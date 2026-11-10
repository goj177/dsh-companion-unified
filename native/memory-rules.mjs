import { createHash } from 'node:crypto'
import { isPlainObject, validateJson } from './contracts.mjs'

export const MEMORY_LEVELS = Object.freeze(['fact','lesson','user','project','topic','rules'])
export const MEMORY_TYPES = Object.freeze(['observed','asserted','inferred','recorded'])
export const ENTITY_TYPES = Object.freeze(['knowledge','experience','person','conversation'])
export const VISIBILITIES = Object.freeze(['public','conversation','owner','secret'])
export const SOURCE_TYPES = Object.freeze(['user','platform','server_action','host','model'])
export const EVIDENCE_KINDS = Object.freeze(['message','comment','reply','post','dynamic','watch','read','receipt','note','statement','learning','action','observation','knowledge','thread','user_statement'])
export const DIRECTIONS = Object.freeze(['in','out','internal','observation'])
const UNCERTAIN = /开玩笑|逗你|只是玩笑|假设|猜测|猜的|可能|或许|大概|好像|似乎|据说|不确定|瞎说|编的|\b(?:pretend|joking|guess|maybe|hypothetical)\b/i
const SECRET = '(?:access[_-]?token|refresh[_-]?token|api[_-]?key|client[_-]?secret|token|secret|credentials?|auth|authorization|password|passwd|cookies?|set-cookie|csrf|sessdata|bili_jct|buvid[0-9]*|bduss|stoken|private[_-]?key|密码|口令|密钥|令牌)'
const FAILED = new Set(['failed','error','unknown','uncertain','draft','preview','dry','queued','pending','blocked','cancelled','timeout'])
const RECEIPT_KEYS = ['ok','sent','success','status','code','retcode','message_id','reply_id','dynamic_id','post_id','rpid','bvid','id','ref','url','source_at']

export const digest = value => createHash('sha256').update(value).digest('hex')
export function fields(input, allowed, name = '原生记忆参数') {
  if (!isPlainObject(input) || Object.keys(input).some(key => !allowed.includes(key))) throw new Error(name + '包含未知字段或类型错误')
  return input
}
export function choice(value, allowed, name) { if (!allowed.includes(value)) throw new Error(name + '不在允许范围'); return value }
export function integer(value, name, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(name + '必须为安全整数且在允许范围')
  return value
}
export function rawText(value, name, max = 16000, required = false) {
  if (typeof value !== 'string' || !value.isWellFormed() || value.length > max || required && !value.trim()) throw new Error(name + '必须为有效文本且在长度范围内')
  return value
}
export function identifier(value, name = 'id') {
  rawText(value,name,240,true)
  if (value.includes('\0') || !/^[a-z][a-z0-9_.:/-]*$/.test(value)) throw new Error(name + '必须为完整稳定标识')
  return value
}
export function platformName(value) {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(value) || value === 'global') throw new Error('platform必须为有效平台namespace')
  return value
}
export function uid(value, name = 'actor_uid') {
  rawText(value,name,240)
  if (value.includes('\0') || value !== value.trim()) throw new Error(name + '必须是原平台稳定UID文本')
  return value
}
export function timestamp(value, name, nullable = false) {
  if (nullable && value === null) return null
  let result = value
  if (typeof value === 'string') {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(value)
    if (!m) throw new Error(name + '必须为带时区的ISO时间或UTC毫秒')
    const [,year,month,day,hour,minute,second,zone] = m
    const calendar = new Date(0); calendar.setUTCFullYear(+year,+month-1,+day); calendar.setUTCHours(+hour,+minute,+second,0)
    if (calendar.getUTCFullYear() !== +year || calendar.getUTCMonth() !== +month-1 || calendar.getUTCDate() !== +day || +hour>23 || +minute>59 || +second>59
      || zone !== 'Z' && (+zone.slice(1,3)>23 || +zone.slice(4,6)>59)) throw new Error(name + '日期无效')
    result = Date.parse(value)
  }
  return integer(result,name,0,8640000000000000)
}
export function queryTime(value, name, end = false) {
  if (value === undefined) return undefined
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return timestamp(value+(end?'T23:59:59.999+08:00':'T00:00:00.000+08:00'),name)
  return timestamp(value,name)
}

