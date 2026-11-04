/** The native composition root. The bootstrap supplies an already-open v3 store; there is no legacy fallback. */
import {createHash,randomUUID} from 'node:crypto'
import {NativeStore} from './store.mjs'
import {NativeAssets} from './assets.mjs'
import {NativeSecrets} from './secrets.mjs'
import {NativeResources} from './resources.mjs'
import {NativePortable} from './portable.mjs'
import {NativeProfileService} from './profile-service.mjs'
import {NativePeople} from './people.mjs'
import {NativeMemoryRuntime} from './memory-runtime.mjs'
import {NativeReferences} from './references.mjs'
import {NativeLearning} from './learning.mjs'
import {NativeLearningLoop} from './learning-loop.mjs'
import {NativeLearningRuntime} from './learning-runtime.mjs'
import {NativeMood} from './mood.mjs'
import {NativeHormone} from './hormone.mjs'
import {NativeAffectRuntime} from './affect.mjs'
import {NativeSpeech} from './speech.mjs'
import {NativeQQ} from './qq.mjs'
import {NativeSessionNames} from './session-names.mjs'
import {NativeBilibili} from './bilibili.mjs'
import {NativeTieba} from './tieba.mjs'
import {NativeSocial,isQQModeration,normalizeQQModerationTarget,qqModerationAuthorized} from './social.mjs'
import {NativeActivity} from './activity.mjs'
import {NativeScheduledRounds} from './scheduled-rounds.mjs'
import {NativeMoneyBudget} from './money-budget.mjs'
import {effectiveActivityPolicy,restoreExpiredBudgetOverrides} from './budget-override.mjs'
import {NativeDiary} from './diary.mjs'
import {createNativeSessionController,NativeSessionRunner} from './session-runner.mjs'
import {installNativeRuntimeHooks} from './runtime-hooks.mjs'
import {installNativeAdminApi} from './admin-api.mjs'
import {installNativeTools} from './tools.mjs'
import {NATIVE_WORKSPACE_IDS} from './defaults.mjs'
import {isPlainObject,stringifyJson} from './contracts.mjs'
import {shanghaiTime,valleyDecision} from '../policy.mjs'
import {withRunScope,assertRunActive} from './run-scope.mjs'

const installed=new WeakMap(),resourcesOwners=new WeakMap(),hash=value=>createHash('sha256').update(value).digest('hex')
const sidOf=exec=>exec?.agent?.session?.header?.id??exec?.agent?.session?.id??exec?.session?.header?.id??exec?.session?.id??''
const service=(ctx,key)=>{try{return ctx.get?.(key)??ctx[key]}catch{return undefined}}
const fields=(value,allowed)=>{if(!isPlainObject(value)||Object.keys(value).some(key=>!allowed.includes(key)))throw new Error('原生Core参数含未知字段')}
const memoryContext=value=>Object.fromEntries(['platform','conversation_id','actor_uid','actor_entity_id','owner_authorized','include_secret','allow_global_summary'].filter(key=>value[key]!==undefined).map(key=>[key,value[key]]))
const learningContext=value=>Object.fromEntries(['platform','persona_platform','conversation_id','session_id','task_id','owner_authorized','autonomous','visibility'].filter(key=>value[key]!==undefined).map(key=>[key,value[key]]))
const callbackNames=['operator_authorizer','asset_management_authorizer','qq_connection_factory','media_downloader','qr_render','websocket_factory']
export {NATIVE_READ_OPERATIONS} from './read-contracts.mjs'
import {NATIVE_READ_OPERATIONS,NATIVE_READ_SPECS as READ_SPECS} from './read-contracts.mjs'
const METHOD={direct_messages:'directMessages',direct_contacts:'directContacts',live_history:'liveHistory',share_materials:'shareMaterials',sub_replies:'subReplies',style_refs:'styleRefs',bar_style:'barStyle',evolution_status:'evolutionStatus'}

