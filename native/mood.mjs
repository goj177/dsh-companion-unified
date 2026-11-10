import { createHash,randomUUID } from 'node:crypto'
import { NativeStore } from './store.mjs'
import { NativeActivity } from './activity.mjs'
import { stringifyJson } from './contracts.mjs'
import { fields,choice,contextOf,visible,safeText,identifier } from './memory-rules.mjs'
import { shanghaiTime,valleyDecision } from '../policy.mjs'

const DIMS=Object.freeze(['happy','calm','sweet','heartache','worry','sad','jealous'])
const DEFAULT_POLICY=Object.freeze({baseline:70,floor:0,decay_half_hours:12,auto_judge:true,inject_mode:'event',inject_confidence:60,significant_delta:3,significant_dimension_delta:5,inject_per_day:6})
const hash=value=>createHash('sha256').update(value).digest('hex')
const clamp=(value,min=0,max=100)=>Math.max(min,Math.min(max,value))
const number=(value,label)=>{if(typeof value!=='number'||!Number.isFinite(value)||value<0||value>100)throw new Error(label+'必须为0至100的有限数值');return value}
const nowValue=value=>{if(!Number.isSafeInteger(value)||value<0)throw new Error('心情时钟无效');return value}
const blankDims=()=>Object.fromEntries(DIMS.map(key=>[key,0]))
const auth=input=>{fields(input??{},['platform','conversation_id','actor_uid','actor_entity_id','owner_authorized','include_secret','source_event_id','session_id','workspace_id','memory_only','query','allow_global_summary','read_memory','write_memory','allow_observe','idempotency_key','expected_revision']);for(const key of ['session_id','idempotency_key'])if(input?.[key]!==undefined&&(typeof input[key]!=='string'||input[key].length>512||/[\0\r\n]/.test(input[key])))throw new Error(key+'无效');if(input?.allow_observe!==undefined&&typeof input.allow_observe!=='boolean')throw new Error('allow_observe必须为可信宿主布尔能力');if(input?.expected_revision!==undefined&&(!Number.isSafeInteger(input.expected_revision)||input.expected_revision<0))throw new Error('expected_revision无效');return {authority:contextOf(Object.fromEntries(['platform','conversation_id','actor_uid','actor_entity_id','owner_authorized','include_secret'].filter(key=>input?.[key]!==undefined).map(key=>[key,input[key]]))),source_event_id:input?.source_event_id,session_id:input?.session_id??'',idempotency_key:input?.idempotency_key,expected_revision:input?.expected_revision,allow_observe:input?.allow_observe===true}}

/** One shared subjective state. Reads project natural recovery without changing
 * stored values, timestamps, reasons, journals or quotas. No model is called. */
