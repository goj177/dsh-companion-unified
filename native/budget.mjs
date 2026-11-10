import { createHash } from 'node:crypto'
import { NativeStore } from './store.mjs'
import { stringifyJson } from './contracts.mjs'
import { shanghaiTime, valleyDecision } from '../policy.mjs'
import {effectiveActivityPolicy,restoreExpiredBudgetOverrides} from './budget-override.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')
const nonnegative = value => Number.isSafeInteger(value) && value >= 0
const metadataOf = row => JSON.parse(row.metadata_json)

/** Model reservations and actual usage live in the same native transaction. */
export class NativeBudget {
  constructor({ store, now = Date.now, policy_document_id = 'activity', quota_prefix = 'quota:system:activity' } = {}) {
    if (!(store instanceof NativeStore) || typeof now !== 'function') throw new Error('预算服务需显式原生存储')
    this.store = store; this.now = now; this.policyId = policy_document_id; this.quotaPrefix = quota_prefix; this.wakeKinds = new Map()
  }
  _now() { const at = this.now(); if (!nonnegative(at)) throw new Error('预算时钟无效'); return at }
  _policy() { const doc = this.store.getDocument(this.policyId); if (doc && doc.type !== 'activity') throw new Error('预算文档类型错误'); return effectiveActivityPolicy({store:this.store,document_id:this.policyId,now:this.now}) }
  _restore() { if(!this.store.readOnly)restoreExpiredBudgetOverrides({store:this.store,now:this.now}) }
  _state() { return new Map() }
  _day(state, date) {
    if (state.has(date)) return state.get(date)
    const documents = {}
    for (const metric of ['tokens','wakes']) {
      const id = this.quotaPrefix + ':' + metric + ':' + date, doc = this.store.getDocument(id)
      if (doc && (doc.type !== 'quota' || doc.value.metric !== metric || doc.value.day !== date || doc.value.platform !== 'system' || doc.value.category !== 'activity')) throw new Error('原生每日预算契约不一致')
      documents[metric] = { id, revision: doc?.revision || 0 }
    }
    const tokenDoc = this.store.getDocument(documents.tokens.id), wakeDoc = this.store.getDocument(documents.wakes.id)
    const value = { day: date, wakes: wakeDoc?.value.used || 0, tokens: tokenDoc?.value.used || 0,
      reserved_tokens: tokenDoc?.value.reserved || 0, documents }
    state.set(date, value)
    return value
  }
  _save(state) {
    const policy = this._policy()
    for (const day of state.values()) for (const metric of ['tokens','wakes']) {
      const old = day.documents[metric]
      const next = this.store.putDocument({ id: old.id, type: 'quota', expected_revision: old.revision,
        value: { platform: 'system', category: 'activity', metric, day: day.day,
          limit: metric === 'tokens' ? policy.budget?.daily_token_limit ?? 300000 : policy.budget?.daily_wake_limit ?? 18,
          used: metric === 'tokens' ? day.tokens : day.wakes, reserved: metric === 'tokens' ? day.reserved_tokens : 0 } })
      old.revision = next.revision
    }
  }
  _row(id) {
    const row = this.store.db.prepare("SELECT * FROM actions WHERE id=? AND kind='model.reservation'").get(id)
    if (!row) throw new Error('没有该原生模型预留')
    return { row, metadata: metadataOf(row) }
  }
  _hold(meta) { return meta.reservation_open ? Math.max(0, meta.reserved_tokens - meta.actual_tokens) : 0 }
  _wakeCounts(date,total,tokens=0,reserved=0) {
    const counts={manual_wakes:0,incoming_wakes:0,manual_tokens:0,manual_reserved_tokens:0,manual_uncertain_tokens:0}
    for(const row of this.store.db.prepare("SELECT id,metadata_json FROM actions WHERE kind='model.reservation' AND json_extract(metadata_json,'$.day')=?").all(date)){
      const meta=metadataOf(row);if(!meta.wake_charge)continue
      let kind=meta.wake_kind??this.wakeKinds.get(row.id)
      if(!kind){const linked=this.store.db.prepare("SELECT json_extract(metadata_json,'$.trigger') AS trigger FROM actions WHERE kind LIKE 'activity.%' AND json_extract(metadata_json,'$.reservation_id')=? LIMIT 1").get(row.id);kind=linked?.trigger??(meta.kind==='activity.incoming'?'incoming':'autonomous');this.wakeKinds.set(row.id,kind)}
      if(kind==='manual'){counts.manual_wakes+=meta.wake_charge;counts.manual_tokens+=meta.reservation_open?meta.actual_tokens:meta.charged_tokens;counts.manual_reserved_tokens+=this._hold(meta);if(!meta.reservation_open&&!meta.actual_known)counts.manual_uncertain_tokens+=meta.charged_tokens}
      if(kind==='incoming')counts.incoming_wakes+=meta.wake_charge
    }
    return {...counts,autonomous_wakes:Math.max(0,total-counts.manual_wakes-counts.incoming_wakes),automatic_tokens:Math.max(0,tokens-counts.manual_tokens),automatic_reserved_tokens:Math.max(0,reserved-counts.manual_reserved_tokens)}
  }
  _event(id, name, status, meta) {
    const key = id + ':' + name
    this.store.appendJournalEvent({ id: 'journal:' + hash(key), event_key: key, event_type: 'log', platform: meta.platform,
      visibility: 'owner', direction: 'internal', status, text: '', source_at: this._now(), source_type: 'native_budget',
      metadata: { event_name: 'budget.' + name, reservation_id: id, day: meta.day, kind: meta.kind,
        reserved_tokens: meta.reserved_tokens, actual_known: meta.actual_known, actual_tokens: meta.actual_tokens,
        charged_tokens: meta.charged_tokens, wake_charge: meta.wake_charge, ...(meta.wake_kind?{wake_kind:meta.wake_kind}:{}) } })
  }
  reserve({ id, platform, kind, estimated_tokens, human = false, heavy = true, manual = false, trigger } = {}) {
    if (typeof id !== 'string' || !id || id.length > 512 || /[\0\r\n]/.test(id)
      || !['qq','tieba','bilibili','harness','system'].includes(platform) || typeof kind !== 'string' || !kind || kind.length > 100
      || !nonnegative(estimated_tokens) || estimated_tokens < 1 || typeof human !== 'boolean' || typeof heavy !== 'boolean' || typeof manual !== 'boolean'
      || trigger!==undefined&&!['autonomous','manual','incoming'].includes(trigger)||manual&&trigger!==undefined&&trigger!=='manual') throw new Error('模型预算预留参数无效')
    const wake_kind=trigger??(manual?'manual':human?'incoming':'autonomous');manual=wake_kind==='manual'
    this._restore()
    return this.store.transaction(() => {
      this.expire()
      const at = this._now(), policy = this._policy(), budgetPolicy = policy.budget || {}
      if (policy.enabled !== true) return { allowed: false, reason: 'disabled' }
      const phase = valleyDecision(at, { holidays: policy.holidays || [] })
      const urgent = human && !heavy && budgetPolicy.urgent_human_allowed === true
      if (!phase.valley && !urgent && !manual) return { allowed: false, reason: 'peak', not_before: phase.nextValleyAt }
      const remaining = policy.batching?.min_valley_remaining_ms ?? 120000
      if (!manual && heavy && Number.isFinite(phase.nextPeakAt) && at + remaining >= phase.nextPeakAt) return { allowed: false, reason: 'valley_ending', not_before: valleyDecision(phase.nextPeakAt + 1, { holidays: policy.holidays || [] }).nextValleyAt }
      if (estimated_tokens > (budgetPolicy.max_task_tokens ?? 30000)) return { allowed: false, reason: 'task_reservation_too_large' }
      const date = shanghaiTime(at).date, reservation = 'reservation:' + hash(date + '\0' + id)
      const existing = this.store.db.prepare('SELECT status FROM actions WHERE id=?').get(reservation)
      if (existing) return { allowed: false, reason: 'duplicate', reservation_id: reservation, status: existing.status }
      const open = this.store.db.prepare("SELECT metadata_json FROM actions WHERE kind='model.reservation' AND status IN ('reserved','running')").all()
        .filter(row => metadataOf(row).reservation_open)
      if (open.length >= (policy.batching?.max_concurrent ?? 1)) return { allowed: false, reason: 'busy' }
      if (open.filter(row=>metadataOf(row).platform===platform).length >= (policy.batching?.max_per_platform ?? 1)) return { allowed: false, reason: 'busy' }
      const state = this._state(), day = this._day(state, date),counts=this._wakeCounts(date,day.wakes,day.tokens,day.reserved_tokens)
      if (wake_kind==='autonomous'&&counts.autonomous_wakes >= (budgetPolicy.daily_wake_limit ?? 18) || wake_kind!=='manual'&&counts.automatic_tokens + counts.automatic_reserved_tokens + estimated_tokens > (budgetPolicy.daily_token_limit ?? 300000)) return { allowed: false, reason: 'budget' }
      const meta = { schema_version: 1, record_type: 'model_reservation', platform, kind, day: date,
        reserved_tokens: estimated_tokens, reservation_open: true, actual_known: false, actual_tokens: 0,
        charged_tokens: 0, wake_charge: 1, wake_kind, started: false, lease_until: at + (policy.batching?.lease_ms ?? 900000) }
      const emptyDigest = hash('')
      this.store.db.prepare(`INSERT INTO actions(id,platform,kind,target_json,body,body_digest,request_digest,status,
        created_at,updated_at,not_before,metadata_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(reservation,platform,'model.reservation',stringifyJson({ caller_id: id, kind }),'',emptyDigest,hash(reservation),'reserved',at,at,at,stringifyJson(meta))
      day.wakes++; day.reserved_tokens += estimated_tokens; this._save(state); this._event(reservation, 'reserved', 'pending', meta)
      return { allowed: true, reservation_id: reservation, reserved_tokens: estimated_tokens, day: date, lease_until: meta.lease_until }
    })
  }
  markStarted(id) {
    this._restore()
    return this.store.transaction(() => {
      const { row, metadata } = this._row(id)
      if (!metadata.reservation_open || metadata.started || row.status !== 'reserved') throw new Error('模型预留不能重复开始')
      metadata.started = true
      this.store.db.prepare("UPDATE actions SET status='running',updated_at=?,metadata_json=? WHERE id=?").run(this._now(),stringifyJson(metadata),id)
      this._event(id, 'started', 'pending', metadata)
      return { started: true }
    })
  }
  recordUsage(id, { total_tokens } = {}) {
    if (!nonnegative(total_tokens)) throw new Error('实际用量必须是本次任务累计非负整数')
    this._restore()
    return this.store.transaction(() => {
      const { metadata } = this._row(id)
      if (metadata.actual_known && total_tokens <= metadata.actual_tokens) return { updated: false, actual_tokens: metadata.actual_tokens }
      const state = this._state(), day = this._day(state, metadata.day), held = this._hold(metadata)
      const previousCharge = metadata.reservation_open ? metadata.actual_tokens : metadata.charged_tokens
      metadata.actual_known = true; metadata.actual_tokens = total_tokens
      day.tokens += total_tokens - previousCharge
      if (day.tokens < 0) throw new Error('原生预算累计出现不一致，未写入')
      if (metadata.reservation_open) day.reserved_tokens += this._hold(metadata) - held
      else metadata.charged_tokens = total_tokens
      this._save(state)
      this.store.db.prepare('UPDATE actions SET updated_at=?,metadata_json=? WHERE id=?').run(this._now(),stringifyJson(metadata),id)
      return { updated: true, actual_tokens: total_tokens, day: metadata.day }
    })
  }
  finish(id, { outcome = 'completed', total_tokens } = {}) {
    if (!['completed','unknown','not_started'].includes(outcome)) throw new Error('模型预算结束状态无效')
    this._restore()
    return this.store.transaction(() => {
      if (total_tokens !== undefined) this.recordUsage(id, { total_tokens })
      const { metadata } = this._row(id)
      if (!metadata.reservation_open) return { closed: true, duplicate: true, actual_known: metadata.actual_known, charged_tokens: metadata.charged_tokens }
      if (outcome === 'not_started' && (metadata.started || metadata.actual_known)) throw new Error('模型请求已开始或存在用量，不能退回为未开始')
      const state = this._state(), day = this._day(state, metadata.day)
      day.reserved_tokens = Math.max(0, day.reserved_tokens - this._hold(metadata))
      if (outcome === 'not_started') { day.wakes -= metadata.wake_charge; metadata.wake_charge = 0; metadata.charged_tokens = 0 }
      else {
        const charge = metadata.actual_known ? metadata.actual_tokens : metadata.reserved_tokens
        day.tokens += charge - metadata.actual_tokens; metadata.charged_tokens = charge
      }
      metadata.reservation_open = false
      this._save(state)
      this.store.db.prepare('UPDATE actions SET status=?,updated_at=?,metadata_json=? WHERE id=?').run(outcome === 'not_started' ? 'cancelled' : outcome,this._now(),stringifyJson(metadata),id)
      this._event(id, outcome, outcome === 'unknown' ? 'unknown' : outcome === 'not_started' ? 'cancelled' : 'recorded', metadata)
      return { closed: true, duplicate: false, actual_known: metadata.actual_known, charged_tokens: metadata.charged_tokens }
    })
  }
  expire() {
    this._restore()
    return this.store.transaction(() => {
      const at = this._now(), rows = this.store.db.prepare("SELECT id,metadata_json FROM actions WHERE kind='model.reservation' AND status IN ('reserved','running')").all()
      const ids = rows.filter(row => metadataOf(row).reservation_open && metadataOf(row).lease_until <= at).map(row => row.id)
      for (const id of ids) this.finish(id, { outcome: 'unknown' })
      return { expired: ids.length }
    })
  }
  status({ day = shanghaiTime(this._now()).date } = {}) {
    const p = this._policy(), current = this._day(this._state(), day)
    const counts=this._wakeCounts(day,current.wakes,current.tokens,current.reserved_tokens),budget = { day, wakes: current.wakes, tokens: counts.automatic_tokens, reserved_tokens: counts.automatic_reserved_tokens, total_tokens:current.tokens, total_reserved_tokens:current.reserved_tokens }
    const uncertain = this.store.db.prepare("SELECT COALESCE(SUM(json_extract(metadata_json,'$.charged_tokens')),0) AS n FROM actions WHERE kind='model.reservation' AND json_extract(metadata_json,'$.day')=? AND json_extract(metadata_json,'$.reservation_open')=0 AND json_extract(metadata_json,'$.actual_known')=0").get(day).n
    return { ...budget, ...counts, manual_known_tokens:counts.manual_tokens-counts.manual_uncertain_tokens,daily_token_limit_scope:'automatic',daily_wake_limit_scope:'autonomous', known_tokens: budget.tokens - (uncertain-counts.manual_uncertain_tokens), uncertain_tokens: uncertain-counts.manual_uncertain_tokens,
      daily_wake_limit: p.budget?.daily_wake_limit ?? 18, daily_token_limit: p.budget?.daily_token_limit ?? 300000,
      enabled: p.enabled === true, model_calls: 0, note: '自主活动受每日次数限制；手动执行与来信分开计数。手动Token单列，不占每日自动活动Token预算；total_tokens保留全部实际及保守占额用量。未确认消耗按预留保守占额。' }
  }
}
