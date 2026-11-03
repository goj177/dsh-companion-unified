import { createHash, randomUUID } from 'node:crypto'
import {validateModerationStateProof} from './qq-moderation.mjs'
import { NativeStore } from './store.mjs'
import { validateJson, stringifyJson, isPlainObject } from './contracts.mjs'

const digest = value => createHash('sha256').update(value).digest('hex')
const idOf = value => 'action:' + digest(value)
const fields = (value, allowed) => {
  if (!isPlainObject(value) || Object.keys(value).some(key => !allowed.includes(key))) throw new Error('动作参数含未定义字段')
}
const canonical = value => Array.isArray(value) ? value.map(canonical) : isPlainObject(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value
const encode = value => stringifyJson(canonical(validateJson(value)))
function targetOf(input) {
  const target = validateJson(input, { object: true, maxBytes: 65536 })
  const visit = value => {
    for (const [key, child] of Object.entries(value)) {
      if (/(?:^|_)(?:id|uid|pid|mid)$/.test(key) && child !== null && typeof child !== 'string') throw new Error('平台身份和回复坐标必须使用字符串')
      if (isPlainObject(child) || Array.isArray(child)) visit(child)
    }
  }
  visit(target)
  return target
}
const SELECT = 'SELECT actions.*,CAST(body AS BLOB) AS body_bytes FROM actions'
const PUBLIC_KINDS = new Set(['tieba.reply','tieba.post','bilibili.comment','bilibili.reply','bilibili.dynamic'])
export function actionVisibility(action) {
  const target=action.target??{},conversation=typeof target.conversation_id==='string'?target.conversation_id:''
  const privateBili=action.platform==='bilibili'&&(target.channel==='dm'||target.via==='dm')||action.platform==='tieba'&&action.kind==='tieba.message'
  if(privateBili&&!/^dm:[0-9]+$/.test(conversation))throw new Error('私信必须明确dm:完整UID会话')
  return {conversation_id:conversation,visibility:privateBili?'conversation':action.status==='confirmed'&&PUBLIC_KINDS.has(action.kind)?'public':conversation?'conversation':'owner'}
}
function project(row, internal = false) {
  if (!row) return null
  const metadata = JSON.parse(row.metadata_json)
  if (!internal) { delete metadata.lease_token; delete metadata.lease_until }
  return { id: row.id, platform: row.platform, kind: row.kind, target: JSON.parse(row.target_json),
    body: Buffer.from(row.body_bytes).toString('utf8'), body_digest: row.body_digest, request_digest: row.request_digest,
    status: row.status, receipt: JSON.parse(row.receipt_json), source_evidence_id: row.source_evidence_id,
    created_at: row.created_at, updated_at: row.updated_at, not_before: row.not_before,
    submitted_at: row.submitted_at, confirmed_at: row.confirmed_at, metadata,
    ...(internal ? { approval_token: row.approval_token } : {}) }
}

/** Native persisted action lifecycle; this service never sends a network request. */
export class NativeOutbox {
  constructor({ store, now = Date.now } = {}) {
    if (!(store instanceof NativeStore) || typeof now !== 'function') throw new Error('动作服务需显式使用原生存储')
    this.store = store; this.now = now
  }
  _now() { const value = this.now(); if (!Number.isSafeInteger(value) || value < 0) throw new Error('动作时钟无效'); return value }
  get(id, { internal = false } = {}) { return project(this.store.db.prepare(SELECT + ' WHERE id=?').get(id), internal) }
  list({ platform, status, limit = 100 } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('动作数量无效')
    const conditions = [], args = []
    if (platform !== undefined) { conditions.push('platform=?'); args.push(platform) }
    if (status !== undefined) { conditions.push('status=?'); args.push(status) }
    return this.store.db.prepare(SELECT + (conditions.length ? ' WHERE ' + conditions.join(' AND ') : '') + ' ORDER BY created_at,id LIMIT ?').all(...args, limit).map(row => project(row))
  }
  _event(action, transition, { text = '', metadata = {}, at = this._now() } = {}) {
    const key = action.id + ':' + transition
    const eventName = 'action.' + transition.split(':')[0]
    const status = ['leased','submitting'].includes(action.status) ? 'pending' : action.status
    const {conversation_id:conversation,visibility}=actionVisibility(action)
    this.store.appendJournalEvent({ id: 'journal:' + digest(key), event_key: key,
      event_type: action.status === 'confirmed' ? 'experience' : 'log',
      platform: action.platform, conversation_id: conversation, visibility, direction: 'out', status,
      text: action.status === 'confirmed' && !text ? action.body : text, source_at: at,
      source_type: 'native_action_service', recorded_at: at, metadata: { action_id: action.id, kind: action.kind,
        event_name: eventName, action_status: action.status, request_digest: action.request_digest, ...metadata } })
  }
  prepare(input) {
    fields(input, ['platform','kind','target','body','idempotency_key','approval','source_evidence_id','not_before'])
    if (!['qq','tieba','bilibili'].includes(input.platform) || typeof input.kind !== 'string' || !/^[a-z][a-z0-9_.:-]{0,99}$/.test(input.kind)) throw new Error('动作平台或类型无效')
    if (typeof input.body !== 'string' || input.body.length > 200000 || Buffer.from(input.body, 'utf8').toString('utf8') !== input.body
      || !['required','authorized'].includes(input.approval || 'required')) throw new Error('动作正文或授权类型无效')
    const target = targetOf(input.target), body = input.body, requestDigest = digest(encode({ platform: input.platform, kind: input.kind, target, body }))
    actionVisibility({platform:input.platform,kind:input.kind,target,status:'draft'})
    const key = input.idempotency_key ?? randomUUID()
    if (typeof key !== 'string' || !key || key.length > 512 || /[\0\r\n]/.test(key)) throw new Error('动作去重标识无效')
    if (input.not_before !== undefined && (!Number.isSafeInteger(input.not_before) || input.not_before < 0)) throw new Error('动作执行时间无效')
    return this.store.transaction(() => {
      const id = idOf(input.platform + '\0' + key), previous = this.get(id, { internal: true })
      if (previous) {
        if (previous.request_digest !== requestDigest) throw new Error('相同动作标识对应不同正文或目标，原记录保留')
        return { action: this.get(id), duplicate: true }
      }
      const at = this._now(), authorized = input.approval === 'authorized', authorization = authorized ? randomUUID() : ''
      this.store.db.prepare(`INSERT INTO actions(id,platform,kind,target_json,body,body_digest,request_digest,approval_token,status,
        source_evidence_id,created_at,updated_at,not_before,metadata_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(id,input.platform,input.kind,encode(target),body,digest(Buffer.from(body,'utf8')),requestDigest,authorization,
          authorized ? 'queued' : 'draft',input.source_evidence_id ?? null,at,at,input.not_before ?? at,encode({ schema_version: 1, attempts: 0, network_started: false }))
      const action = this.get(id)
      this._event(action, 'prepared', { text: body, metadata: { target, approval_required: !authorized } })
      return { action, duplicate: false, ...(authorized ? { authorization } : {}) }
    })
  }
  approve(id, { expected_digest } = {}) {
    return this.store.transaction(() => {
      const old = this.get(id, { internal: true })
      if (!old || old.request_digest !== expected_digest) throw new Error('草稿不存在或内容与批准时不一致')
      if (old.status === 'queued') return { action: this.get(id), authorization: old.approval_token, duplicate: true }
      if (old.status !== 'draft') throw new Error('当前动作不能重新批准或重复发送')
      const token = randomUUID(), at = this._now()
      this.store.db.prepare("UPDATE actions SET status='queued',approval_token=?,updated_at=? WHERE id=?").run(token,at,id)
      const action = this.get(id); this._event(action, 'approved', { at })
      return { action, authorization: token, duplicate: false }
    })
  }
  lease(id, { authorization, expected_digest, lease_ms = 120000 } = {}) {
    if (!Number.isSafeInteger(lease_ms) || lease_ms < 1) throw new Error('动作租约无效')
    return this.store.transaction(() => {
      const old = this.get(id, { internal: true }), at = this._now()
      if (!old || old.approval_token !== authorization || !authorization || old.request_digest !== expected_digest) throw new Error('动作授权、目标或正文不一致')
      if (old.status === 'confirmed') return { allowed: false, status: 'confirmed', action: this.get(id), duplicate: true }
      if (old.status !== 'queued' || old.not_before > at) return { allowed: false, status: old.status, action: this.get(id) }
      const token = randomUUID(), metadata = { ...old.metadata, attempts: old.metadata.attempts + 1, lease_token: token, lease_until: at + lease_ms, network_started: false }
      this.store.db.prepare("UPDATE actions SET status='leased',updated_at=?,metadata_json=? WHERE id=?").run(at,encode(metadata),id)
      const action = this.get(id); this._event(action, 'leased:' + token, { at })
      return { allowed: true, lease_token: token, action }
    })
  }
  markNetworkStarted(id, leaseToken) {
    return this.store.transaction(() => {
      const old = this._lease(id, leaseToken)
      if (old.status !== 'leased') throw new Error('该租约不能再次开始网络提交')
      const at = this._now(), metadata = { ...old.metadata, network_started: true, attempted_at: at }
      this.store.db.prepare("UPDATE actions SET status='submitting',updated_at=?,metadata_json=? WHERE id=?").run(at,encode(metadata),id)
      this._event(this.get(id), 'network_started:' + leaseToken, { at })
      return this.get(id)
    })
  }
  _lease(id, token) {
    const old = this.get(id, { internal: true })
    if (!old || !token || old.metadata.lease_token !== token || !['leased','submitting'].includes(old.status)) throw new Error('动作租约已结束或不属于当前执行者')
    return old
  }
  finish(id, { lease_token, outcome, proof, detail = '' } = {}) {
    if (!['confirmed','unknown','blocked','not_started'].includes(outcome) || typeof detail !== 'string' || detail.length > 4000) throw new Error('动作结果无效')
    return this.store.transaction(() => {
      const old = this._lease(id, lease_token), at = this._now()
      if (outcome === 'not_started' && old.metadata.network_started) throw new Error('网络提交已开始，不能声明未开始并自动重发')
      if (outcome === 'confirmed') {
        if(old.platform==='qq'&&['qq.mute','qq.unmute'].includes(old.kind))validateModerationStateProof(old,proof,{now:at})
        else if (!isPlainObject(proof) || proof.accepted !== true || typeof proof.server_id !== 'string'
          || !proof.server_id.trim() || /^(?:0|-1|null|undefined)$/i.test(proof.server_id) || proof.source !== 'server_receipt'
          || proof.rejected === true || proof.code !== undefined && proof.code !== 0) throw new Error('确认动作必须有实际服务器回执及非零字符串标识')
      }
      const receipt = proof === undefined ? {} : validateJson(proof, { object: true, maxBytes: 65536 })
      const rejected = outcome === 'blocked' && proof?.rejected === true && proof?.source === 'server_receipt'
      const status = outcome === 'not_started' ? 'queued'
        : outcome === 'blocked' && old.metadata.network_started && !rejected ? 'unknown' : outcome
      const metadata = { ...old.metadata, last_detail: detail, lease_token: '', lease_until: 0,
        confirmed_rejection: rejected }
      this.store.db.prepare('UPDATE actions SET status=?,receipt_json=?,metadata_json=?,updated_at=?,submitted_at=?,confirmed_at=? WHERE id=?')
        .run(status,encode(receipt),encode(metadata),at,outcome === 'confirmed' ? at : old.submitted_at,outcome === 'confirmed' ? at : old.confirmed_at,id)
      const action = this.get(id)
      this._event(action, outcome + ':' + lease_token, { text: detail, metadata: { server_id: receipt.server_id || '', network_started: old.metadata.network_started }, at })
      return action
    })
  }
  expire() {
    return this.store.transaction(() => {
      const at = this._now(), rows = this.store.db.prepare(SELECT + " WHERE status IN ('leased','submitting')").all()
      const expired = []
      for (const raw of rows) {
        const row = project(raw, true)
        if (row.metadata.lease_until > at) continue
        expired.push(this.finish(row.id, { lease_token: row.metadata.lease_token, outcome: 'unknown', detail: '执行完成未确认，保留原稿与回执，不自动重发' }))
      }
      return expired
    })
  }
  cancel(id, { expected_digest, reason = '' } = {}) {
    if (typeof reason !== 'string' || reason.length > 1000) throw new Error('取消说明无效')
    return this.store.transaction(() => {
      const old = this.get(id)
      if (!old || old.request_digest !== expected_digest) throw new Error('动作不存在或内容已变化')
      if (!['draft','queued','blocked'].includes(old.status)) throw new Error('执行中、结果未知或已确认的动作不能按未发送草稿删除')
      this.store.db.prepare("UPDATE actions SET status='cancelled',updated_at=? WHERE id=?").run(this._now(),id)
      const action = this.get(id); this._event(action, 'cancelled', { text: reason })
      return action
    })
  }
}
