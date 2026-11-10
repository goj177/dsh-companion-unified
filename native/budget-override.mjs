import { createHash } from 'node:crypto'
import { NativeStore } from './store.mjs'
import { isPlainObject } from './contracts.mjs'
import { shanghaiTime } from '../policy.mjs'

const DAY = 86400000, SOURCE = 'native_budget_override'
const FIELDS = new Set(['daily_token_limit','daily_wake_limit','max_task_tokens','money_budget_enabled'])
const snapshots = new WeakMap(), restoring = new WeakSet()
const own = (value, key) => Object.hasOwn(value, key)
const hash = value => createHash('sha256').update(value).digest('hex')
const scalar = (key, value) => key === 'money_budget_enabled' ? typeof value === 'boolean' : Number.isSafeInteger(value) && value >= 0
const clock = value => { const at = typeof value === 'function' ? value() : value; if (!Number.isSafeInteger(at) || at < 0) throw new Error('临时预算时钟无效'); return at }
const proofKey = (id, fields) => 'native-budget-override:restored:' + hash(JSON.stringify([id,[...fields].sort()]))

function grantOf(row, value) {
  if (!isPlainObject(value) || value.schema_version !== 1 || value.subtype !== 'grant' || value.user_authorized !== true
    || Object.keys(value).some(key => !['schema_version','subtype','user_authorized','document_id','day','expires_at','original','temporary'].includes(key))
    || typeof value.document_id !== 'string' || !value.document_id || value.document_id.length > 160 || /[\0\r\n]/.test(value.document_id)
    || !/^\d{4}-\d{2}-\d{2}$/.test(value.day ?? '') || !Number.isSafeInteger(value.expires_at)
    || !isPlainObject(value.original) || !isPlainObject(value.temporary)) return null
  const midnight = Date.parse(value.day + 'T00:00:00+08:00'), fields = Object.keys(value.temporary)
  if (!Number.isSafeInteger(midnight) || midnight < 0 || shanghaiTime(midnight).date !== value.day || value.expires_at !== midnight + DAY
    || !Number.isSafeInteger(row.source_at) || row.source_at < midnight || row.source_at >= value.expires_at
    || !fields.length || fields.some(key => !FIELDS.has(key) || !scalar(key, value.temporary[key]))
    || Object.keys(value.original).some(key => !fields.includes(key) || !scalar(key, value.original[key]))) return null
  return { id: row.id, event_key: row.event_key, rowid: row.rowid, ...value, fields }
}

// Only immutable journal entries are cached. New events are read by rowid;
// policy documents and the clock are always read fresh. Uncommitted events
// never enter the shared cache, including inside a caller's outer transaction.
function journalSnapshot(store) {
  const db = store.db, maximum = db.prepare('SELECT COALESCE(max(rowid),0) n FROM journal_events').get().n
  let previous = snapshots.get(db)
  if (!previous || previous.cursor > maximum) previous = { cursor: 0, grants: new Map(), settled: new Map() }
  if (previous.cursor === maximum && store._depth === 0) return previous
  const next = { cursor: maximum, grants: new Map(previous.grants), settled: new Map([...previous.settled].map(([key, fields]) => [key, new Set(fields)])) }
  const rows = db.prepare('SELECT rowid,id,event_key,source_at,metadata_json FROM journal_events WHERE rowid>? AND rowid<=? AND source_type=? ORDER BY rowid').all(previous.cursor,maximum,SOURCE)
  for (const row of rows) {
    let value; try { value = JSON.parse(row.metadata_json) } catch { continue }
    const grant = grantOf(row, value)
    if (grant) { next.grants.set(grant.id, grant); continue }
    if (value?.schema_version !== 1 || value.subtype !== 'restored' || !Array.isArray(value.settled_fields) || !value.settled_fields.length) continue
    const original = next.grants.get(value.grant_id), fields = value.settled_fields
    if (!original || value.document_id !== original.document_id || fields.some(key => !original.fields.includes(key))
      || new Set(fields).size !== fields.length || row.event_key !== proofKey(original.id, fields)
      || !Number.isSafeInteger(row.source_at) || row.source_at < original.expires_at) continue
    const settled = next.settled.get(original.id) ?? new Set(); fields.forEach(key => settled.add(key)); next.settled.set(original.id, settled)
  }
  if (store._depth === 0) snapshots.set(db, next)
  return next
}