function redactAssignments(text) {
  const pattern = new RegExp('(["\']?' + SECRET + '["\']?\\s*[:=]\\s*)','gi')
  let output = '', previous = 0, match
  while ((match = pattern.exec(text))) {
    const start = pattern.lastIndex, first = text[start]
    let end = start
    if (first === '"' || first === "'") {
      for (end=start+1;end<text.length;end++) { if (text[end] === '\\') { end++; continue }; if (text[end] === first) { end++; break } }
    } else if (first === '{' || first === '[') {
      const stack = [], pairs = {'{':'}','[':']'}; let quote = ''
      for (end=start;end<text.length;end++) {
        const char=text[end]
        if (quote) { if (char === '\\') { end++; continue }; if (char === quote) quote=''; continue }
        if (char === '"' || char === "'") { quote=char; continue }
        if (pairs[char]) stack.push(pairs[char])
        else if (char === stack.at(-1)) { stack.pop(); if (!stack.length) { end++; break } }
      }
    } else while (end<text.length && !/[\r\n,}&]/.test(text[end])) end++
    output += text.slice(previous,start)+'[已隐藏]'; previous=end; pattern.lastIndex=end
  }
  return output+text.slice(previous)
}

/** Credentials are removed before hashing/writing. Other bytes, including NUL,
 * punctuation, Unicode width, decimal signs and surrounding space, stay intact. */
export function redactText(value) {
  let text = rawText(value,'原文',64000)
  text = text.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,'[私钥已隐藏]')
    .replace(/\b((?:authorization|proxy-authorization|cookie|set-cookie)\s*:)\s*[^\r\n]+/gi,'$1 [已隐藏]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi,'Bearer [已隐藏]')
    .replace(/\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,'[令牌已隐藏]')
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g,'[密钥已隐藏]')
    .replace(/((?:密码|口令|密钥|令牌)\s*(?:是|为|：)\s*)[^\s，。；,;\r\n]+/g,'$1[已隐藏]')
  // Only remove userinfo; do not URL-normalize ordinary source text.
  text = text.replace(/(https?:\/\/)[^\s/@]+(?::[^\s/@]*)?@/gi,'$1[身份已隐藏]@')
  text = text.replace(new RegExp('([?&]' + SECRET + '=)[^&#\\s]*','gi'),'$1[已隐藏]')
  text = text.replace(/https?:\/\/[^\s<>"']+/gi, link=>link.replace(/([?&])([^=&#]+)=([^&#]*)/g,(part,separator,key)=>{
    let name=key
    try{name=decodeURIComponent(key.replace(/\+/g,' '))}catch{}
    return new RegExp('^'+SECRET+'$','i').test(name)?separator+key+'=[已隐藏]':part
  }))
  return redactAssignments(text)
}
export function safeText(value, name, max = 16000, required = false) { return redactText(rawText(value,name,max,required)) }
export function safeJson(value) {
  validateJson(value)
  const walk = input => {
    if (typeof input === 'string') return redactText(input)
    if (Array.isArray(input)) return input.map(walk)
    if (!isPlainObject(input)) return input
    return Object.fromEntries(Object.entries(input).map(([key,item]) => [key,new RegExp('^'+SECRET+'$','i').test(key)?'[已隐藏]':walk(item)]))
  }
  return walk(value)
}
export function sourceDescriptor(value = {}) {
  fields(value,['kind','explicit','uncertain','role','ref','pipeline','nickname','verification'],'source')
  const result = {kind:choice(value.kind??'host_record',['user','human','user_statement','platform_read','server_action','host_record','inference'],'source.kind')}
  for (const key of ['explicit','uncertain']) if (value[key] !== undefined) { if (typeof value[key] !== 'boolean') throw new Error('source.'+key+'必须为布尔值'); result[key]=value[key] }
  for (const key of ['role','ref','pipeline','nickname','verification']) if (value[key]!==undefined) result[key]=safeText(value[key],'source.'+key,2000)
  return result
}
export function receiptDescriptor(value = {}) {
  fields(value,RECEIPT_KEYS,'receipt'); validateJson(value)
  for (const [key,item] of Object.entries(value)) if (!['string','number','boolean'].includes(typeof item) || ['ok','sent','success'].includes(key) && typeof item !== 'boolean') throw new Error('receipt.'+key+'类型无效')
  return safeJson(value)
}
export function positiveReceipt(receipt) {
  if (FAILED.has(String(receipt.status??'').toLowerCase()) || receipt.sent===false || receipt.success===false || receipt.ok===false) return false
  const positive = receipt.ok===true || receipt.sent===true || receipt.success===true || ['sent','success','confirmed','completed'].includes(receipt.status) || receipt.code===0 || receipt.retcode===0
  const reference = ['message_id','reply_id','dynamic_id','post_id','rpid','bvid','id','ref','url'].some(key => typeof receipt[key] === 'string' && receipt[key].trim() && !/^(?:0|-1|null|undefined|\[已隐藏\])$/i.test(receipt[key].trim()))
  return positive && reference
}
export function uncertain(value) { return UNCERTAIN.test(value) }
export function classifyEvidence({direction,source_type,kind,text,source,receipt}) {
  if (FAILED.has(String(receipt.status??'').toLowerCase()) || receipt.ok===false || receipt.sent===false || receipt.success===false) return {status:FAILED.has(receipt.status)?receipt.status:'failed',confirmation:'none',priority:0}
  if (source_type==='server_action' && positiveReceipt(receipt)) return {status:'confirmed',confirmation:'server_receipt',priority:90}
  if (source.uncertain===true || source_type==='model' || source.kind==='inference') return {status:'uncertain',confirmation:'none',priority:0}
  // A quoted "maybe" describes the source's claim, not whether the native
  // reader actually received these bytes. Confirm the read only; its body is
  // still labelled as an unverified account and cannot prove own experience.
  if (source_type==='platform' && ['in','observation'].includes(direction) && source.kind==='platform_read' && source.explicit===true) return {status:'confirmed',confirmation:'source_observation',priority:75}
  if (uncertain(text)) return {status:'uncertain',confirmation:'none',priority:0}
  if (source_type==='user' && direction==='in' && ['user','human','user_statement'].includes(source.kind) && (source.explicit===true || source.kind==='user_statement' || ['statement','user_statement'].includes(kind))) return {status:'confirmed',confirmation:'user_statement',priority:80}
  return {status:'pending',confirmation:'none',priority:0}
}
/** Runtime authority comes from the canonical immutable source category, never
 * a historical numeric priority or an asserted role/name inside source text. */
