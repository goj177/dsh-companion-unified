/** Conservative pre-model checks for official Tieba reply notifications. */
import {createHash} from 'node:crypto'
import {explicitSourceReplyUid} from './source-context.mjs'
import {redactText} from './memory-rules.mjs'
import {decodeTiebaPublicText,tiebaThreadUsesEncryptedReplies} from './tieba-encoded-text.mjs'
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
  const source_id=String(row?.post_id??row?.sub_reply_id??''),author_uid=String(row?.author_uid??row?.author?.uid??''),raw=typeof row?.text==='string'?row.text:''
  if(!/^[1-9]\d*$/.test(source_id)||!/^[1-9]\d*$/.test(author_uid)||!raw.trim())return null
  const decoded=decodeTiebaPublicText(raw),text=decoded??raw
  return {source_id,author_uid,author_name:String(row.name??row.author?.name_show??row.author?.name??'').replace(/[\r\n\t]/g,' ').slice(0,80),author_role:author_uid===self_uid?'account_self':author_uid===topic_author_uid?'topic_author':'participant',reply_to_uid:explicitSourceReplyUid(row)||null,text:text.slice(0,max_chars).toWellFormed(),...(text.length>max_chars?{text_truncated:true,total_chars:text.length}:{}),...(decoded!==null?{text_encoding:'base64_aes_256_gcm'}:{}),verification}
}

function restoreEncodedTopicQuote(store,record,{thread_id,bar,self_uid}){
  if(record.verification!=='server_read'||record.author_uid!==self_uid||record.text_truncated!==true||!record.text?.startsWith('eyJ'))return record
  const row=store.db.prepare("SELECT body,body_digest,target_json,receipt_json FROM actions WHERE kind='tieba.post' AND platform='tieba' AND status='confirmed' AND json_extract(receipt_json,'$.thread_id')=? AND json_extract(receipt_json,'$.server_id')=? LIMIT 2").all(thread_id,record.source_id)
  if(row.length!==1)return record
  const {body,body_digest,target_json,receipt_json}=row[0],target=JSON.parse(target_json),receipt=JSON.parse(receipt_json),read=receipt.readback
  if(target.bar!==bar||receipt.source!=='server_receipt'||receipt.accepted!==true||read?.author_uid!==self_uid||read.thread_id!==thread_id||read.post_id!==record.source_id||read.floor!==1||read.body_sha256!==body_digest||body.length!==record.total_chars||!body.startsWith(record.text)||createHash('sha256').update(body).digest('hex')!==body_digest)return record
  const text=decodeTiebaPublicText(body)
  if(text===null)return record
  return {...record,text:text.slice(0,480).toWellFormed(),text_truncated:text.length>480,total_chars:text.length,text_encoding:'base64_aes_256_gcm'}
}

/** Only a matching confirmed receipt may recover our own reply's recipient. */
export function verifiedTiebaSelfRecipient(store,{source_id,self_uid,thread_id,parent_post_id}={}){
  if(![source_id,self_uid,thread_id,parent_post_id].every(value=>typeof value==='string'&&/^[1-9]\d*$/.test(value)))return ''
  const rows=store.db.prepare("SELECT body,body_digest,target_json,receipt_json FROM actions WHERE platform='tieba' AND kind='tieba.reply' AND status='confirmed' AND json_extract(receipt_json,'$.server_id')=? LIMIT 2").all(source_id)
  if(rows.length!==1)return ''
  const row=rows[0];let target,receipt
  try{target=JSON.parse(row.target_json);receipt=JSON.parse(row.receipt_json)}catch{return ''}
  const read=receipt?.readback,recipient=target?.reply_uid
  if(!/^[1-9]\d*$/.test(recipient??'')||target.thread_id!==thread_id||target.post_id!==parent_post_id||receipt.source!=='server_receipt'||receipt.accepted!==true||receipt.rejected===true||receipt.code!==undefined&&receipt.code!==0||receipt.reply_uid!==recipient||read?.author_uid!==self_uid||read.post_id!==source_id||read.thread_id!==thread_id||read.parent_post_id!==parent_post_id||read.reply_uid!==recipient||read.body_sha256!==row.body_digest||createHash('sha256').update(row.body).digest('hex')!==row.body_digest)return ''
  return recipient
}