function expiredFields(snapshot, grant, at) {
  if (grant.expires_at > at) return []
  return grant.fields.filter(key => !snapshot.settled.get(grant.id)?.has(key)
    && ![...snapshot.grants.values()].some(later => later.rowid > grant.rowid && later.document_id === grant.document_id
      && later.expires_at > at && later.fields.includes(key) && !snapshot.settled.get(later.id)?.has(key)))
}

function restoreField(value, key, grant) {
  if (!isPlainObject(value?.budget) || !own(value.budget, key) || value.budget[key] !== grant.temporary[key]) return false
  if (own(grant.original, key)) value.budget[key] = grant.original[key]
  else delete value.budget[key]
  return true
}

/** A pure policy view. Expired temporary values cannot authorize a model just
 * because the next host pulse has not run; status/read-only callers never write. */
export function effectiveActivityPolicy({ store, document_id = 'activity', now = store?.now ?? Date.now } = {}) {
  if (!(store instanceof NativeStore)) throw new Error('临时预算需要原生存储')
  store._open(); const at = clock(now), document = store.getDocument(document_id)
  if (document && document.type !== 'activity') throw new Error('临时预算策略文档类型错误')
  const value = structuredClone(document?.value ?? { enabled: false }), snapshot = journalSnapshot(store)
  for (const grant of [...snapshot.grants.values()].filter(grant => grant.document_id === document_id).sort((a,b) => b.rowid-a.rowid))
    for (const key of expiredFields(snapshot, grant, at)) restoreField(value, key, grant)
  return value
}

/** Synchronous, field-by-field CAS restoration; never clears usage or queues.
 * The same function handles a live midnight and the first start on a later day. */
export function restoreExpiredBudgetOverrides({ store, now = store?.now ?? Date.now } = {}) {
  if (!(store instanceof NativeStore)) throw new Error('临时预算恢复需要原生存储')
  store._open(); const at = clock(now), report = { restored_grants: 0, restored_fields: 0, preserved_fields: 0, journal_events: 0 }
  if (store.readOnly) return { ...report, read_only: true }
  if (restoring.has(store.db)) return { ...report, already_running: true }
  const initial = journalSnapshot(store)
  if (![...initial.grants.values()].some(grant => expiredFields(initial, grant, at).length)) return report
  restoring.add(store.db)
  try {
    return store.transaction(() => {
      const snapshot = journalSnapshot(store)
      for (const grant of [...snapshot.grants.values()].sort((a,b) => b.rowid-a.rowid)) {
        const fields = expiredFields(snapshot, grant, at); if (!fields.length) continue
        const event_key = proofKey(grant.id, fields)
        if (store.db.prepare('SELECT id FROM journal_events WHERE event_key=?').get(event_key)) throw new Error('临时预算恢复证明键冲突，未覆盖原记录')
        const document = store.getDocument(grant.document_id), value = document?.type === 'activity' ? structuredClone(document.value) : null
        const restored_fields = [], preserved_fields = [], results = {}
        for (const key of fields) {
          if (value && restoreField(value, key, grant)) { restored_fields.push(key); results[key] = 'restored' }
          else { preserved_fields.push(key); results[key] = 'preserved_later_value_or_missing_document' }
        }
        if (value && JSON.stringify(value) !== JSON.stringify(document.value)) store.putDocument({ id: document.id, type: document.type, expected_revision: document.revision, value })
        store.appendJournalEvent({ event_key, event_type: 'log', platform: 'harness', direction: 'internal', status: 'recorded', visibility: 'owner', text: '', source_at: at, source_type: SOURCE,
          metadata: { schema_version: 1, subtype: 'restored', grant_id: grant.id, grant_event_key: grant.event_key, document_id: grant.document_id, expires_at: grant.expires_at, settled_fields: fields, restored_fields, preserved_fields, field_results: results } })
        const settled = snapshot.settled.get(grant.id) ?? new Set(); fields.forEach(key => settled.add(key)); snapshot.settled.set(grant.id, settled)
        report.restored_grants++; report.restored_fields += restored_fields.length; report.preserved_fields += preserved_fields.length; report.journal_events++
      }
      return report
    })
  } finally { restoring.delete(store.db) }
}