class NativeCore{
  constructor(ctx,options){
    fields(options,['store','resources','runtime_root','resource_tools','now','sdk','audit_only','workspace_ids','operator_authorizer','asset_management_authorizer','qq_connection_factory','media_downloader','qr_render','websocket_factory','fetcher','schedule','connection'])
    if(!(options.store instanceof NativeStore))throw new Error('必须先显式打开原生数据库；旧目录资料需要先迁移，不能运行时fallback')
    for(const key of callbackNames)if(options[key]!==undefined&&typeof options[key]!=='function')throw new Error(key+'必须为可信宿主函数')
    this.ctx=ctx;this.store=options.store;this.options=options;this.now=options.now??this.store.now;this.started=false;this.closed=false;this.audit_only=options.audit_only!==false;this.leader=false;this.timers=[];this.running=new Set();this.operatorTurns=new Map();this.workspacePaths=new Map();this.last_error='';this.collector={empty_rounds:0,failures:0,next_at:0,last:null,account_key:''};this.flights={};this.process_id=randomUUID();this.read_operations=NATIVE_READ_OPERATIONS
    if(typeof this.now!=='function'||!this.store.getDocument('settings'))throw new Error('原生资料未初始化；请显式迁移或对空库调用initNativeDefaults')
    const resources=options.resources??new NativeResources({store:this.store,runtime_root:options.runtime_root,tools:options.resource_tools,now:this.now})
    if(resources.store!==this.store||typeof resources.workspace!=='function'||typeof resources.registerProcess!=='function')throw new Error('Core资源必须明确绑定同一NativeStore')
    if(resourcesOwners.has(resources))throw new Error('同一进程资源实例不能同时属于两个Core')
    resourcesOwners.set(resources,this);this.holder_id=resources.process_id??this.process_id
    const store=this.store,now=this.now,assets=new NativeAssets({store}),secrets=new NativeSecrets({store}),profiles=new NativeProfileService({store}),people=new NativePeople({store,now}),memory=new NativeMemoryRuntime({store,now,current_qq_authority:(exec,context)=>this._currentQQAuthority(exec,context)}),references=new NativeReferences({store,profiles,now,memory_runtime:memory}),learning=new NativeLearning({store,now,references}),mood=new NativeMood({store,now}),hormone=new NativeHormone({store,now}),affect=new NativeAffectRuntime({store,hormone,mood,now,enabled:()=>!this.audit_only&&!this.closed}),speech=new NativeSpeech({store,now}),diary=new NativeDiary({store,now})
    let qq
    const session_names=new NativeSessionNames({store,ctx,now,enabled:()=>this.leader&&!this.audit_only&&!this.closed,resolve_group:id=>qq?.connection?.connected?qq._readCall('get_group_info',{group_id:id}):null})
    const controller=createNativeSessionController(ctx,{resources,sdk:options.sdk,session_names,resolve_images:input=>this._qqInputImages(input)})
    let runner,social
    const money=new NativeMoneyBudget({store,now})
    const activity=new NativeActivity({store,now,money_budget:money,runner:(batch,controls)=>this._runModel(batch,controls),publication_runner:(batch,controls)=>this.leader&&!this.audit_only&&!this.closed?social.publicationRunner(batch,controls):{status:'not_started',retry:true,reason:'当前实例没有渠道主租约'}})
    qq=new NativeQQ({store,session_controller:controller,memory_runtime:memory,assets,credentials:secrets.bind('qq'),now,connection_factory:options.qq_connection_factory,download:options.media_downloader,transcriber:resources.transcriber,card_renderer:resources.cardRenderer,logger:ctx.logger,money_budget:money,local_moderation_source:input=>this._localModerationSource(input)})
    if(typeof resources.qqBridgeCacheReader==='function')qq.media.bindBridgeCacheReader(resources.qqBridgeCacheReader)
    const bilibili=new NativeBilibili({store,credentials:secrets.bind('bilibili'),assets,memory_runtime:memory,activity,fetcher:options.fetcher,now,learning,resource_runner:resources.resourceRunner,qr_render:options.qr_render,self_names:()=>[profiles.resolve('bilibili').name],websocket_factory:options.websocket_factory})
    const tieba=new NativeTieba({store,credentials:secrets.bind('tieba'),assets,memory_runtime:memory,activity,fetcher:options.fetcher,now})
    const scheduled_rounds=new NativeScheduledRounds({store,activity,platforms:{tieba,bilibili},schedule:()=>service(ctx,'schedule'),current_agent:id=>service(ctx,'agents')?.get(id),owner_entity_id:()=>this._ownerEntity(),now})
    social=new NativeSocial({store,providers:{qq,bilibili,tieba},memory_runtime:memory,activity,now})
    // Enforce the process/audit authority at the common final network gate too,
    // including NativeQQ's automatic final answer, recalls and deferred flush.
    const sharedSendGate=social.before_send.bind(social)
    social.before_send=action=>{this.assertMutable();if(!this.leader)throw new Error('当前实例没有渠道主租约，网络发送尚未开始');return sharedSendGate(action)}
    this.workspace_ids={...NATIVE_WORKSPACE_IDS,...options.workspace_ids}
    runner=new NativeSessionRunner({store,controller,qq,money_budget:money,workspace_ids:this.workspace_ids,now,context_resolver:(batch,base)=>this._runnerContext(batch,base),memory_sources:(batch,context)=>this._maintenanceSources(batch,context)})
    const learning_loop=new NativeLearningLoop({store,now}),learning_runtime=new NativeLearningRuntime({store,loop:learning_loop,legacy:learning,memory,now,enabled:()=>!this.audit_only&&!this.closed,resolve_context:exec=>this.context(exec),get_task:id=>runner.task(id)})
    memory.attachLearningLoop(learning_loop)
    const portability=new NativePortable({store,assets,secrets,now,assert_quiescent:()=>resources.assertQuiescent()})
    this.services={store,resources,assets,secrets,profiles,people,memory,memory_runtime:memory,memory_store:memory.memory,references,learning,learning_loop,learning_runtime,mood,hormone,affect,speech,diary,qq,bilibili,tieba,tieba_atmosphere:tieba.atmosphere,social,activity,scheduled_rounds,money,session_names,session_controller:controller,session_runner:runner,portability}
    session_names.attach()
    for(const platform of ['main','qq','bilibili','tieba'])if(!store.getPersonaProfile('persona-'+platform))this._warn('原生'+platform+'人设缺失，不用其他稿冒充')
    this._install()
  }
  async _qqInputImages({session_id,source}){
    const qq=this.services.qq,job=qq._job(source?.inbound_id)
    if(source?.kind!=='plugin:companion-qq'||source.platform!=='qq'||job?.kind!=='qq.inbound'||!['submitted','running'].includes(job.status)||job.target.session_id!==session_id||job.target.conversation_id!==source.conversation_id||job.metadata.actor_uid!==source.actor_uid||(job.metadata.evidence_id??'')!==(source.humanEvidenceId??''))throw new Error('QQ图片来源未绑定当前真实入站会话')
    if(job.source_evidence_id&&(job.source_evidence_id!==source.humanEvidenceId||this.store.db.prepare("SELECT 1 FROM evidence WHERE id=? AND platform='qq' AND conversation_id=? AND actor_uid=? AND direction='in' AND source_type='user'").get(source.humanEvidenceId,source.conversation_id,source.actor_uid)===undefined))throw new Error('QQ图片原始发言证据不一致')
    const refs=job.metadata.asset_refs??[];if(!Array.isArray(refs)||refs.some(ref=>typeof ref!=='string'))throw new Error('QQ图片资产登记无效')
    const images=[]
    for(const ref of [...new Set(refs)]){
      const row=this.store.db.prepare('SELECT media_type FROM assets WHERE id=?').get(ref)
      if(!row?.media_type?.startsWith('image/'))continue
      const asset=await qq.readAsset(ref,{conversation_id:source.conversation_id})
      images.push({bytes:asset.bytes,media_type:asset.media_type,name:'QQ图片',asset_ref:ref})
      if(images.length===12)break
    }
    return images
  }
  _now(){const at=this.now();if(!Number.isSafeInteger(at)||at<0)throw new Error('Core时钟无效');return at}
  _warn(error){this.last_error=String(error?.message??error).slice(0,300);try{this.ctx.logger?.warn?.(this.last_error)}catch{}}
  _track(work,key){const promise=Promise.resolve(work);this.running.add(promise);if(key)this.flights[key]=promise;promise.catch(error=>this._warn(error)).finally(()=>{this.running.delete(promise);if(key&&this.flights[key]===promise)delete this.flights[key]});return promise}
  _ownerEntity(){const ids=new Set(this.store.listPlatformIdentities({role:'owner',limit:1000}).map(row=>row.entity_id)),explicit=this.store.getDocument('mood')?.value.owner_entity_id;if(explicit){const entity=this.store.getEntity(explicit);if(entity?.kind==='person'&&entity.metadata.owner_confirmed===true)ids.add(explicit)}return ids.size===1?[...ids][0]:null}
  _workspacePlatform(exec){const sid=sidOf(exec),meta=this.services?.session_controller.metadata(sid);if(meta&&['main','qq','tieba','bilibili'].includes(meta.platform))return {platform:meta.platform,workspace_id:meta.workspace_id};const cwd=exec?.agent?.session?.header?.cwd,bound=this.workspacePaths.get(cwd);return bound??{platform:'main'}}
  _personaPlatform(agent,context){if(['qq','bilibili','tieba'].includes(context.platform))return context.platform;return this._workspacePlatform({agent}).platform}
  _loadWorkspaces(){this.workspacePaths.clear();const bindings=this.store.listDocuments({type:'workspace_persona_binding',limit:1000});for(const row of bindings)if(row.value.enabled){const value=row.value,physical=this.services.resources.workspace(value.workspace_id);if(typeof physical==='string')this.workspacePaths.set(physical,{workspace_id:value.workspace_id,platform:value.platform})}if(!bindings.length)for(const[platform,id]of Object.entries(this.workspace_ids))this.workspacePaths.set(this.services.resources.workspace(id),{workspace_id:id,platform})}
  _hostContext(exec,binding){
    const sid=sidOf(exec),space=this._workspacePlatform(exec),base={platform:'harness',...(space.workspace_id?{workspace_id:space.workspace_id}:{}),session_id:sid,conversation_id:'local-owner',owner_authorized:false,actor_uid:'',include_secret:false},s=this.services
    if(!binding||binding.purpose!=='sdk-consumed-input')return base
    if(s.session_runner.task(sid)||s.qq.chatForSession(sid)||['autonomous','memory-maintenance','internal-maintenance'].includes(s.session_controller.metadata(sid)?.purpose))return base
    if(binding.producer?.kind!=='user'||typeof binding.source_message_id!=='string'||!binding.source_message_id||binding.source_message_id.length>240||!exec?.agent)return base
    const entity_id=this._ownerEntity();if(!entity_id)return base
    if(this.options.operator_authorizer&&this.options.operator_authorizer({agent:exec.agent,binding,owner_entity_id:entity_id})!==true)return base
    const previous=this.store.getPlatformIdentity('harness','local-owner');if(previous&&(previous.entity_id!==entity_id||previous.role!=='owner'))return base
    if(!previous){if(this.store.readOnly)return base;this.store.upsertPlatformIdentity({namespace:'harness',platform_uid:'local-owner',entity_id,role:'owner',display_name:this.store.getEntity(entity_id).display_name})}
    this.operatorTurns.set(sid,{agent:exec.agent,message_id:binding.source_message_id})
    return {...base,actor_uid:'local-owner',actor_entity_id:entity_id,owner_authorized:true}
  }
  // A source label/old evidence ID is insufficient: require this operational
  // turn, its registered inbound job and the SDK's committed message together.
  _currentQQAuthority(exec,context={}){
    const sid=sidOf(exec),s=this.services,turn=s.qq.turns.get(sid),chat=s.qq.chatForSession(sid),agent=exec?.agent
    if(!turn?.frozen||!turn.running||turn.autonomous||s.session_controller.get(sid)!==agent||context.platform!=='qq'||context.conversation_id!==chat||context.actor_uid!==turn.actor?.actor_uid||context.actor_entity_id!==turn.actor?.actor_entity_id||!turn.inbound_id)return null
    const load=id=>{const row=this.store.db.prepare('SELECT kind,status,target_json,metadata_json,source_evidence_id FROM actions WHERE id=?').get(id);return row?{...row,target:JSON.parse(row.target_json),metadata:JSON.parse(row.metadata_json)}:null},job=load(turn.id),inbound=load(turn.inbound_id),id=turn.actor.evidence_id,proof=id?s.memory_store._effectiveEvidence(id):null,identity=this.store.getPlatformIdentity('qq',turn.actor.actor_uid)
    if(job?.kind!=='qq.turn'||job.status!=='running'||job.metadata.source_consumed!==true||job.target.session_id!==sid||job.target.conversation_id!==chat||String(job.target.turn_id)!==String(turn.turn_id)||job.metadata.actor?.evidence_id!==id||inbound?.kind!=='qq.inbound'||inbound.status!=='running'||inbound.target.session_id!==sid||inbound.target.conversation_id!==chat||String(inbound.metadata.assigned_turn)!==String(turn.turn_id)||inbound.source_evidence_id!==id||inbound.metadata.evidence_id!==id||inbound.metadata.actor_uid!==context.actor_uid||inbound.metadata.actor_entity_id!==context.actor_entity_id)return null
    if(!proof||proof.platform!=='qq'||proof.conversation_id!==chat||proof.actor_uid!==context.actor_uid||proof.actor_entity_id!==context.actor_entity_id||proof.direction!=='in'||proof.source_type!=='user'||proof.source?.kind!=='user'||proof.source?.pipeline!=='trusted-human-inbound'||proof.source_message_id!==inbound.metadata.source_message_id||!identity||identity.entity_id!==context.actor_entity_id||identity.role==='account'||context.actor_uid===s.qq.self_uid||proof.text==='[媒体消息]'||!proof.text.trim()||['rejected','unknown'].includes(proof.status))return null
    const events=agent.session.snapshotEvents?.(agent.session.inheritedEventCount??0);if(!Array.isArray(events))return null
    let committed=false;for(const event of [...events].reverse()){if(event.type==='turn/start')break;if(event.type!=='user/message')continue;const message=event.data?.message??event.data,source=message?.source;if(typeof message?.id==='string'&&source?.kind==='plugin:companion-qq'&&source.inbound_id===turn.inbound_id&&source.humanEvidenceId===id&&source.actor_uid===context.actor_uid&&source.conversation_id===chat){committed=true;break}}
    return committed?Object.freeze({platform:'qq',conversation_id:chat,session_id:sid,actor_uid:context.actor_uid,actor_entity_id:context.actor_entity_id,allow_current_feedback:true,bound_evidence_ids:Object.freeze([id])}):null
  }
  _localModerationSource({session_id}={}){
    if(typeof session_id!=='string')return null
    const local=this.operatorTurns.get(session_id),s=this.services,agent=local?.agent,owner=this._ownerEntity()
    if(!agent||!owner||s.qq.chatForSession(session_id)||s.session_runner.task(session_id))return null
    const context=this.hooks?.context({agent}),identity=this.store.getPlatformIdentity('harness','local-owner')
    if(context?.platform!=='harness'||context.owner_authorized!==true||context.actor_uid!=='local-owner'||context.actor_entity_id!==owner||identity?.role!=='owner'||identity.entity_id!==owner)return null
    const events=agent.session.snapshotEvents?.(agent.session.inheritedEventCount??0);if(!Array.isArray(events))return null
    for(const event of [...events].reverse()){
      if(event.type==='turn/start')break;if(event.type!=='user/message')continue
      const message=event.data?.message??event.data
      if(message?.id!==local.message_id||message.source?.kind!=='user'||!Array.isArray(message.content)||!message.content.length||message.content.some(block=>block.type!=='text'||typeof block.text!=='string'))continue
      const text=message.content.map(block=>block.text).join('\n')
      return {platform:'harness',session_id,conversation_id:'local-owner',actor_uid:'local-owner',actor_entity_id:owner,text,mention_uids:[],source_message_id:message.id,source_scope:'user:'+message.id,source_text_sha256:hash(text)}
    }
    return null
  }
  _moderationRequest(exec,context){
    if(context.autonomous===true||!['qq','harness'].includes(context.platform))return null
    const cfg=this.store.getDocument('qq')?.value.qq??{},policy=cfg.moderation??{}
    if(policy.enabled!==true||context.platform==='harness'&&policy.allow_local_owner!==true)return null
    const sid=sidOf(exec),s=this.services,source=context.platform==='qq'?s.qq.moderationSource?.(sid,{agent:exec?.agent}):this._localModerationSource({session_id:sid})
    if(!source||source.platform!==context.platform||source.session_id!==sid||source.actor_uid!==context.actor_uid)return null
    if(context.platform==='qq'&&!(cfg.access?.admin_uids??[]).includes(source.actor_uid)||context.platform==='harness'&&policy.allow_local_owner!==true)return null
    const request=s.qq.moderation.request(source)
    if(!request||!(policy.allowed_group_uids??[]).includes(request.conversation_id.replace(/^group:/,''))||request.duration_seconds>(policy.max_duration_seconds??2592000))return null
    return {source,request}
  }
  _moderationContext(exec,context){
    const capability=this._moderationRequest(exec,context)
    if(!capability)return null
    const intent=this.services.qq.moderation.intent(capability.source)
    return intent?{intent,source_scope:capability.source.source_scope}:null
  }
  _moderationLookupAllowed(context,operation,args={}){
    const request=context.moderation_lookup
    return context.platform==='qq'&&['members','moderation_target'].includes(operation)&&!!request&&(operation==='moderation_target'||args.query===request.member_selector)&&(args.conversation_id??request.conversation_id)===request.conversation_id
  }
  _qqModerationLookupAllowed(exec){
    return exec.name==='companion_read'&&(exec.arguments?.platform??'qq')==='qq'&&this._moderationLookupAllowed(this.context(exec),exec.arguments?.operation,exec.arguments?.args)
  }
  _moderationActionAllowed(exec){
    if(exec?.name!=='companion_action'||!isQQModeration(exec.arguments?.kind))return false
    const context=this.context(exec)
    try{return (exec.arguments.body??'')===''&&qqModerationAuthorized(exec.arguments.kind,normalizeQQModerationTarget(exec.arguments.kind,exec.arguments.target,context),context)}catch{return false}
  }
  _qqManagementAllowed(exec){
    const context=this.context(exec),qq=this.services.qq
    if(!context.can_manage_qq||!qq.managementAuthority(context))return false
    if(exec.name==='companion_read')return (exec.arguments?.platform??'qq')==='qq'&&(['groups','members'].includes(exec.arguments?.operation)||['history','recent'].includes(exec.arguments?.operation)&&qq.managementAuthority(context,{conversation_id:exec.arguments?.args?.conversation_id}))
    return exec.name==='companion_action'&&exec.arguments?.kind==='qq.send'&&qq.managementAuthority(context,exec.arguments?.target)
  }
  context(exec){
    const sid=sidOf(exec),s=this.services,agent=exec?.agent,resolved=this.hooks?.context(exec)??{session_id:sid,platform:'harness',conversation_id:'',owner_authorized:false},task=s.session_runner.task(sid),chat=s.qq.chatForSession(sid),local=this.operatorTurns.get(sid)
    const persona_platform=this.hooks?.platform(agent)??this._personaPlatform(agent,resolved),context={...resolved,session_id:sid,include_secret:false,can_manage:false,can_manage_qq:false,can_moderate_group:false,autonomous:false,source_scope:'',allow_observe:false,persona_platform,default_platform:['qq','tieba','bilibili'].includes(resolved.platform)?resolved.platform:persona_platform==='main'?'system':persona_platform}
    if(task){if(s.session_controller.get(sid)!==agent)throw new Error('SDK Agent引用与活动会话不一致');if(task.input_bound&&task.user_committed){context.autonomous=true;context.task_id=task.batch.id;context.round_id=task.batch.id;context.source_scope='activity:'+task.batch.id;context.allow_observe=true;const cap=this._maintenanceCapability(task.batch);if(cap)context.can_manage=false}}
    else if(chat){const turn=s.qq.turns.get(sid),bound=this._currentQQAuthority(exec,context);if(bound){context.task_id=turn.id;context.round_id=turn.id;context.source_scope='qq:'+turn.id;context.allow_observe=true;context.allow_current_feedback=true;context.bound_evidence_ids=[...bound.bound_evidence_ids];context.can_manage=resolved.owner_authorized===true&&chat.startsWith('private:')&&s.qq.isTurnAdmin(sid)}else{context.owner_authorized=false;context.allow_observe=false}}
    else if(local?.agent===agent){context.task_id='host:'+hash(local.message_id);context.round_id=context.task_id;context.source_scope='user:'+local.message_id;context.source_message_id=local.message_id;context.allow_observe=true;context.can_manage=resolved.owner_authorized===true}
    else{context.owner_authorized=false;context.actor_uid='';delete context.actor_entity_id}
    if(chat?.startsWith('private:')){const source=s.qq.moderationSource(sid,{agent});if(source){context.source_scope||=source.source_scope;if(s.qq.managementAuthority(context))context.can_manage_qq=true}}
    const moderationRequest=this._moderationRequest(exec,context)
    if(moderationRequest)context.moderation_lookup=Object.freeze({...moderationRequest.request})
    const moderation=this._moderationContext(exec,context)
    if(moderation){context.can_moderate_group=true;context.moderation_intent=Object.freeze({...moderation.intent});context.source_scope||=moderation.source_scope}
    if(typeof exec?.callId==='string'&&context.source_scope)context.idempotency_key='sdk-call:'+hash(context.source_scope+'\0'+exec.callId)
    context.visibility=context.platform==='qq'?context.conversation_id?.startsWith('group:')?'conversation':'owner':['tieba','bilibili'].includes(context.platform)&&/^dm:/.test(context.conversation_id)?'conversation':context.platform==='harness'?'owner':'public'
    return context
  }
  learningAuthority(exec,authority=this.context(exec)){if(authority.session_id!==sidOf(exec))throw new Error('学习来源与当前SDK会话不一致');return this.services.learning_runtime.authority(exec,authority)}
  assertMutable(){if(this.closed||!this.started)throw new Error('原生Core尚未运行或已经关闭');if(this.audit_only)throw new Error('原生审计保护中，社交和自主写入尚未启用');if(this.store.readOnly||this.store.getDocument('settings')?.value.enabled===false)throw new Error('原生资料只读或总开关关闭')}
  _assertRead(context,platform,operation){const manager=context.can_manage===true||context.owner_authorized===true,pure=platform==='system'&&['status','reference_search','reference_read','learning_status','mood_status','speech_status','diary_status'].includes(operation);if(operation==='status'&&platform==='system')return;if(this.closed)throw new Error('Core已关闭');if(pure&&context.source_scope)return;if(operation==='status'&&(manager||context.platform===platform&&context.source_scope))return;if(this.audit_only)throw new Error('审计模式只允许记忆、人设、设置和只读状态');if(manager)return;if(context.platform!==platform||!context.source_scope)throw new Error('当前可信来源不能操作其他平台或尚未消费真实输入')}
  async read(platform,operation,args={},context={}){
    const task=this.services.session_runner.task(context.session_id)
    if(!task&&context.autonomous===true)throw new Error('活动会话已结束，未继续平台读取')
    return withRunScope(task?{...task.controls,now:this.now}:undefined,()=>this._read(platform,operation,args,context))
  }
  async _read(platform,operation,args={},context={}){
    assertRunActive()
    if(!NATIVE_READ_OPERATIONS[platform]?.includes(operation))throw new Error('未开放这个原生读取操作');if(!isPlainObject(args))throw new Error('读取参数必须为对象');this._assertRead(context,platform,operation)
    if(platform==='system'){
      if(operation==='status'){fields(args,[]);const result=await this.status();return context.can_manage||context.owner_authorized?result:{native:true,audit_only:this.audit_only,started:this.started,model_calls:0}}
      if(!context.can_manage&&!['reference_search','reference_read','learning_status','mood_status','speech_status','diary_status'].includes(operation))throw new Error('当前来源没有本机资料管理能力')
      if(operation==='resources'){fields(args,[]);return this.services.resources.probe()}
      if(operation==='people'){fields(args,['query','platform']);return {items:this.services.people.list(args)}}
      if(operation==='reference_search')return this.services.references.search(args,context)
      if(operation==='reference_read')return this.services.references.read(args,context)
      if(operation==='learning_status'){fields(args,[]);return this.services.learning.status(learningContext(context))}
      if(operation==='mood_status'){fields(args,[]);return this.services.mood.status()}
      if(operation==='speech_status'){fields(args,[]);return this.services.speech.status()}
      if(operation==='diary_status'){fields(args,[]);return this.services.diary.status(memoryContext(context))}
    }
    if(operation==='status'){fields(args,[]);return platform==='tieba'?this.services.tieba.status({refresh:true}):this.services[platform].status()}
    fields(args,READ_SPECS[platform]?.[operation]??[])
    if(platform==='qq'){
      if(operation==='moderation_target'){
        const request=context.moderation_lookup;if(!this._moderationLookupAllowed(context,operation,args))throw new Error('当前消息没有已核验的管理员管理指令')
        const result=request.member_uid?{items:[{member_uid:request.member_uid}],total:1,match_kind:'native_identifier',model_calls:0}:await this.services.qq.members({conversation_id:request.conversation_id,query:request.member_selector,session_id:context.session_id})
        return {...result,conversation_id:request.conversation_id,operation:request.operation,duration_seconds:request.duration_seconds,requires_uid:result.total!==1}
      }
      if(['groups','members'].includes(operation)){
        if(this._moderationLookupAllowed(context,operation,args))return this.services.qq.members({...args,conversation_id:context.moderation_lookup.conversation_id,session_id:context.session_id})
        if(context.can_manage!==true&&!(context.can_manage_qq&&this.services.qq.managementAuthority(context))||context.platform==='qq'&&!context.conversation_id?.startsWith('private:'))throw new Error('允许群与成员查询仅限主人管理员私聊或本机主人')
        return operation==='groups'?this.services.qq.managementGroups():this.services.qq.members({...args,session_id:context.session_id})
      }
      const conversation=args.conversation_id??context.conversation_id;if(typeof conversation!=='string'||!conversation)throw new Error('需要明确QQ会话');if(conversation!==context.conversation_id&&!context.can_manage&&!(context.can_manage_qq&&this.services.qq.managementAuthority(context,{conversation_id:conversation})))throw new Error('只能读取当前可信QQ会话或明确允许管理的群')
      const{conversation_id:unused,...options}=args;return operation==='history'?this.services.qq.history(conversation,{...options,session_id:context.session_id}):this.services.qq.recentConversation(conversation,options)
    }
    const method=METHOD[operation]??operation,provider=this.services[platform];if(typeof provider?.[method]!=='function')throw new Error('原生平台接口尚未就绪')
    const value=['tieba','bilibili'].includes(platform)&&['direct_messages','direct_contacts'].includes(operation)?await provider[method](args,memoryContext(context)):await provider[method]({...args,session_id:context.session_id??'',...((platform==='tieba'&&['browse','thread','sub_replies'].includes(operation)||platform==='bilibili'&&['browse','video','subtitles','watch','transcribe'].includes(operation))?{round_id:context.round_id??context.task_id??context.source_scope??''}:{})})
    if(platform==='tieba'&&operation==='browse')for(const item of value.items??[])if(item.evidence_ids?.length)this.services.learning.observeRead({evidence_ids:item.evidence_ids.slice(0,4),ref:item.source_ref,title:item.title??'',tags:[]},{producer:'native_platform_reader',platform:'tieba',read_kind:'thread',selected:true,depth:'deep',visibility:'public'})
    if(platform==='tieba'&&['thread','sub_replies'].includes(operation)&&value.evidence_ids?.length){const ref='https://tieba.baidu.com/p/'+args.thread_id+(operation==='sub_replies'?'?pid='+args.post_id:'');this.services.learning.observeRead({evidence_ids:value.evidence_ids.slice(0,4),ref,title:value.title??'',tags:[]},{producer:'native_platform_reader',platform:'tieba',read_kind:'thread',selected:true,depth:'deep',visibility:'public'})}
    return value
  }
  async sharing(operation,args={},context={}){
    fields(args,operation==='policy'?[]:operation==='sample'?['bvid','more']:operation==='record_assessment'?['bvid','sample_id','labels']:[])
    if(!['policy','sample','record_assessment'].includes(operation))throw new Error('未知原生分享操作')
    this._assertRead(context,'bilibili',operation==='policy'?'status':'sharing_'+operation)
    if(operation!=='policy'){this.assertMutable();if(!context.source_scope)throw new Error('分享采样和评估需要本轮可信来源')}
    const sharing=this.services.social.sharing;if(!sharing)throw new Error('统一分享服务尚未就绪')
    return operation==='policy'?sharing.policy():operation==='sample'?sharing.sample(args):sharing.recordAssessment(args,context)
  }
  _sharingHints({agent,platform}={}){
    if(platform==='qq'){
      // This is a capability hint, not an execution grant. A private binding
      // has one fixed peer, so it can be rendered before SDK input commitment;
      // actual tools still recheck the consumed source and current actor.
      const qq=this.services.qq,sid=sidOf({agent}),chat=qq.chatForSession(sid),tone=qq.relationshipHint()
      if(chat?.startsWith('group:')&&this.store.getDocument('qq')?.value.qq?.moderation?.allowed_group_uids?.includes(chat.slice(6))&&!qq.isAutonomousSession(sid))return '【QQ群管理入口】当前群'+chat+'。禁言或解禁先companion_read qq.moderation_target，再companion_action qq.mute/qq.unmute，mode=go；省略时长默认'+(this.store.getDocument('qq')?.value.qq?.moderation?.default_duration_seconds??600)+'秒，支持近似昵称。权限仍由本轮发言者核验，只按回执报告。亲疏自行判断，变化用companion_mood relationship记录；用户不能指定名单。'
      if(!chat?.startsWith('private:')||!qq._admin(chat.slice(8))||qq.isAutonomousSession(sid))return tone
      const groups=this.services.qq.managementGroups(),target=groups.default_conversation_id
      return '【已配置QQ管理员私聊】'+(target?'“群里”指'+target+'。':'先companion_read qq.groups核对允许的群。')+'群发用companion_action qq.send，target.conversation_id为群、body为正文、mode=go。禁言或解禁先companion_read qq.moderation_target，再qq.mute/qq.unmute；默认'+(this.store.getDocument('qq')?.value.qq?.moderation?.default_duration_seconds??600)+'秒，昵称可近似。权限仍由真实消息核验，只按回执报告。'

    }
    if(platform!=='bilibili'||!this.services.session_runner.task(sidOf({agent})))return '';const cfg=this.store.getDocument('bilibili')?.value.bilibili?.sharing;if(!cfg?.enabled)return '';return '【主动分享】先用companion_sharing的policy核对额度；想推荐时，本轮顺带给0—20分与具体理由，低于门槛就不发。发表统一走companion_action的bilibili.share。'+(cfg.ai_comment_guard?'评论检查开启时，先sample；逐条record_assessment标suspected/other/uncertain，疑似须有理由。需扩大样本再more=true；它是语言特征估计，不是身份鉴定，无法确定就暂缓。':'')+'不另开评分模型。'}
  _managedAsset(asset){const entries=asset.manifest?.catalog_entries??[];return asset.manifest?.visibility==='public'||asset.kind==='sticker'&&asset.manifest?.collection==='shared_stickers'||entries.some(entry=>entry.historical!==true&&['shared_stickers','tieba_images'].includes(entry.collection)&&entry.enabled!==false)}
  readImage(asset_ref,context={}){const target=context.default_platform??context.platform;if(target==='qq')throw new Error('QQ原图请通过当前会话qq_read_asset正规入口读取');const asset=this.services.assets.read(asset_ref);if(!asset.media_type.startsWith('image/'))throw new Error('素材不是图片');if(['bilibili','tieba'].includes(target)&&!this._managedAsset(asset))throw new Error('公共平台只能读取公开或明确管理的素材，不能读取QQ私图');if(!['bilibili','tieba'].includes(target)&&!context.can_manage&&!this._managedAsset(asset))throw new Error('当前来源没有私域素材读取权限');return asset}
  expressionList({query='',limit=12}={},context={}){if(typeof query!=='string'||query.length>240||!Number.isSafeInteger(limit)||limit<1||limit>30)throw new Error('表情查询范围无效');const rows=this.store.db.prepare("SELECT id FROM assets WHERE kind IN ('sticker','image') ORDER BY created_at DESC,id LIMIT 1000").all(),items=[];for(const row of rows){const raw=this.store.db.prepare('SELECT kind,media_type,manifest_json FROM assets WHERE id=?').get(row.id),manifest=JSON.parse(raw.manifest_json),entries=(manifest.catalog_entries??[]).filter(entry=>entry.historical!==true&&['shared_stickers','tieba_images'].includes(entry.collection)&&entry.enabled!==false);if(!entries.length&&!(raw.kind==='sticker'&&manifest.collection==='shared_stickers'))continue;const e=entries[0]??manifest,name=String(e.display_name??e.name??row.id).slice(0,120),description=String(e.description??'').slice(0,180),tags=(e.tags??[]).slice(0,12).map(String);if(query&&!(name+' '+description+' '+tags.join(' ')).includes(query))continue;items.push({asset_ref:row.id,name,description,tags,media_type:raw.media_type});if(items.length===limit)break}return {items,reference_only:true,model_calls:0}}
  adoptExpression(input,context={}){fields(input,['asset_ref','name','description','tags']);this.assertMutable();if(context.can_manage!==true)throw new Error('管理表情素材需要可信本机管理能力');if(typeof input.name!=='string'||!input.name.trim()||input.name.length>120||typeof(input.description??'')!=='string'||(input.description??'').length>500||!Array.isArray(input.tags??[])||(input.tags??[]).length>20||(input.tags??[]).some(tag=>typeof tag!=='string'||tag.length>40))throw new Error('表情名称或标签无效');const asset=this.services.assets.read(input.asset_ref);if(!asset.media_type.startsWith('image/'))throw new Error('只接受原生已登记图片');if(!this._managedAsset(asset)&&this.options.asset_management_authorizer?.({asset_ref:asset.id,context})!==true)throw new Error('私聊原图不能自动提升到共享表情库，需要本机明确素材导入来源');const result=this.services.assets.put({bytes:asset.bytes,kind:'sticker',media_type:asset.media_type,source_ref:asset.source_ref,visibility:asset.manifest.visibility??'owner',manifest:{schema_version:1,collection:'shared_stickers',catalog_entries:[{collection:'shared_stickers',source_id:asset.id,display_name:input.name,description:input.description??'',tags:input.tags??[],enabled:true,historical:false}],management_scope:context.source_scope}});return {asset_ref:result.id,name:input.name,registered:true,duplicate:result.duplicate===true,published:false}}
  _install(){
    const s=this.services,ctx=this.ctx
    this.missing_interfaces=[];for(const[key,path]of [['on',['on']],['tools.register',['tools','register']],['tools.guard',['tools','guard']],['systemPrompt.section',['systemPrompt','section']],['systemPrompt.context',['systemPrompt','context']]])if(typeof path.reduce((v,k)=>v?.[k],ctx)!=='function')this.missing_interfaces.push(key)
    if(!this.missing_interfaces.length){this._loadWorkspaces();this.hooks=installNativeRuntimeHooks(ctx,{store:this.store,profiles:s.profiles,people:s.people,memory_runtime:s.memory,qq:s.qq,activity:s.activity,session_runner:s.session_runner,money_budget:s.money,now:this.now,host_context_resolver:(exec,binding)=>this._hostContext(exec,binding),persona_resolver:(agent,context)=>this._personaPlatform(agent,context),qq_current_authority:(exec,context)=>this._currentQQAuthority(exec,context),qq_moderation_authority:exec=>this._moderationActionAllowed(exec),qq_moderation_lookup_authority:exec=>this._qqModerationLookupAllowed(exec),qq_management_authority:exec=>this._qqManagementAllowed(exec),
      references:{context:input=>input.platform==='tieba'?s.tieba.styleContext(input,s.session_runner.task(sidOf({agent:input.agent}))):s.references.hints({query:input.context.query??''},{...input.context,persona_platform:input.platform})},learning:s.learning_runtime,mood:s.mood,affect:s.affect,
      speech:{section:input=>s.speech.section(input),context:input=>s.speech.context(input),on_event:(session,event)=>{if(!this.audit_only&&!this.closed)return s.speech.on_event(session,event)}},social:{context:input=>this._sharingHints(input),allowed_tool_names:()=>['companion_sharing','companion_read','companion_action','companion_diary','companion_image','companion_mood','companion_speech','qq_send_image','qq_send_voice','qq_send_video','qq_send_forward']}})
      this.toolRegistration=installNativeTools(ctx,{core:this})
      this.offTurn=ctx.on('session/event',(session,event)=>{if(['turn/start','turn/end'].includes(event.type))this.operatorTurns.delete(session.header?.id??session.id)})
    }
    for(const key of ['create','resume','get'])if(typeof service(ctx,'agents')?.[key]!=='function')this.missing_interfaces.push('agents.'+key)
    const activityPort={status:()=>({...s.activity.status(),available:!this.audit_only}),get runOneRound(){return !thisCore.audit_only?((platform,options)=>{thisCore.assertMutable();return s.activity.runOneRound(platform,options)}):undefined},get enqueue(){return !thisCore.audit_only?(input=>{thisCore.assertMutable();const result=s.activity.enqueue(input);thisCore._issueMaintenance('memory',result.task,{query:input.target?.query??''});return result}):undefined}},thisCore=this
    const platforms=Object.fromEntries(['qq','bilibili','tieba'].map(platform=>[platform,{status:()=>s[platform].status(),get login(){if(thisCore.audit_only)return undefined;return async(input,trustedContext)=>{thisCore.assertMutable();if(platform==='qq'&&!thisCore.leader)throw new Error('当前窗口不是渠道主实例，请在主实例管理QQ连接');return s[platform].login(input,trustedContext)}},get checkInbox(){if(thisCore.audit_only||!['bilibili','tieba'].includes(platform))return undefined;return async()=>{thisCore.assertMutable();if(!thisCore.leader)throw new Error('请在渠道主实例检查收件箱');if(platform==='tieba')return s.tieba.pollReplies({force:true});const result=await s.bilibili.pollInbox({force:true,comments_only:true});thisCore.collector.last=result;thisCore.collector.next_at=thisCore._now()+(thisCore.store.getDocument('bilibili-inbox')?.value.poll_interval_ms??180000);return result}},get reconcileToday(){if(thisCore.audit_only||platform!=='bilibili')return undefined;return async(input,trustedContext)=>{thisCore.assertMutable();if(!thisCore.leader)throw new Error('请在渠道主实例补回评论');return s.bilibili.reconcileToday(trustedContext)}},get checkPrivate(){if(thisCore.audit_only||platform!=='tieba')return undefined;return async(input,trustedContext)=>{thisCore.assertMutable();if(!thisCore.leader)throw new Error('请在渠道主实例处理贴吧私信');return s.tieba.replyPendingMessages(input,trustedContext)}},get inspectPage(){if(thisCore.audit_only||platform!=='tieba')return undefined;return async(input,trustedContext)=>{thisCore.assertMutable();return s.tieba.inspectOfficialPage(trustedContext)}},get resume(){if(thisCore.audit_only||platform!=='tieba')return undefined;return async(input,trustedContext)=>{thisCore.assertMutable();return s.tieba.resume(input,trustedContext)}}}]))
    this.admin=installNativeAdminApi(ctx,{store:this.store,profiles:s.profiles,memory:s.memory_store,diary:s.diary,hormone:s.hormone,learning_loop:s.learning_loop,tieba_atmosphere:s.tieba.atmosphere,consolidate_learning:()=>this._queueLearning({manual:true}),activity:activityPort,platforms,people:input=>s.people.list(input),affinities:()=>s.qq.affinityList(),portability:s.portability,connection:this.options.connection,on_change:()=>{this.collector.next_at=0;if(this.tieba_replies_collector)this.tieba_replies_collector.next_at=0;if(this.leader)this._track(this._syncChannels(),'channels');return{restart_required:false}}})
  }
  _issueMaintenance(kind,task,{query=''}={}){if(!task)return;const existing=this.store.db.prepare('SELECT id FROM journal_events WHERE event_key=?').get('core:maintenance:'+task.id);if(existing)return;this.store.appendJournalEvent({event_key:'core:maintenance:'+task.id,event_type:'log',platform:'harness',direction:'internal',status:'recorded',visibility:'owner',text:'',source_at:this._now(),source_type:'native_core',metadata:{subtype:'closed_maintenance_capability',task_id:task.id,kind,request_digest:task.request_digest,evidence_ids:task.target.evidence_ids??[],query,authority:'trusted_native_backend_only',no_publication:true}})}
  _maintenanceCapability(batch){if(batch.kind!=='activity.maintenance')return null;const caps=batch.tasks.map(task=>{const row=this.store.db.prepare("SELECT metadata_json FROM journal_events WHERE event_key=? AND source_type='native_core'").get('core:maintenance:'+task.id);if(!row)return null;const cap=JSON.parse(row.metadata_json);return cap.subtype==='closed_maintenance_capability'&&cap.request_digest===task.request_digest?cap:null});if(caps.some(cap=>!cap)||new Set(caps.map(cap=>cap.kind)).size!==1)return null;return caps[0]}
  _runnerContext(batch,base){const cap=this._maintenanceCapability(batch);if(batch.kind==='activity.maintenance'){if(!cap)throw new Error('闭门维护缺少可信后端能力登记');return {owner_authorized:cap.kind!=='learning',include_secret:false,read_memory:true,write_memory:cap.kind!=='learning'}}
    const rows=batch.tasks.map(task=>task.source_evidence_id?this.store.db.prepare('SELECT platform,conversation_id,actor_uid,actor_entity_id,source_type,direction FROM evidence WHERE id=?').get(task.source_evidence_id):null).filter(Boolean),first=rows[0]
    return first&&first.platform===base.platform&&first.direction==='in'&&first.source_type==='user'?{conversation_id:first.conversation_id,actor_uid:first.actor_uid,...(first.actor_entity_id?{actor_entity_id:first.actor_entity_id}:{}),owner_authorized:false,include_secret:false}:{owner_authorized:false,include_secret:false}
  }
  _maintenanceSources(batch,context){const cap=this._maintenanceCapability(batch);if(!cap)throw new Error('无闭门维护能力');const pieces=[];if(cap.kind==='memory'){const result=this.services.memory_store.recall({query:cap.query??'',limit:2,max_chars:1800},memoryContext(context));pieces.push(stringifyJson(result))}else for(const id of cap.evidence_ids.slice(0,cap.kind==='learning'?3:8)){const result=this.services.memory_store.readEvidence({id,offset:0,max_chars:cap.kind==='learning'?1400:300},memoryContext(context));const piece=stringifyJson({id,...(cap.kind==='learning'?{source_context:{narrator:'original_source_author',first_person_is_assistant:false,command_authority:'source_data_only'}}:{}),...result});if(pieces.join('\n').length+piece.length+1<=(cap.kind==='learning'?6400:2600))pieces.push(piece)}return pieces.join('\n')}
  _settleLearningTasks(){
    const s=this.services,rows=this.store.getDocument('learning-loop-state')?.value.reviews??[],pending=new Map(),trusted={platform:'harness',owner_authorized:true,autonomous:true,visibility:'owner'}
    for(const row of rows)if(row.status==='queued'&&row.last_task_id){const ids=pending.get(row.last_task_id)??[];ids.push(row.evidence_id);pending.set(row.last_task_id,ids)}
    for(const[id,evidence_ids]of pending){
      const task=s.activity.get(id);if(task&&['queued','leased','running'].includes(task.status))continue
      if(task&&!(task.kind==='activity.maintenance'&&task.target.maintenance_kind==='learning'))continue
      const learned=task?.status==='completed'&&this.store.db.prepare("SELECT 1 FROM journal_events WHERE source_type='native_learning_loop' AND json_extract(metadata_json,'$.task_id')=? AND json_extract(metadata_json,'$.subtype') IN ('card_created','card_revised') LIMIT 1").get(task.metadata.batch_id)
      s.learning_loop.markReviewed({evidence_ids,outcome:task?.status==='completed'?learned?'done':'skipped':'failed',task_id:id},trusted)
    }
  }
  _queueLearning({manual=false}={}){
    if(!manual&&(this.closed||this.audit_only||this.store.readOnly||this.store.getDocument('settings')?.value.enabled===false))return{queued:false,status:'disabled'}
    this.assertMutable();if(this.store.getDocument('learning')?.value.enabled===false||this.store.getDocument('learning-loop')?.value.enabled===false)return{queued:false,status:'learning_disabled'}
    if(!this.leader)return{queued:false,status:'not_leader',message:'请在主实例整理学习来源'}
    const s=this.services,p=effectiveActivityPolicy({store:this.store,document_id:s.activity.policy_id,now:this.now});if(p.enabled!==true)return{queued:false,status:'activity_disabled',message:'请先开启活动总开关'}
    this._settleLearningTasks()
    const live=this.store.db.prepare("SELECT id,status FROM actions WHERE kind='activity.maintenance' AND json_extract(target_json,'$.maintenance_kind')='learning' AND status IN ('queued','leased','running') ORDER BY created_at LIMIT 1").get()
    if(live)return{queued:false,status:'pending',task_id:live.id,task:s.activity.get(live.id),message:'已有一批学习来源正在整理'}
    const phase=valleyDecision(this._now(),p);if(!manual&&!phase.valley)return{queued:false,status:'peak',next_at:phase.nextValleyAt,message:'自动学习等待谷时，已有来源继续保留'}
    const batchLimit=Math.min(3,this.store.getDocument('learning-loop')?.value.policy?.review_sources_per_batch??3),trusted={platform:'harness',owner_authorized:true,autonomous:true,visibility:'owner',manual},pending=s.learning_loop.pendingSources({limit:batchLimit,manual},trusted)
    if(!pending.review.eligible)return{queued:false,status:pending.review.used_today>=pending.review.max_per_day?'daily_limit':'cooldown',next_at:pending.review.next_at,pending_sources:pending.pending_count,message:pending.review.used_today>=pending.review.max_per_day?'今天已达到学习整理批次上限，剩余来源留到下一天':'刚整理过一批，待下次学习间隔到达后继续'}
    if(!pending.items.length)return{queued:false,status:'no_new_sources',pending_sources:0,message:'暂时没有新的可复核阅读来源'}
    const max=p.budget?.max_task_tokens??30000,capacity=Math.min(3,Math.floor((max-1800)/1400));if(capacity<1)return{queued:false,status:'task_budget',message:'单轮Token保护不足以整理一条有来源的学习卡'}
    const items=pending.items.slice(0,capacity),estimated_tokens=1800+items.length*1400,budget=s.activity.budget.status(),remaining=budget.daily_token_limit-budget.tokens-budget.reserved_tokens
    if(remaining<estimated_tokens||!manual&&budget.autonomous_wakes>=budget.daily_wake_limit)return{queued:false,status:'budget',message:'当前剩余用量不足，学习来源保留待下次整理'}
    if(s.money.enabled()&&s.money.status().remaining_nano<=0)return{queued:false,status:'money_budget',message:'当前费用额度不足，学习来源保持未整理'}
    const evidence_ids=items.map(x=>x.evidence_id),key='learning-review:'+hash(stringifyJson([evidence_ids,manual,this._now()])),result=s.activity.enqueue({platform:'qq',kind:'maintenance',trigger:manual?'manual':'autonomous',target:{maintenance_kind:'learning',evidence_ids,no_publication:true,source_platforms:[...new Set(items.map(x=>x.platform))]},human:false,heavy:true,estimated_tokens,idempotency_key:key})
    this._issueMaintenance('learning',result.task)
    s.learning_loop.markReviewed({evidence_ids,outcome:'queued',task_id:result.task.id},trusted)
    return{queued:!result.duplicate,status:result.duplicate?'pending':'queued',task_id:result.task.id,task:result.task,source_count:evidence_ids.length,pending_sources:pending.pending_count,model_calls:0}
  }
  _runModel(batch,controls){return withRunScope({...controls,now:this.now},()=>this._runModelInScope(batch,controls))}
  _runModelInScope(batch,controls){if(this.audit_only||!this.leader||this.closed)return{status:'not_started',retry:true,reason:'当前实例只读或未持有渠道租约'};if(batch.platform==='bilibili'&&['activity.incoming','activity.explore'].includes(batch.kind)){const ready=this.services.bilibili.readAvailability({reserve_inbox:batch.kind==='activity.explore'&&batch.trigger==='autonomous'});if(!ready.allowed)return{status:'not_started',retry:true,reason:ready.message,not_before:ready.not_before}};if(batch.kind==='activity.maintenance'&&!this._maintenanceCapability(batch))return{status:'not_started',retry:false,reason:'闭门维护缺少可信后端能力，不从task target授予权限'};if(batch.kind==='activity.explore'&&['tieba','bilibili'].includes(batch.platform))this.services[batch.platform].rounds.begin(batch.id,{limits:batch.tasks[0]?.target.round_limits});const result=this.services.session_runner.run(batch,controls);return batch.kind==='activity.maintenance'&&batch.tasks[0]?.target.maintenance_kind==='learning'?Promise.resolve(result).then(outcome=>outcome?.status==='not_started'?{...outcome,retry:false}:outcome):result}
  _pidAlive(pid){try{process.kill(pid,0);return true}catch(error){return error.code!=='ESRCH'}}
  _claimLeader(){if(this.audit_only||this.closed||this.store.readOnly)return false;return this.store.transaction(()=>{const doc=this.store.getDocument('runtime-lease:channels'),old=doc?.value;if(doc&&doc.type!=='runtime_lease')throw new Error('渠道租约类型异常');if(old?.holder_id&&old.lease_until!==0&&old.holder_id!==this.holder_id){const registered=typeof this.services.resources.isRegisteredProcessActive==='function'&&this.services.resources.isRegisteredProcessActive({pid:old.pid,token:old.holder_id});if(registered||this._pidAlive(old.pid))return false}this.store.putDocument({id:'runtime-lease:channels',type:'runtime_lease',expected_revision:doc?.revision??0,value:{scope:'channels',holder_id:this.holder_id,pid:process.pid,lease_until:this._now()+30000,renewed_at:this._now()}});return true})}
  _releaseLeader(){if(this.store.readOnly)return;this.store.transaction(()=>{const doc=this.store.getDocument('runtime-lease:channels');if(doc?.value.holder_id===this.holder_id)this.store.putDocument({id:doc.id,type:doc.type,expected_revision:doc.revision,value:{...doc.value,lease_until:0,renewed_at:this._now()}})})}
  _renew(){const prior=this.leader;try{this.leader=this._claimLeader()}catch(error){this.leader=false;this._warn(error)}if(prior&&!this.leader)this._track(this._stopChannels(),'stop_channels');return this.leader}
  async _syncChannels(){if(this.closed||this.audit_only||!this.leader)return;const enabled=this.store.getDocument('settings')?.value.enabled!==false,qq=this.services.qq,wanted=enabled&&this.store.getDocument('qq')?.value.enabled===true,key=stringifyJson(this.store.getDocument('qq')?.value??{})
    const tInbox=this.services.tieba.inbox,tSettings=this.store.getDocument('tieba')?.value;if(tInbox.connection&&(!enabled||tSettings?.enabled!==true||!tInbox.authAllowed()||tInbox.connectionCredentialRef!==tSettings.credential_ref))tInbox.connection.close()
    const syncQQ=async()=>{if(!wanted&&qq.started)await qq.stop();else if(wanted&&(!qq.started||this.qq_config_key!==key)){if(qq.started)await qq.stop();await qq.start();this.qq_config_key=key}}
    const syncBili=async()=>{
      const inbox=this.store.getDocument('bilibili-inbox')?.value,liveTime=inbox?.all_day!==false||valleyDecision(this._now(),this.store.getDocument('activity')?.value??{}).valley,bEnabled=liveTime&&enabled&&this.store.getDocument('bilibili')?.value.enabled===true&&inbox?.enabled===true&&inbox.channels?.includes('live')&&!!inbox.room_uid,bkey=stringifyJson([this.store.getDocument('bilibili')?.value.credential_ref,inbox?.room_uid])
      if(this.bili_config_key&&this.bili_config_key!==bkey)this.services.bilibili.liveConnection?.public.close();this.bili_config_key=bkey
      if(bEnabled&&!this.services.bilibili.liveConnection)await this.services.bilibili.startLive();if(!bEnabled)this.services.bilibili.liveConnection?.public.close()
    }
    for(const outcome of await Promise.allSettled([syncQQ(),syncBili()]))if(outcome.status==='rejected')this._warn(outcome.reason)
  }
  async _collectTiebaReplies(){
    const cfg=this.services.tieba._settings(),policy=cfg.config.comment_inbox,state=this.tieba_replies_collector??={next_at:0,failures:0,last:null},key=stringifyJson([cfg.value.account_entity_id,cfg.value.credential_ref,policy])
    if(state.key!==key){state.key=key;state.next_at=0;state.failures=0}
    if(this.store.getDocument('settings')?.value.enabled===false||cfg.value.enabled!==true||policy?.enabled!==true||this._now()<state.next_at)return
    const base=Math.max(15000,policy.poll_interval_ms??60000)
    try{state.last=await this.services.tieba.pollReplies();state.failures=0;state.next_at=this._now()+base}catch(error){state.failures++;state.next_at=this._now()+Math.min(Math.max(base,900000),base*2**Math.min(6,state.failures));throw error}
  }
  async _collectTieba(){const cfg=this.store.getDocument('tieba')?.value;if(cfg?.enabled!==true||cfg.tieba?.inbox?.enabled!==true||cfg.tieba?.inbox?.allow_legacy_auth!==true||cfg.tieba.inbox.auth_until&&cfg.tieba.inbox.auth_until<=this._now())return;const state=this.tieba_collector??={next_at:0,empty:0,failures:0};if(this._now()<state.next_at)return;const base=Math.max(15000,cfg.tieba.inbox.poll_interval_ms??180000);try{const r=await this.services.tieba.pollInbox();state.failures=0;state.empty=r.queued?0:state.empty+1;state.next_at=this._now()+Math.min(900000,base*2**Math.min(3,state.empty));state.last=r}catch(e){state.failures++;state.next_at=this._now()+Math.min(900000,base*2**Math.min(3,state.failures));throw e}}
  async _collect(){const policy=this.store.getDocument('bilibili-inbox')?.value,cfg=this.store.getDocument('bilibili')?.value;if(!policy?.enabled||cfg?.enabled!==true)return;const base=Math.max(15000,policy.poll_interval_ms??180000),key=JSON.stringify([cfg.account_entity_id??cfg.credential_ref??'',cfg.bilibili?.risk?.read_daily,cfg.bilibili?.risk?.read_hourly,base,policy.channels]);if(this.collector.account_key!==key){this.collector={empty_rounds:0,failures:0,next_at:0,last:null,account_key:key}}if(this._now()<this.collector.next_at)return
    const phase=valleyDecision(this._now(),this.store.getDocument('activity')?.value??{});if(policy.all_day===false&&!phase.valley){this.collector.next_at=phase.nextValleyAt??this._now()+base;return}
    const ready=this.services.bilibili.readAvailability();if(!ready.allowed){this.collector.next_at=ready.not_before;this.collector.last={polled:false,reason:ready.reason,message:ready.message,model_calls:0};return}
    try{const result=await this.services.bilibili.pollInbox();this.collector.last=result;this.collector.failures=0;if(result.polled){if(result.new_events>0){this.collector.empty_rounds=0}else this.collector.empty_rounds++}this.collector.next_at=this._now()+base}catch(error){this.collector.failures++;this.collector.next_at=this._now()+Math.min(Math.max(base,900000),base*2**Math.min(6,this.collector.failures));throw error}}
  async pulse(){if(!this.started||this.closed||this.audit_only)return {active:false};if(!this._renew())return{leader:false}
    if(!this.store.readOnly)restoreExpiredBudgetOverrides({store:this.store,now:this.now})
    if(!this.names_repaired)try{for(const session of service(this.ctx,'sessions')?.list?.()??[])void this.services.session_names.update(session);this.names_repaired=true}catch(error){this._warn(error)}
    if(!this.flights.channels)this._track(this._syncChannels(),'channels')
    if(!this.flights.scheduled_monitors)this._track(this.services.scheduled_rounds.pulseMonitors(),'scheduled_monitors')
    try{this.services.speech.scan({limit:200})}catch(error){this._warn(error)}
    try{this.services.learning_runtime.scanPublications({limit:200})}catch(error){this._warn(error)}
    try{const judged=this.services.mood.autoJudge(this.services.activity);if(judged.queued)this._issueMaintenance('mood',this.services.activity.get(judged.task_id))}catch(error){this._warn(error)}
    try{this._queueLearning()}catch(error){this._warn(error)}
    if(!this.flights.tieba_replies)this._track(this._collectTiebaReplies(),'tieba_replies');if(!this.flights.tieba_inbox)this._track(this._collectTieba(),'tieba_inbox');if(!this.flights.collector)this._track(this._collect(),'collector');if(!this.flights.qq_flush&&this.services.qq.started)this._track(this.services.qq.flush(),'qq_flush')
    try{this.services.activity.scheduleIdle()}catch(error){this._warn(error)}
    for(const platform of ['qq','tieba','bilibili'])for(const execution of ['model','publication']){
      const key='activity:'+platform+':'+execution
      if(!this.flights[key])this._track(this.services.activity.tick({idle:false,platform,execution}),key)
    }
    return{leader:true,model_calls:0}
  }
  async start({audit_only=this.audit_only}={}){if(this.closed)throw new Error('Core已关闭，不能重新启动');if(typeof audit_only!=='boolean')throw new Error('audit_only必须为宿主明确布尔值');if(!audit_only&&this.missing_interfaces.length)throw new Error('SDK接口尚未就绪：'+this.missing_interfaces.join('、'));this.audit_only=audit_only;this.started=true;this.services.resources.registerProcess();if(audit_only){this.leader=false;await this._stopChannels();this._releaseLeader();return this.status()}
    if(!this.store.readOnly)restoreExpiredBudgetOverrides({store:this.store,now:this.now})
    this.services.hormone.ensure()
    this.services.learning_loop.ensure()
    if(this.options.schedule!==false&&!this.timers.length){const timer=setInterval(()=>this._renew(),5000);timer.unref?.();this.timers.push(timer);const work=setInterval(()=>{this._track(this.pulse()).catch(()=>{})},7000);work.unref?.();this.timers.push(work)}await this.pulse();return this.status()}
  activate(){return this.start({audit_only:false})}
  async _stopChannels(){this.services.tieba.inbox.connection?.close();this.services.bilibili.liveConnection?.public.close();await this.services.qq.stop()}
  async status(){const s=this.services,ports={sdk_hooks:!!this.hooks,native_tools:!!this.toolRegistration,agent_registry:['create','resume','get'].every(key=>typeof service(this.ctx,'agents')?.[key]==='function'),image_attachments:typeof service(this.ctx,'attachments')?.saveImages==='function',admin_routes:!!this.admin,admin_server:typeof service(this.ctx,'webServer')?.register==='function',admin_connection_policy:!!this.options.connection||typeof service(this.ctx,'connection')?.requestRejection==='function',sdk:this.options.sdk?'injected':'host_module',http:this.options.fetcher?'injected':'host_fetch',qq_transport:this.options.qq_connection_factory?'injected':'native_websocket',resource_runner:typeof s.resources.resourceRunner==='function',transcriber:typeof s.resources.transcriber==='function',card_renderer:typeof s.resources.cardRenderer==='function'};return {native:true,schema_version:3,started:this.started,closed:this.closed,audit_only:this.audit_only,leader:this.leader,process_registered:!!s.resources.process_file,owner_principal_known:!!this._ownerEntity(),missing_interfaces:[...this.missing_interfaces,...(!this._ownerEntity()?['operator.owner_principal']:[])],fully_wired:this.missing_interfaces.length===0,ports,activity_budget:s.activity.status().budget,collector:{...this.collector},services:{profiles:true,people:true,memory:true,references:true,learning:true,learning_loop:true,mood:true,hormone:true,speech:true,resources:true,social:true,activity:true,diary:true,portability:true},platforms:{qq:s.qq.status(),bilibili:await s.bilibili.status(),tieba:await s.tieba.status()},model_calls:0,last_error:this.last_error}}
  async close(){if(this.closePromise)return this.closePromise;this.closed=true;this.audit_only=true;this.started=false;for(const timer of this.timers)clearInterval(timer);this.timers=[];this.closePromise=(async()=>{for(const task of [...this.services.session_runner.pending.values()])task.abort?.();for(const sid of this.services.qq.ready_sessions)await this.services.session_controller.stop({session_id:sid}).catch(()=>{});await this._stopChannels();await Promise.allSettled([...this.running]);await this.services.session_names.close();this._releaseLeader();this.leader=false;this.offTurn?.();this.toolRegistration?.dispose?.();this.hooks?.dispose?.();this.services.affect.dispose();this.services.learning_runtime.dispose();this.admin?.dispose?.();this.services.bilibili.close();this.services.tieba.close();this.services.memory.close();this.services.resources.close();this.operatorTurns.clear();resourcesOwners.delete(this.services.resources);installed.delete(this.ctx);return{closed:true}})();return this.closePromise}
}

export function createNativeCore(ctx,options={}){if(!ctx||typeof ctx!=='object')throw new Error('需要真实SDK宿主上下文');const existing=installed.get(ctx);if(existing){if(existing.store!==options.store)throw new Error('同一SDK宿主不能切换到另一原生库');return existing}const core=new NativeCore(ctx,options);installed.set(ctx,core);return core}
