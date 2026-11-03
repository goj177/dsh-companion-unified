import { createHash } from 'node:crypto'
import { NativeStore } from './store.mjs'
import { isPlainObject,stringifyJson } from './contracts.mjs'
import { SPEECH_DEFAULTS,buildSpeechSection,analyzeSpeech } from './speech-core.mjs'

const hash=value=>createHash('sha256').update(value).digest('hex')
const fields=(value,keys)=>{if(!isPlainObject(value)||Object.keys(value).some(key=>!keys.includes(key)))throw new Error('原生表达参数包含未知字段')}
const canonical=value=>Array.isArray(value)?value.map(canonical):isPlainObject(value)?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value
const encode=value=>stringifyJson(canonical(value))
const sidOf=value=>value?.agent?.session?.header?.id??value?.agent?.session?.id??value?.session?.header?.id??value?.session?.id??value?.header?.id??value?.id??''
const textOf=content=>typeof content==='string'?content:Array.isArray(content)?content.filter(block=>block?.type==='text'&&typeof block.text==='string').map(block=>block.text).join('\n'):''
const isTime=value=>Number.isSafeInteger(value)&&value>=0
const finalText=message=>Array.isArray(message?.content)&&!message.content.some(block=>['tool-call','question','approval-request'].includes(block?.type))?textOf(message.content):''
const structured=text=>/(?:只|仅|严格|按.{0,10}(?:格式|结构)).{0,24}(?:JSON|XML|YAML|CSV|代码|表格)|(?:写|生成|输出|整理).{0,15}(?:报告|文档|代码|JSON|XML|YAML|CSV|表格|操作步骤)/i.test(text)
const KINDS=new Set(['qq.send','tieba.reply','tieba.post','tieba.message','bilibili.comment','bilibili.reply','bilibili.dynamic'])
const proof=receipt=>receipt?.accepted===true&&receipt.source==='server_receipt'&&receipt.rejected!==true&&(receipt.code===undefined||receipt.code===0)&&typeof receipt.server_id==='string'&&receipt.server_id.trim()&&!/^(?:0|-1|null|undefined)$/i.test(receipt.server_id)

/** Anonymous surface-pattern cache only. Never rewrites, rejects, resends or
 * scores a publication, and never stores generated text or contact identifiers. */
