import { randomUUID } from 'node:crypto'
import { NativeStore } from './store.mjs'
import {MEMORY_QUERY_MAX_CHARS} from './memory-query.mjs'
import { stringifyJson } from './contracts.mjs'
import { MEMORY_LEVELS, MEMORY_TYPES, ENTITY_TYPES, VISIBILITIES, SOURCE_TYPES, EVIDENCE_KINDS, DIRECTIONS,
  digest,fields,choice,integer,rawText,safeText,identifier,platformName,uid,timestamp,queryTime,
  sourceDescriptor,receiptDescriptor,classifyEvidence,canonicalEvidenceRank,contextOf,visible,compareText,directlySupports,searchTerms,
  searchScore,page,evidenceLabel,entryLabel,uncertain } from './memory-rules.mjs'

const ENTRY_TEXT = ['subject','predicate','object','content','title','project','goal','reason','subcategory','source_session_id']
const EVIDENCE_TEXT = ['text','ref','source_time_raw']
const select = (table, columns) => `SELECT ${table}.*,${columns.map(key=>`CAST(${table}.${key} AS BLOB) AS bytes_${key}`).join(',')} FROM ${table}`
const ENTRY_SELECT=select('memory_entries',ENTRY_TEXT), EVIDENCE_SELECT=select('evidence',EVIDENCE_TEXT)
const decode = (row,columns) => {
  if(!row)return null
  const output={...row}
  for(const key of columns){output[key]=Buffer.from(row['bytes_'+key]).toString('utf8');delete output['bytes_'+key]}
  return output
}
const entryRow = row => {
  const value=decode(row,ENTRY_TEXT)
  if(!value)return null
  choice(value.memory_type,MEMORY_TYPES,'保存的memory_type');choice(value.scope,['global','platform','conversation'],'保存的scope')
  choice(value.visibility,VISIBILITIES,'保存的visibility')
  value.keywords=JSON.parse(value.keywords_json);delete value.keywords_json;value.corrected=value.corrected===1
  return value
}
const evidenceRow = row => {
  const value=decode(row,EVIDENCE_TEXT)
  if(!value)return null
  value.source=JSON.parse(value.source_json);value.receipt=JSON.parse(value.receipt_json)
  delete value.source_json;delete value.receipt_json
  return value
}
const QUERY_FIELDS=['query','platform','conversation_id','since','until','limit','max_chars','entity_id','level','project','goal']
const hooks=new WeakSet()
const idsOf = (values,label,{required=false}={}) => {
  if(!Array.isArray(values)||values.length>32||required&&!values.length)throw new Error(label+'需为1至32个完整ID数组')
  return [...new Set(values.map(value=>identifier(value,label)))].sort()
}
const ENTRY_COLUMNS=['id','semantic_key','entity_key','level','entity_type','subject','actor_entity_id','actor_uid','predicate','object','content','title','keywords_json','project','goal','importance','corrected','subcategory','source_session_id','scope','visibility','platform','conversation_id','memory_type','status','reason','source_at','valid_from','valid_until','priority','heat','hit_count','created_at','updated_at','last_accessed_at']
const EVIDENCE_COLUMNS=['id','dedupe_key','platform','conversation_id','actor_entity_id','actor_uid','direction','kind','text','ref','source_message_id','source_at','source_time_raw','recorded_at','status','confirmation','priority','visibility','source_type','source_json','receipt_json']
function insert(db,table,columns,row){db.prepare(`INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map(()=>'?').join(',')})`).run(...columns.map(key=>row[key]))}
const noResult = text => ({items:[],text,abstained:true,untrusted:true})

/** Native schema3 memory only. The host owns this object. In particular,
 * recordEvidence is a trusted ingestion method and must never be a model tool.
 * Model requests and host authorization are always separate arguments. */
