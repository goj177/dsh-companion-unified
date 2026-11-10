/** Owner-only, evidence-backed people detail. Never used by model familiarity
 * context; no summary generation, relationship mutation or provider calls. */
import {createHash} from 'node:crypto'
import {NativeStore} from './store.mjs'
import {NativeMemory} from './memory.mjs'
import {identifier,redactText,positiveReceipt} from './memory-rules.mjs'

const parse=value=>{try{return JSON.parse(value??'{}')}catch{return{}}}
const hash=value=>createHash('sha256').update(value).digest('hex')
const raw=(row,field)=>row[field+'_bytes']?Buffer.from(row[field+'_bytes']).toString('utf8'):String(row[field]??'')
const clip=(value,max=360)=>{const text=redactText(String(value??'')).replace(/\0/g,' ').trim();let end=Math.min(max,text.length);if(end>0&&/[\uD800-\uDBFF]/.test(text[end-1])&&/[\uDC00-\uDFFF]/.test(text[end]??''))end--;return{text:text.slice(0,end),truncated:end<text.length}}
const sourceLink=value=>{try{const u=new URL(value);if(u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&['tieba.baidu.com','www.bilibili.com','t.bilibili.com','space.bilibili.com'].includes(u.hostname))return redactText(u.href)}catch{}return ''}
const sameIds=(a,b)=>Array.isArray(a)&&Array.isArray(b)&&a.length===b.length&&a.every((id,i)=>id===b[i])
const messageKinds=new Set(['message','statement','user_statement','comment','reply'])
const receiptId=value=>{for(const key of ['message_id','reply_id','rpid','post_id','dynamic_id','id','server_id']){const id=value?.[key];if(typeof id==='string'&&id&&!/^(?:0|-1|null|undefined)$/i.test(id))return id;if(Number.isSafeInteger(id)&&id>0)return String(id)}return ''}
const outKey=(platform,kind,receipt)=>{const id=receiptId(receipt);return id?'out:'+platform+':'+(platform==='bilibili'&&String(kind).includes('dynamic')?'dynamic':'message')+':'+id:''}
const allowedOwner=context=>context?.owner_authorized===true&&context.visibility!=='public'&&!['tieba','bilibili'].includes(context.platform)&&!(context.platform==='qq'&&context.conversation_id?.startsWith('group:'))

