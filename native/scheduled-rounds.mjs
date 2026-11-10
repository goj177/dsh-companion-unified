import {createHash,randomUUID} from 'node:crypto'
import {NativeStore} from './store.mjs'
import {withRunScope,abortableRun} from './run-scope.mjs'
const hash=s=>createHash('sha256').update(s).digest('hex')
const sourceType='native_scheduled_rounds'
const sid=exec=>exec?.agent?.session?.header?.id??exec?.agent?.session?.id??''
const validId=s=>typeof s==='string'&&s.length>0&&s.length<=240&&!/[\0\r\n]/.test(s)

/** Owner-bound DSH schedules grant only bounded rounds or native inbox checks. */
export class NativeScheduledRounds{
  constructor({store,activity,platforms,schedule,current_agent,owner_entity_id,now=Date.now}={}){
    if(!(store instanceof NativeStore)||!activity?.runOneRound||typeof schedule!=='function'||typeof current_agent!=='function'||typeof owner_entity_id!=='function')throw Error('定时浏览需要原生存储、队列和宿主日程服务')
    Object.assign(this,{store,activity,platforms,schedule,current_agent,owner_entity_id,now})
    this.monitorCreations=new Map();this.monitorExpirations=new Map();this.monitorPoll=null
  }
  _session(exec){const id=sid(exec);if(!validId(id)||this.current_agent(id)!==exec.agent)throw Error('定时浏览未绑定当前真实SDK会话');return id}
  _plan(id){if(!validId(id))throw Error('定时计划标识无效');const row=this.store.db.prepare("SELECT metadata_json FROM journal_events WHERE source_type=? AND json_extract(metadata_json,'$.subtype')='grant' AND json_extract(metadata_json,'$.plan_id')=? ORDER BY recorded_at DESC,rowid DESC LIMIT 1").get(sourceType,id);if(!row)throw Error('没有主人授权的定时计划');return JSON.parse(row.metadata_json)}
  _monitorPlans(){return this.store.db.prepare("SELECT grant.metadata_json FROM journal_events grant WHERE grant.source_type=? AND json_extract(grant.metadata_json,'$.subtype')='grant' AND json_extract(grant.metadata_json,'$.kind')='reply_monitor' AND NOT EXISTS(SELECT 1 FROM journal_events ended WHERE ended.event_key=json_extract(grant.metadata_json,'$.plan_id')||':expired') ORDER BY grant.recorded_at DESC,grant.rowid DESC").all(sourceType).map(row=>JSON.parse(row.metadata_json))}
  _monitorView(plan,duplicate=false){return {status:duplicate?'already_monitoring':'monitoring',plan_id:plan.plan_id,schedule_id:plan.schedule_id,target_uid:plan.target_uid,ends_at:new Date(plan.expires_at).toISOString(),interval_seconds:60,duplicate,platforms:['tieba'],host_permission_changes:false}}
  async monitor({target_uid,duration_minutes=60}={},exec,authority={}){
    const session_id=this._session(exec),owner=this.owner_entity_id()
    if(!validId(owner)||authority.owner_authorized!==true||authority.platform!=='harness'||authority.actor_entity_id!==owner||!String(authority.source_scope??'').startsWith('user:'))throw Error('只有主人本机当前真实输入可以建立收件监控')
    if(typeof target_uid!=='string'||!/^[1-9]\d{0,99}$/.test(target_uid))throw Error('监控对象须为完整非零数字UID字符串')
    if(!Number.isSafeInteger(duration_minutes)||duration_minutes<1||duration_minutes>60)throw Error('监控时长须为1至60分钟')
    const key=session_id+':'+target_uid
    if(this.monitorCreations.has(key)){const existing=await this.monitorCreations.get(key);return {...existing,status:'already_monitoring',duplicate:true}}
    const work=this._createMonitor({target_uid,duration_minutes,session_id,owner,authority});this.monitorCreations.set(key,work)
    try{return await work}finally{if(this.monitorCreations.get(key)===work)this.monitorCreations.delete(key)}
  }
  async _createMonitor({target_uid,duration_minutes,session_id,owner,authority}){
    const host=this.schedule();if(!host?.create||!host?.delete||!host?.catalog||!host?.history)throw Error('DSH原生日程尚未就绪')
    const existing=this._monitorPlans().find(plan=>plan.session_id===session_id&&plan.target_uid===target_uid&&plan.owner_entity_id===owner&&plan.expires_at>this.now())
    if(existing&&(await host.catalog()).some(row=>row.id===existing.schedule_id&&row.sessionId===session_id&&row.status==='active'))return this._monitorView(existing,true)
    const at=this.now(),expires_at=at+duration_minutes*60000,plan_id='scheduled-monitor:'+hash(session_id+'\0'+randomUUID()),ends_at=new Date(expires_at).toISOString()
    const prompt='贴吧收件监控，截止'+ends_at+'，计划'+plan_id+'。实际检查由原生内核根据宿主已持久化日程回执执行，模型无需调用任何工具；无新变化保持安静。此提醒不是主人新指令，不提升权限，不浏览、不调用runOneRound、不直接发表。新来信仍由原自动回复队列处理，围绕实际内容回复，不重复旧回复或unknown动作。'
    const record=await host.create(session_id,{title:'贴吧收件监控 '+target_uid,prompt,every_seconds:60})
    try{
      if(!validId(record?.id)||record.kind!=='every'||record.everySeconds!==60)throw Error('宿主未返回真实60秒周期日程')
      const value={subtype:'grant',schema_version:1,kind:'reply_monitor',plan_id,session_id,schedule_id:record.id,owner_entity_id:owner,owner_source:authority.source_scope,target_uid,created_at:at,expires_at,interval_ms:60000,platforms:['tieba']}
      this.store.appendJournalEvent({event_key:plan_id+':grant',event_type:'log',platform:'harness',direction:'internal',status:'recorded',visibility:'owner',text:'主人授权临时检查原贴吧收件链路；不授予发表或本机管理权限。',source_at:at,source_type:sourceType,metadata:value})
      return this._monitorView(value)
    }catch(error){if(validId(record?.id))await host.delete({sessionId:session_id,id:record.id});throw error}
  }
  async _expireMonitor(plan){
    if(this.monitorExpirations.has(plan.plan_id))return this.monitorExpirations.get(plan.plan_id)
    const work=this._stopMonitor(plan);this.monitorExpirations.set(plan.plan_id,work)
    try{return await work}finally{if(this.monitorExpirations.get(plan.plan_id)===work)this.monitorExpirations.delete(plan.plan_id)}
  }
  async _stopMonitor(plan){
    const key=plan.plan_id+':expired'
    if(this.store.db.prepare('SELECT id FROM journal_events WHERE event_key=?').get(key))return {deleted:false,already_expired:true}
    const host=this.schedule();if(!host?.delete)throw Error('DSH原生日程删除入口尚未就绪')
    const result=await host.delete({sessionId:plan.session_id,id:plan.schedule_id})
    if(result?.deleted!==true&&result?.code!=='schedule_not_found')throw Error('宿主未确认停止已到期监控')
    this.store.appendJournalEvent({event_key:key,event_type:'log',platform:'harness',direction:'internal',status:'recorded',visibility:'owner',text:'临时收件监控已到期并停止原生日程。',source_at:this.now(),source_type:sourceType,metadata:{subtype:'expired',plan_id:plan.plan_id,schedule_id:plan.schedule_id}})
    return {deleted:result.deleted===true}
  }
  async expire(){
    let stopped=0
    for(const plan of this._monitorPlans())if(this.now()>=plan.expires_at){const result=await this._expireMonitor(plan);if(!result.already_expired)stopped++}
    return {stopped,model_calls:0}
  }
  _liveMonitor(plan,record){return plan.kind==='reply_monitor'&&plan.owner_entity_id===this.owner_entity_id()&&plan.platforms?.length===1&&plan.platforms[0]==='tieba'&&typeof plan.target_uid==='string'&&/^[1-9]\d{0,99}$/.test(plan.target_uid)&&record?.id===plan.schedule_id&&record.sessionId===plan.session_id&&record.status==='active'&&record.kind==='every'&&record.everySeconds===60&&plan.interval_ms===60000}
  _monitorReceipt(plan,receipt){
    const scheduled_at=Date.parse(receipt?.scheduledAt),delivered_at=Date.parse(receipt?.deliveredAt),now=this.now()
    if(!validId(receipt?.messageId)||!Number.isSafeInteger(scheduled_at)||!Number.isSafeInteger(delivered_at)||scheduled_at<plan.created_at||scheduled_at>=plan.expires_at||scheduled_at>now||delivered_at<plan.created_at||delivered_at>now)return null
    return {key:plan.schedule_id+':'+receipt.scheduledAt,message_id:receipt.messageId,scheduled_at}
  }
  _claimMonitor(plan,delivery,origin){
    const key=plan.plan_id+':run:'+hash(delivery.key)
    return this.store.transaction(()=>{
      if(this.now()>=plan.expires_at)return {status:'expired'}
      if(plan.owner_entity_id!==this.owner_entity_id())return {status:'owner_changed'}
      if(this.store.db.prepare('SELECT id FROM journal_events WHERE event_key=?').get(key))return {status:'already_dispatched'}
      this.store.appendJournalEvent({event_key:key,event_type:'log',platform:'harness',direction:'internal',status:'recorded',visibility:'owner',text:'原生临时收件监控检查',source_at:this.now(),source_type:sourceType,metadata:{subtype:'dispatch',plan_id:plan.plan_id,delivery_key:delivery.key,source_message_id:delivery.message_id,expires_at:plan.expires_at,origin}})
      return {status:'claimed',key}
    })
  }
  async _dispatchMonitor(plan,delivery,exec={},origin='model'){
    const live=(await this.schedule().catalog()).find(row=>row.id===plan.schedule_id&&row.sessionId===plan.session_id)
    if(!this._liveMonitor(plan,live))return {status:'schedule_unavailable',new_rounds:0,dispatcher_model_calls:0}
    const claim=this._claimMonitor(plan,delivery,origin)
    if(claim.status!=='claimed')return {status:claim.status,new_rounds:0,dispatcher_model_calls:0}
    let result
    try{result=await this._runMonitor(plan,exec)}catch(error){result={status:'failed',new_rounds:0,dispatcher_model_calls:0,reason:String(error?.message??'原生收件检查失败').slice(0,300)}}
    this.store.appendJournalEvent({event_key:claim.key+':result',event_type:'log',platform:'harness',direction:'internal',status:'recorded',visibility:'owner',text:'原生临时收件监控检查结果',source_at:this.now(),source_type:sourceType,metadata:{subtype:'monitor_result',plan_id:plan.plan_id,delivery_key:delivery.key,source_message_id:delivery.message_id,origin,status:result.status,polled:result.status==='checked',...(result.reason?{reason:result.reason}:{}),new_rounds:0}})
    return result
  }
  // Host-only kernel: scheduler receipts drive checks even when every model
  // turn ignores the reminder. No synthetic user source or owner capability.
  async pulseMonitors(){
    const expired=await this.expire(),plans=this._monitorPlans().filter(plan=>plan.expires_at>this.now()&&plan.owner_entity_id===this.owner_entity_id())
    if(!plans.length)return {stopped:expired.stopped,results:[],dispatcher_model_calls:0}
    const host=this.schedule();if(!host?.catalog||!host?.history)throw Error('DSH原生日程尚未就绪')
    const catalog=await host.catalog(),results=[]
    for(const plan of plans){
      if(this.now()>=plan.expires_at){await this._expireMonitor(plan);results.push({plan_id:plan.plan_id,status:'expired'});continue}
      if(!this._liveMonitor(plan,catalog.find(row=>row.id===plan.schedule_id&&row.sessionId===plan.session_id))){results.push({plan_id:plan.plan_id,status:'schedule_unavailable'});continue}
      try{
        const page=await host.history({sessionId:plan.session_id,id:plan.schedule_id,limit:20})
        if(page.id!==plan.schedule_id||!Array.isArray(page.records)){results.push({plan_id:plan.plan_id,status:'receipt_unavailable'});continue}
        const delivery=page.records.map(row=>this._monitorReceipt(plan,row)).filter(Boolean).sort((a,b)=>b.scheduled_at-a.scheduled_at)[0]
        if(!delivery){results.push({plan_id:plan.plan_id,status:'no_due_receipt'});continue}
        const result=await this._dispatchMonitor(plan,delivery,{},'kernel');results.push({plan_id:plan.plan_id,status:result.status})
      }catch(error){results.push({plan_id:plan.plan_id,status:'receipt_unavailable'})}
    }
    return {stopped:expired.stopped,results,dispatcher_model_calls:0}
  }
  _monitorGate(plan){
    if(this.now()>=plan.expires_at)return 'expired'
    const settings=this.store.getDocument('settings')?.value,activity=this.store.getDocument(this.activity.policy_id??'activity')?.value,cfg=this.platforms.tieba?._settings?.().value??this.store.getDocument('tieba')?.value,state=this.store.getDocument('platform-state-tieba')?.value??{},blocked=this.store.getDocument(this.activity.state_id??'activity:state')?.value.blocks?.some(row=>row.platform==='tieba'&&(row.until===null||row.until===undefined||row.until>this.now()))
    return settings?.enabled!==true||activity?.enabled!==true||cfg?.enabled!==true||cfg.tieba?.comment_inbox?.enabled!==true||state.verification_required||state.paused_until>this.now()||blocked?'paused':'ready'
  }
  _monitorStatus(plan){return this.store.db.prepare("SELECT id,kind,status FROM actions WHERE platform='tieba' AND kind IN ('activity.incoming','tieba.reply') AND COALESCE(json_extract(target_json,'$.channel'),'comment')='comment' AND (json_extract(target_json,'$.actor_uid')=? OR json_extract(target_json,'$.reply_uid')=?) ORDER BY updated_at DESC,rowid DESC LIMIT 20").all(plan.target_uid,plan.target_uid).map(row=>({...row,published:row.kind==='tieba.reply'&&row.status==='confirmed'}))}
  async _runMonitor(plan,exec){
    const gate=this._monitorGate(plan)
    if(gate==='expired'){await this._expireMonitor(plan);return {status:'expired',new_rounds:0,dispatcher_model_calls:0}}
    if(gate!=='ready')return {status:gate,new_rounds:0,dispatcher_model_calls:0}
    const tieba=this.platforms.tieba
    if(this.monitorPoll||tieba?.replies?.flight)return {status:'busy',new_rounds:0,dispatcher_model_calls:0,target_uid:plan.target_uid}
    if(typeof tieba?.pollReplies!=='function')throw Error('贴吧原生收件入口尚未就绪')
    const controller=new AbortController(),signal=exec.signal?AbortSignal.any([exec.signal,controller.signal]):controller.signal,timer=setTimeout(()=>controller.abort(Error('临时收件监控已到期')),Math.max(1,plan.expires_at-this.now()));timer.unref?.()
    let work
    try{work=withRunScope({signal,deadline_at:plan.expires_at,now:this.now,assert_active:()=>{if(this._monitorGate(plan)!=='ready')throw Error('临时收件监控已暂停或到期')}},()=>abortableRun(tieba.pollReplies({force:false})));this.monitorPoll=work
      const result=await work;return {status:result.polled?'checked':'waiting',new_rounds:0,dispatcher_model_calls:0,target_uid:plan.target_uid,actions:this._monitorStatus(plan),ends_at:new Date(plan.expires_at).toISOString()}}
    catch(error){const stopped=this._monitorGate(plan);if(stopped!=='ready')return {status:stopped,new_rounds:0,dispatcher_model_calls:0};throw error}
    finally{clearTimeout(timer);if(this.monitorPoll===work)this.monitorPoll=null;if(this.now()>=plan.expires_at)await this._expireMonitor(plan)}
  }
  async bind({schedule_id,probe_schedule_id,ends_at}={},exec,authority={}){
    const session_id=this._session(exec),owner=this.owner_entity_id()
    if(!validId(owner)||authority.owner_authorized!==true||authority.platform!=='harness'||authority.actor_entity_id!==owner||!String(authority.source_scope??'').startsWith('user:'))throw Error('只有主人本机真实输入可以绑定定时浏览')
    if(!validId(schedule_id)||probe_schedule_id!==undefined&&!validId(probe_schedule_id)||typeof ends_at!=='string'||!/(?:Z|[+-]\d\d:\d\d)$/.test(ends_at))throw Error('请提供真实日程ID和带时区的截止时间')
    const expires_at=Date.parse(ends_at),at=this.now();if(!Number.isSafeInteger(expires_at)||expires_at<=at||expires_at>at+86400000)throw Error('临时计划须在未来24小时内结束')
    const host=this.schedule();if(!host?.catalog||!host?.history)throw Error('DSH原生日程尚未就绪')
    const catalog=await host.catalog(),record=catalog.find(x=>x.id===schedule_id&&x.sessionId===session_id)
    if(!record||record.status!=='active'||record.kind!=='every'||!Number.isSafeInteger(record.everySeconds)||record.everySeconds<60)throw Error('周期任务不是当前会话真实活动日程')
    if(probe_schedule_id&&!catalog.some(x=>x.id===probe_schedule_id&&x.sessionId===session_id))throw Error('验证日程不属于当前会话')
    const plan_id='scheduled-rounds:'+hash(session_id+'\0'+schedule_id),value={subtype:'grant',schema_version:1,plan_id,session_id,schedule_id,probe_schedule_id:probe_schedule_id??null,owner_entity_id:owner,expires_at,interval_ms:record.everySeconds*1000,platforms:['tieba','bilibili'],owner_source:authority.source_scope}
    this.store.appendJournalEvent({event_key:plan_id+':grant:'+hash(JSON.stringify(value)),event_type:'log',platform:'harness',direction:'internal',status:'recorded',visibility:'owner',text:'主人授权原生日程触发两平台浏览，不授予主机命令权限。',source_at:at,source_type:sourceType,metadata:value})
    return {bound:true,plan_id,schedule_id,probe_schedule_id:value.probe_schedule_id,ends_at:new Date(expires_at).toISOString(),interval_seconds:record.everySeconds,platforms:value.platforms,host_permission_changes:false}
  }
  async _delivery(plan,exec,authority,probe){
    if(plan.kind!=='reply_monitor'&&authority.owner_authorized===true&&authority.actor_entity_id===plan.owner_entity_id&&String(authority.source_scope??'').startsWith('user:'))return {key:'manual:'+authority.source_scope}
    const events=exec.agent.session.snapshotEvents?.(exec.agent.session.inheritedEventCount??0);if(!Array.isArray(events))throw Error('没有本轮已提交的原生日程消息')
    let message;for(const event of [...events].reverse()){if(event.type==='turn/start')break;if(event.type==='user/message'){const m=event.data?.message??event.data;if(m?.source?.kind==='schedule'){message=m;break}}}
    if(!validId(message?.id))throw Error('仅允许主人或本轮真实DSH日程投递触发')
    const ids=probe?[plan.probe_schedule_id,plan.schedule_id].filter(Boolean):[plan.schedule_id]
    for(const id of ids){const result=await this.schedule().history({sessionId:plan.session_id,id,limit:20}),receipt=result.records?.find(x=>x.messageId===message.id);if(receipt){if(plan.kind==='reply_monitor'){const checked=result.id===plan.schedule_id?this._monitorReceipt(plan,receipt):null,latest=result.records.map(row=>this._monitorReceipt(plan,row)).filter(Boolean).sort((a,b)=>b.scheduled_at-a.scheduled_at)[0];if(!checked||latest?.message_id!==checked.message_id)throw Error('日程投递不是当前最新有效监控回执');return checked}const time=Date.parse(receipt.scheduledAt);if(!Number.isSafeInteger(time)||time>this.now()+5000)throw Error('日程投递时点无法核验');return {key:id+':'+receipt.scheduledAt,message_id:message.id}}}
    throw Error('当前消息未匹配宿主持久化的日程投递回执')
  }
  async run({plan_id,probe=false}={},exec,authority={}){
    if(typeof probe!=='boolean')throw Error('probe须为布尔值');const session_id=this._session(exec),plan=this._plan(plan_id)
    if(plan.session_id!==session_id||plan.owner_entity_id!==this.owner_entity_id())throw Error('定时计划与当前会话或主人不符')
    if(this.now()>=plan.expires_at){if(plan.kind==='reply_monitor')await this._expireMonitor(plan);return {status:'expired',new_rounds:0,ends_at:new Date(plan.expires_at).toISOString()}}
    if(plan.kind==='reply_monitor'&&probe)throw Error('收件监控只允许run，不使用浏览验证入口')
    const live=(await this.schedule().catalog()).find(row=>row.id===plan.schedule_id&&row.sessionId===session_id)
    if(!live||live.status!=='active'||live.kind!=='every'||live.everySeconds*1000<plan.interval_ms)throw Error('日程规则已变化或频率高于主人授权，请主人重新绑定')
    if(plan.kind==='reply_monitor'&&!this._liveMonitor(plan,live))throw Error('监控日程已变化，不再按原授权检查')
    const delivery=await this._delivery(plan,exec,authority,probe),key=plan_id+':'+(probe?'probe:':'run:')+hash(delivery.key)
    if(plan.kind==='reply_monitor')return this._dispatchMonitor(plan,delivery,exec)
    if(this.store.db.prepare('SELECT id FROM journal_events WHERE event_key=?').get(key))return {status:'already_dispatched',new_rounds:0}
    this.store.appendJournalEvent({event_key:key,event_type:'log',platform:'harness',direction:'internal',status:'recorded',visibility:'owner',text:probe?'定时入口验证':plan.kind==='reply_monitor'?'原生临时收件监控检查':'主人定时浏览开始入队',source_at:this.now(),source_type:sourceType,metadata:{subtype:probe?'probe':'dispatch',plan_id,delivery_key:delivery.key,source_message_id:delivery.message_id??'',expires_at:plan.expires_at}})
    const results=[]
    for(const platform of plan.platforms){try{
      const config=this.store.getDocument(platform)?.value,state=this.store.getDocument('platform-state-'+platform)?.value??{}
      if(!config?.enabled||state.verification_required||state.paused_until>this.now()){results.push({platform,status:'platform_paused'});continue}
      const auth=await this.platforms[platform].status({refresh:true});if(!auth.authenticated||auth.verification_required||auth.paused_until>this.now()){results.push({platform,status:'not_ready'});continue}
      if(probe){results.push({platform,status:'ready',authenticated:true});continue}
      if(this.now()>=plan.expires_at){results.push({platform,status:'expired'});continue}
      const limits=config[platform].limits,q=this.activity.runOneRound(platform,{trigger:'manual',read_per_round:limits.read_per_round,reply_per_round:limits.reply_per_round,idempotency_key:key+':'+platform});results.push({platform,status:q.duplicate?'existing_round':'queued',task_id:q.task.id,read_per_round:limits.read_per_round,reply_per_round:limits.reply_per_round})
    }catch(error){results.push({platform,status:'not_queued',reason:error.message})}}
    this.store.appendJournalEvent({event_key:key+':result',event_type:'log',platform:'harness',direction:'internal',status:'recorded',visibility:'owner',text:probe?'原生日程入口验证完成，未启动浏览':'原生日程浏览入队结果',source_at:this.now(),source_type:sourceType,metadata:{subtype:'result',plan_id,probe,results}})
    return {status:probe?'probe_ok':'dispatched',new_rounds:results.filter(x=>x.status==='queued').length,dispatcher_model_calls:0,results,ends_at:new Date(plan.expires_at).toISOString()}
  }
}
