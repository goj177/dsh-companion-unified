/** Native people repository. Owner UI gets neutral statistics; model context only gets the bounded index. */
import { NativeStore } from './store.mjs'
import {ownerPeopleDetail} from './people-detail.mjs'
import { rankAllContactsForOwner,rankContacts,renderFamiliarContext } from './contacts.mjs'
import { fields,platformName,positiveReceipt,directlySupports,uncertain } from './memory-rules.mjs'

const key=(...values)=>JSON.stringify(values)
const json=value=>{try{return JSON.parse(value??'{}')}catch{return {}}}
const count=value=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0?value:0
const at=value=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0&&value<=8640000000000000?value:null
const token=value=>typeof value==='string'&&value&&value.length<=512&&!/[\0\r\n]/.test(value)?value:typeof value==='number'&&Number.isSafeInteger(value)?String(value):''
const idKey=(platform,uid)=>platform+'\0'+uid
const evidenceKinds=new Set(['message','statement','user_statement','comment','reply'])
const nativeId=value=>typeof value==='string'&&/^[a-z][a-z0-9_.:/-]{0,159}$/.test(value)
const FIRST_KEYS=['message_id','reply_id','rpid','post_id','dynamic_id','id','server_id']
function wireKey(platform,kind,receipt){
  for(const field of FIRST_KEYS){const id=token(receipt?.[field]);if(!id||/^(?:0|-1|null|undefined)$/i.test(id))continue
    const family=platform==='qq'?'message':platform==='tieba'?'post':platform==='bilibili'?field==='dynamic_id'||String(kind).includes('dynamic')?'dynamic':'reply':field
    return key('wire-out',platform,family,id)
  }
  return null
}
function actionConfirmed(row){const r=row.receipt;return row.status==='confirmed'&&r?.source==='server_receipt'&&r.accepted===true&&r.rejected!==true&&(r.code===undefined||r.code===0)&&typeof r.server_id==='string'&&!!token(r.server_id)&&!/^(?:0|-1|null|undefined)$/i.test(r.server_id)}
function evidenceConfirmed(row){return row.status==='confirmed'&&row.confirmation==='server_receipt'&&row.source_type==='server_action'&&positiveReceipt(row.receipt)}
const CONTEXT_FIELDS=['session_id','workspace_id','read_memory','platform','conversation_id','actor_uid','actor_entity_id','actor','mentioned_identities','participant_identities','owner_authorized','include_secret','public_summary_enabled','sharing','max_people','max_context_chars']

