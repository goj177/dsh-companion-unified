import {isPlainObject} from './contracts.mjs'
import {canonicalBar} from './tieba-atmosphere.mjs'

export const TIEBA_REPLY_INTENTS=Object.freeze(['answer','chat','share','joke'])
export const TIEBA_REPLY_INTENT_GUIDE='回复可选target.intent=answer/chat/share/joke声明答疑/接话/分享/玩梗；intent只放target内部，不放工具顶层。关闭答疑时明确answer会被拦截，未声明沿用兼容行为。这是用途声明，不是语义识别。'
export const tiebaDeclaredAnswerAllowed=(config,target)=>target?.intent!=='answer'||config?.permissions?.answer_questions!==false

export function tiebaBarRepliesIgnored(config,bar){
  if(!config?.ignored_reply_bars?.length||typeof bar!=='string'||!bar)return false
  let name
  try{name=canonicalBar(bar)}catch{return false}
  return config.ignored_reply_bars.some(entry=>{
    try{return canonicalBar(entry)===name}catch{return false}
  })
}

/** Owner settings use exact platform UIDs and expire without a scheduled write. */
export function tiebaReplyPaused(config,actor_uid,now,source_at){
  return typeof actor_uid==='string'&&!!actor_uid&&(config?.reply_pauses??[]).some(row=>row.actor_uid===actor_uid&&(row.until>now||Number.isSafeInteger(source_at)&&source_at<row.skip_before))
}

/** An owner pause covers this entire thread and retains a source-time cutoff
 * after expiry, so messages received while paused are not replayed later. */
export function tiebaThreadReplyPaused(config,thread_id,now,source_at,{unknown_source_blocks=false}={}){
  if(typeof thread_id!=='string'||!thread_id)return false
  return (config?.thread_reply_pauses??[]).some(row=>row.thread_id===thread_id&&(row.until>now||Number.isSafeInteger(row.skip_before)&&row.skip_before>0&&(Number.isSafeInteger(source_at)?source_at<row.skip_before:unknown_source_blocks)))
}

/** Use the same target contract before freezing a draft and before sending.
 * Incoming message envelopes also carry context; those fields are not valid
 * publication coordinates and must be corrected by the caller, not dropped. */
export function assertTiebaActionTarget(kind,target){
  const allowed=kind==='tieba.reply'?['bar','thread_id','post_id','sub_reply_id','reply_uid','reply_profile_id','target_name','asset_ids','emotes','intent']:kind==='tieba.post'?['bar','title','asset_ids','emotes','encrypt_replies']:['tieba.sign','tieba.follow','tieba.unfollow'].includes(kind)?['bar']:null
  if(!allowed)throw new Error('未知贴吧发表操作')
  if(!isPlainObject(target)||Object.keys(target).some(key=>!allowed.includes(key)))throw new Error('动作包含未定义目标字段；'+kind+' 的target只允许 '+allowed.join('、')+'，不要复制来信的消息上下文字段')
  if(kind==='tieba.reply'&&Object.hasOwn(target,'intent')&&!TIEBA_REPLY_INTENTS.includes(target.intent))throw new Error('贴吧回复intent只能为answer/chat/share/joke；未声明时请省略此字段')
  if(kind==='tieba.post'&&Object.hasOwn(target,'encrypt_replies')&&target.encrypt_replies!==true)throw new Error('encrypt_replies 只接受 true')
  if(Object.hasOwn(target,'asset_ids')&&(!Array.isArray(target.asset_ids)||target.asset_ids.length>1||target.asset_ids.some(id=>typeof id!=='string'||!/^asset:[a-f0-9]{64}$/.test(id))))throw new Error('贴吧配图必须使用完整的原生asset_ref（asset:加64位哈希），最多一张；请从素材列表复制，不传裸哈希、路径或网址')
}