/** Small factual continuity across public threads, bound to this exact UID. No private summaries, learned cards or generated memory. */
const peerConversation=value=>{const found=/^thread:([1-9]\d*)(?::([1-9]\d*))?$/.exec(String(value??''));return found?{thread_id:found[1],parent_post_id:found[2]??null}:null}
const samePeerConversation=(row,conversation)=>{const current=peerConversation(conversation);return !!current&&row.thread_id===current.thread_id&&(row.parent_post_id??null)===current.parent_post_id}
const peerTime=row=>row.fact.source_at??row.recorded_at??0
const matchingPeerCoordinate=(values,expected)=>{const present=values.filter(value=>value!==undefined&&value!==null&&value!=='');return present.every(value=>value===expected)&&(!expected||present.length>0)}
function trimPeerDialogue(peer,conversation_id){const rows=peer.recent_public_dialogue,index=rows.findIndex(row=>!samePeerConversation(row,conversation_id));rows.splice(index<0?0:index,1)}
const mentionLabel=value=>typeof value==='string'?redactText(value.replace(/[\r\n\t]/g,' ').trim()).slice(0,80).toWellFormed():''
/** Names come from the same verified protocol part as the UID, never by scanning @ in prose. */
export function tiebaMentionLabels(row,mentioned_uids,self_uid){
  const labels=[],seen=new Set([self_uid,row.author_uid])
  for(const part of row.content_parts??[]){
    if(part.kind!=='mention'||seen.has(part.uid)||!mentioned_uids.includes(part.uid)||!Number.isSafeInteger(part.start)||!Number.isSafeInteger(part.end)||part.start<0||part.end<=part.start||part.end>row.text.length)continue
    const text=mentionLabel(row.text.slice(part.start,part.end));if(!text)continue
    labels.push({uid:part.uid,text});seen.add(part.uid);if(labels.length===4)break
  }
  return labels
}
export function tiebaReplyContextLimits(store){
  const id=store.getDocument('settings')?.value.platform_document_ids?.tieba??'tieba'
  const config=store.getDocument(id)?.value.tieba?.reply_context
  return {peer_history_limit:config?.peer_history_limit??3,nearby_reply_limit:config?.nearby_reply_limit??4}
}