export class NativeMemory {
  constructor(store, options = {}) {
    if(!(store instanceof NativeStore))throw new Error('NativeMemory只接收NativeStore实例，不能接收路径、数据库或旧reader')
    fields(options,['now'],'NativeMemory选项')
    if(options.now!==undefined&&typeof options.now!=='function')throw new Error('NativeMemory时钟必须为函数')
    store._open();this.store=store;this.now=options.now??store.now
    if(!hooks.has(store.db)) {
      store.db.function('companion_memory_match',{deterministic:true},(bytes,query)=>searchScore(Buffer.from(bytes??[]).toString('utf8'),searchTerms(query)))
      hooks.add(store.db)
    }
  }
  _now(){return timestamp(this.now(),'记忆时钟')}
  _entry(id){return entryRow(this.store.db.prepare(ENTRY_SELECT+' WHERE id=?').get(id))}
  _rawEvidence(id){return evidenceRow(this.store.db.prepare(EVIDENCE_SELECT+' WHERE id=?').get(id))}
  _relate(subject_kind,subject_id,relation,object_kind,object_id,metadata={}) {
    const id='relation:'+digest(stringifyJson([subject_kind,subject_id,relation,object_kind,object_id]))
    this.store.db.prepare('INSERT OR IGNORE INTO relations(id,subject_kind,subject_id,relation,object_kind,object_id,created_at,metadata_json) VALUES(?,?,?,?,?,?,?,?)')
      .run(id,subject_kind,subject_id,relation,object_kind,object_id,this._now(),stringifyJson(metadata))
    return id
  }
  _support(id) {
    return this.store.db.prepare("SELECT object_id FROM relations WHERE subject_kind='memory_entry' AND subject_id=? AND relation='supported_by' AND object_kind='evidence' ORDER BY object_id").all(id)
      .map(row=>this._effectiveEvidence(row.object_id)).filter(Boolean)
  }
  _supportedForType(row,memory_type,entity_type){return canonicalEvidenceRank(row)>0&&(memory_type==='asserted'?row.confirmation==='user_statement':memory_type==='observed'?row.confirmation==='source_observation'||row.confirmation==='server_receipt'&&(row.direction==='observation'||entity_type==='experience'&&row.direction==='out'):false)}
  _entryRank(row){
    if(!row||row.memory_type==='inferred'||row.memory_type==='recorded')return 0
    const sources=this._support(row.id).filter(source=>this._supportedForType(source,row.memory_type,row.entity_type)&&directlySupports(source.text,{object:row.object,content:row.object,predicate:row.predicate}))
    return Math.max(0,...sources.map(canonicalEvidenceRank))
  }
  _entityAnchor(row,sources){
    if(row.actor_entity_id)return 'entity:'+row.actor_entity_id
    // The fixed owner role is resolved only through explicitly registered UID
    // identities. A nickname or source.role="owner" never binds a person.
    if(row.scope==='global'&&['主人','owner'].includes(compareText(row.subject))){
      const ids=[...new Set(sources.map(source=>source.actor_entity_id).filter(Boolean))]
      if(ids.length===1&&sources.length&&sources.every(source=>source.actor_entity_id===ids[0]&&canonicalEvidenceRank(source)===2)
        &&this.store.listPlatformIdentities({entity_id:ids[0],role:'owner'}).length)return 'entity:'+ids[0]
    }
    return 'concept:'+compareText(row.subject)
  }
  _logicalEntity(row,sources){
    if(sources===undefined)sources=!row.actor_entity_id&&row.scope==='global'&&['主人','owner'].includes(compareText(row.subject))?this._support(row.id):[]
    const origin=row.scope==='global'&&row.entity_type!=='conversation'?['','']:[row.platform,row.conversation_id]
    return stringifyJson([row.scope,...origin,row.entity_type,this._entityAnchor(row,sources),row.project,row.goal])
  }
  _evidenceStates(id,context) {
    return this.store.db.prepare("SELECT memory_entries.id FROM relations JOIN memory_entries ON memory_entries.id=relations.subject_id WHERE relations.object_kind='evidence' AND relations.object_id=? AND relations.relation='supported_by' AND relations.subject_kind='memory_entry' ORDER BY memory_entries.id").all(id)
      .map(item=>this._entry(item.id)).filter(row=>this._canEntry(row,context)).map(row=>({id:row.id,status:row.status,memory_type:row.memory_type}))
  }
  _evidenceDescription(row,context) {
    const related_memory_states=this._evidenceStates(row.id,context),historical=related_memory_states.some(item=>['stale','expired','forgotten','pending_conflict'].includes(item.status))
    return {related_memory_states,label:evidenceLabel(row)+(historical?'；关联旧值或矛盾历史，不能据此覆盖当前值':'')}
  }
  _effectiveEvidence(id) {
    const original=this._rawEvidence(id)
    if(!original)return null
    const attestations=this.store.db.prepare("SELECT object_id FROM relations WHERE subject_kind='evidence' AND subject_id=? AND relation='confirmed_by' AND object_kind='evidence'").all(id)
      .map(row=>this._rawEvidence(row.object_id)).filter(row=>row&&row.status==='confirmed'&&row.confirmation==='server_receipt'
        &&row.platform===original.platform&&row.conversation_id===original.conversation_id)
      .sort((a,b)=>b.priority-a.priority||(b.source_at??0)-(a.source_at??0))
    if(!attestations.length)return original
    const proof=attestations[0]
    return {...original,status:proof.status,confirmation:proof.confirmation,priority:proof.priority,
      confirmation_evidence_id:proof.id,receipt:proof.receipt}
  }
  _canEntry(row,context) {
    if(!row||!visible(row,context))return false
    const evidence=this._support(row.id)
    // A globally addressable semantic summary never exposes secret evidence.
    if(evidence.some(item=>item.visibility==='secret')&&!(context.owner_authorized===true&&context.include_secret===true))return false
    if(context.owner_authorized===true)return true
    if(row.scope==='global')return true
    if(row.scope==='platform')return row.platform===context.platform
    return row.scope==='conversation'&&!!context.conversation_id&&row.platform===context.platform&&row.conversation_id===context.conversation_id
  }
  _identity(platform,actor_uid,actor_entity_id) {
    const identity=actor_uid?this.store.getPlatformIdentity(platform,actor_uid):null
    if(actor_entity_id!==undefined&&actor_entity_id!==null) {
      identifier(actor_entity_id,'actor_entity_id')
      if(!this.store.getEntity(actor_entity_id)||actor_uid&&(!identity||identity.entity_id!==actor_entity_id))throw new Error('actor_entity_id与已登记平台UID不符；需先登记准确身份')
    }
    return actor_entity_id??identity?.entity_id??null
  }

