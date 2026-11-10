/** Conservative pre-model checks for official Tieba reply notifications. */
import {createHash} from 'node:crypto'
const numericQuestion=/多少|几个|几条|几次|几岁|几点|数值|答案|选(?:择)?(?:第|哪|几|项)|(?:回|给|填|报).{0,8}(?:数字|编号|序号)|[1-9一二三].{0,6}(?:还是|或)/u
export function lowInformationTiebaReply(row,{previous_text=''}={}){
  if(typeof row?.text!=='string'||row.content_parts?.some(part=>part.type===3)||/https?:\/\/|\[图片\]|\[贴吧图片\]|[?？]/i.test(row.text))return false
  const body=row.text.normalize('NFKC').replace(/^\s*回复\s+[^:：\n]{1,80}[:：]\s*/u,'').replace(/\[贴吧表情\]/g,'').replace(/[\s!。，、…~]/gu,'')
  if(!body||body.length>64||!/^(?:3+|6+|233+|顶+|帮顶|路过|签到|打卡|水(?:一波|一下)?经验|经验\+?\d+)$/u.test(body))return false
  if(/^\d+$/.test(body)&&numericQuestion.test(previous_text))return false
  return true
}

/** Each text fragment carries its own verified speaker; notification prose is never split into invented authors. */
export function tiebaContextRecord(row,{self_uid='',topic_author_uid='',verification='server_read',max_chars=360}={}){
  const source_id=String(row?.post_id??row?.sub_reply_id??''),author_uid=String(row?.author_uid??row?.author?.uid??''),text=typeof row?.text==='string'?row.text:''
  if(!/^[1-9]\d*$/.test(source_id)||!/^[1-9]\d*$/.test(author_uid)||!text.trim())return null
  return {source_id,author_uid,author_name:String(row.name??row.author?.name_show??row.author?.name??'').replace(/[\r\n\t]/g,' ').slice(0,80),author_role:author_uid===self_uid?'account_self':author_uid===topic_author_uid?'topic_author':'participant',reply_to_uid:typeof row.reply_to_uid==='string'&&/^[1-9]\d*$/.test(row.reply_to_uid)?row.reply_to_uid:null,text:text.slice(0,max_chars).toWellFormed(),...(text.length>max_chars?{text_truncated:true,total_chars:text.length}:{}),verification}
}

