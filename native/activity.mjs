import { randomUUID,createHash } from 'node:crypto'
import { NativeStore } from './store.mjs'
import { NativeBudget } from './budget.mjs'
import { isPlainObject,validateJson,stringifyJson } from './contracts.mjs'
import { shanghaiTime,valleyDecision } from '../policy.mjs'
import {isCompletedShareIntent} from './sharing.mjs'

const PLATFORMS=['qq','tieba','bilibili']
const KINDS=['explore','incoming','chat','maintenance']
const OPEN=['draft','queued','leased','running','blocked']
const ACTIVE=['leased','running']
const SELECT='SELECT actions.*,CAST(body AS BLOB) AS body_bytes FROM actions'
const PREFIX="kind IN ('activity.explore','activity.incoming','activity.chat','activity.maintenance')"
const hash=value=>createHash('sha256').update(value).digest('hex')
const fields=(value,allowed)=>{if(!isPlainObject(value)||Object.keys(value).some(key=>!allowed.includes(key)))throw new Error('原生活动参数包含未知字段或类型错误')}
const integer=(value,name,min=0,max=Number.MAX_SAFE_INTEGER)=>{if(!Number.isSafeInteger(value)||value<min||value>max)throw new Error(name+'必须为范围内安全整数');return value}
const text=(value,name,max=16000,required=false)=>{if(typeof value!=='string'||!value.isWellFormed()||value.length>max||required&&!value.trim())throw new Error(name+'文本无效');return value}
const time=(value,name)=>integer(value,name,0,8640000000000000)
const choice=(value,allowed,name)=>{if(!allowed.includes(value))throw new Error(name+'取值无效');return value}
const canonical=value=>Array.isArray(value)?value.map(canonical):isPlainObject(value)?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value
const encode=value=>stringifyJson(canonical(validateJson(value)))
// Public inbox work has its own queue. It must not keep pushing back idle opportunities.
const monitoredIncoming=task=>task.kind==='activity.incoming'&&task.metadata?.trigger==='incoming'&&['tieba','bilibili'].includes(task.platform)
function targetOf(value){
  const result=validateJson(value,{object:true,maxBytes:512*1024})
  const visit=input=>{if(!isPlainObject(input)&&!Array.isArray(input))return;for(const [key,child]of Object.entries(input)){
    if(!Array.isArray(input)&&!/^[a-z][a-z0-9_]*$/.test(key))throw new Error('target字段必须为canonical snake_case')
    if(/(?:^|_)(?:id|uid|mid|pid|rpid)$/.test(key)&&child!==null&&typeof child!=='string')throw new Error('平台标识与回复坐标必须为字符串')
    visit(child)
  }}
  visit(result);return result
}
function project(row,{internal=false}={}){
  if(!row)return null
  const metadata=JSON.parse(row.metadata_json)
  if(!internal){delete metadata.lease_token;delete metadata.lease_until}
  return {id:row.id,platform:row.platform,kind:row.kind,status:row.status,target:JSON.parse(row.target_json),body:Buffer.from(row.body_bytes).toString('utf8'),
    request_digest:row.request_digest,body_digest:row.body_digest,source_evidence_id:row.source_evidence_id,created_at:row.created_at,updated_at:row.updated_at,not_before:row.not_before,
    metadata,...(internal?{approval_token:row.approval_token}:{})}
}
function quietDecision(now,config){
  const t=shanghaiTime(now),start=config.qq?.quiet_start_hour??1,end=config.qq?.quiet_end_hour??8
  const quiet=start===end?false:start<end?t.hour>=start&&t.hour<end:t.hour>=start||t.hour<end
  const next=quiet?t.midnight+end*3600000+(start>end&&t.hour>=start?86400000:0):now
  return {quiet,next_at:next}
}

/** Persisted native scheduling only. All model work is injected through one
 * runner; prepared publications use a separate zero-model runner. No network or
 * public-send implementation exists in this module. */
