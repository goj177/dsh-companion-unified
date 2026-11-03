/** Classify a Bilibili reply from immutable task/evidence links, never LLM flags.
 * Publication carrier tasks are always trigger=manual; they are not the origin.
 */
import {isDeepStrictEqual} from 'node:util'

export function incomingReplyOrigin(store,action){
  if(action?.platform!=='bilibili'||action.kind!=='bilibili.reply'||typeof action.id!=='string')return null
  const row=store.db.prepare('SELECT platform,kind,target_json,request_digest,metadata_json FROM actions WHERE id=?').get(action.id)
  if(!row||row.platform!=='bilibili'||row.kind!=='bilibili.reply'||action.request_digest&&row.request_digest!==action.request_digest)return null
  const target=JSON.parse(row.target_json);if(action.target&&!isDeepStrictEqual(target,action.target))return null
  const round=JSON.parse(row.metadata_json).prepared_in?.round_id;if(typeof round!=='string')return null
  const tasks=store.db.prepare("SELECT id,target_json,source_evidence_id FROM actions WHERE platform='bilibili' AND kind='activity.incoming' AND json_extract(metadata_json,'$.execution')='model' AND json_extract(metadata_json,'$.trigger') IN ('incoming','manual') AND json_extract(metadata_json,'$.human')=1 AND json_extract(metadata_json,'$.batch_id')=?").all(round)
  for(const task of tasks){
    const source=task.source_evidence_id&&store.db.prepare('SELECT platform,source_type,direction,actor_uid,conversation_id FROM evidence WHERE id=?').get(task.source_evidence_id)
    if(source?.platform!=='bilibili'||source.source_type!=='user'||source.direction!=='in')continue
    const original=JSON.parse(task.target_json);if(original.actor_uid!==source.actor_uid||original.conversation_id!==source.conversation_id)continue
    if(target.channel==='dm'){
      if(target.recipient_uid!==source.actor_uid||target.conversation_id!=='dm:'+source.actor_uid||original.conversation_id!==target.conversation_id||original.channel!=='dm')continue
    }else if(target.channel==='live'){
      if(original.channel!=='live'||target.room_id!==original.room_id||target.reply_uid!==source.actor_uid||source.conversation_id!=='live:'+target.room_id||original.reply_dmid&&target.reply_dmid!==original.reply_dmid)continue
    }else{
      if(target.channel&&target.channel!=='comment')continue
      if(!['object_id','object_type','root_reply_id','parent_reply_id'].every(key=>typeof target[key]==='string'&&target[key]===original[key]))continue
      if(source.conversation_id!=='comment:'+target.object_type+':'+target.object_id+':'+target.root_reply_id)continue
    }
    return {task_id:task.id,evidence_id:task.source_evidence_id,round_id:round}
  }
  return null
}
