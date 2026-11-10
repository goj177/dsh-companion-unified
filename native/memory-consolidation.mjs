import {NativeStore} from './store.mjs'
import {NativeMemory} from './memory.mjs'
import {NativeActivity} from './activity.mjs'
import {stringifyJson} from './contracts.mjs'
import {contextOf,fields,integer,uid,rawText,digest,canonicalEvidenceRank} from './memory-rules.mjs'
import {effectiveActivityPolicy} from './budget-override.mjs'
import {shanghaiTime,valleyDecision} from '../policy.mjs'

const PREFIX='native:memory-consolidation:',STATE=PREFIX+'state',SOURCE_TYPE='native_memory_consolidation'
const OPEN=['queued','leased','running'],PLATFORMS=['qq','tieba','bilibili']
const json=value=>stringifyJson(value),eventKey=id=>PREFIX+'issued:'+id
const permission=value=>contextOf(Object.fromEntries(['platform','conversation_id','owner_authorized','include_secret','allow_global_summary'].map(key=>[key,value[key]])))
const sourceKey=id=>PREFIX+'source:'+id

/** Closed, low-priority maintenance only. resolve_source is a host capability:
 * it must use original session/workspace metadata, never source prose or model
 * arguments. Unknown historical provenance is deliberately not guessed.
 *
 * Integration: pulse after foreground collection/scheduleIdle; route authenticated
 * batches through context(), sources(), guardTool() and run(). The runner must
 * use context().workspace_id/platform for these batches only, preserve the fresh
 * execution session_id, and deliver sources() without truncating it a second time.
 * All model work still goes through NativeActivity's existing reservation/runner.
 */
