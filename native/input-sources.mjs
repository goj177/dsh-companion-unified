import {NativeStore} from './store.mjs'

const textOf=value=>typeof value==='string'?value:Array.isArray(value)?value.filter(x=>x?.type==='text').map(x=>x.text??'').join('\n'):''
const sidOf=agent=>agent?.session?.id??agent?.session?.header?.id??''

/** Consumed source envelopes are host capabilities, not role labels found in
 * page text. Share the same identity checks across state and learning. */
export function admittedHumanSources({store,agent,messages=[],context={},task,memory,qq}={}){
  if(!(store instanceof NativeStore))throw new Error('真人来源必须使用原生存储')
  const sid=sidOf(agent),found=new Map(),add=(key,text,platform,fields={})=>{
    found.set(key,{key,text,platform,session_id:sid,conversation_id:context.conversation_id??'',actor_uid:context.actor_uid??'',actor_entity_id:context.actor_entity_id,owner_authorized:context.owner_authorized===true,...fields})
  }
  if(!sid||context.memory_only)return []
  for(const message of messages){
    if(message?.role!=='user')continue
    const source=message.source??{}
    if(source.kind==='user'&&typeof message.id==='string'&&message.id&&textOf(message.content).trim())add('human:'+message.id,textOf(message.content),['qq','bilibili','tieba'].includes(context.platform)?context.platform:'harness',{message_id:message.id})
    if(source.kind!=='plugin:companion-qq')continue
    if(source.humanEvidenceId&&memory?.turns.get(sid)?.evidence_ids.includes(source.humanEvidenceId)){
      const row=store.db.prepare('SELECT * FROM evidence WHERE id=?').get(source.humanEvidenceId)
      if(row?.platform==='qq'&&row.direction==='in'&&row.source_type==='user'&&row.actor_uid===context.actor_uid&&row.conversation_id===context.conversation_id)add('human-evidence:'+row.id,row.text,'qq',{evidence_id:row.id,source_at:row.source_at})
    }else if(!source.humanEvidenceId){
      const bound=qq?.turns.get(sid),id=source.inbound_id,row=typeof id==='string'?store.db.prepare('SELECT kind,status,target_json,metadata_json FROM actions WHERE id=?').get(id):null
      if(!bound?.frozen||!bound.running||bound.autonomous||!bound.inbound_ids?.includes(id)||row?.kind!=='qq.inbound'||row.status!=='running')continue
      const target=JSON.parse(row.target_json),meta=JSON.parse(row.metadata_json)
      if(!meta.evidence_id&&target.session_id===sid&&target.conversation_id===context.conversation_id&&meta.actor_uid===context.actor_uid&&meta.actor_uid===source.actor_uid&&String(meta.assigned_turn)===String(bound.turn_id))add('human-inbound:'+id,meta.moderation_text??'','qq',{operation_id:'operation:'+id,source_at:meta.source_at})
    }
  }
  if(task?.input_bound&&task.batch?.kind==='activity.incoming')for(const source of task.batch.tasks??[]){
    if(source.metadata?.human!==true)continue
    const target=source.target??{},scope={conversation_id:target.conversation_id??'',actor_uid:target.actor_uid??'',owner_authorized:false}
    if(!source.source_evidence_id){if(scope.actor_uid&&scope.conversation_id&&typeof source.body==='string')add('human-task:'+source.id,source.body,source.platform,{...scope,operation_id:'operation:'+source.id});continue}
    const row=store.db.prepare('SELECT * FROM evidence WHERE id=?').get(source.source_evidence_id)
    if(row?.source_type==='user'&&row.direction==='in'&&row.platform===source.platform&&row.actor_uid===scope.actor_uid&&row.conversation_id===scope.conversation_id)add('human-evidence:'+row.id,row.text,row.platform,{...scope,evidence_id:row.id,source_at:row.source_at,actor_entity_id:row.actor_entity_id})
  }
  return [...found.values()]
}