  /** Host ingestion only. Immutability also applies to receipt upgrades: an
   * attestation is a new evidence row connected to the original, never UPDATE. */
  recordEvidence(input) {
    this.store._write()
    fields(input,['platform','conversation_id','actor_uid','actor_entity_id','direction','kind','text','ref','source_message_id','source_at','source_time_raw','source_type','visibility','source','receipt','attests_id'],'来源证据')
    const platform=platformName(input.platform),conversation_id=uid(input.conversation_id??'','conversation_id'),actor_uid=uid(input.actor_uid??'')
    const direction=choice(input.direction,DIRECTIONS,'direction'),kind=choice(input.kind,EVIDENCE_KINDS,'kind')
    const source_type=choice(input.source_type,SOURCE_TYPES,'source_type'),source=sourceDescriptor(input.source),receipt=receiptDescriptor(input.receipt)
    const text=safeText(input.text,'text',64000,kind!=='receipt'),ref=safeText(input.ref??'','ref',4000)
    const source_message_id=uid(input.source_message_id??'','source_message_id'),source_at=timestamp(input.source_at,'source_at',true)
    const source_time_raw=safeText(input.source_time_raw??'','source_time_raw',2000)
    const visibility=choice(input.visibility??'owner',VISIBILITIES,'visibility')
    if(visibility==='conversation'&&!conversation_id)throw new Error('conversation私域证据必须提供conversation_id')
    const actor_entity_id=this._identity(platform,actor_uid,input.actor_entity_id)
    const classification=classifyEvidence({direction,source_type,kind,text,source,receipt})
    const dedupe_key=digest(stringifyJson(source_message_id&&!input.attests_id?{platform,conversation_id,direction,kind,source_message_id}:
      {platform,conversation_id,actor_uid,direction,kind,text,ref,source_message_id,source_at,source_time_raw,source_type,visibility,source,receipt,attests_id:input.attests_id??null}))
    const id='evidence:'+dedupe_key
    return this.store.transaction(()=>{
      if(input.attests_id!==undefined) {
        identifier(input.attests_id,'attests_id');const original=this._rawEvidence(input.attests_id)
        if(!original||kind!=='receipt'||classification.confirmation!=='server_receipt'||original.platform!==platform||original.conversation_id!==conversation_id
          ||original.direction!=='out'||actor_uid&&original.actor_uid&&original.actor_uid!==actor_uid)throw new Error('回执只能确认同平台、同会话的原动作来源')
        if(ref&&original.ref&&ref!==original.ref)throw new Error('回执与原动作引用不一致')
      }
      const previous=this._rawEvidence(id)
      const identityResolvedLater=previous&&previous.actor_entity_id===null&&actor_entity_id!==null&&actor_uid&&previous.actor_uid===actor_uid&&previous.direction==='observation'&&previous.source_type==='platform'&&source_type==='platform'&&previous.ref===ref&&previous.visibility===visibility&&this.store.getPlatformIdentity(platform,actor_uid)?.entity_id===actor_entity_id
      if(previous&&(previous.text!==text||previous.actor_uid!==actor_uid||previous.actor_entity_id!==actor_entity_id&&!identityResolvedLater))throw new Error('同一来源消息身份或原文发生冲突；已保留首条来源，未覆盖')
      if(previous&&classification.confirmation==='server_receipt'&&classification.priority>this._effectiveEvidence(id).priority&&previous.direction==='out') {
        const proof_key='attestation:'+digest(stringifyJson({original:id,source,receipt,classification})),proof_id='evidence:'+digest(proof_key)
        if(!this._rawEvidence(proof_id))insert(this.store.db,'evidence',EVIDENCE_COLUMNS,{...previous,id:proof_id,dedupe_key:proof_key,kind:'receipt',text:'',source_at,recorded_at:this._now(),...classification,source_type,source_json:stringifyJson(source),receipt_json:stringifyJson(receipt)})
        this._relate('evidence',id,'confirmed_by','evidence',proof_id)
      }
      if(!previous) {
        const row={id,dedupe_key,platform,conversation_id,actor_entity_id,actor_uid,direction,kind,text,ref,source_message_id,source_at,source_time_raw,recorded_at:this._now(),...classification,visibility,source_type,source_json:stringifyJson(source),receipt_json:stringifyJson(receipt)}
        insert(this.store.db,'evidence',EVIDENCE_COLUMNS,row)
        if(input.attests_id)this._relate('evidence',input.attests_id,'confirmed_by','evidence',id)
      }
      const evidence=this._effectiveEvidence(id)
      return {ok:true,accepted:true,id,status:evidence.status,confirmation:evidence.confirmation,duplicate:!!previous,evidence}
    })
  }