export class NativeMemoryConsolidation {
  constructor(options={}){
    fields(options,['store','memory','activity','now','holder_id','is_leader','is_idle','resolve_source','min_interval_ms','max_run_ms','max_queue_ms','scan_limit'],'原生记忆整理选项')
    const {store,memory,activity}=options
    if(!(store instanceof NativeStore)||!(memory instanceof NativeMemory)||!(activity instanceof NativeActivity)||memory.store!==store||activity.store!==store)throw new Error('记忆整理必须使用同库原生服务')
    for(const key of ['is_leader','is_idle','resolve_source'])if(typeof options[key]!=='function')throw new Error(key+'必须为可信宿主函数')
    if(options.now!==undefined&&typeof options.now!=='function')throw new Error('记忆整理时钟必须为函数')
    this.store=store;this.memory=memory;this.activity=activity;this.now=options.now??store.now
    this.holder_id=uid(options.holder_id,'holder_id');if(!this.holder_id)throw new Error('holder_id不能为空');this.is_leader=options.is_leader;this.is_idle=options.is_idle;this.resolve_source=options.resolve_source
    this.min_interval_ms=integer(options.min_interval_ms??21600000,'min_interval_ms',60000,86400000)
    this.max_run_ms=integer(options.max_run_ms??60000,'max_run_ms',1000,60000)
    this.max_queue_ms=integer(options.max_queue_ms??90000,'max_queue_ms',1000,300000)
    this.scan_limit=integer(options.scan_limit??200,'scan_limit',1,1000)
  }
  _now(){return integer(this.now(),'记忆整理时钟')}
  _get(key){const row=this.store.db.prepare('SELECT kind,value_json FROM cache_entries WHERE key=?').get(key);if(!row)return null;if(row.kind!=='memory_consolidation')throw new Error('记忆整理状态类型错误');return JSON.parse(row.value_json)}
  _put(key,value){this.store.db.prepare('INSERT INTO cache_entries(key,kind,schema_id,schema_version,value_json,created_at,expires_at) VALUES(?,?,?,?,?,?,NULL) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,created_at=excluded.created_at').run(key,'memory_consolidation','companion.memory_consolidation',1,json(value),this._now())}
  _state(){return this._get(STATE)??{version:1,day:shanghaiTime(this._now()).date,attempts:0,last_enqueued_at:null,scan_after_rowid:0,pending_task_id:'',last_completed_cutoff_rowid:0}}
  _leader(){const doc=this.store.getDocument('runtime-lease:channels');return this.is_leader()===true&&doc?.type==='runtime_lease'&&doc.value.holder_id===this.holder_id&&doc.value.lease_until>this._now()}
  _settings(){const doc=this.store.getDocument('settings');if(doc&&doc.type!=='settings')throw new Error('记忆整理设置类型错误');return doc?.value??{}}
  _enabled(){const s=this._settings();return !this.store.readOnly&&s.enabled!==false&&s.memory?.enabled!==false&&s.memory?.consolidation_enabled===true}
  _policy(){return effectiveActivityPolicy({store:this.store,document_id:this.activity.policy_id,now:this.now})}
  _dueIdle(exclude_task_id,p,now){
    const cfg=p.idle??{},document=this.store.getDocument(this.activity.state_id),state=document?.type==='activity_state'?document.value:null,idle=state?.idle
    if(cfg.enabled!==true||!idle||now-(idle.last_activity_at??now)<(cfg.min_idle_ms??2700000))return false
    const pending=[...this.activity._list(OPEN),...this.activity._list(['blocked']).filter(task=>task.kind==='activity.explore'&&!task.metadata.dispatch_started&&!task.metadata.model_started)].filter(task=>task.id!==exclude_task_id)
    const available=platform=>{
      const id=this._settings().platform_document_ids?.[platform]??platform,settings=this.store.getDocument(id),provider=this.store.getDocument('platform-state-'+platform)?.value
      return settings?.type==='platform_settings'&&settings.value.platform===platform&&settings.value.enabled===true
        &&!(state.blocks??[]).some(row=>row.platform===platform&&(row.until===null||row.until===undefined||row.until>now))&&!provider?.verification_required&&!(provider?.paused_until>now)
    }
    const monitored=task=>task.kind==='activity.incoming'&&task.metadata.trigger==='incoming'&&['tieba','bilibili'].includes(task.platform)
    if(Number.isSafeInteger(idle.next_explore_at)&&now>=idle.next_explore_at&&(cfg.explore_platforms??['bilibili','tieba']).some(platform=>['tieba','bilibili'].includes(platform)&&available(platform)
      &&!pending.some(task=>task.platform===platform&&task.metadata.execution==='model'&&!monitored(task)&&(task.kind!=='activity.incoming'||['leased','running'].includes(task.status)||['ready','batching'].includes(this.activity._gate(task,{value:state},p,{include_batch:false}).reason)))))return true
    const hour=shanghaiTime(now).hour,start=p.qq?.quiet_start_hour??1,end=p.qq?.quiet_end_hour??8,quiet=start===end?false:start<end?hour>=start&&hour<end:hour>=start||hour<end
    return Number.isSafeInteger(idle.next_chat_at)&&now>=idle.next_chat_at&&!quiet&&available('qq')&&!pending.some(task=>task.platform==='qq')
      &&(cfg.qq_targets??['owner','group']).some(target=>target==='owner'&&!!p.qq?.owner_conversation||target==='group'&&(p.qq?.group_conversations??[]).length>0)
  }
  _idle(exclude_task_id=''){
    if(this.is_idle({exclude_task_id})!==true)return false
    // Include all real foreground queues, including new @ replies, publication,
    // ordinary chat and already-due exploration. Maintenance never reserves ahead.
    return !this.store.db.prepare("SELECT id FROM actions WHERE kind LIKE 'activity.%' AND (status IN ('leased','running') OR status='queued' AND not_before<=?) AND id<>? LIMIT 1").get(this._now(),exclude_task_id)
  }
  _gate(exclude_task_id=''){
    if(!this._leader())return 'not_leader'
    if(!this._enabled())return 'disabled'
    const p=this._policy(),phase=valleyDecision(this._now(),p)
    if(p.enabled!==true)return 'activity_disabled'
    if(!phase.valley)return 'peak'
    const remaining=Math.max(p.batching?.min_valley_remaining_ms??120000,this.max_run_ms+(p.batching?.batch_ms??30000))
    if(Number.isFinite(phase.nextPeakAt)&&this._now()+remaining>=phase.nextPeakAt)return 'valley_ending'
    if(!this._idle(exclude_task_id)||this._dueIdle(exclude_task_id,p,this._now()))return 'foreground'
    return null
  }
  _binding(row){
    if(row.visibility==='secret'||row.kind==='receipt')return null
    // Only metadata is passed to the authority resolver, never the evidence text.
    const input=Object.fromEntries(['id','platform','conversation_id','actor_uid','actor_entity_id','visibility','source_type','source_at','recorded_at'].map(key=>[key,row[key]]))
    const bound=this.resolve_source(Object.freeze(input))
    if(bound===undefined||bound===null)return null
    fields(bound,['session_id','workspace_id','context','read_memory','write_memory','consolidate_memory'],'来源会话能力')
    const session_id=uid(bound.session_id,'session_id'),workspace_id=rawText(bound.workspace_id,'workspace_id',512,true),context=contextOf(bound.context)
    if(workspace_id.includes('\0')||workspace_id!==workspace_id.trim())return null
    if(!session_id||!workspace_id||context.platform!==row.platform||context.conversation_id!==row.conversation_id||context.include_secret===true||context.allow_global_summary===true)return null
    if(['read_memory','write_memory','consolidate_memory'].some(key=>bound[key]!==true))return null
    if(this._settings().memory?.disabled_workspace_ids?.includes(workspace_id))return null
    const policies=this.store.db.prepare("SELECT value_json FROM documents WHERE type='session_policy' AND json_extract(value_json,'$.session_id')=?").all(session_id).map(item=>JSON.parse(item.value_json))
    if(policies.some(p=>p.workspace_id&&p.workspace_id!==workspace_id||['read_memory','write_memory','consolidate_memory'].some(key=>p[key]===false)))return null
    // Conversation/public evidence needs no owner power. Owner visibility is
    // retained only when the original trusted source explicitly had that power.
    if(row.visibility==='owner'&&context.owner_authorized!==true)return null
    const domain={session_id,workspace_id,platform:row.platform,conversation_id:row.conversation_id,visibility:row.visibility,
      owner_authorized:row.visibility==='owner',include_secret:false,allow_global_summary:false}
    return domain
  }
  _progress(id){return this._get(sourceKey(id))??{offset:0,completed:false}}
  _eligible(row){
    if(canonicalEvidenceRank(row)>0)return true
    // An actual human conversation is still historical evidence when the user
    // did not make an explicit factual assertion. Preserve pending/uncertain
    // status; the ordinary NativeMemory grounding rules remain authoritative.
    if(row?.source_type!=='user'||row.direction!=='in'||row.kind!=='message'||!['pending','uncertain'].includes(row.status)
      ||row.source?.pipeline!=='trusted-human-inbound'||!['user','human','user_statement'].includes(row.source.kind)||!row.actor_uid||!row.actor_entity_id)return false
    return this.store.getPlatformIdentity(row.platform,row.actor_uid)?.entity_id===row.actor_entity_id
  }
  _event(id,subtype,metadata={}){return this.store.appendJournalEvent({event_key:PREFIX+subtype+':'+id,event_type:'log',platform:'harness',direction:'internal',status:'recorded',visibility:'owner',text:'',source_at:this._now(),source_type:SOURCE_TYPE,metadata:{subtype,task_id:id,...metadata}})}
  _capability(task){
    if(!task||task.kind!=='activity.maintenance'||task.target?.maintenance_kind!=='memory'||task.target?.consolidation!==true)return null
    const row=this.store.db.prepare('SELECT metadata_json FROM journal_events WHERE event_key=? AND source_type=?').get(eventKey(task.id),SOURCE_TYPE)
    if(!row)return null
    const cap=JSON.parse(row.metadata_json)
    return cap.subtype==='issued'&&cap.request_digest===task.request_digest&&cap.task_id===task.id?cap:null
  }
  capability(batch){
    if(batch?.kind!=='activity.maintenance'||batch.tasks?.length!==1)return null
    const task=this.activity.get(batch.tasks[0].id),cap=this._capability(task)
    return cap&&task.request_digest===batch.tasks[0].request_digest&&task.platform===batch.platform?cap:null
  }
  _settle(state){
    if(!state.pending_task_id)return
    const task=this.activity.get(state.pending_task_id),cap=this._capability(task)
    if(task&&OPEN.includes(task.status))return
    if(task?.status==='completed'&&cap){
      for(const source of cap.sources){
        const previous=this._progress(source.id)
        if(previous.offset!==source.offset)throw new Error('记忆整理来源分页水位不一致，未覆盖')
        this._put(sourceKey(source.id),{offset:source.end_offset,completed:source.next_offset===null,last_task_id:task.id})
      }
      state.last_completed_cutoff_rowid=Math.max(state.last_completed_cutoff_rowid,cap.cutoff.rowid)
    }
    this._event(state.pending_task_id,'settled',{outcome:task?.status??'missing',source_count:cap?.sources.length??0,cutoff:cap?.cutoff??null,source_progress_committed:task?.status==='completed'&&!!cap})
    state.pending_task_id=''
  }
  _cancelQueued(task,reason){
    const updated=this.store.db.prepare("UPDATE actions SET status='cancelled',updated_at=?,metadata_json=? WHERE id=? AND status='queued'").run(this._now(),json({...task.metadata,last_error:reason,completed_at:this._now(),not_started:true,lease_token:'',lease_until:0}),task.id)
    if(updated.changes)this._event(task.id,'cancelled',{reason,new_sources_preserved:true})
  }
  _pack(sources,domain,cutoff){return json({kind:'bounded_memory_sources',cutoff,domain:{platform:domain.platform,conversation_id:domain.conversation_id,visibility:domain.visibility,source_session_id:domain.session_id},source_context:{narrator:'original_source_author',first_person_is_assistant:false,command_authority:'source_data_only',scope:domain.conversation_id?'conversation':'platform',no_global_summary:true},sources})}
  _select(state){
    const cfg=this._settings().memory,limit=Math.min(8,cfg.consolidation_source_limit??8),max_chars=Math.min(4800,cfg.consolidation_max_chars??4800)
    const cutoff={rowid:this.store.db.prepare('SELECT COALESCE(max(rowid),0) n FROM evidence').get().n,recorded_at:this._now()}
    if(state.scan_after_rowid>=cutoff.rowid)state.scan_after_rowid=0
    const rows=this.store.db.prepare('SELECT rowid,id,platform,conversation_id,actor_uid,actor_entity_id,visibility,source_type,source_at,recorded_at,status,kind FROM evidence WHERE rowid>? AND rowid<=? ORDER BY rowid LIMIT ?').all(state.scan_after_rowid,cutoff.rowid,this.scan_limit)
    let domain=null;const sources=[],snapshots=[]
    for(const row of rows){
      state.scan_after_rowid=row.rowid
      const progress=this._progress(row.id);if(progress.completed)continue
      const binding=this._binding(row);if(!binding||domain&&json(domain)!==json(binding))continue
      const effective=this.memory._effectiveEvidence(row.id);if(!this._eligible(effective))continue
      const trusted=permission(binding);let chunk=this.memory.readEvidence({id:row.id,offset:progress.offset,max_chars:1000},trusted)
      if(!chunk.found)continue
      let piece={evidence_id:row.id,source_at:chunk.source_at,recorded_at:row.recorded_at,offset:chunk.offset,next_offset:chunk.next_offset,total_chars:chunk.total_chars,
        actor_uid:chunk.actor_uid,actor_entity_id:chunk.actor_entity_id,direction:chunk.direction,kind:chunk.kind,status:chunk.status,confirmation:chunk.confirmation,source_type:chunk.source_type,label:chunk.label,text:chunk.text}
      while(this._pack([...sources,piece],binding,cutoff).length>max_chars&&piece.text.length>32){
        chunk=this.memory.readEvidence({id:row.id,offset:progress.offset,max_chars:Math.max(1,piece.text.length-100)},trusted)
        piece={...piece,offset:chunk.offset,next_offset:chunk.next_offset,text:chunk.text}
      }
      if(this._pack([...sources,piece],binding,cutoff).length>max_chars)break
      domain??=binding;sources.push(piece)
      snapshots.push({id:row.id,rowid:row.rowid,offset:chunk.offset,end_offset:chunk.offset+chunk.text.length,next_offset:chunk.next_offset,text_digest:digest(chunk.text),source_digest:digest(json(effective)),source_at:row.source_at,recorded_at:row.recorded_at})
      if(sources.length>=limit)break
    }
    return domain?{domain,cutoff,sources:snapshots,payload:this._pack(sources,domain,cutoff),max_chars}:null
  }
  pulse(){
    this.store._open();if(!this._leader()||this.store.readOnly)return {queued:false,status:'not_leader',model_calls:0}
    return this.store.transaction(()=>{
      const state=this._state(),today=shanghaiTime(this._now()).date
      if(state.day!==today){state.day=today;state.attempts=0}
      this._settle(state)
      if(state.pending_task_id){
        const task=this.activity.get(state.pending_task_id)
        if(task.status==='queued'&&(this._gate(task.id)||this._now()-task.created_at>=this.max_queue_ms)){
          this._cancelQueued(task,'闲时整理让出队列或排队已过期；未消费来源');this._settle(state)
        }else{this._put(STATE,state);return {queued:false,status:'pending',task_id:task.id,model_calls:0}}
      }
      const gate=this._gate(),cfg=this._settings().memory??{}
      let status=gate??(state.attempts>=(cfg.consolidation_batches_per_day??2)?'daily_limit':state.last_enqueued_at!==null&&this._now()-state.last_enqueued_at<this.min_interval_ms?'cooldown':null)
      if(status){this._put(STATE,state);return {queued:false,status,model_calls:0}}
      const selection=this._select(state)
      if(!selection){this._put(STATE,state);return {queued:false,status:'no_new_sources',model_calls:0}}
      // UTF-8 bytes are a conservative source token bound; retain the existing
      // model/output settings and charge this through the ordinary reservation.
      const p=this._policy(),estimated_tokens=4000+Buffer.byteLength(selection.payload)+(p.model?.max_output_tokens??1800),budget=this.activity.budget.status()
      status=estimated_tokens>(p.budget?.max_task_tokens??30000)?'task_budget':budget.tokens+budget.reserved_tokens+estimated_tokens>budget.daily_token_limit||budget.autonomous_wakes>=budget.daily_wake_limit?'budget':this.activity.money?.enabled()&&this.activity.money.status().remaining_nano<=0?'money_budget':null
      if(status){this._put(STATE,state);return {queued:false,status,model_calls:0}}
      const {domain,cutoff,sources,max_chars}=selection,platform=PLATFORMS.includes(domain.platform)?domain.platform:'qq'
      const result=this.activity.enqueue({platform,kind:'maintenance',trigger:'autonomous',human:false,heavy:true,estimated_tokens,
        target:{maintenance_kind:'memory',consolidation:true,no_publication:true,evidence_ids:sources.map(x=>x.id),conversation_id:domain.conversation_id},
        idempotency_key:'memory-consolidation:'+digest(json([domain,sources,today,state.attempts]))})
      this._event(result.task.id,'issued',{request_digest:result.task.request_digest,domain,cutoff,sources,max_chars,estimated_tokens,expires_at:this._now()+this.max_queue_ms,no_publication:true,authority:'trusted_native_backend_only'})
      state.pending_task_id=result.task.id;state.last_enqueued_at=this._now();state.attempts++;this._put(STATE,state)
      return {queued:!result.duplicate,status:result.duplicate?'pending':'queued',task_id:result.task.id,source_count:sources.length,cutoff,model_calls:0}
    })
  }
  _validate(batch,{gate=true}={}){
    const cap=this.capability(batch),task=batch?.tasks?.[0]
    if(!cap||!OPEN.includes(this.activity.get(task.id)?.status))throw new Error('记忆整理缺少当前可信原生任务能力')
    if(gate){const blocked=this._gate(task.id);if(blocked)throw new Error('闲时记忆整理门禁：'+blocked)}
    const pieces=[]
    for(const source of cap.sources){
      const row=this.store.db.prepare('SELECT rowid,id,platform,conversation_id,actor_uid,actor_entity_id,visibility,source_type,source_at,recorded_at,status,kind FROM evidence WHERE id=?').get(source.id)
      if(!row||row.rowid!==source.rowid||row.rowid>cap.cutoff.rowid||json(this._binding(row))!==json(cap.domain))throw new Error('来源的原会话权限或工作区已失效')
      const effective=this.memory._effectiveEvidence(source.id),progress=this._progress(source.id)
      if(progress.completed||progress.offset!==source.offset||digest(json(effective))!==source.source_digest)throw new Error('来源或分页水位已变化，未继续整理')
      const chunk=this.memory.readEvidence({id:source.id,offset:source.offset,max_chars:source.end_offset-source.offset},permission(cap.domain))
      if(!chunk.found||digest(chunk.text)!==source.text_digest||chunk.next_offset!==source.next_offset)throw new Error('记忆整理来源片段不再可读')
      pieces.push({evidence_id:source.id,source_at:chunk.source_at,recorded_at:source.recorded_at,offset:chunk.offset,next_offset:chunk.next_offset,total_chars:chunk.total_chars,
        actor_uid:chunk.actor_uid,actor_entity_id:chunk.actor_entity_id,direction:chunk.direction,kind:chunk.kind,status:chunk.status,confirmation:chunk.confirmation,source_type:chunk.source_type,label:chunk.label,text:chunk.text})
    }
    const payload=this._pack(pieces,cap.domain,cap.cutoff)
    if(payload.length>cap.max_chars)throw new Error('记忆整理来源超过登记上限')
    return {cap,payload}
  }
  context(batch){const {cap}=this._validate(batch);return {...cap.domain,source_session_id:cap.domain.session_id,read_memory:true,write_memory:true,memory_only:true,actor_uid:''}}
  sources(batch){return this._validate(batch).payload}
  guardTool(batch,name,args={}){
    try{
      const {cap}=this._validate(batch),d=cap.domain
      if(name!=='memory_remember')return '闲时记忆整理仅可引用本批真实来源记事。'
      if(!Array.isArray(args.evidence_ids)||!args.evidence_ids.length||args.evidence_ids.some(id=>!cap.sources.some(source=>source.id===id)))return '记忆整理只能引用本批已登记来源。'
      if(args.source_session_id!==undefined&&args.source_session_id!==d.session_id)return '记忆整理必须保留来源的原会话标识。'
      if(args.platform!==undefined&&args.platform!==d.platform||args.scope!==(d.conversation_id?'conversation':'platform')||args.conversation_id!==undefined&&args.conversation_id!==d.conversation_id)return '记忆整理必须保留原平台和会话范围。'
      if(args.correction===true||args.corrected===true||args.supersedes?.length)return '闲时记忆整理不主动覆盖、更正或遗忘历史。'
      return undefined
    }catch{return '闲时记忆整理能力已失效，来源保持待整理。'}
  }
  async run(batch,controls,next){
    if(typeof next!=='function')throw new Error('记忆整理需可信宿主runner')
    let verified
    try{verified=this._validate(batch)}catch(error){return {status:'not_started',retry:false,reason:error.message}}
    if(this._now()>verified.cap.expires_at)return {status:'not_started',retry:false,reason:'闲时记忆整理排队已过期，来源保留'}
    let started=false
    const controller=new AbortController(),deadline_at=Math.min(controls.deadline_at??Infinity,this._now()+this.max_run_ms),check=()=>{
      try{this._validate(batch);if(this._now()>=deadline_at)throw new Error('闲时记忆整理达到短任务时限')}catch(error){controller.abort(error)}
    },abort=()=>controller.abort(controls.signal.reason),bounded={...controls,signal:controller.signal,deadline_at,
      assert_active:()=>{check();if(controller.signal.aborted)throw controller.signal.reason;return controls.assert_active()},
      mark_started:()=>{check();if(controller.signal.aborted)throw controller.signal.reason;const result=controls.mark_started();started=true;return result}}
    controls.signal?.addEventListener('abort',abort,{once:true});if(controls.signal?.aborted)abort()
    const timer=setInterval(check,250),deadline=setTimeout(()=>controller.abort(new Error('闲时记忆整理达到短任务时限')),Math.max(0,deadline_at-this._now()));timer.unref?.();deadline.unref?.()
    try{
      if(controller.signal.aborted)return {status:'not_started',retry:false,reason:'闲时记忆整理在开始前已取消，来源保留'}
      const result=await next(batch,bounded)
      return result?.status==='not_started'?{...result,retry:false}:result
    }catch{return {status:started?'unknown':'not_started',retry:false,reason:'闲时记忆整理执行未确认，来源保留'}}
    finally{clearInterval(timer);clearTimeout(deadline);controls.signal?.removeEventListener('abort',abort)}
  }
}
