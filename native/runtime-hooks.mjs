import { NativeStore } from './store.mjs'
import { NativeProfileService } from './profile-service.mjs'
import { NativeMemoryRuntime } from './memory-runtime.mjs'
import { isPlainObject,stringifyJson } from './contracts.mjs'
import { valleyDecision } from '../policy.mjs'
import {nativeReadParameters,nativeReadDescription} from './read-contracts.mjs'

const installed=new WeakMap()
const sidOf=value=>value?.agent?.session?.header?.id??value?.agent?.session?.id??value?.session?.header?.id??value?.session?.id??value?.header?.id??value?.id??''
const fields=(value,keys)=>{if(!isPlainObject(value)||Object.keys(value).some(key=>!keys.includes(key)))throw new Error('原生运行钩子参数包含未知字段')}
const contextKeys=['session_id','workspace_id','platform','conversation_id','actor_uid','actor_entity_id','owner_authorized','include_secret','allow_global_summary','memory_only','query','read_memory','write_memory']
const pickContext=value=>Object.fromEntries(contextKeys.filter(key=>value?.[key]!==undefined).map(key=>[key,value[key]]))
const memoryRead=new Set(['memory_search','memory_read','memory_journal','memory_pending','companion_persona','qq_read_asset'])
const maintenanceRead=new Set(['memory_search','memory_read','memory_journal','memory_pending'])
const memoryOnly=new Set([...maintenanceRead,'memory_remember'])
const qqAnswers=new Set([...maintenanceRead,'qq_read_asset','memory_remember','memory_update','companion_learning','companion_mood','companion_diary','companion_expression','qq_send_image','qq_send_voice','qq_send_video','qq_send_forward'])
const optional=(port,method,...args)=>typeof port?.[method]==='function'?port[method](...args):undefined
const short=(value,limit)=>{if(value===undefined||value===null)return '';if(typeof value!=='string')throw new Error('原生上下文callback必须同步返回文本');return value.length<=limit?value:''}

/** Native services only. The caller registers publication/social tools; these
 * hooks bind real SDK sources, apply monotonic execution guards and assemble
 * stable persona plus a small task-related context. */