export function canonicalEvidenceRank(row) {
  if(row?.status!=='confirmed')return 0
  if(row.confirmation==='server_receipt'&&row.direction==='out'&&row.source_type==='server_action')return 3
  if(row.confirmation==='user_statement'&&row.direction==='in')return 2
  if(row.confirmation==='source_observation'||row.confirmation==='server_receipt'&&['in','observation'].includes(row.direction))return 1
  return 0
}
export function contextOf(value = {}) {
  fields(value,['platform','conversation_id','owner_authorized','include_secret','allow_global_summary','actor_uid','actor_entity_id'],'trusted context')
  const context = {...value}
  if (context.platform!==undefined) platformName(context.platform)
  if (context.conversation_id!==undefined) uid(context.conversation_id,'conversation_id')
  if (context.actor_uid!==undefined) uid(context.actor_uid)
  if (context.actor_entity_id!==undefined) identifier(context.actor_entity_id,'actor_entity_id')
  for (const key of ['owner_authorized','include_secret','allow_global_summary']) if (context[key]!==undefined && typeof context[key]!=='boolean') throw new Error(key+'必须为布尔值')
  return context
}
export function visible(row, context) {
  if (row.visibility==='public') return true
  if (row.visibility==='secret') return context.owner_authorized===true && context.include_secret===true
  if (row.visibility==='owner') return context.owner_authorized===true
  return row.visibility==='conversation' && (context.owner_authorized===true || !!context.conversation_id && row.platform===context.platform && row.conversation_id===context.conversation_id)
}
export function compareText(value) { return value.toLowerCase().replace(/\s+/g,' ').trim() }
/** This is conservative textual grounding, not an LLM truth judgement. A small
 * matching value cannot endorse extra claims in content, change a numeric sign,
 * or turn an explicitly negative relation into a positive assertion. */
