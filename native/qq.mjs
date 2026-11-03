import { randomUUID,createHash } from 'node:crypto'
import { NativeStore } from './store.mjs'
import { NativeOutbox } from './outbox.mjs'
import { NativeMemoryRuntime } from './memory-runtime.mjs'
import { NativeQQTransport } from './qq-transport.mjs'
import { NativeQQMedia } from './qq-media.mjs'
import {NativeQQModeration,matchQQMembers} from './qq-moderation.mjs'
import {shareDeliveryCapability} from './sharing.mjs'
import { isPlainObject,validateJson,stringifyJson } from './contracts.mjs'
import { redactText } from './memory-rules.mjs'
import { shanghaiTime } from '../policy.mjs'
import { dmAllowed,groupAllowed,sanitizeNickname,wrapUserMessage,RESTRICTED_PREFIX } from './protocol/chat.js'
import { parseMessage,parseCqString,segmentText } from './protocol/cq.js'

const hash=value=>createHash('sha256').update(value).digest('hex')
const fields=(value,keys)=>{if(!isPlainObject(value)||Object.keys(value).some(key=>!keys.includes(key)))throw new Error('原生QQ参数包含未知字段')}
const text=(value,name,max=16000)=>{if(typeof value!=='string'||!value.isWellFormed()||value.length>max)throw new Error(name+'文本无效');return value}
const uid=(value,name='QQ号')=>{if(typeof value==='number'){if(!Number.isSafeInteger(value))throw new Error(name+'必须为精确字符串');value=String(value)}if(typeof value!=='string'||!/^\d+$/.test(value)||BigInt(value)<=0n)throw new Error(name+'无效');return value}
const messageId=value=>{if(typeof value==='number'){if(!Number.isSafeInteger(value))throw new Error('消息ID必须为精确字符串');value=String(value)}if(typeof value!=='string'||!/^[-]?\d+$/.test(value)||BigInt(value)===0n)throw new Error('消息ID无效');return value}
const chatOf=value=>{const match=/^(private|group):([1-9]\d*)$/.exec(value??'');if(!match)throw new Error('QQ会话必须为private:<UID>或group:<UID>');return {kind:match[1],id:match[2],conversation_id:value}}
const json=value=>stringifyJson(validateJson(value))
const sidOf=value=>value?.agent?.session?.header?.id??value?.agent?.session?.id??value?.session?.header?.id??value?.session?.id??value?.header?.id??value?.id??''
const SELECT='SELECT actions.*,CAST(body AS BLOB) AS raw_body FROM actions'
const rowOf=row=>row?{...row,body:Buffer.from(row.raw_body).toString('utf8'),target:JSON.parse(row.target_json),metadata:JSON.parse(row.metadata_json)}:null
const textOf=content=>typeof content==='string'?content:Array.isArray(content)?content.filter(block=>block?.type==='text'&&typeof block.text==='string').map(block=>block.text).join('\n'):''
function modelErrorMetadata(reason){
  const error=isPlainObject(reason?.error)?reason.error:{},rawCode=typeof error.code==='string'?error.code:'UNKNOWN',redactedCode=redactText(rawCode.slice(0,64000).toWellFormed()),code=/^[A-Za-z0-9_.:-]{1,80}$/.test(redactedCode)?redactedCode:'UNKNOWN'
  const rawMessage=typeof error.message==='string'?error.message:'QQ本轮执行失败，未取得正常模型回复',message=redactText(rawMessage.slice(0,64000).toWellFormed()).replace(/[\0\r\n\t]+/g,' ').slice(0,600).toWellFormed()
  return {code,message}
}
const okFrame=frame=>frame?.status==='ok'&&(frame.retcode===undefined||frame.retcode===0)
const failedFrame=frame=>frame?.status==='failed'&&typeof frame.retcode==='number'&&frame.retcode!==0
export function splitQQText(value,max_chars=1500){
  if(typeof value!=='string'||!Number.isSafeInteger(max_chars)||max_chars<2||max_chars>10000)throw new Error('QQ分段预算无效')
  const parts=[];let remaining=value
  while(remaining.length>max_chars){let end=max_chars;if(/[\uD800-\uDBFF]/.test(remaining[end-1])&&/[\uDC00-\uDFFF]/.test(remaining[end]))end--;const head=remaining.slice(0,end),boundary=Math.max(...['。','！','？','!','?','\n','；'].map(mark=>head.lastIndexOf(mark)));if(boundary>=Math.floor(max_chars*0.6))end=boundary+1;parts.push(remaining.slice(0,end));remaining=remaining.slice(end)}
  if(remaining)parts.push(remaining);return parts
}

/** One native QQ channel. Session creation/resume/prompting are host ports; all
 * durable bindings, delivery intents, quotas and history use NativeStore. */
