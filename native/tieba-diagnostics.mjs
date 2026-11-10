import {isPlainObject} from './contracts.mjs'

const SOURCES=['status','ports','asset_counts','learning_flags','settings']
const REQUIRED_PORTS=['sdk_hooks','native_tools','agent_registry']
const OPTIONAL_PORTS=['image_attachments','admin_routes','admin_server','admin_connection_policy','resource_runner','transcriber','card_renderer']
const COUNTS=['images','stickers','public_images','bar_samples','current_style_sources']
const FLAGS=['enabled','loop_enabled','bar_style_enabled','persona_evolution_enabled','paused']
const PERMISSIONS=['sign','follow','sign_all_followed','reply','answer_questions','sub_reply','new_thread','images','experimental_image_post','direct_message']
const time=value=>Number.isSafeInteger(value)&&value>=0
const count=value=>Number.isSafeInteger(value)&&value>=0
const boolFields=(value,keys)=>Object.fromEntries(keys.filter(key=>typeof value?.[key]==='boolean').map(key=>[key,value[key]]))
const countsOf=(value,keys)=>Object.fromEntries(keys.filter(key=>count(value?.[key])).map(key=>[key,value[key]]))
const fields=(value,keys)=>{if(!isPlainObject(value)||Object.keys(value).some(key=>!keys.includes(key)))throw new Error('贴吧自检参数包含未知字段')}
const portValue=value=>typeof value==='boolean'?value:['injected','host_module','host_fetch','native_websocket','native_curl','injected_fetch'].includes(value)?value:undefined

/** Projection only. In particular, account objects, credentials, source text,
 * callback errors and arbitrary metadata never enter the diagnostic result. */