export function publicTiebaPeerContext(store,{actor_uid,self_uid,conversation_id,exclude_evidence_id='',history_limit=tiebaReplyContextLimits(store).peer_history_limit,max_chars=Math.max(1000,history_limit*330),before_at=null,include_public_name=false}={}){
  if(history_limit===0||!/^[1-9]\d*$/.test(actor_uid??'')||!/^[1-9]\d*$/.test(self_uid??'')||actor_uid===self_uid)return null
  const identity=store.getPlatformIdentity('tieba',actor_uid);if(!identity||identity.role==='account')return null
  const entity=store.db.prepare("SELECT short_ref FROM entities WHERE id=? AND kind='person'").get(identity.entity_id),current=peerConversation(conversation_id),current_thread=current?.thread_id??'',current_parent=current?.parent_post_id??'',conversation=String(conversation_id??''),records=[],key=id=>String(id??'').replace(/^reply:/,'')
  const incoming=store.db.prepare("SELECT id,conversation_id,source_message_id,source_at,recorded_at,text,json_extract(source_json,'$.nickname') nickname FROM evidence WHERE platform='tieba' AND actor_uid=? AND direction='in' AND source_type='user' AND visibility='public' AND status IN ('confirmed','pending','uncertain') AND id<>? AND (actor_entity_id IS NULL OR actor_entity_id=?) AND json_extract(source_json,'$.kind') IN ('user','human','user_statement') AND (? IS NULL OR source_at<?) ORDER BY CASE WHEN conversation_id=? THEN 0 ELSE 1 END,source_at DESC,recorded_at DESC LIMIT 40").all(actor_uid,exclude_evidence_id,identity.entity_id,before_at,before_at,conversation).filter(row=>peerConversation(row.conversation_id)&&/^[1-9]\d*$/.test(key(row.source_message_id)))
  for(const row of incoming){const coordinates=peerConversation(row.conversation_id),source_id=key(row.source_message_id);if(lowInformationTiebaReply({text:row.text}))continue;records.push({conversation_id:row.conversation_id,recorded_at:row.recorded_at,fact:{...coordinates,source_id,author_uid:actor_uid,author_role:'counterpart',text:row.text.slice(0,120).toWellFormed(),...(row.text.length>120?{text_truncated:true,total_chars:row.text.length}:{}),source_at:row.source_at,verification:'public_user_statement'}})}
  const outgoing=store.db.prepare("SELECT body,body_digest,target_json,receipt_json,confirmed_at FROM actions WHERE platform='tieba' AND kind='tieba.reply' AND status='confirmed' AND (json_extract(target_json,'$.reply_uid')=? OR json_extract(receipt_json,'$.reply_uid')=?) AND (? IS NULL OR COALESCE(json_extract(receipt_json,'$.readback.source_at'),confirmed_at)<?) ORDER BY CASE WHEN json_extract(target_json,'$.thread_id')=? AND COALESCE(json_extract(target_json,'$.post_id'),'')=? THEN 0 ELSE 1 END,confirmed_at DESC LIMIT 12").all(actor_uid,actor_uid,before_at,before_at,current_thread,current_parent)
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
  const selected=[],seen=new Set();for(const row of records){const key=row.fact.thread_id+':'+row.fact.source_id;if(seen.has(key))continue;seen.add(key);selected.push(row);if(selected.length===history_limit)break}
  const public_name=include_public_name?incoming.map(row=>mentionLabel(row.nickname)).find(Boolean):''
  const result={uid:actor_uid,entity_ref:entity?.short_ref??identity.entity_id,known_before:incoming.length>0||records.length>0,seen_in_other_threads:incoming.some(row=>peerConversation(row.conversation_id).thread_id!==current_thread)||records.some(row=>row.fact.thread_id!==current_thread),recent_public_dialogue:selected.map(row=>row.fact),...(public_name?{public_name}:{})}
  while(selected.length&&JSON.stringify(result).length>max_chars){selected.pop();result.recent_public_dialogue=selected.map(row=>row.fact)}
  result.recent_public_dialogue=selected.sort((a,b)=>peerTime(a)-peerTime(b)||(a.recorded_at??0)-(b.recorded_at??0)).map(row=>row.fact)
  return result
}

function mentionedTiebaPeople(store,context,source,self_uid){
  const {mention_labels,source_context}=context,seen=new Set([self_uid,source.actor_uid]),people=[]
  if(source_context.platform!=='tieba'||source_context.visibility!=='public'||!Array.isArray(source_context.mentioned_uids)||!peerConversation(source.conversation_id))return people
  for(const uid of source_context.mentioned_uids){
    if(typeof uid!=='string'||!/^[1-9]\d*$/.test(uid)||seen.has(uid))continue
    seen.add(uid)
    const peer=publicTiebaPeerContext(store,{actor_uid:uid,self_uid,conversation_id:source.conversation_id,before_at:source.source_at,include_public_name:true,history_limit:3,max_chars:900})
    const mention_text=mentionLabel(Array.isArray(mention_labels)?mention_labels.find(label=>label?.uid===uid)?.text:'')
    people.push({uid,...(mention_text?{mention_text}:peer?.public_name?{public_name:peer.public_name}:{}),known_before:peer?.known_before??false,seen_in_other_threads:peer?.seen_in_other_threads??false,recent_public_dialogue:(peer?.recent_public_dialogue??[]).map(fact=>fact.author_uid===uid?{...fact,author_role:'mentioned_person'}:fact)})
    if(people.length===4)break
  }
  return people
}