export function directlySupports(source, {object,content,predicate}) {
  const evidence=compareText(source),value=compareText(object),body=compareText(content)
  if(!evidence.includes(value)||!evidence.includes(body))return false
  const numeric=value=>value.match(/(?<![\p{L}\d_.])[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?(?![\p{L}\d_.])/giu)||[]
  const sourceNumbers=new Set(numeric(evidence))
  if([...numeric(value),...numeric(body)].some(number=>!sourceNumbers.has(number)))return false
  const positiveRelation=/(?:喜欢|喜爱|偏爱|支持|赞同|允许|同意|\blikes?\b|\bloves?\b|\bsupports?\b|\ballows?\b)/i.test(predicate)
  const negativeRelation=/(?:不|没|无|讨厌|拒绝|禁止|\bnot\b|\bdislikes?\b)/i.test(predicate)
  if(positiveRelation&&!negativeRelation){
    for(const match of evidence.matchAll(/(?:不|没|并非|从未|拒绝|禁止)\s*(?:喜欢|喜爱|偏爱|支持|赞同|允许|同意)[^。；\n]{0,60}|\b(?:does?\s+not|don'?t|never)\s+(?:like|love|support|allow)[^.!?\n]{0,80}/gi))
      if(match[0].includes(value))return false
  }
  return true
}
export function searchTerms(value) {
  const text=compareText(value).slice(0,240), values=[text]
  for (const part of text.match(/[a-z0-9_.-]{2,}|[\p{Script=Han}]{2,}/gu)||[]) {
    values.push(part)
    if (/\p{Script=Han}/u.test(part)) for(let n=0;n<part.length-1;n++) values.push(part.slice(n,n+2))
  }
  return [...new Set(values.filter(Boolean))].slice(0,64)
}
export function searchScore(text, terms) {
  const value=compareText(text)
  return terms.reduce((score,term,index)=>score+(value.includes(term)?index===0?24:term.length>2?4:1:0),0)
}
export function page(text,{offset=0,max_chars=1800}={}) {
  integer(offset,'offset'); integer(max_chars,'max_chars',1,1800)
  // Offset/length are UTF-16 units, like JavaScript String.length; do not split a
  // surrogate pair at a normal page boundary.
  let start=Math.min(offset,text.length), end=Math.min(text.length,start+max_chars)
  if (start>0 && /[\uDC00-\uDFFF]/.test(text[start]??'') && /[\uD800-\uDBFF]/.test(text[start-1])) start--
  if (end>start && /[\uD800-\uDBFF]/.test(text[end-1]) && /[\uDC00-\uDFFF]/.test(text[end]??'')) end--
  if(end===start && start<text.length)end=Math.min(text.length,start+2)
  return {text:text.slice(start,end),offset:start,total_chars:text.length,next_offset:end<text.length?end:null,truncated:start>0||end<text.length}
}
export function evidenceLabel(row) {
  if (row.direction==='out') return row.status==='confirmed'&&row.confirmation==='server_receipt'?'已确认动作回执；只证明发出，不证明正文判断':'未确认动作；不能当作已完成'
  if (row.confirmation==='user_statement') return '用户原话；未独立核验现实真伪'
  if (row.confirmation==='source_observation') return '已读取来源内容；未独立核验内容真伪'
  return '来源记事；尚未确认'
}
export function entryLabel(row) {
  if(row.status==='stale')return '历史旧值/已结束记录；不作为当前事实'
  if(row.status==='expired')return '已失效记事；不作为当前事实'
  if(row.status==='forgotten')return '已主动遗忘的记事；来源保留'
  if(row.memory_type==='recorded')return '记事记录，未独立验证'
  if(row.status==='pending_inference'||row.memory_type==='inferred')return '待确认推断'
  if(row.status!=='active')return '待核实记忆（'+row.status+'）'
  return row.memory_type==='asserted'?'有明确原话支持；未独立核验现实真伪':'有来源支持的观察；未独立核验内容真伪'
}
