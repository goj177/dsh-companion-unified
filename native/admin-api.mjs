import { NativeStore } from './store.mjs'
import {ownerActivityReports} from './activity-report.mjs'
import { NativeProfileService } from './profile-service.mjs'
import { NativeMemory } from './memory.mjs'
import { NativeDiary } from './diary.mjs'
import { isPlainObject, validateJson } from './contracts.mjs'
import {NativeUpdateChecker} from './update-check.mjs'

export const NATIVE_ADMIN_BASE='/api/companion/v3'
const PLATFORMS=['qq','bilibili','tieba']
const EDITABLE_DOCUMENTS=new Set(['settings','activity','mood','hormone','speech','learning','learning-loop','qq','tieba','bilibili','bilibili-inbox'])
const PRIVATE_FIELD=/^(?:access_token|refresh_token|api_key|password|credentials?|credential_ref|cookies?|csrf|bili_jct|sessdata|buvid\d*|bduss|stoken)$/i
const clone=value=>structuredClone(value)
const local=value=>['localhost','127.0.0.1','[::1]','::1','::ffff:127.0.0.1'].includes(String(value).toLowerCase())
const allowedKeys=(value,keys)=>{
  if(!isPlainObject(value)||Object.keys(value).some(key=>!keys.includes(key)))throw new Error('请求包含不支持的字段')
}
function revision(value){if(!Number.isSafeInteger(value)||value<0)throw new Error('请提供当前设置版本')}
function merge(base,patch){
  if(!isPlainObject(patch))throw new Error('设置改动必须是对象')
  const next=clone(base)
  for(const[key,value]of Object.entries(patch)){
    if(['__proto__','prototype','constructor'].includes(key)||PRIVATE_FIELD.test(key))throw new Error('该字段请使用专门的账号设置入口')
    next[key]=isPlainObject(value)?merge(isPlainObject(next[key])?next[key]:{},value):clone(value)
  }
  return next
}
function publicDocument(row){
  if(!row)return null
  const clean=value=>Array.isArray(value)?value.map(clean):isPlainObject(value)?Object.fromEntries(Object.entries(value)
    .filter(([key])=>!PRIVATE_FIELD.test(key)).map(([key,v])=>[key,clean(v)])):value
  return {...row,value:clean(row.value)}
}

/** Settings are a local owner surface. Public source text never grants access. */
export function nativeAdminRequestAllowed(req,connection){
  const headers=req.headers||{},remote=req.socket?.remoteAddress||req.connection?.remoteAddress
  if(headers['sec-fetch-site']==='cross-site'||remote&&!local(remote))return false
  let host
  try{host=new URL('http://'+String(headers.host||''))}catch{return false}
  if(!local(host.hostname)||host.username||host.password||host.pathname!=='/')return false
  let framework=false
  if(connection?.requestRejection){try{const rejection=connection.requestRejection(req);if(rejection!==undefined&&rejection!==null&&rejection!==false)return false;framework=true}catch{return false}}
  if(!headers.origin)return true
  if(headers.origin==='dsh-app://app')return framework
  try{const origin=new URL(headers.origin);return ['http:','https:'].includes(origin.protocol)&&origin.host===host.host&&!origin.username&&!origin.password}catch{return false}
}
async function readBody(req){
  if(!String(req.headers?.['content-type']||'').toLowerCase().startsWith('application/json'))throw new Error('请提交JSON内容')
  let body=''
  if(typeof req.body==='string'||Buffer.isBuffer(req.body))body=String(req.body)
  else for await(const chunk of req){body+=chunk;if(Buffer.byteLength(body)>262144)throw new Error('提交内容过大')}
  if(Buffer.byteLength(body)>262144)throw new Error('提交内容过大')
  const result=JSON.parse(body||'{}');validateJson(result,{object:true,maxBytes:262144});return result
}
function send(res,status,value){res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(JSON.stringify(value))}
const unavailable=message=>Object.assign(new Error(message||'此功能尚未就绪'),{httpStatus:503})
const ownerContext={platform:'harness',conversation_id:'local-settings',owner_authorized:true,include_secret:false}