/** Small factual continuity across public threads, bound to this exact UID. No private summaries, learned cards or generated memory. */
const peerConversation=value=>{const found=/^thread:([1-9]\d*)(?::([1-9]\d*))?$/.exec(String(value??''));return found?{thread_id:found[1],parent_post_id:found[2]??null}:null}
const samePeerConversation=(row,conversation)=>{const current=peerConversation(conversation);return !!current&&row.thread_id===current.thread_id&&(row.parent_post_id??null)===current.parent_post_id}
const peerTime=row=>row.fact.source_at??row.recorded_at??0
const matchingPeerCoordinate=(values,expected)=>{const present=values.filter(value=>value!==undefined&&value!==null&&value!=='');return present.every(value=>value===expected)&&(!expected||present.length>0)}
function trimPeerDialogue(peer,conversation_id){const rows=peer.recent_public_dialogue,index=rows.findIndex(row=>!samePeerConversation(row,conversation_id));rows.splice(index<0?0:index,1)}
export function publicTiebaPeerContext(store,{actor_uid,self_uid,conversation_id,exclude_evidence_id='',max_chars=1000}={}){
  if(!/^[1-9]\d*$/.test(actor_uid??'')||!/^[1-9]\d*$/.test(self_uid??'')||actor_uid===self_uid)return null
  const identity=store.getPlatformIdentity('tieba',actor_uid);if(!identity||identity.role==='account')return null
  const entity=store.db.prepare("SELECT short_ref FROM entities WHERE id=? AND kind='person'").get(identity.entity_id),current=peerConversation(conversation_id),current_thread=current?.thread_id??'',current_parent=current?.parent_post_id??'',conversation=String(conversation_id??''),records=[],key=id=>String(id??'').replace(/^reply:/,'')
  const incoming=store.db.prepare("SELECT id,conversation_id,source_message_id,source_at,recorded_at,text FROM evidence WHERE platform='tieba' AND actor_uid=? AND direction='in' AND source_type='user' AND visibility='public' AND status IN ('confirmed','pending','uncertain') AND id<>? AND (actor_entity_id IS NULL OR actor_entity_id=?) AND json_extract(source_json,'$.kind') IN ('user','human','user_statement') ORDER BY CASE WHEN conversation_id=? THEN 0 ELSE 1 END,source_at DESC,recorded_at DESC LIMIT 40").all(actor_uid,exclude_evidence_id,identity.entity_id,conversation)
  for(const row of incoming){const coordinates=peerConversation(row.conversation_id),source_id=key(row.source_message_id);if(!coordinates||!/^[1-9]\d*$/.test(source_id)||lowInformationTiebaReply({text:row.text}))continue;records.push({conversation_id:row.conversation_id,recorded_at:row.recorded_at,fact:{...coordinates,source_id,author_uid:actor_uid,author_role:'counterpart',text:row.text.slice(0,120).toWellFormed(),...(row.text.length>120?{text_truncated:true,total_chars:row.text.length}:{}),source_at:row.source_at,verification:'public_user_statement'}})}
  const outgoing=store.db.prepare("SELECT body,body_digest,target_json,receipt_json,confirmed_at FROM actions WHERE platform='tieba' AND kind='tieba.reply' AND status='confirmed' AND (json_extract(target_json,'$.reply_uid')=? OR json_extract(receipt_json,'$.reply_uid')=?) ORDER BY CASE WHEN json_extract(target_json,'$.thread_id')=? AND COALESCE(json_extract(target_json,'$.post_id'),'')=? THEN 0 ELSE 1 END,confirmed_at DESC LIMIT 12").all(actor_uid,actor_uid,current_thread,current_parent)
  for(const row of outgoing){
    let target,receipt;try{target=JSON.parse(row.target_json);receipt=JSON.parse(row.receipt_json)}catch{continue}
    if(!target||!receipt||receipt.source!=='server_receipt'||receipt.accepted!==true||receipt.rejected===true||receipt.code!==undefined&&receipt.code!==0||receipt.readback?.author_uid!==self_uid||typeof receipt.server_id!=='string'||!/^[1-9]\d*$/.test(receipt.server_id)||typeof target.thread_id!=='string'||!/^[1-9]\d*$/.test(target.thread_id)||createHash('sha256').update(row.body).digest('hex')!==row.body_digest)continue
    const recipients=[target.reply_uid,receipt.reply_uid].filter(value=>value!==undefined&&value!==null&&value!=='');if(!recipients.length||recipients.some(value=>value!==actor_uid)||receipt.readback.reply_uid!==undefined&&receipt.readback.reply_uid!==actor_uid)continue
    if(target.channel&&target.channel!=='comment'||target.visibility&&target.visibility!=='public'||String(target.conversation_id??'').startsWith('dm:')||target.recipient_uid)continue
    const parent=target.post_id??'',child=target.sub_reply_id??'';if(parent!==''&&(typeof parent!=='string'||!/^[1-9]\d*$/.test(parent))||child!==''&&(!parent||typeof child!=='string'||!/^[1-9]\d*$/.test(child)))continue
    if(!matchingPeerCoordinate([receipt.thread_id,receipt.readback.thread_id],target.thread_id)||!matchingPeerCoordinate([receipt.parent_post_id,receipt.readback.parent_post_id],parent)||!matchingPeerCoordinate([receipt.parent_sub_reply_id,receipt.readback.parent_sub_reply_id],child)||receipt.readback.post_id!==undefined&&receipt.readback.post_id!==receipt.server_id||receipt.readback.body_sha256!==undefined&&receipt.readback.body_sha256!==row.body_digest)continue
    const source_at=receipt.readback.source_at??row.confirmed_at;if(!Number.isSafeInteger(source_at)||source_at<0)continue
    records.push({conversation_id:'thread:'+target.thread_id+(parent?':'+parent:''),recorded_at:row.confirmed_at,fact:{thread_id:target.thread_id,parent_post_id:parent||null,source_id:receipt.server_id,author_uid:self_uid,author_role:'account_self',reply_to_uid:actor_uid,text:row.body.slice(0,120).toWellFormed(),...(row.body.length>120?{text_truncated:true,total_chars:row.body.length}:{}),source_at,verification:'server_receipt'}})
  }
  records.sort((a,b)=>Number(b.conversation_id===conversation)-Number(a.conversation_id===conversation)||peerTime(b)-peerTime(a)||(b.recorded_at??0)-(a.recorded_at??0))
  const selected=[],seen=new Set();for(const row of records){const key=row.fact.thread_id+':'+row.fact.source_id;if(seen.has(key))continue;seen.add(key);selected.push(row);if(selected.length===3)break}
  const result={uid:actor_uid,entity_ref:entity?.short_ref??identity.entity_id,known_before:incoming.length>0||records.length>0,seen_in_other_threads:incoming.some(row=>{const prior=peerConversation(row.conversation_id);return prior&&prior.thread_id!==current_thread})||records.some(row=>row.fact.thread_id!==current_thread),recent_public_dialogue:selected.map(row=>row.fact)}
  while(selected.length&&JSON.stringify(result).length>max_chars){selected.pop();result.recent_public_dialogue=selected.map(row=>row.fact)}
  result.recent_public_dialogue=selected.sort((a,b)=>peerTime(a)-peerTime(b)||(a.recorded_at??0)-(b.recorded_at??0)).map(row=>row.fact)
  return result
}

