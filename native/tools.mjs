import { createHash } from 'node:crypto'
import { isPlainObject,validateJson,stringifyJson } from './contracts.mjs'
import { fields,choice,integer,rawText } from './memory-rules.mjs'
import {isQQModeration,normalizeQQModerationTarget} from './social.mjs'
import {nativeReadParameters,nativeReadDescription} from './read-contracts.mjs'

const installed=new WeakMap()
const PLATFORMS=['qq','bilibili','tieba','harness']
const KINDS=['qq.send','qq.profile','qq.mute','qq.unmute','tieba.reply','tieba.post','tieba.message','tieba.sign','tieba.follow','tieba.unfollow','bilibili.comment','bilibili.reply','bilibili.dynamic','bilibili.share','bilibili.like','bilibili.coin']
const TRUST_KEYS=new Set(['owner_authorized','can_manage','autonomous','can_moderate_group','can_manage_qq','moderation_intent','moderation_source','moderation_authority','allow_observe','include_secret','allow_global_summary','producer','role','source','source_scope','source_evidence_id','source_at','session_id','workspace_id','task_id','round_id','call_id','idempotency_key','approval','approval_token','authorization','receipt','metadata','persona_platform','default_platform','allow_current_feedback','bound_evidence_ids'])
const select=(value,keys)=>Object.fromEntries(keys.filter(key=>value[key]!==undefined).map(key=>[key,value[key]]))
const memoryContext=value=>select(value,['platform','conversation_id','actor_uid','actor_entity_id','owner_authorized','include_secret','allow_global_summary'])
const learningContext=value=>select(value,['platform','persona_platform','conversation_id','session_id','task_id','owner_authorized','autonomous','visibility','allow_current_feedback','bound_evidence_ids','actor_uid','actor_entity_id'])
const moodContext=value=>select(value,['platform','conversation_id','actor_uid','actor_entity_id','owner_authorized','session_id','allow_observe','idempotency_key'])
const object=(properties={},required=[])=>({type:'object',properties,required,additionalProperties:false})
const str=(maxLength=240)=>({type:'string',maxLength})
const ids={type:'array',items:str(),maxItems:100,uniqueItems:true}
const integerSchema=(minimum,maximum)=>({type:'integer',minimum,maximum})
const enumSchema=values=>({type:'string',enum:values})
const jsonObject={type:'object',additionalProperties:true}
const jsonOutput={schema:jsonObject,render:(_args,value)=>[{type:'text',text:stringifyJson(value)}]}
const canonical=value=>Array.isArray(value)?value.map(canonical):isPlainObject(value)?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value
const sha=value=>createHash('sha256').update(stringifyJson(canonical(value))).digest('hex')
const requestKey=(context,kind,target,body)=>{
  const scope=context.source_scope||context.task_id
  if(typeof scope!=='string'||!scope||scope.length>1024||/[\0\r\n]/.test(scope))throw new Error('当前调用尚未绑定真实输入或活动任务，不能建立发表草稿')
  return 'native-tool:'+sha({scope,kind,target,body})
}
function untrustedObject(value){
  validateJson(value,{object:true,maxBytes:128*1024})
  const check=node=>{if(Array.isArray(node)){node.forEach(check);return}if(isPlainObject(node))for(const[key,item]of Object.entries(node)){if(TRUST_KEYS.has(key))throw new Error('工具参数不能提供宿主权限、来源、会话或回执字段：'+key);check(item)}}
  check(value);return value
}
function stringIds(value,max=100){if(!Array.isArray(value)||value.length>max)throw new Error('来源引用数量无效');value.forEach(id=>rawText(id,'evidence_ids',240,true));return [...new Set(value)]}
function assetRef(value){rawText(value,'asset_ref',240,true);if(!/^asset:[a-f0-9]{64}$/.test(value))throw new Error('媒体只能使用原生asset_ref，不能传路径、网址或base64');return value}
function hasTextOnly(target,body){return !target.segments||target.segments.every(segment=>segment.type==='text')&&typeof body==='string'}
function requireMethod(service,name,label=name){if(typeof service?.[name]!=='function')throw new Error(label+'尚未就绪');return service[name].bind(service)}

/** SDK tools are adapters only. Host context and each native service remain the
 * authority; the model cannot mint source evidence, permissions or receipts. */