export class NativeActivity {
  constructor(options={}){
    fields(options,['store','budget','money_budget','runner','publication_runner','now','activity_document_id','state_document_id'])
    if(!(options.store instanceof NativeStore))throw new Error('NativeActivity必须显式使用NativeStore')
    if(options.now!==undefined&&typeof options.now!=='function'||options.runner!==undefined&&typeof options.runner!=='function'||options.publication_runner!==undefined&&typeof options.publication_runner!=='function')throw new Error('活动时钟或runner必须为函数')
    this.store=options.store;this.now=options.now??this.store.now;this.policy_id=text(options.activity_document_id??'activity','activity_document_id',160,true)
    this.state_id=text(options.state_document_id??'activity:state','state_document_id',160,true)
    this.budget=options.budget??new NativeBudget({store:this.store,now:this.now,policy_document_id:this.policy_id})
    if(!(this.budget instanceof NativeBudget)||this.budget.store!==this.store||this.budget.policyId!==this.policy_id)throw new Error('NativeActivity预算必须使用同一个NativeStore和活动策略')
    this.runner=options.runner;this.publication_runner=options.publication_runner;this.money=options.money_budget;if(this.money&&this.money.store!==this.store)throw new Error('费用预算必须同库')
  }
  _now(){this.store._open();return time(this.now(),'活动时钟')}
  _policy(){const doc=this.store.getDocument(this.policy_id);if(doc&&doc.type!=='activity')throw new Error('活动策略文档类型无效');return doc?.value??{enabled:false}}
  _state(){
    const doc=this.store.getDocument(this.state_id);if(doc&&doc.type!=='activity_state')throw new Error('活动状态文档类型无效')
    const p=this._policy(),now=this._now()
    return {revision:doc?.revision??0,value:{idle:{last_activity_at:now,next_explore_at:now+(p.idle?.explore_every_ms??5400000),next_chat_at:now+(p.idle?.chat_every_ms??7200000),explore_cursor:0,chat_cursor:0,...doc?.value.idle},blocks:doc?.value.blocks??[]}}
  }
  _save(state){const doc=this.store.putDocument({id:this.state_id,type:'activity_state',expected_revision:state.revision,value:state.value});state.revision=doc.revision}
  _get(id,internal=false){text(id,'activity id',160,true);return project(this.store.db.prepare(SELECT+' WHERE id=? AND '+PREFIX).get(id),{internal})}
  get(id){return this._get(id)}
  _list(statuses){const conditions=[PREFIX],args=[];if(statuses){conditions.push('status IN ('+statuses.map(()=>'?').join(',')+')');args.push(...statuses)}return this.store.db.prepare(SELECT+' WHERE '+conditions.join(' AND ')+' ORDER BY created_at,id').all(...args).map(row=>project(row,{internal:true}))}
  _block(state,platform){const now=this._now();return state.value.blocks.find(row=>row.platform===platform&&(row.until===null||row.until===undefined||row.until>now))}
  _event(task,name,extra={}){
    this.store.appendJournalEvent({event_key:'activity:'+task.id+':'+name+':'+randomUUID(),event_type:'log',platform:task.platform,direction:'internal',status:['leased','running'].includes(task.status)?'pending':task.status==='completed'?'recorded':task.status,
      visibility:'owner',text:'',source_at:this._now(),source_type:'native_activity',metadata:{event_name:'activity.'+name,task_id:task.id,kind:task.kind,batch_id:task.metadata.batch_id??'',...extra}})
  }
  _manualRequest(task,trigger){
    if(trigger==='manual'&&task.status==='queued'&&task.metadata.execution==='model'&&!task.metadata.dispatch_started&&!task.metadata.model_started&&task.metadata.trigger!=='manual'){
      const metadata={...task.metadata,trigger:'manual',last_error:''},now=this._now()
      this.store.db.prepare('UPDATE actions SET metadata_json=?,not_before=?,updated_at=? WHERE id=?').run(encode(metadata),Math.max(now,task.not_before??0),now,task.id)
      const updated=this._get(task.id);this._event(updated,'requested_manually');return updated
    }
    return this._get(task.id)
  }
  _enqueue(input){
    fields(input,['platform','kind','trigger','idempotency_key','target','body','source_evidence_id','not_before','estimated_tokens','human','heavy','execution','initial_status'])
    const p=this._policy(),platform=choice(input.platform,PLATFORMS,'platform'),kind='activity.'+choice(input.kind,KINDS,'kind'),trigger=choice(input.trigger??(input.human?'incoming':'autonomous'),['manual','autonomous','incoming'],'trigger')
    const execution=choice(input.execution??'model',['model','publication'],'execution'),body=text(input.body??'','body',200000),target=targetOf(input.target??{})
    if(input.human!==undefined&&typeof input.human!=='boolean'||input.heavy!==undefined&&typeof input.heavy!=='boolean')throw new Error('human/heavy必须为布尔值')
    const human=input.human===true,heavy=input.heavy??!human,now=this._now(),not_before=time(input.not_before??now,'not_before')
    if(execution==='publication'&&kind!=='activity.incoming')throw new Error('准备发表只能进入独立publication incoming载体')
    const initial_status=choice(input.initial_status??'queued',['queued','draft'],'initial_status')
    if(kind==='activity.explore'){
      const old=this._list(OPEN).find(row=>row.platform===platform&&row.kind===kind&&(!target.round_limits||encode(row.target.round_limits??{})===encode(target.round_limits)))
      if(old){
        if(trigger==='manual'&&old.status==='queued'&&!old.metadata.dispatch_started&&!old.metadata.model_started&&old.metadata.trigger!=='manual'){
          const metadata={...old.metadata,trigger:'manual',last_error:''}
          this.store.db.prepare('UPDATE actions SET metadata_json=?,not_before=?,updated_at=? WHERE id=?').run(encode(metadata),now,now,old.id)
        }
        return {task:project(this.store.db.prepare(SELECT+' WHERE id=?').get(old.id)),duplicate:true}
      }
    }
    if(execution==='publication'){
      const old=this._list().find(row=>row.metadata.execution==='publication'&&row.target.action_id===target.action_id)
      if(old)return {task:project(this.store.db.prepare(SELECT+' WHERE id=?').get(old.id)),duplicate:true}
    }
    const key=text(input.idempotency_key??randomUUID(),'idempotency_key',512,true)
    if(/[\0\r\n]/.test(key))throw new Error('idempotency_key不能包含控制分隔符')
    const dedupe_key=hash(encode([platform,kind,key])),id='activity:'+dedupe_key
    const source_evidence_id=input.source_evidence_id??null
    if(source_evidence_id!==null)text(source_evidence_id,'source_evidence_id',160,true)
    const request_digest=hash(encode({platform,kind,target,body,source_evidence_id,execution})),previous=this._get(id,true)
    if(previous){if(previous.request_digest!==request_digest)throw new Error('同一活动标识出现不同目标或正文，未覆盖');return {task:this._manualRequest(previous,trigger),duplicate:true}}
    const estimated_tokens=execution==='publication'?0:integer(input.estimated_tokens??(human?p.budget?.human_reserve_tokens??3000:p.budget?.reserve_tokens??10000),'estimated_tokens',1)
    const metadata={schema_version:1,record_type:'activity_task',trigger,execution,dedupe_key,estimated_tokens,human,heavy,attempts:0,lease_token:'',lease_until:0,
      model_started:false,dispatch_started:false,reservation_id:'',batch_id:'',actual_tokens:0,usage_known:false,last_error:'',completed_at:null,not_started:false}
    this.store.db.prepare('INSERT INTO actions(id,platform,kind,target_json,body,body_digest,request_digest,status,source_evidence_id,created_at,updated_at,not_before,metadata_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id,platform,kind,encode(target),body,hash(Buffer.from(body,'utf8')),request_digest,initial_status,source_evidence_id,now,now,not_before,encode(metadata))
    const task=this._get(id);this._event(task,'enqueued')
    if(execution==='model'&&(human||trigger==='manual')&&!monitoredIncoming(task)){const state=this._state();state.value.idle.last_activity_at=now;this._save(state)}
    return {task,duplicate:false}
  }
  enqueueIncoming(input,{public_context=''}={}){
    this.store._write();fields(input,['platform','kind','trigger','idempotency_key','target','body','source_evidence_id','not_before','estimated_tokens','human','heavy']);text(public_context,'公开引用上下文',4000)
    if(input?.kind!=='incoming'||input.execution!==undefined||input.initial_status!==undefined)throw Error('来信必须使用原生消息执行器')
    return this.store.transaction(()=>{
      const platform=choice(input.platform,PLATFORMS,'platform'),key=text(input.idempotency_key,'idempotency_key',512,true),id='activity:'+hash(encode([platform,'activity.incoming',key])),old=this._get(id,true),source=input.source_evidence_id?this.store.db.prepare('SELECT platform,source_type,direction,actor_uid,conversation_id,CAST(text AS BLOB) bytes FROM evidence WHERE id=?').get(input.source_evidence_id):null
      if(old&&old.metadata.execution==='model'&&old.metadata.human===true&&input.human===true&&old.source_evidence_id===input.source_evidence_id&&source?.platform===platform&&source.source_type==='user'&&source.direction==='in'&&source.actor_uid===input.target?.actor_uid&&source.conversation_id===input.target?.conversation_id&&Buffer.from(source.bytes).toString('utf8')===input.body&&encode(old.target)===encode(targetOf(input.target)))return {task:this._manualRequest(old,input.trigger),duplicate:true}
      const result=this._enqueue(input)
      if(!result.duplicate&&public_context){const metadata={...result.task.metadata,public_context};this.store.db.prepare('UPDATE actions SET metadata_json=? WHERE id=?').run(encode(metadata),result.task.id);result.task=this._get(result.task.id)}
      return result
    })
  }
  enqueue(input){this.store._write();if(input?.execution!==undefined||input?.initial_status!==undefined)throw new Error('通用enqueue不接受执行器或审批状态覆盖');return this.store.transaction(()=>this._enqueue(input))}
  runOneRound(platform,options={}){
    fields(options,['trigger','read_per_round','reply_per_round','idempotency_key']);const trigger=options.trigger??'manual'
    choice(platform,['tieba','bilibili'],'探索平台');choice(trigger,['manual','autonomous'],'trigger')
    const limits={};for(const key of ['read_per_round','reply_per_round'])if(options[key]!==undefined)limits[key]=integer(options[key],key,key==='read_per_round'?1:0,30)
    if(Object.keys(limits).length&&trigger!=='manual')throw new Error('单轮覆盖仅限主人手动发起')
    return this.enqueue({platform,kind:'explore',trigger,target:{autonomous:true,...(Object.keys(limits).length?{round_limits:limits}:{})},human:false,heavy:true,...(options.idempotency_key?{idempotency_key:options.idempotency_key}:{})})
  }
  enqueuePublication(input){
    this.store._write();fields(input,['platform','action_id','idempotency_key'])
    return this.store.transaction(()=>{
      const linked=project(this.store.db.prepare(SELECT+' WHERE id=?').get(text(input.action_id,'action_id',160,true)),{internal:true})
      if(!linked||linked.platform!==input.platform||!linked.kind.startsWith(linked.platform+'.'))throw new Error('准备发表必须引用同平台真实NativeOutbox动作')
      const result=this._enqueue({platform:input.platform,kind:'incoming',trigger:'manual',execution:'publication',initial_status:'draft',idempotency_key:input.idempotency_key??'publication:'+linked.id,
        target:{action_id:linked.id,request_digest:linked.request_digest},body:linked.body,human:false,heavy:false})
      return result
    })
  }
  _publication(task){
    const linked=project(this.store.db.prepare(SELECT+' WHERE id=?').get(task.target.action_id),{internal:true})
    if(!linked||linked.platform!==task.platform||!linked.kind.startsWith(linked.platform+'.')||linked.request_digest!==task.target.request_digest||linked.body_digest!==task.body_digest)throw new Error('发表载体与原稿目标或正文不一致')
    return linked
  }
  activatePublication(id,{expected_digest}={}){
    this.store._write()
    return this.store.transaction(()=>{
      const task=this._get(id,true)
      if(!task||task.metadata.execution!=='publication'||task.request_digest!==expected_digest)throw new Error('准备发表内容与批准时不一致')
      if(task.status==='queued')return {task:this._get(id),duplicate:true}
      if(task.status!=='draft')throw new Error('未知、已执行或被阻断的发表载体不能重新激活')
      const linked=this._publication(task)
      if(linked.status!=='queued'||!linked.approval_token)throw new Error('原稿仍需明确授权；活动队列不会自动批准')
      this.store.db.prepare("UPDATE actions SET status='queued',updated_at=? WHERE id=?").run(this._now(),id)
      const result=this._get(id);this._event(result,'publication_activated');return {task:result,duplicate:false}
    })
  }
  resumeUnsentPublication(id,{expected_digest}={}){
    this.store._write()
    return this.store.transaction(()=>{
      const task=this._get(id,true)
      if(!task||task.request_digest!==expected_digest||task.metadata.execution!=='publication'||task.status!=='unknown'||task.metadata.dispatch_started||task.metadata.model_started)throw new Error('只能恢复已核实未开始发送的发表任务')
      const linked=this._publication(task)
      if(linked.status!=='queued'||linked.metadata.network_started===true||!linked.approval_token)throw new Error('原稿未被确认尚未发送，保持原状且不重放')
      const metadata={...task.metadata,lease_token:'',lease_until:0,completed_at:null,not_started:true,last_error:'已核实未开始网络发送，保留原授权和原稿恢复排队'}
      this.store.db.prepare("UPDATE actions SET status='queued',not_before=?,updated_at=?,metadata_json=? WHERE id=?").run(Math.max(this._now(),linked.not_before??0),this._now(),encode(metadata),id)
      this._event({...task,status:'queued',metadata},'unsent_resumed')
      return {task:this._get(id),network_replayed:false}
    })
  }
  noteActivity({source_at=this._now()}={}){this.store._write();time(source_at,'source_at');return this.store.transaction(()=>{const state=this._state();state.value.idle.last_activity_at=Math.max(state.value.idle.last_activity_at,source_at);this._save(state);return {last_activity_at:state.value.idle.last_activity_at}})}
  blockPlatform(platform,{reason='需要平台验证',until=null}={}){
    this.store._write();choice(platform,PLATFORMS,'platform');text(reason,'reason',2000);if(until!==null)time(until,'until')
    return this.store.transaction(()=>{const state=this._state();state.value.blocks=state.value.blocks.filter(row=>row.platform!==platform);state.value.blocks.push({platform,reason,blocked_at:this._now(),until});this._save(state);return {platform,blocked:true,until,reason}})
  }
  clearPlatformBlock(platform){
    this.store._write();choice(platform,PLATFORMS,'platform')
    return this.store.transaction(()=>{
      const state=this._state();state.value.blocks=state.value.blocks.filter(row=>row.platform!==platform);this._save(state)
      for(const task of this._list(['blocked']).filter(row=>row.platform===platform)){
        // Once a model or publication actually began, clearing a login/captcha
        // latch is not evidence that its old action did not happen.
        if(task.metadata.dispatch_started||task.metadata.model_started){this._finishInvalid(task,'验证门禁已清除；原执行仍不重放','unknown');continue}
        const metadata={...task.metadata,last_error:'',not_started:true}
        this.store.db.prepare("UPDATE actions SET status='queued',not_before=?,updated_at=?,metadata_json=? WHERE id=?").run(this._now(),this._now(),encode(metadata),task.id)
      }
      return {platform,blocked:false}
    })
  }
  _gate(task,state,p,{include_batch=true}={}){
    const now=this._now(),phase=valleyDecision(now,p)
    if(p.enabled!==true)return {reason:'disabled',next_eligible_at:null}
    const block=this._block(state,task.platform)
    if(block)return {reason:'platform_blocked',next_eligible_at:block.until??null,detail:block.reason}
    const platformState=this.store.getDocument('platform-state-'+task.platform)?.value
    if(platformState?.verification_required||platformState?.paused_until>now)return{reason:'platform_blocked',next_eligible_at:platformState.verification_required?null:platformState.paused_until,detail:platformState.verification_reason??'平台要求核验或退避'}
    const maintenance=task.kind==='activity.maintenance'&&task.metadata.execution==='model'&&['memory','mood','learning'].includes(task.target.maintenance_kind)
    if(task.platform==='qq'&&!task.metadata.human&&!maintenance){const quiet=quietDecision(now,p);if(quiet.quiet)return {reason:'qq_quiet',next_eligible_at:quiet.next_at}}
    if(task.not_before>now)return {reason:'not_before',next_eligible_at:task.not_before}
    if(task.metadata.execution!=='publication'){
      if(this.money?.enabled()){const cash=this.money.status();if(cash.remaining_nano<(task.metadata.required_cost_nano??1))return{reason:'money_budget',next_eligible_at:shanghaiTime(now).midnight+86400000}}
      const urgent=task.metadata.human&&!task.metadata.heavy&&p.budget?.urgent_human_allowed===true
      const manual=task.metadata.trigger==='manual'
      if(!phase.valley&&!urgent&&!manual)return {reason:'peak',next_eligible_at:phase.nextValleyAt}
      if(!manual&&task.metadata.heavy&&Number.isFinite(phase.nextPeakAt)&&now+(p.batching?.min_valley_remaining_ms??120000)>=phase.nextPeakAt)return {reason:'valley_ending',next_eligible_at:valleyDecision(phase.nextPeakAt+1,p).nextValleyAt}
    }
    const delay=task.metadata.trigger==='manual'||task.metadata.execution==='publication'?0:task.metadata.human?p.batching?.human_batch_ms??0:p.batching?.batch_ms??30000
    if(include_batch&&task.created_at+delay>now)return {reason:'batching',next_eligible_at:task.created_at+delay}
    return {reason:'ready',next_eligible_at:now}
  }
  _idle(state,p){
    const now=this._now(),cfg=p.idle??{},phase=valleyDecision(now,p)
    if(p.enabled!==true||cfg.enabled!==true||this.money?.enabled()&&this.money.status().remaining_nano<=0||!phase.valley||now-state.value.idle.last_activity_at<(cfg.min_idle_ms??2700000))return
    const pending=this._list(['queued','leased','running']),active=pending.filter(task=>ACTIVE.includes(task.status)),models=active.filter(task=>task.metadata.execution==='model')
    const foreground=models.filter(task=>!monitoredIncoming(task))
    if(new Set(foreground.map(task=>task.metadata.batch_id||task.id)).size>=(p.batching?.max_concurrent??1)||pending.some(task=>task.status==='queued'&&task.metadata.execution==='model'&&!monitoredIncoming(task)&&new Set(models.filter(row=>row.platform===task.platform).map(row=>row.metadata.batch_id||row.id)).size<(p.batching?.max_per_platform??1)&&this._gate(task,state,p,{include_batch:false}).reason==='ready'))return
    const choices=[]
    const platforms=(cfg.explore_platforms??['bilibili','tieba']).filter(platform=>['tieba','bilibili'].includes(platform)&&!this._block(state,platform)&&!pending.some(task=>task.platform===platform&&task.metadata.execution==='model'&&!monitoredIncoming(task)&&(task.kind!=='activity.incoming'||ACTIVE.includes(task.status)||['ready','batching'].includes(this._gate(task,state,p,{include_batch:false}).reason))))
    if(platforms.length&&now>=state.value.idle.next_explore_at)choices.push({kind:'explore',at:state.value.idle.next_explore_at})
    const chats=[]
    for(const target of cfg.qq_targets??['owner','group']){
      if(target==='owner'&&p.qq?.owner_conversation)chats.push({target,conversation_id:p.qq.owner_conversation})
      if(target==='group')for(const conversation_id of p.qq?.group_conversations??[])chats.push({target,conversation_id})
    }
    if(chats.length&&!pending.some(task=>task.platform==='qq')&&!this._block(state,'qq')&&!quietDecision(now,p).quiet&&now>=state.value.idle.next_chat_at)choices.push({kind:'chat',at:state.value.idle.next_chat_at})
    const next=choices.sort((a,b)=>a.at-b.at)[0]
    if(next?.kind==='explore'){
      const platform=platforms[state.value.idle.explore_cursor%platforms.length]
      const result=this._enqueue({platform,kind:'explore',trigger:'autonomous',target:{autonomous:true},human:false,heavy:true})
      if(!result.duplicate)state.value.idle.explore_cursor++
      state.value.idle.next_explore_at=now+(cfg.explore_every_ms??5400000);this._save(state)
    }else if(next?.kind==='chat'){
      const target=chats[state.value.idle.chat_cursor%chats.length]
      this._enqueue({platform:'qq',kind:'chat',trigger:'autonomous',target,human:false,heavy:true})
      state.value.idle.chat_cursor++;state.value.idle.next_chat_at=now+(cfg.chat_every_ms??7200000);this._save(state)
    }
  }
  scheduleIdle(){
    this.store._write()
    return this.store.transaction(()=>{this._recoverExpired();const state=this._state();if(!state.revision)this._save(state);this._idle(state,this._policy());return {checked:true}})
  }
  _recoverExpired(){
    const now=this._now(),expired=this._list(ACTIVE).filter(task=>(task.metadata.lease_until??0)<=now)
    const batches=new Set(),reservations=new Map()
    for(const task of expired){
      const metadata={...task.metadata};let started=metadata.dispatch_started===true||metadata.model_started===true
      if(metadata.execution==='publication'){
        try{const linked=this._publication(task);if(linked.status==='confirmed'||isCompletedShareIntent(this.store,linked)){this._finishInvalid(task,'原稿已确认，无需重复发表','completed');continue}if(['leased','submitting','unknown'].includes(linked.status))started=true}catch{started=true}
      }
      if(metadata.reservation_id){
        if(!reservations.has(metadata.reservation_id)){const raw=this.store.db.prepare("SELECT metadata_json FROM actions WHERE id=? AND kind='model.reservation'").get(metadata.reservation_id);reservations.set(metadata.reservation_id,raw?JSON.parse(raw.metadata_json):null)}
        const reservation=reservations.get(metadata.reservation_id)
        started=started||reservation?.started===true||reservation?.actual_known===true
        if(reservation?.reservation_open&&!batches.has(metadata.reservation_id))this.budget.finish(metadata.reservation_id,{outcome:started?'unknown':'not_started'})
        batches.add(metadata.reservation_id)
      }
      metadata.lease_token='';metadata.lease_until=0;metadata.last_error=started?'租约过期，已开始的结果未知，不重放':'租约过期但未开始，释放预留后等待统一执行';metadata.not_started=!started
      const status=started?'unknown':'queued'
      this.store.db.prepare('UPDATE actions SET status=?,metadata_json=?,updated_at=?,not_before=? WHERE id=?').run(status,encode(metadata),now,now,task.id)
      this._event({...task,status,metadata},'lease_expired')
    }
    return expired.length
  }
  _claim({idle=true,platform,execution}={}){
    return this.store.transaction(()=>{
      this._recoverExpired();const p=this._policy(),state=this._state()
      if(!state.revision)this._save(state)
      if(p.enabled!==true)return {reason:'disabled'}
      if(idle)this._idle(state,p)
      const active=this._list(ACTIVE),models=active.filter(task=>task.metadata.execution==='model')
      const queued=this._list(['queued']).filter(task=>(platform===undefined||task.platform===platform)&&(execution===undefined||task.metadata.execution===execution)),ready=queued.filter(task=>this._gate(task,state,p).reason==='ready')
      const dueExploration=new Set()
      for(const task of ready.filter(task=>task.kind==='activity.explore'&&task.metadata.trigger==='autonomous')){
        const previous=this.store.db.prepare("SELECT kind,metadata_json,platform FROM actions WHERE platform=? AND json_extract(metadata_json,'$.record_type')='activity_task' AND json_extract(metadata_json,'$.execution')='model' AND json_extract(metadata_json,'$.model_started')=1 AND json_extract(metadata_json,'$.completed_at')>=? ORDER BY json_extract(metadata_json,'$.completed_at') DESC,rowid DESC LIMIT 1").get(task.platform,task.created_at)
        if(previous&&monitoredIncoming({...previous,metadata:JSON.parse(previous.metadata_json)}))dueExploration.add(task.id)
      }
      // Once an inbox batch finishes, let an already-due exploration take its
      // turn. Continuous new replies cannot starve that platform indefinitely.
      ready.sort((a,b)=>Number(b.metadata.execution==='publication')-Number(a.metadata.execution==='publication')||Number(b.metadata.trigger==='manual')-Number(a.metadata.trigger==='manual')||Number(dueExploration.has(b.id))-Number(dueExploration.has(a.id))||Number(b.metadata.human)-Number(a.metadata.human)||a.created_at-b.created_at||a.id.localeCompare(b.id))
      let denied=null
      for(const first of ready){
        const publication=first.metadata.execution==='publication'
        const full=publication?active.some(task=>task.platform===first.platform&&task.metadata.execution==='publication'):
          new Set(models.map(task=>task.metadata.batch_id||task.id)).size>=(p.batching?.max_concurrent??1)||new Set(models.filter(task=>task.platform===first.platform).map(task=>task.metadata.batch_id||task.id)).size>=(p.batching?.max_per_platform??1)
        if(full){denied={reason:'busy'};continue}
        if(publication&&!this.publication_runner||!publication&&!this.runner){denied={reason:'runner_unavailable'};continue}
        if(publication){
          let linked
          try{linked=this._publication(first)}catch(error){this._finishInvalid(first,error.message);continue}
          if(linked.status==='confirmed'||isCompletedShareIntent(this.store,linked)){this._finishInvalid(first,'原稿已确认，无需重复发表','completed');continue}
          if(linked.status==='unknown'||['leased','submitting'].includes(linked.status)){this._finishInvalid(first,'原稿结果未知或由其他执行者处理，不重放','unknown');continue}
          if(linked.status!=='queued'||!linked.approval_token){this._finishInvalid(first,'原稿需要明确授权','draft');continue}
        }
        const domain=this._batchDomain(first)
        const group=publication?[first]:ready.filter(task=>task.metadata.execution==='model'&&task.platform===first.platform&&task.kind===first.kind&&task.metadata.trigger===first.metadata.trigger&&task.metadata.human===first.metadata.human&&task.metadata.heavy===first.metadata.heavy
          &&first.kind==='activity.incoming'&&this._batchDomain(task)===domain).slice(0,p.batching?.max_batch??5)
        if(!group.length)group.push(first)
        const max=p.budget?.max_task_tokens??30000,tasks=[];let estimated_tokens=0
        for(const task of group){const estimate=publication?0:task.metadata.estimated_tokens;if(tasks.length&&estimated_tokens+estimate>max)break;tasks.push(task);estimated_tokens+=estimate}
        const batch_id='activity-batch:'+randomUUID(),lease_token=randomUUID(),now=this._now(),lease_until=now+(p.batching?.lease_ms??900000)
        let reservation=null
        if(!publication){
          reservation=this.budget.reserve({id:batch_id,platform:first.platform,kind:first.kind,estimated_tokens,human:first.metadata.human,heavy:first.metadata.heavy,manual:first.metadata.trigger==='manual',trigger:first.metadata.trigger})
          if(!reservation.allowed){denied=reservation;if(reservation.reason==='task_reservation_too_large')this._finishInvalid(first,'任务预留超出单轮上限','blocked');continue}
        }
        for(const task of tasks){
          const metadata={...task.metadata,attempts:(task.metadata.attempts??0)+1,lease_token,lease_until,batch_id,reservation_id:reservation?.reservation_id??'',model_started:false,dispatch_started:false,not_started:false,completed_at:null,actual_tokens:0,usage_known:false,last_error:''}
          this.store.db.prepare("UPDATE actions SET status='leased',metadata_json=?,updated_at=? WHERE id=? AND status='queued'").run(encode(metadata),now,task.id)
          task.metadata=metadata;task.status='leased';this._event(task,'leased')
        }
        if(!publication&&!monitoredIncoming(first)){state.value.idle.last_activity_at=now;this._save(state)}
        return {batch:{id:batch_id,batch_id,platform:first.platform,kind:first.kind,execution:first.metadata.execution,trigger:first.metadata.trigger,
          estimated_tokens,reservation_id:reservation?.reservation_id??'',lease_until,tasks:tasks.map(task=>this._get(task.id)),
          model:{reasoning_effort:p.model?.reasoning_effort??'low',max_output_tokens:valleyDecision(now,p).valley||first.metadata.trigger==='manual'||first.metadata.human?p.model?.max_output_tokens??1800:p.model?.peak_max_output_tokens??900,max_steps:p.budget?.max_steps??8}},lease_token}
      }
      if(denied)return {reason:denied.reason,next_eligible_at:denied.not_before??(denied.reason==='budget'?shanghaiTime(this._now()).midnight+86400000:null)}
      const gates=queued.map(task=>this._gate(task,state,p)).filter(row=>row.reason!=='ready')
      return {reason:gates[0]?.reason??'empty',next_eligible_at:gates.map(row=>row.next_eligible_at).filter(Number.isSafeInteger).sort((a,b)=>a-b)[0]??null}
    })
  }
  _batchDomain(task){
    const target=typeof task.target.conversation_id==='string'?task.target.conversation_id:''
    if(task.platform==='qq')return target?'qq-conversation:'+target:'isolated:'+task.id
    const evidence=task.source_evidence_id?this.store.db.prepare('SELECT platform,conversation_id,visibility FROM evidence WHERE id=?').get(task.source_evidence_id):null
    if(evidence&&evidence.platform===task.platform){
      if(evidence.visibility==='public')return 'public:'+task.platform
      if(evidence.conversation_id&&(!target||target===evidence.conversation_id))return 'private:'+task.platform+':'+evidence.visibility+':'+evidence.conversation_id
      return 'isolated:'+task.id
    }
    return target?'unproven:'+task.platform+':'+target:'isolated:'+task.id
  }
  _finishInvalid(task,reason,status='unknown'){
    const metadata={...task.metadata,last_error:reason,completed_at:this._now(),lease_token:'',lease_until:0}
    this.store.db.prepare('UPDATE actions SET status=?,updated_at=?,metadata_json=? WHERE id=?').run(status,this._now(),encode(metadata),task.id)
    this._event({...task,status,metadata},'not_dispatched')
  }
  _batchRows(batch,lease_token,{active=true}={}){
    const rows=batch.tasks.map(task=>this._get(task.id,true))
    if(rows.some(task=>!task||task.metadata.batch_id!==batch.id||task.metadata.reservation_id!==batch.reservation_id||active&&(!ACTIVE.includes(task.status)||task.metadata.lease_token!==lease_token||task.metadata.lease_until<=this._now())))throw new Error('活动租约已结束或不属于当前执行者')
    return rows
  }
  _markStarted(batch,lease_token){
    return this.store.transaction(()=>{
      const tasks=this._batchRows(batch,lease_token),p=this._policy(),state=this._state()
      if(tasks.every(task=>task.metadata.dispatch_started))return {started:true,duplicate:true}
      const gate=this._gate(tasks[0],state,p,{include_batch:false})
      if(gate.reason!=='ready')throw new Error('模型或发表尚未实际开始，当前活动门禁为'+gate.reason)
      if(batch.execution==='model')this.budget.markStarted(batch.reservation_id)
      for(const task of tasks){const metadata={...task.metadata,dispatch_started:true,model_started:batch.execution==='model'};this.store.db.prepare("UPDATE actions SET status='running',updated_at=?,metadata_json=? WHERE id=?").run(this._now(),encode(metadata),task.id);this._event({...task,status:'running',metadata},'started')}
      return {started:true,duplicate:false}
    })
  }
  _recordUsage(batch,total_tokens){
    integer(total_tokens,'total_tokens')
    return this.store.transaction(()=>{
      const rows=this._batchRows(batch,null,{active:false})
      if(batch.execution!=='model'){if(total_tokens!==0)throw new Error('准备发表不允许记录模型token');return {actual_tokens:0,updated:false}}
      if(rows.some(task=>!task.metadata.model_started))throw new Error('模型未实际开始，不能记录用量')
      const result=this.budget.recordUsage(batch.reservation_id,{total_tokens})
      for(const task of rows){const metadata={...task.metadata,actual_tokens:Math.max(task.metadata.actual_tokens??0,total_tokens),usage_known:true};this.store.db.prepare('UPDATE actions SET metadata_json=?,updated_at=? WHERE id=?').run(encode(metadata),this._now(),task.id)}
      return result
    })
  }
  _finish(batch,lease_token,result={}){
    return this.store.transaction(()=>{
      const tasks=this._batchRows(batch,lease_token),started=tasks.some(task=>task.metadata.dispatch_started),model_started=tasks.some(task=>task.metadata.model_started)
      let status,reason=text(result.reason??'','runner reason',2000),retry_at=result.not_before===undefined?this._now()+(result.status==='not_started'?Math.max(1000,this._policy().batching?.batch_ms??30000):0):time(result.not_before,'not_before')
      if(result.total_tokens!==undefined&&(model_started||batch.execution==='publication'))this._recordUsage(batch,result.total_tokens)
      else if(result.total_tokens!==undefined&&result.total_tokens!==0)throw new Error('runner未标记模型开始却返回正用量，需按原预留核对')
      if(batch.execution==='publication'){
        const linked=this._publication(tasks[0])
        status=linked.status==='confirmed'||isCompletedShareIntent(this.store,linked)?'completed':linked.status==='unknown'?'unknown':result.status==='blocked'?'blocked':!started&&result.status==='not_started'?(result.retry===false?'cancelled':'queued'):'unknown'
        if(status==='completed')reason='原稿已由实际服务器回执确认'
      }else{
        status=!model_started&&result.status==='not_started'?(result.retry===false?'cancelled':'queued'):!model_started?'unknown':result.status==='completed'?'completed':result.status==='blocked'?'blocked':'unknown'
        this.budget.finish(batch.reservation_id,{outcome:!model_started?'not_started':status==='completed'?'completed':'unknown'})
      }
      if(!started&&status==='unknown'&&!reason)reason='runner未确认实际开始或完成，保留未知状态，不自动重放'
      // A bad coordinate or rejected single action must not freeze the whole
      // platform. The common gate reads the provider's actual risk state.
      for(const original of tasks){const task=this._get(original.id,true),metadata={...task.metadata,last_error:reason,lease_token:'',lease_until:0,not_started:!started,...(result.required_cost_nano?{required_cost_nano:result.required_cost_nano}:{}),completed_at:status==='queued'?null:this._now()};this.store.db.prepare('UPDATE actions SET status=?,updated_at=?,not_before=?,metadata_json=? WHERE id=?').run(status,this._now(),retry_at,encode(metadata),task.id);this._event({...task,status,metadata},'finished')}
      return {status,reason,task_ids:tasks.map(task=>task.id)}
    })
  }
  _failClosed(batch,lease_token,result){
    return this.store.transaction(()=>{
      const tasks=this._batchRows(batch,lease_token),model_started=tasks.some(task=>task.metadata.model_started)
      const known_usage=batch.execution==='model'&&Number.isSafeInteger(result.total_tokens)&&result.total_tokens>0
      if(batch.execution==='model'){
        // Exact provider usage is still accounted for when a host runner broke
        // the start/result protocol. It never authorizes a retry or a send.
        if(known_usage)this.budget.recordUsage(batch.reservation_id,{total_tokens:result.total_tokens})
        this.budget.finish(batch.reservation_id,{outcome:model_started||known_usage?'unknown':'not_started'})
      }
      for(const task of tasks){const metadata={...task.metadata,lease_token:'',lease_until:0,completed_at:this._now(),last_error:'runner回执未通过校验；保留未知结果，不自动重放',not_started:!model_started&&!known_usage,
        ...(known_usage?{actual_tokens:Math.max(task.metadata.actual_tokens??0,result.total_tokens),usage_known:true}:{})};this.store.db.prepare("UPDATE actions SET status='unknown',updated_at=?,metadata_json=? WHERE id=?").run(this._now(),encode(metadata),task.id);this._event({...task,status:'unknown',metadata},'invalid_result')}
      return {status:'unknown',reason:'runner回执未通过校验；原预算已按已知用量或是否开始结算，不重放',task_ids:tasks.map(task=>task.id)}
    })
  }
  async tick(options={}){
    fields(options,['idle','platform','execution']);if(options.idle!==undefined&&typeof options.idle!=='boolean')throw new Error('idle必须为布尔值');if(options.platform!==undefined)choice(options.platform,PLATFORMS,'平台');if(options.execution!==undefined)choice(options.execution,['model','publication'],'执行阶段');this.store._write()
    const claim=this._claim(options)
    if(!claim.batch)return {dispatched:false,...claim}
    const {batch,lease_token}=claim,controller=new AbortController(),timeout_ms=this._policy().batching?.task_timeout_ms??600000
    let timer,result
    const controls={signal:controller.signal,mark_started:()=>this._markStarted(batch,lease_token),record_usage:usage=>{fields(usage,['total_tokens']);return this._recordUsage(batch,usage.total_tokens)}}
    const runner=batch.execution==='publication'?this.publication_runner:this.runner
    const packet=batch.execution==='publication'?{...batch,publication:this._publication(this._get(batch.tasks[0].id,true))}:batch
    try{
      const running=Promise.resolve().then(()=>runner(packet,controls));running.catch(()=>{})
      result=await Promise.race([running,new Promise(resolve=>{timer=setTimeout(()=>{controller.abort();resolve({status:'unknown',reason:'活动执行超时，结果未知，不自动重放'})},timeout_ms)})])
      if(!isPlainObject(result))result={status:'unknown',reason:'runner未返回明确执行状态'}
    }catch(error){
      const started=this._get(batch.tasks[0].id,true)?.metadata.dispatch_started===true
      result={status:started?'unknown':'not_started',reason:text(String(error?.message??'执行异常').slice(0,2000),'runner error',2000)}
    }finally{clearTimeout(timer)}
    try{return {dispatched:true,batch_id:batch.id,platform:batch.platform,execution:batch.execution,...this._finish(batch,lease_token,result)}}catch(error){
      // Another process may have expired this lease. Late real usage can still
      // settle its original reservation, but it cannot restart or resend it.
      if(result.total_tokens!==undefined){try{this._recordUsage(batch,result.total_tokens)}catch{}}
      try{return {dispatched:true,batch_id:batch.id,platform:batch.platform,execution:batch.execution,...this._failClosed(batch,lease_token,result)}}catch{}
      return {dispatched:true,batch_id:batch.id,platform:batch.platform,status:'unknown',reason:'活动租约已结束，保留原状态，不自动重放'}
    }
  }
  status(){
    const now=this._now(),p=this._policy(),state=this._state(),budget=this.budget.status(),tasks=this._list()
    const events=tasks.map(task=>{
      let gate
      if(task.status==='queued')gate=this._gate(task,state,p)
      else if(task.status==='blocked')gate={reason:'platform_blocked',next_eligible_at:this._block(state,task.platform)?.until??null}
      else if(task.status==='draft')gate={reason:'approval_required',next_eligible_at:null}
      else gate={reason:task.status,next_eligible_at:null}
      if(gate.reason==='ready'&&task.metadata.execution==='model'&&(task.metadata.trigger==='autonomous'&&budget.autonomous_wakes>=budget.daily_wake_limit||task.metadata.trigger!=='manual'&&budget.tokens+budget.reserved_tokens+task.metadata.estimated_tokens>budget.daily_token_limit))gate={reason:'budget',next_eligible_at:shanghaiTime(now).midnight+86400000}
      const display_status=gate.reason==='platform_blocked'?'blocked':ACTIVE.includes(task.status)?'running':task.status
      return {id:task.id,platform:task.platform,kind:task.kind,status:task.status,display_status,execution:task.metadata.execution,trigger:task.metadata.trigger,created_at:task.created_at,updated_at:task.updated_at,not_before:task.not_before,batch_id:task.metadata.batch_id??'',...(task.target.round_limits?{round_limits:{...task.target.round_limits}}:{}),reason:task.metadata.last_error||gate.reason,next_eligible_at:gate.next_eligible_at}
    })
    const counters={queued:0,running:0,blocked:0,draft:0,unknown:0,completed:0}
    for(const task of events)if(Object.hasOwn(counters,task.display_status))counters[task.display_status]++
    const active=tasks.filter(task=>ACTIVE.includes(task.status)),concurrency={model_limit:p.batching?.max_concurrent??1,model_limit_per_platform:p.batching?.max_per_platform??1,publication_limit_per_platform:1,
      platforms:Object.fromEntries(PLATFORMS.map(platform=>[platform,{models:new Set(active.filter(task=>task.platform===platform&&task.metadata.execution==='model').map(task=>task.metadata.batch_id||task.id)).size,publications:active.filter(task=>task.platform===platform&&task.metadata.execution==='publication').length}]))}
    return {enabled:p.enabled===true,now,phase:valleyDecision(now,p),budget,...(this.money?{money_budget:this.money.status()}:{}),concurrency,counters,blocks:state.value.blocks.filter(row=>row.until===null||row.until===undefined||row.until>now),idle:state.value.idle,
      next_eligible_at:events.map(row=>row.next_eligible_at).filter(Number.isSafeInteger).sort((a,b)=>a-b)[0]??null,tasks:events}
  }
}