export function createNativeAdminApi({store,profiles=new NativeProfileService({store}),memory=new NativeMemory(store),diary=new NativeDiary({store}),activity,hormone,learning_loop,consolidate_learning,tieba_atmosphere,
  platforms={},people,affinities,portability,connection,on_change,updates=new NativeUpdateChecker()}={}){
  if(!(store instanceof NativeStore))throw new Error('新版设置必须使用NativeStore')
  const ownerActivity=async()=>ownerActivityReports(store,activity?.status?await activity.status():{tasks:[],blocks:[],available:false})
  const snapshot=async()=>{
    const documents={}
    for(const id of EDITABLE_DOCUMENTS){const row=store.getDocument(id);if(row)documents[id]=publicDocument(row)}
    const persona={}
    for(const platform of ['main',...PLATFORMS]){try{persona[platform]={own:profiles.ownProfile(platform),effective:profiles.resolve(platform)}}catch{persona[platform]={own:null,effective:null,error:'当前平台尚未配置人设'}}}
    const platformStatus={}
    for(const platform of PLATFORMS){
      const service=platforms[platform]
      try{platformStatus[platform]=service?.status?await service.status():{status:'unavailable',message:'平台服务尚未就绪'}}
      catch{platformStatus[platform]={status:'error',message:'平台状态暂时无法读取'}}
    }
    const tasks=await ownerActivity()
    const budget=tasks.budget??null,mood=store.getDocument('mood')?.value.state??null
    let hormoneStatus=null
    try{if(typeof hormone?.status==='function')hormoneStatus=hormone.status()}catch{hormoneStatus={available:false}}
    return {ok:true,version:3,schema_version:3,documents,profiles:persona,updates:updates.status(),overview:{budget,mood,hormone:hormoneStatus,money_budget:tasks.money_budget??null,platforms:platformStatus},activity:tasks,
      capabilities:{documents:!store.readOnly,profiles:!store.readOnly,rounds:{bilibili:!!activity?.runOneRound&&!store.readOnly,tieba:!!activity?.runOneRound&&!store.readOnly},
        memory:true,diary:true,update_check:true,people:typeof people==='function',portability:!!portability,learning:{items:typeof learning_loop?.list==='function',manage:typeof learning_loop?.manage==='function'&&!store.readOnly,consolidate:typeof consolidate_learning==='function'&&!store.readOnly},
        authentication:Object.fromEntries(PLATFORMS.map(p=>[p,!!platforms[p]?.login&&!store.readOnly])),platform_actions:{bilibili:{check_inbox:!!platforms.bilibili?.checkInbox&&!store.readOnly,reconcile_today:!!platforms.bilibili?.reconcileToday&&!store.readOnly},tieba:{atmosphere:typeof tieba_atmosphere?.list==='function',check_inbox:!!platforms.tieba?.checkInbox&&!store.readOnly,inspect_page:!!platforms.tieba?.inspectPage&&!store.readOnly,check_private:!!platforms.tieba?.checkPrivate&&!store.readOnly}}}}
  }
  const handlers=new Map(),route=(method,path,handler)=>handlers.set(method+' '+NATIVE_ADMIN_BASE+path,handler)
  route('GET','/snapshot',()=>snapshot())
  route('POST','/updates/check',async(req)=>{const body=await readBody(req);allowedKeys(body,[]);return {ok:true,...await updates.check()}})
  route('GET','/activity',async()=>({ok:true,...await ownerActivity()}))
  route('GET','/tieba/atmosphere',async(_req,url)=>{
    if([...url.searchParams.keys()].some(key=>key!=='bar'))throw new Error('吧内参考查询含未知字段')
    if(!tieba_atmosphere?.list||!tieba_atmosphere?.profile)throw unavailable('吧内参考暂时无法读取')
    const bar=url.searchParams.get('bar')
    if(bar!==null){const value=tieba_atmosphere.profile({bar}),{sources,...summary}=value,samples=value.samples.slice(0,4).map(row=>({thread_id:row.thread_id,author_uid:row.author_uid,scene:row.scene,text:(()=>{let end=Math.min(240,row.text.length);if(end>0&&/[\uD800-\uDBFF]/.test(row.text[end-1])&&/[\uDC00-\uDFFF]/.test(row.text[end]??''))end--;return row.text.slice(0,end)})(),evidence_id:row.evidence_id,ref:value.sources.find(source=>source.evidence_id===row.evidence_id)?.ref??''}));return {ok:true,...summary,samples}}
    return {ok:true,items:tieba_atmosphere.list().items.slice(0,50).map(({sources,...row})=>row)}
  })
  for(const id of EDITABLE_DOCUMENTS)route('POST','/documents/'+id,async(req)=>{
    const body=await readBody(req);allowedKeys(body,['expected_revision','patch']);revision(body.expected_revision)
    const old=store.getDocument(id);if(!old)throw new Error('该项设置尚未初始化')
    if(!isPlainObject(body.patch)||!Object.keys(body.patch).length)throw new Error('没有需要保存的改动')
    // Identities, account bindings and physical resources have dedicated flows.
    const protectedFields=['account_entity_id','owner_entity_id','self_profile_id','default_persona_id','platform_document_ids',
      'activity_document_id','mood_document_id','speech_document_id','learning_document_id']
    if(Object.keys(body.patch).some(k=>protectedFields.includes(k))||id==='mood'&&Object.hasOwn(body.patch,'state'))throw new Error('请在对应的人设或账号入口修改此项')
    if(id==='hormone'&&Object.keys(body.patch).some(key=>!['enabled','mode','policy'].includes(key)))throw new Error('精力和压力只能由真实活动变化，不能直接改写当前状态')
    if(id==='learning'&&Object.hasOwn(body.patch,'active_revision')||id==='learning-loop'&&Object.keys(body.patch).some(key=>!['enabled','policy'].includes(key)))throw new Error('学习版本、来源和使用记录由实际学习过程维护，不能通过设置改写')
    if(id==='qq'&&Object.hasOwn(body.patch.qq??{},'relationships'))throw new Error('QQ亲疏由欧鲸鲸自主决定，不能通过设置指定名单')
    const value=merge(old.value,body.patch),document=store.putDocument({id,type:old.type,value,expected_revision:body.expected_revision})
    const effect=await on_change?.({document_id:id,type:old.type,revision:document.revision})
    return {ok:true,document:publicDocument(document),restart_required:effect?.restart_required===true,message:effect?.message||'已保存'}
  })
  for(const platform of ['main',...PLATFORMS])route('POST','/profiles/'+platform,async(req)=>{
    const body=await readBody(req),result=profiles.save(platform,body,{owner_authorized:true})
    await on_change?.({profile_id:result.profile.id,platform})
    return {ok:true,profile:result.profile,changed:result.changed,message:result.changed?'人设已保存，下次生成生效':'人设没有变化'}
  })
  route('POST','/rounds',async(req)=>{
    const body=await readBody(req);allowedKeys(body,['platform','read_per_round','reply_per_round']);if(!['bilibili','tieba'].includes(body.platform))throw new Error('请选择B站或贴吧')
    if(!activity?.runOneRound)throw unavailable('活动执行器尚未就绪')
    const result=await activity.runOneRound(body.platform,{trigger:'manual',...(body.read_per_round===undefined?{}:{read_per_round:body.read_per_round}),...(body.reply_per_round===undefined?{}:{reply_per_round:body.reply_per_round})})
    const task=result.task??result
    return {ok:true,...result,task,duplicate:result.duplicate===true}
  })
  route('GET','/qq-affinities',async()=>{if(typeof affinities!=='function')throw unavailable('自主相处判断尚未就绪');return {ok:true,decider:'companion',editable:false,items:await affinities()}})
  route('GET','/people',async(_req,url)=>{
    if(typeof people!=='function')throw unavailable('熟人索引尚未就绪')
    return {ok:true,items:await people({query:url.searchParams.get('query')??'',platform:url.searchParams.get('platform')||undefined})}
  })
  route('GET','/diary',(_req,url)=>({ok:true,...diary.list({kind:url.searchParams.get('kind')??'public',
    ...(url.searchParams.get('platform')?{platform:url.searchParams.get('platform')}:{}),
    ...(url.searchParams.get('before')?{before:url.searchParams.get('before')}:{})},ownerContext)}))
  route('GET','/diary/status',()=>({ok:true,...diary.status(ownerContext)}))
  route('POST','/diary/write',async(req)=>{
    const body=await readBody(req);allowedKeys(body,['platform','kind','text','evidence_ids','idempotency_key'])
    return {ok:true,...diary.write(body,ownerContext)}
  })
  route('GET','/memory/search',(_req,url)=>{
    const query=url.searchParams.get('query')??'',mode=url.searchParams.get('mode')??'memory'
    if(!['memory','journal','pending'].includes(mode))throw new Error('不支持的记忆视图')
    const filter={query,limit:20,max_chars:1800}
    if(url.searchParams.get('platform'))filter.platform=url.searchParams.get('platform')
    let result=mode==='pending'?memory.pendingConflicts({limit:20,max_chars:1800},ownerContext)
      :mode==='journal'?memory.searchJournal(filter,ownerContext):memory.recall(filter,ownerContext)
    if(mode==='memory'&&!filter.platform&&typeof learning_loop?.searchMemory==='function'){
      const learned=learning_loop.searchMemory({query,limit:1,max_chars:360},ownerContext)
      if(learned.items.length){const lines=learned.items.map(item=>item.id+' '+item.label+'（'+item.status+'）：'+item.summary),budget=1800-lines.join('\n').length-1;result=memory.recall({...filter,max_chars:budget},ownerContext);result={...result,items:[...learned.items,...result.items],text:[lines.join('\n'),result.text].filter(Boolean).join('\n'),abstained:false,untrusted:true}}
    }
    return {ok:true,...result}
  })
  route('GET','/memory/read',(_req,url)=>{
    const id=url.searchParams.get('id'),offset=Number(url.searchParams.get('offset')??0)
    const input={id,offset,max_chars:1800}
    let detail=id?.startsWith('learning-card:')&&typeof learning_loop?.readMemory==='function'?learning_loop.readMemory(input,ownerContext):memory.readEntry(input,ownerContext)
    if(!detail.found)detail=memory.readEvidence(input,ownerContext)
    if(!detail.found){const event=store.getJournalEvent(id);if(event&&event.visibility!=='secret'){
      const text=event.text, end=Math.min(text.length,offset+1800)
      if(!Number.isSafeInteger(offset)||offset<0||offset>text.length)throw new Error('分页位置无效')
      detail={...event,found:true,text:text.slice(offset,end),offset,total_chars:text.length,next_offset:end<text.length?end:null,untrusted:true}
    }}
    return {ok:true,detail}
  })
  route('POST','/memory/forget',async(req)=>{
    const body=await readBody(req);allowedKeys(body,['id','mode','reason']);return {ok:true,...memory.forget(body,ownerContext)}
  })
  route('POST','/memory/restore',async(req)=>{
    const body=await readBody(req);allowedKeys(body,['id','reason']);return {ok:true,...memory.restore(body,ownerContext)}
  })
  route('POST','/memory/consolidate',async(req)=>{
    const body=await readBody(req);allowedKeys(body,['query'])
    if(!activity?.enqueue)throw unavailable('记忆整理执行器尚未就绪')
    return {ok:true,...await activity.enqueue({platform:'bilibili',kind:'maintenance',trigger:'manual',target:{maintenance_kind:'memory',query:body.query??''},heavy:true,human:false})}
  })
  route('GET','/learning/items',async(_req,url)=>{
    if(typeof learning_loop?.list!=='function')throw unavailable('学过的表达暂时无法读取')
    if([...url.searchParams.keys()].some(key=>!['query','status','limit'].includes(key)))throw new Error('学习筛选包含不支持的字段')
    const query=url.searchParams.get('query')??'',status=url.searchParams.get('status')||undefined,limit=Number(url.searchParams.get('limit')??30)
    if(query.length>240||status&&!['trial','active','paused','retired'].includes(status)||!Number.isSafeInteger(limit)||limit<1||limit>100)throw new Error('学习筛选范围无效')
    const result=await learning_loop.list({query,...(status?{status}:{}),limit},ownerContext)
    if(!Array.isArray(result?.items))throw unavailable('学习记录尚未返回有效列表')
    const statusResult=typeof learning_loop.status==='function'?await learning_loop.status(ownerContext):null
    return {ok:true,...result,...(statusResult?{summary:{enabled:statusResult.enabled,counts:statusResult.counts,revision:statusResult.revision,pending_sources:statusResult.pending_sources}}:{})}
  })
  route('GET','/learning/status',async()=>{
    if(typeof learning_loop?.status!=='function')throw unavailable('学习状态暂时无法读取')
    const result=await learning_loop.status(ownerContext)
    return {ok:true,enabled:result.enabled,counts:result.counts,revision:result.revision,pending_sources:result.pending_sources}
  })
  route('GET','/learning/detail',async(_req,url)=>{
    if(typeof learning_loop?.detail!=='function')throw unavailable('学习应用记录暂时无法读取')
    if([...url.searchParams.keys()].some(key=>!['id','limit'].includes(key)))throw new Error('学习详情包含不支持的字段')
    const id=url.searchParams.get('id'),limit=Number(url.searchParams.get('limit')??10)
    if(typeof id!=='string'||!id||id.length>160||!Number.isSafeInteger(limit)||limit<1||limit>20)throw new Error('学习详情范围无效')
    return {ok:true,...await learning_loop.detail({id,limit},ownerContext)}
  })
  route('POST','/learning/consolidate',async(req)=>{
    const body=await readBody(req);allowedKeys(body,[])
    if(typeof consolidate_learning!=='function')throw unavailable('学习整理暂时无法启动')
    const result=await consolidate_learning()
    if(!isPlainObject(result))throw unavailable('学习整理尚未返回有效结果')
    return {ok:true,...result}
  })
  route('POST','/learning/manage',async(req)=>{
    const body=await readBody(req);allowedKeys(body,['id','operation','expected_revision','version']);revision(body.expected_revision)
    if(typeof body.id!=='string'||!body.id||body.id.length>160||!['pause','resume','rollback','retire'].includes(body.operation)||body.version!==undefined&&(!Number.isSafeInteger(body.version)||body.version<1||body.operation!=='rollback'))throw new Error('请选择有效学习项、操作和版本')
    if(typeof learning_loop?.manage!=='function')throw unavailable('学习项管理暂时无法使用')
    return {ok:true,...await learning_loop.manage(body,ownerContext)}
  })
  for(const platform of PLATFORMS)route('POST','/platforms/'+platform+'/login',async(req)=>{
    if(!platforms[platform]?.login)throw unavailable('该平台登录入口尚未接入')
    const body=await readBody(req);allowedKeys(body,['operation','login_id'])
    if(!['start','poll','cancel'].includes(body.operation))throw new Error('登录操作无效')
    return {ok:true,...await platforms[platform].login(body,{...ownerContext,local_settings:true})}
  })
  for(const[platform,operation,method]of [['bilibili','check-inbox','checkInbox'],['bilibili','reconcile-today','reconcileToday'],['tieba','check-inbox','checkInbox'],['tieba','inspect-page','inspectPage'],['tieba','check-private','checkPrivate']])route('POST','/platforms/'+platform+'/'+operation,async(req)=>{
    const service=platforms[platform]?.[method];if(typeof service!=='function')throw unavailable('当前实例尚未开放这个平台操作')
    const body=await readBody(req);allowedKeys(body,[]);return {ok:true,...await service(body,{...ownerContext,local_settings:true})}
  })
  route('POST','/platforms/tieba/credentials',async(req,url)=>{
    if(url.search)throw new Error('贴吧凭据只能放在本机专门请求正文中')
    if(!platforms.tieba?.login)throw unavailable('贴吧账号绑定入口尚未接入')
    let body;try{body=await readBody(req);allowedKeys(body,['cookie_header'])}catch{throw new Error('贴吧凭据请求无效，请使用专门的账号输入框')}
    if(typeof body.cookie_header!=='string'||!body.cookie_header||body.cookie_header.length>65536)throw new Error('请提供不超过65536字节的Cookie请求头')
    const result=await platforms.tieba.login({operation:'import_cookie',cookie_header:body.cookie_header},{...ownerContext,local_settings:true})
    if(result?.status!=='confirmed'||typeof result.account?.uid!=='string'||!/^\d+$/.test(result.account.uid)||typeof result.account.name!=='string')throw new Error('官方尚未确认账号绑定，原账号保持不变')
    await on_change?.({platform:'tieba',account_binding_changed:true})
    return {ok:true,platform:'tieba',status:'confirmed',authenticated:true,account:{uid:result.account.uid,name:result.account.name},verification_required:result.verification_required===true,paused_until:result.paused_until??null,automatic_resume:false}
  })
  route('POST','/platforms/tieba/resume',async(req,url)=>{
    if(url.search)throw new Error('请从本机账号区明确确认官方处理已完成')
    const body=await readBody(req);allowedKeys(body,['official_check_completed'])
    if(body.official_check_completed!==true)throw new Error('请先完成官方验证，再确认重新检查并恢复')
    if(!platforms.tieba?.resume)throw unavailable('贴吧人工恢复入口尚未接入')
    const result=await platforms.tieba.resume({official_check_completed:true},{...ownerContext,local_settings:true})
    if(result?.resumed!==true||result.old_actions_replayed!==false)throw new Error('官方状态尚未确认恢复，原动作保持原状态')
    await on_change?.({platform:'tieba',manual_verification_completed:true})
    return {ok:true,resumed:true,activity_unblocked:result.activity_unblocked===true,old_actions_replayed:false}
  })
  route('POST','/portability/export',async(req)=>{
    const body=await readBody(req);allowedKeys(body,['include_credentials'])
    if(typeof body.include_credentials!=='boolean')throw new Error('请选择是否包含登录状态')
    if(!portability?.exportBundle)throw unavailable('搬家导出尚未就绪')
    return {ok:true,...await portability.exportBundle(body)}
  })
  route('POST','/portability/import',async(req)=>{
    const body=await readBody(req);allowedKeys(body,['bundle_path','confirmed'])
    if(typeof body.bundle_path!=='string'||!body.bundle_path.trim()||body.confirmed!==true)throw new Error('请选择搬家包并确认恢复')
    if(!portability?.importBundle)throw unavailable('搬家导入尚未就绪')
    return {ok:true,...await portability.importBundle(body)}
  })
  const handle=async(req,res,forcedPath)=>{
    if(!nativeAdminRequestAllowed(req,typeof connection==='function'?connection():connection))return send(res,403,{ok:false,error:'请从本机设置页面访问'})
    let url;try{url=new URL(req.url||forcedPath||'/', 'http://localhost')}catch{return send(res,400,{ok:false,error:'请求地址无效'})}
    const pathname=forcedPath??url.pathname,key=req.method+' '+pathname,handler=handlers.get(key)
    if(!handler)return send(res,[...handlers.keys()].some(k=>k.endsWith(' '+pathname))?405:404,{ok:false,error:'此接口或请求方式不受支持'})
    if(req.method!=='GET'&&store.readOnly)return send(res,403,{ok:false,error:'当前实例为只读'})
    try{const result=await handler(req,url);send(res,200,result)}catch(error){const conflict=/版本冲突/.test(error.message)
      send(res,conflict?409:error.httpStatus??400,{ok:false,error:String(error.message||'操作失败').slice(0,180),...(conflict?{conflict:true}:{})})}
  }
  return {handle,snapshot,paths:[...new Set([...handlers.keys()].map(key=>key.slice(key.indexOf(' ')+1)))]}
}

export function installNativeAdminApi(ctx,options){
  const routes=createNativeAdminApi({...options,connection:options?.connection??(()=>{try{return ctx.get?.('connection')??ctx.connection}catch{return undefined}})})
  let mounted=false,timer;const disposers=[]
  const mount=()=>{if(mounted)return;let server;try{server=ctx.get?.('webServer')??ctx.webServer}catch{return}
    if(!server?.register)return
    for(const path of routes.paths)disposers.push(server.register({kind:'exact',path,handler:(req,res)=>routes.handle(req,res,path)}))
    mounted=true;clearInterval(timer)
  }
  const dispose=()=>{clearInterval(timer);for(const off of disposers.reverse())off?.()}
  const install=()=>{mount();if(!mounted){timer=setInterval(mount,500);timer.unref?.()}return dispose}
  if(ctx.effect)ctx.effect(install,'companion-native:settings');else install()
  return {routes,dispose}
}