export function installNativeTools(ctx,{core}={}){
  if(!ctx?.tools?.register||!core?.services||typeof core.context!=='function'||typeof core.assertMutable!=='function')throw new Error('原生工具需要宿主工具注册器和已绑定Core')
  if(installed.has(ctx)){const previous=installed.get(ctx);if(previous.core!==core)throw new Error('同一宿主不能重复安装不同原生Core工具');return previous.registration}
  const tools=[],disposers=[]
  const context=exec=>{const value=core.context(exec);if(!isPlainObject(value))throw new Error('宿主未返回可信上下文');return value}
  const add=(name,description,parameters,execute,output=jsonOutput)=>tools.push({name,description,parameters,output,execute})
  const mutate=()=>core.assertMutable()
  const social=async(kind,target,body,mode,authority)=>{
    mutate();choice(kind,KINDS,'kind');choice(mode,['dry','go'],'mode');untrustedObject(target);rawText(body,'body',64000)
    if(isQQModeration(kind)){if(body!=='')throw new Error('禁言或解禁无需正文，body请置空');target=normalizeQQModerationTarget(kind,target,authority)}
    if(kind==='qq.send'&&authority.platform==='qq'&&authority.autonomous===true&&target.conversation_id===authority.conversation_id&&hasTextOnly(target,body))throw new Error('本轮QQ最终文字由同一会话自动投递；请直接完成最终回复，避免重复发送')
    return requireMethod(core.services.social,'execute','统一社交入口')({kind,target,body,idempotency_key:requestKey(authority,kind,target,body)},{mode,context:authority})
  }
  add('companion_rounds','原生DSH定时浏览。主人用bind将当前会话真实周期日程绑定到带时区的截止时间（未来24小时内），可附probe_schedule_id。返回plan_id后，run为两平台各排一轮，probe只核验登录。须匹配原生日程本轮真实投递回执；同一投递不重跑，到期不入队，不执行主机命令。',object({operation:enumSchema(['bind','run','probe']),schedule_id:str(),probe_schedule_id:str(),ends_at:str(),plan_id:str()},['operation']),async(args,exec)=>{
    mutate();choice(args.operation,['bind','run','probe'],'operation');const authority=context(exec),service=core.services.scheduled_rounds;if(!service)throw new Error('原生定时浏览入口尚未就绪')
    if(args.operation==='bind'){fields(args,['operation','schedule_id','probe_schedule_id','ends_at']);return service.bind(select(args,['schedule_id','probe_schedule_id','ends_at']),exec,authority)}
    fields(args,['operation','plan_id']);return service.run({plan_id:args.plan_id,probe:args.operation==='probe'},exec,authority)
  })
  const requestedPlatform=(platform,authority)=>{
    const stage=authority.default_platform??authority.platform,resolved=choice(platform??(stage==='system'?'harness':stage),PLATFORMS,'platform')
    if(resolved!==authority.platform&&authority.owner_authorized!==true&&authority.can_manage!==true)throw new Error('当前会话不能指定其他平台')
    return resolved
  }
  const assertTurn=authority=>{if(!authority.source_scope&&!authority.task_id)throw new Error('写入需要宿主已消费的真实输入或活动任务')}

  add('companion_read',nativeReadDescription(),nativeReadParameters(),async(args,exec)=>{
    fields(args,['platform','operation','args']);const authority=context(exec),stage=authority.default_platform??authority.platform,platform=choice(args.platform??(stage==='harness'?'system':stage),['system','qq','bilibili','tieba'],'platform');rawText(args.operation,'operation',80,true)
    return requireMethod(core,'read','原生读取入口')(platform,args.operation,untrustedObject(args.args??{}),authority)
  })
  add('companion_action','统一社交动作。明确要执行时mode=go，dry只预览；unknown不重发，以confirmed回执确认。QQ发送kind=qq.send、target.conversation_id=group:群号、body正文。禁言qq.mute、解禁qq.unmute用target={conversation_id:"group:群号",member_uid:"完整成员QQ",duration_seconds:秒数}，body空；唯一允许群可省略群号，优先companion_read qq.moderation_target解析当前指令，返回目标和时长；唯一近似昵称可用，重名才确认。未写时长使用本机默认值，解禁0；仅本轮真实管理员文字授权。贴吧私信使用kind=tieba.message，target={recipient_uid:完整UID字符串,conversation_id:dm:同一UID字符串}，先direct_contacts/direct_messages读取真实会话；只回当前私信，不改发到公开帖子。贴吧统一kind=tieba.reply：评论帖子主题、新开一楼用target={bar,thread_id}，不带post_id；回复具体楼层才带post_id，回复子评论再带sub_reply_id、reply_uid。楼中楼坐标从thread/sub_replies读取，定位失败不改成新楼；主人明确要在仍存在的父楼中点名某公开账号时，可带reply_profile_id=该主页portrait，系统核验UID并生成可点击引用，不伪造已删除的sub_reply_id；B回复kind=bilibili.reply、target={object_id:"视频aid",object_type:"1",root_reply_id:"根评论ID",parent_reply_id:"被回复ID"}，所有ID用字符串，object_type用数字字符串、不是video。B分享bilibili.share用{via:"qq",bvid,destination:"owner"|"group"|"both",score?,reason?}。',object({kind:enumSchema(KINDS),target:jsonObject,body:str(64000),mode:enumSchema(['dry','go'])},['kind','target','body','mode']),async(args,exec)=>{
    fields(args,['kind','target','body','mode']);return social(args.kind,args.target,args.body,args.mode??'dry',context(exec))
  })
  add('companion_sharing','本轮顺带处理B站推荐策略、原生评论采样与逐条特征估计，不另开模型。policy查额度，sample默认20条/需扩大more=true，record_assessment只引用原生样本ID；发表仍用companion_action，不是AI身份鉴定。',object({operation:enumSchema(['policy','sample','record_assessment']),bvid:str(32),more:{type:'boolean'},sample_id:str(64),labels:{type:'array',items:object({id:str(),label:enumSchema(['suspected','other','uncertain']),reason:str(300)},['id','label']),maxItems:40}},['operation']),async(args,exec)=>{
    const authority=context(exec);untrustedObject(args)
    const fieldsByOperation={policy:[],sample:['bvid','more'],record_assessment:['bvid','sample_id','labels']},allowed=fieldsByOperation[args.operation];if(!allowed)throw new Error('未知分享操作');fields(args,['operation',...allowed])
    if(args.operation!=='policy'){mutate();assertTurn(authority)}
    return requireMethod(core,'sharing','原生分享委托')(args.operation,select(args,allowed),authority)
  })
  add('companion_expression','查找已管理的表情包或B站官方表情。adopt只在主人设置权限下登记素材；普通QQ私图不能自动变为跨平台素材。',object({operation:enumSchema(['list','emotes','adopt']),query:str(),limit:integerSchema(1,20),asset_ref:str(),name:str(120),description:str(500),tags:{type:'array',items:str(40),maxItems:20}},['operation']),async(args,exec)=>{
    const authority=context(exec)
    if(args.operation==='list'){fields(args,['operation','query','limit']);rawText(args.query??'','query',240);integer(args.limit??5,'limit',1,20);return requireMethod(core,'expressionList','原生表情库')({query:args.query??'',limit:args.limit??5},authority)}
    if(args.operation==='emotes'){fields(args,['operation']);return requireMethod(core,'read','原生读取入口')('bilibili','emotes',{},authority)}
    if(args.operation==='adopt'){fields(args,['operation','asset_ref','name','description','tags']);mutate();assertTurn(authority);if(authority.can_manage!==true)throw new Error('登记或修改表情素材需要主人设置权限');assetRef(args.asset_ref);rawText(args.name,'name',120,true);rawText(args.description??'','description',500);if(!Array.isArray(args.tags??[])||(args.tags??[]).length>20)throw new Error('tags数量无效');(args.tags??[]).forEach(tag=>rawText(tag,'tag',40,true));return requireMethod(core,'adoptExpression','原生素材管理')(select(args,['asset_ref','name','description','tags']),authority)}
    throw new Error('未知表情库操作')
  })
  add('companion_diary','写或读取自己的原生日记，不会自动发布。默认private；public仅引用已确认公开证据，私密内容不能转入公开日记。',object({operation:enumSchema(['status','list','write']),platform:enumSchema(PLATFORMS),kind:enumSchema(['private','public']),text:str(64000),evidence_ids:ids,before:str(600),limit:integerSchema(1,100)},['operation']),async(args,exec)=>{
    const authority=context(exec),diary=core.services.diary,access=memoryContext(authority)
    if(args.operation==='status'){fields(args,['operation']);return requireMethod(diary,'status','原生日记')(access)}
    if(args.operation==='list'){fields(args,['operation','platform','kind','before','limit']);if(args.platform)requestedPlatform(args.platform,authority);return requireMethod(diary,'list','原生日记')({...select(args,['platform','before','limit']),kind:args.kind??'private'},access)}
    if(args.operation==='write'){fields(args,['operation','platform','kind','text','evidence_ids']);mutate();assertTurn(authority);const platform=requestedPlatform(args.platform,authority),kind=choice(args.kind??'private',['private','public'],'kind'),text=rawText(args.text,'text',64000,true),evidence_ids=stringIds(args.evidence_ids??[]);if(authority.platform==='qq'&&authority.owner_authorized!==true&&authority.autonomous!==true&&kind!=='private')throw new Error('普通QQ来源只能写同域私密日记');return requireMethod(diary,'write','原生日记')({platform,kind,text,evidence_ids,idempotency_key:requestKey(authority,'diary.write',{platform,kind,evidence_ids:[...evidence_ids].sort()},text)},access)}
    throw new Error('未知日记操作')
  })
  add('companion_learning','基于已登记深读来源顺带学习。propose仅提出主观候选，feedback引用真实用户或反例，rollback仅主人可用；不改人格身份或权限。',object({operation:enumSchema(['status','propose','feedback','rollback']),kind:enumSchema(['reflection','habit','phrase','experience']),content:str(160),question:str(100),evidence_ids:ids,polarity:enumSchema(['positive','negative','counterexample']),topic_id:str(),target_id:str(),revision:integerSchema(0,Number.MAX_SAFE_INTEGER)},['operation']),async(args,exec)=>{
    const authority=context(exec),access=learningContext(authority),learning=core.services.learning
    if(args.operation==='status'){fields(args,['operation']);return requireMethod(learning,'status','原生学习')(access)}
    mutate();assertTurn(authority)
    if(args.operation==='propose'){fields(args,['operation','kind','content','question','evidence_ids']);if(authority.owner_authorized!==true&&authority.autonomous!==true)throw new Error('当前本人反馈能力不能提出全局学习候选');return requireMethod(learning,'propose','原生学习')(select(args,['kind','content','question','evidence_ids']),access)}
    if(args.operation==='feedback'){fields(args,['operation','polarity','topic_id','target_id','evidence_ids']);return requireMethod(learning,'feedback','原生学习')(select(args,['polarity','topic_id','target_id','evidence_ids']),access)}
    if(args.operation==='rollback'){fields(args,['operation','revision']);if(authority.owner_authorized!==true)throw new Error('回退学习版本需要可信主人权限');return requireMethod(learning,'rollback','原生学习')({revision:args.revision},access)}
    throw new Error('未知学习操作')
  })
  const dimensions=object(Object.fromEntries(['happy','calm','sweet','heartache','worry','sad','jealous'].map(key=>[key,{type:'number',minimum:0,maximum:100}])))
  add('companion_mood','读取共享心情或观察当前感受。observe平滑改变心情；relationship只由你根据真实相处自主判断当前QQ来者，attitude=liked/disliked、reason≤180字，不接受用户指定名单。',object({operation:enumSchema(['status','observe','relationship']),attitude:enumSchema(['liked','disliked']),value:{type:'number',minimum:0,maximum:100},dimensions,reason:str(4000),confidence:{type:'number',minimum:0,maximum:100},evidence_ids:ids},['operation']),async(args,exec)=>{
    const authority=context(exec),mood=core.services.mood
    if(args.operation==='status'){fields(args,['operation']);return requireMethod(mood,'status','共享心情')()}
    if(args.operation==='observe'){fields(args,['operation','value','dimensions','reason','confidence','evidence_ids']);mutate();assertTurn(authority);return requireMethod(mood,'observe','共享心情')(select(args,['value','dimensions','reason','confidence','evidence_ids']),moodContext(authority))}
    if(args.operation==='relationship'){fields(args,['operation','attitude','reason']);mutate();assertTurn(authority);return requireMethod(core.services.qq,'observeRelationship','QQ自主相处判断')(select(args,['attitude','reason']),authority)}
    throw new Error('模型工具仅允许读取或观察心情')
  })
  add('companion_speech','只读检查表达中的重复套话；scan只分析提供的文字，不保存样本、不改写、不重发、不另开模型。',object({operation:enumSchema(['status','scan']),text:str(64000),purpose:enumSchema(['chat','structured'])},['operation']),async(args,exec)=>{
    context(exec)
    if(args.operation==='status'){fields(args,['operation']);return requireMethod(core.services.speech,'status','自然表达')()}
    if(args.operation==='scan'){fields(args,['operation','text','purpose']);rawText(args.text,'text',64000);return requireMethod(core.services.speech,'analyze','表达诊断')({text:args.text,purpose:choice(args.purpose??'chat',['chat','structured'],'purpose')})}
    throw new Error('未知表达诊断操作')
  })
  add('companion_image','查看有权读取的原生图片素材，经宿主图像附件显示；QQ当前会话图片请用qq_read_asset。',object({asset_ref:str()},['asset_ref']),async(args,exec)=>{
    fields(args,['asset_ref']);assetRef(args.asset_ref);const authority=context(exec);if(authority.platform==='qq')throw new Error('QQ图片需使用qq_read_asset核对当前会话权限')
    const value=await requireMethod(core,'readImage','原生图像读取')(args.asset_ref,authority)
    if(!/^image\//.test(value?.media_type??'')||!(value.bytes instanceof Uint8Array))throw new Error('素材不是已验证的图片字节')
    const attachments=ctx.get?.('attachments')??ctx.attachments;if(!attachments?.saveImages)throw new Error('宿主正规图像附件服务尚未就绪')
    const refs=await attachments.saveImages([{data:value.bytes,mediaType:value.media_type,name:args.asset_ref}]);if(!refs[0]?.attachmentId)throw new Error('宿主未返回已登记ImageAttachmentRef')
    return {asset_ref:args.asset_ref,attachment:refs[0]}
  },{schema:jsonObject,render:(_args,value)=>[{type:'image',attachment:value.attachment}]})

  const qqSend=async(segments,args,exec)=>{
    const authority=context(exec)
    if(authority.platform!=='qq'&&authority.owner_authorized!==true&&authority.can_manage!==true)throw new Error('QQ媒体只用于可信QQ会话或主人明确管理；B站推荐请用统一bilibili.share')
    const conversation_id=args.conversation_id??(authority.platform==='qq'?authority.conversation_id:'')
    rawText(conversation_id,'conversation_id',240,true)
    if(conversation_id!==authority.conversation_id&&authority.owner_authorized!==true&&authority.can_manage!==true)throw new Error('当前会话不能向其他QQ目标发送媒体')
    return social('qq.send',{conversation_id,segments},'',args.mode??'go',authority)
  }
  add('qq_send_image','向当前QQ会话发送原生图片或表情包素材；与统一社交动作共用Outbox和回执，不接受网址、路径或base64。',object({asset_refs:{type:'array',items:str(),minItems:1,maxItems:9},conversation_id:str(),mode:enumSchema(['dry','go'])},['asset_refs']),async(args,exec)=>{
    fields(args,['asset_refs','conversation_id','mode']);if(!Array.isArray(args.asset_refs)||!args.asset_refs.length||args.asset_refs.length>9)throw new Error('图片数量为1至9张');return qqSend(args.asset_refs.map(id=>({type:'image',asset_ref:assetRef(id)})),args,exec)
  })
  for(const[type,name,label]of [['record','qq_send_voice','语音'],['video','qq_send_video','视频']])add(name,'向当前QQ会话发送原生'+label+'素材，使用统一社交动作及精确回执。',object({asset_ref:str(),conversation_id:str(),mode:enumSchema(['dry','go'])},['asset_ref']),async(args,exec)=>{
    fields(args,['asset_ref','conversation_id','mode']);return qqSend([{type,asset_ref:assetRef(args.asset_ref)}],args,exec)
  })
  const forwardNode=object({name:str(80),segments:{type:'array',items:jsonObject,minItems:1,maxItems:100}},['name','segments'])
  add('qq_send_forward','将明确提供的原生segments节点作为QQ合并转发，经统一社交动作发送；文字用type=text/text，媒体用type=image|record|video|file及asset_ref，转发内容保持引用。',object({nodes:{type:'array',items:forwardNode,minItems:1,maxItems:30},conversation_id:str(),mode:enumSchema(['dry','go'])},['nodes']),async(args,exec)=>{
    fields(args,['nodes','conversation_id','mode']);if(!Array.isArray(args.nodes)||!args.nodes.length||args.nodes.length>30)throw new Error('转发节点为1至30条')
    const nodes=args.nodes.map(node=>{fields(node,['name','segments']);rawText(node.name,'name',80);if(!Array.isArray(node.segments)||!node.segments.length||node.segments.length>100)throw new Error('转发节点消息段数量无效');return {name:node.name,segments:node.segments}})
    return qqSend([{type:'forward',nodes}],args,exec)
  })
  try{for(const tool of tools){const off=ctx.tools.register(tool);if(typeof off==='function')disposers.push(off)}}catch(error){for(const off of disposers.reverse())try{off()}catch{}throw error}
  let disposed=false
  const registration={tools,dispose(){if(disposed)return;disposed=true;for(const off of disposers.reverse())try{off()}catch{}installed.delete(ctx)}}
  installed.set(ctx,{core,registration});return registration
}