export class NativeMood {
  constructor(options={}){fields(options,['store','now','document_id']);if(!(options.store instanceof NativeStore))throw new Error('NativeMood必须显式使用NativeStore');this.store=options.store;this.now=options.now??this.store.now;this.document_id=options.document_id??'mood'}
  _now(){return nowValue(this.now())}
  _data(){
    const doc=this.store.getDocument(this.document_id);if(doc&&doc.type!=='mood')throw new Error('共享心情文档类型错误')
    const value=doc?.value??{enabled:true,shared:true},policy={...DEFAULT_POLICY,...value.policy},at=this._now(),raw=value.state??{},state={value:raw.value??policy.baseline,dimensions:{...blankDims(),...raw.dimensions},reason:raw.reason??'',updated_at:raw.updated_at??0,last_decay_at:raw.last_decay_at??at,last_confidence:raw.last_confidence??0,last_noted_value:raw.last_noted_value??raw.value??policy.baseline,minor:raw.minor??false,kind:raw.kind??'',injected_for:raw.injected_for??null,last_injected_at:raw.last_injected_at??null,last_injected_text:raw.last_injected_text??'',said_at:raw.said_at??[],...(raw.source_event_id?{source_event_id:raw.source_event_id}:{})}
    const age=Math.max(0,at-state.last_decay_at)
    if(age>=60000){const half=policy.decay_half_hours*3600000,base=policy.baseline;state.value=clamp(Math.round(base+(state.value-base)*2**(-age/half)));for(const key of DIMS)state.dimensions[key]=Math.max(0,Math.round(state.dimensions[key]*2**(-age/(90*60000))))}
    return {doc,value,policy,state,stored:raw,enabled:this.store.getDocument('settings')?.value.enabled!==false&&value.enabled!==false}
  }
  _notice(data){
    const {state,policy}=data,day=shanghaiTime(this._now()),said_today=state.said_at.filter(at=>at>=day.midnight&&at<day.midnight+86400000).length
    let status='pending'
    if(!data.enabled||policy.inject_mode==='off')status='off'
    else if(!state.source_event_id)status='empty'
    else if(this.store.db.prepare('SELECT id FROM journal_events WHERE event_key=?').get('mood-notice:'+state.source_event_id))status='said'
    else if(state.minor)status='minor'
    else if(state.last_confidence<policy.inject_confidence)status='low_confidence'
    else if(said_today>=policy.inject_per_day)status='daily_limit'
    return {status,said_today,limit:policy.inject_per_day,source_event_id:state.source_event_id??null}
  }
  status(){const data=this._data();return {enabled:data.enabled,shared:true,revision:data.doc?.revision??0,value:data.state.value,dimensions:{...data.state.dimensions},updated_at:data.state.updated_at,computed_at:this._now(),last_confidence:data.state.last_confidence,minor:data.state.minor,source_event_id:data.state.source_event_id??null,reason_hidden:true,policy:{...data.policy},event_notice:this._notice(data)}}
  context(input={}){fields(input,['context','platform','agent']);const data=this._data();if(!data.enabled||data.policy.inject_mode==='off'||input.context?.memory_only||!data.state.source_event_id)return '';return '【心情】'+stringifyJson({scope:'shared',recorded:true,value:data.state.value,dimensions:Object.fromEntries(DIMS.filter(key=>data.state.dimensions[key]>0).sort((a,b)=>data.state.dimensions[b]-data.state.dimensions[a]).slice(0,2).map(key=>[key,data.state.dimensions[key]]))})}
  _sources(ids,context){
    const rows=ids.map(id=>this.store.db.prepare('SELECT id,platform,conversation_id,visibility,source_at,direction,source_type FROM evidence WHERE id=?').get(id))
    if(rows.some(row=>!row||!visible(row,context.authority)))throw new Error('心情引用来源不存在或当前上下文无权限')
    if(context.source_event_id){identifier(context.source_event_id);const event=this.store.getJournalEvent(context.source_event_id);if(!event||!visible(event,context.authority))throw new Error('心情宿主来源事件不存在或无权限');rows.push(event)}
    return rows
  }
  _write(input,trusted_context,absolute){
    this.store._write();fields(input,['value','dimensions','reason','confidence','evidence_ids'])
    const context=auth(trusted_context),target=number(input.value,'value'),confidence=number(input.confidence??70,'confidence'),reason=safeText(input.reason??'','reason',4000)
    if(reason.includes('\0'))throw new Error('心情原因不能包含NUL')
    if(absolute&&context.authority.owner_authorized!==true)throw new Error('绝对设置心情需要可信主人授权')
    fields(input.dimensions??{},DIMS);for(const [key,value]of Object.entries(input.dimensions??{}))number(value,'dimensions.'+key)
    if(!Array.isArray(input.evidence_ids??[])||(input.evidence_ids??[]).length>32)throw new Error('evidence_ids最多32条')
    const evidence_ids=[...new Set(input.evidence_ids??[])].sort();evidence_ids.forEach(id=>identifier(id))
    return this.store.transaction(()=>{
      const data=this._data();if(!data.enabled)return {recorded:false,status:'disabled'}
      const sources=this._sources(evidence_ids,context)
      if(!absolute&&!sources.length&&!context.allow_observe)throw new Error('普通心情观察需真实来源或宿主当前同轮感受能力，不能自造经历')
      if(!absolute&&!sources.length&&(!context.session_id||!context.idempotency_key))throw new Error('无证据的同轮自评必须携带可信SDK会话与调用标识')
      const source_at=absolute||!sources.length?this._now():Math.max(...sources.map(row=>row.source_at??0))
      const raw_delta=clamp(Math.round(target-data.state.value),-10,10),step=absolute?target-data.state.value:Math.round(raw_delta/3),dimensions={...data.state.dimensions},deltas={}
      for(const [key,value]of Object.entries(input.dimensions??{})){const delta=absolute?value-dimensions[key]:clamp(Math.round(value-dimensions[key]),-10,10);deltas[key]=delta;dimensions[key]=absolute?value:clamp(Math.round(dimensions[key]+delta))}
      const value=absolute?target:clamp(Math.round(data.state.value+step),data.policy.floor),significant=absolute||Math.abs(raw_delta)>=data.policy.significant_delta||Object.values(deltas).some(delta=>Math.abs(delta)>=data.policy.significant_dimension_delta)
      const key=context.idempotency_key??(absolute?randomUUID():stringifyJson([context.session_id,context.source_event_id??'',evidence_ids])),event_key='mood:'+ (absolute?'apply':'observe')+':'+hash(String(key)),id='mood:'+hash(event_key)
      const old=this.store.getJournalEvent(id)
      if(old)return {recorded:true,duplicate:true,id,value:old.metadata.after_value,status:'recorded'}
      if(context.expected_revision!==undefined&&context.expected_revision!==(data.doc?.revision??0))return {recorded:false,status:'stale_observation',value:data.state.value}
      const secret=sources.some(row=>row.visibility==='secret'),owner=sources.some(row=>row.visibility==='owner'),conversations=sources.filter(row=>row.visibility==='conversation'),one=new Set(conversations.map(row=>row.platform+'\0'+row.conversation_id)).size===1
      const visibility=secret?'secret':absolute||owner||!sources.length||conversations.length&&!one?'owner':conversations.length?'conversation':'public',origin=conversations[0]??sources[0]
      const platform=visibility==='conversation'?origin.platform:context.authority.platform??'harness',conversation_id=visibility==='conversation'?origin.conversation_id:''
      const event=this.store.appendJournalEvent({id,event_key,event_type:'mood',platform,conversation_id,direction:'internal',status:'recorded',visibility,text:reason,source_at:this._now(),source_type:'native_mood',metadata:{event_name:'mood.'+(absolute?'apply':'observe'),subjective:true,independently_verified:false,evidence_ids,observed_source_at:source_at,source_session_id:context.session_id,source_basis:sources.length?'existing_native_sources':absolute?'owner_setting':'trusted_current_turn_self_report',before_value:data.state.value,after_value:value,raw_delta,applied_delta:value-data.state.value,dimension_deltas:deltas,confidence,minor:!significant}})
      for(const evidence_id of evidence_ids)this.store.db.prepare("INSERT OR IGNORE INTO relations(id,subject_kind,subject_id,relation,object_kind,object_id,created_at,metadata_json) VALUES(?,'journal_event',?,'references','evidence',?,?,'{}')").run('relation:'+hash(id+'\0'+evidence_id),id,evidence_id,this._now())
      const state={...data.state,value,dimensions,reason,updated_at:this._now(),last_decay_at:this._now(),source_event_id:event.id,last_confidence:confidence,last_noted_value:value,minor:!significant,kind:absolute?'manual':'observation'}
      this.store.putDocument({id:this.document_id,type:'mood',expected_revision:data.doc?.revision??0,value:{...data.value,shared:true,state}})
      return {recorded:true,duplicate:false,id,status:'recorded',value,dimensions:{...dimensions},minor:!significant,changed:value!==data.state.value||Object.values(deltas).some(delta=>delta!==0)}
    })
  }
  observe(input,trusted_context={}){return this._write(input,trusted_context,false)}
  apply(input,trusted_context={}){return this._write(input,trusted_context,true)}
  acknowledgeNotice(input,trusted_context={}){
    this.store._write();fields(input,['source_event_id']);identifier(input.source_event_id);const context=auth(trusted_context)
    return this.store.transaction(()=>{const data=this._data(),notice=this._notice(data),source=this.store.getJournalEvent(input.source_event_id)
      if(notice.status!=='pending'||data.state.source_event_id!==input.source_event_id||!source||!visible(source,context.authority))return {acknowledged:false,status:notice.status}
      const event=this.store.appendJournalEvent({event_key:'mood-notice:'+source.id,event_type:'log',platform:context.authority.platform??'harness',conversation_id:context.authority.conversation_id??'',direction:'internal',status:'recorded',visibility:source.visibility==='public'?'public':'owner',text:'',source_at:this._now(),source_type:'native_mood',metadata:{event_name:'mood.notice_acknowledged',source_event_id:source.id}})
      const midnight=shanghaiTime(this._now()).midnight,state={...data.stored,injected_for:data.state.updated_at,last_injected_at:this._now(),last_injected_text:'',said_at:[...data.state.said_at.filter(at=>at>=midnight),this._now()].slice(-10000)}
      this.store.putDocument({id:this.document_id,type:'mood',expected_revision:data.doc.revision,value:{...data.value,state}});return {acknowledged:true,id:event.id}
    })
  }
  autoJudge(activity){
    if(!(activity instanceof NativeActivity)||activity.store!==this.store)throw new Error('自动心情评估只能进入同库NativeActivity')
    if(this.store.readOnly)return {queued:false,status:'read_only'}
    return this.store.transaction(()=>{
      const data=this._data(),policy=this.store.getDocument('activity')?.value??{enabled:false},now=this._now(),phase=valleyDecision(now,policy)
      if(!data.enabled||data.policy.auto_judge!==true||policy.enabled!==true)return {queued:false,status:'disabled'}
      if(!phase.valley||Number.isFinite(phase.nextPeakAt)&&now+(policy.batching?.min_valley_remaining_ms??120000)>=phase.nextPeakAt)return {queued:false,status:'peak'}
      const pending=this.store.db.prepare("SELECT id,status FROM actions WHERE kind='activity.maintenance' AND json_extract(target_json,'$.maintenance_kind')='mood' AND status IN ('queued','leased','running') LIMIT 1").get()
      if(pending)return {queued:false,status:'pending',task_id:pending.id}
      const day=shanghaiTime(now),id='quota:system:mood:wakes:'+day.date,quota=this.store.getDocument(id),cfg=policy.mood_judge??{},limit=cfg.max_per_day??3,last=Math.max(quota?.value.last_action_at??0,data.stored.updated_at??0)
      if((quota?.value.used??0)>=limit)return {queued:false,status:'daily_limit'}
      if(last&&now-last<(cfg.min_interval_minutes??240)*60000)return {queued:false,status:'cooldown'}
      const latest=this.store.db.prepare("SELECT id,platform,conversation_id,source_at FROM evidence WHERE direction='in' AND source_type='user' AND actor_uid<>'' AND actor_uid<>'self' AND source_at>? AND source_at<=? AND visibility<>'secret' AND json_extract(source_json,'$.pipeline')='trusted-human-inbound' ORDER BY source_at DESC,id DESC LIMIT 8").all(Math.max(data.stored.updated_at??0,last,now-86400000),now)
      if(!latest.length)return {queued:false,status:'no_new_interaction'}
      const newest=latest[0],platform=['qq','tieba','bilibili'].includes(newest.platform)?newest.platform:'qq',evidence_ids=latest.map(row=>row.id)
      const enqueued=activity.enqueue({platform,kind:'maintenance',trigger:'autonomous',idempotency_key:'mood:'+day.date+':'+hash(stringifyJson(evidence_ids)),target:{maintenance_kind:'mood',source_platform:newest.platform,conversation_id:newest.conversation_id,evidence_ids},human:false,heavy:true,estimated_tokens:cfg.reserve_tokens??5000})
      if(!enqueued.duplicate)this.store.putDocument({id,type:'quota',expected_revision:quota?.revision??0,value:{platform:'system',category:'mood',metric:'wakes',day:day.date,limit,used:(quota?.value.used??0)+1,reserved:0,last_action_at:now}})
      return {queued:!enqueued.duplicate,status:enqueued.duplicate?'duplicate':'queued',task_id:enqueued.task.id,evidence_count:evidence_ids.length,model_calls:0}
    })
  }
}
