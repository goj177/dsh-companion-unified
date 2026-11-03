import {createHash} from 'node:crypto'
import {NativeStore} from './store.mjs'
const hash=s=>createHash('sha256').update(s).digest('hex')
const sourceType='native_scheduled_rounds'
const sid=exec=>exec?.agent?.session?.header?.id??exec?.agent?.session?.id??''
const validId=s=>typeof s==='string'&&s.length>0&&s.length<=240&&!/[\0\r\n]/.test(s)

/** One owner-created DSH reminder gets a bounded two-platform queue capability. */
export class NativeScheduledRounds{
  constructor({store,activity,platforms,schedule,current_agent,owner_entity_id,now=Date.now}={}){
    if(!(store instanceof NativeStore)||!activity?.runOneRound||typeof schedule!=='function'||typeof current_agent!=='function'||typeof owner_entity_id!=='function')throw Error('定时浏览需要原生存储、队列和宿主日程服务')
    Object.assign(this,{store,activity,platforms,schedule,current_agent,owner_entity_id,now})
  }
  _session(exec){const id=sid(exec);if(!validId(id)||this.current_agent(id)!==exec.agent)throw Error('定时浏览未绑定当前真实SDK会话');return id}
  _plan(id){if(!validId(id))throw Error('定时计划标识无效');const row=this.store.db.prepare("SELECT metadata_json FROM journal_events WHERE source_type=? AND json_extract(metadata_json,'$.subtype')='grant' AND json_extract(metadata_json,'$.plan_id')=? ORDER BY recorded_at DESC,rowid DESC LIMIT 1").get(sourceType,id);if(!row)throw Error('没有主人授权的定时计划');return JSON.parse(row.metadata_json)}
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
    if(authority.owner_authorized===true&&authority.actor_entity_id===plan.owner_entity_id&&String(authority.source_scope??'').startsWith('user:'))return {key:'manual:'+authority.source_scope}
    const events=exec.agent.session.snapshotEvents?.(exec.agent.session.inheritedEventCount??0);if(!Array.isArray(events))throw Error('没有本轮已提交的原生日程消息')
    let message;for(const event of [...events].reverse()){if(event.type==='turn/start')break;if(event.type==='user/message'){const m=event.data?.message??event.data;if(m?.source?.kind==='schedule'){message=m;break}}}
    if(!validId(message?.id))throw Error('仅允许主人或本轮真实DSH日程投递触发')
    const ids=probe?[plan.probe_schedule_id,plan.schedule_id].filter(Boolean):[plan.schedule_id]
    for(const id of ids){const result=await this.schedule().history({sessionId:plan.session_id,id,limit:20}),receipt=result.records?.find(x=>x.messageId===message.id);if(receipt){const time=Date.parse(receipt.scheduledAt);if(!Number.isSafeInteger(time)||time>this.now()+5000)throw Error('日程投递时点无法核验');return {key:id+':'+receipt.scheduledAt,message_id:message.id}}}
    throw Error('当前消息未匹配宿主持久化的日程投递回执')
  }
  async run({plan_id,probe=false}={},exec,authority={}){
    if(typeof probe!=='boolean')throw Error('probe须为布尔值');const session_id=this._session(exec),plan=this._plan(plan_id)
    if(plan.session_id!==session_id||plan.owner_entity_id!==this.owner_entity_id())throw Error('定时计划与当前会话或主人不符')
    if(this.now()>=plan.expires_at)return {status:'expired',new_rounds:0,ends_at:new Date(plan.expires_at).toISOString()}
    const live=(await this.schedule().catalog()).find(row=>row.id===plan.schedule_id&&row.sessionId===session_id)
    if(!live||live.status!=='active'||live.kind!=='every'||live.everySeconds*1000<plan.interval_ms)throw Error('日程规则已变化或频率高于主人授权，请主人重新绑定')
    const delivery=await this._delivery(plan,exec,authority,probe),key=plan_id+':'+(probe?'probe:':'run:')+hash(delivery.key)
    if(this.store.db.prepare('SELECT id FROM journal_events WHERE event_key=?').get(key))return {status:'already_dispatched',new_rounds:0}
    this.store.appendJournalEvent({event_key:key,event_type:'log',platform:'harness',direction:'internal',status:'recorded',visibility:'owner',text:probe?'定时入口验证':'主人定时浏览开始入队',source_at:this.now(),source_type:sourceType,metadata:{subtype:probe?'probe':'dispatch',plan_id,delivery_key:delivery.key,source_message_id:delivery.message_id??'',expires_at:plan.expires_at}})
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