  remember(input, trusted_context = {}) {
    this.store._write();const context=contextOf(trusted_context)
    fields(input,['level','memory_type','subject','predicate','object','content','evidence_ids','entity_type','scope','platform','conversation_id','actor_uid','actor_entity_id','title','keywords','project','goal','importance','corrected','subcategory','source_session_id','valid_from','valid_until','correction','supersedes'],'结构化记忆')
    const level=choice(input.level,MEMORY_LEVELS,'level'),memory_type=choice(input.memory_type,['observed','asserted','inferred'],'memory_type')
    const evidence_ids=idsOf(input.evidence_ids,'evidence_ids',{required:true}),evidence=evidence_ids.map(id=>this._effectiveEvidence(id))
    if(evidence.some(row=>!row||row.kind==='receipt'||!visible(row,context)))throw new Error('引用证据不存在、不是正文或当前上下文无读取权限')
    const entity_type=choice(input.entity_type??(level==='user'?'person':'knowledge'),ENTITY_TYPES,'entity_type')
    if(level==='user'&&!['person','conversation'].includes(entity_type))throw new Error('user层仅保存具有稳定身份的人物或会话记忆')
    const subject=safeText(input.subject??'记事','subject',300,true),object=safeText(input.object??input.content,'object',16000,true)
    const content=safeText(input.content??`${subject} ${input.predicate??'记事'} ${object}`,'content',16000,true)
    // Unstructured notes do not all compete on a meaningless common predicate.
    const predicate=compareText(safeText(input.predicate??'note:'+digest(content).slice(0,24),'predicate',160,true))
    const public_only=evidence.every(row=>row.visibility==='public')
    const scope=choice(input.scope??(public_only?'global':'conversation'),['global','platform','conversation'],'scope')
    const one_private_context=new Set(evidence.filter(row=>row.visibility==='conversation').map(row=>row.platform+'\0'+row.conversation_id)).size===1
    const global_summary_authorized=scope==='global'&&context.allow_global_summary===true&&entity_type==='experience'&&evidence.every(row=>row.direction==='out'&&row.status==='confirmed'&&row.confirmation==='server_receipt'&&row.source_type==='server_action')
    const visibility=global_summary_authorized?'public':evidence.some(row=>row.visibility==='secret')?'secret':evidence.some(row=>row.visibility==='owner')?'owner':evidence.some(row=>row.visibility==='conversation')?(one_private_context?'conversation':'owner'):'public'
    const origin=evidence.find(row=>row.visibility==='conversation')??evidence[0]
    const platform=scope==='global'?(visibility==='conversation'?origin.platform:''):platformName(input.platform??evidence[0].platform)
    const conversation_id=scope==='conversation'?uid(input.conversation_id??evidence[0].conversation_id,'conversation_id'):visibility==='conversation'?origin.conversation_id:''
    if(scope==='conversation'&&!conversation_id)throw new Error('私域记忆必须提供确切conversation_id')
    if(scope!=='global'&&evidence.some(row=>row.platform!==platform||scope==='conversation'&&row.conversation_id!==conversation_id))throw new Error('记忆scope与来源平台/会话不符')
    if(scope==='global'&&!public_only&&context.owner_authorized!==true&&!global_summary_authorized)throw new Error('私域来源的全局摘要必须由可信主人上下文明确授权')
    const actor_uid=uid(input.actor_uid??(['person','conversation'].includes(entity_type)&&new Set(evidence.map(row=>row.actor_uid)).size===1?evidence[0].actor_uid:''))
    const evidenceEntities=[...new Set(evidence.map(row=>row.actor_entity_id).filter(Boolean))]
    let actor_entity_id=input.actor_entity_id??(entity_type==='person'&&evidenceEntities.length===1?evidenceEntities[0]:null)
    if(actor_entity_id!==null)identifier(actor_entity_id,'actor_entity_id')
    if(entity_type==='person') {
      if(!actor_entity_id||!this.store.getEntity(actor_entity_id)||evidence.some(row=>row.actor_entity_id!==actor_entity_id))throw new Error('人物记忆必须使用已登记稳定实体，不能按姓名猜测或合并')
      if(actor_uid&&evidence.some(row=>row.actor_uid&&row.actor_uid!==actor_uid)&&scope!=='global')throw new Error('人物来源UID不一致')
    } else if(actor_entity_id!==null) {
      if(!this.store.getEntity(actor_entity_id)||evidence.some(row=>row.actor_entity_id&&row.actor_entity_id!==actor_entity_id))throw new Error('记忆实体与来源身份不符')
    }
    const sourceTimes=evidence.map(row=>row.source_at).filter(value=>value!==null),source_at=sourceTimes.length?Math.max(...sourceTimes):null
    const valid_from=input.valid_from===undefined?source_at:timestamp(input.valid_from,'valid_from',true),valid_until=input.valid_until===undefined?null:timestamp(input.valid_until,'valid_until',true)
    if(valid_until!==null&&valid_from!==null&&valid_until<=valid_from)throw new Error('valid_until必须晚于valid_from')
    const supported=evidence.filter(row=>this._supportedForType(row,memory_type,entity_type))
    const grounded=supported.some(row=>directlySupports(row.text,{object,content,predicate}))
    let status=memory_type==='inferred'?'pending_inference':grounded&&!uncertain(object)?'active':'pending_confirmation'
    let reason=status==='active'?'':status==='pending_inference'?'推断需明确确认，不能当作事实':'缺少直接支持正文的明确来源'
    if(source_at===null&&status==='active'){status='pending_confirmation';reason='来源发生时间未知，不能作为已确认时序事实'}
    if(valid_until!==null&&valid_until<=this._now()){status='expired';reason='已到明确失效时间'}
    const priority=supported.length?Math.max(...supported.map(row=>row.priority)):0
    const source_rank=Math.max(0,...supported.filter(row=>directlySupports(row.text,{object,content,predicate})).map(canonicalEvidenceRank))
    const importance=integer(input.importance??1,'importance',0,100)
    const title=safeText(input.title??'','title',500),project=safeText(input.project??'','project',500),goal=safeText(input.goal??'','goal',1000)
    if(input.keywords!==undefined&&(!Array.isArray(input.keywords)||input.keywords.length>32))throw new Error('keywords必须为不超过32项文本数组')
    const keywords=(input.keywords??[]).map(value=>safeText(value,'keyword',160,true))
    for(const name of ['corrected','correction'])if(input[name]!==undefined&&typeof input[name]!=='boolean')throw new Error(name+'必须为布尔值')
    const subcategory=safeText(input.subcategory??'','subcategory',240),source_session_id=uid(input.source_session_id??'','source_session_id')
    const supersedes=idsOf(input.supersedes??[],'supersedes')
    const proposed={scope,platform,conversation_id,entity_type,actor_entity_id,subject,project,goal},logical_entity=this._logicalEntity(proposed,evidence)
    const sameEntity=row=>this._logicalEntity(row)===logical_entity
    // entity_key is a stable native key, not a format/version signature. Reuse
    // an existing logical entity after an explicit one-time migration as well.
    return this.store.transaction(()=>{
      // Privacy is checked before entity grouping, dedupe and conflict effects.
      // ACL origin remains on each row; a global logical entity has no origin.
      const sameEntities=this.store.db.prepare(ENTRY_SELECT+' WHERE scope=? AND entity_type=? ORDER BY created_at,id').all(scope,entity_type).map(entryRow).filter(row=>this._canEntry(row,context)&&sameEntity(row))
      const entity_key=sameEntities[0]?.entity_key??digest(logical_entity)
      const canonical_key=digest(stringifyJson([level,entity_key,predicate,compareText(object),memory_type,visibility,visibility==='conversation'?platform:'',visibility==='conversation'?conversation_id:'']))
      const equivalent=sameEntities.filter(row=>row.level===level&&row.memory_type===memory_type&&compareText(row.predicate)===predicate&&compareText(row.object)===compareText(object)&&row.visibility===visibility
        &&(visibility!=='conversation'||row.platform===platform&&row.conversation_id===conversation_id)).sort((a,b)=>Number(b.status==='active')-Number(a.status==='active')||(b.source_at??0)-(a.source_at??0))[0]
      const base=equivalent??entryRow(this.store.db.prepare(ENTRY_SELECT+' WHERE semantic_key=?').get(canonical_key))
      // Even guessed identical public text cannot reuse an inaccessible private
      // row's semantic key or append a public proof to that private memory.
      const base_key=base&&this._canEntry(base,context)?base.semantic_key:base?digest(stringifyJson([canonical_key,evidence_ids])):canonical_key
      const renew=base&&this._canEntry(base,context)&&['stale','expired','forgotten'].includes(base.status)&&source_at!==null&&(base.source_at===null||source_at>base.source_at)
      const semantic_key=renew?digest(stringifyJson([base_key,evidence_ids,valid_from])):base_key,id=!renew&&base&&this._canEntry(base,context)?base.id:'memory:'+semantic_key
      const previous=this._entry(id)
      for(const target of supersedes){const old=this._entry(target);if(!old||!this._canEntry(old,context)||!sameEntity(old)||compareText(old.predicate)!==predicate)throw new Error('只能纠正同主体、同关系且有权限的已有记忆')}
      if(previous&&!this._canEntry(previous,context))throw new Error('不能复用当前上下文无权读取的私域记忆')
      if(previous&&!(previous.status.startsWith('pending_')&&status==='active')) {
        for(const proof of evidence_ids)this._relate('memory_entry',id,'supported_by','evidence',proof)
        if(previous.status==='active'&&status==='active'&&source_at!==null&&(previous.source_at===null||source_at>previous.source_at)&&source_rank>=this._entryRank(previous))
          this.store.db.prepare('UPDATE memory_entries SET source_at=?,updated_at=? WHERE id=?').run(source_at,this._now(),id)
        return {ok:true,id,status:previous.status,duplicate:true,entry:this._writeDescription(this._entry(id),context)}
      }
      const competing=sameEntities.filter(row=>['active','pending_conflict'].includes(row.status)&&row.id!==id&&compareText(row.predicate)===predicate)
        .filter(row=>compareText(row.object)!==compareText(object)&&(row.valid_until===null||valid_from===null||row.valid_until>valid_from)&&(valid_until===null||row.valid_from===null||valid_until>row.valid_from))
      let corrected=[]
      if(status==='active'&&competing.length) {
        const explicit=input.correction===true||supersedes.length>0
        const canCorrect=explicit&&competing.every(row=>(supersedes.length===0||supersedes.includes(row.id))&&source_at!==null&&row.source_at!==null&&source_at>row.source_at&&source_rank>=this._entryRank(row))
        if(canCorrect)corrected=competing.map(row=>row.id)
        else if(competing.some(row=>source_at===null||row.source_at!==null&&source_at<row.source_at||source_rank<this._entryRank(row))) {
          status='pending_confirmation';reason='来源较旧或较弱，保留当前已知值，未覆盖较新记忆'
        } else {status='pending_conflict';reason='同一关系存在矛盾来源，等待明确更正'}
      }
      const now=this._now()
      if(previous) this.store.db.prepare('UPDATE memory_entries SET status=?,reason=?,source_at=?,valid_from=?,valid_until=?,priority=?,updated_at=? WHERE id=?').run(status,reason,source_at,valid_from,valid_until,priority,now,id)
      else insert(this.store.db,'memory_entries',ENTRY_COLUMNS,{id,semantic_key,entity_key,level,entity_type,subject,actor_entity_id,actor_uid:scope==='global'?'':actor_uid,predicate,object,content,title,keywords_json:stringifyJson(keywords),project,goal,importance,corrected:input.corrected===true?1:0,subcategory,source_session_id,scope,visibility,platform,conversation_id,memory_type,status,reason,source_at,valid_from,valid_until,priority,heat:1,hit_count:0,created_at:now,updated_at:now,last_accessed_at:null})
      for(const proof of evidence_ids)this._relate('memory_entry',id,'supported_by','evidence',proof,{global_summary_authorized:scope==='global'&&!public_only&&context.owner_authorized===true})
      for(const old of corrected) {
        this.store.db.prepare("UPDATE memory_entries SET status='stale',reason='已有较新明确更正，旧值及来源保留',corrected=1,valid_until=CASE WHEN valid_until IS NULL OR valid_until>? THEN ? ELSE valid_until END,updated_at=? WHERE id=?").run(valid_from,valid_from,now,old)
        this._relate('memory_entry',id,'supersedes','memory_entry',old)
      }
      if(status==='pending_conflict')for(const row of competing){
        this.store.db.prepare("UPDATE memory_entries SET status='pending_conflict',reason='存在待确认矛盾，暂不作为当前事实',updated_at=? WHERE id=?").run(now,row.id)
        this._relate('memory_entry',id,'contradicts','memory_entry',row.id)
      }
      return {ok:true,id,status,duplicate:!!previous,corrected,entry:this._writeDescription(this._entry(id),context)}
    })
  }