/** Refresh a model-only view when a queued notification predates the current context format. Stored evidence remains unchanged. */
export function currentTiebaIncomingView(store,batch,self_uid){
  if(batch.platform!=='tieba'||batch.kind!=='activity.incoming'||!/^[1-9]\d*$/.test(self_uid??''))return batch
  const {peer_history_limit,nearby_reply_limit}=tiebaReplyContextLimits(store)
  const tasks=batch.tasks.map(task=>{
    let envelope;try{envelope=JSON.parse(task.metadata?.public_context??'null')}catch{return task}
    const source=task.source_evidence_id?store.db.prepare("SELECT actor_uid,conversation_id,text,source_at FROM evidence WHERE id=? AND platform='tieba' AND direction='in' AND source_type='user' AND visibility='public'").get(task.source_evidence_id):null
    if(!source||source.actor_uid!==task.target.actor_uid||source.conversation_id!==task.target.conversation_id||source.text!==task.body||envelope?.source_context?.account_self_uid!==self_uid||envelope.source_context.current_speaker_uid!==source.actor_uid)return task
    const {public_image_sources=[],...context}=envelope
    if(!Array.isArray(public_image_sources))return task
    const decoded=decodeTiebaPublicText(task.body)
    if(decoded!==null)context.incoming_text_encoding='base64_aes_256_gcm'
    if(tiebaThreadUsesEncryptedReplies(store,task.target.thread_id))context.encrypted_reply=true
    if(context.quoted_context?.authorship==='mixed_or_unresolved')context.quoted_context={records:[],unresolved_notification_excerpt_omitted:true,authority:'quoted_public_source'}
    if(Array.isArray(context.quoted_context?.records))context.quoted_context={...context.quoted_context,records:context.quoted_context.records.map(raw=>{
      const record=decoded===null&&!context.encrypted_reply?raw:restoreEncodedTopicQuote(store,raw,{thread_id:task.target.thread_id,bar:task.target.bar,self_uid})
      if(record.author_uid!==self_uid||record.reply_to_uid)return record
      const reply_to_uid=verifiedTiebaSelfRecipient(store,{source_id:record.source_id,self_uid,thread_id:task.target.thread_id,parent_post_id:task.target.post_id})
      return reply_to_uid?{...record,reply_to_uid,recipient_verification:'confirmed_local_receipt'}:record
    })}
    const identity=store.getPlatformIdentity('tieba',source.actor_uid);context.speaker={uid:source.actor_uid,name:identity?.display_name??'',role:'counterpart'};delete context.peer_context
    const peer=publicTiebaPeerContext(store,{actor_uid:source.actor_uid,self_uid,conversation_id:source.conversation_id,exclude_evidence_id:task.source_evidence_id,history_limit:peer_history_limit});if(peer)context.peer_context=peer
    if(Array.isArray(context.nearby_context?.records)){
      const records=context.nearby_context.records
      if(!nearby_reply_limit)delete context.nearby_context
      else context.nearby_context={...context.nearby_context,records:records.slice(Math.max(0,records.length-nearby_reply_limit))}
    }
    const mentioned=mentionedTiebaPeople(store,context,source,self_uid);delete context.mention_labels;delete context.mentioned_people
    if(mentioned.length)context.mentioned_people=mentioned
    const pack=()=>JSON.stringify({...context,...(public_image_sources.length?{public_image_sources}:{})})
    while(context.peer_context?.recent_public_dialogue?.length&&pack().length>4000)trimPeerDialogue(context.peer_context,source.conversation_id)
    if(pack().length>4000)delete context.peer_context
    while(context.nearby_context?.records?.length&&pack().length>4000)context.nearby_context.records.shift()
    for(const person of [...mentioned].reverse())while(person.recent_public_dialogue.length&&pack().length>4000)trimPeerDialogue(person,source.conversation_id)
    while(mentioned.length&&pack().length>4000)mentioned.pop()
    if(!mentioned.length)delete context.mentioned_people
    const public_context=pack();if(public_context.length>4000)return task
    return {...task,...(decoded!==null?{body:decoded}:{}),metadata:{...task.metadata,public_context}}
  })
  return {...batch,tasks}
}