export class NativeSpeech {
  constructor(options={}){
    fields(options,['store','now','document_id','state_document_id','cursor_key'])
    if(!(options.store instanceof NativeStore))throw new Error('NativeSpeech必须显式使用NativeStore')
    this.store=options.store;this.now=options.now??this.store.now;this.document_id=options.document_id??'speech';this.state_document_id=options.state_document_id??'speech-state';this.cursor_key=options.cursor_key??'native:speech:cursor';this.turns=new Map()
  }
  _now(){const value=this.now();if(!isTime(value))throw new Error('表达缓存时钟无效');return value}
  _settings(){const doc=this.store.getDocument(this.document_id);if(doc&&doc.type!=='speech')throw new Error('自然表达文档类型不符');return {doc,value:{...SPEECH_DEFAULTS,...doc?.value,enabled:this.store.getDocument('settings')?.value.enabled!==false&&(doc?.value.enabled??true)}}}
  _state(){const doc=this.store.getDocument(this.state_document_id);if(doc&&doc.type!=='speech_state')throw new Error('表达指纹文档类型不符');return {doc,value:doc?.value??{version:1,buckets:[]}}}
  _scope({platform='main',context={},agent}={}){
    if(context.memory_only)return null
    if(platform==='qq'){if(typeof context.conversation_id!=='string'||!context.conversation_id)return null;return {id:hash('qq\0qq-chat\0'+context.conversation_id),platform:'qq',kind:'qq-chat'}}
    if(['tieba','bilibili'].includes(platform))return {id:hash(platform+'\0session\0public-generator'),platform,kind:'session'}
    const sid=sidOf(agent)||context.session_id
    if(!sid)return null
    return {id:hash('main\0session\0'+sid),platform:'main',kind:'session'}
  }
  section(input={}){fields(input,['platform','context','agent']);if(input.context?.memory_only)return '';return buildSpeechSection({platform:input.platform??'',settings:this._settings().value})}
  context(input={}){
    fields(input,['platform','context','agent']);const config=this._settings(),settings=config.value,scope=this._scope(input)
    if(!settings.enabled||!settings.repetition_hints||!scope||this.turns.get(sidOf(input.agent))?.structured)return ''
    const bucket=this._state().value.buckets.find(row=>row.id===scope.id),counts=new Map()
    for(const row of bucket?.recent??[])if(row.source_at>=(config.doc?.updated_at??0))for(const id of new Set(row.pattern_ids))counts.set(id,(counts.get(id)??0)+1)
    if(![...counts.values()].some(count=>count>=2))return ''
    return '【口气提醒】最近几次生成用了相同句架；这次可直接接具体内容，换个自然起句或收尾。保留有效人设、明确格式与事实，不为变化硬凑新话。'
  }
  analyze(input){fields(input,['text','purpose']);if(typeof input.text!=='string'||input.text.length>64000||!input.text.isWellFormed()||input.purpose!==undefined&&!['chat','structured'].includes(input.purpose))throw new Error('表达诊断文本或用途无效');return {...analyzeSpeech(input.text,{purpose:input.purpose??'chat'}),stored:false,rewritten:false,model_calls:0}}
  _record(scope,event_id,source_at,body,purpose='chat'){
    if(!scope||!body.trim()||body==='[[COMPANION_SKIP]]')return false
    const state=this._state(),fingerprints=analyzeSpeech(body,{purpose}).fingerprints.map(row=>row.id).slice(0,16),bucket=state.value.buckets.find(row=>row.id===scope.id)
    if(bucket?.recent.some(row=>row.event_id===event_id))return false
    const epoch=this._settings().doc?.updated_at??0,recent=[...(bucket?.recent??[]).filter(row=>row.source_at>=epoch),{event_id,source_at,pattern_ids:[...new Set(fingerprints)]}].slice(-3)
    const next={id:scope.id,platform:scope.platform,kind:scope.kind,updated_at:source_at,recent}
    const buckets=[...state.value.buckets.filter(row=>row.id!==scope.id),next].sort((a,b)=>b.updated_at-a.updated_at).slice(0,200)
    this.store.putDocument({id:this.state_document_id,type:'speech_state',expected_revision:state.doc?.revision??0,value:{version:1,buckets}})
    return true
  }
  _cursor(){
    const row=this.store.db.prepare('SELECT schema_id,schema_version,value_json FROM cache_entries WHERE key=?').get(this.cursor_key)
    try{const value=row?JSON.parse(row.value_json):null;if(row?.schema_id==='companion.speech_cursor'&&row.schema_version===1&&isTime(value?.journal_rowid)&&isTime(value?.epoch_at)&&Number.isSafeInteger(value?.settings_revision))return value}catch{}
    return {journal_rowid:0,epoch_at:0,settings_revision:0}
  }
  _saveCursor(value){this.store.db.prepare('INSERT INTO cache_entries(key,kind,schema_id,schema_version,value_json,created_at,expires_at) VALUES(?,?,?,?,?,?,NULL) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,created_at=excluded.created_at,schema_id=excluded.schema_id,schema_version=excluded.schema_version,kind=excluded.kind').run(this.cursor_key,'speech_cursor','companion.speech_cursor',1,encode(value),this._now())}
  _body(action){
    if(action.platform!=='qq')return action.body
    let segments
    try{segments=JSON.parse(action.body)}catch{return ''}
    if(!Array.isArray(segments)||!Array.isArray(action.target.segments)||encode(segments)!==encode(action.target.segments))return ''
    // Forward containers are quotations by default. Only a trusted host's
    // explicit self-generation marker may make their text eligible.
    const collect=rows=>rows.flatMap(row=>row.type==='text'&&typeof row.text==='string'?[row.text]:row.type==='forward'&&action.metadata.speech_role==='self_generated'?(row.nodes??[]).flatMap(node=>collect(node.segments??[])):[])
    return collect(segments).join('\n')
  }
  scan(input={}){
    fields(input,['limit']);const limit=input.limit??250;if(!Number.isSafeInteger(limit)||limit<1||limit>1000)throw new Error('扫描数量必须为1至1000')
    if(this.store.readOnly)return {scanned:0,recorded:0,status:'read_only'}
    return this.store.transaction(()=>{
      const settings=this._settings();if(!settings.value.enabled||!settings.value.repetition_hints)return {scanned:0,recorded:0,status:'disabled'}
      const cursor=this._cursor(),revision=settings.doc?.revision??0
      if(cursor.settings_revision!==revision){cursor.settings_revision=revision;cursor.epoch_at=settings.doc?.updated_at??0}
      const rows=this.store.db.prepare("SELECT rowid AS journal_rowid,id,platform,conversation_id,status,visibility,recorded_at,metadata_json FROM journal_events WHERE rowid>? AND source_type='native_action_service' ORDER BY rowid LIMIT ?").all(cursor.journal_rowid,limit)
      let recorded=0
      for(const row of rows){
        cursor.journal_rowid=row.journal_rowid
        if(row.status!=='confirmed'||row.recorded_at<cursor.epoch_at||row.platform!=='qq'&&row.visibility!=='public')continue
        const metadata=JSON.parse(row.metadata_json),raw=this.store.db.prepare('SELECT *,CAST(body AS BLOB) AS body_bytes FROM actions WHERE id=?').get(metadata.action_id)
        if(!raw||raw.status!=='confirmed'||!KINDS.has(raw.kind)||raw.platform!==row.platform||metadata.request_digest!==raw.request_digest)continue
        const action={...raw,body:Buffer.from(raw.body_bytes).toString('utf8'),target:JSON.parse(raw.target_json),metadata:JSON.parse(raw.metadata_json)}
        if(!proof(JSON.parse(raw.receipt_json))||hash(Buffer.from(action.body,'utf8'))!==raw.body_digest||hash(encode({platform:action.platform,kind:action.kind,target:action.target,body:action.body}))!==raw.request_digest)continue
        if(action.platform==='qq'&&row.conversation_id!==action.target.conversation_id)continue
        const body=this._body(action),scope=this._scope({platform:row.platform,context:{conversation_id:row.conversation_id}})
        if(this._record(scope,hash('publication\0'+action.id+'\0'+action.request_digest),row.recorded_at,body))recorded++
      }
      this._saveCursor(cursor)
      return {status:'scanned',scanned:rows.length,recorded,cursor:cursor.journal_rowid,has_more:rows.length===limit,model_calls:0}
    })
  }
  on_event(session,event){
    const config=this._settings(),settings=config.value,sid=sidOf(session);if(!sid)return
    if(this.store.readOnly||!settings.enabled||!settings.repetition_hints||session?.header?.origin==='subagent'){this.turns.delete(sid);return}
    if(event.type==='turn/start'){this.turns.set(sid,{turn:event.data?.turn,settings_revision:config.doc?.revision??0,had_user:false,internal:false,structured:false,candidate:''});if(this.turns.size>512)this.turns.delete(this.turns.keys().next().value);return}
    const state=this.turns.get(sid);if(!state)return
    if(state.settings_revision!==(config.doc?.revision??0)){this.turns.delete(sid);return}
    const message=event.data?.message??event.data??{}
    if(event.type==='user/message'){
      if(message.source?.kind==='user'){state.had_user=true;state.structured=structured(textOf(message.content))}
      else if(message.source?.kind?.startsWith('plugin:')&&message.source.kind!=='plugin:companion-memory')state.internal=true
      return
    }
    if(event.data?.turn!==state.turn)return
    if(event.type==='assistant/message')state.candidate=finalText(message)
    if(event.type==='tool/call')state.candidate=''
    if(event.type==='turn/end'){
      this.turns.delete(sid)
      if(event.data?.reason?.kind==='completed'&&state.had_user&&!state.internal&&state.candidate.trim())this.store.transaction(()=>this._record(this._scope({agent:{session}}),hash('harness\0'+sid+'\0'+state.turn),this._now(),state.candidate,state.structured?'structured':'chat'))
    }
  }
  status(){const settings=this._settings(),state=this._state().value;return {enabled:settings.value.enabled,level:settings.value.level,repetition_hints:settings.value.repetition_hints,scopes:state.buckets.length,events:state.buckets.reduce((sum,row)=>sum+row.recent.length,0),max_scopes:200,max_recent:3,model_calls:0,rewrites:false,cursor:this._cursor().journal_rowid}}
}
