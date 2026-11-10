import {semanticMessageText} from './memory-query.mjs'
/** Native Tieba service. Pure protocol adaptation attribution is in tieba-http.mjs.
 * No vendor module, legacy path, credential file, shell transport or standalone scheduler is loaded.
 */
import {createHash,randomUUID} from 'node:crypto'
import {isDeepStrictEqual} from 'node:util'
import {NativeStore} from './store.mjs'
import {NativeRoundPolicy} from './round-policy.mjs'
import {tiebaEmotes,checkedTiebaEmotes,compileTiebaMedia,compileTiebaWebMedia,compileTiebaWapMedia,parseTiebaWapPictureUpload,parseWapUploadAppPicture,matchesTiebaMedia,verifyTiebaReadbackImage} from './tieba-media.mjs'
import {encodeTiebaAppMediaReply} from './tieba-app-media.mjs'
import {accountSourceUid,publicSourceContext,attributePublicRows,renderPublicSource,explicitSourceReplyUid} from './source-context.mjs'
import {parsePostPage,parseSubPage,encodeProfileRequest,parseUserProfile} from './tieba-http.mjs'
import {NativeMemory} from './memory.mjs'
import {registerNativeReadSource} from './read-record-view.mjs'
import {isPlainObject,stringifyJson,validateJson} from './contracts.mjs'
import {redactText,safeJson} from './memory-rules.mjs'
import {shanghaiTime} from '../policy.mjs'
import {canPublishAsset} from './asset-policy.mjs'
import {selectTiebaMedia,compactTiebaMediaHint} from './tieba-media-selection.mjs'
import {createTiebaCurlFetcher} from './tieba-curl.mjs'
import {NativeTiebaInbox} from './tieba-inbox.mjs'
import {NativeTiebaReplies} from './tieba-replies.mjs'
import {assertTiebaPublishableText} from './tieba-content.mjs'
import {assertTiebaActionTarget,tiebaReplyPaused,tiebaDeclaredAnswerAllowed} from './tieba-target.mjs'
import {NativeTiebaAtmosphere,canonicalBar} from './tieba-atmosphere.mjs'
import {tiebaConversationSevenState,directPersonalInsult} from './tieba-conversation-style.mjs'
import {NativeTiebaMentions} from './tieba-mentions.mjs'
import {NativeTiebaVision,tiebaRowImageSources} from './tieba-vision.mjs'
import {NativeExpressionVisual} from './expression-visual.mjs'
import {currentRunScope,withRunScope,assertRunActive,abortableRun} from './run-scope.mjs'
export {projectNativeTiebaReadToolResult} from './read-result-projection.mjs'
import {TiebaError,TIEBA_HOST,TIEBA_APP,TIEBA_UA,tiebaId,exactTiebaJson,trustedTiebaUrl,appSignature,pcSignature,parseBarHtml,parsePcBar,parseThreadHtml,encodePageRequest,encodeSubRequest,parsePagePosts,parseSubPosts,pbFields,parseAddReceipt,outboundAllowed} from './tieba-http.mjs'

const sha=value=>createHash('sha256').update(value).digest('hex'),clone=value=>structuredClone(value)
const publicationErrorInfo=error=>{
 const names=new Set(['Error','TypeError','RangeError','SyntaxError','AbortError','TimeoutError','TiebaError','TiebaTransportError']),codes=new Set(['invalid_response','read_failed','verification_required','risk_pause','account_changed','invalid_action_lease','permission_denied','participation_paused','disabled','closed','authentication_required','tieba_transport_failed','tieba_transport_aborted','tieba_transport_response_invalid','tieba_transport_size_limit','tieba_transport_not_started','ECONNRESET','ETIMEDOUT','EPIPE','ECONNABORTED','ENOTFOUND','EAI_AGAIN','UND_ERR_SOCKET','UND_ERR_CONNECT_TIMEOUT','SQLITE_BUSY','ERR_INVALID_STATE','ERR_STREAM_PREMATURE_CLOSE'])
 const name=names.has(error?.name)?error.name:'Error',raw=error?.code,code=codes.has(raw)?raw:Number.isSafeInteger(raw)?String(raw):typeof raw==='string'?'other:'+sha(raw).slice(0,12):'',locations=[]
 for(const match of (typeof error?.stack==='string'?error.stack:'').matchAll(/\/native\/(tieba(?:-media|-curl|-app-media)?|outbox|run-scope)\.mjs:(\d{1,8}):(\d{1,8})/g)){const location=match[1]+'.mjs:'+match[2]+':'+match[3];if(!locations.includes(location))locations.push(location);if(locations.length===3)break}
 return{name,code,locations}
}
const attributionAliases={source_id:'row.post_id ?? row.sub_reply_id',current_speaker_uid:'row.author_uid',author_name:'row.name',first_person_owner_uid:'row.author_uid'}
/** Compact only the model-facing read. With same_as_row=true, omitted
 * attribution fields use these aliases. Native records stay complete. */
export function projectNativeTiebaReadResult(value){
  if(!isPlainObject(value)||Object.hasOwn(value,'attribution_aliases'))return value
  if(value.source_context?.platform!=='tieba'&&value.thread?.source_context?.platform!=='tieba'&&!(Array.isArray(value.items)&&value.items.some(item=>item?.source_context?.platform==='tieba')))return value
  const used=new Set()
  const rowProjection=row=>{
    if(!isPlainObject(row)||!isPlainObject(row.attribution)||Object.hasOwn(row.attribution,'same_as_row')||Object.keys(attributionAliases).some(key=>!Object.hasOwn(row.attribution,key)))return row
    const attribution={...row.attribution},aliases={source_id:row.post_id??row.sub_reply_id,current_speaker_uid:row.author_uid,author_name:row.name,first_person_owner_uid:row.author_uid}
    let changed=false
    for(const [key,original]of Object.entries(aliases))if(typeof original==='string'&&original&&Object.hasOwn(attribution,key)&&attribution[key]===original){delete attribution[key];used.add(key);changed=true}
    return changed?{...row,attribution:{...attribution,same_as_row:true}}:row
  }
  const sectionProjection=section=>{
    if(!isPlainObject(section))return section
    const projected={...section}
    if(Array.isArray(section.posts))projected.posts=section.posts.map(rowProjection)
    if(Array.isArray(section.items))projected.items=section.items.map(item=>isPlainObject(item)&&Array.isArray(item.posts)?sectionProjection(item):rowProjection(item))
    for(const key of ['thread','sub_replies'])if(isPlainObject(section[key]))projected[key]=sectionProjection(section[key])
    return projected
  }
  const projected=sectionProjection(value)
  if(!used.size)return value
  projected.attribution_aliases=Object.fromEntries([...used].map(key=>[key,attributionAliases[key]]))
  return JSON.stringify(projected).length<JSON.stringify(value).length?projected:value
}
const withPostMentions=(rows,bytes)=>{
  const mentions=new Map()
  for(const top of pbFields(bytes))if(top.field===2&&top.bytes)for(const post of pbFields(top.bytes))if(post.field===6&&post.bytes){const fields=pbFields(post.bytes),id=fields.find(x=>x.field===1)?.value?.toString(),uids=[];for(const field of fields)if(field.field===5&&field.bytes){const content=pbFields(field.bytes);if(content.find(x=>x.field===1)?.value===4n){const target=content.find(x=>x.field===15)?.value;if(target&&target>0n)uids.push(target.toString())}}if(id&&uids.length)mentions.set(id,uids)}
  return rows.map(row=>mentions.has(row.post_id)?{...row,mention_uids:mentions.get(row.post_id)}:row)
}

const text=(value,max=64000)=>{if(typeof value!=='string'||!value.isWellFormed()||value.includes('\0')||value.length>max)throw new TiebaError('文字参数无效','invalid_input');return value}
const barName=value=>{const name=text(value,160).trim();if(!name)throw new TiebaError('吧名不能为空','invalid_target');return name}
const positive=(value,max=1000)=>{if(!Number.isSafeInteger(value)||value<1||value>max)throw new TiebaError('页码或数量无效','invalid_input');return value}
const fields=(value,allowed)=>{if(!isPlainObject(value)||Object.keys(value).some(key=>!allowed.includes(key)))throw new TiebaError('贴吧账号参数包含不支持的字段','invalid_input')}
const sourceParts=rows=>rows.filter(row=>row.content_parts?.length).map(row=>({source_id:row.post_id??row.sub_reply_id,content_parts:row.content_parts}))
const briefRow=row=>{const {text:body,content_parts,...rest}=row;return {...rest,total_chars:body.length,...(content_parts?.length?{content_parts:content_parts.slice(0,4).map(part=>Object.fromEntries(['index','type','kind','start','end','display_text','uid'].filter(key=>part[key]!==undefined).map(key=>[key,part[key]]))),total_content_parts:content_parts.length,content_parts_truncated:content_parts.length>4}:{})}}
const result=(outcome,detail,proof)=>({outcome,detail,...(proof?{proof}:{})})
const paged=(value,{offset=0,max_chars=1800}={})=>{if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(max_chars)||max_chars<1||max_chars>4000)throw new TiebaError('分页范围无效','invalid_input');return {text:value.slice(offset,offset+max_chars),offset,total_chars:value.length,next_offset:offset+max_chars<value.length?offset+max_chars:null}}
function cookiesOf(data,host,now){
  if(!isPlainObject(data))throw new TiebaError('贴吧私密凭据尚未就绪','authentication_required')
  const values=new Map()
  if(data.cookie_header!==undefined){if(typeof data.cookie_header!=='string'||/[\0\r\n]/.test(data.cookie_header)||data.cookie_header.length>262144)throw new TiebaError('贴吧私密凭据格式无效','authentication_required');for(const part of data.cookie_header.split(';')){const at=part.indexOf('=');if(at>0)values.set(part.slice(0,at).trim(),part.slice(at+1).trim())}}
  for(const row of Array.isArray(data.cookies)?data.cookies:[]){const domain=String(row.domain??'').replace(/^\./,'');if(host!==domain&&!(row.include_subdomains===true&&host.endsWith('.'+domain))||row.expires_at!==null&&row.expires_at!==undefined&&row.expires_at<=now)continue;if(typeof row.name!=='string'||typeof row.value!=='string'||/[\0\r\n;]/.test(row.name+row.value))throw new TiebaError('贴吧私密凭据格式无效','authentication_required');values.set(row.name,row.value)}
  const bduss=values.get('BDUSS')??'';return {header:[...values].map(([name,value])=>name+'='+value).join('; '),bduss,secrets:[...values.values()]}
}