  _describeEntry(row,context) {
    const supported=this._support(row.id),evidence_ids=supported.filter(item=>visible(item,context)).map(item=>item.id)
    const related=this.store.db.prepare("SELECT relation,object_id FROM relations WHERE subject_kind='memory_entry' AND subject_id=? AND object_kind='memory_entry' AND relation IN ('supersedes','contradicts') ORDER BY relation,object_id").all(row.id)
      .filter(item=>this._canEntry(this._entry(item.object_id),context))
    return {id:row.id,level:row.level,entity_type:row.entity_type,subject:row.subject,predicate:row.predicate,object:row.object,content:row.content,title:row.title,keywords:row.keywords,
      project:row.project,goal:row.goal,importance:row.importance,corrected:row.corrected,scope:row.scope,visibility:row.visibility,platform:row.platform,conversation_id:row.conversation_id,actor_entity_id:row.actor_entity_id,
      memory_type:row.memory_type,status:row.status,label:entryLabel(row),reason:row.reason,source_at:row.source_at,valid_from:row.valid_from,valid_until:row.valid_until,
      evidence_ids,private_source_count:supported.length-evidence_ids.length,relations:related.map(item=>({relation:item.relation,id:item.object_id})),untrusted:true}
  }
  _writeDescription(row,context) {
    const entry=this._describeEntry(row,context);delete entry.content;delete entry.object
    return {...entry,...page(row.content,{max_chars:320})}
  }
  readEntry(input, trusted_context = {}) {
    this.store._open();fields(input,['id','offset','max_chars'],'读取记忆');identifier(input.id)
    const context=contextOf(trusted_context),row=this._entry(input.id)
    if(!row||!this._canEntry(row,context))return {found:false,text:'没有该记忆或当前上下文无读取权限。'}
    const result=this._describeEntry(row,context),chunk=page(row.content,input)
    delete result.content;delete result.object
    return {found:true,...result,...chunk}
  }
  readEvidence(input, trusted_context = {}) {
    this.store._open();fields(input,['id','offset','max_chars'],'读取来源');identifier(input.id)
    const context=contextOf(trusted_context),row=this._effectiveEvidence(input.id)
    if(!row||!visible(row,context))return {found:false,text:'没有该来源或当前上下文无读取权限。'}
    return {found:true,id:row.id,platform:row.platform,conversation_id:row.conversation_id,actor_entity_id:row.actor_entity_id,actor_uid:row.actor_uid,
      direction:row.direction,kind:row.kind,status:row.status,confirmation:row.confirmation,...this._evidenceDescription(row,context),visibility:row.visibility,ref:row.ref,
      source_at:row.source_at,source_time_raw:row.source_time_raw,source_type:row.source_type,source_message_id:row.source_message_id,
      confirmation_evidence_id:row.confirmation_evidence_id??null,...page(row.text,input),untrusted:true}
  }
  _query(input,extra=[]) {
    fields(input,[...QUERY_FIELDS,...extra],'检索记忆')
    const query=safeText(input.query??'','query',MEMORY_QUERY_MAX_CHARS),terms=searchTerms(query)
    const limit=integer(input.limit??8,'limit',1,30),max_chars=integer(input.max_chars??1800,'max_chars',96,1800)
    if(input.platform!==undefined)platformName(input.platform)
    if(input.conversation_id!==undefined)uid(input.conversation_id,'conversation_id')
    if(input.entity_id!==undefined)identifier(input.entity_id,'entity_id')
    if(input.level!==undefined)choice(input.level,MEMORY_LEVELS,'level')
    for(const key of ['project','goal'])if(input[key]!==undefined)safeText(input[key],key,1000)
    const since=queryTime(input.since,'since'),until=queryTime(input.until,'until',true)
    if(since!==undefined&&until!==undefined&&since>until)throw new Error('since不能晚于until')
    return {query,terms,limit,max_chars,since,until}
  }
  _conditions(input,q,{table='memory_entries',text='content'}={}) {
    const conditions=[],parameters=[]
    if(q.terms.length){
      const columns=table==='memory_entries'?['content','subject','predicate','object','title','keywords_json','project','goal']:[text]
      conditions.push('('+columns.map(column=>`companion_memory_match(CAST(${table}.${column} AS BLOB),?)>0`).join(' OR ')+')');parameters.push(...columns.map(()=>q.query))
    }
    for(const key of ['platform','conversation_id','level','project','goal'])if(input[key]!==undefined){conditions.push(table+'.'+key+'=?');parameters.push(input[key])}
    if(input.entity_id!==undefined){conditions.push(table+'.'+(table==='journal_events'?'entity_id':'actor_entity_id')+'=?');parameters.push(input.entity_id)}
    if(q.since!==undefined){conditions.push(table+'.source_at>=?');parameters.push(q.since)}
    if(q.until!==undefined){conditions.push(table+'.source_at<=?');parameters.push(q.until)}
    return {conditions,parameters}
  }
  recall(input = {}, trusted_context = {}) {
    this.store._open();const context=contextOf(trusted_context),q=this._query(input)
    if(!q.terms.length)return noResult('请提供具体问题或关键词；没有依据时不补全记忆。')
    const {conditions,parameters}=this._conditions(input,q)
    conditions.push("status='active'",'(valid_from IS NULL OR valid_from<=?)','(valid_until IS NULL OR valid_until>?)');parameters.push(this._now(),this._now())
    const rows=this.store.db.prepare(ENTRY_SELECT+' WHERE '+conditions.join(' AND ')+' ORDER BY source_at DESC,id').all(...parameters).map(entryRow).filter(row=>this._canEntry(row,context))
    const ranks=new Map(),rank=row=>{if(!ranks.has(row.id))ranks.set(row.id,this._entryRank(row));return ranks.get(row.id)}
    rows.sort((a,b)=>searchScore(b.content,q.terms)-searchScore(a.content,q.terms)||rank(b)-rank(a)||(b.source_at??0)-(a.source_at??0))
    const result=this._renderEntries(rows,q,context)
    if(!this.store.readOnly&&result.items.length){
      this.store.transaction(()=>{for(const row of result.items)this.store.db.prepare('UPDATE memory_entries SET hit_count=hit_count+1,last_accessed_at=? WHERE id=?').run(this._now(),row.id)})
    }
    return result
  }
  _renderEntries(rows,q,context) {
    const items=[],lines=[];let used=0
    for(const row of rows){
      if(items.length>=q.limit)break
      const prefix='['+entryLabel(row)+' '+row.id+'] ',room=q.max_chars-used-prefix.length-(lines.length?1:0)
      if(room<12)break
      const offset=this._matchOffset(row.content,q.terms),chunk=page(row.content,{offset,max_chars:Math.min(room,520)})
      const entry=this._describeEntry(row,context);delete entry.content;delete entry.object
      items.push({...entry,...chunk});const line=prefix+chunk.text;lines.push(line);used+=line.length+(lines.length>1?1:0)
    }
    return {items,text:lines.join('\n')||'没有符合权限、时间和有效状态的依据；暂时记不清。',abstained:!items.length,untrusted:true}
  }
  _matchOffset(text,terms) {
    const value=text.toLowerCase(),indices=terms.filter(Boolean).sort((a,b)=>b.length-a.length).map(term=>value.indexOf(term)).filter(index=>index>=0)
    return Math.max(0,(indices[0]??0)-100)
  }
  /** A deliberate raw-history request includes pending/failed records but labels
   * them. It does not promote them into current semantic facts. */
  searchJournal(input = {}, trusted_context = {}) {
    this.store._open();const context=contextOf(trusted_context),q=this._query(input,['event_type','kind','direction','source','status'])
    for(const unsupported of ['level','project','goal'])if(input[unsupported]!==undefined)throw new Error('原始经历检索不支持'+unsupported)
    if(input.direction!==undefined)choice(input.direction,DIRECTIONS,'direction')
    if(input.kind!==undefined)choice(input.kind,EVIDENCE_KINDS,'kind')
    if(input.source!==undefined)choice(input.source,['all','evidence','journal'],'source')
    if(input.event_type!==undefined)choice(input.event_type,['interaction','experience','mood','log','diary','report','learning','notification','platform_read'],'event_type')
    if(input.status!==undefined)rawText(input.status,'status',80,true)
    if(!q.terms.length&&q.since===undefined&&q.until===undefined&&input.conversation_id===undefined)return noResult('请提供关键词、会话或时间范围，不会整库注入原文。')
    const all=[]
    if(input.source!=='journal'&&input.event_type===undefined) {
      const {conditions,parameters}=this._conditions(input,q,{table:'evidence',text:'text'})
      for(const key of ['kind','direction'])if(input[key]!==undefined){conditions.push('evidence.'+key+'=?');parameters.push(input[key])}
      conditions.push("kind<>'receipt'")
      const rows=this.store.db.prepare(EVIDENCE_SELECT+' WHERE '+conditions.join(' AND ')+' ORDER BY source_at DESC,id').all(...parameters).map(evidenceRow)
      for(const original of rows){const row=this._effectiveEvidence(original.id);if(visible(row,context)&&(input.status===undefined||row.status===input.status))all.push({id:row.id,source:'evidence',platform:row.platform,conversation_id:row.conversation_id,actor_entity_id:row.actor_entity_id,actor_uid:row.actor_uid,direction:row.direction,kind:row.kind,text:row.text,ref:row.ref,source_at:row.source_at,source_time_raw:row.source_time_raw,status:row.status,visibility:row.visibility,confirmation:row.confirmation,...this._evidenceDescription(row,context)})}
    }
    if(input.source!=='evidence'&&input.kind===undefined) {
      const {conditions,parameters}=this._conditions(input,q,{table:'journal_events',text:'text'})
      for(const key of ['event_type','direction','status'])if(input[key]!==undefined){conditions.push('journal_events.'+key+'=?');parameters.push(input[key])}
      const projection=select('journal_events',['text','ref','source_time_raw'])
      const rows=this.store.db.prepare(projection+(conditions.length?' WHERE '+conditions.join(' AND '):'')+' ORDER BY source_at DESC,id').all(...parameters).map(row=>decode(row,['text','ref','source_time_raw']))
      for(const row of rows)if(visible(row,context))all.push({id:row.id,source:'journal',platform:row.platform,conversation_id:row.conversation_id,actor_entity_id:row.entity_id,actor_uid:row.actor_uid,direction:row.direction,event_type:row.event_type,text:row.text,ref:row.ref,source_at:row.source_at,source_time_raw:row.source_time_raw,status:row.status,visibility:row.visibility,label:row.status==='confirmed'?'带确认记录的经历；不独立证明正文事实':'经历/日志原始记事；不独立证明正文事实'})
    }
    all.sort((a,b)=>searchScore(b.text,q.terms)-searchScore(a.text,q.terms)||(b.source_at??0)-(a.source_at??0)||a.id.localeCompare(b.id))
    const items=[],lines=[];let used=0
    for(const row of all) {
      if(items.length>=q.limit)break
      const prefix='['+row.label+' '+row.id+'] ',room=q.max_chars-used-prefix.length-(lines.length?1:0)
      if(room<12)break
      const chunk=page(row.text,{offset:this._matchOffset(row.text,q.terms),max_chars:Math.min(room,520)})
      items.push({...row,...chunk,untrusted:true});const line=prefix+chunk.text;lines.push(line);used+=line.length+(lines.length>1?1:0)
    }
    return {items,text:lines.join('\n')||'没有符合权限与时间范围的来源或经历记录。',abstained:!items.length,untrusted:true}
  }
  pendingConflicts(input = {}, trusted_context = {}) {
    this.store._open();fields(input,['limit','max_chars'],'待确认记忆');const context=contextOf(trusted_context)
    const q={limit:integer(input.limit??8,'limit',1,30),max_chars:integer(input.max_chars??1800,'max_chars',96,1800),terms:[]}
    const rows=this.store.db.prepare(ENTRY_SELECT+" WHERE status IN ('pending_conflict','pending_inference','pending_confirmation','pending_scope') ORDER BY updated_at DESC,id").all().map(entryRow).filter(row=>this._canEntry(row,context))
    return this._renderEntries(rows,q,context)
  }
  forget(input, trusted_context = {}) {
    this.store._write();fields(input,['id','mode','reason'],'遗忘记忆');identifier(input.id)
    const context=contextOf(trusted_context)
    if(context.owner_authorized!==true)throw new Error('遗忘需可信主人授权')
    const mode=choice(input.mode??'forget',['forget','cool','expire'],'mode'),reason=safeText(input.reason??'','reason',500)
    return this.store.transaction(()=>{
      const row=this._entry(input.id)
      if(!row||!this._canEntry(row,context))return {ok:false,status:'not_found'}
      if(mode==='cool')this.store.db.prepare('UPDATE memory_entries SET heat=MAX(0.01,heat*0.25),updated_at=? WHERE id=?').run(this._now(),row.id)
      else this.store.db.prepare('UPDATE memory_entries SET status=?,reason=?,heat=0,updated_at=? WHERE id=?').run(mode==='expire'?'expired':'forgotten',reason||'主人主动'+(mode==='expire'?'标记过期':'遗忘；原始来源保留'),this._now(),row.id)
      const event=this.store.appendJournalEvent({event_key:'memory-state:'+randomUUID(),event_type:'log',platform:row.platform||'memory',entity_id:row.actor_entity_id,conversation_id:row.conversation_id,
        direction:'internal',status:'recorded',visibility:row.visibility,text:reason,source_at:this._now(),source_type:'native_memory',metadata:{memory_id:row.id,operation:mode,previous_status:row.status}})
      this._relate('memory_entry',row.id,'state_history','journal_event',event.id)
      return {ok:true,id:row.id,status:this._entry(row.id).status,original_evidence_preserved:true}
    })
  }
  restore(input, trusted_context = {}) {
    this.store._write();fields(input,['id','reason'],'恢复记忆');identifier(input.id)
    const context=contextOf(trusted_context)
    if(context.owner_authorized!==true)throw new Error('恢复需可信主人授权')
    const reason=safeText(input.reason??'','reason',500)
    return this.store.transaction(()=>{
      const row=this._entry(input.id)
      if(!row||!this._canEntry(row,context))return {ok:false,status:'not_found'}
      const history=this.store.db.prepare("SELECT journal_events.metadata_json FROM relations JOIN journal_events ON journal_events.id=relations.object_id WHERE subject_kind='memory_entry' AND subject_id=? AND relation='state_history' AND object_kind='journal_event' ORDER BY journal_events.recorded_at DESC,journal_events.rowid DESC").all(row.id).map(item=>JSON.parse(item.metadata_json))
      const manual=history.find(item=>['forget','expire','cool'].includes(item.operation))
      if(!['forgotten','expired','active'].includes(row.status)||!manual||row.corrected||manual.previous_status!=='active'||row.valid_until!==null&&row.valid_until<=this._now())return {ok:false,id:row.id,status:row.status,reason:'仅可恢复主动遗忘的有效记忆；更正、自然到期和待确认状态不能复活'}
      const logical=this._logicalEntity(row),competing=this.store.db.prepare(ENTRY_SELECT+" WHERE scope=? AND entity_type=? AND id<>? AND status IN ('active','pending_conflict')").all(row.scope,row.entity_type,row.id).map(entryRow)
        .filter(other=>this._canEntry(other,context)&&this._logicalEntity(other)===logical&&compareText(other.predicate)===compareText(row.predicate))
      if(competing.length)return {ok:false,id:row.id,status:row.status,reason:'同关系已有更新记录，不能恢复旧值覆盖'}
      this.store.db.prepare("UPDATE memory_entries SET status='active',reason=?,heat=1,updated_at=? WHERE id=?").run(reason||'主人恢复主动遗忘的记忆；原来源保留',this._now(),row.id)
      return {ok:true,id:row.id,status:'active',original_evidence_preserved:true}
    })
  }
}