export function buildTiebaDiagnostics(input){
  fields(input,[...SOURCES,'errors','checked_at'])
  if(!time(input.checked_at))throw new Error('贴吧自检时钟无效')
  if(input.errors!==undefined&&!Array.isArray(input.errors))throw new Error('贴吧自检来源无效')
  const errors=new Set(input.errors??[])
  if([...errors].some(key=>!SOURCES.includes(key)))throw new Error('贴吧自检来源无效')
  for(const name of SOURCES)if(input[name]!==undefined&&!isPlainObject(input[name]))throw new Error('贴吧自检来源格式无效')
  const status=input.status??{},ports=input.ports??{},settings=input.settings??{},learning=input.learning_flags??{},assets=input.asset_counts??{},checks=[]
  const add=(id,label,state,details={})=>checks.push({id,label,status:state,details})
  for(const name of SOURCES)if(errors.has(name))add('source.'+name,'读取'+({status:'连接状态',ports:'宿主能力',asset_counts:'资源计数',learning_flags:'学习配置',settings:'平台配置'})[name],'unavailable',{reason:'read_failed'})
  const enabled=typeof status.enabled==='boolean'?status.enabled:typeof settings.enabled==='boolean'?settings.enabled:null
  add('platform.enabled','贴吧连接',enabled===null?'unknown':enabled?'ok':'disabled',enabled===null?{}:{enabled})
  const credentials=boolFields(status,['credential_configured','authenticated','tbs_available'])
  const verified=status.authenticated===true&&status.tbs_available===true
  add('authentication.cache','缓存登录状态',enabled===false?'disabled':verified?'ok':status.credential_configured===false?'blocked':'warning',{
    ...credentials,official_refresh_performed:false,next_step:'open_platform_login_status_for_official_refresh',
    reason:verified?'cached_authentication_available':status.credential_configured===false?'credential_not_configured':'cache_does_not_confirm_current_login'
  })
  const risk=boolFields(status,['verification_required']),paused_until=time(status.paused_until)?status.paused_until:null
  add('publication.risk','平台发表限制',status.verification_required===true?'blocked':paused_until!==null&&paused_until>input.checked_at?'warning':typeof status.verification_required==='boolean'?'ok':'unknown',{
    ...risk,...(paused_until!==null?{paused_until}:{}),automatic_resume:false
  })
  const nativePorts=Object.fromEntries([...REQUIRED_PORTS,...OPTIONAL_PORTS,'sdk','http','qq_transport'].filter(key=>portValue(ports[key])!==undefined).map(key=>[key,portValue(ports[key])]))
  const missing=REQUIRED_PORTS.filter(key=>ports[key]===false),unknown=REQUIRED_PORTS.filter(key=>typeof ports[key]!=='boolean')
  add('runtime.ports','原生宿主能力',missing.length?'blocked':unknown.length?'unknown':'ok',{ports:nativePorts,missing,unknown})
  if(['native_curl','injected_fetch'].includes(status.transport))add('transport','贴吧请求通道','ok',{configured:status.transport,execution_probe_performed:false})
  else add('transport','贴吧请求通道','unknown',{execution_probe_performed:false})
  for(const [key,label]of [['comment_inbox','评论收件监测'],['mention_inbox','艾特收件监测']]){
    const row=isPlainObject(status[key])?status[key]:{},details={...boolFields(row,['polled']),...countsOf(row,['queued','unresolved']),...(time(row.checked_at)?{checked_at:row.checked_at}:{})}
    add('inbox.'+key,label,row.unresolved>0?'warning':row.polled===true?'ok':Object.keys(details).length?'warning':'unknown',details)
  }
  const resourceCounts=countsOf(assets,COUNTS)
  add('assets','已登记资源',Object.keys(resourceCounts).length?'ok':'unknown',resourceCounts)
  const learningFlags=boolFields(learning,FLAGS)
  add('learning','学习与演化',learning.paused===true?'warning':learning.enabled===false?'disabled':learning.enabled===true?'ok':'unknown',learningFlags)
  if(input.settings!==undefined){
    const permissions=boolFields(settings.permissions,PERMISSIONS),bars=Array.isArray(settings.bars)?settings.bars.filter(row=>typeof row==='string'||isPlainObject(row)).length:null
    add('configuration','平台配置','ok',{...(bars!==null?{configured_bars:bars}:{}),permissions,...(isPlainObject(settings.comment_inbox)?{comment_inbox:boolFields(settings.comment_inbox,['enabled','seed_on_start'])}:{}),...(isPlainObject(settings.inbox)?{private_inbox:boolFields(settings.inbox,['enabled','seed_on_start'])}:{})})
  }
  add('headless.standalone','独立无头浏览器','not_applicable',{reason:'unified_native_transport_and_scheduler'})
  const summary={total:checks.length,...Object.fromEntries(['ok','warning','blocked','unavailable','unknown','disabled','not_applicable'].map(state=>[state,checks.filter(row=>row.status===state).length]))}
  return {platform:'tieba',checked_at:input.checked_at,read_only:true,summary,checks,model_calls:0,mutations:0,publication_attempts:0,shell_probes:0}
}

/** Each host callback must be a read-only snapshot. Do not pass login refresh,
 * resource probing, polling, sign-in, publication or profile-creation methods.
 * Callback failures are isolated and represented without their private text. */
export class NativeTiebaDiagnostics{
  constructor({now=Date.now,getStatus,getPorts,getAssetCounts,getLearningFlags,getSettings}={}){
    if(typeof now!=='function'||[getStatus,getPorts,getAssetCounts,getLearningFlags].some(fn=>typeof fn!=='function')||getSettings!==undefined&&typeof getSettings!=='function')throw new Error('贴吧自检需要只读状态、宿主能力、资源与学习回调')
    this.now=now;this.sources={status:getStatus,ports:getPorts,asset_counts:getAssetCounts,learning_flags:getLearningFlags,...(getSettings?{settings:getSettings}:{})}
  }
  async check(input={},trusted={}){
    if(trusted.owner_authorized!==true)throw new Error('贴吧自检需要主人授权的设置会话')
    fields(input,[])
    const checked_at=this.now();if(!time(checked_at))throw new Error('贴吧自检时钟无效')
    const entries=Object.entries(this.sources),rows=await Promise.allSettled(entries.map(([,fn])=>Promise.resolve().then(()=>fn()).then(value=>{if(!isPlainObject(value))throw new Error('snapshot_invalid');return value}))),snapshot={checked_at,errors:[]}
    for(const [index,[name]]of entries.entries())if(rows[index].status==='fulfilled')snapshot[name]=rows[index].value;else snapshot.errors.push(name)
    return buildTiebaDiagnostics(snapshot)
  }
}