export class NativeTieba{
  constructor({store,credentials,assets,memory_runtime,activity,participation,fetcher=createTiebaCurlFetcher(),image_fetcher=fetch,now=Date.now,im_factory}={}){
    if(!(store instanceof NativeStore)||typeof credentials!=='function'||typeof fetcher!=='function'||typeof image_fetcher!=='function'||typeof now!=='function')throw new Error('贴吧服务必须明确使用NativeStore、凭据回调与HTTP实现')
    this.store=store;this.credentials=credentials;this.assets=assets;this.memoryRuntime=memory_runtime;this.memory=memory_runtime?null:new NativeMemory(store,{now});this.activity=activity;this.participation=participation;this.fetcher=fetcher;this.imageFetcher=image_fetcher;this.now=now;this.queue=Promise.resolve();this.inflight=new Set();this.auth=null;this.closed=false;this.rounds=new NativeRoundPolicy({store,platform:'tieba',now,settings:()=>this._settings().config});this.inbox=new NativeTiebaInbox(this,{im_factory});this.replies=new NativeTiebaReplies(this);this.mentions=new NativeTiebaMentions(this);this.atmosphere=new NativeTiebaAtmosphere({store,now});this.readContexts=new Map();this.vision=new NativeTiebaVision(this)
  }
  _now(){const value=this.now();if(!Number.isSafeInteger(value)||value<0)throw new Error('贴吧时钟无效');return value}
  _rememberForum(thread_id,bar){
    this._assertRun()
    if(!bar)return '';try{canonicalBar(bar);bar=bar.trim()}catch{return ''}
    const previous=this._knownForum(thread_id);if(previous&&canonicalBar(previous)!==canonicalBar(bar))return ''
    this.store.db.prepare('INSERT INTO cache_entries(key,kind,schema_id,schema_version,value_json,created_at,expires_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,created_at=excluded.created_at,expires_at=excluded.expires_at').run('tieba.forum:'+thread_id,'tieba.thread_forum','companion.tieba.thread_forum',1,JSON.stringify({bar,thread_id}),this._now(),this._now()+86400000)
    return bar
  }
  _knownForum(thread_id){this._assertRun();const row=this.store.db.prepare("SELECT schema_id,schema_version,value_json FROM cache_entries WHERE key=? AND kind='tieba.thread_forum' AND expires_at>?").get('tieba.forum:'+thread_id,this._now());if(row?.schema_id!=='companion.tieba.thread_forum'||row.schema_version!==1)return '';try{const value=JSON.parse(row.value_json);if(value.thread_id!==thread_id)return '';canonicalBar(value.bar);return value.bar}catch{return ''}}
  _rememberListedForums(data,listed){
    this._assertRun()
    const value=data.data??data,forum=value.forum??{},wanted=new Set(listed.threads.map(row=>row.thread_id)),rawNames=[forum.name,forum.forum_name].filter(value=>value!==undefined&&value!==null&&value!=='');let bar,names
    try{bar=canonicalBar(listed.bar);names=rawNames.map(canonicalBar);if(names.some(name=>name!==bar)||[forum.id,forum.fid].some(id=>id!==undefined&&id!==null&&tiebaId(id)!==listed.forum_id))return}catch{return}
    for(const row of value.page_data?.feed_list??[]){
      this._assertRun();const item=row.feed?.business_info_map;if(!item)continue
      try{
        const thread_id=tiebaId(item.thread_id);if(!wanted.has(thread_id))continue
        const ownName=typeof item.forum_name==='string'&&item.forum_name.trim()?canonicalBar(item.forum_name):'',hasId=item.forum_id!==undefined&&item.forum_id!==null&&item.forum_id!==''
        if(ownName&&ownName!==bar||hasId&&tiebaId(item.forum_id)!==listed.forum_id||!ownName&&(!names.length||!hasId))continue
        // Both the thread ID and forum identity are server-returned. The
        // requested bar alone never establishes an arbitrary thread's forum.
        this._rememberForum(thread_id,ownName?item.forum_name:rawNames[0])
      }catch{this._assertRun()}
    }
  }
  _observeAtmosphere({bar,thread_id,title='',evidence_ids=[],session_id='',query='',reply_actor_uids=[],reply_actor_texts={}}){
    const scope=currentRunScope();this._assertRun(scope)
    if(!bar){if(session_id)this.readContexts.delete(session_id);return}
    if(session_id){this.readContexts.set(session_id,{bar,thread_id,query:query.replace(/\0/g,' ').slice(0,2400),reply_actor_uids:[...new Set(reply_actor_uids.filter(uid=>typeof uid==='string'&&/^[1-9]\d*$/.test(uid)))].slice(0,2),reply_actor_texts:Object.fromEntries(reply_actor_uids.slice(0,2).map(uid=>[uid,String(reply_actor_texts[uid]??'').slice(0,800)]))});while(this.readContexts.size>256)this.readContexts.delete(this.readContexts.keys().next().value)}
    if(evidence_ids.length)try{this._assertRun(scope);this.atmosphere.observe({bar,thread_id,title:title.slice(0,180),evidence_ids},{producer:'native_tieba_reader',self_uid:accountSourceUid(this.store,'tieba',this._settings().value.account_entity_id)})}catch{this._assertRun(scope);/* Reading succeeds independently of the optional empirical index. */}
    this._assertRun(scope)
  }
  styleContext({agent,context={},platform}={},task){
    if(this.closed||platform!=='tieba'||context.memory_only||task?.maintenance_kind||context.conversation_id?.startsWith('dm:'))return ''
    const sid=context.session_id??agent?.session?.header?.id??agent?.session?.id??'',recent=this.readContexts.get(sid),incoming=task?.batch?.kind==='activity.incoming'?task.batch.tasks:[],bars=[...new Map(incoming.map(row=>{try{return [canonicalBar(row.target.bar),row.target.bar]}catch{return ['',null]}}).filter(([key])=>key)).values()]
    if(incoming.length&&bars.length!==1)return ''
    const bar=bars[0]??recent?.bar;if(!bar)return ''
    const same=recent&&canonicalBar(recent.bar)===canonicalBar(bar)?recent:null,actors=[...new Set(incoming.map(row=>row.target.actor_uid).filter(Boolean))],manualActors=!task?.batch?same?.reply_actor_uids??[]:[],actor=actors.length===1?actors[0]:!incoming.length&&manualActors.length===1?manualActors[0]:'',retaliation=actor&&(incoming.length?incoming.filter(row=>row.target.actor_uid===actor).some(row=>directPersonalInsult(row.body)):directPersonalInsult(same?.reply_actor_texts?.[actor])),cadence=retaliation?tiebaConversationSevenState({store:this.store,actor_uid:actor,now:this._now()}).context:'',thread_id=incoming[0]?.target.thread_id??same?.thread_id??'',query=(incoming.length?incoming.map(row=>semanticMessageText(row.body??'',{platform:'tieba',conversation_id:row.target.conversation_id})).join(' '):same?.query??'').replace(/[\0\r\n]/g,' ').slice(0,4000),atmosphere=incoming.length&&!query.trim()?'':this.atmosphere.styleContext({bar,thread_id,query,max_chars:cadence?160:300}),line=[atmosphere,cadence].filter(Boolean).join('\n')
    if(!line)return ''
    const starts=this.store.db.prepare("SELECT CAST(body AS BLOB) bytes FROM actions WHERE platform='tieba' AND kind='tieba.reply' AND status='confirmed' AND json_extract(target_json,'$.bar') IN (?,?) ORDER BY confirmed_at DESC LIMIT 5").all(bar,canonicalBar(bar)).map(row=>Buffer.from(row.bytes).toString('utf8').replace(/\s+/g,' ').slice(0,5)),unique=[...new Set(starts)].slice(0,3),tail=unique.length?'【本吧已发开头·统计】'+JSON.stringify(unique)+'（历史原文）':''
    return line+(tail&&line.length+tail.length+1<=360?'\n'+tail:'')
  }
  _assertRun(scope){assertRunActive((arguments.length?scope:currentRunScope())??null)}
  _settings(){const id=this.store.getDocument('settings')?.value.platform_document_ids?.tieba??'tieba',doc=this.store.getDocument(id);if(doc&&(doc.type!=='platform_settings'||doc.value.platform!=='tieba'))throw new Error('贴吧原生设置类型错误');return {id,revision:doc?.revision??0,value:doc?.value??{platform:'tieba',enabled:false},config:doc?.value.tieba??{}}}
  _state(){const doc=this.store.getDocument('platform-state-tieba');if(doc&&doc.type!=='platform_state')throw new Error('贴吧原生状态类型错误');return {revision:doc?.revision??0,value:doc?.value??{platform:'tieba'}}}
  _saveState(patch){this._assertRun();return this.store.transaction(()=>{const current=this._state();return this.store.putDocument({id:'platform-state-tieba',type:'platform_state',expected_revision:current.revision,value:{...current.value,...patch}})})}
  _enabled(diagnostic=false,owner_login=false){this._assertRun();if(this.closed)throw new TiebaError('贴吧服务已关闭','closed');if(!owner_login&&this._settings().value.enabled!==true)throw new TiebaError('贴吧当前关闭','disabled');const state=this._state().value;if(!diagnostic&&state.verification_required)throw new TiebaError('贴吧需要主人核对官方登录或验证状态','verification_required');if(!diagnostic&&state.paused_until>this._now())throw new TiebaError('贴吧请求暂停中','risk_pause')}
  async _credential(required=true,host='tieba.baidu.com'){
    const scope=currentRunScope();this._assertRun(scope);const ref=this._settings().value.credential_ref
    if(!ref){if(required)throw new TiebaError('请先绑定贴吧登录态','authentication_required');return {header:'',bduss:'',secrets:[]}}
    let data;try{data=await abortableRun(this.credentials(ref),scope)}catch{this._assertRun(scope);throw new TiebaError('贴吧私密凭据无法读取','authentication_required')}
    this._assertRun(scope);const value=cookiesOf(data,host,this._now());if(required&&!value.bduss)throw new TiebaError('贴吧登录态未包含BDUSS','authentication_required');return {...value,secret_ref:ref}
  }
  _journal(subtype,metadata={},options={}){this._assertRun();const key='tieba:'+subtype+':'+(options.event_key??sha(stringifyJson([metadata,this._now()])));return this.store.appendJournalEvent({id:'journal-'+sha(key),event_key:key,event_type:options.event_type??'log',platform:'tieba',direction:options.direction??'state',status:options.status??'recorded',visibility:options.visibility??'owner',text:options.text??'',ref:options.ref??'',source_at:this._now(),source_type:'native_tieba',recorded_at:this._now(),metadata:{subtype,...metadata}})}
  _pause(reason,{captcha=false,code=null}={}){const until=this._now()+Math.max(60000,this._settings().config.requests?.breaker_ms??30*60000);this._saveState({paused_until:until,verification_required:this._state().value.verification_required===true||captcha||code===5,verification_reason:reason});return until}
  async _http(input,{method='GET',body,cred,content_type,write=false,onWrite,diagnostic=false,owner_login=false,official_page_check=false,max_bytes=8*1024*1024,protobuf=false,referer}={}){
    const scope=currentRunScope();this._assertRun(scope)
    const url=trustedTiebaUrl(input),pageCheck=official_page_check&&owner_login&&diagnostic&&!write&&url.hostname==='tieba.baidu.com'&&(method==='GET'&&url.pathname==='/f'||method==='POST'&&url.pathname==='/c/f/frs/page_pc');if(owner_login&&!diagnostic||diagnostic&&!(method==='GET'&&url.hostname==='tieba.baidu.com'&&['/dc/common/tbs','/mo/q/newmoindex'].includes(url.pathname)||pageCheck))throw new TiebaError('诊断只能读取官方登录、TBS和主人明确检查的官网吧页面','invalid_input')
    const previous=this.queue;let release,entered=false;this.queue=new Promise(resolve=>{release=resolve})
    try{
      await abortableRun(previous,scope);entered=true;this._assertRun(scope)
      this._enabled(diagnostic,owner_login);const state=this._state().value,gap=Math.max(0,Math.min(5000,this._settings().config.requests?.gap_ms??1200)),wait=gap-(this._now()-Math.max(state.last_read_at??0,state.last_write_at??0));if(wait>0){let timer;try{await abortableRun(new Promise(resolve=>{timer=setTimeout(resolve,wait)}),scope)}finally{clearTimeout(timer)}}this._assertRun(scope);this._enabled(diagnostic,owner_login)
      let networkStarted=false,gateFailure
      const beginWrite=async()=>withRunScope(scope??{},async()=>{try{this._assertRun(scope);await onWrite();networkStarted=true;this._assertRun(scope);this._saveState({last_write_at:this._now()})}catch(error){gateFailure=error;throw error}})
      if(write){if(typeof onWrite!=='function')throw new TiebaError('网络写入缺少原生租约回调','invalid_action_lease');if(this.fetcher.controlled_network_start!==true)await beginWrite()}
      else this.store.transaction(()=>{const day=shanghaiTime(this._now()).date,id='quota:tieba:read:'+day,current=this.store.getDocument(id);this.store.putDocument({id,type:'quota',expected_revision:current?.revision??0,value:{platform:'tieba',category:'read',metric:'reads',day,used:(current?.value.used??0)+1,last_action_at:this._now()}});this._saveState({last_read_at:this._now()})})
      const app=url.hostname==='tiebac.baidu.com',identityRead=!app&&(url.pathname==='/im/pcmsg'||url.pathname.startsWith('/im/pcmsg/')||method==='GET'&&['/dc/common/tbs','/mo/q/newmoindex','/f'].includes(url.pathname)||method==='GET'&&/^\/p\/[1-9]\d*$/.test(url.pathname)||method==='POST'&&['/c/f/frs/page_pc','/c/s/uploadPicture_pc'].includes(url.pathname));let response
      // Fixed identity and PC routes use the transport identity. The mobile
      // page identity redirects official JSON routes to HTTP; HTTPS redirects
      // still fail without following, and no alternate account is attempted.
      const timeout=AbortSignal.timeout(Number.isSafeInteger(scope?.deadline_at)?Math.max(1,Math.min(30000,scope.deadline_at-scope.now())):30000),signal=scope?.signal?AbortSignal.any([timeout,scope.signal]):timeout
      this._assertRun(scope)
      try{response=await abortableRun(this.fetcher(url.href,{method,headers:{...(identityRead?{}:{'user-agent':app?protobuf?'aiotieba/4.8.1':'bdtb for Android 12.60.1.0':TIEBA_UA}),'accept-language':'zh-CN,zh;q=0.9',...(!app||referer?{referer:referer?trustedTiebaUrl(referer).href:TIEBA_HOST+'/'}:{}),...(!app&&cred?.header?{cookie:cred.header}:{}),...(protobuf?{x_bd_data_type:'protobuf'}:{}),...(content_type?{'content-type':content_type}:{}),...(method==='POST'&&!app?{origin:TIEBA_HOST}:{}),...(!app&&method==='POST'&&['/mo/q/apubpost','/mo/q/cooluploadpic'].includes(url.pathname)?{'x-requested-with':'XMLHttpRequest'}:{})},...(body===undefined?{}:{body}),redirect:'error',signal,...(write&&this.fetcher.controlled_network_start===true?{mark_network_started:beginWrite}:{})}),scope)}catch(error){throw gateFailure??error}
      this._assertRun(scope)
      if(write&&!networkStarted)throw new TiebaError('传输尚未确认实际网络开始，未确认发表','invalid_action_lease')
      const chunks=[];let size=0
      if(response.body?.getReader){const reader=response.body.getReader();try{for(;;){this._assertRun(scope);const {done,value}=await abortableRun(reader.read(),scope);this._assertRun(scope);if(done)break;size+=value.length;if(size>max_bytes)throw new TiebaError('贴吧响应超过容量限制','invalid_response');chunks.push(Buffer.from(value))}}finally{await abortableRun(reader.cancel().catch(()=>{}),scope)}}
      else{const bytes=Buffer.from(await abortableRun(response.arrayBuffer(),scope));this._assertRun(scope);if(bytes.length>max_bytes)throw new TiebaError('贴吧响应超过容量限制','invalid_response');chunks.push(bytes)}
      const bytes=Buffer.concat(chunks),charset=String(response.headers?.get?.('content-type')??''),encoding=/charset\s*=\s*(?:gbk|gb2312|gb18030)/i.test(charset)?'gb18030':'utf-8';let decoded=''
      try{decoded=new TextDecoder(encoding,{fatal:true}).decode(bytes)}catch{}
      this._assertRun(scope);this._saveState({[write?'last_write_at':'last_read_at']:this._now()})
      if([403,412,429].includes(response.status)){this._pause('贴吧接口限制了当前请求，请等待或由主人核对官方页面',{code:response.status,captcha:/<title[^>]*>[^<]*(?:百度安全验证|安全验证|验证码)/i.test(decoded)});if(pageCheck)return{response,bytes,text:decoded,restricted:true};throw new TiebaError('贴吧接口限制了当前请求','risk_pause',{http_status:response.status})}
      if(/^\s*(?:<!doctype|<html)/i.test(decoded)&&/<title[^>]*>[^<]*(?:百度安全验证|安全验证|验证码)/i.test(decoded)){this._pause('官方页面返回安全验证，需要主人正常处理',{captcha:true});throw new TiebaError('官方页面返回安全验证，未继续请求','verification_required')}
      if(!write&&!diagnostic&&decoded.trim().startsWith('{')){const receipt=parseAddReceipt(bytes);if(receipt.code===5||receipt.captcha_present){this._pause(receipt.captcha_present?'官方读取响应包含验证字段，需正常处理':'官方读取返回5，需核对登录/TBS而非切换通道重试',{captcha:receipt.captcha_present,code:receipt.code});throw new TiebaError(receipt.captcha_present?'官方读取要求正常验证，已暂停':'官方读取返回5，已暂停核对登录/TBS','verification_required')}}
      return {bytes,text:decoded,response,request_id:randomUUID()}
    }finally{if(entered)release();else previous.then(release,release)}
  }
  async _tbs(cred,{diagnostic=false,refresh=false,owner_login=false}={}){
    const run=currentRunScope();this._assertRun(run);const scope=sha(cred.header);if(!refresh&&this.auth?.scope===scope&&this._now()-this.auth.at<600000)return this.auth
    const reply=await this._http(TIEBA_HOST+'/dc/common/tbs',{cred,diagnostic,owner_login,max_bytes:262144});let data;try{if(!reply.response.ok)throw Error();data=exactTiebaJson(reply.text)}catch{this.auth=null;throw new TiebaError('官方TBS响应无法核验','invalid_response')}
    if(String(data.is_login)!=='1'||typeof data.tbs!=='string'||!data.tbs||/[\0\r\n]/.test(data.tbs)){this.auth=null;throw new TiebaError('官方未认可当前请求的登录态；需检查登录或传输环境','authentication_required')}
    this._assertRun(run);this.auth={scope,at:this._now(),tbs:data.tbs};return this.auth
  }
  async _self(cred,{diagnostic=false,owner_login=false}={}){const run=currentRunScope();this._assertRun(run);const reply=await this._http(TIEBA_HOST+'/mo/q/newmoindex?need_user=1',{cred,diagnostic,owner_login,max_bytes:262144});let data;try{if(!reply.response.ok)throw Error();data=exactTiebaJson(reply.text).data??{}}catch{throw new TiebaError('官方账号信息无法核验','invalid_response')}const scrub=value=>{let out=text(String(value??''),200);for(const token of [...cred.secrets,this.auth?.tbs??''])if(token.length>=4)out=out.split(token).join('[已隐藏]');return redactText(out)},account={uid:tiebaId(data.id??data.uid),name:scrub(data.name),name_show:scrub(data.name_show??data.name)};this._assertRun(run);this.selfCache={scope:sha(cred.header),secret_ref:cred.secret_ref,account,at:this._now()};return account}
  async login(input={},trusted_context={}){
    fields(input,['operation','cookie_header'])
    if(trusted_context.owner_authorized!==true||trusted_context.local_settings!==true||trusted_context.platform!=='harness'||trusted_context.conversation_id!=='local-settings')throw new TiebaError('请由主人在本机账号设置中导入贴吧Cookie','owner_required')
    this.store._write();if(this.closed)throw new TiebaError('贴吧服务已关闭','closed')
    if(input.operation==='start')return {platform:'tieba',status:'manual_required',method:'import_cookie',qr_url:null,message:'贴吧使用本机专用Cookie导入；提交后只读取官方TBS和账号信息进行核验。'}
    if(input.operation!=='import_cookie')throw new TiebaError('贴吧仅支持本机明确导入Cookie，不提供扫码轮询','invalid_input')
    if(this.loginFlight)throw new TiebaError('贴吧账号正在核验，请等待本次结果','login_busy')
    if(typeof this.credentials.save!=='function')throw new TiebaError('原生私密凭据保存入口尚未接入','not_ready')
    const raw=input.cookie_header
    if(typeof raw!=='string'||!raw.trim()||raw.length>65536||!/^[\x20-\x7e]+$/.test(raw))throw new TiebaError('请提交不超过65536字节的单行Cookie请求头','invalid_input')
    const pairs=new Map()
    for(const part of raw.split(';').map(value=>value.trim()).filter(Boolean)){const at=part.indexOf('='),name=part.slice(0,at).trim(),value=part.slice(at+1).trim();if(at<1||! /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)||pairs.has(name))throw new TiebaError('Cookie名称或重复项无效，请复制浏览器的Cookie请求头','invalid_input');pairs.set(name,value)}
    if(!pairs.get('BDUSS'))throw new TiebaError('Cookie请求头需包含非空BDUSS；未进行账号绑定','invalid_input')
    const data={cookie_header:[...pairs].map(([name,value])=>name+'='+value).join('; ')},cred=cookiesOf(data,'tieba.baidu.com',this._now()),settings=this._settings(),priorAuth=this.auth,priorSelf=this.selfCache
    const work=(async()=>{
      try{
        await this._tbs(cred,{diagnostic:true,refresh:true,owner_login:true});const account=await this._self(cred,{diagnostic:true,owner_login:true}),existing=this.store.getPlatformIdentity('tieba',account.uid)
        if(existing&&(existing.role!=='account'||this.store.getEntity(existing.entity_id)?.kind!=='account'))throw new TiebaError('该UID已有其他明确身份，未自动合并或覆盖，请主人核对','identity_conflict')
        if(this.closed||this._settings().revision!==settings.revision)throw new TiebaError('账号设置已变化，旧绑定未替换，请重新提交核验','binding_changed')
        const entity_id=existing?.entity_id??'account-tieba-'+sha(account.uid).slice(0,32),secret_ref='credential:tieba:'+randomUUID()
        // A fresh ref leaves every previous secret intact; only the following
        // SQL transaction can make the newly verified credential active.
        await this.credentials.save(secret_ref,data)
        this.store.transaction(()=>{
          if(this.closed||this._settings().revision!==settings.revision)throw new TiebaError('账号设置已变化，旧绑定未替换，请重新提交核验','binding_changed')
          const current=this.store.getPlatformIdentity('tieba',account.uid)
          if(current&&(current.role!=='account'||current.entity_id!==entity_id))throw new TiebaError('账号身份绑定发生变化，原绑定保留','identity_conflict')
          if(!current)this.store.createEntity({id:entity_id,kind:'account',display_name:account.name_show||account.name})
          else this.store.updateEntity(entity_id,{display_name:account.name_show||account.name})
          this.store.upsertPlatformIdentity({namespace:'tieba',platform_uid:account.uid,entity_id,role:'account',display_name:account.name_show||account.name})
          this.store.putDocument({id:settings.id,type:'platform_settings',expected_revision:settings.revision,value:{...settings.value,credential_ref:secret_ref,account_entity_id:entity_id}})
          this._journal('account_bound',{account_entity_id:entity_id,platform_uid:account.uid,official_tbs_verified:true,official_self_verified:true,verification_state_unchanged:true,publication_attempted:false},{event_key:'account-bind:'+randomUUID()})
        })
        this.selfCache={...this.selfCache,secret_ref};const state=this._state().value
        return {platform:'tieba',status:'confirmed',authenticated:true,account:{uid:account.uid,name:account.name_show||account.name},verification_required:state.verification_required===true,paused_until:state.paused_until??null,automatic_resume:false,publications:0}
      }catch(error){this.auth=priorAuth;this.selfCache=priorSelf;throw error instanceof TiebaError?error:new TiebaError('贴吧账号核验或保存未完成，原账号绑定保持不变','login_failed')}
    })();this.loginFlight=work;try{return await work}finally{this.loginFlight=null}
  }
  async diagnostics({refresh=true}={}){
    const settings=this._settings(),state=this._state().value;let authenticated=false,tbs_available=false,account=null,reason=state.verification_reason??''
    if(!refresh)try{const cred=await this._credential(false);if(this.auth?.scope===sha(cred.header)&&this.selfCache?.scope===this.auth.scope&&this._now()-this.auth.at<600000){account=clone(this.selfCache.account);authenticated=true;tbs_available=true}}catch{reason='私密资源当前不可读取'}
    if(settings.value.enabled&&refresh)try{const cred=await this._credential();await this._tbs(cred,{diagnostic:true,refresh:true});tbs_available=true;account=await this._self(cred,{diagnostic:true});authenticated=true}catch(error){reason=error instanceof TiebaError?error.message:'登录诊断未完成'}
    return {platform:'tieba',enabled:settings.value.enabled===true,credential_configured:!!settings.value.credential_ref,authenticated,tbs_available,account,verification_required:state.verification_required===true,paused_until:state.paused_until??null,status:state.verification_required?'verification_required':state.paused_until>this._now()?'paused':authenticated?'ready':'signed_out',reason,transport:this.fetcher.controlled_network_start===true?'native_curl':'injected_fetch',comment_inbox:this.replyInboxHealth??this.replies.health,mention_inbox:this.mentions.health,model_calls:0,automatic_retry:false}
  }
  directContacts(input={},context={}){return this.inbox.contacts(input,context)}
  directMessages(input={},context={}){return this.inbox.history(input,context)}
  replyPendingMessages(input={},context={}){return this.inbox.poll({manual:true,limit:20},context)}
  pollInbox(){return this.inbox.poll()}
  async pollReplies(input={}){if(this.replyInboxFlight)return this.replyInboxFlight;const work=(async()=>{const results=await Promise.allSettled([this.replies.poll(input),this.mentions.poll(input)]);if(results.every(row=>row.status==='rejected'))throw results[0].reason;const channels=results.map(row=>row.status==='fulfilled'?row.value:{polled:false,queued:0,unresolved:1,reason:row.reason?.code??'check_failed'}),[replies,mentions]=channels,result={...replies,polled:channels.some(row=>row.polled),queued:channels.reduce((sum,row)=>sum+(row.queued??0),0),unresolved:channels.reduce((sum,row)=>sum+(row.unresolved??0),0),mentions};this.replyInboxHealth={...result,checked_at:this._now()};return result})();this.replyInboxFlight=work;try{return await work}finally{this.replyInboxFlight=null}}
  whoami(options={}){return this.diagnostics(options)}
  status({refresh=false}={}){return this.diagnostics({refresh})}
  async resume({official_check_completed=false}={},trusted_context={}){
    if(trusted_context.owner_authorized!==true||official_check_completed!==true)throw new TiebaError('只有主人确认官方处理完成后才能恢复新请求','owner_required')
    this.store._write()
    if(this.activity&&(this.activity.store!==this.store||typeof this.activity.clearPlatformBlock!=='function'))throw new TiebaError('同库活动恢复入口尚未就绪，未解除限制','not_ready')
    const settings=this._settings();let account
    if(trusted_context.local_settings===true){try{const cred=await this._credential();await this._tbs(cred,{diagnostic:true,refresh:true,owner_login:true});account=await this._self(cred,{diagnostic:true,owner_login:true})}catch(error){throw error instanceof TiebaError?error:new TiebaError('官方登录检查未完成，当前限制保持不变','authentication_required')}}
    else{const check=await this.diagnostics();if(!check.authenticated||!check.tbs_available)throw new TiebaError('官方登录/TBS尚未核验，未恢复','authentication_required');account=check.account}
    const expected=settings.value.account_entity_id?this.store.listPlatformIdentities({namespace:'tieba',entity_id:settings.value.account_entity_id,role:'account'}):[]
    if(expected.length&&!expected.some(row=>row.platform_uid===account.uid))throw new TiebaError('官方账号与已绑定账号不符，请先由主人重新绑定','account_changed')
    const page=await this.inspectOfficialPage({...trusted_context,owner_authorized:true,local_settings:true})
    if(!page.readable)throw new TiebaError('账号登录有效，但官方吧页面仍未读通；没有解除验证或退避，请先正常处理官方页面','verification_required')
    if(this._settings().revision!==settings.revision)throw new TiebaError('账号设置已变化，请重新检查官方状态','binding_changed')
    this.store.transaction(()=>{this._saveState({verification_required:false,paused_until:null,verification_reason:''});this.activity?.clearPlatformBlock('tieba');this._journal('manual_request_resume',{official_check_confirmed_by_owner:true,activity_unblocked:!!this.activity,old_actions_replayed:false},{event_key:'manual-resume:'+randomUUID()})})
    return {resumed:true,activity_unblocked:!!this.activity,old_actions_replayed:false}
  }
  async _source({body,ref,kind='read',session_id='',source_id='',protocol_metadata}){
    const scope=currentRunScope();this._assertRun(scope);text(body,2*1024*1024);let asset_id=null;const evidence_ids=[]
    const meta=protocol_metadata?.length?JSON.stringify(protocol_metadata):''
    if(this.assets?.put){asset_id=(await abortableRun(this.assets.put({bytes:Buffer.from(body),kind:'source',media_type:'text/plain',source_ref:ref,visibility:'public',manifest:{schema_version:1,platform:'tieba',source_kind:kind,trust:'untrusted_source',...(meta?meta.length<=120000?{protocol_metadata}:{protocol_metadata_sha256:sha(meta),protocol_metadata_truncated:true}:{})}}),scope)).id;this._assertRun(scope)}
    if(this.store.getDocument('settings')?.value.memory?.enabled!==false)for(let offset=0;offset<body.length;){
      this._assertRun(scope);let end=Math.min(body.length,offset+60000);if(end<body.length&&/[\uD800-\uDBFF]/.test(body[end-1])&&/[\uDC00-\uDFFF]/.test(body[end]))end--
      const input={platform:'tieba',session_id,kind,text:body.slice(offset,end),ref,source_message_id:'tieba-read:'+sha(source_id+'\0'+ref+'\0'+body)+':'+offset,source_at:this._now(),visibility:'public'};let saved
      if(this.memoryRuntime)saved=await abortableRun(this.memoryRuntime.ingestSourceRead(input),scope)
      else{const {session_id:unused,...record}=input;saved=this.memory.recordEvidence({...record,direction:'observation',actor_uid:'',source_type:'platform',source:{kind:'platform_read',explicit:true}})}
      this._assertRun(scope);if(saved?.id)evidence_ids.push(saved.id);offset=end
    }
    this._assertRun(scope);return {asset_id,evidence_ids,untrusted:true}
  }
  seen(thread_id){thread_id=tiebaId(thread_id);const since=this._now()-(this._settings().config.requests?.dedupe_days??7)*86400000;return !!this.store.db.prepare("SELECT id FROM journal_events WHERE platform='tieba' AND event_type='platform_read' AND json_extract(metadata_json,'$.thread_id')=? AND source_at>=? LIMIT 1").get(thread_id,Math.max(0,since))}
  async inspectOfficialPage(trusted_context={}){
    if(trusted_context.owner_authorized!==true||trusted_context.local_settings!==true)throw new TiebaError('官网页面检查只能由主人在本机设置明确执行','owner_required')
    const bar=barName(this._settings().config.bars?.[0]??''),cred=await this._credential(false),reply=await this._http(TIEBA_HOST+'/f?'+new URLSearchParams({kw:bar,ie:'utf-8',pn:'0'}),{cred,diagnostic:true,owner_login:true,official_page_check:true}),parsed=reply.response.ok?await this._pcBar(bar,1,cred,{diagnostic:true,owner_login:true,official_page_check:true}):{threads:[]}
    let detail=reply.text.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();for(const secret of cred.secrets)if(secret.length>=4)detail=detail.split(secret).join('[已隐藏]')
    return {bar,http_status:reply.response.status,readable:reply.response.ok&&parsed.threads.length>0,thread_count:parsed.threads.length,title:(/<title[^>]*>([^<]*)/i.exec(reply.text)?.[1]??'').slice(0,300),detail:redactText(detail.slice(0,300)),publications:0,automatic_resume:false,model_calls:0}
  }
  async _pcBar(bar,page,cred,diagnostic={}){
    const auth=await this._tbs(cred,diagnostic),params={kw:encodeURIComponent(bar),pn:String(page),sort_type:'-1',is_newfrs:'1',is_newfeed:'1',rn:'30',rn_need:'10',tbs:auth.tbs,subapp_type:'pc',_client_type:'20'},reply=await this._http(TIEBA_HOST+'/c/f/frs/page_pc',{method:'POST',body:new URLSearchParams({...params,sign:pcSignature(params)}),content_type:'application/x-www-form-urlencoded',cred,...diagnostic})
    if(!reply.response.ok)throw new TiebaError('贴吧官网帖子列表读取未完成','read_failed')
    let data;try{data=exactTiebaJson(reply.text)}catch{throw new TiebaError('贴吧官网帖子列表响应无法核验','invalid_response')}
    const receipt=parseAddReceipt(reply.bytes);if(receipt.code===5||receipt.captcha_present){this._pause('官方帖子列表要求验证，需要正常处理',{captcha:true,code:receipt.code});throw new TiebaError('官方帖子列表要求验证，已暂停','verification_required')}
    if(String(data.error_code)!=='0')throw new TiebaError('贴吧官网帖子列表返回错误，未切换入口重试','read_failed',{server_code:/^-?\d+$/.test(String(data.error_code))?String(data.error_code):null,response_keys:Object.keys(data).filter(key=>!/(?:token|tbs|cookie|secret)/i.test(key))})
    const listed=parsePcBar(data,bar);this._rememberListedForums(data,listed);return listed
  }
  async _bar(bar,page=1){bar=barName(bar);positive(page);return this._pcBar(bar,page,await this._credential())}
  async bar({bar,page=1,limit=10}={}){positive(limit,30);const full=await this._bar(bar,page),stored=await this._source({body:renderPublicSource(full.threads.map(row=>({...row,text:row.title})),{platform:'tieba',source_kind:'title_list',self_uid:accountSourceUid(this.store,'tieba',this._settings().value.account_entity_id)}),ref:TIEBA_HOST+'/f?kw='+encodeURIComponent(full.bar),source_id:'bar:'+full.bar+':'+page});return {...full,source_context:publicSourceContext({platform:'tieba',source_kind:'title_list',self_uid:accountSourceUid(this.store,'tieba',this._settings().value.account_entity_id)}),threads:full.threads.slice(0,limit).map(row=>({...row,title:row.title.slice(0,180),seen:this.seen(row.thread_id)})),...stored}}
  _readRound(round_id=''){this._assertRun();const state=this.rounds.state(round_id);return {limit:state.limit,thread_ids:state.ids}}
  _reserveRead(thread_id,round_id=''){this._assertRun();this.rounds.reserve(thread_id,round_id)}
  async browse({bar,page=1,session_id='',round_id=''}={}){
    const scope=currentRunScope();this._assertRun(scope)
    bar=barName(bar??this._settings().config.bars?.[0]??'');positive(page);this.rounds.begin(round_id)
    const before=this._readRound(round_id),remaining=Math.max(0,before.limit-before.thread_ids.length),wanted=Math.min(30,remaining)
    if(!wanted)return {bar,page,items:[],configured_limit:before.limit,opened:before.thread_ids.length,remaining:0,reply_limit:this.rounds.limits(round_id).reply,model_calls:0}
    const list=await this.bar({bar,page,limit:30}),keywords=this._settings().config.keywords??[],candidates=list.threads.filter(row=>!before.thread_ids.includes(row.thread_id)).map((row,index)=>({...row,index,score:(row.seen?0:100)+keywords.filter(word=>word&&row.title.includes(word)).length*10})).sort((a,b)=>b.score-a.score||a.index-b.index).slice(0,wanted),items=[],errors=[]
    for(const candidate of candidates){
      this._assertRun(scope)
      try{const value=await this.thread({thread_id:candidate.thread_id,limit:4,max_chars:1000,session_id,round_id});this._assertRun(scope);items.push({bar:value.bar,thread_id:value.thread_id,title:candidate.title,coordinates_available:value.coordinates_available,source_context:value.source_context,posts:value.posts,text:value.text,total_chars:value.total_chars,evidence_ids:value.evidence_ids??[],source_ref:TIEBA_HOST+'/p/'+value.thread_id,reading_claim:'selected_text_preview'})}
      catch(error){this._assertRun(scope);if(['verification_required','risk_pause','round_read_limit','closed','disabled'].includes(error.code))throw error;errors.push({thread_id:candidate.thread_id,code:error instanceof TiebaError?error.code:'read_failed'})}
    }
    this._assertRun(scope);const after=this._readRound(round_id),opened=round_id?after.thread_ids.length:candidates.length
    return {bar,page,items,errors,configured_limit:before.limit,opened,remaining:Math.max(0,before.limit-opened),reply_limit:this.rounds.limits(round_id).reply,sub_reply_limit:this.rounds.limits(round_id).sub_reply,next_page:list.threads.length===30?page+1:null,model_calls:0}
  }
  async search({query,bar,page=1,limit=10}={}){text(query,240);if(!query.trim())throw new TiebaError('搜索词不能为空','invalid_input');positive(page);positive(limit,30);const params=new URLSearchParams({ie:'utf-8',qw:query,pn:String(page),...(bar?{kw:barName(bar)}:{})}),cred=await this._credential(false),reply=await this._http(TIEBA_HOST+'/f/search/res?'+params,{cred});if(!reply.response.ok)throw new TiebaError('贴吧搜索读取未完成','read_failed');const parsed=parseBarHtml(reply.text),stored=await this._source({body:renderPublicSource(parsed.threads.map(row=>({...row,text:row.title})),{platform:'tieba',source_kind:'search_results',self_uid:accountSourceUid(this.store,'tieba',this._settings().value.account_entity_id)}),ref:TIEBA_HOST+'/f/search/res?'+params,source_id:'search:'+sha(params.toString())});return {query,page,source_context:publicSourceContext({platform:'tieba',source_kind:'search_results',self_uid:accountSourceUid(this.store,'tieba',this._settings().value.account_entity_id)}),items:parsed.threads.slice(0,limit).map(row=>({...row,title:row.title.slice(0,180)})),...stored}}
  async _pb(path,bytes,cred){const form=new FormData();form.append('data',new Blob([bytes],{type:'application/octet-stream'}),'file');const reply=await this._http(TIEBA_APP+path,{method:'POST',body:form,cred,protobuf:true});if(!reply.response.ok)throw new TiebaError('贴吧楼层读取未完成','read_failed');return reply}
  _location(kind,key,fallback=1){const row=this.store.db.prepare('SELECT value_json,expires_at FROM cache_entries WHERE key=? AND kind=?').get('tieba.location.'+kind+':'+key,'tieba.location.'+kind);if(!row||row.expires_at<=this._now())return fallback;try{const page=JSON.parse(row.value_json).page;return Number.isSafeInteger(page)&&page>=1&&page<=1000?page:fallback}catch{return fallback}}
  _rememberLocations(kind,prefix,rows,field,page){this._assertRun();this.store.transaction(()=>{const put=this.store.db.prepare('INSERT INTO cache_entries(key,kind,schema_id,schema_version,value_json,created_at,expires_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,created_at=excluded.created_at,expires_at=excluded.expires_at');for(const row of rows)put.run('tieba.location.'+kind+':'+prefix+':'+row[field],'tieba.location.'+kind,'companion.tieba.location',1,stringifyJson({page,author_uid:row.author_uid??row.author?.uid??''}),this._now(),this._now()+1800000);this.store.db.prepare("DELETE FROM cache_entries WHERE key IN (SELECT key FROM cache_entries WHERE kind IN ('tieba.location.post','tieba.location.sub') ORDER BY created_at DESC,key LIMIT -1 OFFSET 1000)").run()})}
  async _posts(thread_id,{page=1,limit=30,sort=1,cred}={}){thread_id=tiebaId(thread_id);positive(page);positive(limit,100);cred??=await this._credential(false);const reply=await this._pb('/c/f/pb/page?cmd=302001',encodePageRequest({thread_id,page,limit,sort,bduss:cred.bduss}),cred);const rows=withPostMentions(parsePagePosts(reply.bytes),reply.bytes);if(sort===0)this._rememberLocations('post',thread_id,rows,'post_id',page);return rows}
  _readPageEnvelope(bytes,parse){this._assertRun();try{return parse(bytes)}catch(error){this._assertRun();if(error.server_code===5){this._pause('官方楼层读取要求验证，已停止本轮',{code:5});throw new TiebaError('官方楼层读取要求验证','verification_required')}throw error}}
  async _postPage(thread_id,page,cred,post_id=''){const reply=await this._pb('/c/f/pb/page?cmd=302001',encodePageRequest({thread_id,...(post_id?{post_id}:{}),page,limit:30,sort:0,bduss:cred.bduss}),cred);const result=this._readPageEnvelope(reply.bytes,parsePostPage);if(result.thread_id&&result.thread_id!==thread_id)throw new TiebaError('官方楼层所属主题与请求不一致','invalid_target');return {...result,posts:withPostMentions(result.posts,reply.bytes)}}
  async _resolvePostTarget(thread_id,post_id,fid,cred){
    const cached=this._location('post',thread_id+':'+post_id,null)
    const read=async page=>{
      this._assertRun?.();let result
      try{result=await this._postPage(thread_id,page,cred,page===0?post_id:'')}catch(error){if(error.code==='invalid_response')throw new TiebaError('真实父楼定位响应无法核验，未改发新楼','target_not_resolved');throw error}
      this._assertRun?.();if(result.forum_id!==fid)throw new TiebaError('实际父楼与目标吧不一致，未发表','invalid_target');this._rememberLocations('post',thread_id,result.posts,'post_id',result.page.current_page);return result.posts.find(row=>row.post_id===post_id)
    }
    let found=await read(cached??0)
    if(!found&&cached!==null)found=await read(0)
    if(!found?.author_uid)throw new TiebaError('真实父楼定位未完成，未改发新楼','target_not_resolved')
    return found
  }
  async _replyTail(thread_id,fid,cred){
    const first=await this._postPage(thread_id,1,cred)
    if(first.forum_id!==fid)throw new TiebaError('实际帖子与目标吧不一致，未发表','invalid_target')
    let tail=first.page.total_page===1?first:await this._postPage(thread_id,first.page.total_page,cred)
    if(tail.page.current_page!==tail.page.total_page)tail=await this._postPage(thread_id,tail.page.total_page,cred)
    if(tail.forum_id!==fid||tail.page.current_page!==tail.page.total_page||!tail.posts.length)throw new TiebaError('实际末页无法核验，未猜测发表位置','invalid_response')
    return tail
  }
  async _subPage(thread_id,post_id,page,cred){
    const reply=await this._pb('/c/f/pb/floor?cmd=302002',encodeSubRequest({thread_id,post_id,page,bduss:cred.bduss}),cred),result=this._readPageEnvelope(reply.bytes,parseSubPage)
    if(result.thread_id!==thread_id||result.parent_post_id!==post_id)throw new TiebaError('官方楼中楼坐标与目标不一致','invalid_target')
    return result
  }
  async _resolveSubTarget(thread_id,post_id,child_id,fid,cred){
    const cached=this._location('sub',thread_id+':'+post_id+':'+child_id,null),pages=new Set();let total=1,reads=0
    const read=async page=>{
      this._assertRun?.();let result
      try{result=await this._subPage(thread_id,post_id,page,cred)}catch(error){if(error.code==='invalid_response')throw new TiebaError('真实子楼定位响应无法核验，未改回父楼或新楼','target_not_resolved');throw error}
      this._assertRun?.();if(result.forum_id!==fid)throw new TiebaError('实际子楼与目标吧不一致，未发表','invalid_target');reads++;total=Math.max(total,result.page.total_page);pages.add(result.page.current_page);this._rememberLocations('sub',thread_id+':'+post_id,result.posts,'sub_reply_id',result.page.current_page);return result.posts.find(row=>row.sub_reply_id===child_id)
    }
    let found=await read(cached??1)
    // A busy floor can move a cached child onto the adjacent page. Check that
    // neighborhood and the recent tail before spending the bound on page 1+.
    // All reads still share one bound; an incomplete scan cannot prove deletion.
    const likely=[...(cached!==null?[cached+1,cached-1]:[]),...(total>10?[total,total-1]:[])]
    for(const page of likely){if(found||reads>=10)break;if(page<1||page>total||pages.has(page))continue;found=await read(page)}
    for(let page=1;!found&&page<=total&&reads<10;page++){if(pages.has(page))continue;found=await read(page)}
    if(!found?.author?.uid)throw new TiebaError(found?'真实子楼作者未通过回读核验，未改回父楼或新楼':pages.size===total?'已核验的楼中楼分页未找到目标子楼，未改回父楼或新楼':'真实子楼定位未完成，未改回父楼或新楼','target_not_resolved')
    return found
  }
  async _subTail(thread_id,post_id,fid,cred){
    const first=await this._subPage(thread_id,post_id,1,cred)
    let tail=first.page.total_page===1?first:await this._subPage(thread_id,post_id,first.page.total_page,cred)
    if(tail.page.current_page!==tail.page.total_page)tail=await this._subPage(thread_id,post_id,tail.page.total_page,cred)
    if(tail.forum_id!==fid||tail.page.current_page!==tail.page.total_page)throw new TiebaError('实际楼中楼末页无法核验','invalid_response')
    return tail
  }
  _incomingReplySource(action){
    const batch=action.metadata?.prepared_in?.round_id
    if(action.kind!=='tieba.reply'||!batch)return null
    const rows=this.store.db.prepare("SELECT a.target_json,a.metadata_json,e.source_at,a.source_evidence_id FROM actions a JOIN evidence e ON e.id=a.source_evidence_id WHERE a.platform='tieba' AND a.kind='activity.incoming' AND json_extract(a.metadata_json,'$.execution')='model' AND json_extract(a.metadata_json,'$.batch_id')=?").all(batch)
    for(const row of rows){const target=JSON.parse(row.target_json);if(target.thread_id===action.target.thread_id&&target.post_id===action.target.post_id&&(target.sub_reply_id??'')===(action.target.sub_reply_id??''))return {...target,source_at:row.source_at,source_evidence_id:row.source_evidence_id,manual:JSON.parse(row.metadata_json).trigger==='manual'}}
    return null
  }
  async _existingIncomingReply(source,{cred,me,before}={}){
    if(!source?.thread_id||!source.post_id||!source.actor_uid||!Number.isSafeInteger(source.source_at)||source.source_at<=0)throw new TiebaError('来信来源不完整，无法核对人工回复，未发表','invalid_target')
    cred??=await this._credential();me??=await this._self(cred)
    let page=before??await this._subPage(source.thread_id,source.post_id,1,cred)
    if(!before&&page.page.total_page>1)page=await this._subPage(source.thread_id,source.post_id,page.page.total_page,cred)
    for(let count=0;count<10;count++){
      for(const row of page.posts){
        if((row.author_uid??row.author?.uid)!==me.uid||!Number.isSafeInteger(row.source_at)||row.source_at<=0||row.source_at<source.source_at||row.source_at===source.source_at&&BigInt(row.sub_reply_id??row.post_id)<=BigInt(source.sub_reply_id??source.post_id))continue
        if(!source.sub_reply_id||explicitSourceReplyUid(row)===source.actor_uid)return {existing_post_id:row.sub_reply_id??row.post_id,source_message_id:source.source_message_id??source.sub_reply_id??source.post_id,source_at:row.source_at,response_sha256:page.response_sha256}
      }
      if(page.page.current_page===1||page.posts.length&&Math.min(...page.posts.map(row=>row.source_at))<source.source_at)return null
      page=await this._subPage(source.thread_id,source.post_id,page.page.current_page-1,cred)
    }
    throw new TiebaError('人工回复去重分页尚未完整核对，未发表','invalid_target')
  }
  async _profile(portrait,cred){if(typeof portrait!=='string'||!/^tb\.1\.[a-z0-9_.%-]+$/i.test(portrait))throw new TiebaError('引用主页标识无效','invalid_target');const response=await this._pb('/c/u/user/profile?cmd=303012',encodeProfileRequest({portrait,bduss:cred.bduss}),cred),user=this._readPageEnvelope(response.bytes,parseUserProfile);if(user.portrait.split('?')[0]!==portrait||!user.name_show)throw new TiebaError('引用主页身份未通过回读核验','target_not_resolved');return{uid:tiebaId(user.uid),name:user.name_show,portrait}}
  async _confirmWebReply({thread_id,post_id='',child_id='',profile_id='',resolved,fid,cred,before,body,me,started_at,emotes=[],images=[],expected_id=''}){
    const readPage=page=>post_id?this._subPage(thread_id,post_id,page,cred):this._postPage(thread_id,page,cred),tail=post_id?await this._subTail(thread_id,post_id,fid,cred):await this._replyTail(thread_id,fid,cred),pages=[tail]
    if(tail.page.total_page>before.page.total_page&&tail.page.total_page-before.page.total_page<=1)pages.push(await readPage(before.page.total_page))
    const maxFloor=Math.max(0,...before.posts.map(row=>row.floor)),maxPid=before.posts.reduce((value,row)=>BigInt(row.post_id)>value?BigInt(row.post_id):value,0n),compact=value=>value.replace(/\s+/gu,''),expected=child_id||profile_id?'回复 '+resolved.name+' :'+body:body
    const candidates=pages.flatMap(page=>page.forum_id===fid?page.posts:[]).filter(row=>(post_id||row.floor>maxFloor)&&BigInt(row.post_id)>maxPid&&row.author_uid===me.uid&&row.source_at>=started_at-5000&&row.source_at<=this._now()+60000&&(!expected_id||row.post_id===expected_id)&&(!(child_id||profile_id)||row.mention_uids?.[0]===resolved.uid)),matches=[]
    for(const row of candidates){
      this._assertRun();let mediaMatches=emotes.length||images.length?matchesTiebaMedia(row,{body:expected,emotes,images}):compact(row.text)===compact(expected)
      if(!mediaMatches&&images.length===1){const scope=currentRunScope(),timeout=AbortSignal.timeout(15000),signal=scope?.signal?AbortSignal.any([timeout,scope.signal]):timeout,verified=await verifyTiebaReadbackImage(row,{body:expected,emotes,image:images[0],fetcher:this.imageFetcher,signal});this._assertRun(scope);mediaMatches=!!verified}
      if(mediaMatches)matches.push(row)
    }
    const unique=[...new Map(matches.map(row=>[row.post_id,row])).values()]
    if(unique.length!==1)return null
    const post=unique[0]
    return {post_id:post.post_id,thread_id,author_uid:post.author_uid,source_at:post.source_at,floor:post.floor,body_sha256:sha(body),before_max_post_id:maxPid.toString(),before_max_floor:maxFloor,response_sha256:tail.response_sha256,...(post_id?{parent_post_id:post_id}:{}),...(child_id?{parent_sub_reply_id:child_id,reply_uid:resolved.uid,mention_uid:post.mention_uids[0]}:{}),...(profile_id?{reply_profile_id:profile_id,reply_uid:resolved.uid,mention_uid:post.mention_uids[0]}:{})}
  }
  /** Reconcile exactly one owner-specified server post with an unknown draft.
   * This method only reads official state and returns a proof; it never sends
   * the draft, changes its status, loosens permissions, or loops over unknowns. */
  async reconcilePublication(action,{post_id:server_post_id}={},trusted_context={}){
    if(trusted_context.owner_authorized!==true)throw new TiebaError('只有主人可核验指定的未确认发表','owner_required')
    const raw=action?.id?this.store.db.prepare('SELECT *,CAST(body AS BLOB) bytes FROM actions WHERE id=?').get(action.id):null
    if(!raw||raw.platform!=='tieba'||raw.kind!=='tieba.reply'||raw.status!=='unknown'||raw.request_digest!==action.request_digest||raw.body_digest!==sha(action.body)||Buffer.from(raw.bytes).toString('utf8')!==action.body||!isDeepStrictEqual(JSON.parse(raw.target_json),action.target))throw new TiebaError('只能核验原稿和摘要一致的贴吧未确认回复','invalid_action')
    const metadata=JSON.parse(raw.metadata_json),oldReceipt=JSON.parse(raw.receipt_json)
    if(metadata.network_started!==true||metadata.confirmed_rejection===true||oldReceipt.rejected===true||!Number.isSafeInteger(metadata.attempted_at)||metadata.attempted_at<=0)throw new TiebaError('原动作没有可核验的真实网络开始记录','invalid_action')
    assertTiebaActionTarget(action.kind,action.target)
    const target=action.target,thread_id=tiebaId(target.thread_id),new_post_id=tiebaId(server_post_id),parent_id=target.post_id?tiebaId(target.post_id):'',child_id=target.sub_reply_id?tiebaId(target.sub_reply_id):'',emotes=checkedTiebaEmotes(target.emotes??[]),asset_ids=target.asset_ids??[]
    if(new_post_id===parent_id||new_post_id===child_id||!Array.isArray(asset_ids)||asset_ids.length>1)throw new TiebaError('核验的新楼层ID或媒体数量不符','invalid_target')
    if(this.store.db.prepare("SELECT id FROM actions WHERE id<>? AND platform='tieba' AND status='confirmed' AND json_extract(receipt_json,'$.server_id')=? LIMIT 1").get(action.id,new_post_id))throw new TiebaError('该新楼层已属于另一条已确认动作','invalid_target')
    const cred=await this._credential(),me=await this._self(cred),binding=this.store.listPlatformIdentities({namespace:'tieba',entity_id:this._settings().value.account_entity_id,role:'account'})
    if(binding.length!==1||binding[0].platform_uid!==me.uid)throw new TiebaError('当前官方账号与原生绑定不符，未认领旧动作','account_changed')
    const bar=barName(target.bar),forum=await this._bar(bar),fid=tiebaId(forum.forum_id)
    let row,page,resolved=null
    if(parent_id){
      const parent=await this._resolvePostTarget(thread_id,parent_id,fid,cred)
      if(target.reply_profile_id)resolved=await this._profile(target.reply_profile_id,cred)
      else if(child_id){const original=await this._resolveSubTarget(thread_id,parent_id,child_id,fid,cred);resolved={uid:original.author.uid,name:original.author.name_show}}
      else if(target.reply_uid&&tiebaId(target.reply_uid)!==parent.author_uid)throw new TiebaError('原稿回复对象与实际父楼不符','invalid_target')
      if(resolved&&target.reply_uid&&resolved.uid!==target.reply_uid)throw new TiebaError('原稿回复对象与实际子楼不符','invalid_target')
      row=await this._resolveSubTarget(thread_id,parent_id,new_post_id,fid,cred)
    }else{
      // The official protobuf reader locates an exact pid only with pn=0.
      // pn=1 still selects the first page even when a pid is supplied.
      page=await this._postPage(thread_id,0,cred,new_post_id)
      if(page.forum_id!==fid||page.thread_id!==thread_id)throw new TiebaError('指定新楼层与主题或吧不符','invalid_target')
      const matches=page.posts.filter(post=>post.post_id===new_post_id)
      if(matches.length!==1)throw new TiebaError('官方读取尚未唯一找到指定新楼层','target_not_resolved')
      row=matches[0]
    }
    const author_uid=row.author_uid??row.author?.uid,source_at=row.source_at??row.source_time*1000,expected=child_id||target.reply_profile_id?'回复 '+resolved.name+' :'+action.body:action.body
    if(author_uid!==me.uid||!Number.isSafeInteger(source_at)||source_at<metadata.attempted_at-5000||source_at>metadata.attempted_at+180000||source_at>raw.updated_at+60000||resolved&&explicitSourceReplyUid(row)!==resolved.uid)throw new TiebaError('指定楼层作者、时间或回复对象与原动作不符','invalid_target')
    const asset_hashes=[]
    let mediaMatches
    if(asset_ids.length){
      if(!this.assets?.read)throw new TiebaError('原生素材仓库不可用，不能跳过原图核验','invalid_asset')
      const asset=await this.assets.read(asset_ids[0]);if(!asset.bytes?.length||!/^image\//.test(asset.media_type)||sha(asset.bytes)!==asset.sha256)throw new TiebaError('原素材完整性核验未完成','invalid_asset')
      const verified=await verifyTiebaReadbackImage(row,{body:expected,emotes,image:{asset_sha256:asset.sha256},fetcher:this.imageFetcher,signal:AbortSignal.timeout(15000)})
      mediaMatches=!!verified;asset_hashes.push({asset_id:asset.id,sha256:asset.sha256})
    }else mediaMatches=matchesTiebaMedia(row,{body:expected,emotes})
    if(!mediaMatches)throw new TiebaError('正文、原生表情或原图字节未与原稿完全相符；保留未确认','invalid_target')
    const readback={post_id:new_post_id,thread_id,author_uid,source_at,floor:row.floor??0,body_sha256:sha(action.body),request_digest:action.request_digest,attempted_at:metadata.attempted_at,emotes:[...emotes],asset_hashes,...(page?{response_sha256:page.response_sha256}:{}),...(parent_id?{parent_post_id:parent_id}:{}),...(child_id?{parent_sub_reply_id:child_id}:{}),...(resolved?{reply_uid:resolved.uid,mention_uid:explicitSourceReplyUid(row)}:{})}
    return {source:'server_receipt',accepted:true,server_id:new_post_id,confirmation_source:'exact_server_readback',id_source:'exact_server_readback',reconciled:true,readback,thread_id,...(parent_id?{parent_post_id:parent_id}:{}),...(child_id?{parent_sub_reply_id:child_id}:{}),...(target.reply_uid?{reply_uid:target.reply_uid}:{}),no_publication:true}
  }
  async _subs(thread_id,post_id,{page=1,cred}={}){thread_id=tiebaId(thread_id);post_id=tiebaId(post_id);positive(page);cred??=await this._credential(false);const reply=await this._pb('/c/f/pb/floor?cmd=302002',encodeSubRequest({thread_id,post_id,page,bduss:cred.bduss}),cred);const rows=parseSubPosts(reply.bytes);this._rememberLocations('sub',thread_id+':'+post_id,rows,'sub_reply_id',page);return rows}
  async thread({thread_id,post_id='',page=1,limit=20,offset=0,max_chars=1800,session_id='',round_id=''}={}){
    thread_id=tiebaId(thread_id);if(post_id)post_id=tiebaId(post_id);positive(page);positive(limit,30);paged('',{offset,max_chars});this._reserveRead(thread_id,round_id);const cred=await this._credential(false),reply=await this._http(TIEBA_HOST+'/p/'+thread_id+'?'+new URLSearchParams({pn:String(page)}),{cred,referer:TIEBA_HOST+'/p/'+thread_id});if(!reply.response.ok)throw new TiebaError('贴吧正文读取未完成','read_failed');const html=parseThreadHtml(reply.text);let posts=[],coordinates_available=true
    try{if(post_id){const focused=await this._postPage(thread_id,0,cred,post_id);if(focused.thread_id!==thread_id)throw new TiebaError('目标楼所属主题尚未通过官方回读核验','target_not_resolved');posts=focused.posts;page=focused.page.current_page;this._rememberLocations('post',thread_id,posts,'post_id',page)}else posts=await this._posts(thread_id,{page,limit:30,sort:0,cred})}catch(error){this._assertRun();if(['verification_required','risk_pause','invalid_target','target_not_resolved'].includes(error.code))throw error;coordinates_available=false}
    const knownBar=this._knownForum(thread_id),bar=html.bar?this._rememberForum(thread_id,html.bar):knownBar,forum_identity_conflict=!!(html.bar&&knownBar&&!bar),self_uid=accountSourceUid(this.store,'tieba',this._settings().value.account_entity_id),topic_author_uid=posts.find(row=>row.floor===1)?.author_uid??'',source={platform:'tieba',source_kind:'thread',self_uid,topic_author_uid,...(bar?{bar,thread_id}:{})},rawRows=posts.length?posts:html.floors.map((body,index)=>({text:body,name:html.owners[index]??'',author_uid:''})),named=rawRows.map(row=>({...row,name:row.name||row.author?.name_show||row.author?.name||''})),focus=post_id?named.find(row=>row.post_id===post_id):null,rows=focus?[focus,...named.filter(row=>row.post_id!==post_id)]:named,attributed=attributePublicRows(rows,source)
    if(!rows.some(row=>row.text?.trim()))throw new TiebaError('未读取到真实帖子正文，不标记已读','read_failed')
    const body=renderPublicSource(rows,source),stored=await this._source({body,ref:TIEBA_HOST+'/p/'+thread_id,session_id,source_id:'thread:'+thread_id+':'+page+(post_id?':focus:'+post_id:''),protocol_metadata:sourceParts(rows)})
    this._observeAtmosphere({bar,thread_id,title:html.title,evidence_ids:stored.evidence_ids,session_id,query:html.title+' '+rows.slice(0,4).map(row=>row.text).join(' '),reply_actor_uids:(focus?[focus]:posts).filter(row=>row.author_uid!==self_uid&&row.mention_uids?.includes(self_uid)).sort((a,b)=>b.source_at-a.source_at).map(row=>row.author_uid),reply_actor_texts:Object.fromEntries((focus?[focus]:posts).filter(row=>row.mention_uids?.includes(self_uid)).sort((a,b)=>a.source_at-b.source_at).map(row=>[row.author_uid,row.text]))})
    this._journal('thread_read',{thread_id,page,marker_kind:'read',request_id:reply.request_id},{event_type:'platform_read',visibility:'public',ref:thread_id,event_key:reply.request_id})
    return registerNativeReadSource({thread_id,page,...(post_id?{focus:{requested_post_id:post_id,found:!!focus,...(focus?{floor:focus.floor,author_uid:focus.author_uid,author_name:focus.name}:{})}}:{}),title:html.title.slice(0,180),bar:bar?canonicalBar(bar):'',...(forum_identity_conflict?{forum_identity_conflict:true}:{}),coordinates_available,source_context:publicSourceContext(source),posts:this.vision.rows(attributed.slice(0,limit),{thread_id,session_id}).map(briefRow),images:html.images,...paged(body,{offset,max_chars}),...stored},body)
  }
  async subReplies({thread_id,post_id,page=1,limit=20,offset=0,max_chars=1800,session_id='',round_id=''}={}){
    thread_id=tiebaId(thread_id);post_id=tiebaId(post_id);positive(limit,30);paged('',{offset,max_chars});this._reserveRead(thread_id,round_id)
    const bar=this._knownForum(thread_id),raw=await this._subs(thread_id,post_id,{page}),cached=this.store.db.prepare("SELECT value_json FROM cache_entries WHERE key=? AND expires_at>?").get('tieba.location.post:'+thread_id+':'+post_id,this._now()),parent_author_uid=cached?JSON.parse(cached.value_json).author_uid??'':'',source={platform:'tieba',source_kind:'sub_reply',parent_post_id:post_id,self_uid:accountSourceUid(this.store,'tieba',this._settings().value.account_entity_id),parent_author_uid,...(bar?{bar,thread_id}:{})},rows=raw.map(row=>({...row,reply_to_uid:explicitSourceReplyUid(row)||parent_author_uid})),body=renderPublicSource(rows,source),stored=await this._source({body,ref:TIEBA_HOST+'/p/'+thread_id+'?pid='+post_id,session_id,source_id:'subs:'+thread_id+':'+post_id+':'+page,protocol_metadata:sourceParts(rows)})
    this._observeAtmosphere({bar,thread_id,evidence_ids:stored.evidence_ids,session_id,query:rows.slice(0,6).map(row=>row.text).join(' ')})
    return registerNativeReadSource({thread_id,post_id,page,source_context:publicSourceContext(source),items:this.vision.rows(attributePublicRows(rows,source).slice(0,limit),{thread_id,post_id,session_id}).map(briefRow),...paged(body,{offset,max_chars}),...stored},body)
  }

  async conversation({thread_id,post_id,page=1,sub_page=1,limit=20,sub_limit=limit,offset=0,sub_offset=0,max_chars=1800,session_id='',round_id=''}={}){
    thread_id=tiebaId(thread_id);post_id=tiebaId(post_id);positive(page);positive(sub_page);positive(limit,30);positive(sub_limit,30);paged('',{offset,max_chars});paged('',{offset:sub_offset,max_chars})
    const thread=await this.thread({thread_id,post_id,page,limit,offset,max_chars,session_id,round_id})
    this._assertRun()
    if(!thread.coordinates_available||!thread.focus?.found||thread.forum_identity_conflict)throw new TiebaError('目标主楼未通过定位核验，未拼接其他楼中楼','target_not_resolved')
    const sub_replies=await this.subReplies({thread_id,post_id,page:sub_page,limit:sub_limit,offset:sub_offset,max_chars,session_id,round_id})
    this._assertRun()
    return {thread_id,post_id,thread,sub_replies,evidence_ids:[...new Set([...thread.evidence_ids,...sub_replies.evidence_ids])],untrusted:true}
  }

  async followed({pages=1,limit=50}={}){positive(pages,5);positive(limit,200);const cred=await this._credential(),items=[];for(let page=1;page<=pages;page++){const params={BDUSS:cred.bduss,_client_version:'12.60.1.0',friend_uid:'0',page_no:String(page),page_size:String(limit)},reply=await this._http(TIEBA_APP+'/c/f/forum/like',{method:'POST',body:new URLSearchParams({...params,sign:appSignature(params)}),cred,content_type:'application/x-www-form-urlencoded'});let data;try{data=exactTiebaJson(reply.text)}catch{throw new TiebaError('关注列表响应无法核验','invalid_response')}if(Number(data.error_code??data.error?.errno??0)!==0)throw new TiebaError('关注列表读取未完成','read_failed');for(const row of [...(data.forum_list?.['non-gconforum']??[]),...(data.forum_list?.gconforum??[])])if(typeof row.name==='string'&&!items.includes(row.name))items.push(row.name);if(!Number(data.has_more))break}return {items:items.slice(0,200),untrusted:true}}
  emotes(args={}){return tiebaEmotes(args)}
  imageSources(row,coordinates){return tiebaRowImageSources(row,coordinates)}
  readImage(args={}){return this.vision.read(args)}
  inputImages(args={}){return this.vision.input(args)}
  images({bar='',query='',limit=20,round_id=''}={}){
    positive(limit,50);text(query,4000);text(bar,160)
    const rows=this.store.db.prepare("SELECT id,kind,media_type,byte_size,manifest_json FROM assets WHERE kind IN ('image','sticker') AND (json_extract(manifest_json,'$.collection') IN ('tieba_images','shared_stickers') OR EXISTS(SELECT 1 FROM json_each(assets.manifest_json,'$.catalog_entries') c WHERE json_extract(c.value,'$.collection') IN ('tieba_images','shared_stickers')) OR EXISTS(SELECT 1 FROM json_each(assets.manifest_json,'$.registrations') r WHERE json_extract(r.value,'$.manifest.collection') IN ('tieba_images','shared_stickers') OR EXISTS(SELECT 1 FROM json_each(r.value,'$.manifest.catalog_entries') c WHERE json_extract(c.value,'$.collection') IN ('tieba_images','shared_stickers')))) ORDER BY created_at DESC,id LIMIT 10000").all()
    const used=new Map(this.store.db.prepare("SELECT json_extract(metadata_json,'$.asset_id') asset_id,MAX(source_at) source_at FROM journal_events WHERE platform='tieba' AND json_extract(metadata_json,'$.subtype')='image_upload_attempt' GROUP BY asset_id").all().map(row=>[row.asset_id,row.source_at])),round_used=round_id&&this.rounds.active(round_id)?this.store.db.prepare("SELECT COALESCE(SUM(json_extract(metadata_json,'$.image_count')),0) used FROM journal_events WHERE platform='tieba' AND json_extract(metadata_json,'$.subtype')='publication_attempt' AND json_extract(metadata_json,'$.round_id')=?").get(round_id).used:0
    const indexed=new NativeExpressionVisual({store:this.store,assets:this.assets,now:this.now}).decorate(rows.map(({manifest_json,...row})=>({...row,manifest:JSON.parse(manifest_json)})))
    return selectTiebaMedia({assets:indexed,bar,query,limit,now:this._now(),last_used_at_by_asset:used,budget:{daily_limit:this._settings().config.permissions?.images===false?0:this._settings().config.limits?.image_per_day??10,daily_used:this._highWater('image',shanghaiTime(this._now()).date).used,round_limit:1,round_used}})
  }
  mediaContext({agent,context={},platform}={},task){
    if(this.closed||platform!=='tieba'||context.memory_only||task?.maintenance_kind||context.conversation_id?.startsWith('dm:'))return ''
    const sid=context.session_id??agent?.session?.header?.id??agent?.session?.id??'',recent=this.readContexts.get(sid),incoming=task?.batch?.kind==='activity.incoming'?task.batch.tasks:[],bars=[...new Set(incoming.map(row=>row.target.bar).filter(Boolean))],bar=bars.length===1?bars[0]:incoming.length?'':recent?.bar
    if(!bar)return ''
    const query=(incoming.length?incoming.map(row=>semanticMessageText(row.body,{platform:'tieba',conversation_id:row.target.conversation_id})).join(' '):recent?.query??'').slice(0,4000),hint=incoming.length&&!query.trim()?'':compactTiebaMediaHint(this.images({bar,query,limit:2,round_id:context.round_id??context.task_id??context.source_scope??''}),{max_chars:220,max_items:1})
    return hint+'\n回帖可直接用的自带表情：滑稽、笑眼、疑问、汗、泪、真棒；填target.emotes，每条最多3个。已列出的可用收藏图也可直接填target.asset_ids，每条最多1张；需要其他表情或图片再查emotes/images。合适才加，不手写标记。'
  }
  styleRefs({bar,limit=4}={}){positive(limit,8);const profile=this.atmosphere.profile({bar});bar=profile.bar;if(profile.sample_count)return {bar,items:profile.samples.filter(row=>row.observed_at>=this._now()-30*86400000).slice(0,Math.min(2,limit)).map(row=>({text:row.text.slice(0,160),evidence_id:row.evidence_id,author_uid:row.author_uid,thread_id:row.thread_id,scene:row.scene})),qualified:profile.qualified,reference_only:true,not_persona_override:true};const items=[];for(const doc of this.store.listDocuments({type:'tieba_style_library',limit:1000}))if(doc.value.historical===false)for(const row of doc.value.bars){let key;try{key=canonicalBar(row.bar)}catch{continue}if(key===bar)for(const sample of row.samples)items.push({text:sample.text,likes:sample.likes})}items.sort((a,b)=>(b.likes??0)-(a.likes??0));return {bar,items:items.slice(0,limit).map(row=>({...row,text:row.text.slice(0,160)})),qualified:false,legacy_unverified:true,note:'旧样本缺少逐条作者和阅读证据，仅供核查，不作为当前吧内画像或自动表达建议。',reference_only:true,not_persona_override:true}}
  barStyle({bar}={}){const profile=this.atmosphere.profile({bar});return {bar:profile.bar,mode:profile.qualified?'observed':'insufficient_samples',qualified:profile.qualified,thread_count:profile.thread_count,author_count:profile.author_count,sample_count:profile.sample_count,scenes:profile.scenes,updated_at:profile.updated_at,reference_only:true,not_persona_override:true}}
  evolutionStatus(){const row=this.store.db.prepare("SELECT metadata_json FROM journal_events WHERE platform='tieba' AND json_extract(metadata_json,'$.subtype') IN ('tieba_evolution_control','tieba_evolution_state') ORDER BY recorded_at DESC,rowid DESC LIMIT 1").get();const data=row?JSON.parse(row.metadata_json):{};return {paused:data.paused===true,reason:data.reason??data.paused_reason??'',deterministic_style_only:true,persona_updates:'shared_learning_review',model_calls:0}}
  evolutionControl({paused}={},trusted_context={}){if(trusted_context.owner_authorized!==true||typeof paused!=='boolean')throw new TiebaError('只能由主人切换风格学习状态','owner_required');this._journal('tieba_evolution_control',{paused,reason:'主人设置',persona_unchanged:true},{event_key:randomUUID()});return this.evolutionStatus()}
  async observeStyle({bar,thread_id,page=1,session_id=''}={}){
    this._assertRun();bar=barName(bar);thread_id=tiebaId(thread_id);if(this._settings().config.learning?.bar_style_enabled!==true||this.evolutionStatus().paused)return {bar,added:0,disabled:true,model_calls:0}
    const posts=await this._posts(thread_id,{page,limit:30,sort:1}),stored=await this._source({body:posts.map(row=>row.text).join('\n'),ref:TIEBA_HOST+'/p/'+thread_id,session_id,source_id:'style-source:'+thread_id+':'+page}),id='style-library-tieba',current=this.store.getDocument(id)
    if(current&&(current.type!=='tieba_style_library'||current.value.historical!==false))throw new TiebaError('当前风格库文档类型不一致','invalid_state')
    const value=clone(current?.value??{platform:'tieba',historical:false,bars:[]}),before=value.bars.find(row=>row.bar===bar),samples=[...(before?.samples??[])],seen=new Set(samples.map(row=>row.text));let added=0
    for(const post of posts){this._assertRun();const body=post.text.replace(/\s+/g,' ').trim();if(body.length<4||body.length>120||/^(?:\+?3|6|哈+|啊+|dd|cy|顶|好|赞|草|乐|典|难绷|插眼|mark|留名)[。！？!?~～]*$/i.test(body)||/加群|广告|代练|私信|https?:\/\/|微信|qq群|扫码|淘宝|拼多多/i.test(body)||seen.has(body)||this._settings().config.learning?.hot_only===true&&post.likes<=0)continue;seen.add(body);samples.push({text:body,likes:post.likes,likes_raw:String(post.likes),floor:post.floor});added++}
    samples.sort((a,b)=>(b.likes??0)-(a.likes??0));samples.splice(40);const joined=samples.map(row=>row.text).join('\n'),matches=re=>(joined.match(re)??[]).length,terms=new Map();for(const sample of samples){const chars=sample.text.replace(/[\s，。！？、,.!?“”"'「」（）()\[\]]/g,'');for(let n=2;n<=3;n++)for(let index=0;index+n<=chars.length;index++){const term=chars.slice(index,index+n);if(term.isWellFormed())terms.set(term,(terms.get(term)??0)+1)}}const statistics={sample_count:samples.length,average_length:samples.length?Math.round(samples.reduce((sum,row)=>sum+row.text.length,0)/samples.length):0,punctuation:{period:matches(/。/g),question:matches(/[?？]/g),exclamation:matches(/[!！]/g),ellipsis:matches(/…|\.{3,}/g)},emoji_rate:samples.length?samples.filter(row=>/\[[^\]]{1,8}\]|[\u{1f300}-\u{1faff}]/u.test(row.text)).length/samples.length:0,top_terms:[...terms].filter(([,count])=>count>=2).sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0])).slice(0,5).map(([term])=>term)},updated={bar,updated_at:this._now(),updated_time_raw:new Date(this._now()).toISOString(),samples,statistics}
    this._assertRun();value.bars=value.bars.filter(row=>row.bar!==bar);value.bars.push(updated);this.store.putDocument({id,type:'tieba_style_library',expected_revision:current?.revision??0,value});this._journal('style_observation',{bar,thread_id,added,retained:samples.length,evidence_ids:stored.evidence_ids,persona_unchanged:true},{event_type:'learning',event_key:randomUUID()});return {bar,added,retained:samples.length,...stored,persona_unchanged:true,model_calls:0}
  }
  _highWater(category,day){let used=0,last=0;for(const row of this.store.db.prepare("SELECT value_json FROM documents WHERE type='quota' AND json_extract(value_json,'$.platform')='tieba' AND json_extract(value_json,'$.category')=? AND json_extract(value_json,'$.day')=?").all(category,day)){const value=JSON.parse(row.value_json);used=Math.max(used,value.used??0);last=Math.max(last,value.last_action_at??0)}const field={reply:'replies',post:'post_count',image:'image_count'}[category];for(const row of this.store.db.prepare("SELECT metadata_json FROM journal_events WHERE platform='tieba' AND json_extract(metadata_json,'$.subtype')='tieba_daily_counters' AND json_extract(metadata_json,'$.day')=?").all(day)){const value=JSON.parse(row.metadata_json);used=Math.max(used,value[field]??0);last=Math.max(last,value.last_reply_at??0)}return {used,last}}
  _subReplyUsed(day){let used=this.store.getDocument('quota:tieba:subreply:'+day)?.value.used??0;for(const row of this.store.db.prepare("SELECT metadata_json FROM journal_events WHERE platform='tieba' AND json_extract(metadata_json,'$.subtype')='tieba_daily_counters' AND json_extract(metadata_json,'$.day')=?").all(day))used=Math.max(used,JSON.parse(row.metadata_json).sub_replies??0);return used}
  nextIncomingReplyAt({sub=true}={}){const now=this._now(),day=shanghaiTime(now),limits=this._settings().config.limits??{};return this._highWater('reply',day.date).used>=(limits.reply_per_day??5)||sub&&this._subReplyUsed(day.date)>=(limits.sub_reply_per_day??3)?day.midnight+86400000:now}
  nextPublicationAt(action){
    if(action?.kind==='tieba.message')return this.inbox.nextAt()
    if(!['tieba.reply','tieba.post'].includes(action.kind))return 0
    const now=this._now(),day=shanghaiTime(now).date,last=Math.max(this._highWater('reply',day).last,this._highWater('post',day).last),gap=this._settings().config.limits?.reply_gap_ms??30000
    return last&&last+gap>now?last+gap:0
  }
  _reserveRound(action,sub,imageCount,roundScope){
    const day=shanghaiTime(this._now()).date,cfg=this._settings().config,key='tieba:publication_attempt:'+action.id+':'+day,old=this.store.db.prepare('SELECT id FROM journal_events WHERE event_key=?').get(key)
    if(old){const category=action.kind==='tieba.post'?'post':'reply',cap=category==='post'?cfg.limits?.new_thread_per_day??1:cfg.limits?.reply_per_day??5;if(cap<=0||this._highWater(category,day).used>cap)throw new TiebaError('当前发表额度不足以继续原动作','daily_limit');return true}
    if(roundScope&&this.rounds.active(roundScope)){
      const rows=this.store.db.prepare("SELECT metadata_json FROM journal_events WHERE platform='tieba' AND json_extract(metadata_json,'$.subtype')='publication_attempt' AND json_extract(metadata_json,'$.round_id')=?").all(roundScope).map(row=>JSON.parse(row.metadata_json))
      if(action.kind==='tieba.reply'&&rows.filter(row=>row.operation==='tieba.reply').length>=this.rounds.limits(roundScope).reply||sub&&rows.filter(row=>row.sub_reply===true).length>=this.rounds.limits(roundScope).sub_reply||imageCount&&rows.reduce((sum,row)=>sum+(row.image_count??0),0)+imageCount>1)throw new TiebaError('统一模型批次的贴吧发表额度已用完','round_limit')
    }
    this._journal('publication_attempt',{action_id:action.id,day,round_id:roundScope,operation:action.kind,sub_reply:sub,image_count:imageCount,confirmation:'attempt_not_success'},{status:'pending',direction:'out',event_key:action.id+':'+day});return false
  }
  _reserveAction(action,sub,imageCount=0,roundScope=''){this._assertRun();return this.store.transaction(()=>{if(this._reserveRound(action,sub,imageCount,roundScope))return;const day=shanghaiTime(this._now()).date,cfg=this._settings().config,id='quota:tieba:'+(action.kind==='tieba.post'?'post':'reply')+':'+day,category=action.kind==='tieba.post'?'post':'reply',current=this.store.getDocument(id),high=this._highWater(category,day),last=Math.max(high.last,this._highWater(category==='reply'?'post':'reply',day).last),limit=category==='post'?cfg.limits?.new_thread_per_day??1:cfg.limits?.reply_per_day??5;if(high.used>=limit)throw new TiebaError('贴吧当天发表额度已用完','daily_limit');if(last&&this._now()-last<(cfg.limits?.reply_gap_ms??30000))throw new TiebaError('贴吧发表冷却尚未结束','minimum_gap',{not_before:last+(cfg.limits?.reply_gap_ms??30000)});if(sub){const sid='quota:tieba:subreply:'+day,doc=this.store.getDocument(sid);const used=this._subReplyUsed(day);const cap=cfg.limits?.sub_reply_per_day??3;if(used>=cap)throw new TiebaError('贴吧楼中楼当天额度已用完','daily_limit');this.store.putDocument({id:sid,type:'quota',expected_revision:doc?.revision??0,value:{platform:'tieba',category:'reply',metric:'actions',day,limit:cap,used:used+1,last_action_at:this._now()}})}if(imageCount){const imageId='quota:tieba:image:'+day,imageDoc=this.store.getDocument(imageId),used=this._highWater('image',day).used,cap=cfg.limits?.image_per_day??10;if(used+imageCount>cap)throw new TiebaError('贴吧图片当天额度已用完','daily_limit');this.store.putDocument({id:imageId,type:'quota',expected_revision:imageDoc?.revision??0,value:{platform:'tieba',category:'image',metric:'images',day,used:used+imageCount,limit:cap,last_action_at:this._now()}})}this.store.putDocument({id,type:'quota',expected_revision:current?.revision??0,value:{platform:'tieba',category,metric:'actions',day,limit,used:high.used+1,last_action_at:this._now()}})})}
  _action(action){if(!action||action.platform!=='tieba'||!['tieba.reply','tieba.post','tieba.sign','tieba.follow','tieba.unfollow','tieba.message'].includes(action.kind))throw new TiebaError('贴吧动作类型无效','invalid_action');const row=this.store.db.prepare('SELECT *,CAST(body AS BLOB) AS body_bytes FROM actions WHERE id=?').get(action.id);if(!row||row.status!=='leased'||row.platform!=='tieba'||row.kind!==action.kind||row.request_digest!==action.request_digest||row.body_digest!==sha(action.body)||Buffer.from(row.body_bytes).toString()!==action.body||!isDeepStrictEqual(JSON.parse(row.target_json),action.target))throw new TiebaError('动作没有有效原生租约','invalid_action_lease');return row}
  async _failure(action,receipt,cred){
    const sensitive=[...(cred.secrets??[]),cred.bduss,this.auth?.tbs].filter(value=>typeof value==='string'&&value.length>=8),scrub=value=>{let output=String(value??'');for(const token of sensitive)output=output.split(token).join('[已隐藏]');return redactText(output)},canonical={...receipt,message:scrub(receipt.message)}
    const proof={source:'server_receipt',accepted:false,rejected:receipt.valid===true&&receipt.code!==0,code:receipt.code,captcha_present:receipt.captcha_present===true,response_sha256:receipt.response_sha256}
    if(receipt.code===5||receipt.captcha_present){const reason=receipt.captcha_present?'官方回执包含验证字段，需主人正常处理':'官方返回错误5，缺少明确验证码字段；需核对登录与TBS';this._pause(reason,{captcha:receipt.captcha_present,code:receipt.code});const diagnostics=await this.diagnostics().catch(()=>({authenticated:false,tbs_available:false,reason:'官方登录诊断未完成'}));canonical.diagnostics={authenticated:diagnostics.authenticated,tbs_available:diagnostics.tbs_available,reason:diagnostics.reason}}
    this._journal('publication_receipt',{action_id:action.id,receipt:safeJson(canonical)},{status:proof.rejected?'blocked':'unknown',event_key:action.id+':'+receipt.response_sha256})
    return result(proof.rejected?'blocked':'unknown',receipt.code===5?'贴吧返回5，已保留回执并暂停；未猜测验证码已解决、未重试':receipt.captcha_present?'官方要求正常验证，未重试':'贴吧未确认发表，保留原动作等待核验',proof)
  }
  async _finalizePublication(action,{receipt,readback,bar,thread_id,post_id,child_id,profile_id,resolved,body,me,transport='',recovered=false}){
      let server_id;try{server_id=tiebaId(receipt.post_id);if(action.kind==='tieba.post')tiebaId(receipt.thread_id)}catch{return result('unknown','服务器成功码缺少非零新pid/spid，未伪造确认或重发')}
      const reused=this.store.db.prepare("SELECT id FROM actions WHERE platform='tieba' AND status='confirmed' AND id<>? AND json_extract(receipt_json,'$.server_id')=? LIMIT 1").get(action.id,server_id)
      if(server_id===post_id||server_id===child_id||reused||action.kind==='tieba.reply'&&receipt.thread_id&&receipt.thread_id!==thread_id)return result('unknown','回执复用了已有楼层ID或线程不一致，未伪造新的发表；不自动重发')
      const proof={source:'server_receipt',accepted:true,...(receipt.valid&&receipt.code===0?{code:0}:{raw_response_confirmed:false,confirmation_source:'exact_server_readback'}),server_id,...(receipt.thread_id?{thread_id:receipt.thread_id}:{}),...(post_id?{parent_post_id:post_id}:{}),...(child_id?{parent_sub_reply_id:child_id}:{}),...(profile_id?{reply_profile_id:profile_id}:{}),...(resolved?{reply_uid:resolved.uid}:{}),...(receipt.visible===undefined?{}:{visible:receipt.visible}),response_sha256:receipt.response_sha256,...(readback?{id_source:'exact_server_readback',readback}:{}),...(transport?{transport}:{}),...(recovered?{recovered_read_only:true}:{})}
      try{this._journal('publication_receipt',{action_id:action.id,operation:action.kind,bar,thread_id:receipt.thread_id||thread_id,post_id:server_id,code:receipt.valid?receipt.code:null,confirmation_source:readback?'exact_server_readback':'server_response',response_sha256:receipt.response_sha256},{status:'confirmed',event_key:action.id})}catch{}
      let memory_evidence_id
      try{if(this.store.getDocument('settings')?.value.memory?.enabled!==false){const input={platform:'tieba',conversation_id:'thread:'+(receipt.thread_id||thread_id),actor_uid:me.uid,kind:action.kind==='tieba.post'?'post':'reply',text:body,source_message_id:server_id,source_at:this._now(),visibility:'public',receipt:{ok:true,status:'sent',reply_id:server_id}},saved=this.memoryRuntime?await this.memoryRuntime.ingestActionReceipt(input):this.memory.recordEvidence({...input,direction:'out',source_type:'server_action',source:{kind:'server_action'}});memory_evidence_id=saved?.id;if(saved?.id&&resolved){const prior=this.store.getPlatformIdentity('tieba',resolved.uid),person=this.store.upsertPlatformIdentity({namespace:'tieba',platform_uid:resolved.uid,display_name:resolved.name,...(prior?{entity_id:prior.entity_id,role:prior.role}:{role:'person'})}),memory=this.memoryRuntime?.memory??this.memory;memory._relate('evidence',saved.id,'directed_to','entity',person.entity_id);memory._relate('action',action.id,'directed_to','entity',person.entity_id)}}}catch{try{this._journal('receipt_memory_pending',{action_id:action.id,server_id},{event_key:action.id})}catch{}}
      return {...result('confirmed',readback?'已严格回读确认新楼层、正文及所发表媒体':'贴吧服务器返回有效新楼层回执',proof),...(memory_evidence_id?{memory_evidence_id}:{})}
  }
  async _confirmNewThread({thread_id,fid,cred,body,me,started_at}){
    this._assertRun();if(/```|`|<pre\b|<code\b/i.test(body))return null
    const page=await this._postPage(tiebaId(thread_id),1,cred);this._assertRun()
    if(page.thread_id!==thread_id||page.forum_id!==fid||page.page?.current_page!==1||!/^[a-f0-9]{64}$/.test(page.response_sha256??''))return null
    const visible=value=>value.replace(/[\r\n]/g,''),earliest=Math.floor(started_at/1000)*1000,candidates=page.posts.filter(row=>row.floor===1&&row.author_uid===me.uid&&Number.isSafeInteger(row.source_at)&&row.source_at>=earliest&&row.source_at<=this._now()+5000&&/^[1-9]\d*$/.test(row.post_id??'')&&typeof row.text==='string'&&visible(row.text)===visible(body)&&matchesTiebaMedia(row,{body,emotes:[],images:[]}))
    if(candidates.length!==1)return null
    const row=candidates[0];return {post_id:row.post_id,thread_id,author_uid:row.author_uid,source_at:row.source_at,floor:1,body_sha256:sha(body),response_sha256:page.response_sha256}
  }
  async _confirmNewThreadFromFeed({before,bar,title,fid,cred,body,me,started_at}){
    if(/```|`|<pre\b|<code\b/i.test(body)||!Array.isArray(before?.threads)||!before.threads.length)return null
    const ids=new Set(before.threads.map(row=>row.thread_id).filter(id=>/^[1-9]\d*$/.test(id))),maximum=[...ids].reduce((n,id)=>BigInt(id)>n?BigInt(id):n,0n);if(!maximum)return null
    const after=await this._bar(bar);this._assertRun();if(after.forum_id!==fid)return null
    const candidates=after.threads.filter(row=>row.title===title&&/^[1-9]\d*$/.test(row.thread_id??'')&&!ids.has(row.thread_id)&&BigInt(row.thread_id)>maximum)
    if(!candidates.length||candidates.length>3)return null
    const matches=[];for(const row of candidates){const found=await this._confirmNewThread({thread_id:row.thread_id,fid,cred,body,me,started_at});if(found)matches.push({...found,title:row.title})}
    return matches.length===1?matches[0]:null
  }
  _mediaRecoveryState(action,context){
    this._assertRun(context.scope);this._enabled()
    const settings=this._settings(),at=this._now(),row=this.store.db.prepare('SELECT *,CAST(body AS BLOB) AS body_bytes FROM actions WHERE id=?').get(action.id),metadata=row?JSON.parse(row.metadata_json):{}
    if(this.store.getDocument('settings')?.value.enabled===false||settings.config.permissions?.reply!==true||context.post_id&&settings.config.permissions?.sub_reply!==true||context.images.length&&settings.config.permissions?.images!==true||settings.value.credential_ref!==context.credential_ref||settings.value.account_entity_id!==context.account_entity_id||accountSourceUid(this.store,'tieba',settings.value.account_entity_id)!==context.bound_uid)return false
    if(!row||row.status!=='submitting'||row.platform!=='tieba'||row.kind!=='tieba.reply'||row.request_digest!==context.request_digest||row.request_digest!==action.request_digest||row.body_digest!==sha(action.body)||Buffer.from(row.body_bytes).toString('utf8')!==action.body||!isDeepStrictEqual(JSON.parse(row.target_json),action.target)||metadata.lease_token!==context.lease_token||metadata.lease_until<=at||metadata.network_started!==true||metadata.attempted_at!==context.attempted_at||!Number.isSafeInteger(metadata.attempted_at)||at<metadata.attempted_at||at-metadata.attempted_at>180000)return false
    if(context.http_ok===false||context.receipt?.captcha_present||context.receipt?.valid&&context.receipt.code!==0)return false
    context.check_authority();return true
  }
  async _recoverMediaPublication(action,context){
    if(!context?.post_request_started||context.recovery_attempted||!this._mediaRecoveryState(action,context))return null
    if(sha((await this._credential()).header)!==context.credential_hash||!this._mediaRecoveryState(action,context))return null
    context.recovery_attempted=true
    const {thread_id,post_id,child_id,profile_id,resolved,fid,cred,before,body,me,started_at,emotes,images}=context,readback=await this._confirmWebReply({thread_id,post_id,child_id,profile_id,resolved,fid,cred,before,body,me,started_at,emotes,images,expected_id:context.receipt?.post_id??''})
    if(!readback||!/^[a-f0-9]{64}$/.test(readback.response_sha256??'')||!this._mediaRecoveryState(action,context)||sha((await this._credential()).header)!==context.credential_hash||!this._mediaRecoveryState(action,context))return null
    const receipt={...(context.receipt??{valid:false,code:null}),post_id:readback.post_id,thread_id,response_sha256:context.receipt?.response_sha256??readback.response_sha256}
    return this._finalizePublication(action,{receipt,readback,bar:context.bar,thread_id,post_id,child_id,profile_id,resolved,body,me,transport:context.transport,recovered:true})
  }
  async submit(action,{mark_network_started,round_id}={}){
    const scope=currentRunScope();this._assertRun(scope)
    if(action?.kind==='tieba.message')return this.inbox.submit(action,{mark_network_started})
    let marked=false,owns=false,recovery=null
    try{
      const storedAction=this._action(action),prepared=JSON.parse(storedAction.metadata_json).prepared_in,roundScope=round_id??prepared?.round_id??'';if(typeof roundScope!=='string'||roundScope.length>512||/[\0\r\n]/.test(roundScope)||prepared?.round_id&&round_id!==undefined&&prepared.round_id!==round_id)throw new TiebaError('发表批次与可信来源不一致','invalid_action_lease');if(this.inflight.has(action.id))return result('blocked','同一贴吧动作正在处理');this.inflight.add(action.id);owns=true;this._enabled()
      if(typeof mark_network_started!=='function')throw new TiebaError('缺少原生发表回调','invalid_action_lease')
      const cfg=this._settings().config,target=action.target,bar=barName(target.bar),body=text(action.body,3000),publication=['tieba.reply','tieba.post'].includes(action.kind),sub=!!target.post_id||!!target.sub_reply_id,images=target.asset_ids??[]
      let emotes;try{emotes=checkedTiebaEmotes(target.emotes??[])}catch(error){throw new TiebaError(error.message,'invalid_input')}
      if(publication)try{assertTiebaPublishableText(body)}catch(error){throw new TiebaError(error.message,'invalid_input')}
      const allowed=action.kind==='tieba.post'?cfg.permissions?.new_thread:action.kind==='tieba.reply'?cfg.permissions?.reply:action.kind==='tieba.sign'?cfg.permissions?.sign:cfg.permissions?.follow
      if(allowed!==true||sub&&cfg.permissions?.sub_reply!==true)throw new TiebaError('当前设置未允许此操作','permission_denied')
      try{assertTiebaActionTarget(action.kind,target)}catch(error){throw new TiebaError(error.message,'invalid_target')}
      const checkReplyIntent=()=>{if(action.kind==='tieba.reply'&&!tiebaDeclaredAnswerAllowed(this._settings().config,target))throw new TiebaError('当前设置关闭答疑，明确声明为answer的回复未发送；其他用途不由程序猜测','permission_denied')}
      checkReplyIntent()
      if(action.kind==='tieba.reply'&&!target.post_id&&(target.sub_reply_id||target.reply_uid||target.reply_profile_id||target.target_name))throw new TiebaError('回复他人必须有真实父楼坐标，未改发新楼','invalid_target')
      if(!Array.isArray(images)||images.length>1||images.length&&action.kind!=='tieba.reply')throw new TiebaError('贴吧图片暂支持评论或楼中楼单图，不改发文字或切换楼层','unsupported_image_target')
      if(action.kind==='tieba.post'&&emotes.length)throw new TiebaError('贴吧自带表情暂支持回帖与楼中楼，未改发其他位置','unsupported_image_target')
      if(images.length&&(cfg.permissions?.images!==true))throw new TiebaError('贴吧图片发表尚未启用','permission_denied')
      const publicText=action.kind==='tieba.post'?text(target.title,30)+'\n'+body:body
      if(publication&&(!outboundAllowed(publicText)||redactText(publicText)!==publicText))throw new TiebaError('正文或标题含私密资源或凭据，未发表','invalid_input')
      if(action.kind==='tieba.reply'&&(!body.trim().length&&!images.length&&!emotes.length||body.length>(sub?300:400)))throw new TiebaError('回帖正文长度不符合当前通道要求','invalid_input')
      if(action.kind==='tieba.post'&&(text(target.title,30).trim().length<4||body.trim().length<10||body.length>2000))throw new TiebaError('标题或发帖正文长度不符合要求','invalid_input')
      if(cfg.expression?.tone_gate_enabled&&action.kind==='tieba.reply'&&/希望对你有帮助|如有疑问|请随时|建议您|值得注意的是|不难看出|从某种意义上/.test(body.replace(/```[\s\S]*?```|`[^`\n]*`|^>[^\n]*/gm,'')))throw new TiebaError('正文命中已开启的客服腔门禁，原稿未改写','tone_gate')
      const credentialRef=this._settings().value.credential_ref,cred=await this._credential(),auth=await this._tbs(cred);if([...(cred.secrets??[]),auth.tbs].some(value=>value.length>=8&&publicText.includes(value)))throw new TiebaError('正文包含当前私密认证内容，未发表','invalid_input');const me=await this._self(cred),forum=await this._bar(bar);const fid=tiebaId(forum.forum_id)
      let resolved=null,thread_id='',post_id='',child_id='',profile_id='',parent_floor=0,image=null,reply_source_at=action.created_at
      if(action.kind==='tieba.reply'){
        thread_id=tiebaId(target.thread_id)
        if(sub){post_id=tiebaId(target.post_id);child_id=target.sub_reply_id?tiebaId(target.sub_reply_id):'';if(child_id===post_id)throw new TiebaError('父楼ID不能当作子楼ID','invalid_target');const parent=await this._resolvePostTarget(thread_id,post_id,fid,cred);if(parent.floor===1&&!child_id&&parent.reply_count===0)throw new TiebaError('帖子主题楼没有可用楼中楼，明确指定的目标不会改发新楼；评论帖子主题应不带post_id','invalid_target');parent_floor=parent.floor;reply_source_at=parent.source_at||reply_source_at;profile_id=target.reply_profile_id??'';if(profile_id&&child_id)throw new TiebaError('主页引用与具体子楼引用不能混用','invalid_target');resolved=profile_id?await this._profile(profile_id,cred):{uid:tiebaId(parent.author_uid),name:'',portrait:''};if(child_id){const child=await this._resolveSubTarget(thread_id,post_id,child_id,fid,cred);reply_source_at=child.source_time?child.source_time*1000:reply_source_at;resolved={uid:tiebaId(child.author.uid),name:child.author.name_show,portrait:child.author.portrait}}if(target.reply_uid&&tiebaId(target.reply_uid)!==resolved.uid)throw new TiebaError('冻结的回复UID与实际目标作者不一致','invalid_target');if(resolved.uid===me.uid){if(child_id||profile_id||target.reply_uid)throw new TiebaError('不能把自己当作回复对象','invalid_target');resolved=null}}
      }
      const checkReplyPause=()=>{const source=this._incomingReplySource(action);if(source&&this.participation?.paused({platform:'tieba',...source}))throw new TiebaError('当前来信已选择暂不接话','participation_paused');if(action.kind==='tieba.reply'&&tiebaReplyPaused(this._settings().config,resolved?.uid??target.reply_uid,this._now(),reply_source_at))throw new TiebaError('主人已临时暂停回复此贴吧账号','permission_denied')}
      checkReplyPause()
      if(images.length){if(!this.assets?.read)throw new TiebaError('原生图片仓库尚未接入','invalid_asset');const asset=await abortableRun(this.assets.read(text(images[0],160)),scope);this._assertRun(scope);if(!/^image\/(?:png|jpeg|gif|webp)$/.test(asset.media_type)||asset.bytes.length>2*1024*1024)throw new TiebaError('贴吧图片类型或容量不符合原图床限制','invalid_asset');if(!canPublishAsset(asset,{platform:'tieba',bar}))throw new TiebaError('图片未获本吧发表许可','invalid_asset');const entries=(asset.manifest.catalog_entries??[]).filter(row=>row.historical!==true&&['tieba_images','shared_stickers'].includes(row.collection));let last=Math.max(0,...entries.map(row=>row.last_used_at??0));for(const row of this.store.db.prepare("SELECT source_at FROM journal_events WHERE platform='tieba' AND json_extract(metadata_json,'$.subtype')='image_upload_attempt' AND json_extract(metadata_json,'$.asset_id')=?").all(asset.id))last=Math.max(last,row.source_at??0);if(last&&this._now()-last<86400000)throw new TiebaError('这张图片仍在24小时使用冷却内','minimum_gap');const high=this._highWater('image',shanghaiTime(this._now()).date);if(high.used>=(cfg.limits?.image_per_day??10))throw new TiebaError('贴吧图片当天额度已用完','daily_limit');image=asset}
      const onWrite=async()=>{this._assertRun(scope);checkReplyPause();checkReplyIntent();const row=this.store.db.prepare('SELECT status,request_digest,metadata_json FROM actions WHERE id=?').get(action.id),metadata=row?JSON.parse(row.metadata_json):{};if(!row||!['leased','submitting'].includes(row.status)||row.request_digest!==action.request_digest||metadata.lease_until<=this._now())throw new TiebaError('贴吧发表租约已结束','invalid_action_lease');if(this._settings().value.credential_ref!==credentialRef||sha((await this._credential()).header)!==sha(cred.header))throw new TiebaError('账号登录态已变化，原动作未继续发送','account_changed');this._assertRun(scope);checkReplyPause();checkReplyIntent();if(!marked){if(publication)this._reserveAction(action,sub,image?1:0,roundScope);await mark_network_started();this._assertRun(scope);const checked=this.store.db.prepare('SELECT status,metadata_json FROM actions WHERE id=?').get(action.id),meta=checked?JSON.parse(checked.metadata_json):{};if(checked?.status!=='submitting'||meta.network_started!==true||meta.lease_until<=this._now())throw new TiebaError('原生发表开始状态未持久确认或已过期','invalid_action_lease');marked=true}}
      const webReply=action.kind==='tieba.reply',richReply=webReply&&!!(emotes.length||image),wapReply=richReply&&!!image&&!sub,appMediaReply=webReply&&(emotes.length>0&&!image||sub&&!!image),before=webReply?(sub?await this._subTail(thread_id,post_id,fid,cred):await this._replyTail(thread_id,fid,cred)):null,started_at=this._now()
      const incoming=this._incomingReplySource(action)
      if(incoming){const existing=await this._existingIncomingReply(incoming,{cred,me,before:sub?before:undefined});if(existing){this._journal('incoming_already_replied',{action_id:action.id,...existing},{status:'recorded',event_key:action.id});return result('blocked','此来信已有本账号回复，已跳过重复发送',{source:'server_state_read',accepted:false,duplicate_reply:true,...existing})}}
      let response,readback=null
      if(action.kind==='tieba.sign'||action.kind==='tieba.follow'||action.kind==='tieba.unfollow'){
        const signProof=()=>{const observed_at=this._now();return{source:'server_state_read',schema_id:'companion.tieba_sign_state',schema_version:1,operation:'tieba.sign',request_digest:action.request_digest,bar,forum_id:fid,account_uid:me.uid,signed:true,day:shanghaiTime(observed_at).date,observed_at,write_attempted:marked}}
        if(action.kind==='tieba.sign'&&forum.signed===true){if(this._settings().value.credential_ref!==credentialRef||sha((await this._credential()).header)!==sha(cred.header))throw new TiebaError('账号登录态已变化，签到状态未确认','account_changed');const proof=signProof();this._journal('account_state_observation',{action_id:action.id,bar,operation:action.kind,state_verified:true,write_attempted:false},{status:'confirmed',event_key:action.id});return result('confirmed','官方账号状态显示本吧今日已签到，未重复提交',proof)}
        const sign=action.kind==='tieba.sign',params=sign?{ie:'utf-8',kw:bar,tbs:auth.tbs}:{BDUSS:cred.bduss,fid,tbs:auth.tbs},payload=sign?params:{...params,sign:appSignature(params)}
        response=await this._http((sign?TIEBA_HOST+'/sign/add':TIEBA_APP+(action.kind==='tieba.follow'?'/c/c/forum/like':'/c/c/forum/unfavolike')),{method:'POST',body:new URLSearchParams(payload),cred,content_type:'application/x-www-form-urlencoded',write:true,onWrite:sign?async()=>{if(this._settings().config.permissions?.sign!==true)throw new TiebaError('当前设置关闭签到，未提交','permission_denied');await onWrite()}:onWrite,referer:TIEBA_HOST+'/f?kw='+encodeURIComponent(bar)})
        if(sign){
          const receipt=parseAddReceipt(response.bytes);if(!response.response.ok||receipt.code===5||receipt.captcha_present)return this._failure(action,receipt,cred)
          const checked=await this._bar(bar),sameAccount=this._settings().value.credential_ref===credentialRef&&sha((await this._credential()).header)===sha(cred.header),verified=sameAccount&&checked.forum_id===fid&&checked.signed===true
          this._journal('account_state_observation',{action_id:action.id,bar,operation:action.kind,state_verified:verified,write_attempted:true,response_sha256:receipt.response_sha256},{status:verified?'confirmed':'unknown',event_key:action.id})
          return verified?result('confirmed','官方账号状态已回读确认本吧今日签到',signProof()):result('unknown','签到请求后尚未确认本吧今日已签到，保留原动作且不重发',{source:'server_state_read',operation:'tieba.sign',state_verified:false})
        }
        const receipt=parseAddReceipt(response.bytes);if(!receipt.valid||receipt.code!==0)return this._failure(action,receipt,cred)
        const checked=await this._bar(bar);const verified=sign?checked.signed:checked.following===(action.kind==='tieba.follow');this._journal('account_state_observation',{action_id:action.id,bar,operation:action.kind,state_verified:verified,publication_id_available:false},{status:'unknown',event_key:action.id});return result('unknown',verified?'目标状态已回读符合要求，但接口没有独立非零发表回执；不会重发':'账号操作未取得独立回执，保留结果等待核验',{source:'server_state_read',state_verified:verified})
      }
      if(richReply&&profile_id)return result('blocked','主页引用与媒体暂不能组合，未改发其他位置')
      let uploadedImage=null
      if(image){
        const form=new FormData();form.append('pic',new Blob([image.bytes],{type:image.media_type}),'image.'+({ 'image/jpeg':'jpg','image/png':'png','image/gif':'gif','image/webp':'webp' }[image.media_type]));form.append('forum_name',bar)
        const upload=await this._http(TIEBA_HOST+'/mo/q/cooluploadpic?r='+this._now(),{method:'POST',body:form,cred,write:true,referer:TIEBA_HOST+'/mo/q/m?kw='+encodeURIComponent(bar),onWrite:async()=>{await onWrite();this._journal('image_upload_attempt',{action_id:action.id,asset_id:image.id,upload_confirmed:false},{status:'pending',event_key:action.id+':'+image.id})}})
        const wapUploadedImage=upload.response.ok?parseTiebaWapPictureUpload(upload.text):null
        uploadedImage=appMediaReply&&wapUploadedImage?parseWapUploadAppPicture(upload.text):wapUploadedImage
        let shape;try{const data=exactTiebaJson(upload.text);shape={top_keys:Object.keys(data).slice(0,30),data_keys:data.data&&typeof data.data==='object'?Object.keys(data.data).slice(0,30):[]}}catch{shape={html_response:true}}
        this._journal('image_upload_receipt',{action_id:action.id,asset_id:image.id,upload_confirmed:!!wapUploadedImage,post_request_started:false,...(appMediaReply?{app_picture_verified:!!uploadedImage}:{}),...(wapUploadedImage?{image_url:wapUploadedImage.url}:{}),...(!wapUploadedImage?{response_shape:shape}:{})},{event_key:action.id+':'+image.id})
        if(!wapUploadedImage)return this._failure(action,parseAddReceipt(upload.bytes),cred)
        if(!uploadedImage)return result('unknown','图片已上传，但官方回执缺少可核验的楼中楼图片标识和尺寸；正文未提交且不重试')
      }
      if(richReply)recovery={scope,thread_id,post_id,child_id,profile_id,resolved:resolved?clone(resolved):null,fid,cred,before:clone(before),body,bar,me:clone(me),started_at,emotes:[...emotes],images:uploadedImage?[{...uploadedImage,asset_sha256:sha(image.bytes)}]:[],transport:wapReply?'wap_rich':'app_protobuf_media',credential_ref:credentialRef,credential_hash:sha(cred.header),account_entity_id:this._settings().value.account_entity_id,bound_uid:accountSourceUid(this.store,'tieba',this._settings().value.account_entity_id),lease_token:JSON.parse(storedAction.metadata_json).lease_token,request_digest:action.request_digest,post_request_started:false,recovery_attempted:false,attempted_at:null,check_authority:()=>{checkReplyPause();checkReplyIntent()}}
      const onReplyWrite=async()=>{await onWrite();if(recovery){const row=this.store.db.prepare('SELECT metadata_json FROM actions WHERE id=?').get(action.id),metadata=row?JSON.parse(row.metadata_json):{};recovery.post_request_started=true;recovery.attempted_at=metadata.attempted_at}}
      const richBody=wapReply?compileTiebaWapMedia(body,{emotes}):compileTiebaWebMedia(body,{emotes})
      if(action.kind==='tieba.post')response=await this._http(TIEBA_HOST+'/f/commit/thread/add',{method:'POST',body:new URLSearchParams({ie:'utf-8',kw:bar,fid,tbs:auth.tbs,title:target.title,content:richBody,rich_text:'1',__type__:'thread'}),cred,content_type:'application/x-www-form-urlencoded',write:true,onWrite,referer:TIEBA_HOST+'/f?kw='+encodeURIComponent(bar)})
      else if(appMediaReply){
        let transport=compileTiebaMedia(body,{emotes,images:uploadedImage?[uploadedImage]:[]})
        if(child_id){const name=resolved.name.replace(/[(),#\r\n]/g,''),portrait=/^([a-z0-9_.%-]+)(?:\?t=\d{1,16})?$/i.exec(resolved.portrait)?.[1];if(!name||!portrait)throw new TiebaError('目标作者无法安全构造引用','invalid_target');transport='回复 #(reply, '+portrait+', '+name+') :'+transport}
        const bytes=encodeTiebaAppMediaReply({thread_id,forum_id:fid,bar,content:transport,tbs:auth.tbs,bduss:cred.bduss,post_id,sub_reply_id:child_id,reply_uid:post_id?(resolved?.uid??me.uid):'',name_show:me.name_show||me.name,parent_floor}),form=new FormData();form.append('data',new Blob([bytes],{type:'application/octet-stream'}),'file')
        response=await this._http(TIEBA_APP+'/c/c/post/add?cmd=309731&format=protobuf',{method:'POST',body:form,cred,protobuf:true,write:true,onWrite:onReplyWrite})
      }
      else if(wapReply){
        const transport=child_id?'回复 '+resolved.name.replace(/[\r\n]/g,'')+' :'+richBody:richBody,fields={co:transport,_t:String(this._now()),tag:'11',upload_img_info:uploadedImage?.image_info??'',fid,src:'1',word:bar,tbs:auth.tbs,z:thread_id,lp:'6026',nick_name:me.name_show||me.name,...(sub?{pid:post_id,floor:String(parent_floor)}:{}),...(child_id?{lzl_id:child_id}:{})}
        response=await this._http(TIEBA_HOST+'/mo/q/apubpost',{method:'POST',body:new URLSearchParams(fields),cred,content_type:'application/x-www-form-urlencoded',write:true,onWrite:onReplyWrite,referer:TIEBA_HOST+'/p/'+thread_id})
      }
      else if(webReply){
        let transport=richBody
        if(child_id||profile_id){const name=resolved.name.replace(/[(),#\r\n]/g,''),portrait=/^([a-z0-9_.%-]+)(?:\?t=\d{1,16})?$/i.exec(resolved.portrait)?.[1];if(!name||!portrait)throw new TiebaError('目标作者无法安全构造引用','invalid_target');transport='回复 #(reply, '+portrait+', '+name+') :'+richBody}
        const fields={ie:'utf-8',kw:bar,fid,tid:thread_id,tbs:auth.tbs,files:'[]',content:transport,...(emotes.length||uploadedImage?{rich_text:'1',__type__:'reply',is_login:'1'}:{}),...(sub?{rich_text:'1',floor_num:String(parent_floor),quote_id:post_id,repostid:child_id||post_id}:{})}
        response=await this._http(TIEBA_HOST+'/f/commit/post/add',{method:'POST',body:new URLSearchParams(fields),cred,content_type:'application/x-www-form-urlencoded',write:true,onWrite,referer:TIEBA_HOST+'/p/'+thread_id})
      }
      if(recovery)recovery.http_ok=response.response.ok
      let receipt=parseAddReceipt(response.bytes)
      if(recovery)recovery.receipt=receipt
      // Unknown empty write responses are reconciled only by exact public
      // readback. No second submission, fallback endpoint or changed body.
      if(!response.response.ok||!receipt.valid||receipt.code!==0){
        if(!(webReply&&marked&&response.response.ok&&response.bytes.length===0&&!receipt.captcha_present))return this._failure(action,receipt,cred)
        for(let attempt=0;attempt<3&&!readback;attempt++){this._assertRun(scope);readback=await this._confirmWebReply({thread_id,post_id,child_id,profile_id,resolved,fid,cred,before,body,me,started_at,emotes,images:uploadedImage?[{...uploadedImage,asset_sha256:sha(image.bytes)}]:[]})}
        if(!readback)return this._failure(action,receipt,cred)
        receipt={...receipt,post_id:readback.post_id}
      }
      if(webReply&&(!receipt.post_id||emotes.length||uploadedImage)){
        if(receipt.captcha_present){this._pause('官方发表响应要求验证，未确认发表',{captcha:true});return result('unknown','官方响应要求验证且没有新楼层ID，未确认或重发')}
        try{const json=JSON.parse(response.text);this._journal('publication_response_shape',{action_id:action.id,top_keys:Object.keys(json).slice(0,30),data_keys:json.data&&typeof json.data==='object'?Object.keys(json.data).slice(0,30):[],server_post_id:receipt.post_id??'',response_sha256:receipt.response_sha256},{event_key:action.id})}catch{}
        for(let attempt=0;attempt<3&&!readback;attempt++){this._assertRun(scope);readback=await this._confirmWebReply({thread_id,post_id,child_id,profile_id,resolved,fid,cred,before,body,me,started_at,emotes,images:uploadedImage?[{...uploadedImage,asset_sha256:sha(image.bytes)}]:[],expected_id:receipt.post_id??''})}
        if(!readback)return result('unknown','严格回读尚未唯一核对正文、回复对象和所发表媒体；保留原稿且不重发')
        receipt={...receipt,post_id:readback.post_id}
      }
      if(action.kind==='tieba.post'&&!/^[1-9]\d*$/.test(receipt.post_id??'')){
        if(receipt.captcha_present)return this._failure(action,receipt,cred)
        try{readback=/^[1-9]\d*$/.test(receipt.thread_id??'')?await this._confirmNewThread({thread_id:receipt.thread_id,fid,cred,body,me,started_at}):await this._confirmNewThreadFromFeed({before:forum,bar,title:target.title,fid,cred,body,me,started_at})}catch{this._assertRun(scope)}
        if(!readback)return result('unknown','已作原生只读核验，但新主题、首楼作者、正文、吧名或时间尚未唯一核对；保留原稿且不重发',{source:'server_receipt',accepted:false,code:receipt.code,...(/^[1-9]\d*$/.test(receipt.thread_id??'')?{thread_id:receipt.thread_id}:{}),response_sha256:receipt.response_sha256})
        receipt={...receipt,post_id:readback.post_id,thread_id:readback.thread_id}
      }
      if(action.kind==='tieba.post'&&emotes.length){let page;try{page=await this._postPage(tiebaId(receipt.thread_id),1,cred)}catch{};const row=page?.posts.find(row=>row.post_id===receipt.post_id&&row.author_uid===me.uid);if(!row||!matchesTiebaMedia(row,{body,emotes}))return result('unknown','主题表情尚未通过官方回读核验，未重发')}
      return await this._finalizePublication(action,{receipt,readback,bar,thread_id,post_id,child_id,profile_id,resolved,body,me,transport:webReply?(wapReply?'wap_rich':appMediaReply?'app_protobuf_media':'web_form'):''})
    }catch(error){
      let recovered=null,recovery_error
      if(recovery&&(!(error instanceof TiebaError)||['invalid_response','read_failed'].includes(error.code)))try{recovered=await this._recoverMediaPublication(action,recovery)}catch(failure){recovery_error=publicationErrorInfo(failure)}
      try{this._journal('publication_exception',{action_id:action.id,error:publicationErrorInfo(error),post_request_started:recovery?.post_request_started===true,recovery_attempted:recovery?.recovery_attempted===true,recovery_confirmed:recovered?.outcome==='confirmed',...(recovery_error?{recovery_error}:{})},{visibility:'owner',event_key:action.id+':'+sha(JSON.stringify(publicationErrorInfo(error))).slice(0,16)})}catch{}
      if(recovered?.outcome==='confirmed')return recovered
      const row=action?.id?this.store.db.prepare('SELECT metadata_json FROM actions WHERE id=?').get(action.id):null;if(row&&JSON.parse(row.metadata_json).network_started)marked=true;if(!marked&&error instanceof TiebaError&&error.code==='minimum_gap')return {...result('not_started',error.message),not_before:error.not_before??this._now()+(this._settings().config.limits?.reply_gap_ms??30000)};return result(marked?'unknown':error instanceof TiebaError&&['invalid_action','invalid_action_lease','invalid_target','target_not_resolved','invalid_asset','invalid_input','permission_denied','participation_paused','unsupported_image_target','tone_gate','verification_required','daily_limit','minimum_gap','round_limit','account_changed'].includes(error.code)?'blocked':'not_started',error instanceof TiebaError?error.message:'贴吧操作未完成；未自动重试或切换通道')
    }
    finally{if(owns)this.inflight.delete(action.id)}
  }
  close(){this.closed=true;this.inbox.close();this.auth=null;this.selfCache=null;this.readContexts.clear()}
}