/** Refresh a model-only view when a queued notification predates the current context format. Stored evidence remains unchanged. */
export function currentTiebaIncomingView(store,batch,self_uid){
  if(batch.platform!=='tieba'||batch.kind!=='activity.incoming'||!/^[1-9]\d*$/.test(self_uid??''))return batch
  const tasks=batch.tasks.map(task=>{
    let envelope;try{envelope=JSON.parse(task.metadata?.public_context??'null')}catch{return task}
    const source=task.source_evidence_id?store.db.prepare("SELECT actor_uid,conversation_id,text FROM evidence WHERE id=? AND platform='tieba' AND direction='in' AND source_type='user' AND visibility='public'").get(task.source_evidence_id):null
    if(!source||source.actor_uid!==task.target.actor_uid||source.conversation_id!==task.target.conversation_id||source.text!==task.body||envelope?.source_context?.account_self_uid!==self_uid||envelope.source_context.current_speaker_uid!==source.actor_uid)return task
    const {public_image_sources=[],...context}=envelope
    if(!Array.isArray(public_image_sources))return task
    if(context.quoted_context?.authorship==='mixed_or_unresolved')context.quoted_context={records:[],unresolved_notification_excerpt_omitted:true,authority:'quoted_public_source'}
    const identity=store.getPlatformIdentity('tieba',source.actor_uid);context.speaker={uid:source.actor_uid,name:identity?.display_name??'',role:'counterpart'};delete context.peer_context
    const peer=publicTiebaPeerContext(store,{actor_uid:source.actor_uid,self_uid,conversation_id:source.conversation_id,exclude_evidence_id:task.source_evidence_id});if(peer)context.peer_context=peer
    const pack=()=>JSON.stringify({...context,...(public_image_sources.length?{public_image_sources}:{})})
    while(context.peer_context?.recent_public_dialogue?.length&&pack().length>4000)trimPeerDialogue(context.peer_context,source.conversation_id)
    if(pack().length>4000)delete context.peer_context
    const public_context=pack();if(public_context.length>4000)return task
    return {...task,metadata:{...task.metadata,public_context}}
  })
  return {...batch,tasks}
}
