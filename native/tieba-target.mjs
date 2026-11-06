import {isPlainObject} from './contracts.mjs'

/** Use the same target contract before freezing a draft and before sending.
 * Incoming message envelopes also carry context; those fields are not valid
 * publication coordinates and must be corrected by the caller, not dropped. */
export function assertTiebaActionTarget(kind,target){
  const allowed=kind==='tieba.reply'?['bar','thread_id','post_id','sub_reply_id','reply_uid','reply_profile_id','target_name','asset_ids']:kind==='tieba.post'?['bar','title','asset_ids']:['tieba.sign','tieba.follow','tieba.unfollow'].includes(kind)?['bar']:null
  if(!allowed)throw new Error('未知贴吧发表操作')
  if(!isPlainObject(target)||Object.keys(target).some(key=>!allowed.includes(key)))throw new Error('动作包含未定义目标字段；'+kind+' 的target只允许 '+allowed.join('、')+'，不要复制来信的消息上下文字段')
}