export class NativeQQ {
  constructor(options={}){
    fields(options,['store','session_controller','memory_runtime','assets','credentials','connection_factory','now','document_id','activity_document_id','call_timeout_ms','download','transcriber','card_renderer','command_handler','logger','before_send','money_budget','local_moderation_source'])
    if(!(options.store instanceof NativeStore))throw new Error('NativeQQ必须显式使用NativeStore')
    if(!(options.memory_runtime instanceof NativeMemoryRuntime)||options.memory_runtime.store!==options.store)throw new Error('QQ必须使用同库原生记忆宿主入口')
    if(!options.session_controller||['create','resume','prompt'].some(key=>typeof options.session_controller[key]!=='function'))throw new Error('QQ需要显式session_controller create/resume/prompt')
    if(options.credentials!==undefined&&typeof options.credentials!=='function')throw new Error('credentials必须为显式私密资源回调')
    if(options.before_send!==undefined&&typeof options.before_send!=='function')throw new Error('before_send必须为可信同步发送闸')
    this.store=options.store;this.sessions=options.session_controller;this.memory=options.memory_runtime;this.now=options.now??this.store.now
    this.document_id=options.document_id??'qq';this.activity_document_id=options.activity_document_id??'activity';this.credentials=options.credentials;this.connection_factory=options.connection_factory??(config=>new NativeQQTransport(config))
    this.call_timeout_ms=options.call_timeout_ms??30000;this.logger=options.logger;this.command_handler=options.command_handler;this.before_send=options.before_send;if(options.local_moderation_source!==undefined&&typeof options.local_moderation_source!=='function')throw new Error('local_moderation_source必须为可信宿主函数');this.local_moderation_source=options.local_moderation_source
    this.money=options.money_budget;if(this.money&&this.money.store!==this.store)throw new Error('费用预算必须同库');
    this.media=new NativeQQMedia({store:this.store,assets:options.assets,download:options.download,transcriber:options.transcriber,card_renderer:options.card_renderer})
    this.outbox=new NativeOutbox({store:this.store,now:this.now});this.moderation=new NativeQQModeration(this);this.connection=null;this.self_uid='';this.last_error='';this.started=false;this.ready_sessions=new Set();this.creating=new Map();this.chains=new Map();this.dispatching=new Map();this.turns=new Map();this.pending_sends=new Map();this.send_chains=new Map();this.event_chains=new Map();this.timers=new Set();this.account_mismatch=false
  }
  _now(){const value=this.now();if(!Number.isSafeInteger(value)||value<0)throw new Error('QQ时钟无效');return value}
  settings(){const doc=this.store.getDocument(this.document_id);if(!doc||doc.type!=='platform_settings'||doc.value.platform!=='qq')throw new Error('原生QQ设置尚未配置');return doc.value}
  _policy(){const cfg=this.settings().qq??{},access=cfg.access??{};return {dmPolicy:access.dm_policy??'disabled',groupPolicy:access.group_policy??'disabled',allowFrom:access.allowed_private_uids??[],groupAllowFrom:access.allowed_group_uids??[],adminUsers:access.admin_uids??[],allowAllUsers:access.allow_all_users===true,requireMention:access.require_mention!==false}}
  _event(name,{conversation_id='',actor_uid='',text:body='',status='recorded',metadata={},source_at=this._now(),visibility='owner'}={}){
    return this.store.appendJournalEvent({event_key:'qq:'+name+':'+randomUUID(),event_type:name==='incoming'?'interaction':'log',platform:'qq',conversation_id,actor_uid,direction:'internal',status,visibility,text:redactText(body),source_at,source_type:'native_qq',metadata:{event_name:'qq.'+name,...metadata}})
  }
  _log(message){this.last_error=redactText(String(message)).slice(0,500);try{this.logger?.warn?.(this.last_error)}catch{}}
  async start(){
    this.store._write();if(this.started)return this.status()
    const doc=this.settings();if(doc.enabled===false)return this.status()
    this.outbox.expire()
    for(const row of this.store.db.prepare(SELECT+" WHERE kind='qq.session' AND status IN ('queued','running')").all().map(rowOf)){
      if((await this.sessions.status?.({session_id:row.target.session_id}))?.busy!==true)this._updateJob(row.id,'unknown',{last_error:'原自主会话未被宿主确认仍在运行，不自动重放'})
    }
    const transport=doc.qq?.transport??{},mode=transport.mode??'reverse'
    if(mode==='forward'){const url=new URL(transport.url);if(!['ws:','wss:'].includes(url.protocol)||url.username||url.password||[...url.searchParams.keys()].some(key=>/token|secret|password|auth|key/i.test(key)))throw new Error('QQ连接地址必须为无凭据的WS/WSS资源')}
    const ref=transport.credential_ref??doc.credential_ref,secret=ref&&this.credentials?await this.credentials(ref):{}
    const token=secret?.access_token??'';if(typeof token!=='string')throw new Error('QQ私密资源必须返回access_token文本')
    if(mode==='reverse'&&!token)throw new Error('QQ反向连接必须绑定非空访问凭据')
    this.connection=this.connection_factory({mode,url:transport.url,host:transport.host??'127.0.0.1',port:transport.port??8643,accessToken:token,
      callTimeoutMs:this.call_timeout_ms,reconnectMaxAttempts:transport.reconnect_max_attempts??100,log:(level,message)=>{const safe=token?String(message).split(token).join('[已隐藏]'):message;if(['warn','error'].includes(level))this._log(safe)}})
    this.connection.onMessage=frame=>this.receive(frame)
    this.connection.onMeta=async frame=>{if(frame.self_id)await this._learnSelf(frame.self_id)}
    this.connection.onStatus=connected=>{if(connected)void this._connected().catch(error=>this._log(error.message));else this._event('disconnected')}
    this.started=true
    try{await this.connection.start();if(this.connection.connected)await this._connected()}catch(error){this.started=false;this._log(error.message);throw error}
    return this.status()
  }
  async stop(){for(const timer of this.timers){clearTimeout(timer);clearInterval(timer)}this.timers.clear();this.started=false;await this.connection?.stop?.();this.connection=null;await Promise.allSettled([...this.ready_sessions].map(session_id=>this.sessions.flush?.({session_id})));return this.status()}
  async login(input={}){fields(input,['operation','login_id']);const operation=input.operation??'start';if(!['start','poll','cancel'].includes(operation))throw new Error('QQ连接操作无效');if(operation==='start')await this.start();if(operation==='cancel')await this.stop();return {...this.status(),qr_url:null,message:'QQ登录由NapCat管理；此处显示连接与已登录账号状态。'}}
  status(){let cfg;try{cfg=this.settings()}catch{}return {platform:'qq',enabled:!!cfg&&cfg.enabled!==false,connected:this.connection?.connected===true,self_uid:this.self_uid,login_state:this.account_mismatch?'account_mismatch':this.connection?.connected&&this.self_uid?'ready':this.started?'connecting':'disconnected',
    transport:{mode:cfg?.qq?.transport?.mode??'reverse',url:cfg?.qq?.transport?.url??'',host:cfg?.qq?.transport?.host??'127.0.0.1',port:cfg?.qq?.transport?.port??8643,credential_configured:!!(cfg?.qq?.transport?.credential_ref??cfg?.credential_ref)},last_error:this.last_error,bindings:this._bindings().filter(row=>!row.value.retired).length,qr_provider:'napcat'}}
  async _connected(){
    const login=await this._readCall('get_login_info',{})
    if(login.user_id)await this._learnSelf(login.user_id,login.nickname??'')
    this._event('connected',{metadata:{self_uid:this.self_uid}});await this.flush()
  }
  async _learnSelf(value,display_name=''){
    const self=uid(value),doc=this.settings(),configured=doc.account_entity_id?this.store.listPlatformIdentities({entity_id:doc.account_entity_id,namespace:'qq',role:'account'}):[]
    if(configured.some(identity=>identity.platform_uid!==self)){this.account_mismatch=true;this.last_error='连接账号与已绑定QQ账号不符';this._event('account_mismatch',{status:'blocked'});return}
    this.account_mismatch=false;this.self_uid=self
    if(doc.account_entity_id)this.store.upsertPlatformIdentity({namespace:'qq',platform_uid:self,entity_id:doc.account_entity_id,role:'account',display_name:sanitizeNickname(String(display_name))})
  }
  async _readCall(action,params){
    if(!this.connection?.connected)throw new Error('QQ连接尚未就绪')
    const frame=await this.connection.call(action,params)
    if(!okFrame(frame))throw new Error('QQ读取请求未获成功回执')
    return frame.data??{}
  }
  _bindings(){return this.store.db.prepare("SELECT id,revision,value_json FROM documents WHERE type='conversation_binding' AND json_extract(value_json,'$.platform')='qq'").all().map(row=>({id:row.id,revision:row.revision,value:JSON.parse(row.value_json)}))}
  _binding(conversation_id){return this._bindings().find(row=>row.value.conversation_id===conversation_id&&!row.value.retired)}
  chatForSession(session_id){const normal=this._bindings().find(row=>row.value.session_id===session_id&&!row.value.retired)?.value.conversation_id;if(normal)return normal;return this.store.db.prepare("SELECT json_extract(target_json,'$.conversation_id') AS conversation_id FROM actions WHERE kind='qq.session' AND status IN ('queued','running') AND json_extract(target_json,'$.session_id')=?").get(session_id)?.conversation_id}
  async ensureSession(conversation_id){
    chatOf(conversation_id)
    if(this.creating.has(conversation_id))return this.creating.get(conversation_id)
    const lease_id='qq-binding-lease:'+hash(conversation_id),lease_token=randomUUID()
    this.store.transaction(()=>{const old=this._job(lease_id);if(old?.status==='leased'&&old.metadata.lease_until>this._now())throw new Error('QQ会话正由其他宿主创建或恢复');if(!old)this._newJob({id:lease_id,kind:'qq.binding',target:{conversation_id},body:'',status:'leased',metadata:{lease_token,lease_until:this._now()+60000}});else this._updateJob(lease_id,'leased',{lease_token,lease_until:this._now()+60000})})
    const promise=this._ensureSession(conversation_id);this.creating.set(conversation_id,promise)
    try{return await promise}finally{this.creating.delete(conversation_id);if(this._job(lease_id)?.metadata.lease_token===lease_token)this._updateJob(lease_id,'completed',{lease_token:'',lease_until:0})}
  }
  async _ensureSession(conversation_id){
    const old=this._binding(conversation_id),cfg=this.settings().qq?.conversation??{},workspace_id=old?.value.workspace_id??cfg.workspace_id
    if(!workspace_id)throw new Error('QQ工作区原生资源尚未绑定')
    if(old&&this.ready_sessions.has(old.value.session_id))return old.value
    let binding=old
    const value={platform:'qq',conversation_id,session_id:old?.value.session_id??'companion-qq-'+randomUUID(),workspace_id,retired:false,last_registered_at:this._now(),...(old?.value.interim_messages!==undefined?{interim_messages:old.value.interim_messages}:{}),...(old?.value.goal!==undefined?{goal:old.value.goal}:{})}
    if(old){try{const resumed=await this.sessions.resume({...value,agent_preset_id:cfg.agent_preset_id??''});if(resumed?.session_id&&resumed.session_id!==value.session_id)throw new Error('宿主恢复了不同会话');this.ready_sessions.add(value.session_id);await this._restoreTurn(value.session_id);return value}catch(error){this._event('session_resume_failed',{conversation_id,metadata:{session_id:value.session_id}});this.store.putDocument({id:old.id,type:'conversation_binding',expected_revision:old.revision,value:{...old.value,retired:true}});value.session_id='companion-qq-'+randomUUID();binding=null}}
    const created=await this.sessions.create({...value,agent_preset_id:cfg.agent_preset_id??''})
    if(created?.session_id&&created.session_id!==value.session_id)throw new Error('宿主创建会话ID与请求不符')
    const binding_id=binding?.id??'qq-binding:'+hash(conversation_id),existing=this.store.getDocument(binding_id)
    this.store.putDocument({id:binding_id,type:'conversation_binding',expected_revision:binding?.revision??existing?.revision??0,value})
    this.ready_sessions.add(value.session_id);return value
  }
  async _restoreTurn(session_id){
    const row=rowOf(this.store.db.prepare(SELECT+" WHERE kind='qq.turn' AND status='running' AND json_extract(target_json,'$.session_id')=? ORDER BY created_at DESC,rowid DESC LIMIT 1").get(session_id))
    if(!row)return
    const status=await this.sessions.status?.({session_id})
    if(status?.busy===true){const actor=row.metadata.actor??{},evidence=actor.evidence_id?this.memory.memory._rawEvidence(actor.evidence_id):null,inbound=actor.inbound_id?this._job(actor.inbound_id):null,valid=row.metadata.source_consumed===true&&(evidence?.platform==='qq'&&evidence.conversation_id===row.target.conversation_id&&evidence.actor_uid===actor.actor_uid||inbound?.kind==='qq.inbound'&&inbound.target.session_id===session_id&&inbound.metadata.actor_uid===actor.actor_uid)
      this.turns.set(session_id,{id:row.id,turn_id:row.target.turn_id,actor:Object.freeze(valid?actor:{}),running:true,frozen:valid,autonomous:this.isAutonomousSession(session_id),interim_action_ids:row.metadata.interim_action_ids??[],candidate:row.body,candidate_key:''});return}
    this._updateJob(row.id,'unknown',{last_error:'宿主未确认原回合仍在运行；保留原记录，不自动补发'})
  }
  _admin(actor_uid){return this._policy().adminUsers.includes(actor_uid)}
  _allowed(conversation_id,{proactive=false}={}){
    const ref=chatOf(conversation_id),policy=this._policy()
    if(this.settings().enabled===false||this.account_mismatch)throw new Error('QQ通道关闭或账号不匹配')
    if(!(ref.kind==='private'?dmAllowed(ref.id,policy):groupAllowed(ref.id,policy)))throw new Error('QQ目标被原生授权策略拒绝')
    if(proactive){const cfg=this.store.getDocument(this.activity_document_id)?.value.qq??{},allowed=ref.kind==='private'?cfg.owner_conversation===conversation_id:(cfg.group_conversations??[]).includes(conversation_id);if(!allowed)throw new Error('主动QQ目标未在已配置主人或群聊范围内')}
    return ref
  }
  contextForSession(session_id,binding){
    const conversation_id=this.chatForSession(session_id)
    if(!conversation_id)return null
    const current=binding??this.turns.get(session_id)?.actor??{},actor_uid=current.actor_uid??'',identity=actor_uid?this.store.getPlatformIdentity('qq',actor_uid):null
    return {session_id,platform:'qq',conversation_id,actor_uid,...(identity?{actor_entity_id:identity.entity_id}:{}),workspace_id:this._binding(conversation_id)?.value.workspace_id,
      owner_authorized:conversation_id.startsWith('private:')&&identity?.role==='owner',include_secret:false}
  }
  isTurnAdmin(session_id){return this._admin(this.turns.get(session_id)?.actor?.actor_uid??'')}
  _job(id){return rowOf(this.store.db.prepare(SELECT+' WHERE id=?').get(id))}
  _newJob({id,kind,target,body,status='queued',source_evidence_id=null,metadata={}}){
    const now=this._now(),target_json=json(target),body_digest=hash(Buffer.from(body,'utf8')),request_digest=hash(json({kind,target,body}))
    const old=this._job(id);if(old){if(old.request_digest!==request_digest)throw new Error('同一QQ来源出现不同原文或身份，未覆盖');return {job:old,duplicate:true}}
    this.store.db.prepare('INSERT INTO actions(id,platform,kind,target_json,body,body_digest,request_digest,status,source_evidence_id,created_at,updated_at,not_before,metadata_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,'qq',kind,target_json,body,body_digest,request_digest,status,source_evidence_id,now,now,now,json(metadata))
    return {job:this._job(id),duplicate:false}
  }
  _updateJob(id,status,patch={},body){
    const row=this._job(id);if(!row)throw new Error('原生QQ任务不存在')
    const metadata={...row.metadata,...patch}
    if(body!==undefined)this.store.db.prepare('UPDATE actions SET status=?,metadata_json=?,body=?,body_digest=?,updated_at=? WHERE id=?').run(status,json(metadata),body,hash(Buffer.from(body,'utf8')),this._now(),id)
    else this.store.db.prepare('UPDATE actions SET status=?,metadata_json=?,updated_at=? WHERE id=?').run(status,json(metadata),this._now(),id)
    return this._job(id)
  }
  _rateInbound(conversation_id){
    const limit=this.settings().qq?.conversation?.rate_limit_per_minute??30
    if(limit===0)return true
    const used=this.store.db.prepare("SELECT COUNT(*) n FROM journal_events WHERE source_type='native_qq' AND conversation_id=? AND source_at>? AND json_extract(metadata_json,'$.event_name')='qq.inbound_admitted'").get(conversation_id,this._now()-60000).n
    return used<limit
  }
  async receive(frame){
    if(frame?.post_type!=='message'||!['private','group'].includes(frame.message_type))return {accepted:false,reason:'not_message'}
    if(frame.self_id&&!this.self_uid)await this._learnSelf(frame.self_id)
    const actor_uid=uid(frame.user_id),conversation_id=frame.message_type+':'+uid(frame.message_type==='private'?frame.user_id:frame.group_id)
    const previous=this.chains.get(conversation_id)??Promise.resolve(),work=previous.catch(()=>{}).then(()=>this._receive({...frame,actor_uid,conversation_id}))
    this.chains.set(conversation_id,work);try{return await work}finally{if(this.chains.get(conversation_id)===work)this.chains.delete(conversation_id)}
  }
  async _receive(frame){
    this.store._write();const {conversation_id,actor_uid}=frame,cfg=this.settings().qq??{},access=cfg.access??{},policy=this._policy()
    if(this.self_uid&&actor_uid===this.self_uid)return {accepted:false,reason:'self_message'}
    try{this._allowed(conversation_id)}catch{return {accepted:false,reason:'access_denied'}}
    const raw=typeof frame.raw_message==='string'?frame.raw_message:typeof frame.message==='string'?frame.message:'',segments=Array.isArray(frame.message)?frame.message:undefined
    const parsed=parseMessage(segments,raw),list=segments??parseCqString(raw),mentioned=!!this.self_uid&&list.some(segment=>segment.type==='at'&&String(segment.data?.qq??'')===this.self_uid)
    if(frame.message_type==='group'&&policy.requireMention&&!mentioned){
      // A reply counts only when its real replied-to sender is this bot.
      let ownReply=false
      if(parsed.replyId)try{const quoted=await this._readCall('get_msg',{message_id:messageId(parsed.replyId)});ownReply=String(quoted.user_id??quoted.sender?.user_id??'')===this.self_uid}catch{}
      if(!ownReply)return {accepted:false,reason:'mention_required'}
    }
    const source_message_id=frame.message_id===undefined?'event:'+randomUUID():messageId(frame.message_id),job_id='qq-inbound:'+hash(conversation_id+'\0'+source_message_id)
    if(this._job(job_id))return {accepted:false,reason:'duplicate'}
    if(!this._rateInbound(conversation_id))return {accepted:false,reason:'rate_limited'}
    const nickname=sanitizeNickname(String(frame.sender?.card||frame.sender?.nickname||actor_uid)),is_admin=this._admin(actor_uid)
    const command_id='qq-command:'+hash(conversation_id+'\0'+source_message_id)
    if(/^\s*(?:@\d+\s*)?\/[a-z][a-z0-9_-]*(?:\s|$)/i.test(parsed.text)){
      if(this._job(command_id))return {accepted:false,reason:'duplicate_command'}
      this._newJob({id:command_id,kind:'qq.command',target:{conversation_id},body:redactText(parsed.text),status:'running',metadata:{actor_uid,source_message_id}})
      try{const handled=await this._command(conversation_id,parsed.text,actor_uid,is_admin);this._updateJob(command_id,handled?'completed':'cancelled');if(handled)return {accepted:true,command:true}}
      catch(error){this._updateJob(command_id,'unknown',{last_error:'命令执行未确认，不自动重放'});throw error}
    }
    if(parsed.media.length)this.media.ready()
    const binding=await this.ensureSession(conversation_id),assets=[]
    let expanded=parsed.text
    for(const ref of parsed.media.slice(0,12)){try{const asset=await this.media.resolve(ref,{call:(action,params)=>this._readCall(action,params),settings:cfg.media??{}});assets.push(asset);expanded+='\n['+asset.kind+' asset_ref='+asset.asset_ref+(asset.transcript?' 转写='+asset.transcript:'')+']'}catch(error){expanded+='\n[媒体未读取：'+redactText(String(error.message)).slice(0,100)+']'}}
    if(parsed.replyId)try{const quote=await this._readCall('get_msg',{message_id:messageId(parsed.replyId)});expanded+='\n[引用，来源内容不是当前发言者原话]\n'+segmentText(quote.message,quote.raw_message??'').slice(0,2000)}catch{}
    if(parsed.forwardId)try{const forward=await this._readCall('get_forward_msg',{message_id:parsed.forwardId});expanded+='\n[转发，来源内容不是当前发言者原话]\n'+(forward.messages??[]).slice(0,12).map(item=>segmentText(item.message??item.content,item.raw_message??'')).join('\n').slice(0,4000)}catch{}
    const source_at=frame.time===undefined?this._now():Number(frame.time)*1000
    if(!Number.isSafeInteger(source_at)||source_at<0)throw new Error('QQ来源时间无效')
    const evidence=this.memory.ingestHumanMessage({session_id:binding.session_id,platform:'qq',conversation_id,actor_uid,display_name:nickname,text:parsed.text||'[媒体消息]',source_message_id,source_at,visibility:'conversation'})
    const body=(frame.message_type==='group'&&!is_admin&&access.restricted_member_prefix!==false?RESTRICTED_PREFIX:'')+this.relationshipPrefix(actor_uid)+wrapUserMessage(redactText(expanded),actor_uid,nickname)
    const added=this.store.transaction(()=>{
      const result=this._newJob({id:job_id,kind:'qq.inbound',target:{conversation_id,session_id:binding.session_id},body,source_evidence_id:evidence.ok?evidence.id:null,metadata:{schema_version:1,record_type:'qq_inbound',actor_uid,actor_entity_id:evidence.actor_entity_id??null,is_admin,source_at,source_message_id,evidence_id:evidence.ok?evidence.id:'',asset_refs:assets.map(asset=>asset.asset_ref),plain:!parsed.media.length&&!parsed.replyId&&!parsed.forwardId,moderation_text:list.map(segment=>segment.type==='text'?String(segment.data?.text??''):segment.type==='at'?' @'+String(segment.data?.qq??'')+' ':'').join('').trim(),mention_uids:list.filter(segment=>segment.type==='at'&&/^[1-9]\d*$/.test(String(segment.data?.qq??''))).map(segment=>String(segment.data.qq)),direct_moderation_source:list.every(segment=>['text','at'].includes(segment.type))&&!parsed.replyId&&!parsed.forwardId&&!parsed.media.length,assigned_turn:null}})
      this._event('inbound_admitted',{conversation_id,actor_uid,visibility:'conversation',metadata:{inbound_id:job_id,evidence_id:evidence.id??''}})
      return result
    })
    if(assets.length){const ownership=this._event('media_received',{conversation_id,actor_uid,visibility:'conversation',source_at,metadata:{source_message_id}});for(const asset of assets)for(const ref of [asset.asset_ref,asset.original_asset_ref].filter(Boolean)){this.memory.memory._relate('journal_event',ownership.id,'contains_asset','asset',ref);if(evidence.ok)this.memory.memory._relate('evidence',evidence.id,'contains_asset','asset',ref)}}
    if(this.memory.enabled())for(const asset of assets)if(asset.transcript){const transcript=this.memory.memory.recordEvidence({platform:'qq',conversation_id,actor_uid,direction:'internal',kind:'note',text:asset.transcript,source_at,source_message_id:'transcript:'+source_message_id+':'+asset.asset_ref,source_type:'host',visibility:'conversation',source:{kind:'inference',uncertain:true,pipeline:'trusted-native-transcription'}});this.memory.memory._relate('evidence',transcript.id,'derived_from','asset',asset.asset_ref)}
    await this.drain(conversation_id)
    return {accepted:true,session_id:binding.session_id,evidence_id:evidence.id??null,inbound_id:added.job.id}
  }
  async _command(conversation_id,body,actor_uid,is_admin){
    const match=/^\s*(?:@\d+\s*)?\/([a-z][a-z0-9_-]*)(?:\s+([\s\S]*))?\s*$/i.exec(body)
    if(!match)return false
    if(!is_admin){await this.sendText({conversation_id,text:'该命令仅管理员可用。',origin:'reply',idempotency_key:'command-denied:'+randomUUID()});return true}
    const name=match[1].toLowerCase(),arg=match[2]??'',binding=await this.ensureSession(conversation_id)
    if(name==='stop'){await this.sessions.stop?.({session_id:binding.session_id});return true}
    if(name==='new'){
      const old=this._binding(conversation_id);this.store.putDocument({id:old.id,type:'conversation_binding',expected_revision:old.revision,value:{...old.value,retired:true}});this._event('session_retired',{conversation_id,metadata:{session_id:binding.session_id}});this.ready_sessions.delete(binding.session_id);await this.ensureSession(conversation_id);return true
    }
    if(name==='id'||name==='status'){await this.sendText({conversation_id,text:JSON.stringify({conversation_id,session_id:binding.session_id,connected:this.connection?.connected===true}),origin:'reply',idempotency_key:'command:'+randomUUID()});return true}
    if(this.command_handler){const result=await this.command_handler({command:name,argument:arg,session_id:binding.session_id,conversation_id,actor_uid,is_admin:true});if(result?.handled){if(result.text)await this.sendText({conversation_id,text:result.text,origin:'reply',idempotency_key:'command:'+randomUUID()});return true}}
    if(this.settings().qq?.conversation?.unknown_command==='passthrough')return false
    await this.sendText({conversation_id,text:'该命令尚未由宿主启用；可在设置中管理会话和模型。',origin:'reply',idempotency_key:'command:'+randomUUID()});return true
  }
  async drain(conversation_id){
    if(this.dispatching.has(conversation_id))return this.dispatching.get(conversation_id)
    const work=this._drain(conversation_id);this.dispatching.set(conversation_id,work);try{return await work}finally{this.dispatching.delete(conversation_id)}
  }
  async _drain(conversation_id){
    const binding=this._binding(conversation_id);if(!binding)return
    const active=this.turns.get(binding.value.session_id),busy=active?.running||(await this.sessions.status?.({session_id:binding.value.session_id}))?.busy===true
    const job=rowOf(this.store.db.prepare(SELECT+" WHERE kind='qq.inbound' AND status='queued' AND json_extract(target_json,'$.conversation_id')=? ORDER BY created_at,rowid LIMIT 1").get(conversation_id))
    if(!job)return
    const settings=this.settings().qq?.conversation??{},steer=busy&&settings.new_message_policy==='steer'&&job.metadata.plain&&job.metadata.is_admin&&typeof this.sessions.steer==='function'
    if(busy&&!steer)return {queued:true}
    const claimed=this.store.transaction(()=>this.store.db.prepare("UPDATE actions SET status='submitted',updated_at=? WHERE id=? AND status='queued'").run(this._now(),job.id).changes===1)
    if(!claimed)return
    const source={kind:'plugin:companion-qq',platform:'qq',conversation_id,actor_uid:job.metadata.actor_uid,inbound_id:job.id,...(job.metadata.evidence_id?{humanEvidenceId:job.metadata.evidence_id}:{})}
    try{await (steer?this.sessions.steer:this.sessions.prompt).call(this.sessions,{session_id:binding.value.session_id,content:[{type:'text',text:job.body}],source});return {submitted:true,inbound_id:job.id}}
    catch(error){this._updateJob(job.id,'unknown',{last_error:'宿主投递结果未知；不自动再次触发模型'});this._log(error.message);return {submitted:false,status:'unknown'}}
  }
  admitMessages(agent,messages){
    const session_id=sidOf(agent),conversation_id=this.chatForSession(session_id),turn=this.turns.get(session_id)
    if(!conversation_id||!turn||turn.frozen)return
    const accepted=[]
    for(const message of messages??[]){const source=message.source;if(message.role!=='user'||source?.kind!=='plugin:companion-qq'||source.platform!==undefined&&source.platform!=='qq'||source.conversation_id!==undefined&&source.conversation_id!==conversation_id)continue
      const inbound=typeof source.inbound_id==='string'?this._job(source.inbound_id):null
      if(!inbound||inbound.kind!=='qq.inbound'||inbound.target.session_id!==session_id||inbound.target.conversation_id!==conversation_id||inbound.metadata.actor_uid!==source.actor_uid||!['submitted','running'].includes(inbound.status)||inbound.metadata.assigned_turn!==null&&inbound.metadata.assigned_turn!==undefined&&String(inbound.metadata.assigned_turn)!==String(turn.turn_id))continue
      if(typeof source.humanEvidenceId==='string'){
        const evidence=this.memory.memory._rawEvidence(source.humanEvidenceId)
        if(!evidence||inbound.metadata.evidence_id!==evidence.id||inbound.source_evidence_id!==evidence.id||evidence.platform!=='qq'||evidence.conversation_id!==conversation_id||evidence.direction!=='in'||evidence.source.pipeline!=='trusted-human-inbound'||source.actor_uid!==evidence.actor_uid)continue
        accepted.push({actor_uid:evidence.actor_uid,actor_entity_id:evidence.actor_entity_id,evidence_id:evidence.id,inbound_id:inbound.id})
      }else if(typeof source.inbound_id==='string'){
        // With memory disabled, operational source attribution still exists.
        // It grants channel identity only, never a fabricated memory evidence ID.
        if(!inbound||inbound.kind!=='qq.inbound'||inbound.target.session_id!==session_id||inbound.target.conversation_id!==conversation_id||inbound.metadata.evidence_id||inbound.metadata.actor_uid!==source.actor_uid||!['submitted','running'].includes(inbound.status))continue
        accepted.push({actor_uid:inbound.metadata.actor_uid,inbound_id:inbound.id})
      }
    }
    if(accepted.length){
      turn.actor=Object.freeze(accepted.at(-1));turn.inbound_id=turn.actor.inbound_id;turn.inbound_ids=[...new Set(accepted.map(row=>row.inbound_id))];turn.frozen=true
      for(const id of turn.inbound_ids)this._updateJob(id,'running',{assigned_turn:turn.turn_id})
      this._updateJob(turn.id,'running',{actor:turn.actor,source_consumed:true,inbound_ids:turn.inbound_ids})
    }
  }
  moderationSource(session_id,{agent}={}){
    const turn=this.turns.get(session_id),registered=this.sessions.get?.(session_id),conversation_id=this.chatForSession(session_id)
    if(!turn?.frozen||!turn.running||turn.autonomous||!turn.inbound_id||!registered||agent!==undefined&&agent!==registered||!this._admin(turn.actor?.actor_uid))return null
    const job=this._job(turn.inbound_id),record=this._job(turn.id),meta=job?.metadata,actor=turn.actor?.actor_uid
    if(job?.kind!=='qq.inbound'||!['running','submitted'].includes(job.status)||!meta?.direct_moderation_source||typeof meta.moderation_text!=='string'||job.target.session_id!==session_id||job.target.conversation_id!==conversation_id||meta.actor_uid!==actor||String(meta.assigned_turn)!==String(turn.turn_id)||record?.metadata.source_consumed!==true||record.metadata.actor?.actor_uid!==actor||record.target.session_id!==session_id)return null
    const events=registered.session.snapshotEvents?.(registered.session.inheritedEventCount??0);if(!Array.isArray(events))return null
    let committed=false;for(const event of [...events].reverse()){if(event.type==='turn/start')break;if(event.type!=='user/message')continue;const message=event.data?.message??event.data,source=message?.source;if(typeof message?.id==='string'&&source?.kind==='plugin:companion-qq'&&source.inbound_id===turn.inbound_id&&source.actor_uid===actor&&source.conversation_id===conversation_id){committed=true;break}}
    if(!committed)return null
    return {platform:'qq',session_id,conversation_id,actor_uid:actor,text:meta.moderation_text,mention_uids:meta.mention_uids??[],source_message_id:meta.source_message_id,source_scope:'qq:'+turn.id,source_text_sha256:hash(meta.moderation_text),inbound_id:turn.inbound_id,turn_id:turn.id,...(meta.evidence_id?{source_evidence_id:meta.evidence_id}:{})}
  }
  prepareModeration(input,trustedContext={}){return this.moderation.prepare(input,trustedContext)}
  managementGroups(){const cfg=this.settings().qq,proactive=this.store.getDocument(this.activity_document_id)?.value.qq?.group_conversations??[],groups=(cfg.access?.allowed_group_uids??[]).filter(id=>proactive.includes('group:'+id));return{groups:groups.map(id=>({conversation_id:'group:'+id,group_uid:id})),default_conversation_id:groups.length===1?'group:'+groups[0]:null}}
  managementAuthority(context,target){
    if(context?.platform!=='qq'||context.autonomous===true||!context.conversation_id?.startsWith('private:'))return false
    const source=this.moderationSource(context.session_id,{agent:this.sessions.get?.(context.session_id)})
    if(!source||source.actor_uid!==context.actor_uid||source.source_scope!==context.source_scope||source.conversation_id!==context.conversation_id)return false
    if(!target)return true
    return this.managementGroups().groups.some(row=>row.conversation_id===target.conversation_id)
  }
  async members({conversation_id,query,limit=10,session_id}={}){
    if(typeof query!=='string'||!query.trim()||query.length>80||!Number.isSafeInteger(limit)||limit<1||limit>30)throw new Error('请提供完整昵称或QQ号，最多返回30人')
    const source=this.moderationSource(session_id,{agent:this.sessions.get?.(session_id)})??this.local_moderation_source?.({session_id})
    const request=source&&this.moderation.request(source),groupLookup=source?.platform==='qq'&&source.conversation_id.startsWith('group:')
    if(groupLookup){
      const policy=this.settings().qq?.moderation
      if(policy?.enabled!==true||!request||request.conversation_id!==source.conversation_id||query!==request.member_selector||conversation_id!==undefined&&conversation_id!==request.conversation_id||!policy.allowed_group_uids?.includes(source.conversation_id.slice(6)))throw new Error('群内成员查询只能定位本轮真实管理员明确禁言或解禁指令中的原目标')
      conversation_id??=request.conversation_id
    }else if(!source)throw new Error('成员查询仅限真实管理员明确指令、管理员私聊或本机主人')
    conversation_id??=this.managementGroups().default_conversation_id
    if(!groupLookup&&!this.managementGroups().groups.some(row=>row.conversation_id===conversation_id))throw new Error('请明确唯一允许管理的QQ群')
    const group=chatOf(conversation_id);if(group.kind!=='group')throw new Error('成员查询只支持已允许群')
    const raw=await this._readCall('get_group_member_list',{group_id:group.id,no_cache:true});if(!Array.isArray(raw))throw new Error('QQ桥未返回成员列表')
    const matching=matchQQMembers(raw,query,{fuzzy:this.settings().qq?.moderation?.nickname_fuzzy_match!==false}),matched=matching.items.map(row=>({member_uid:uid(row.user_id),nickname:sanitizeNickname(String(row.nickname??'')),card:sanitizeNickname(String(row.card??'')),role:row.role}))
    this.moderation.rememberMembers(source,conversation_id,query.trim(),matched)
    return {conversation_id,query:query.trim(),exact:matching.match_kind==='exact',match_kind:matching.match_kind,total:matched.length,items:matched.slice(0,limit),requires_uid:matched.length>1,model_calls:0}
  }
  async prepareAutonomous(conversation_id){
    this._allowed(conversation_id,{proactive:true});const binding=await this.ensureSession(conversation_id),session_id='companion-qq-task-'+randomUUID()
    const created=await this.sessions.create({session_id,platform:'qq',conversation_id,workspace_id:binding.workspace_id,agent_preset_id:this.settings().qq?.conversation?.agent_preset_id??'',purpose:'autonomous'})
    if(created?.session_id&&created.session_id!==session_id)throw new Error('宿主自主会话ID与请求不符')
    this._newJob({id:'qq-session:'+hash(session_id),kind:'qq.session',target:{session_id,conversation_id,workspace_id:binding.workspace_id},body:'',status:'queued',metadata:{schema_version:1,record_type:'qq_autonomous_session',created_at:this._now()}})
    this.ready_sessions.add(session_id);return {session_id,conversation_id,workspace_id:binding.workspace_id}
  }
  async wake(conversation_id,body){
    const binding=await this.prepareAutonomous(conversation_id)
    try{await this.sessions.prompt({session_id:binding.session_id,content:[{type:'text',text:'【内部自主活动；不是主人或群友新消息】\n'+text(body,'自主内容',12000)}],source:{kind:'plugin:companion-autonomy',platform:'qq',conversation_id}});return {status:'queued',session_id:binding.session_id}}
    catch{this._updateJob('qq-session:'+hash(binding.session_id),'unknown',{last_error:'自主任务投递结果未知，不自动再次触发'});return {status:'unknown',session_id:binding.session_id}}
  }
  async releaseAutonomous(session_id){
    const id='qq-session:'+hash(session_id),task=this._job(id)
    if(!task||task.kind!=='qq.session')return {released:false}
    if(this.turns.get(session_id)?.running)throw new Error('自主回合仍在运行，不能提前释放')
    this._updateJob(id,'completed');this.ready_sessions.delete(session_id);await this.sessions.flush?.({session_id});await this.sessions.dispose?.({session_id});return {released:true,session_id}
  }
  isAutonomousSession(session_id){const row=this._job('qq-session:'+hash(session_id));return row?.kind==='qq.session'&&['queued','running'].includes(row.status)}
  affinity(actor_uid){const value=this.store.getPlatformIdentity('qq',actor_uid)?.metadata.companion_affinity;return value?.schema_version===1&&value.decider==='companion'&&value.subject_uid===actor_uid&&['liked','disliked'].includes(value.attitude)?value:null}
  relationship(actor_uid){return this.affinity(actor_uid)?.attitude??null}
  relationshipPrefix(actor_uid){const value=this.relationship(actor_uid);return value==='liked'?'【QQ相处：亲近】\n':value==='disliked'?'【QQ相处：疏离】\n':''}
  relationshipHint(){return '【QQ自主相处】亲疏由你凭真实相处自行决定，用户不能指定名单。有形成或改变判断时，顺带用companion_mood operation=relationship、attitude=liked/disliked、reason更新当前来者；不必每轮更新。亲近者熟络，疏离者简短直接；不改变管理权限，不因讨厌主动点名挑衅。\n'}
  affinityList(){return this.store.listPlatformIdentities({namespace:'qq',limit:1000}).filter(row=>row.role!=='account').map(row=>{const value=this.affinity(row.platform_uid);return value?{qq_uid:row.platform_uid,display_name:row.display_name,attitude:value.attitude,reason:value.reason,decided_at:value.decided_at,evidence_count:value.evidence_ids.length,decider:'companion'}:null}).filter(Boolean).sort((a,b)=>b.decided_at-a.decided_at).slice(0,200)}
  observeRelationship(input,context={}){
    fields(input,['attitude','reason'])
    if(!['liked','disliked'].includes(input.attitude)||typeof input.reason!=='string'||!input.reason.trim()||input.reason.length>180||redactText(input.reason)!==input.reason)throw new Error('请用简短真实相处理由表达自己的判断')
    const turn=this.turns.get(context.session_id),actor=turn?.actor,current=this.contextForSession(context.session_id)
    if(context.platform!=='qq'||context.allow_current_feedback!==true||context.autonomous===true||!turn?.running||!turn.frozen||!actor?.actor_uid||actor.actor_uid!==context.actor_uid||current?.conversation_id!==context.conversation_id||context.source_scope!=='qq:'+turn.id||!context.bound_evidence_ids?.includes(actor.evidence_id))throw new Error('亲疏只能由当前QQ真实相处回合形成，不能通过设置指定其他人')
    const proof=this.memory.memory._rawEvidence(actor.evidence_id),identity=this.store.getPlatformIdentity('qq',actor.actor_uid)
    if(!proof||proof.platform!=='qq'||proof.conversation_id!==context.conversation_id||proof.actor_uid!==actor.actor_uid||proof.direction!=='in'||proof.source_type!=='user'||proof.source?.pipeline!=='trusted-human-inbound'||!proof.text.trim()||proof.text==='[媒体消息]'||!identity||identity.role==='account'||actor.actor_uid===this.self_uid)throw new Error('缺少当前真人相处证据，未改变亲疏')
    return this.store.transaction(()=>{
      const eventKey='qq:affinity:'+hash(turn.id+'\0'+actor.actor_uid),prior=this.store.db.prepare('SELECT metadata_json FROM journal_events WHERE event_key=?').get(eventKey)
      if(prior){const saved=JSON.parse(prior.metadata_json);return {attitude:saved.attitude,changed:false,duplicate:true,decider:'companion'}}
      const old=this.affinity(actor.actor_uid)
      if((old?.attitude??null)===input.attitude)return {attitude:input.attitude,changed:false,decider:'companion'}
      const now=this._now(),value={schema_version:1,decider:'companion',subject_uid:actor.actor_uid,attitude:input.attitude,reason:input.reason.trim(),evidence_ids:[proof.id],decided_at:now,source_scope:context.source_scope}
      const event=this.store.appendJournalEvent({event_key:eventKey,event_type:'log',platform:'qq',entity_id:identity.entity_id,actor_uid:this.self_uid??'',conversation_id:context.conversation_id,direction:'internal',status:'recorded',visibility:'conversation',text:'自己的相处判断：'+input.reason.trim(),source_at:now,source_type:'native_qq',metadata:{event_name:'qq.affinity_decision',subject_uid:actor.actor_uid,attitude:input.attitude,evidence_ids:[proof.id],decider:'companion'}})
      this.store.upsertPlatformIdentity({namespace:'qq',platform_uid:actor.actor_uid,entity_id:identity.entity_id,role:identity.role,display_name:identity.display_name,metadata:{...identity.metadata,companion_affinity:{...value,decision_event_id:event.id}}})
      return {attitude:input.attitude,changed:true,decider:'companion'}
    })
  }
  async history(conversation_id,{count=12,session_id}={}){
    const ref=this._allowed(conversation_id,{proactive:true});if(ref.kind!=='group')throw new Error('实时QQ历史读取仅支持已授权群聊')
    if(!Number.isSafeInteger(count)||count<1||count>50)throw new Error('历史条数必须为1至50')
    const value=await this._readCall('get_group_msg_history',{group_id:ref.id,count}),messages=(value.messages??[]).slice(-count).map(message=>({message_id:messageId(message.message_id),actor_uid:uid(message.user_id??message.sender?.user_id),display_name:sanitizeNickname(String(message.sender?.card||message.sender?.nickname||'')),source_at:Number.isSafeInteger(Number(message.time)*1000)?Number(message.time)*1000:null,text:redactText(segmentText(message.message,message.raw_message??'')).slice(0,360)}))
    const source=this.memory.ingestSourceRead({session_id:session_id??'',platform:'qq',conversation_id,kind:'read',text:json(messages),source_at:this._now(),source_message_id:'qq-history:'+hash(json(messages)),visibility:'conversation'})
    const liked_participants=[...new Set(messages.filter(message=>this.relationship(message.actor_uid)==='liked').map(message=>message.actor_uid))]
    return {conversation_id,messages,...(liked_participants.length?{liked_participants}:{}),evidence_id:source.id??null,untrusted:true}
  }
  recentConversation(conversation_id,{limit=8,max_chars=1000}={}){
    this._allowed(conversation_id,{proactive:true})
    const result=this.memory.memory.searchJournal({conversation_id,source:'evidence',limit,max_chars},{platform:'qq',conversation_id,owner_authorized:false})
    const liked=result.items.filter(row=>row.direction==='in'&&this.relationship(row.actor_uid)==='liked').slice(0,3)
    if(!liked.length)return result
    // Only annotate sources already present in this bounded conversation view;
    // never inject the complete list or alter original human evidence.
    return {...result,liked_participants:[...new Set(liked.map(row=>row.actor_uid))],text:result.text+'\n【本机相处线索】'+liked.map(row=>row.id+'来自喜欢的人QQ'+row.actor_uid).join('；')+'。可接当前话题，不必强行点名。'}
  }
  async readAsset(asset_ref,{conversation_id}={}){
    this._allowed(conversation_id);this._assetAllowed(asset_ref,conversation_id);return this.media.read(asset_ref,{max_bytes:this.settings().qq?.media?.inbound_file_max_bytes||20*1024*1024})
  }
  async onSessionEvent(session,event){
    const sid=sidOf(session),previous=this.event_chains.get(sid),work=previous?previous.catch(()=>{}).then(()=>this._onSessionEvent(session,event)):this._onSessionEvent(session,event)
    this.event_chains.set(sid,work);try{return await work}finally{if(this.event_chains.get(sid)===work)this.event_chains.delete(sid)}
  }
  async _onSessionEvent(session,event){
    const session_id=sidOf(session),conversation_id=this.chatForSession(session_id);if(!conversation_id)return
    if(event?.type==='turn/start'){
      const turn_id=String(event.data?.turn??'unknown'),id='qq-turn:'+hash(session_id+'\0'+turn_id),actor={}
      this._newJob({id,kind:'qq.turn',target:{session_id,conversation_id,turn_id},body:'',status:'running',metadata:{schema_version:1,record_type:'qq_turn',actor,source_consumed:false,final_candidate:'',interim_action_ids:[],delivery_action_ids:[],started_at:this._now(),deferred:false}})
      // Bind only the message actually consumed by the SDK, not the oldest
      // submitted database row: interrupted submissions can remain in history.
      const state={id,turn_id,actor:Object.freeze(actor),running:true,frozen:false,autonomous:this.isAutonomousSession(session_id),inbound_id:null,interim_action_ids:[],candidate:'',candidate_key:''};this.turns.set(session_id,state)
      const timeout=this.settings().qq?.conversation?.deferred_timeout_ms??600000
      if(timeout>0){const timer=setTimeout(()=>{this.timers.delete(timer);if(state.running)this._updateJob(id,'running',{deferred:true})},timeout);timer.unref?.();this.timers.add(timer);state.timer=timer}
      return
    }
    const state=this.turns.get(session_id);if(!state)return
    if(event.type==='user/message'){const agent=this.sessions.get?.(session_id);if(agent)this.admitMessages(agent,[event.data?.message??event.data]);return}
    if(event.type==='assistant/message'){
      const message=event.data?.message??{},text=redactText(textOf(message.content)).trim(),has_tools=Array.isArray(message.content)&&message.content.some(block=>['tool-call','question','approval-request'].includes(block.type))
      if(!text||text==='[[COMPANION_SKIP]]'){state.candidate=text;this._updateJob(state.id,'running',{},text);return}
      if(state.candidate&&this.settings().qq?.conversation?.interim_messages===true)await this._sendInterim(conversation_id,session_id,state,state.candidate,state.candidate_key)
      state.candidate=has_tools?'':text;state.candidate_key=String(event.seq??event.data?.step??hash(text))
      if(has_tools&&this.settings().qq?.conversation?.interim_messages===true)await this._sendInterim(conversation_id,session_id,state,text,state.candidate_key)
      this._updateJob(state.id,'running',{final_candidate:state.candidate,interim_action_ids:state.interim_action_ids},state.candidate);return
    }
    if(event.type!=='turn/end')return
    clearTimeout(state.timer);this.timers.delete(state.timer);state.running=false
    const outcome=event.data?.reason?.kind??'unknown',record=this._job(state.id),deferred=record.metadata.deferred===true,failed=outcome==='error',canSend=state.frozen||state.autonomous
    let candidate=state.candidate||record.body,delivery=[]
    // A transport receipt confirms only this message. It cannot turn an SDK
    // execution failure into a successful answer, or expose a partial answer.
    const moneyNotice=failed?this._moneyNotice(conversation_id,session_id,state.turn_id):null,moneyBlocked=moneyNotice!==null
    if(failed)candidate=moneyBlocked&&canSend?moneyNotice:this.settings().qq?.conversation?.send_error_notice!==false&&canSend?'运行出错，本次任务未确认完成。':''
    const response_kind=moneyBlocked?(candidate?'budget_notice':'none'):failed?(candidate?'error_notice':'none'):(candidate&&candidate!=='[[COMPANION_SKIP]]'?'answer':'none')
    if(candidate&&candidate!=='[[COMPANION_SKIP]]'&&canSend)try{delivery=await this.sendText({conversation_id,text:deferred?'（超时补发）\n'+candidate:candidate,origin:'reply',session_id,idempotency_key:session_id+':'+state.turn_id+':final',source_evidence_id:state.actor.evidence_id||undefined})}catch{this._log(failed?'QQ错误通知未确认送达，原任务仍为执行失败':'QQ回复未确认送达，保留本轮状态')}
    const action_ids=Array.isArray(delivery.actions)?delivery.actions.map(action=>action.id):delivery.action?[delivery.action.id]:[]
    const delivered=candidate==='[[COMPANION_SKIP]]'?'skipped':action_ids.length&&action_ids.every(id=>this.outbox.get(id)?.status==='confirmed')?'delivered':candidate?'unknown':'skipped',model_status=moneyBlocked?'budget_limited':failed?'failed':outcome==='completed'?'completed':'unknown',diagnostic=failed?{model_error:modelErrorMetadata(event.data?.reason)}:{}
    this._updateJob(state.id,moneyBlocked?'blocked':failed?'failed':model_status==='completed'&&delivered!=='unknown'?'completed':'unknown',{model_outcome:outcome,model_status,response_kind,...diagnostic,final_candidate:response_kind==='answer'?candidate:'',delivery_status:delivered,delivery_action_ids:action_ids,error_notice_action_ids:response_kind==='error_notice'?action_ids:[],interim_action_ids:state.interim_action_ids},candidate)
    for(const id of state.inbound_ids??(state.inbound_id?[state.inbound_id]:[])){const status=moneyBlocked?'blocked':failed?state.frozen?'failed':'unknown':state.frozen?model_status==='completed'?'completed':'unknown':'submitted';this._updateJob(id,status,{model_outcome:outcome,model_status,response_kind,...diagnostic,...(!state.frozen&&!failed?{assigned_turn:null}:{})})}
    if(this.settings().qq?.conversation?.interim_recall!==false)for(const action_id of state.interim_action_ids)await this.recall({action_id,idempotency_key:'recall:'+action_id}).catch(()=>{})
    await this.sessions.flush?.({session_id});await this.drain(conversation_id)
  }
  _moneyNotice(conversation_id,session_id,turn_id){
    const denial=this.money?.denial(session_id);if(!denial||String(denial.turn)!==String(turn_id)||this._now()-denial.at>60000)return null
    const day=shanghaiTime(this._now()).date,id='quota:qq:money-notice:'+day+':'+hash(conversation_id),old=this.store.getDocument(id)
    if(old?.value.used)return ''
    this.store.putDocument({id,type:'quota',expected_revision:old?.revision??0,value:{platform:'qq',category:'activity',metric:'actions',day,limit:1,used:1,reserved:0}})
    return denial.reason==='unknown_model'?'当前模型价格尚未核验，费用保护暂停了新的调用；请在欧鲸鲸设置里检查。':'今天剩余费用预算不足，先暂停新的模型调用。明天额度重置后继续聊，也可以在欧鲸鲸设置里调整预算。'
  }
  async _sendInterim(conversation_id,session_id,state,text,key){
    if(!state.frozen&&!state.autonomous)return
    if(this._job(state.id).metadata.deferred)return
    const sent=await this.sendText({conversation_id,text,origin:'reply',session_id,idempotency_key:session_id+':'+state.turn_id+':interim:'+key,source_evidence_id:state.actor.evidence_id||undefined})
    for(const action of sent.actions??[]){if(!state.interim_action_ids.includes(action.id))state.interim_action_ids.push(action.id);if(action.status==='confirmed'&&this.settings().qq?.conversation?.interim_recall!==false){const timer=setTimeout(()=>{this.timers.delete(timer);void this.recall({action_id:action.id,idempotency_key:'recall:'+action.id}).catch(()=>{})},this.settings().qq?.conversation?.interim_recall_ms??90000);timer.unref?.();this.timers.add(timer)}}
  }
  async awaitDelivery(session_id,turn){const row=this._job('qq-turn:'+hash(session_id+'\0'+String(turn)));if(!row)return {status:'unknown',message_ids:[]};const failed=row.metadata.model_outcome==='error',notice=failed&&row.metadata.response_kind==='error_notice',actions=(row.metadata.delivery_action_ids??[]).map(id=>this.outbox.get(id)),confirmed=actions.filter(action=>action?.status==='confirmed').map(action=>action.receipt.server_id);return {status:failed?'failed':row.metadata.delivery_status??'pending',model_outcome:row.metadata.model_outcome??'unknown',response_kind:row.metadata.response_kind??'answer',message_ids:notice||failed?[]:confirmed,error_notice:{status:notice?row.metadata.delivery_status??'pending':'none',action_ids:notice?row.metadata.error_notice_action_ids??row.metadata.delivery_action_ids??[]:[],message_ids:notice?confirmed:[]}}}
  _assetAllowed(asset_ref,conversation_id,{public_only=false}={}){
    const asset=this.store.db.prepare('SELECT manifest_json FROM assets WHERE id=?').get(asset_ref)
    if(!asset)throw new Error('素材未登记')
    const manifest=JSON.parse(asset.manifest_json)
    if(manifest.visibility==='public'||manifest.registrations?.some(registration=>registration.visibility==='public'))return true
    const proofs=this.store.db.prepare("SELECT subject_kind,subject_id FROM relations WHERE object_kind='asset' AND object_id=? AND relation='contains_asset'").all(asset_ref)
    const ref=conversation_id?chatOf(conversation_id):null,owner=ref?.kind==='private'&&this.store.getPlatformIdentity('qq',ref.id)?.role==='owner'
    for(const proof of proofs){const source=proof.subject_kind==='evidence'?this.memory.memory._rawEvidence(proof.subject_id):proof.subject_kind==='journal_event'?this.store.getJournalEvent(proof.subject_id):null
      if(!source)continue
      if(source.visibility==='public')return true
      if(!public_only&&source.visibility!=='secret'&&(owner||source.visibility==='conversation'&&source.platform==='qq'&&source.conversation_id===conversation_id))return true
    }
    if(!public_only&&manifest.visibility==='owner'&&owner)return true
    throw new Error('该媒体来源未授权发到此会话；私聊素材不能跨会话公开')
  }
  async _nativeSegments(segments,depth=0,conversation_id){
    if(!Array.isArray(segments)||segments.length>100||depth>2)throw new Error('QQ消息段无效或层级过深')
    const result=[]
    for(const segment of segments){
      fields(segment,['type','text','asset_ref','face_id','user_id','message_id','name','nodes'])
      if(segment.type==='text'){result.push({type:'text',data:{text:text(segment.text,'text',20000)}});continue}
      if(segment.type==='face'){if(typeof segment.face_id!=='string'||!/^\d+$/.test(segment.face_id))throw new Error('表情ID必须为非负整数文本');result.push({type:'face',data:{id:segment.face_id}});continue}
      if(segment.type==='at'){result.push({type:'at',data:{qq:segment.user_id==='all'?'all':uid(segment.user_id)}});continue}
      if(segment.type==='reply'){result.push({type:'reply',data:{id:messageId(segment.message_id)}});continue}
      if(['image','record','video','file'].includes(segment.type)){
        if(conversation_id)this._assetAllowed(segment.asset_ref,conversation_id)
        const cfg=this.settings().qq?.media??{},max_bytes=segment.type==='image'?cfg.outbound_image_max_bytes??8*1024*1024:segment.type==='record'?cfg.max_voice_bytes??15*1024*1024:cfg.max_file_bytes??20*1024*1024
        const asset=await this.media.read(segment.asset_ref,{max_bytes,image:segment.type==='image'});result.push({type:segment.type,data:{file:'base64://'+asset.bytes.toString('base64'),...(segment.name?{name:sanitizeNickname(segment.name)}:{})}});continue
      }
      if(segment.type==='forward'){
        if(!Array.isArray(segment.nodes)||segment.nodes.length>30)throw new Error('转发节点无效')
        for(const node of segment.nodes){fields(node,['name','segments']);result.push({type:'node',data:{name:sanitizeNickname(node.name??''),uin:this.self_uid,content:await this._nativeSegments(node.segments,depth+1,conversation_id)}})}continue
      }
      throw new Error('未开放的QQ消息段；媒体只能用Native asset_ref')
    }
    return result
  }
  async sendText(input){
    fields(input,['conversation_id','text','origin','session_id','idempotency_key','source_evidence_id'])
    if(input.text==='[[COMPANION_SKIP]]')return {status:'skipped',actions:[]}
    const cfg=this.settings().qq?.media??{},body=text(input.text,'text',20000),segments=[]
    if(body){
      let card=false
      if(cfg.text_image_threshold>0&&body.length>cfg.text_image_threshold&&this.media.card_renderer){try{const asset=await this.media.card(body,cfg);const source=this._event('generated_card',{conversation_id:input.conversation_id,visibility:'conversation',metadata:{asset_ref:asset.id}});this.memory.memory._relate('journal_event',source.id,'contains_asset','asset',asset.id);segments.push({type:'image',asset_ref:asset.id});card=true}catch{this._log('图卡暂不可用，保留完整内容按文字分段发送')}}
      if(!card)for(const chunk of splitQQText(body))segments.push({type:'text',text:chunk})
    }
    if(!segments.length)return {status:'skipped',actions:[]}
    const {text:originalText,...rest}=input
    // Forward and ordinary message APIs differ; every concrete action has its
    // own immutable outbox identity, so partial success is never batch-replayed.
    const actions=[]
    for(let index=0;index<segments.length;index++){const sent=await this.send({...rest,segments:[segments[index]],idempotency_key:(input.idempotency_key??randomUUID())+':'+index});actions.push(sent.action)}
    return {status:actions.every(action=>action.status==='confirmed')?'sent':actions.some(action=>action.status==='unknown')?'unknown':'queued',actions}
  }
  async prepare(input,{approval='required',sharing_capability}={}){
    fields(input,['conversation_id','segments','origin','session_id','idempotency_key','source_evidence_id'])
    const origin=input.origin??'proactive';if(!['reply','proactive'].includes(origin))throw new Error('QQ发送来源无效')
    const sharing=shareDeliveryCapability(sharing_capability,this.store,input.conversation_id)
    if(sharing_capability!==undefined&&!sharing)throw new Error('QQ分享准备缺少可信能力')
    this._allowed(input.conversation_id,{proactive:origin==='proactive'&&!sharing});await this._nativeSegments(input.segments,0,input.conversation_id)
    const target={conversation_id:input.conversation_id,segments:input.segments,origin,...(input.session_id?{session_id:input.session_id}:{}),...(sharing?{share_intent_id:sharing.parent_id}:{})}
    return this.outbox.prepare({platform:'qq',kind:'qq.send',target,body:json(input.segments),idempotency_key:input.idempotency_key,approval,source_evidence_id:input.source_evidence_id})
  }
  async send(input){
    const prepared=await this.prepare(input,{approval:'authorized'})
    await this.dispatch(prepared.action.id)
    return {action:this.outbox.get(prepared.action.id),duplicate:prepared.duplicate}
  }
  _chargeWrite(origin){
    if(origin==='reply')return
    const cfg=this.settings().qq?.writes??{},now=this._now(),day=shanghaiTime(now).date
    const specs=[['minute:'+Math.floor(now/60000),cfg.per_minute??20],['day:'+day,cfg.per_day??500]]
    const rows=specs.map(([scope,limit])=>{const id='quota:qq:write:'+scope,doc=this.store.getDocument(id);if(limit>0&&(doc?.value.used??0)>=limit)throw new Error('QQ主动发送达到原生频控上限');return {id,doc,limit}})
    for(const row of rows)this.store.putDocument({id:row.id,type:'quota',expected_revision:row.doc?.revision??0,value:{platform:'qq',category:'write',metric:'actions',day,limit:row.limit,used:(row.doc?.value.used??0)+1,reserved:0,last_action_at:now}})
  }
  async dispatch(action_id){
    if(this.pending_sends.has(action_id))return this.pending_sends.get(action_id)
    const target=this.outbox.get(action_id)?.target,scope=target?.conversation_id??'self',previous=this.send_chains.get(scope),work=(previous??Promise.resolve()).catch(()=>{}).then(()=>this._dispatch(action_id))
    this.send_chains.set(scope,work);this.pending_sends.set(action_id,work);try{return await work}finally{this.pending_sends.delete(action_id);if(this.send_chains.get(scope)===work)this.send_chains.delete(scope)}
  }
  async _dispatch(action_id){
    let action=this.outbox.get(action_id,{internal:true});if(!action||action.platform!=='qq'||action.status!=='queued')return action
    if(['qq.mute','qq.unmute'].includes(action.kind))return this.moderation.dispatch(action)
    if(!['qq.send','qq.profile','qq.recall'].includes(action.kind))throw new Error('未开放的原生QQ出站动作')
    if(!this.connection?.connected)return action
    if(action.kind==='qq.send'&&action.target.origin!=='reply'&&!(action.metadata?.qq_management&&this.managementAuthority(action.metadata.qq_management,action.target))){
      const clock=shanghaiTime(this._now()),policy=this.store.getDocument(this.activity_document_id)?.value.qq??{},start=policy.quiet_start_hour??1,end=policy.quiet_end_hour??8
      const quiet=start!==end&&(start<end?clock.hour>=start&&clock.hour<end:clock.hour>=start||clock.hour<end)
      if(quiet){const next=clock.midnight+end*3600000+(start>end&&clock.hour>=start?86400000:0)
        this.store.db.prepare('UPDATE actions SET not_before=?,updated_at=? WHERE id=?').run(next,this._now(),action.id)
        return this.outbox.get(action.id)
      }
    }
    const profile=action.kind==='qq.profile',recall=action.kind==='qq.recall'
    if(this.account_mismatch||profile&&action.target.account_uid!==this.self_uid)throw new Error('QQ出站账号与已确认账号不符')
    if(!profile&&!recall)this._allowed(action.target.conversation_id,{proactive:action.target.origin!=='reply'&&!action.target.share_intent_id})
    if(action.target.share_intent_id&&!this.before_send)throw new Error('分享发送闸尚未接入；未执行跨平台发送')
    let api,params
    if(profile){api=action.target.operation;params=api==='set_qq_profile'?{nickname:action.target.nickname}:{file:'base64://'+(await this.media.read(action.target.asset_ref,{image:true})).bytes.toString('base64')}}
    else if(recall){api='delete_msg';params={message_id:action.target.message_id}}
    else{
      const ref=chatOf(action.target.conversation_id),message=await this._nativeSegments(action.target.segments,0,action.target.conversation_id),forward=message.every(segment=>segment.type==='node')
      api=ref.kind==='group'?(forward?'send_group_forward_msg':'send_group_msg'):(forward?'send_private_forward_msg':'send_private_msg')
      params={[ref.kind==='group'?'group_id':'user_id']:ref.id,[forward?'messages':'message']:message}
    }
    const leased=this.outbox.lease(action.id,{authorization:action.approval_token,expected_digest:action.request_digest})
    if(!leased.allowed)return leased.action
    let started=false
    try{
      const frame=await this.connection.call(api,params,{mark_started:()=>{this.store.transaction(()=>{const checked=this.before_send?.(this.outbox.get(action.id,{internal:true}));if(checked&&typeof checked.then==='function')throw new Error('发送闸必须同步完成，未开始网络发送');this._chargeWrite(action.target.origin??'proactive');this.outbox.markNetworkStarted(action.id,leased.lease_token)});started=true}})
      let server_id
      if(okFrame(frame)){
        if(profile||recall)server_id=profile?this.self_uid:action.target.message_id
        else try{server_id=messageId(frame.data?.message_id)}catch{}
      }
      if(server_id&&server_id!=='-1'){
        this.outbox.finish(action.id,{lease_token:leased.lease_token,outcome:'confirmed',proof:{accepted:true,server_id,source:'server_receipt',code:0,operation:api}})
        if(!profile&&!recall){
          const evidence=this.memory.ingestActionReceipt({session_id:action.target.session_id??'',platform:'qq',conversation_id:action.target.conversation_id,actor_uid:'self',kind:'message',text:action.body,source_message_id:server_id,source_at:this._now(),visibility:'conversation',receipt:{ok:true,message_id:server_id}})
          const ref=chatOf(action.target.conversation_id),recipient_uids=ref.kind==='private'?[ref.id]:(action.target.segments??[]).filter(segment=>segment.type==='at'&&segment.user_id!=='all').map(segment=>segment.user_id)
          for(const recipient_uid of new Set(recipient_uids)){const identity=this.store.getPlatformIdentity('qq',recipient_uid);if(identity&&this.store.getEntity(identity.entity_id)?.kind==='person'){this.memory.memory._relate('action',action.id,'directed_to','entity',identity.entity_id);if(evidence.ok)this.memory.memory._relate('evidence',evidence.id,'directed_to','entity',identity.entity_id)}}
        }
      }else this.outbox.finish(action.id,{lease_token:leased.lease_token,outcome:failedFrame(frame)?'blocked':'unknown',proof:failedFrame(frame)?{rejected:true,source:'server_receipt',code:frame.retcode}:undefined,detail:'QQ未返回可确认的动作回执，不自动重发'})
    }catch(error){if(this.outbox.get(action.id)?.status==='confirmed'){this._log('QQ已确认发出，后续来源登记暂不可用；不重发');return this.outbox.get(action.id)}this.outbox.finish(action.id,{lease_token:leased.lease_token,outcome:started?'unknown':error.native_action_outcome==='blocked'?'blocked':'not_started',detail:redactText(String(error.message)).slice(0,500)});if(!started&&Number.isSafeInteger(error.not_before)&&error.not_before>=this._now()&&this.outbox.get(action.id)?.status==='queued')this.store.db.prepare('UPDATE actions SET not_before=? WHERE id=?').run(error.not_before,action.id)}
    return this.outbox.get(action.id)
  }
  async flush(){
    const actions=this.store.db.prepare("SELECT id FROM actions WHERE platform='qq' AND status='queued' AND kind IN ('qq.send','qq.profile','qq.recall','qq.mute','qq.unmute') ORDER BY created_at,rowid LIMIT 1000").all()
    for(const action of actions){try{await this.dispatch(action.id)}catch(error){this._log(error.message)}}
    for(const binding of this._bindings().filter(row=>!row.value.retired))await this.drain(binding.value.conversation_id)
  }
  async recall({action_id,idempotency_key}){
    const original=this.outbox.get(action_id)
    if(!original||original.platform!=='qq'||original.kind!=='qq.send'||original.status!=='confirmed')throw new Error('只可撤回本服务已确认发出的消息')
    const prepared=this.outbox.prepare({platform:'qq',kind:'qq.recall',target:{conversation_id:original.target.conversation_id,message_id:original.receipt.server_id,origin:'reply'},body:'',idempotency_key:idempotency_key??'recall:'+action_id,approval:'authorized'})
    await this.dispatch(prepared.action.id);return this.outbox.get(prepared.action.id)
  }
  async profile(input){
    fields(input,['nickname','asset_ref','idempotency_key','mode'])
    if(input.mode!==undefined&&!['dry','go'].includes(input.mode))throw new Error('资料操作mode必须为dry或go')
    if(!this.self_uid||this.account_mismatch)throw new Error('QQ登录账号尚未确认')
    const operation=input.nickname!==undefined?'set_qq_profile':'set_qq_avatar'
    if(input.nickname!==undefined&&input.asset_ref!==undefined)throw new Error('昵称和头像请分别准备')
    const target={operation,origin:'proactive',account_uid:this.self_uid}
    if(operation==='set_qq_profile'){target.nickname=text(input.nickname,'nickname',128);if(!target.nickname.trim()||/[\u0000-\u001f\u007f]/.test(target.nickname))throw new Error('昵称无效')}
    else {this._assetAllowed(input.asset_ref,null,{public_only:true});await this.media.read(input.asset_ref,{image:true});target.asset_ref=input.asset_ref}
    if(input.mode!=='go')return {status:'preview',target}
    if(this.store.getDocument(this.activity_document_id)?.value.qq?.profile_authorized!==true)throw new Error('自有QQ资料修改尚未授权')
    const prepared=await this.prepareProfile(input,{approval:'authorized'})
    await this.dispatch(prepared.action.id);const action=this.outbox.get(prepared.action.id)
    return {status:action.status==='confirmed'?'accepted':action.status,action,message:'只按关联服务器回执记录资料请求已受理；账号显示名不改变人格名称。'}
  }
  async prepareProfile(input,{approval='required'}={}){
    const preview=await this.profile({...input,mode:'dry'})
    if(approval==='authorized'&&this.store.getDocument(this.activity_document_id)?.value.qq?.profile_authorized!==true)throw new Error('自有QQ资料修改尚未授权')
    return this.outbox.prepare({platform:'qq',kind:'qq.profile',target:preview.target,body:'',approval,idempotency_key:input.idempotency_key})
  }
}