export function ownerPeopleDetail({store,now=store?.now,entity_id,event_limit=3}={},trusted={}){
  if(!(store instanceof NativeStore)||typeof now!=='function')throw Error('熟人详情需要原生存储与可信时钟')
  if(!allowedOwner(trusted))throw Error('熟人印象与近期互动仅限主人设置查看')
  identifier(entity_id,'entity_id');if(!Number.isSafeInteger(event_limit)||event_limit<1||event_limit>10)throw Error('近期互动数量须为1至10')
  const current=now(),validTime=value=>Number.isSafeInteger(value)&&value>0&&value<=current+60000
  if(!Number.isSafeInteger(current)||current<0)throw Error('熟人详情时钟无效')
  const entity=store.db.prepare("SELECT id,short_ref,display_name FROM entities WHERE id=? AND kind='person'").get(entity_id)
  if(!entity)return{found:false,person:null,impressions:[],recent_events:[],empty_reason:'没有这个熟人。',model_calls:0,read_only:true}
  const identities=store.listPlatformIdentities({entity_id,limit:1000}).filter(row=>row.role!=='account'),identityMap=new Map(identities.map(row=>[row.namespace+'\0'+row.platform_uid,row])),memory=new NativeMemory(store,{now}),owner={platform:'harness',owner_authorized:true,include_secret:false},human=row=>{
    const identity=identityMap.get(row?.platform+'\0'+row?.actor_uid),source=row?.source??parse(row?.source_json)
    return !!identity&&(!row.actor_entity_id||row.actor_entity_id===entity_id)&&row.direction==='in'&&row.source_type==='user'&&messageKinds.has(row.kind)&&['user','human','user_statement'].includes(source.kind)&&!['rejected','failed','forgotten','unknown'].includes(row.status)&&memory._canEvidence(row,owner)
  },person={...entity,identities:identities.map(({namespace,platform_uid,display_name})=>({namespace,platform_uid,display_name}))},impressions=[]
  const evidence=id=>{try{return memory._effectiveEvidence(id)}catch{return null}}
  const addImpression=item=>{if(!item.text?.trim()||impressions.some(row=>row.text===item.text&&row.platform===item.platform))return;impressions.push(item)}
  for(const identity of identities){
    const value=identity.metadata?.companion_affinity
    if(identity.namespace!=='qq'||value?.schema_version!==1||value.decider!=='companion'||value.subject_uid!==identity.platform_uid||!['liked','disliked'].includes(value.attitude)||typeof value.reason!=='string'||!value.reason.trim()||!validTime(value.decided_at)||!Array.isArray(value.evidence_ids)||!value.evidence_ids.length||value.evidence_ids.length>12||typeof value.decision_event_id!=='string')continue
    const event=store.db.prepare('SELECT *,CAST(text AS BLOB) text_bytes FROM journal_events WHERE id=?').get(value.decision_event_id),meta=parse(event?.metadata_json),proofs=value.evidence_ids.map(evidence)
    if(!event||event.source_type!=='native_qq'||event.entity_id!==entity_id||event.platform!=='qq'||event.source_at!==value.decided_at||meta.event_name!=='qq.affinity_decision'||meta.decider!=='companion'||meta.subject_uid!==identity.platform_uid||meta.attitude!==value.attitude||!sameIds(meta.evidence_ids,value.evidence_ids)||raw(event,'text')!=='自己的相处判断：'+value.reason.trim()||!memory._canJournal(event,owner)||proofs.some(row=>!human(row)||row.platform!=='qq'||row.actor_uid!==identity.platform_uid||row.conversation_id!==event.conversation_id||row.visibility==='secret'||!validTime(row.source_at)||row.source_at>value.decided_at))continue
    addImpression({id:event.id,...clip(value.reason,500),label:value.attitude==='liked'?'大肥鱼觉得亲近':'大肥鱼目前比较疏离',kind:'companion_judgment',platform:'qq',at:value.decided_at,evidence_ids:[...value.evidence_ids],source_ref:'',source_kind:'journal',source_record_id:event.id,sources:[{kind:'journal',id:event.id},...value.evidence_ids.map(id=>({kind:'evidence',id}))],verification:'companion_judgment',verification_label:'大肥鱼自己的相处判断，不代表客观定论'})
  }
  const entries=store.db.prepare("SELECT *,CAST(content AS BLOB) content_bytes FROM memory_entries WHERE actor_entity_id=? AND entity_type='person' AND status IN ('active','pending_confirmation') AND visibility<>'secret' AND (subcategory IN ('person_impression','impression','public_summary') OR predicate IN ('person_impression','impression','印象','public_summary')) ORDER BY source_at DESC,updated_at DESC,id LIMIT 40").all(entity_id)
  for(const entry of entries){
    if(!memory._canEntry(entry,owner)||entry.valid_until!==null&&entry.valid_until<=current||entry.valid_from!==null&&entry.valid_from>current||entry.actor_uid&&!identityMap.has(entry.platform+'\0'+entry.actor_uid))continue
    const content=raw(entry,'content');if(!content.trim())continue
    if(entry.memory_type==='recorded'){
      if(!entry.actor_uid||!identityMap.has(entry.platform+'\0'+entry.actor_uid))continue
      // Imported impressions remain useful source records, not current facts.
      const imported=store.db.prepare("SELECT source_key FROM import_records WHERE target_kind='memory_entry' AND target_id=? AND source_type='sqlite_row'").all(entry.id),journals=store.db.prepare("SELECT j.*,CAST(j.text AS BLOB) text_bytes FROM relations r JOIN journal_events j ON j.id=r.object_id WHERE r.subject_kind='memory_entry' AND r.subject_id=? AND r.relation='derived_from' AND r.object_kind='journal_event'").all(entry.id)
      const origin=journals.find(row=>{const meta=parse(row.metadata_json),o=meta.import_origin;return row.source_type==='v2_impression'&&row.entity_id===entity_id&&row.actor_uid===entry.actor_uid&&row.platform===entry.platform&&row.status==='recorded'&&row.visibility!=='secret'&&raw(row,'text')===content&&o?.source_id==='v2.people'&&o.source_table==='impressions'&&imported.some(record=>record.source_key==='v2.people#impressions/'+o.source_pk)&&memory._canJournal(row,owner)})
      if(origin)addImpression({id:entry.id,...clip(content,600),label:'历史印象',kind:'historical_impression',platform:entry.platform,at:validTime(origin.source_at)?origin.source_at:null,evidence_ids:[],source_ref:sourceLink(origin.ref),source_kind:'journal',source_record_id:origin.id,sources:[{kind:'memory',id:entry.id},{kind:'journal',id:origin.id}],verification:'historical_unverified',verification_label:'历史印象，未重新核验'})
      continue
    }
    const proofs=memory._support(entry.id)
    if(!proofs.length||proofs.some(row=>row.visibility==='secret'||!human(row)||row.actor_entity_id!==entity_id)||!['inferred','asserted','observed'].includes(entry.memory_type))continue
    addImpression({id:entry.id,...clip(content,500),label:entry.memory_type==='inferred'?'暂存的印象（待确认）':'对方提过的信息',kind:entry.memory_type==='inferred'?'memory_impression':'remembered_profile',platform:entry.platform,at:validTime(entry.source_at)?entry.source_at:null,evidence_ids:proofs.map(row=>row.id),source_ref:sourceLink(proofs[0].ref),source_kind:'evidence',source_record_id:proofs[0].id,sources:[{kind:'memory',id:entry.id},...proofs.map(row=>({kind:'evidence',id:row.id}))],verification:'source_record',verification_label:entry.memory_type==='inferred'?'有来源的主观推测，尚未核实':'有来源的记录，不代表独立核实'})
  }
  impressions.sort((a,b)=>(a.kind==='companion_judgment'?0:1)-(b.kind==='companion_judgment'?0:1)||(b.at??0)-(a.at??0)||a.id.localeCompare(b.id))
  const events=new Map(),ambiguous=new Set(),covered=new Set(),add=(key,item)=>{
    if(!key||!validTime(item.occurred_at)||!item.text?.trim())return
    const previous=events.get(key)
    if(previous){if(previous._text_digest!==item._text_digest){ambiguous.add(key);return}previous.evidence_ids=[...new Set([...previous.evidence_ids,...item.evidence_ids])];previous.sources=[...new Map([...(previous.sources??[]),...(item.sources??[])].map(source=>[source.kind+'\0'+source.id,source])).values()];if(previous.source_kind!=='evidence'&&item.source_kind==='evidence'){previous.source_kind=item.source_kind;previous.source_record_id=item.source_record_id}return}
    events.set(key,item)
  },inKey=row=>row.source_message_id?'in:'+row.platform+':'+row.conversation_id+':'+row.source_message_id:'in-evidence:'+row.id
  // Prefer existing, attributed interaction summaries. They remain summaries
  // of sources, not proof that the companion performed the narrated acts.
  const summaries=store.db.prepare("SELECT id FROM memory_entries WHERE actor_entity_id=? AND status='active' AND memory_type IN ('asserted','observed') AND visibility<>'secret' AND (subcategory IN ('interaction_summary','conversation_summary','person_event','interaction_event','event','experience') OR predicate IN ('interaction_summary','conversation_summary','person_event','互动经过','对话总结','最近的事')) ORDER BY source_at DESC,id LIMIT 30").all(entity_id)
  for(const summary of summaries){const row=memory._entry(summary.id);if(!row||!memory._canEntry(row,owner)||memory._projectEntry(row).status!=='active'||!validTime(row.source_at)||row.valid_until!==null&&row.valid_until<=current||row.valid_from!==null&&row.valid_from>current)continue;const proofs=memory._support(row.id);if(!proofs.length||proofs.some(proof=>!human(proof)))continue
    for(const proof of proofs)covered.add(proof.id)
    add('summary:'+row.id,{id:row.id,...clip(row.content),_text_digest:hash(row.content),label:'记着的互动',kind:'memory_summary',author:'memory',direction:'observation',platform:row.platform||proofs[0].platform,occurred_at:row.source_at,evidence_ids:proofs.map(proof=>proof.id),source_ref:sourceLink(proofs[0].ref),source_kind:'memory',source_record_id:row.id,verification:'source_record',verification_label:'有来源的记忆摘要，不代表独立核实',sources:[{kind:'memory',id:row.id},...proofs.map(proof=>({kind:'evidence',id:proof.id}))]})
  }
  const incoming=store.db.prepare("SELECT e.id FROM evidence e WHERE e.direction='in' AND e.source_type='user' AND (e.actor_entity_id=? OR EXISTS(SELECT 1 FROM platform_identities p WHERE p.entity_id=? AND p.role<>'account' AND p.namespace=e.platform AND p.platform_uid=e.actor_uid)) AND e.visibility<>'secret' ORDER BY e.source_at DESC,e.recorded_at DESC,e.id LIMIT 120").all(entity_id,entity_id)
  for(const ref of incoming){const row=evidence(ref.id);if(!human(row)||!validTime(row.source_at)||covered.has(row.id))continue
    const owners=row.source_message_id?store.db.prepare("SELECT DISTINCT actor_uid FROM evidence WHERE platform=? AND conversation_id=? AND source_message_id=? AND direction='in' AND source_type='user'").all(row.platform,row.conversation_id,row.source_message_id):[]
    if(owners.some(other=>other.actor_uid&&other.actor_uid!==row.actor_uid))continue
    add(inKey(row),{id:row.id,...clip(row.text),_text_digest:hash(row.text),label:'对方说',kind:'message',author:'counterpart',direction:'in',platform:row.platform,occurred_at:row.source_at,evidence_ids:[row.id],source_ref:sourceLink(row.ref),source_kind:'evidence',source_record_id:row.id,sources:[{kind:'evidence',id:row.id}],verification:'source_record',verification_label:'收到的原话，内容未独立核实'})
  }
  const uidMatches=(platform,uid)=>typeof uid==='string'&&identityMap.has(platform+'\0'+uid)
  const sourceTargetsAction=(source,row,target,receipt)=>{
    if(!source||!human(source)||source.platform!==row.platform)return false
    if(row.platform==='qq')return source.conversation_id===target.conversation_id&&(!target.recipient_uid||target.recipient_uid===source.actor_uid)
    if(row.platform==='tieba')return source.conversation_id==='thread:'+target.thread_id+':'+target.post_id&&source.source_message_id==='reply:'+(target.sub_reply_id??target.post_id)&&(!target.reply_uid||target.reply_uid===source.actor_uid)&&(!receipt.reply_uid||receipt.reply_uid===source.actor_uid)
    if(row.platform==='bilibili'){
      if(target.channel==='dm')return source.conversation_id==='dm:'+target.recipient_uid&&source.actor_uid===target.recipient_uid
      if(target.channel==='live')return source.conversation_id==='live:'+target.room_id&&source.actor_uid===target.reply_uid&&(!target.reply_dmid||source.source_message_id==='live:'+target.reply_dmid)
      return source.conversation_id==='comment:'+(target.object_type??'1')+':'+target.object_id+':'+target.root_reply_id&&source.source_message_id==='comment:'+target.parent_reply_id
    }
    return false
  }
  const confirmedAction=row=>{const receipt=parse(row?.receipt_json);return !!row&&row.status==='confirmed'&&receipt.source==='server_receipt'&&receipt.accepted===true&&receipt.rejected!==true&&(receipt.code===undefined||receipt.code===0)&&!!receiptId(receipt)&&hash(raw(row,'body'))===row.body_digest&&['qq.send','tieba.reply','bilibili.reply'].includes(row.kind)}
  const actionTargetsPerson=row=>{
    if(!confirmedAction(row))return false
    const target=parse(row.target_json),receipt=parse(row.receipt_json),source=row.source_evidence_id?evidence(row.source_evidence_id):null
    if(row.platform==='qq'&&/^private:[1-9]\d*$/.test(target.conversation_id??'')){
      const peer=target.conversation_id.slice(8);return uidMatches('qq',peer)&&(!target.recipient_uid||target.recipient_uid===peer)
    }
    if(row.platform==='bilibili'&&target.channel==='dm')return uidMatches('bilibili',target.recipient_uid)
    if(sourceTargetsAction(source,row,target,receipt))return true
    return row.platform==='tieba'&&uidMatches('tieba',receipt.reply_uid)&&(!target.reply_uid||target.reply_uid===receipt.reply_uid)&&receipt.thread_id===target.thread_id&&!!target.post_id&&receipt.parent_post_id===target.post_id&&(!target.sub_reply_id||receipt.parent_sub_reply_id===target.sub_reply_id)
  }
  const evidenceTargetsPerson=row=>{
    if(row.platform==='qq'&&/^private:[1-9]\d*$/.test(row.conversation_id??''))return uidMatches('qq',row.conversation_id.slice(8))
    if(row.platform==='bilibili'&&/^dm:[1-9]\d*$/.test(row.conversation_id??''))return uidMatches('bilibili',row.conversation_id.slice(3))
    const server=receiptId(row.receipt);if(!server)return false
    return store.db.prepare("SELECT *,CAST(body AS BLOB) body_bytes FROM actions WHERE platform=? AND status='confirmed' AND json_extract(receipt_json,'$.server_id')=?").all(row.platform,server).some(action=>actionTargetsPerson(action)&&raw(action,'body')===row.text&&outKey(action.platform,action.kind,parse(action.receipt_json))===outKey(row.platform,row.kind,row.receipt))
  }
  const outgoingActionSources=(action,receipt)=>{
    const server=receiptId(receipt),body=raw(action,'body')
    const ids=store.db.prepare("SELECT id FROM evidence WHERE platform=? AND direction='out' AND kind<>'receipt' AND visibility<>'secret' AND (source_message_id=? OR json_extract(receipt_json,'$.message_id')=? OR json_extract(receipt_json,'$.reply_id')=? OR json_extract(receipt_json,'$.rpid')=? OR json_extract(receipt_json,'$.post_id')=? OR json_extract(receipt_json,'$.id')=? OR json_extract(receipt_json,'$.server_id')=?) LIMIT 20").all(action.platform,...Array(7).fill(server))
    return ids.map(ref=>evidence(ref.id)).filter(row=>row&&row.direction==='out'&&row.status==='confirmed'&&row.confirmation==='server_receipt'&&row.source_type==='server_action'&&positiveReceipt(row.receipt)&&row.text===body&&outKey(row.platform,row.kind,row.receipt)===outKey(action.platform,action.kind,receipt)&&memory._canEvidence(row,owner)&&evidenceTargetsPerson(row)).map(row=>({kind:'evidence',id:row.id}))
  }
  const directed=store.db.prepare("SELECT subject_kind,subject_id FROM relations WHERE relation='directed_to' AND object_kind='entity' AND object_id=?").all(entity_id)
  for(const link of directed){
    if(link.subject_kind==='evidence'){
      const row=evidence(link.subject_id);if(!row)continue;const identity=store.getPlatformIdentity(row.platform,row.actor_uid),key=outKey(row.platform,row.kind,row.receipt)
      if(!row||row.direction!=='out'||row.status!=='confirmed'||row.confirmation!=='server_receipt'||row.source_type!=='server_action'||!positiveReceipt(row.receipt)||row.kind==='receipt'||!(row.actor_uid==='self'||identity?.role==='account')||!memory._canEvidence(row,owner)||!evidenceTargetsPerson(row))continue
      add(key,{id:row.id,...clip(row.text),_text_digest:hash(row.text),label:'大肥鱼回复',kind:'reply',author:'companion',direction:'out',platform:row.platform,occurred_at:row.source_at,evidence_ids:[row.id],source_ref:sourceLink(row.ref),source_kind:'evidence',source_record_id:row.id,sources:[{kind:'evidence',id:row.id}],verification:'confirmed_receipt',verification_label:'已取得服务器确认的回复'})
    }
    if(link.subject_kind==='action'){
      const row=store.db.prepare('SELECT *,CAST(body AS BLOB) body_bytes FROM actions WHERE id=?').get(link.subject_id),receipt=parse(row?.receipt_json),meta=parse(row?.metadata_json),target=parse(row?.target_json)
      if(!actionTargetsPerson(row))continue
      const source=row.source_evidence_id?evidence(row.source_evidence_id):null
      const happened=validTime(receipt.readback?.source_at)?receipt.readback.source_at:validTime(meta.attempted_at)?meta.attempted_at:row.confirmed_at,outputSources=outgoingActionSources(row,receipt)
      add(outKey(row.platform,row.kind,receipt),{id:row.id,...clip(raw(row,'body')),_text_digest:hash(raw(row,'body')),label:'大肥鱼回复',kind:'reply',author:'companion',direction:'out',platform:row.platform,occurred_at:happened,evidence_ids:source?[source.id]:[],source_ref:row.platform==='tieba'&&/^\d+$/.test(target.thread_id??'')?'https://tieba.baidu.com/p/'+target.thread_id:sourceLink(source?.ref),source_kind:outputSources.length?'evidence':'action',source_record_id:outputSources[0]?.id??row.id,sources:outputSources,verification:'confirmed_receipt',verification_label:'已取得服务器确认的回复'})
    }
  }
  const old=store.db.prepare("SELECT *,CAST(text AS BLOB) text_bytes FROM journal_events WHERE entity_id=? AND source_type='v2_interaction' AND event_type='interaction' AND visibility<>'secret' ORDER BY source_at DESC,id LIMIT 60").all(entity_id)
  for(const row of old){const meta=parse(row.metadata_json),identity=identityMap.get(row.platform+'\0'+row.actor_uid);if(!identity||!validTime(row.source_at)||!['in','out'].includes(row.direction)||['unknown','uncertain','failed','error','draft','preview','dry','queued','pending','blocked','cancelled','timeout','rejected','forgotten'].includes(row.status)||!memory._canJournal(row,owner))continue
    const imported=store.db.prepare("SELECT 1 FROM import_records WHERE target_kind='journal_event' AND target_id=? AND source_type='sqlite_row' LIMIT 1").get(row.id)
    if(!imported||meta.statistics_origin!=='imported_interaction')continue
    // A linked native source owns both its permission and delivery state.
    // It is rendered by the native branches above; missing, secret, disabled
    // or unconfirmed links must never fall back to a less restricted copy.
    if(meta.linked_evidence_id)continue
    const key=meta.source_message_id?(row.direction==='out'?outKey(row.platform,meta.interaction_kind,{server_id:meta.source_message_id}):row.direction+':'+row.platform+':'+row.conversation_id+':'+meta.source_message_id):'historical:'+row.platform+':'+row.direction+':'+row.source_at+':'+hash(raw(row,'text'))
    add(key,{id:row.id,...clip(raw(row,'text')),_text_digest:hash(raw(row,'text')),label:row.direction==='in'?'历史来话':'历史回复记录',kind:'historical_interaction',author:row.direction==='in'?'counterpart':'companion',direction:row.direction,platform:row.platform,occurred_at:row.source_at,evidence_ids:[],source_ref:sourceLink(row.ref),source_kind:'journal',source_record_id:row.id,sources:[{kind:'journal',id:row.id}],verification:'historical_unverified',verification_label:'历史互动原文，未重新核验'})
  }
  const recent_events=[...events].filter(([key])=>!ambiguous.has(key)).map(([,value])=>{const {_text_digest,...item}=value;return item}).sort((a,b)=>b.occurred_at-a.occurred_at||a.id.localeCompare(b.id)).slice(0,event_limit)
  return {found:true,person,impressions:impressions.slice(0,3),recent_events,impression_empty_reason:impressions.length?'':'还没有形成可查看的印象。',events_empty_reason:recent_events.length?'':'还没有带时间且能核对来源的互动记录。',model_calls:0,read_only:true}
}