export class NativePeople{
  constructor(options={}){
    fields(options,['store','now'],'NativePeople选项');const {store,now}=options
    if(!(store instanceof NativeStore)||now!==undefined&&typeof now!=='function')throw new Error('NativePeople必须显式接收NativeStore')
    this.store=store;this.now=now??store.now
  }
  _now(){const value=this.now();if(at(value)===null)throw new Error('熟人仓库时钟无效');return value}
  _settings(){this.store._open();const doc=this.store.getDocument('settings');if(doc&&doc.type!=='settings')throw new Error('原生熟人设置文档类型错误');return doc?.value??{}}
  _load(){
    this.store._open()
    // Do not even select notes, entity.summary, impressions, private message text or raw last-inbound fields.
    const entities=this.store.db.prepare(`SELECT id,short_ref,display_name,
      json_extract(metadata_json,'$.interaction_count') AS baseline_count,
      json_extract(metadata_json,'$.inbound_count') AS baseline_in,
      json_extract(metadata_json,'$.outbound_count') AS baseline_out,
      json_extract(metadata_json,'$.active_days') AS baseline_days,
      json_extract(metadata_json,'$.first_seen_at') AS first_seen_at,
      json_extract(metadata_json,'$.last_seen_at') AS last_seen_at,
      CASE WHEN json_type(metadata_json,'$.owner_confirmed')='true' THEN 1 ELSE 0 END AS owner_confirmed,
      CASE WHEN json_type(metadata_json,'$.pinned')='true' THEN 1 ELSE 0 END AS pinned
      FROM entities WHERE kind='person' ORDER BY id`).all()
    const people=new Map(entities.map(row=>[row.id,{...row,identities:[],groups:new Map(),days:new Set(),times:[]}]))
    const identities=this.store.db.prepare('SELECT namespace,platform_uid,entity_id,role,display_name FROM platform_identities ORDER BY namespace,platform_uid').all(),identityMap=new Map()
    for(const identity of identities){identityMap.set(idKey(identity.namespace,identity.platform_uid),identity);const person=people.get(identity.entity_id);if(person&&identity.role!=='account')person.identities.push({namespace:identity.namespace,platform_uid:identity.platform_uid,display_name:identity.display_name})}
    const resolve=(platform,uid,entityId)=>{
      const identity=token(uid)?identityMap.get(idKey(platform,uid)):null
      if(identity?.role==='account')return null
      if(entityId&&identity&&identity.entity_id!==entityId)return null
      const selected=entityId??identity?.entity_id
      return selected&&people.has(selected)&&(!token(uid)||identity?.entity_id===selected)?selected:null
    }
    const evidenceRows=this.store.db.prepare(`SELECT id,platform,conversation_id,actor_entity_id,actor_uid,direction,kind,source_message_id,
      source_at,status,confirmation,source_type,source_json,receipt_json FROM evidence`).all().map(row=>({...row,source:json(row.source_json),receipt:json(row.receipt_json)}))
    const evidence=new Map(evidenceRows.map(row=>[row.id,row]))
    const journals=this.store.db.prepare(`SELECT id,event_key,event_type,platform,entity_id,actor_uid,conversation_id,direction,status,source_at,source_type,
      json_extract(metadata_json,'$.evidence_id') AS evidence_id,
      json_extract(metadata_json,'$.action_id') AS action_id,
      json_extract(metadata_json,'$.statistics_origin') AS statistics_origin,
      json_extract(metadata_json,'$.linked_evidence_id') AS linked_evidence_id,
      json_extract(metadata_json,'$.source_message_id') AS source_message_id
      FROM journal_events WHERE event_type IN ('interaction','experience','log')`).all()
    const imported=new Set(this.store.db.prepare("SELECT DISTINCT target_id FROM import_records WHERE target_kind='evidence'").all().map(row=>row.target_id))
    for(const row of journals)if(row.statistics_origin==='imported_evidence'&&token(row.evidence_id))imported.add(row.evidence_id)
    const relations=this.store.db.prepare("SELECT subject_kind,subject_id,relation,object_kind,object_id FROM relations WHERE relation IN ('directed_to','confirmed_by','recorded_as')").all(),directed=new Map(),confirmedBy=new Map(),recordedAs=new Map(),actionJournals=new Map()
    for(const row of relations){
      if(row.relation==='directed_to'&&row.object_kind==='entity'&&people.has(row.object_id)){
        const relationKey=key(row.subject_kind,row.subject_id),values=directed.get(relationKey)??new Set();values.add(row.object_id);directed.set(relationKey,values)
      }
      if(row.relation==='confirmed_by'&&row.subject_kind==='evidence'&&row.object_kind==='evidence'){
        const values=confirmedBy.get(row.subject_id)??[];values.push(row.object_id);confirmedBy.set(row.subject_id,values)
      }
      if(row.relation==='recorded_as'&&row.subject_kind==='evidence'&&row.object_kind==='journal_event'){
        const values=recordedAs.get(row.subject_id)??[];values.push(row.object_id);recordedAs.set(row.subject_id,values)
      }
    }
    for(const row of journals){
      if(token(row.evidence_id)){const values=recordedAs.get(row.evidence_id)??[];if(!values.includes(row.id))values.push(row.id);recordedAs.set(row.evidence_id,values)}
      if(token(row.action_id)){const values=actionJournals.get(row.action_id)??[];values.push(row.id);actionJournals.set(row.action_id,values)}
    }
    const recipients=(kind,id,wrappers=[])=>new Set([...(directed.get(key(kind,id))??[]),...wrappers.flatMap(w=>[...(directed.get(key('journal_event',w))??[])])])
    const effective=row=>{
      const proofs=(confirmedBy.get(row.id)??[]).map(id=>evidence.get(id)).filter(proof=>proof&&proof.kind==='receipt'&&evidenceConfirmed(proof)&&proof.platform===row.platform&&proof.conversation_id===row.conversation_id&&(!proof.actor_uid||!row.actor_uid||proof.actor_uid===row.actor_uid))
        .sort((a,b)=>(at(b.source_at)??0)-(at(a.source_at)??0)||a.id.localeCompare(b.id))
      return proofs.length?{...row,status:'confirmed',confirmation:'server_receipt',source_type:'server_action',receipt:proofs[0].receipt,confirmed_at:proofs[0].source_at,proof_ids:proofs.map(proof=>proof.id)}:row
    }
    const sourceKey=(row,projection=row)=>row.direction==='out'?wireKey(row.platform,row.kind,projection.receipt)
      ??(token(row.source_message_id)?key('out',row.platform,row.conversation_id,row.source_message_id):key('evidence',row.id))
      :token(row.source_message_id)?key('in',row.platform,row.conversation_id,row.source_message_id):key('evidence',row.id)
    const add=(entityId,eventKey,direction,time,legacy,actor='')=>{
      const person=people.get(entityId);if(!person||!['in','out'].includes(direction))return
      const existing=person.groups.get(eventKey),value={direction,time:at(time),legacy,actor}
      if(existing){existing.legacy||=legacy;if(value.time!==null)existing.time=existing.time===null?value.time:Math.max(existing.time,value.time);return}
      person.groups.set(eventKey,value)
    }
    for(const row of evidenceRows){
      if(row.kind==='receipt')continue
      const projected=effective(row),legacy=imported.has(row.id)
      if(row.direction==='in'&&evidenceKinds.has(row.kind)&&row.source_type==='user'&&['user','human','user_statement'].includes(row.source.kind)){
        const person=resolve(row.platform,row.actor_uid,row.actor_entity_id);if(person)add(person,sourceKey(row,projected),'in',row.source_at,legacy,row.actor_uid)
      }
      if(row.direction==='out'&&evidenceConfirmed(projected)){
        const targets=recipients('evidence',row.id,recordedAs.get(row.id)??[])
        for(const proof of projected.proof_ids??[])for(const target of recipients('evidence',proof,recordedAs.get(proof)??[]))targets.add(target)
        for(const target of targets)add(target,sourceKey(row,projected),'out',projected.confirmed_at??row.source_at,legacy)
      }
    }
    for(const row of journals){
      if(row.statistics_origin==='imported_interaction'){
        const person=resolve(row.platform,row.actor_uid,row.entity_id);if(!person)continue
        const linked=evidence.get(row.linked_evidence_id),projection=linked?effective(linked):null
        const eventKey=linked?sourceKey(linked,projection):token(row.source_message_id)?key(row.direction,row.platform,row.conversation_id,row.source_message_id):key('legacy-interaction',row.id)
        add(person,eventKey,row.direction,row.source_at,true,row.actor_uid)
        continue
      }
      if(row.statistics_origin==='imported_evidence'||token(row.evidence_id)||token(row.action_id))continue
      if(row.event_type==='interaction'&&row.direction==='in'&&row.source_type.startsWith('native_')){
        const person=resolve(row.platform,row.actor_uid,row.entity_id);if(person)add(person,token(row.source_message_id)?key('in',row.platform,row.conversation_id,row.source_message_id):key('journal',row.id),'in',row.source_at,false,row.actor_uid)
      }
    }
    for(const row of this.store.db.prepare('SELECT id,platform,kind,target_json,status,receipt_json,confirmed_at FROM actions').all()){
      row.receipt=json(row.receipt_json);if(!actionConfirmed(row))continue
      const eventKey=wireKey(row.platform,row.kind,row.receipt)??key('action',row.id)
      for(const target of recipients('action',row.id,actionJournals.get(row.id)??[]))add(target,eventKey,'out',row.confirmed_at,false)
    }
    // Conflicting authors for one exact incoming message cannot manufacture two relationships.
    const incomingOwners=new Map(),ambiguous=new Set()
    for(const person of people.values())for(const [eventKey,event]of person.groups)if(event.direction==='in'&&eventKey.startsWith('["in",')){
      const owner=incomingOwners.get(eventKey);if(owner&&owner!==person.id)ambiguous.add(eventKey);incomingOwners.set(eventKey,person.id)
    }
    let formatter
    try{formatter=new Intl.DateTimeFormat('sv-SE',{timeZone:this._settings().time_zone??'Asia/Shanghai'})}catch{formatter=new Intl.DateTimeFormat('sv-SE',{timeZone:'UTC'})}
    const rows=[]
    for(const person of people.values()){
      const groups=[...person.groups].filter(([eventKey])=>!ambiguous.has(eventKey)).map(([,event])=>event),old=groups.filter(row=>row.legacy),fresh=groups.filter(row=>!row.legacy)
      const inbound=Math.max(count(person.baseline_in),old.filter(row=>row.direction==='in').length)+fresh.filter(row=>row.direction==='in').length
      const outbound=Math.max(count(person.baseline_out),old.filter(row=>row.direction==='out').length)+fresh.filter(row=>row.direction==='out').length
      const observed=Math.max(count(person.baseline_count),count(person.baseline_in)+count(person.baseline_out),old.length)+fresh.length
      const times=[at(person.first_seen_at),at(person.last_seen_at),...groups.map(row=>row.time)].filter(value=>value!==null),days=new Set(groups.map(row=>row.time).filter(value=>value!==null).map(value=>formatter.format(value)))
      const primary=person.display_name||person.identities.find(identity=>identity.display_name)?.display_name||''
      rows.push({id:person.id,kind:'person',short_ref:person.short_ref,display_name:primary,identities:person.identities.map(({namespace,platform_uid})=>({namespace,platform_uid})),first_seen_at:times.length?Math.min(...times):null,last_seen_at:times.length?Math.max(...times):null,
        observed_interactions:Math.max(observed,inbound+outbound),active_days:Math.max(count(person.baseline_days),days.size),inbound_count:inbound,outbound_count:outbound,owner_confirmed:person.owner_confirmed===1,pinned:person.pinned===1,public_summary:null,
        _identity_names:person.identities,_statistics_basis:{version:'native-people-v1',count_basis:'observed_lower_bound',migration_count_floor:count(person.baseline_count),unique_legacy_records:old.length,unique_new_records:fresh.length}})
    }
    return {rows,identityMap}
  }
  /** Trusted owner UI only. This method is deliberately not registered as a model tool. */
  list(options={}){
    fields(options,['query','platform'],'熟人列表筛选');if(options.query!==undefined&&(typeof options.query!=='string'||options.query.length>1000))throw new Error('熟人查询必须是1000字以内文本')
    if(options.platform!==undefined)platformName(options.platform)
    const {rows}=this._load(),query=(options.query??'').trim().toLocaleLowerCase(),selected=rows.filter(row=>(!options.platform||row.identities.some(identity=>identity.namespace===options.platform))&&(!query||[row.id,row.short_ref??'',row.display_name,...row._identity_names.flatMap(identity=>[identity.namespace,identity.platform_uid,identity.display_name])].some(value=>value.toLocaleLowerCase().includes(query))))
    const detail=new Map(selected.map(row=>[row.id,row]))
    return rankAllContactsForOwner(selected,{platform:options.platform??'',now:this._now()},{sharing:'global'}).map(row=>({...row,identities:detail.get(row.id)._identity_names.map(value=>({...value})),statistics_basis:detail.get(row.id)._statistics_basis,public_summary:null}))
  }
  withOwnerDetailSnapshot(work){
    if(this.ownerDetailSnapshot)return work()
    this.ownerDetailSnapshot=new Map()
    try{return this.store.readSnapshot(work)}finally{this.ownerDetailSnapshot=null}
  }
  ownerDetail(options={},trusted={}){
    fields(options,['entity_id','event_limit'],'熟人详情')
    const cache=trusted.owner_authorized===true&&trusted.platform==='harness'&&trusted.visibility!=='public'?this.ownerDetailSnapshot:null,key=JSON.stringify([options.entity_id,options.event_limit??3])
    if(cache?.has(key))return cache.get(key)
    const result=ownerPeopleDetail({store:this.store,now:this.now,...options},trusted);cache?.set(key,result);return result
  }
  _publicSummary(entityId,context,identityMap,now){
    const candidates=this.store.db.prepare(`SELECT id,predicate,CAST(object AS BLOB) AS object_bytes,CAST(content AS BLOB) AS content_bytes,scope,platform,conversation_id,memory_type,source_at,valid_from,valid_until
      FROM memory_entries WHERE actor_entity_id=? AND entity_type='person' AND visibility='public' AND status='active'
      AND memory_type IN ('asserted','observed') AND (predicate='public_summary' OR subcategory='public_summary') ORDER BY updated_at DESC,id`).all(entityId)
    for(const entry of candidates){
      if(entry.source_at===null||entry.valid_from!==null&&entry.valid_from>now||entry.valid_until!==null&&entry.valid_until<=now)continue
      if(entry.scope!=='global'&&!(entry.platform===context.platform&&(entry.scope==='platform'||entry.scope==='conversation'&&entry.conversation_id===context.conversation_id)))continue
      const content=Buffer.from(entry.content_bytes).toString('utf8'),object=Buffer.from(entry.object_bytes).toString('utf8');if(!content.trim()||content.length>28||uncertain(content))continue
      const links=this.store.db.prepare("SELECT object_id FROM relations WHERE subject_kind='memory_entry' AND subject_id=? AND relation='supported_by' AND object_kind='evidence'").all(entry.id)
      if(!links.length)continue
      const proofs=links.map(link=>this.store.db.prepare(`SELECT id,platform,actor_uid,actor_entity_id,direction,kind,status,confirmation,source_type,visibility,source_at,CAST(text AS BLOB) AS text_bytes FROM evidence WHERE id=?`).get(link.object_id))
      if(proofs.some(row=>!row||row.visibility!=='public'||row.status!=='confirmed'||row.source_at===null||row.kind==='receipt'||row.actor_entity_id!==entityId||identityMap.get(idKey(row.platform,row.actor_uid))?.entity_id!==entityId||!['in','observation'].includes(row.direction)
        ||entry.memory_type==='asserted'&&!(row.source_type==='user'&&row.confirmation==='user_statement')||entry.memory_type==='observed'&&!(row.source_type==='platform'&&row.confirmation==='source_observation')))continue
      if(!proofs.some(row=>directlySupports(Buffer.from(row.text_bytes).toString('utf8'),{object,content,predicate:entry.predicate})))continue
      return {text:content,confirmed:true,visibility:'public',evidence_ids:proofs.map(row=>row.id)}
    }
    return null
  }
  /** Only this bounded string may enter model context; aggregate counts and times stay inside the repository. */
  context(ctx={}){
    fields(ctx,CONTEXT_FIELDS,'熟人上下文');const rootSettings=this._settings(),now=this._now(),settings=rootSettings.familiarity??{}
    if(ctx.platform!==undefined)platformName(ctx.platform)
    if(ctx.public_summary_enabled!==undefined&&typeof ctx.public_summary_enabled!=='boolean')throw new Error('public_summary_enabled必须为布尔值')
    for(const name of ['owner_authorized','include_secret','read_memory'])if(ctx[name]!==undefined&&typeof ctx[name]!=='boolean')throw new Error(name+'必须为布尔值')
    for(const name of ['session_id','workspace_id','conversation_id','actor_uid'])if(ctx[name]!==undefined&&(typeof ctx[name]!=='string'||ctx[name].length>512||/[\0\r\n]/.test(ctx[name])))throw new Error(name+'必须为稳定文本标识')
    if(rootSettings.enabled===false||rootSettings.memory?.enabled===false||ctx.read_memory===false||ctx.workspace_id&&rootSettings.memory?.disabled_workspace_ids?.includes(ctx.workspace_id))return ''
    if(ctx.session_id&&this.store.db.prepare("SELECT 1 FROM documents WHERE type='session_policy' AND json_extract(value_json,'$.session_id')=? AND json_extract(value_json,'$.read_memory')=0 LIMIT 1").get(ctx.session_id))return ''
    const {rows,identityMap}=this._load()
    const actor=ctx.actor??(token(ctx.actor_uid)&&ctx.platform?{namespace:ctx.platform,platform_uid:ctx.actor_uid}:undefined)
    if(ctx.actor_entity_id!==undefined&&(!nativeId(ctx.actor_entity_id)||actor&&identityMap.get(idKey(actor.namespace,actor.platform_uid))?.entity_id!==ctx.actor_entity_id))throw new Error('熟人上下文actor实体与稳定身份不符')
    const rankingContext={platform:ctx.platform??'',actor,mentioned_identities:ctx.mentioned_identities,participant_identities:ctx.participant_identities,now},options={sharing:ctx.sharing??settings.sharing??'global',maxPeople:ctx.max_people??settings.max_people??3,maxChars:ctx.max_context_chars??settings.max_context_chars??180}
    if(ctx.public_summary_enabled===true&&settings.public_summary_enabled!==false){const ids=new Set(rankContacts(rows,rankingContext,options).map(row=>row.id));for(const row of rows)if(ids.has(row.id))row.public_summary=this._publicSummary(row.id,ctx,identityMap,now)}
    return renderFamiliarContext(rows,rankingContext,options)
  }
}