export function installNativeRuntimeHooks(ctx,options={}){
  fields(options,['store','profiles','people','memory_runtime','qq','activity','session_runner','money_budget','mood','speech','references','learning','social','host_context_resolver','persona_resolver','qq_current_authority','qq_moderation_authority','qq_moderation_lookup_authority','qq_management_authority','now','register_memory_tools','register_profile_tool','register_image_tool'])
  const {store,profiles,memory_runtime:memory,qq,session_runner:runner}=options
  if(!(store instanceof NativeStore)||!(profiles instanceof NativeProfileService)||!(memory instanceof NativeMemoryRuntime)||profiles.store!==store||memory.store!==store)throw new Error('运行钩子必须使用同一NativeStore的原生人设和记忆服务')
  if(options.host_context_resolver!==undefined&&typeof options.host_context_resolver!=='function')throw new Error('host_context_resolver必须为可信宿主函数')
  if(options.qq_moderation_authority!==undefined&&typeof options.qq_moderation_authority!=='function')throw new Error('qq_moderation_authority必须为可信宿主函数')
  if(installed.has(ctx))return installed.get(ctx)
  if(!ctx.systemPrompt?.section||!ctx.systemPrompt?.context||!ctx.tools?.guard)throw new Error('当前SDK缺少稳定prompt或单调工具权限接口')
  const now=options.now??store.now,disposers=[],oldResolver=memory.context_resolver,hostContexts=new Map()
  let warned=false
  const warn=()=>{if(!warned){warned=true;try{ctx.logger?.warn?.('原生上下文有一项暂不可用；未重放任务或发送。')}catch{}}}
  const context=(exec,binding)=>{
    const sid=sidOf(exec),task=runner?.context(sid)
    if(task)return pickContext(task)
    const channel=qq?.contextForSession(sid,binding)
    if(channel){const verified=options.qq_current_authority?.(exec,channel);return pickContext({...channel,owner_authorized:channel.owner_authorized===true&&(!options.qq_current_authority||!!verified),include_secret:false})}
    if(hostContexts.has(sid))return {...hostContexts.get(sid)}
    const host=options.host_context_resolver?.(exec,binding)
    if(host!==undefined&&host!==null){if(!isPlainObject(host)||typeof host.then==='function')throw new Error('可信host context必须为同步显式能力对象');return {...pickContext(host),session_id:sid,owner_authorized:false,include_secret:false,actor_uid:'',actor_entity_id:undefined}}
    return {session_id:sid,platform:'harness',conversation_id:'',actor_uid:'',owner_authorized:false,include_secret:false}
  }
  memory.context_resolver=context
  const platform=agent=>{const resolved=context({agent}),value=options.persona_resolver?.(agent,resolved)
    if(value!==undefined&&value!==null){if(!['main','qq','tieba','bilibili'].includes(value))throw new Error('人格舞台必须由可信工作区绑定提供');return value}
    return ['qq','tieba','bilibili'].includes(resolved.platform)?resolved.platform:'main'}
  const policy=()=>store.getDocument('activity')?.value??{enabled:false}
  const metadata=agent=>({agent,context:context({agent}),platform:platform(agent)})
  const section=spec=>{const off=ctx.systemPrompt.section(spec);if(typeof off==='function')disposers.push(off)}
  section({name:'companion:persona',order:120,text:({agent}={})=>context({agent}).memory_only?'':profiles.render(platform(agent))})
  if(options.speech?.section)section({name:'companion:speech',order:130,text:({agent}={})=>context({agent}).memory_only?'':short(options.speech.section(metadata(agent)),500)})
  section({name:'companion:memory-guide',order:140,text:()=>memory.guide()})
  const offContext=ctx.systemPrompt.context({name:'companion:native-context',order:950,required:true,text:({agent}={})=>{
    try{
      const resolved=context({agent}),input={agent,context:resolved,platform:platform(agent)},lines=[]
      if(!resolved.memory_only){
        if(options.people?.context){const familiar=Object.fromEntries(['session_id','workspace_id','platform','conversation_id','actor_uid','actor_entity_id','owner_authorized','include_secret','read_memory'].filter(key=>resolved[key]!==undefined).map(key=>[key,resolved[key]]));familiar.public_summary_enabled=store.getDocument('settings')?.value.familiarity?.public_summary_enabled===true;lines.push(short(options.people.context(familiar),180))}
        lines.push(short(optional(options.mood,'context',input),120),short(optional(options.references,'context',input),360),short(optional(options.speech,'context',input),120),short(optional(options.learning,'context',input),400),short(optional(options.social,'context',input),260))
      }
      if(runner?.task(sidOf(agent)))lines.push(resolved.memory_only?'【当前任务】仅整理给定少量证据；推断待确认，不联系任何人。':'【当前活动】只做本轮相关的一件事；开口接具体内容，不写内部工作报告。')
      const complete=[];let used=0
      for(const line of lines.filter(Boolean)){if(used+line.length+(complete.length?1:0)>1400)continue;used+=line.length+(complete.length?1:0);complete.push(line)}
      return complete.join('\n')
    }catch{warn();return ''}
  }})
  if(typeof offContext==='function')disposers.push(offContext)
  const register=tool=>{const off=ctx.tools.register(tool);if(typeof off==='function')disposers.push(off)}
  if(options.register_memory_tools!==false)for(const tool of memory.tools())register(tool)
  const jsonOutput={schema:{type:'object',additionalProperties:true},render:(_args,value)=>[{type:'text',text:stringifyJson(value)}]}
  if(options.register_profile_tool!==false)register({name:'companion_persona',description:'只读查看主稿或指定平台当前有效人设；按该平台独立稿和跟随开关解析。',parameters:{type:'object',properties:{platform:{type:'string',enum:['main','qq','tieba','bilibili']}},additionalProperties:false},output:jsonOutput,
    async execute(args={},exec){fields(args,['platform']);const current=platform(exec?.agent),requested=args.platform??current;if(requested!==current&&context(exec).owner_authorized!==true)throw new Error('当前来源只能读取本平台生效人设，不能读取其他平台稿');return {platform:requested,...profiles.resolve(requested)}}})
  if(options.register_image_tool!==false)register({name:'qq_read_asset',description:'查看当前QQ会话有权读取的原生图片asset_ref；原图字节经SDK正规图像附件显示，不把base64当文本。',parameters:{type:'object',properties:{asset_ref:{type:'string'}},required:['asset_ref'],additionalProperties:false},
    output:{schema:{type:'object',additionalProperties:true},render:(_args,value)=>[{type:'image',attachment:value.attachment}]},
    async execute(args,exec){fields(args,['asset_ref']);const resolved=context(exec);if(resolved.platform!=='qq'||!resolved.conversation_id||!qq?.readAsset)throw new Error('此图像工具只接当前可信QQ会话')
      const value=await qq.readAsset(args.asset_ref,{conversation_id:resolved.conversation_id});if(!value.media_type.startsWith('image/'))throw new Error('该素材不是可显示的图片')
      const attachments=ctx.get?.('attachments')??ctx.attachments;if(!attachments?.saveImages)throw new Error('宿主正规图像附件服务尚未就绪')
      const refs=await attachments.saveImages([{data:value.bytes,mediaType:value.media_type,name:args.asset_ref}]);if(!refs[0]?.attachmentId)throw new Error('宿主未返回已登记ImageAttachmentRef')
      return {asset_ref:args.asset_ref,attachment:refs[0]}
    }})
  const allowed=(agent)=>{
    const resolved=context({agent}),task=runner?.task(sidOf(agent))
    if(!task)return null
    if(resolved.memory_only)return memoryOnly
    if(task.batch.tasks.some(row=>row.target?.no_publication===true))return new Set([...memoryOnly,'companion_persona','companion_expression','companion_read','companion_image','companion_diary','companion_learning','companion_speech'])
    if(task.maintenance_kind==='mood')return new Set([...maintenanceRead,'companion_mood'])
    if(task.maintenance_kind==='learning')return new Set([...maintenanceRead,'companion_learning'])
    const names=optional(options.social,'allowed_tool_names',{agent,context:resolved,platform:resolved.platform})??[]
    if(!Array.isArray(names)||names.some(name=>typeof name!=='string'))throw new Error('社交能力必须显式提供工具名列表')
    return new Set([...memoryOnly,'companion_persona','companion_expression','companion_learning','qq_read_asset',...names])
  }
  const guard=ctx.tools.guard(exec=>{
    const sid=sidOf(exec),task=runner?.task(sid)
    if(task&&!allowed(exec.agent).has(exec.name))return '当前短任务未授权此工具；只用本平台统一入口。'
    const chat=qq?.chatForSession(sid)
    const current=context(exec),verifiedAdmin=chat?.startsWith('private:')&&current.owner_authorized===true&&qq?.isTurnAdmin(sid)&&(!options.qq_current_authority||!!options.qq_current_authority(exec,current))
    if(chat&&!task&&!verifiedAdmin){
      if(options.qq_management_authority?.(exec)===true)return
      if(options.qq_moderation_lookup_authority?.(exec)===true)return
      if(exec.name==='companion_action'&&['qq.mute','qq.unmute'].includes(exec.arguments?.kind)&&options.qq_moderation_authority?.(exec)===true)return
      if(!qqAnswers.has(exec.name))return '当前QQ来源仅可问答，不能操作主机、账号或其他平台。'
      if(exec.name==='companion_learning'&&!['status','feedback'].includes(exec.arguments?.operation))return '当前QQ成员仅可读取学习状态或提交本人本轮真实反馈，不能提案或回滚。'
      if(exec.name==='companion_diary'&&exec.arguments?.operation==='write'&&(exec.arguments?.kind??'private')!=='private')return '普通QQ成员只记录同域私密日记，不能写公开日记。'
      const destination=exec.arguments?.conversation_id
      if(exec.name.startsWith('qq_send_')&&destination!==undefined&&destination!==chat)return 'QQ问答媒体只能回到本轮来源会话。'
    }
  })
  if(typeof guard==='function')disposers.push(guard)
  const on=(name,fn)=>{const off=ctx.on(name,fn);if(typeof off==='function')disposers.push(off)}
  on('system-prompt/assemble',async(_assembly,input,next)=>{const assembly=await next(),names=allowed(input?.agent);if(!names)return assembly;const stage=platform(input?.agent);return{...assembly,tools:assembly.tools.filter(tool=>names.has(tool.name)).map(tool=>tool.name==='companion_read'?{...tool,description:nativeReadDescription(stage),parameters:nativeReadParameters(stage)}:tool.name==='companion_persona'?{...tool,parameters:{...tool.parameters,properties:{platform:{type:'string',enum:[stage]}}}}:tool)}})
  on('agent/pre-step',async(payload,next)=>{
    const {agent,messages=[],turn,step,signal}=payload
    qq?.admitMessages(agent,messages)
    const sid=sidOf(agent)
    if(!runner?.task(sid)&&!qq?.chatForSession(sid)&&!hostContexts.has(sid)&&options.host_context_resolver){
      const human=[...messages].reverse().find(message=>message?.role==='user'&&message.source?.kind==='user')
      if(human){const resolved=options.host_context_resolver({agent},{session_id:sid,turn,step,producer:human.source,source_message_id:human.id,purpose:'sdk-consumed-input'})
        if(resolved!==undefined&&resolved!==null){if(!isPlainObject(resolved)||typeof resolved.then==='function')throw new Error('可信host能力必须同步提供');hostContexts.set(sid,Object.freeze({...pickContext(resolved),session_id:sid}))}
      }
    }
    memory.admitMessages(agent,messages)
    runner?.admitMessages(agent,messages,{turn,step})
    const task=runner?.task(sidOf(agent)),p=policy()
    if(task){
      const heavy=task.batch.tasks.some(item=>item.metadata?.heavy!==false),limit=task.batch.model?.max_steps??p.budget?.max_steps??8
      if(signal?.aborted||messages.length>0&&!task.input_bound||task.blocked||task.unknown||step>limit||task.total_tokens>=(p.budget?.max_task_tokens??30000)||heavy&&task.batch.trigger!=='manual'&&!valleyDecision(now(),p).valley){task.stop_reason=step>limit?'本轮已达到步骤上限，停止追加模型调用':task.total_tokens>=(p.budget?.max_task_tokens??30000)?'本轮已达到token保护上限，停止追加模型调用':'本轮已按运行门禁停止，已准备动作以各自回执为准';return {kind:'reject'}}
    }
    const decision=await next()
    if(decision?.kind!=='enter'||signal?.aborted)return decision
    return memory.beforeFetch(agent,decision)
  })
  on('agent/request',async(payload,next)=>{
    runner?.onRequest(payload.agent,payload);options.money_budget?.onRequest(payload)
    const request=await next(),task=runner?.task(sidOf(payload.agent)),resolved=context({agent:payload.agent}),p=policy()
    if(!task&&!['qq','tieba','bilibili'].includes(resolved.platform))return options.money_budget?.enabled()?{...request,maxTokens:Math.min(request.maxTokens??32768,32768)}:request
    const peak=!valleyDecision(now(),p).valley,output=resolved.memory_only?1200:task?.batch.model?.max_output_tokens??(peak?p.model?.peak_max_output_tokens??900:p.model?.max_output_tokens??1800)
    return {...request,reasoningEffort:task?.batch.model?.reasoning_effort??p.model?.reasoning_effort??'low',maxTokens:Math.min(request.maxTokens??Infinity,output)}
  })
  on('llm/stream',(request,next)=>{
    const task=runner?.task(request?.sessionId),chat=qq?.chatForSession(request?.sessionId)
    if(!task&&!chat&&!options.money_budget?.enabled())return next()
    return (async function*(){const sdk=await runner.controller.sdk(),through=task?(start=>runner.stream(request,start,{is_loop_request:sdk.isAgentLoopRequest(request)})):undefined,money=options.money_budget
      if(money)yield* money.stream(request,next,{scope:task?'activity':chat?'qq':'harness',platform:task?.batch.platform??(chat?'qq':'harness'),through});else yield* (through?through(next):next())
    })()
  })
  on('session/event',(session,event)=>{
    try{
      options.money_budget?.onEvent(session,event)
      if(event.type==='turn/start')hostContexts.delete(sidOf(session))
      memory.ingestSessionEvent(session,event)
      if(event.type==='turn/end'){
        Promise.resolve(qq?.onSessionEvent(session,event)).catch(warn).finally(()=>runner?.onSessionEvent(session,event))
      }else{
        // Source commitment must be visible synchronously before the SDK calls
        // the LLM stream; QQ delivery completion is awaited only at turn/end.
        runner?.onSessionEvent(session,event)
        Promise.resolve(qq?.onSessionEvent(session,event)).catch(warn)
      }
      for(const port of [options.mood,options.speech,options.references,options.social])Promise.resolve(optional(port,'on_event',session,event)).catch(warn)
      if(event.type==='turn/end')hostContexts.delete(sidOf(session))
    }catch{warn()}
  })
  let disposed=false
  const dispose=()=>{if(disposed)return;disposed=true;for(const off of disposers.splice(0).reverse())off();hostContexts.clear();if(memory.context_resolver===context)memory.context_resolver=oldResolver;installed.delete(ctx)}
  on('dispose',dispose)
  const result={context,platform,dispose};installed.set(ctx,result);return result
}
