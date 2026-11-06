/** Native Bilibili service. HTTP algorithms adapted from the bundled MIT dsh-bili-whale (copyright 2026 ALTERSSSS).
 * No legacy module, executable, credential path, config reader or standalone scheduler is imported.
 */
import {createHash,randomUUID} from 'node:crypto'
import {isDeepStrictEqual} from 'node:util'
import {setTimeout as wait} from 'node:timers/promises'
import {NativeStore} from './store.mjs'
import {NativeRoundPolicy} from './round-policy.mjs'
import {accountSourceUid,publicSourceContext,attributePublicRows,renderPublicSource,structuredMentionUids} from './source-context.mjs'
import {NativeMemory} from './memory.mjs'
import {validateJson,stringifyJson,isPlainObject} from './contracts.mjs'
import {shanghaiTime} from '../policy.mjs'
import {BilibiliError,BILIBILI_RISK_CODES,biliId,bvidOf,signedWbi,trustedBiliUrl,boundedBody,exactJson,cleanSourceText,pageText,imageInfo} from './bilibili-http.mjs'
import {pollDirectMessages,pollLive,connectLive,readDirectHistory,liveHistory,liveRoom} from './bilibili-inbox.mjs'
import {canPublishAsset} from './asset-policy.mjs'
import {redactText} from './memory-rules.mjs'
import {incomingReplyOrigin} from './publication-origin.mjs'
import {currentRunScope,withRunScope,assertRunActive,abortableRun} from './run-scope.mjs'
export {projectNativeBilibiliReadResult} from './read-result-projection.mjs'

const HOST='https://api.bilibili.com',PASSPORT='https://passport.bilibili.com',UA='Mozilla/5.0'
const sha=value=>createHash('sha256').update(value).digest('hex'),canonical=value=>Array.isArray(value)?value.map(canonical):isPlainObject(value)?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value
const encode=value=>stringifyJson(canonical(value)),clone=value=>structuredClone(value)
const text=(value,max=64000)=>{if(typeof value!=='string'||!value.isWellFormed()||value.includes('\0')||value.length>max)throw new BilibiliError('文字参数无效',{code:'invalid_input'});return value}
const positive=(value,max=100)=>{if(!Number.isSafeInteger(value)||value<1||value>max)throw new BilibiliError('页码或数量无效',{code:'invalid_input'});return value}
const nonzero=value=>{try{return biliId(value)}catch{return ''}}
const result=(outcome,detail,proof)=>({outcome,detail,...(proof?{proof}:{})})
const nonCommentMention=item=>item.item?.type==='dynamic'&&[0,'0'].includes(item.item?.source_id)
const resourceFailure=error=>['resource_unavailable','ETIMEDOUT','timeout'].includes(error?.code)||error?.name==='TimeoutError'
const cookieOf=cred=>['sessdata','bili_jct','buvid3'].filter(key=>cred?.[key]).map(key=>({sessdata:'SESSDATA',bili_jct:'bili_jct',buvid3:'buvid3'}[key])+'='+cred[key]).join('; ')
const credentialValue=input=>{
  if(!isPlainObject(input)||typeof input.sessdata!=='string'||!input.sessdata||typeof input.bili_jct!=='string'||!/^[a-fA-F0-9]{32}$/.test(input.bili_jct))throw new BilibiliError('B站登录态尚未就绪',{code:'authentication_required'})
  const result={sessdata:input.sessdata,bili_jct:input.bili_jct,buvid3:input.buvid3??''}
  if(Object.values(result).some(value=>typeof value!=='string'||/[\r\n;\0]/.test(value)||value.length>10000))throw new BilibiliError('B站登录态无效',{code:'authentication_required'})
  return result
}

export class NativeBilibili {
  constructor({store,credentials,assets,memory_runtime,activity,fetcher=globalThis.fetch,now=Date.now,resource_runner,qr_render,self_names,websocket_factory,learning}={}){
    if(!(store instanceof NativeStore)||typeof credentials!=='function'||typeof fetcher!=='function'||typeof now!=='function')throw new Error('B站服务必须明确使用NativeStore、凭据回调与HTTP实现')
    this.store=store;this.credentials=credentials;this.assets=assets;this.memoryRuntime=memory_runtime;this.activity=activity;this.fetcher=fetcher;this.now=now;this.resourceRunner=resource_runner;this.qrRender=qr_render
    this.memory=memory_runtime?null:new NativeMemory(store,{now});this.inflight=new Set();this.httpQueue=Promise.resolve();this.auth=null;this.closed=false;this.selfNames=self_names;this.websocketFactory=websocket_factory;this.liveConnection=null;this.learning=learning;this.rounds=new NativeRoundPolicy({store,platform:'bilibili',now,settings:()=>this._settings().config})
  }
  _now(){const at=this.now();if(!Number.isSafeInteger(at)||at<0)throw new Error('B站时钟无效');return at}
  _settings(){const id=this.store.getDocument('settings')?.value.platform_document_ids?.bilibili??'bilibili',doc=this.store.getDocument(id);if(doc&&(doc.type!=='platform_settings'||doc.value.platform!=='bilibili'))throw new Error('B站原生设置类型错误');return {id,revision:doc?.revision??0,value:doc?.value??{platform:'bilibili',enabled:false},config:doc?.value.bilibili??{}}}
  _state(){const doc=this.store.getDocument('platform-state-bilibili');if(doc&&doc.type!=='platform_state')throw new Error('B站原生状态类型错误');return {revision:doc?.revision??0,value:doc?.value??{platform:'bilibili'}}}
  _saveState(patch){assertRunActive();return this.store.transaction(()=>{const old=this._state();return this.store.putDocument({id:'platform-state-bilibili',type:'platform_state',expected_revision:old.revision,value:{...old.value,...patch,...(patch.cursors?{cursors:{...old.value.cursors,...patch.cursors}}:{})}})})}
  _cacheGet(kind,key,{stale=false}={}){assertRunActive();const row=this.store.db.prepare('SELECT kind,schema_id,schema_version,CAST(value_json AS BLOB) AS bytes,created_at,expires_at FROM cache_entries WHERE key=?').get('bilibili:'+kind+':'+key);if(!row||row.kind!=='bilibili.'+kind||row.schema_id!=='companion.bilibili.'+kind||row.schema_version!==1||!stale&&row.expires_at!==null&&row.expires_at<=this._now())return null;try{return JSON.parse(Buffer.from(row.bytes).toString('utf8'))}catch{return null}}
  _cachePut(kind,key,value,ttl=null){assertRunActive();validateJson(value,{object:true,maxBytes:8*1024*1024});this.store.db.prepare('INSERT INTO cache_entries(key,kind,schema_id,schema_version,value_json,created_at,expires_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET kind=excluded.kind,schema_id=excluded.schema_id,schema_version=excluded.schema_version,value_json=excluded.value_json,created_at=excluded.created_at,expires_at=excluded.expires_at').run('bilibili:'+kind+':'+key,'bilibili.'+kind,'companion.bilibili.'+kind,1,encode(value),this._now(),ttl===null?null:this._now()+ttl);if(kind==='http')this.store.db.prepare("DELETE FROM cache_entries WHERE kind='bilibili.http' AND key IN (SELECT key FROM cache_entries WHERE kind='bilibili.http' ORDER BY created_at DESC,key LIMIT -1 OFFSET 400)").run()}
  async _credential(required=true){assertRunActive();const ref=this._settings().value.credential_ref;if(!ref){if(required)throw new BilibiliError('请先绑定B站账号',{code:'authentication_required'});return null}try{const value=await abortableRun(this.credentials(ref));assertRunActive();return credentialValue(value)}catch{assertRunActive();if(required)throw new BilibiliError('B站登录态尚未就绪',{code:'authentication_required'});return null}}
  _scope(cred){return sha(cookieOf(cred??{}))}
  _assertAccount(nav){if(nav?.isLogin!==true)throw new BilibiliError('B站登录身份尚未通过服务器核验',{code:'authentication_required'});const mid=biliId(nav.mid),entity_id=this._settings().value.account_entity_id;if(entity_id){const rows=this.store.listPlatformIdentities({namespace:'bilibili',entity_id,role:'account',limit:100});if(rows.length&&(rows.length!==1||rows[0].platform_uid!==mid))throw new BilibiliError('凭据账号与原生绑定不一致，请主人重新登录核对',{code:'account_mismatch'})}return mid}
  _accountKey(){const settings=this._settings().value;return sha(settings.account_entity_id??settings.credential_ref??'unbound-bilibili')}
  _inboxPolicy(){const id=this._settings().config.inbox_document_id??'bilibili-inbox',doc=this.store.getDocument(id);if(doc&&doc.type!=='inbox')throw new Error('B站收件策略类型错误');return doc?.value??{platform:'bilibili',enabled:false}}
  _inboxState(){const account_key=this._accountKey(),id='inbox-state-bilibili-'+account_key,doc=this.store.getDocument(id);if(doc&&(doc.type!=='bilibili_inbox_state'||doc.value.account_key!==account_key))throw new Error('B站持久收件检查点类型或账号不一致');return{id,revision:doc?.revision??0,value:clone(doc?.value??{platform:'bilibili',account_key,reply_baseline:false,reply_last_timestamp_raw:'0',reply_seen_ids:[],reply_seen_people_uids:[],dm_sessions:[],live_rooms:[],last_poll_at:null})}}
  _saveInboxState(state){return this.store.transaction(()=>{
    assertRunActive()
    const current=this._inboxState();if(current.id!==state.id)throw new BilibiliError('账号绑定已经变化，检查点未跨账号写入',{code:'account_changed'})
    const old=current.value,next=state.value,value={...old,...next,reply_baseline:old.reply_baseline||next.reply_baseline,reply_last_timestamp_raw:BigInt(old.reply_last_timestamp_raw)>BigInt(next.reply_last_timestamp_raw)?old.reply_last_timestamp_raw:next.reply_last_timestamp_raw,reply_seen_ids:[...new Set([...old.reply_seen_ids,...next.reply_seen_ids])].slice(-2000),reply_seen_people_uids:[...new Set([...old.reply_seen_people_uids,...next.reply_seen_people_uids])].slice(-2000),last_poll_at:Math.max(old.last_poll_at??0,next.last_poll_at??0)||null}
    const dm=new Map(old.dm_sessions.map(row=>[row.talker_uid,row]));for(const row of next.dm_sessions){const prior=dm.get(row.talker_uid);if(!prior||BigInt(row.last_timestamp_raw)>BigInt(prior.last_timestamp_raw))dm.set(row.talker_uid,row);else if(row.last_timestamp_raw===prior.last_timestamp_raw)dm.set(row.talker_uid,{...prior,baseline:prior.baseline||row.baseline,last_keys:[...new Set([...prior.last_keys,...row.last_keys])].slice(-200),last_polled_at:Math.max(prior.last_polled_at??0,row.last_polled_at??0)||null})}value.dm_sessions=[...dm.values()]
    const live=new Map(old.live_rooms.map(row=>[row.room_id,row]));for(const row of next.live_rooms){const prior=live.get(row.room_id);live.set(row.room_id,!prior?row:{...prior,...row,baseline:prior.baseline||row.baseline,seen_keys:[...new Set([...prior.seen_keys,...row.seen_keys])].slice(-2000),recent_texts:[...new Map([...prior.recent_texts,...row.recent_texts].map(item=>[item.uid+':'+item.text_sha256,item])).values()].slice(-100),last_polled_at:Math.max(prior.last_polled_at??0,row.last_polled_at??0)||null})}value.live_rooms=[...live.values()]
    if(old.dm_device_id)value.dm_device_id=old.dm_device_id
    const saved=this.store.putDocument({id:state.id,type:'bilibili_inbox_state',expected_revision:current.revision,value});state.revision=saved.revision;state.value=clone(saved.value);return state
  })}
  async _incoming({channel,key,uid,name,body,conversation_id,source_at,source_time_raw='',target,visibility,dispatch_key,context_text='',manual=false}){
    this._checkEnabled();if(!this.activity?.enqueueIncoming)throw new BilibiliError('统一活动队列尚未就绪',{code:'queue_unavailable'});uid=biliId(uid);text(body);let evidence
    if(this.memoryRuntime?.ingestHumanMessage)evidence=await this.memoryRuntime.ingestHumanMessage({platform:'bilibili',conversation_id,actor_uid:uid,display_name:name??'',text:body,source_message_id:channel+':'+key,source_at,source_time_raw,visibility})
    else if(this.store.getDocument('settings')?.value.memory?.enabled!==false){const prior=this.store.getPlatformIdentity('bilibili',uid),identity=this.store.upsertPlatformIdentity({namespace:'bilibili',platform_uid:uid,...(prior?{entity_id:prior.entity_id,role:prior.role}:{role:'person'}),display_name:name||prior?.display_name||''});evidence=this.memory.recordEvidence({platform:'bilibili',conversation_id,actor_uid:uid,actor_entity_id:identity.entity_id,direction:'in',kind:'message',text:body,source_message_id:channel+':'+key,source_at,source_time_raw,source_type:'user',visibility,source:{kind:'user',explicit:false,pipeline:'native-bilibili-inbox'}})}
    return this.activity.enqueueIncoming({platform:'bilibili',kind:'incoming',trigger:manual?'manual':'incoming',not_before:this.nextIncomingReplyAt(),idempotency_key:'bilibili:inbox:'+this._accountKey()+':'+channel+':'+(dispatch_key??key),target:{conversation_id,actor_uid:uid,...target},body,...(evidence?.id?{source_evidence_id:evidence.id}:{}),human:true,heavy:false},{public_context:context_text})
  }
  _checkEnabled(){assertRunActive();if(this.closed)throw new BilibiliError('B站服务已关闭',{code:'closed'});if(this.store.getDocument('settings')?.value.enabled===false||this._settings().value.enabled!==true)throw new BilibiliError('B站功能当前关闭',{code:'disabled'});const state=this._state().value;if(state.verification_required)throw new BilibiliError('B站需要主人处理验证；暂停网络请求',{code:'verification_required'});if(state.paused_until>this._now())throw new BilibiliError('B站风控退避中，请稍后再试',{code:'risk_pause'})}
  _replyQuota(day=shanghaiTime(this._now())){
    const id='quota:bilibili:incoming-write:'+day.date,doc=this.store.getDocument(id),total=this.store.getDocument('quota:bilibili:write:'+day.date)?.value.used??0
    if(doc&&(doc.type!=='quota'||doc.value.platform!=='bilibili'||doc.value.category!=='write'||doc.value.day!==day.date))throw new Error('B站来信回复配额文档不一致')
    let used=doc?.value.used
    if(used===undefined){used=0;const rows=this.store.db.prepare("SELECT id,platform,kind,request_digest,target_json FROM actions WHERE platform='bilibili' AND kind='bilibili.reply' AND json_extract(metadata_json,'$.network_started')=1 AND COALESCE(json_extract(metadata_json,'$.attempted_at'),updated_at)>=? AND COALESCE(json_extract(metadata_json,'$.attempted_at'),updated_at)<?").all(day.midnight,day.midnight+86400000);for(const row of rows)if(incomingReplyOrigin(this.store,{...row,target:JSON.parse(row.target_json)}))used++}
    return {id,doc,used:Math.min(total,used),limit:this._settings().config.risk?.reply_daily??this._settings().config.risk?.write_daily??30}
  }
  readAvailability({reserve_inbox=false}={}){
    const now=this._now(),day=shanghaiTime(now),risk=this._settings().config.risk??{},daily=this.store.getDocument('quota:bilibili:read:'+day.date)?.value,hour=this.store.getDocument('quota:bilibili:read:hour:'+Math.floor(now/3600000))?.value,limit=risk.read_daily??500,used=daily?.used??0,hourLimit=risk.read_hourly??100
    let not_before=now,reason='',message='',reserved=0
    if(used>=limit){not_before=day.midnight+86400000;reason='daily_read_limit';message='B站今日读取请求已用完（'+used+'/'+limit+'），自动收件与回复等待北京时间次日0点，或调高读取上限后恢复'}
    else if((hour?.used??0)>=hourLimit){not_before=(Math.floor(now/3600000)+1)*3600000;reason='hourly_read_limit';message='B站本小时读取请求已用完（'+hour.used+'/'+hourLimit+'），等待下一小时恢复'}
    else if(reserve_inbox){const inbox=this.store.getDocument('bilibili-inbox')?.value,channels=inbox?.channels?.length??0;if(inbox?.enabled&&channels){reserved=Math.min(limit,Math.ceil((day.midnight+86400000-now)/Math.max(15000,inbox.poll_interval_ms??180000))*channels+Math.ceil(limit*.15));if(limit-used<=reserved){not_before=day.midnight+86400000;reason='read_reserved_for_inbox';message='B站剩余读取请求优先保留给来信检查和回复，自主浏览等待次日额度'}}}
    return {allowed:not_before<=now,not_before,reason,message,daily_used:used,daily_limit:limit,remaining:Math.max(0,limit-used),reserved_for_inbox:reserved}
  }
  nextIncomingReplyAt(){const now=this._now(),day=shanghaiTime(now),q=this._replyQuota(day),risk=this._settings().config.risk??{},hour=this.store.getDocument('quota:bilibili:write:hour:'+Math.floor(now/3600000))?.value;return Math.max(now,this.readAvailability().not_before,this._state().value.paused_until??0,q.used>=q.limit?day.midnight+86400000:now,hour?.used>=(risk.write_hourly??10)?(Math.floor(now/3600000)+1)*3600000:now)}
  nextPublicationAt(action){
    if(action?.platform!=='bilibili'||action.kind==='bilibili.share'&&action.target?.via==='qq')return this._now()
    const now=this._now(),day=shanghaiTime(now),risk=this._settings().config.risk??{},quota=this.store.getDocument('quota:bilibili:write:'+day.date)?.value,hour=this.store.getDocument('quota:bilibili:write:hour:'+Math.floor(now/3600000))?.value,reply=this._replyQuota(day),isReply=!!incomingReplyOrigin(this.store,action),used=isReply?reply.used:Math.max(0,(quota?.used??0)-reply.used),limit=isReply?reply.limit:risk.write_daily??30
    return Math.max(now,this.readAvailability().not_before,this._state().value.paused_until??0,quota?.last_action_at===undefined?now:quota.last_action_at+(risk.write_gap_ms??60000),used>=limit?day.midnight+86400000:now,hour?.used>=(risk.write_hourly??10)?(Math.floor(now/3600000)+1)*3600000:now)
  }
  publicationWaitDetail(action){
    const read=this.readAvailability();if(!read.allowed)return read.message
    const day=shanghaiTime(this._now()),q=this.store.getDocument('quota:bilibili:write:'+day.date)?.value,reply=this._replyQuota(day),isReply=!!incomingReplyOrigin(this.store,action),used=isReply?reply.used:Math.max(0,(q?.used??0)-reply.used),limit=isReply?reply.limit:this._settings().config.risk?.write_daily??30
    if(used>=limit)return 'B站'+(isReply?'来信回复':'浏览评论与动态')+'今日额度已用完（'+used+'/'+limit+'），等待北京时间次日0点恢复'
    const hour=this.store.getDocument('quota:bilibili:write:hour:'+Math.floor(this._now()/3600000))?.value,hourLimit=this._settings().config.risk?.write_hourly??10
    if(hour?.used>=hourLimit)return 'B站本小时发表额度已用完（'+hour.used+'/'+hourLimit+'），等待下一小时'
    return '等待B站两次发表的最小间隔，尚未开始发送'
  }
  _reserve(category,{coin=0,is_reply=false}={}){
    return this.store.transaction(()=>{this._checkEnabled();const now=this._now(),day=shanghaiTime(now).date,risk=this._settings().config.risk??{},id='quota:bilibili:'+category+':'+day,doc=this.store.getDocument(id),v=doc?.value??{platform:'bilibili',category,day,metric:'actions',used:0,reserved:0},limit=category==='read'?risk.read_daily??500:risk.write_daily??30
      if(doc&&(doc.type!=='quota'||v.platform!=='bilibili'||v.category!==category||v.day!==day))throw new Error('B站限额文档不一致')
      const reply=category==='write'?this._replyQuota(shanghaiTime(now)):null,dayUsed=category==='write'?(is_reply?reply.used:Math.max(0,v.used-reply.used)):v.used,selectedLimit=is_reply?reply.limit:limit
      if(dayUsed>=selectedLimit)throw new BilibiliError('B站今日'+(category==='read'?'读取':'写入')+'额度已用完',{code:'daily_limit'})
      const gap=category==='write'?risk.write_gap_ms??60000:risk.min_gap_ms??300
      if(v.last_action_at!==undefined&&v.last_action_at!==null&&now-v.last_action_at<gap)throw new BilibiliError('B站请求间隔未到，请等待下一次机会',{code:'minimum_gap'})
      const hour=String(Math.floor(now/3600000)),hourId='quota:bilibili:'+category+':hour:'+hour,hourly=this.store.getDocument(hourId),used=hourly?.value.used??0,hourLimit=category==='read'?risk.read_hourly??100:risk.write_hourly??10
      if(hourly&&(hourly.type!=='quota'||hourly.value.platform!=='bilibili'||hourly.value.category!==category||hourly.value.day!==day))throw new Error('B站小时限额文档不一致')
      if(used>=hourLimit)throw new BilibiliError('B站本小时请求额度已用完',{code:'hourly_limit'})
      if(coin){const cid='quota:bilibili:coin:'+day,old=this.store.getDocument(cid),value=old?.value??{platform:'bilibili',category:'write',metric:'actions',day,used:0};if(value.used+coin>5)throw new BilibiliError('今天的投币额度不足',{code:'coin_limit'});this.store.putDocument({id:cid,type:'quota',expected_revision:old?.revision??0,value:{...value,limit:5,used:value.used+coin,last_action_at:now}})}
      if(reply)this.store.putDocument({id:reply.id,type:'quota',expected_revision:reply.doc?.revision??0,value:{platform:'bilibili',category:'write',metric:'actions',day,limit:reply.limit,used:reply.used+(is_reply?1:0),reserved:0,last_action_at:is_reply?now:reply.doc?.value.last_action_at??null}})
      this.store.putDocument({id,type:'quota',expected_revision:doc?.revision??0,value:{...v,limit:category==='write'?limit+reply.limit:limit,used:v.used+1,last_action_at:now}})
      this.store.putDocument({id:hourId,type:'quota',expected_revision:hourly?.revision??0,value:{platform:'bilibili',category,metric:'actions',day,limit:hourLimit,used:used+1,reserved:0,reset_at:(Number(hour)+1)*3600000,last_action_at:now}})
    })
  }
  _pause({http_status,server_code,write}){if([412,429].includes(http_status)||BILIBILI_RISK_CODES.has(server_code)){const previous=this._cacheGet('risk','streak')??{count:0},count=previous.count+1;this._cachePut('risk','streak',{count},86400000);this._saveState({paused_until:this._now()+Math.min(30,5*2**Math.min(count-1,4))*60000,verification_required:write||server_code===-352||this._state().value.verification_required===true,verification_reason:'B站风控或验证码，需要等待或由主人处理'})}}
  async _waitReadGap(){assertRunActive();const now=this._now(),quota=this.store.getDocument('quota:bilibili:read:'+shanghaiTime(now).date)?.value,last=Math.max(this._cacheGet('network','last-read')?.at??0,quota?.last_action_at??0),gap=(this._settings().config.risk?.min_gap_ms??300)-(now-last);if(last&&gap>0&&gap<=10000)await abortableRun(wait(gap,undefined,{signal:currentRunScope()?.signal}));assertRunActive()}
  async _http(url,{method='GET',body,cred,cdn=false,login=false,onWrite,coin=0,maxBytes=8*1024*1024,content_type,continuation=false,is_reply=false}={}){
    const scope=currentRunScope(),target=trustedBiliUrl(url,{cdn,login}),write=method==='POST'
    this._checkEnabled()
    // Serialize actual request starts; configured read gaps are waited locally, write gaps are returned to the common queue.
    const previous=this.httpQueue;let release,entered=false;this.httpQueue=new Promise(resolve=>{release=resolve})
    try{
      await abortableRun(previous,scope);entered=true;assertRunActive(scope)
      if(!write)await this._waitReadGap()
      if(write&&continuation){const quota=this.store.getDocument('quota:bilibili:write:'+shanghaiTime(this._now()).date)?.value,gap=(this._settings().config.risk?.write_gap_ms??60000)-(this._now()-(quota?.last_action_at??0));if(quota&&gap>0&&gap<=60000)await abortableRun(wait(gap,undefined,{signal:scope?.signal}),scope)}
      assertRunActive(scope)
      this._reserve(write?'write':'read',{coin,is_reply:write&&is_reply})
      if(write){if(typeof onWrite!=='function')throw new BilibiliError('网络写入缺少原生动作回调',{code:'missing_write_lease'});await abortableRun(onWrite(),scope)}
      assertRunActive(scope)
      const site=target.hostname==='api.live.bilibili.com'?'https://live.bilibili.com':target.hostname==='api.vc.bilibili.com'?'https://message.bilibili.com':target.pathname==='/x/dynamic/feed/create/dyn'?'https://t.bilibili.com':'https://www.bilibili.com'
      const headers={'user-agent':UA,referer:site+'/',...(cred&&!cdn?{cookie:cookieOf(cred)}:{}),...(write?{origin:site,...(content_type?{'content-type':content_type}:{})}:{})}
      const timeout=AbortSignal.timeout(30000),signal=scope?.signal?AbortSignal.any([scope.signal,timeout]):timeout
      const response=await abortableRun(this.fetcher(target.href,{method,headers,...(body===undefined?{}:{body}),redirect:'error',signal}),scope)
      assertRunActive(scope)
      if(!write)this._cachePut('network','last-read',{at:this._now()},3600000)
      else this._saveState({last_write_at:this._now()})
      let payload
      try{payload=exactJson((await abortableRun(boundedBody(response,maxBytes),scope)).toString('utf8'))}catch(error){assertRunActive(scope);this._pause({http_status:response.status,server_code:null,write});if(error instanceof BilibiliError)throw error;throw new BilibiliError('B站响应无法核验',{code:'invalid_response',http_status:response.status})}
      assertRunActive(scope)
      if(!isPlainObject(payload))throw new BilibiliError('B站响应结构无效',{code:'invalid_response',http_status:response.status})
      const server_code=typeof payload.code==='number'?payload.code:null;this._pause({http_status:response.status,server_code,write})
      return {response,payload,server_code}
    }finally{if(entered)release();else previous.then(release,release)}
  }
  async _get(path,params={},options={}){
    this._checkEnabled()
    const cred=options.cred??await this._credential(options.auth!==false),scope=this._scope(cred),cacheKey=scope+':'+path+':'+encode(params)
    if(options.ttl&&!options.force){const hit=this._cacheGet('http',cacheKey);if(hit)return {...hit,cached:true}}
    let query=new URLSearchParams(Object.entries(params).map(([key,value])=>[key,String(value)])).toString()
    if(options.signed){const nav=await this._nav(cred);query=signedWbi(params,nav.wbi_img,this._now())}
    const {response,payload}=await this._http((options.host??HOST)+path+(query?'?'+query:''),{cred,maxBytes:options.maxBytes})
    if(!response.ok||payload.code!==0)throw new BilibiliError('B站读取未完成（HTTP '+response.status+'，code='+String(payload.code??'unknown')+'）',{code:BILIBILI_RISK_CODES.has(payload.code)?'risk_pause':'read_failed',http_status:response.status,server_code:payload.code})
    const output={data:payload.data??{},cached:false};if(options.ttl)this._cachePut('http',cacheKey,output,options.ttl);return output
  }
  async _mediaFetch(input,options={}){
    const scope=currentRunScope();assertRunActive(scope)
    if(options.method&&options.method!=='GET')throw new BilibiliError('资源读取器不能进行网络写入',{code:'invalid_input'})
    const url=trustedBiliUrl(input,{cdn:true}),previous=this.httpQueue;let release,entered=false;this.httpQueue=new Promise(resolve=>{release=resolve})
    try{
      await abortableRun(previous,scope);entered=true;assertRunActive(scope)
      this._checkEnabled();await this._waitReadGap();assertRunActive(scope);this._reserve('read')
      const signals=[AbortSignal.timeout(120000),scope?.signal,options.signal].filter(Boolean),signal=signals.length===1?signals[0]:AbortSignal.any(signals)
      const response=await abortableRun(this.fetcher(url.href,{method:'GET',headers:{'user-agent':UA,referer:'https://www.bilibili.com/',...(typeof options.headers?.range==='string'&&/^bytes=\d+-\d*$/.test(options.headers.range)?{range:options.headers.range}:{})},redirect:'error',signal}),scope)
      assertRunActive(scope);this._cachePut('network','last-read',{at:this._now()},3600000);this._pause({http_status:response.status,server_code:null,write:false});return response
    }finally{if(entered)release();else previous.then(release,release)}
  }
  async _nav(cred,{fresh=false}={}){return (await this._get('/x/web-interface/nav',{}, {cred,auth:false,ttl:600000,force:fresh})).data}
  async _source({kind='read',body,ref='',actor_uid='',source_id='',session_id='',conversation_id='',visibility='public'}){
    assertRunActive()
    const value=text(body,2*1024*1024),ids=[];let asset_id=null
    if(this.assets?.put){const asset=await this.assets.put({kind:'source',bytes:Buffer.from(value),media_type:'text/plain',source_ref:ref,visibility,manifest:{schema_version:1,platform:'bilibili',conversation_id,source_kind:kind,trust:'untrusted_source'}});asset_id=asset?.id??asset?.asset_id??null}
    assertRunActive();const enabled=this.store.getDocument('settings')?.value.memory?.enabled!==false
    for(let offset=0;offset<value.length&&enabled;offset+=60000){assertRunActive();const input={platform:'bilibili',session_id,conversation_id,kind,text:value.slice(offset,offset+60000),ref,actor_uid,source_message_id:source_id+':'+sha(value)+':'+offset,source_at:this._now(),visibility};let saved
      if(this.memoryRuntime)saved=await this.memoryRuntime.ingestSourceRead(input)
      else{const{session_id:unused,...record}=input;saved=this.memory.recordEvidence({...record,direction:'observation',source_type:'platform',source:{kind:'platform_read',explicit:true,pipeline:'native-bilibili'}})}
      assertRunActive();if(saved?.id)ids.push(saved.id)
    }
    return {asset_id,evidence_ids:ids.slice(0,3),evidence_count:ids.length}
  }
  async _observeLearning({evidence_ids,ref,title='',kind}){assertRunActive();if(!this.learning?.observeRead||!evidence_ids?.length)return;try{await this.learning.observeRead({evidence_ids,ref,title},{producer:'native_platform_reader',platform:'bilibili',read_kind:kind,selected:true,depth:'deep',visibility:'public'});assertRunActive()}catch{assertRunActive();/* A failed projection never retries the platform request. */}}
  async _inferenceSource({body,ref,source_id,session_id=''}){
    assertRunActive()
    text(body,2*1024*1024);const ids=[],asset=this.assets?.put?await this.assets.put({kind:'source',bytes:Buffer.from(body),media_type:'text/plain',source_ref:ref,visibility:'owner',manifest:{schema_version:1,platform:'bilibili',producer_kind:'trusted-native-transcription',source_type:'model',source_kind:'inference',uncertain:true}}):null
    assertRunActive();const memory=this.memoryRuntime?.memory??this.memory,enabled=this.store.getDocument('settings')?.value.memory?.enabled!==false&&(this.memoryRuntime?this.memoryRuntime.enabled():true)
    if(enabled)for(let offset=0;offset<body.length;offset+=60000){assertRunActive();const value=memory.recordEvidence({platform:'bilibili',conversation_id:'',actor_uid:'',direction:'observation',kind:'read',text:body.slice(offset,offset+60000),ref,source_message_id:source_id+':'+sha(body)+':'+offset,source_at:this._now(),source_type:'model',visibility:'owner',source:{kind:'inference',uncertain:true,explicit:false,pipeline:'trusted-native-transcription'}});ids.push(value.id);if(!value.duplicate)this.store.appendJournalEvent({event_key:'bilibili:asr-source:'+value.id,event_type:'log',platform:'bilibili',direction:'observation',visibility:'owner',text:'自动转写候选；不作为准确台词证据。',ref,source_at:this._now(),source_type:'native_bilibili',metadata:{subtype:'transcription_candidate',evidence_id:value.id,session_id,uncertain:true}})}
    return {asset_id:asset?.id??asset?.asset_id??null,evidence_ids:ids.slice(0,3),evidence_count:ids.length}
  }
  async status({refresh=false}={}){
    const settings=this._settings(),state=this._state().value,cred=await this._credential(false);let account=null,previously_verified=false
    if(refresh){const nav=await this._nav(cred,{fresh:true});if(nav.isLogin===true)account={mid:biliId(nav.mid),name:cleanSourceText(nav.uname,200)}}
    else{const key=this._scope(cred)+':/x/web-interface/nav:{}',cached=this._cacheGet('http',key),nav=cached?.data;if(nav?.isLogin===true)account={mid:biliId(nav.mid),name:cleanSourceText(nav.uname,200)};else if(!cached&&cred){const old=this._cacheGet('http',key,{stale:true});if(old?.data?.isLogin===true)try{this._assertAccount(old.data);previously_verified=true}catch{}}}
    let mismatch=false;if(account)try{this._assertAccount({isLogin:true,mid:account.mid})}catch{mismatch=true}
    const verifying=state.verification_required===true,paused=state.paused_until>this._now(),read_budget=this.readAvailability(),inbox_health=this._cacheGet('inbox-health',this._accountKey())
    return {platform:'bilibili',enabled:settings.value.enabled===true,authenticated:!!account&&!mismatch,account,previously_verified,credential_configured:!!cred,status:mismatch?'account_mismatch':verifying?'verification_required':paused?'paused':cred&&!read_budget.allowed?'quota_exhausted':inbox_health?.status==='error'?'inbox_error':inbox_health?.status==='partial'?'inbox_partial':account?'ready':previously_verified?'verification_stale':cred?'登录态已配置，尚待验证':'需要登录',reason:mismatch?'凭据账号与原生绑定不一致，请重新登录核对':verifying||paused?state.verification_reason??'':!read_budget.allowed?read_budget.message:inbox_health?.status==='error'?'最近收件检查失败：'+inbox_health.message:inbox_health?.status==='partial'?'评论与其他通道分别检查；'+inbox_health.channel_errors.map(x=>({dm:'私信',live:'直播弹幕'}[x.channel]??x.channel)+'：'+x.message).join('；'):'',inbox_health,read_budget,last_successful_poll_at:state.last_poll_at??null,paused_until:state.paused_until??null,live:this.liveConnection?{status:this.liveConnection.public.status,room_id:this.liveConnection.room.room_id}:null,model_calls:0}
  }
  async feed({mode='recommend',page=1,limit=10}={}){
    positive(page,1000);positive(limit,40)
    const routes={recommend:['/x/web-interface/wbi/index/top/feed/rcmd',{fresh_type:3,ps:limit,fresh_idx:page},true],popular:['/x/web-interface/popular',{pn:page,ps:limit}],ranking:['/x/web-interface/ranking/v2',{rid:0,type:'all'}],following:['/x/polymer/web-dynamic/v1/feed/all',{type:'video',page}]}
    if(!routes[mode])throw new BilibiliError('推荐来源无效',{code:'invalid_input'})
    const[path,params,signed]=routes[mode],{data}=await this._get(path,params,{signed})
    const rows=data.item??data.list??data.items??[],items=[]
    for(const row of rows){const archive=row.modules?.module_dynamic?.major?.archive??row,author=row.modules?.module_author??archive.owner??{};if(!archive.bvid)continue;items.push({bvid:bvidOf(archive.bvid),title:cleanSourceText(archive.title,180),author:cleanSourceText(author.name??row.author,80),author_uid:structuredMentionUids([author.mid??author.uid])[0]??null,duration:archive.duration??archive.duration_text??'',seen:this.seen(archive.bvid)})}
    return {items:items.slice(0,limit),page,source:mode,source_context:publicSourceContext({platform:'bilibili',source_kind:'video_list',self_uid:accountSourceUid(this.store,'bilibili',this._settings().value.account_entity_id)}),untrusted:true}
  }
  async browse({mode='recommend',page=1,session_id='',round_id=''}={}){
    assertRunActive()
    positive(page,1000);this.rounds.begin(round_id);const before=this.rounds.state(round_id),wanted=Math.min(30,Math.max(0,before.limit-before.used)),reply_limit=this.rounds.limits(round_id).reply
    const attempts=new Set(before.ids),attempt_limit=before.attempt_limit;let comment_budget=this._settings().config.interaction?.comment_sample_size??6
    if(!wanted||attempts.size>=attempt_limit)return{items:[],configured_limit:before.limit,opened:before.ids.length,remaining:wanted,reply_limit,retry_exhausted:wanted>0,model_calls:0}
    const items=[],errors=[]
    for(let next=page;next<=Math.min(1000,page+1)&&items.length<wanted&&attempts.size<attempt_limit;next++){
      assertRunActive()
      const feed=await this.feed({mode,page:next,limit:Math.min(40,Math.max(wanted*2,5))}),candidates=feed.items.filter(row=>!attempts.has(row.bvid)).sort((a,b)=>Number(a.seen)-Number(b.seen))
      for(const candidate of candidates){
        assertRunActive()
        if(items.length>=wanted||attempts.size>=attempt_limit)break
        if(attempts.has(candidate.bvid))continue
        attempts.add(candidate.bvid)
        try{const value=await this.watch({bvid:candidate.bvid,session_id,round_id}),content=value.content??{},comment_context=comment_budget>0?await this._browseCommentContext(value,{session_id,round_id,sample_limit:Math.ceil(comment_budget/(wanted-items.length))}):null;comment_budget-=comment_context?.candidates?.length??0;items.push({bvid:value.bvid,aid:value.aid,title:value.title,description:String(value.description??'').slice(0,240),duration:value.duration,source_context:value.source_context,content_context:content.source_context,content_available:content.available===true||!!content.asset_ids?.length,content_kind:content.asset_ids?.length?'sampled_frames':content.transcription?'unverified_transcription':content.available?'subtitles':'metadata_only',text:typeof content.text==='string'?content.text.slice(0,1000):'',asset_refs:content.asset_ids??[],evidence_ids:content.evidence_ids??[],source_ref:'https://www.bilibili.com/video/'+value.bvid,full_video_watched:false,transcription_unverified:content.transcription===true,...(comment_context?{comment_context}:{})})}
        catch(error){assertRunActive();if(['verification_required','risk_pause','round_read_limit','round_read_attempt_limit','daily_limit','hourly_limit','minimum_gap','authentication_required','account_mismatch','permission_denied','disabled','closed'].includes(error.code))throw error;const code=error instanceof BilibiliError?error.code:'read_failed';this.rounds.recordFailed(candidate.bvid,round_id,code);errors.push({bvid:candidate.bvid,code})}
      }
    }
    const after=this.rounds.state(round_id),opened=round_id?after.ids.length:attempts.size
    return {items,errors,configured_limit:before.limit,opened,remaining:Math.max(0,before.limit-(round_id?after.used:items.length)),reply_limit,retry_exhausted:attempts.size>=attempt_limit&&items.length<wanted,page,model_calls:0}
  }
  async _browseCommentContext(video,{session_id='',round_id='',sample_limit}={}){
    const cfg=this._settings().config
    if(cfg.interaction?.reply_to_comments!==true||cfg.permissions?.comment!==true||this.rounds.limits(round_id).reply===0)return null
    const limit=Math.min(10,Math.max(1,Math.min(cfg.interaction.comment_sample_size??6,sample_limit??10)))
    try{
      const sample=await this.comments({oid:video.aid,type:'1',limit:Math.min(20,limit*2),sort:'time',session_id}),nav=await this._nav(await this._credential());this._assertAccount(nav);const self=biliId(nav.mid),ids=new Set(),candidates=[]
      for(const row of sample.items){
        if(row.uid===self||ids.has(row.rpid)||!row.text.trim())continue
        const handled=this.store.db.prepare("SELECT 1 FROM actions WHERE platform='bilibili' AND kind IN ('bilibili.reply','bilibili.comment') AND json_extract(target_json,'$.object_id')=? AND json_extract(target_json,'$.parent_reply_id')=? AND status IN ('draft','queued','leased','submitting','submitted','confirmed','unknown') LIMIT 1").get(video.aid,row.rpid)
        if(handled)continue
        ids.add(row.rpid);candidates.push({comment_id:row.rpid,author:row.name,author_uid:row.uid,attribution:row.attribution,text:row.text.slice(0,280),text_truncated:(row.total_chars??row.text.length)>Math.min(row.text.length,280),target:{object_id:video.aid,object_type:'1',root_reply_id:row.root!=='0'?row.root:row.rpid,parent_reply_id:row.rpid}})
        if(candidates.length>=limit)break
      }
      return {available:true,candidates,evidence_ids:sample.evidence_ids??[],reading_claim:'selected_comment_text',model_calls:0}
    }catch(error){assertRunActive();if(['verification_required','risk_pause','daily_limit','hourly_limit','disabled','closed','authentication_required','account_mismatch'].includes(error.code))throw error;return {available:false,candidates:[],reason:error instanceof BilibiliError?error.code:'read_failed',model_calls:0}}
  }
  async search({query,page=1,limit=10}={}){
    text(query,300);if(!query.trim())throw new BilibiliError('搜索词不能为空',{code:'invalid_input'});positive(page,1000);positive(limit,40)
    const{data}=await this._get('/x/web-interface/wbi/search/type',{search_type:'video',keyword:query,page,page_size:limit},{signed:true})
    return {items:(data.result??data.results??[]).slice(0,limit).map(row=>({bvid:bvidOf(row.bvid),title:cleanSourceText(row.title,180),author:cleanSourceText(row.author,80),author_uid:structuredMentionUids([row.mid])[0]??null,description:cleanSourceText(row.description,240),duration:row.duration??'',seen:this.seen(row.bvid)})),page,source_context:publicSourceContext({platform:'bilibili',source_kind:'search_results',self_uid:accountSourceUid(this.store,'bilibili',this._settings().value.account_entity_id)}),untrusted:true}
  }
  async video({bvid,record=true,session_id='',offset=0,max_chars=1200,round_id=''}={}){
    assertRunActive()
    bvid=bvidOf(bvid);if(record)this.rounds.reserve(bvid,round_id);const {data,cached}=await this._get('/x/web-interface/wbi/view',{bvid},{signed:true,ttl:86400000})
    const item={bvid,aid:biliId(data.aid),cid:biliId(data.cid),title:text(String(data.title??''),4000),description:text(String(data.desc??''),64000),duration:Number(data.duration??0),owner:{uid:biliId(data.owner?.mid),name:cleanSourceText(data.owner?.name,200)},cached}
    const sources=record?await this._source({body:item.title+'\n'+item.description,ref:'https://www.bilibili.com/video/'+bvid,actor_uid:item.owner.uid,source_id:'video:'+bvid,session_id}):{},description=pageText(item.description,{offset,max_chars})
    return {...item,source_context:publicSourceContext({platform:'bilibili',source_kind:'video_description',self_uid:accountSourceUid(this.store,'bilibili',this._settings().value.account_entity_id),author_uid:item.owner.uid,topic_author_uid:item.owner.uid}),title:item.title.slice(0,500),description:description.text,description_total_chars:description.total_chars,next_offset:description.next_offset,...sources,untrusted:true}
  }
  async subtitles({bvid,language='ai-zh',offset=0,max_chars=1800,session_id='',round_id=''}={}){
    assertRunActive()
    bvid=bvidOf(bvid);this.rounds.reserve(bvid,round_id);const scope=this._scope(await this._credential()),cache=this._cacheGet('subtitle',scope+':'+bvid+':'+language)
    if(cache){await this._observeLearning({evidence_ids:cache.evidence_ids,ref:'https://www.bilibili.com/video/'+bvid,kind:'subtitle'});return {available:true,bvid,source_context:cache.source_context??publicSourceContext({platform:'bilibili',source_kind:'video_subtitles',self_uid:accountSourceUid(this.store,'bilibili',this._settings().value.account_entity_id)}),language:cache.language,line_count:cache.lines.length,...pageText(cache.body,{offset,max_chars}),asset_id:cache.asset_id??null,evidence_ids:cache.evidence_ids??[],cached:true,untrusted:true}}
    const video=await this.video({bvid,record:false}),primary=await this._get('/x/player/wbi/v2',{bvid:video.bvid,cid:video.cid},{signed:true});let tracks=primary.data.subtitle?.subtitles??[]
    if(!tracks.length){const extra=await this._get('/x/v2/subtitle/web/view',{oid:video.aid,pid:video.aid,context_ext:JSON.stringify({video_type:1}),type:1,cur_production_type:0,preferred_language:language,playlist_switch:0});tracks=extra.data.subtitle?.subtitles??[]}
    const track=tracks.find(row=>row.lan===language)??tracks.find(row=>String(row.lan).startsWith('zh'))??tracks[0]
    if(!track)return {available:false,bvid:video.bvid,reason:'没有可用官方字幕',model_calls:0}
    const{response,payload}=await this._http(trustedBiliUrl(track.subtitle_url,{cdn:true}),{cdn:true});if(!response.ok||!Array.isArray(payload.body))throw new BilibiliError('字幕内容无法核验',{code:'invalid_subtitles'})
    const lines=payload.body.map(row=>({from:Number(row.from),to:Number(row.to),text:text(String(row.content??''),64000)})),body=lines.map(row=>row.text).join('\n'),stored=await this._source({body,kind:'read',ref:'https://www.bilibili.com/video/'+video.bvid,actor_uid:video.owner.uid,source_id:'subtitle:'+video.bvid+':'+track.lan,session_id})
    this._cachePut('subtitle',scope+':'+video.bvid+':'+language,{bvid:video.bvid,language:String(track.lan),lines,body,source_context:publicSourceContext({platform:'bilibili',source_kind:'video_subtitles',self_uid:accountSourceUid(this.store,'bilibili',this._settings().value.account_entity_id),topic_author_uid:video.owner.uid}),...stored},86400000)
    await this._observeLearning({evidence_ids:stored.evidence_ids,ref:'https://www.bilibili.com/video/'+video.bvid,title:video.title,kind:'subtitle'})
    return {available:true,bvid:video.bvid,source_context:publicSourceContext({platform:'bilibili',source_kind:'video_subtitles',self_uid:accountSourceUid(this.store,'bilibili',this._settings().value.account_entity_id),topic_author_uid:video.owner.uid}),language:String(track.lan),line_count:lines.length,...pageText(body,{offset,max_chars}),...stored,untrusted:true}
  }
  async _commentsPage({bvid,oid,type='1',page=1,limit=20,sort='hot'}={}){
    if(!oid){if(!bvid)throw new BilibiliError('需要视频或精确评论区坐标',{code:'invalid_target'});oid=(await this.video({bvid,record:false})).aid}oid=biliId(oid);type=biliId(type);positive(page,10000);positive(limit,50)
    if(!['hot','time'].includes(sort))throw new BilibiliError('评论排序只能为hot或time',{code:'invalid_input'})
    // The owning /x/v2/reply API uses sort=2 for heat and sort=0 for time.
    // /reply/main mode=3 is not an equivalent time-sort selector.
    const{data}=await this._get('/x/v2/reply',{type,oid,pn:page,ps:limit,sort:sort==='hot'?2:0}),items=this._replies(data.replies??[])
    return {oid,type,page,sort,items}
  }
  async comments({bvid,oid,type='1',page=1,limit=20,sort='hot',record=true,session_id=''}={}){
    const result=await this._commentsPage({bvid,oid,type,page,limit,sort});oid=result.oid;type=result.type
    const items=result.items,source={platform:'bilibili',source_kind:'comment',self_uid:accountSourceUid(this.store,'bilibili',this._settings().value.account_entity_id)},stored=record&&items.length?await this._source({body:renderPublicSource(items,source),kind:'read',ref:'bilibili:comments:'+type+':'+oid,source_id:'comments:'+oid+':'+sort+':'+page,session_id}):{}
    if(record)await this._observeLearning({evidence_ids:stored.evidence_ids,ref:'bilibili:comments:'+type+':'+oid,kind:'thread'})
    return {oid,type,page,sort,source_context:publicSourceContext(source),items:this._compactReplies(items,source),...stored,untrusted:true}
  }
  async shareCommentSample({bvid,limit=20,session_id=''}={}){
    bvid=bvidOf(bvid);if(![20,40].includes(limit))throw new BilibiliError('评论检查仅采20或40条',{code:'invalid_input'})
    const batches=[],scope=this._accountKey();let oid
    for(const sort of ['hot','time']){
      let batch=this._cacheGet('share_comments',scope+':'+bvid+':'+sort)
      if(!batch){
        if(!oid)oid=(await this.video({bvid,record:false})).aid
        const page=await this._commentsPage({oid,sort,limit:20}),items=page.items,stored=items.length?await this._source({body:renderPublicSource(items,{platform:'bilibili',source_kind:'comment_sample',self_uid:accountSourceUid(this.store,'bilibili',this._settings().value.account_entity_id)}),kind:'read',ref:'bilibili:comments:1:'+oid,source_id:'share-comments:'+bvid+':'+sort,session_id}):{}
        batch={oid,sort,sampled_at:this._now(),items:items.map(row=>({id:row.rpid,author_uid:row.uid,reply_to_comment_id:row.parent,mentioned_uids:row.mention_uids,text:row.text.trim().slice(0,400)})),evidence_ids:stored.evidence_ids??[]};this._cachePut('share_comments',scope+':'+bvid+':'+sort,batch,6*3600000)
      }
      oid??=batch.oid;if(batch.oid!==oid)throw new BilibiliError('热评与最新评论所属视频不一致，未生成检查样本',{code:'invalid_response'});batches.push(batch)
    }
    const seen=new Set(),rows=[]
    for(let index=0;index<20;index++)for(const batch of batches){const row=batch.items[index];if(!row||!row.text||seen.has(row.id)||rows.length>=limit)continue;seen.add(row.id);rows.push(row)}
    return {bvid,object_id:oid,source_context:publicSourceContext({platform:'bilibili',source_kind:'comment_sample',self_uid:accountSourceUid(this.store,'bilibili',this._settings().value.account_entity_id)}),rows,limit,sampled_at:Math.min(...batches.map(batch=>batch.sampled_at)),sampling:'hot_time_interleaved',evidence_ids:[...new Set(batches.flatMap(batch=>batch.evidence_ids))],untrusted:true,model_calls:0}
  }
  _replies(rows){return rows.map(row=>({rpid:biliId(row.rpid_str??row.rpid),uid:biliId(row.mid??row.member?.mid),name:cleanSourceText(row.member?.uname,200),root:biliId(row.root_str??row.root??'0',{zero:true}),parent:biliId(row.parent_str??row.parent??'0',{zero:true}),text:text(String(row.content?.message??''),64000),mention_uids:structuredMentionUids(row.content?.members),ctime:Number(row.ctime??0),likes:row.like??0}))}
  _compactReplies(rows,source={platform:'bilibili',source_kind:'comment',self_uid:accountSourceUid(this.store,'bilibili',this._settings().value.account_entity_id)}){const budget=Math.min(1000,Math.max(1,Math.floor(3000/Math.max(1,rows.length))));return attributePublicRows(rows,source).map(row=>({...row,name:row.name.slice(0,80),text:row.text.slice(0,budget),total_chars:row.text.length}))}
  async _thread({oid,type='1',root,page=1,limit=20}={}){oid=biliId(oid);root=biliId(root);type=biliId(type);positive(page,10000);positive(limit,50);const{data}=await this._get('/x/v2/reply/reply',{oid,type,root,pn:page,ps:limit});return {oid,type,root,page,root_comment:data.root?this._replies([data.root])[0]:null,items:this._replies(data.replies??[]),untrusted:true}}
  async thread(input={}){
    const result=await this._thread(input),full=[result.root_comment,...result.items].filter(Boolean),source={platform:'bilibili',source_kind:'comment_thread',self_uid:accountSourceUid(this.store,'bilibili',this._settings().value.account_entity_id),parent_author_uid:result.root_comment?.uid},ref='bilibili:thread:'+result.type+':'+result.oid+':'+result.root,stored=full.length?await this._source({body:renderPublicSource(full,source),ref,source_id:'thread:'+result.oid+':'+result.root+':'+result.page,session_id:input.session_id??''}):{},compact=this._compactReplies(full,source)
    await this._observeLearning({evidence_ids:stored.evidence_ids,ref,kind:'thread'});return {...result,source_context:publicSourceContext(source),root_comment:result.root_comment?compact.shift():null,items:compact,...stored}
  }

  seen(bvid){bvid=bvidOf(bvid);return !!this.store.db.prepare("SELECT id FROM journal_events WHERE platform='bilibili' AND json_extract(metadata_json,'$.subtype') IN ('video_watch','video_seen_marker') AND ref=? LIMIT 1").get(bvid)}
  async _runResource(input){
    const scope=currentRunScope();assertRunActive(scope)
    // NativeResources accepts a trusted signal. Its final canvas/asset stage
    // also needs a guard, because that stage can follow the cancellable child.
    const assets=this.assets&&scope?new Proxy(this.assets,{get(target,key){const value=Reflect.get(target,key,target);return typeof value==='function'?(...args)=>{assertRunActive(scope);return Reflect.apply(value,target,args)}:value}}):this.assets
    const output=await abortableRun(this.resourceRunner({...input,assets,signal:scope?.signal,fetcher:(url,options)=>withRunScope(scope,()=>this._mediaFetch(url,options))}),scope)
    assertRunActive(scope);return output
  }
  async _sampleFrames(video,{grid}){
    assertRunActive()
    if(!this.resourceRunner||!this.assets?.read)throw new BilibiliError('原生取帧或图像资产资源尚未接入',{code:'resource_unavailable'})
    const player=await this._get('/x/player/wbi/playurl',{bvid:video.bvid,cid:video.cid,qn:80,fnval:1,platform:'pc',high_quality:1},{signed:true}),segment=player.data.durl?.[0]
    let media;for(const candidate of [segment?.url,...(Array.isArray(segment?.backup_url)?segment.backup_url:[])])try{media=trustedBiliUrl(candidate,{cdn:true});break}catch(error){if(!(error instanceof BilibiliError)||error.code!=='invalid_remote_url')throw error}
    if(!media)throw new BilibiliError('官方播放响应没有既有信任域内的媒体地址，未放宽域名校验',{code:'resource_unavailable'})
    const output=await this._runResource({operation:'bilibili.frames',bvid:video.bvid,url:media.href,grid,duration:video.duration,max_bytes:256*1024*1024})
    if(!Array.isArray(output?.asset_ids)||!output.asset_ids.length||output.asset_ids.length>16)throw new BilibiliError('取帧资源未返回原生图像资产',{code:'resource_unavailable'})
    const count=Number(grid[0])*Number(grid[2]),ref='https://www.bilibili.com/video/'+video.bvid,asset_ids=[...new Set(output.asset_ids)]
    for(const id of asset_ids){
      assertRunActive()
      let asset;try{asset=await this.assets.read(id)}catch{throw new BilibiliError('取帧图像未登记或完整性校验失败',{code:'resource_unavailable'})}
      const provenance=registration=>registration?.source_ref===ref&&registration.manifest?.platform==='bilibili'&&registration.manifest?.source_kind==='sampled_video_frames'&&registration.manifest?.sample_count===count&&registration.manifest?.full_video_view_claim===false
      if(asset?.id!==id||!/^image\//.test(asset?.media_type??'')||!(asset.bytes instanceof Uint8Array)||!asset.bytes.length||!((asset.manifest?.registrations??[]).some(provenance)||provenance({source_ref:asset.source_ref,manifest:asset.manifest})))throw new BilibiliError('取帧资产缺少当前视频的真实抽样来源，未记为已观看',{code:'resource_unavailable'})
    }
    return {available:true,source_context:publicSourceContext({platform:'bilibili',source_kind:'video_frames',self_uid:accountSourceUid(this.store,'bilibili',this._settings().value.account_entity_id),topic_author_uid:video.owner?.uid}),asset_ids,sample_count:count,sampled_frames:true,transcription:false,full_video_view_claim:false,model_calls:0,note:'仅取得抽样画面，未获得转写，未声称看完整个视频。'}
  }
  async watch({bvid,mode='auto',grid='3x3',session_id='',round_id=''}={}){
    assertRunActive()
    if(!['auto','subtitles','frames'].includes(mode)||!/^([1-4])x([1-4])$/.test(grid))throw new BilibiliError('观看方式或取帧网格无效',{code:'invalid_input'})
    this.rounds.reserve(bvidOf(bvid),round_id);const video=await this.video({bvid,session_id});let content=mode==='frames'?null:await this.subtitles({bvid:video.bvid,session_id}),asr
    if(mode==='auto'&&!content?.available){
      if(this._settings().config.transcription?.enabled&&this.resourceRunner){
        try{content={...await this.transcribe({bvid:video.bvid,session_id}),available:true};asr={status:'completed',verified:false}}
        catch(error){assertRunActive();if(!resourceFailure(error))throw error;asr={status:'not_completed',reason:'本地转写资源未就绪或处理未完成；尝试只读取抽样画面。'}}
      }else asr={status:'not_completed',reason:'本地转写未启用或资源未接入；尝试只读取抽样画面。'}
    }
    if((!content?.available||mode==='frames')&&mode!=='subtitles'){
      try{content=await this._sampleFrames(video,{grid})}catch(error){assertRunActive();if(!resourceFailure(error))throw error;return {...video,available:false,reason:'无可用字幕或转写，抽样画面也未成功登记；未新增观看记录。',...(asr?{asr}:{}),seen:this.seen(video.bvid)}}
    }
    if(!content?.available&&!content?.asset_ids?.length)return {...video,...content,seen:this.seen(video.bvid)}
    assertRunActive();const watch_id='bilibili:watch:'+randomUUID();this.store.appendJournalEvent({event_key:watch_id,event_type:'platform_read',platform:'bilibili',direction:'observation',visibility:'owner',text:video.title,ref:video.bvid,source_at:this._now(),source_type:'native_bilibili',metadata:{subtype:'video_watch',mode:content.transcription?'transcription':content.asset_ids?'frames':'subtitles',evidence_ids:content.evidence_ids??[],asset_ids:content.asset_ids??(content.asset_id?[content.asset_id]:[]),...(content.sampled_frames?{sampled_frames:true,sample_count:content.sample_count}:{}),...(asr?{asr_status:asr.status}:{}),full_video_view_claim:false,transcription_unverified:content.transcription===true}})
    return {...video,content,...(asr?{asr}:{}),seen:true,watch_id}
  }
  async transcribe({bvid,session_id='',round_id=''}={}){assertRunActive();this.rounds.reserve(bvidOf(bvid),round_id);if(!this._settings().config.transcription?.enabled||!this.resourceRunner)throw new BilibiliError('原生本地转写未启用或资源未接入',{code:'resource_unavailable'});const video=await this.video({bvid,record:false}),player=await this._get('/x/player/wbi/playurl',{bvid:video.bvid,cid:video.cid,fnval:16},{signed:true}),url=trustedBiliUrl(player.data.dash?.audio?.[0]?.baseUrl??player.data.durl?.[0]?.url,{cdn:true});const output=await this._runResource({operation:'bilibili.asr',url:url.href,bvid:video.bvid,model:this._settings().config.transcription.model??'small',max_bytes:128*1024*1024});if(typeof output?.text!=='string'||!output.text.trim())throw new BilibiliError('自动转写没有产生可用文本',{code:'resource_unavailable'});const body=text(output.text,2*1024*1024),stored=await this._inferenceSource({body,source_id:'asr:'+video.bvid,ref:'https://www.bilibili.com/video/'+video.bvid,session_id});return {bvid:video.bvid,source_context:publicSourceContext({platform:'bilibili',source_kind:'video_transcript',self_uid:accountSourceUid(this.store,'bilibili',this._settings().value.account_entity_id),topic_author_uid:video.owner.uid}),...pageText(body),...stored,untrusted:true,transcription:true,uncertain:true,source_type:'model',note:'自动转写候选，不等于原视频准确台词。'}}
  async stickers({limit=20,query=''}={}){positive(limit,100);const rows=this.store.db.prepare("SELECT id,kind,media_type,CAST(manifest_json AS BLOB) AS manifest FROM assets WHERE kind IN ('sticker','image') ORDER BY created_at DESC LIMIT 1000").all();return {items:rows.map(row=>({...row,manifest:JSON.parse(Buffer.from(row.manifest).toString('utf8'))})).filter(row=>row.kind==='sticker'||row.manifest.collection==='shared_stickers'||row.manifest.catalog_entries?.some(entry=>entry.collection==='shared_stickers')).map(row=>{const catalog=row.manifest.catalog_entries?.find(entry=>entry.collection==='shared_stickers'||entry.kind==='sticker')??row.manifest;return{id:row.id,media_type:row.media_type,name:cleanSourceText(catalog.display_name??catalog.name??row.id,120),description:cleanSourceText(catalog.description??catalog.note,180),tags:(catalog.tags??[]).map(tag=>cleanSourceText(tag,40)).slice(0,12)}}).filter(row=>!query||(row.name+' '+row.description+' '+row.tags.join(' ')).includes(query)).slice(0,limit)}}
  async emotes(){const{data}=await this._get('/x/emote/user/panel/web',{business:'reply'});return {items:(data.packages??[]).flatMap(pack=>(pack.emote??[]).map(item=>({id:biliId(item.id),text:cleanSourceText(item.text,120),url:trustedBiliUrl(item.url,{cdn:true}).href}))).slice(0,120),untrusted:true}}
  async _resolveInbox(item,{threads=new Map(),self_uid=accountSourceUid(this.store,'bilibili',this._settings().value.account_entity_id)}={}){
    const business=String(item.item?.business_id??'1'),type=['11','17'].includes(business)?business:'1',oid=biliId(item.item?.subject_id),parent=biliId(item.item?.source_id),root=biliId(item.item?.root_id??parent,{zero:true}),uid=biliId(item.user?.mid),thread=root==='0'?parent:root,time=Number(item.reply_time??item.at_time??0)
    const threadKey=type+':'+oid+':'+thread
    if(!threads.has(threadKey))threads.set(threadKey,(async()=>{
      const candidates=[];let thread_complete=false
      for(let page=1;page<=30;page++){const result=await this._thread({type,oid,root:thread,page,limit:20});if(result.root_comment)candidates.push(result.root_comment);candidates.push(...result.items);if(result.items.length<20){thread_complete=true;break}}
      return {candidates,thread_complete}
    })())
    let snapshot;try{snapshot=await threads.get(threadKey)}catch(error){threads.delete(threadKey);throw error}
    const {candidates,thread_complete}=snapshot
    let exact=candidates.find(row=>row.uid===uid&&row.rpid===parent)
    if(!exact&&time){const alternatives=candidates.filter(row=>row.uid===uid&&row.parent===parent&&row.ctime===time);if(alternatives.length===1)exact=alternatives[0]}
    if(!exact)return null
    const parentId=exact.parent!=='0'?exact.parent:exact.root!=='0'?exact.root:'',parentRow=candidates.find(row=>row.rpid===parentId);let topic_author_uid=''
    if(!parentId&&self_uid&&!(exact.mention_uids??[]).includes(self_uid)&&['1','11','17'].includes(type)){
      const ownerKey=this._accountKey()+':'+type+':'+oid,cached=this._cacheGet('source-owner',ownerKey)
      if(cached)topic_author_uid=cached.uid
      else if(type==='1'){const{data}=await this._get('/x/web-interface/wbi/view',{aid:oid},{signed:true});if(biliId(data.aid)!==oid)throw new BilibiliError('评论区内容归属无法核验',{code:'target_not_resolved'});topic_author_uid=biliId(data.owner?.mid);this._cachePut('source-owner',ownerKey,{uid:topic_author_uid},1800000)}
      else{const{data}=await this._get('/x/polymer/web-dynamic/v1/detail',{id:oid});if(biliId(data.item?.id_str??data.item?.id)!==oid)throw new BilibiliError('动态评论区归属无法核验',{code:'target_not_resolved'});topic_author_uid=biliId(data.item?.modules?.module_author?.mid);this._cachePut('source-owner',ownerKey,{uid:topic_author_uid},1800000)}
    }
    const source_context=publicSourceContext({platform:'bilibili',source_kind:parentId?'comment_reply':'topic_comment',self_uid,topic_author_uid,author_uid:exact.uid,parent_author_uid:parentRow?.uid,reply_to_uid:parentRow?.uid,mentioned_uids:exact.mention_uids,text:exact.text})
    return {...exact,oid,type,root:exact.root==='0'?exact.rpid:exact.root,thread_rows:candidates,thread_complete,source_context,context_text:JSON.stringify({source_context,quoted_context:{title:cleanSourceText(item.item?.title,180),text:cleanSourceText(item.item?.target_reply_content??item.item?.root_reply_content,300),author_uid:parentRow?.uid??null,authority:'quoted_public_source'}})}
  }
  async pollInbox(options={}){
    const key=this._accountKey(),scope=options.comments_only===true?'comments':'all',flightKey=key+':'+scope
    this.pollFlights??=new Map();if(this.pollFlights.has(flightKey))return this.pollFlights.get(flightKey)
    const prior=this._cacheGet('inbox-health',key),work=this._pollInbox(options);this.pollFlights.set(flightKey,work)
    try{try{this._cachePut('inbox-health',key,{status:'checking',started_at:this._now()},86400000)}catch{}const result=await work;if(result.polled)this._cachePut('inbox-health',key,{status:result.channel_errors?.length?'partial':'ready',checked_at:this._now(),scope,unresolved:result.unresolved??0,queued:result.queued??0,channel_errors:result.channel_errors??[]},86400000);else this._cachePut('inbox-health',key,prior??{status:'idle'},86400000);return result}
    catch(error){try{this._cachePut('inbox-health',key,{status:'error',checked_at:this._now(),message:redactText(String(error.message??error)).slice(0,500)},86400000)}catch{}throw error}
    finally{if(this.pollFlights.get(flightKey)===work)this.pollFlights.delete(flightKey)}
  }
  async _pollInbox({force=false,comments_only=false}={}){
    const policy=this._inboxPolicy()
    if(policy.enabled!==true&&!force)return {enabled:false,polled:false,items:0,new_events:0,queued:0,empty:true,model_calls:0}
    if(!this.activity?.enqueueIncoming)throw new BilibiliError('统一活动队列尚未接入',{code:'queue_unavailable'})
    const state=this._inboxState();if(state.value.last_poll_at&&this._now()-state.value.last_poll_at<(force?0:policy.poll_interval_ms??180000))return {enabled:true,polled:false,skipped:true,reason:'poll_interval',items:0,new_events:0,queued:0,empty:true,model_calls:0}
    const cred=await this._credential(),self_uid=this._assertAccount(await this._nav(cred));const seen=new Set(state.value.reply_seen_ids),people=new Set(state.value.reply_seen_people_uids),configured=comments_only?['replies','mentions']:(policy.channels??['replies','mentions']),hasComments=configured.some(channel=>['replies','mentions'].includes(channel)),channels=[...new Set([...configured.filter(channel=>!['replies','mentions'].includes(channel)),...(hasComments?policy.scope==='replies'?['replies']:policy.scope==='mentions'?['mentions']:['replies','mentions']:[])])]
    let queued=0,unresolved=0,discovered=0,ignored_non_comments=0,latest=state.value.reply_last_timestamp_raw;const failed=(raw,error)=>{unresolved++;if(!error)return;const event_key='bilibili:inbox-failure:'+sha(this._accountKey()+':'+raw+':'+String(error.message??error));if(this.store.db.prepare('SELECT id FROM journal_events WHERE event_key=?').get(event_key))return;this.store.appendJournalEvent({event_key,event_type:'log',platform:'bilibili',direction:'internal',visibility:'owner',status:'recorded',text:'单条来信未处理，已保留重试，不阻塞其他来信。',source_at:this._now(),source_type:'native_bilibili',metadata:{subtype:'inbox_item_failed',reason:redactText(String(error.message??error)).slice(0,500)}})};const cursors={},threads=new Map(),baseline=!state.value.reply_baseline,oldBoundary=BigInt(state.value.reply_last_timestamp_raw)
    for(const channel of channels){if(!['replies','mentions'].includes(channel))continue;const kind=channel==='replies'?'reply':'at';const{data}=await this._get('/x/msgfeed/'+kind,{platform:'web',build:0,mobi_app:'web'},{cred});const items=data.items??[]
      for(const item of items){const raw=String(item.reply_time??item.at_time??'');let key;try{key=kind+':'+biliId(item.id)}catch(error){failed(raw,error);continue}if(!/^\d+$/.test(raw)){failed(raw);continue}if(BigInt(raw)>BigInt(latest))latest=raw;if(baseline){seen.add(key);continue}if(BigInt(raw)<oldBoundary||seen.has(key))continue;if(nonCommentMention(item)){seen.add(key);ignored_non_comments++;continue}discovered++;let resolved;try{resolved=await this._resolveInbox(item,{threads,self_uid})}catch(error){failed(raw,error);continue}if(!resolved){failed(raw);continue}
        if(!resolved.source_context?.addressed_to_self){if(resolved.source_context?.address_kind==='third_party'){seen.add(key);ignored_non_comments++}else failed(raw);continue}
        const self=this.store.listPlatformIdentities({namespace:'bilibili',role:'account',entity_id:this._settings().value.account_entity_id,limit:20}).some(row=>row.platform_uid===resolved.uid);if(self||policy.once_per_person&&people.has(resolved.uid)){seen.add(key);continue}
        const conversation='comment:'+resolved.type+':'+resolved.oid+':'+resolved.root,at=Number.isSafeInteger(resolved.ctime*1000)?resolved.ctime*1000:null
        try{const delivery=await this._incoming({channel:'comment',manual:force&&comments_only,key:resolved.rpid,uid:resolved.uid,name:resolved.name,body:resolved.text,context_text:resolved.context_text,conversation_id:conversation,source_at:at,source_time_raw:String(resolved.ctime),visibility:'public',target:{object_type:resolved.type,object_id:resolved.oid,root_reply_id:resolved.root,parent_reply_id:resolved.rpid}});if(delivery?.duplicate!==true)queued++;seen.add(key);people.add(resolved.uid);cursors[channel]=biliId(item.id)}catch(error){failed(raw,error)}
      }
    }
    state.value.reply_seen_ids=[...seen].slice(-2000);state.value.reply_seen_people_uids=[...people].slice(-2000)
    if(hasComments){state.value.reply_baseline=true;if(!unresolved)state.value.reply_last_timestamp_raw=baseline&&BigInt(latest)<BigInt(Math.floor(this._now()/1000))?String(Math.floor(this._now()/1000)):latest;this._saveInboxState(state)}
    const channel_errors=[],permissions=this._settings().config.permissions??{}
    const collect=async(channel,allowed,run)=>{if(!channels.includes(channel))return null;if(!allowed)return {polled:false,queued:0,observed:0,reason:'reply_permission_disabled'};try{return await run()}catch(error){if(['authentication_required','account_mismatch','verification_required','risk_pause','closed'].includes(error.code))throw error;channel_errors.push({channel,code:typeof error.code==='string'?error.code:'check_failed',message:redactText(String(error.message??error)).slice(0,300)});return {polled:false,queued:0,observed:0,failed:true}}}
    const dm=await collect('dm',permissions.direct_message===true,()=>pollDirectMessages(this,state,policy)),live=await collect('live',permissions.live_danmaku===true,()=>pollLive(this,state,policy))
    unresolved+=channel_errors.length
    state.value.last_poll_at=this._now();this._saveInboxState(state);this._saveState({last_poll_at:this._now(),cursors})
    const totalQueued=queued+(dm?.queued??0)+(live?.queued??0),new_events=totalQueued+unresolved
    return {enabled:true,polled:true,items:discovered+(dm?.observed??0)+(live?.observed??0),new_events,queued:totalQueued,empty:new_events===0,unresolved,ignored_non_comments,channel_errors,checked_channels:channels,reply_seeded:baseline,dm,live,recommended_poll_delay_ms:policy.poll_interval_ms??180000,model_calls:0}
  }
  async reconcileToday(trusted_context={}){
    if(trusted_context.owner_authorized!==true||trusted_context.local_settings!==true)throw new BilibiliError('补回历史评论需要主人在设置里明确执行',{code:'owner_required'})
    if(!this.activity?.enqueueIncoming)throw new BilibiliError('统一回复队列尚未接入',{code:'queue_unavailable'})
    if(this.reconcileFlight)return this.reconcileFlight
    const work=this._reconcileToday();this.reconcileFlight=work
    try{return await work}finally{if(this.reconcileFlight===work)this.reconcileFlight=null}
  }
  async _reconcileToday(){
    this._checkEnabled();const cred=await this._credential(),nav=await this._nav(cred),self=this._assertAccount(nav),day=shanghaiTime(this._now()),notices=new Map(),report={day:day.date,today:0,queued:0,already_replied:0,pending:0,unknown_write:0,unresolved:0,scan_complete:true,items:[],model_calls:0}
    for(const channel of ['reply','at']){
      let cursor=null,finished=false;const pages=new Set()
      for(let page=0;page<10;page++){
        const params={platform:'web',build:0,mobi_app:'web',...(cursor?{id:cursor.id,[channel==='reply'?'reply_time':'at_time']:cursor.time}:{})},{data}=await this._get('/x/msgfeed/'+channel,params,{cred}),items=data.items??[]
        let older=false;for(const item of items){const seconds=Number(item.reply_time??item.at_time??0);if(seconds*1000<day.midnight){older=true;continue}if(seconds*1000>this._now()+60000)continue;notices.set(channel+':'+biliId(item.id),{channel,item})}
        if(!items.length||older||data.cursor?.is_end){finished=true;break}
        const next=data.cursor,key=next?String(next.id)+':'+String(next.time):'';if(!next||pages.has(key))break;pages.add(key);cursor={id:biliId(next.id),time:String(next.time)}
      }
      if(!finished)report.scan_complete=false
    }
    const threads=new Map(),resolvedIds=new Set(),inbox=this._inboxState(),seen=new Set(inbox.value.reply_seen_ids)
    for(const[noticeKey,{item}]of notices){
      if(nonCommentMention(item)){seen.add(noticeKey);continue}
      let row;try{row=await this._resolveInbox(item,{threads,self_uid:self})}catch(error){if(['verification_required','risk_pause','daily_limit','hourly_limit'].includes(error.code))throw error;report.unresolved++;continue}
      if(!row){report.unresolved++;continue}if(!row.source_context?.addressed_to_self){if(row.source_context?.address_kind==='third_party')seen.add(noticeKey);else report.unresolved++;continue}if(row.uid===self||resolvedIds.has(row.rpid))continue;resolvedIds.add(row.rpid);report.today++
      const summary={rpid:row.rpid,uid:row.uid,object_id:row.oid,parent_reply_id:row.rpid,root_reply_id:row.root,status:''}
      const actions=this.store.db.prepare("SELECT status,metadata_json FROM actions WHERE platform='bilibili' AND kind IN ('bilibili.reply','bilibili.comment') AND json_extract(target_json,'$.object_id')=? AND json_extract(target_json,'$.parent_reply_id')=?").all(row.oid,row.rpid)
      if(row.thread_rows.some(reply=>reply.uid===self&&reply.parent===row.rpid)||actions.some(action=>action.status==='confirmed')){report.already_replied++;summary.status='already_replied';seen.add(noticeKey)}
      else if(actions.some(action=>['unknown','submitting','submitted','leased'].includes(action.status)||JSON.parse(action.metadata_json).network_started&&!JSON.parse(action.metadata_json).confirmed_rejection)){report.unknown_write++;summary.status='unknown_write_not_repeated';seen.add(noticeKey)}
      else if(actions.some(action=>['queued','draft'].includes(action.status))){report.pending++;summary.status='pending_publication';seen.add(noticeKey)}
      else if(!row.thread_complete){report.unresolved++;summary.status='thread_scan_incomplete'}
      else{
        const previous=this.store.db.prepare("SELECT status FROM actions WHERE platform='bilibili' AND kind='activity.incoming' AND json_extract(metadata_json,'$.execution')='model' AND json_extract(target_json,'$.object_id')=? AND json_extract(target_json,'$.parent_reply_id')=? ORDER BY created_at DESC").all(row.oid,row.rpid)
        if(previous.some(task=>['queued','leased','running'].includes(task.status))){report.pending++;summary.status='pending_model'}
        else{const result=await this._incoming({channel:'comment',key:row.rpid,manual:true,...(previous.length?{dispatch_key:'today-repair:'+day.date+':'+row.rpid}:{}),uid:row.uid,name:row.name,body:row.text,context_text:row.context_text,conversation_id:'comment:'+row.type+':'+row.oid+':'+row.root,source_at:row.ctime*1000,source_time_raw:String(row.ctime),visibility:'public',target:{object_type:row.type,object_id:row.oid,root_reply_id:row.root,parent_reply_id:row.rpid}});if(result?.duplicate){report.pending++;summary.status='existing_repair'}else{report.queued++;summary.status='queued'}}
        seen.add(noticeKey)
      }
      report.items.push(summary)
    }
    inbox.value.reply_seen_ids=[...seen].slice(-2000);this._saveInboxState(inbox)
    this.store.appendJournalEvent({event_key:'bilibili:reconcile-today:'+randomUUID(),event_type:'log',platform:'bilibili',direction:'internal',status:'recorded',visibility:'owner',text:'主人手动补查今天历史评论；按服务器回复和真实动作回执去重，未知发表不重发。',source_at:this._now(),source_type:'native_bilibili',metadata:{subtype:'today_comment_reconciliation',...report}})
    return report
  }
  async directMessages({talker_uid,limit=20}={},trusted_context={}){talker_uid=biliId(talker_uid);positive(limit,30);if(trusted_context.owner_authorized!==true&&!(trusted_context.platform==='bilibili'&&trusted_context.conversation_id==='dm:'+talker_uid&&trusted_context.actor_uid===talker_uid))throw new BilibiliError('私信只能在对应私聊或主人设置中读取',{code:'private_context_required'});this._assertAccount(await this._nav(await this._credential()));const history=await readDirectHistory(this,{talker_uid,checkpoint:null}),rows=history.rows.slice(-limit),body=rows.map(row=>row.uid+' ['+row.timestamp_raw+'] '+row.text).join('\n'),stored=body?await this._source({body,actor_uid:talker_uid,conversation_id:'dm:'+talker_uid,visibility:'conversation',source_id:'dm-history:'+talker_uid,ref:'bilibili:dm:'+talker_uid}):{};return {talker_uid,items:rows.map(row=>({...row,text:row.text.slice(0,Math.floor(3000/Math.max(1,rows.length))),total_chars:row.text.length})),...stored,private:true,untrusted:true}}
  async liveHistory(input={}){const result=await liveHistory(this,input),stored=result.items.length?await this._source({body:result.items.map(row=>row.uid+' '+row.text).join('\n'),source_id:'live-history:'+result.room_id,ref:'https://live.bilibili.com/'+result.room_id}):{};return {...result,items:result.items.map(row=>({...row,text:row.text.slice(0,Math.floor(3000/Math.max(1,result.items.length))),total_chars:row.text.length})),...stored,untrusted:true}}
  startLive(options={}){return connectLive(this,options)}
  shareMaterials({bvid,message='',destination='owner'}={}){bvid=bvidOf(bvid);text(message,2000);const sharing=this._settings().config.sharing;if(sharing?.enabled!==true||sharing.via!=='qq')throw new BilibiliError('QQ视频分享当前未启用',{code:'permission_denied'});if(!['owner','group','both'].includes(destination))throw new BilibiliError('QQ分享目标无效',{code:'invalid_target'});const deliveries=[];if(destination!=='group'){const uid=biliId(sharing.private_recipient_uid);deliveries.push({platform:'qq',conversation_id:'private:'+uid})}if(destination!=='owner'){const uid=biliId(sharing.group_recipient_uid);deliveries.push({platform:'qq',conversation_id:'group:'+uid})}return {published:false,queued:false,bvid,text:message+(message?'\n':'')+'https://www.bilibili.com/video/'+bvid,deliveries,requires_native_social_service:true}}
  async login({operation,login_id}={}){
    this._checkEnabled();if(typeof this.credentials.save!=='function')throw new BilibiliError('原生登录态保存入口尚未接入',{code:'not_ready'})
    if(operation==='start'){
      if(this.auth&&this.auth.expires_at>this._now()&&this._now()-this.auth.created_at<2000)throw new BilibiliError('请稍等两秒再生成二维码',{code:'minimum_gap'})
      const{response,payload}=await this._http(PASSPORT+'/x/passport-login/web/qrcode/generate',{login:true,maxBytes:131072});if(!response.ok||payload.code!==0||!payload.data?.qrcode_key)throw new BilibiliError('B站二维码生成失败',{code:'login_failed'})
      const url=trustedBiliUrl(payload.data.url,{login:true});const render=this.qrRender??(async value=>{const lib=await import('qrcode');return lib.default.toDataURL(value,{width:220,margin:2})})
      this.auth={id:randomUUID(),status:'waiting',created_at:this._now(),expires_at:this._now()+180000,key:text(payload.data.qrcode_key,256),image:await render(url.href),next_poll_at:this._now()+2000}
      return {login_id:this.auth.id,status:'waiting',qr_url:this.auth.image,expires_at:this.auth.expires_at}
    }
    const auth=this.auth;if(!auth||auth.id!==login_id)throw new BilibiliError('这次登录流程已失效',{code:'login_expired'})
    if(operation==='cancel'){auth.status='cancelled';delete auth.key;delete auth.image;return{login_id:auth.id,status:'cancelled'}}
    if(operation!=='poll')throw new BilibiliError('登录操作无效',{code:'invalid_input'})
    if(auth.expires_at<=this._now()){auth.status='expired';delete auth.key;delete auth.image}
    if(auth.status!=='waiting'||this._now()<auth.next_poll_at)return {login_id:auth.id,status:auth.status,...(auth.image?{qr_url:auth.image}:{})}
    if(auth.flight)return auth.flight
    auth.next_poll_at=this._now()+2000
    auth.flight=(async()=>{
      const{response,payload}=await this._http(PASSPORT+'/x/passport-login/web/qrcode/poll?qrcode_key='+encodeURIComponent(auth.key),{login:true,maxBytes:131072});if(this.auth!==auth||auth.status!=='waiting')return{login_id:auth.id,status:'cancelled'}
      if(!response.ok||payload.code!==0)throw new BilibiliError('扫码状态无法核验',{code:'login_failed'})
      const code=payload.data?.code;if(code===86038){auth.status='expired';delete auth.key;delete auth.image}else if(code===0){
        const values={};for(const cookie of response.headers.getSetCookie?.()??[]){const pair=cookie.split(';',1)[0],at=pair.indexOf('=');if(at>0)values[pair.slice(0,at)]=pair.slice(at+1)}
        const cred=credentialValue({sessdata:values.SESSDATA,bili_jct:values.bili_jct,buvid3:values.buvid3??''}),nav=await this._nav(cred,{fresh:true}),mid=biliId(nav.mid)
        if(nav.isLogin!==true||values.DedeUserID&&biliId(values.DedeUserID)!==mid)throw new BilibiliError('登录账号身份未通过服务器核验',{code:'login_failed'})
        if(this.auth!==auth||auth.status!=='waiting'||auth.expires_at<=this._now())throw new BilibiliError('登录流程已取消或过期，未替换旧账号',{code:'login_expired'})
        const existing=this.store.getPlatformIdentity('bilibili',mid);if(existing&&existing.role!=='account')throw new BilibiliError('该UID已有其他明确身份绑定，需要主人核对后绑定账号',{code:'identity_conflict'})
        const entity_id=existing?.entity_id??'account-bilibili-'+sha(mid).slice(0,32),ref='credential:bilibili:'+randomUUID(),account={mid,name:cleanSourceText(nav.uname,200),entity_id}
        await this.credentials.save(ref,cred,{account})
        if(this.auth!==auth||auth.status!=='waiting')throw new BilibiliError('登录流程已取消，旧账号未替换',{code:'login_expired'})
        this.store.transaction(()=>{if(!existing)this.store.createEntity({id:entity_id,kind:'account',display_name:account.name});this.store.upsertPlatformIdentity({namespace:'bilibili',platform_uid:mid,entity_id,role:'account',display_name:account.name});const settings=this._settings();this.store.putDocument({id:settings.id,type:'platform_settings',expected_revision:settings.revision,value:{...settings.value,credential_ref:ref,account_entity_id:entity_id}})})
        this.liveConnection?.public.close();auth.status='confirmed';delete auth.key;delete auth.image;auth.account=account
      }else if(![86101,86090].includes(code))throw new BilibiliError('扫码状态无法识别',{code:'login_failed'})
      return {login_id:auth.id,status:auth.status,...(auth.image?{qr_url:auth.image}:{}),...(auth.account?{account:auth.account}:{})}
    })().finally(()=>{auth.flight=null});return auth.flight
  }
  _action(action){
    if(!action||action.platform!=='bilibili'||!['bilibili.comment','bilibili.reply','bilibili.dynamic','bilibili.like','bilibili.coin','bilibili.share'].includes(action.kind))throw new BilibiliError('B站动作类型无效',{code:'invalid_action'})
    const row=this.store.db.prepare('SELECT *,CAST(body AS BLOB) AS body_bytes FROM actions WHERE id=?').get(action.id)
    if(!row||row.platform!=='bilibili'||row.status!=='leased'||row.kind!==action.kind||row.request_digest!==action.request_digest||Buffer.from(row.body_bytes).toString('utf8')!==action.body||!isDeepStrictEqual(JSON.parse(row.target_json),action.target)||row.body_digest!==sha(action.body))throw new BilibiliError('动作未取得有效原生租约，未发送',{code:'invalid_action_lease'})
    return row
  }
  async submit(action,{mark_network_started}={}){
    let started=false,marked=false,ownsFlight=false
    const is_reply=!!incomingReplyOrigin(this.store,action)
    try{
      this._action(action);if(this.inflight.has(action.id))return result('blocked','同一动作正在处理，未重复发送');this.inflight.add(action.id);ownsFlight=true
      this._checkEnabled();if(typeof mark_network_started!=='function')throw new BilibiliError('缺少原生发表开始回调',{code:'missing_write_lease'})
      const cred=await this._credential(),cfg=this._settings().config,target=action.target,body=text(action.body,10000),kind=action.kind,images=target.asset_ids??[],channel=kind==='bilibili.share'?(target.via??cfg.sharing?.via??'comment'):kind==='bilibili.dynamic'?'dynamic':kind==='bilibili.reply'?(target.channel??'comment'):kind==='bilibili.comment'?'comment':'reaction'
      if(!Array.isArray(images)||images.length>9)throw new BilibiliError('图片资产数量无效',{code:'invalid_asset'})
      if(!['comment','dynamic','dm','live','reaction'].includes(channel))throw new BilibiliError('此分享目标应由统一SocialService准备对应平台动作',{code:'unsupported_share_target'})
      if(channel==='comment'&&cfg.permissions?.comment!==true||channel==='dynamic'&&cfg.permissions?.dynamic!==true||channel==='dm'&&cfg.permissions?.direct_message!==true||channel==='live'&&cfg.permissions?.live_danmaku!==true)throw new BilibiliError('当前设置未允许此类发表',{code:'permission_denied'})
      if(kind==='bilibili.share'&&cfg.sharing?.enabled!==true)throw new BilibiliError('当前设置未允许分享',{code:'permission_denied'})
      if(['dm','live'].includes(channel)&&images.length)throw new BilibiliError('本通道暂不接受图片资产，未退化成另一种发表',{code:'invalid_asset'})
      if(images.length&&cfg.permissions?.stickers!==true)throw new BilibiliError('图片或表情包发表未启用',{code:'permission_denied'})
      const onWrite=async()=>{const lease=this.store.db.prepare('SELECT status,metadata_json,request_digest FROM actions WHERE id=?').get(action.id),metadata=lease?JSON.parse(lease.metadata_json):{};if(!lease||!['leased','submitting'].includes(lease.status)||lease.request_digest!==action.request_digest||metadata.lease_until<=this._now())throw new BilibiliError('原生发表租约已结束，未继续网络写入',{code:'invalid_action_lease'});if(!marked){await mark_network_started();marked=true;started=true}}
      let endpoint,params,content_type='application/x-www-form-urlencoded',requestBody,coin=0,apiHost=HOST
      const transportText=kind==='bilibili.share'?body+(body?'\n':'')+'https://www.bilibili.com/video/'+bvidOf(target.bvid):body
      if(channel==='dm'){
        const recipient=biliId(target.recipient_uid);if(target.conversation_id!=='dm:'+recipient)throw new BilibiliError('私信目标与私域会话不一致',{code:'invalid_target'});if(!transportText.trim()||transportText.length>300)throw new BilibiliError('私信需为1—300字，未自动截断',{code:'invalid_input'})
        const nav=await this._nav(cred);if(nav.isLogin!==true)throw new BilibiliError('B站私信发送者身份尚未核验',{code:'authentication_required'});const state=this._inboxState();if(!state.value.dm_device_id){state.value.dm_device_id=randomUUID();this._saveInboxState(state)}
        params={'msg[sender_uid]':biliId(nav.mid),'msg[receiver_id]':recipient,'msg[receiver_type]':'1','msg[msg_type]':'1','msg[msg_status]':'0','msg[timestamp]':String(Math.floor(this._now()/1000)),'msg[dev_id]':state.value.dm_device_id,'msg[content]':JSON.stringify({content:transportText}),csrf:cred.bili_jct};endpoint='/web_im/v1/web_im/send_msg';apiHost='https://api.vc.bilibili.com'
      }else if(channel==='live'){
        if(!transportText.trim())throw new BilibiliError('弹幕正文不能为空',{code:'invalid_input'});const room=await liveRoom(this,biliId(target.room_id));params={csrf:cred.bili_jct,csrf_token:cred.bili_jct,roomid:room.room_id,msg:transportText,rnd:String(Math.floor(this._now()/1000)),fontsize:'25',color:'16777215',mode:'1',bubble:'0',room_type:'0',jumpfrom:'0',statistics:JSON.stringify({appId:100,platform:5})};if(target.reply_dmid)params.replay_dmid=biliId(target.reply_dmid);if(target.reply_uid)params.reply_mid=biliId(target.reply_uid);if(target.reply_name)params.reply_uname=text(target.reply_name,200);endpoint='/msg/send';apiHost='https://api.live.bilibili.com'
      }else if(channel==='comment'){
        const oid=biliId(target.object_id),type=biliId(target.object_type??'1'),root=biliId(target.root_reply_id??'0',{zero:true}),parent=biliId(target.parent_reply_id??'0',{zero:true})
        if(kind==='bilibili.reply'&&(root==='0'||parent==='0')||kind==='bilibili.comment'&&(root!=='0'||parent!=='0')||(root==='0')!==(parent==='0'))throw new BilibiliError('回复必须保留原评论与楼中楼坐标，不能改发新评论',{code:'invalid_reply_target'})
        if(transportText.length>1000||!transportText.trim())throw new BilibiliError('评论正文需为1—1000字',{code:'invalid_input'})
        await this._get('/x/v2/reply/main',{oid,type,pn:1,ps:1})
        if(parent!=='0'){let confirmed=false;for(let page=1;page<=30;page++){const thread=await this._thread({oid,type,root,page,limit:20});if([thread.root_comment,...thread.items].some(row=>row?.rpid===parent)){confirmed=true;break}if(thread.items.length<20)break}if(!confirmed)throw new BilibiliError('指定父评论没有回读确认，未改发新楼',{code:'target_not_resolved'})}
        params={oid,type,root,parent,message:transportText,plat:'1',csrf:cred.bili_jct};endpoint='/x/v2/reply/add'
      }else if(channel==='dynamic'){
        if(!transportText.trim())throw new BilibiliError('动态内容不能为空',{code:'invalid_input'})
        requestBody={csrf:cred.bili_jct,dyn_req:{content:{contents:[{raw_text:transportText,type:1,biz_id:''}]},scene:1,meta:{app_meta:{from:'create.dynamic.web',mobi_app:'web'}}}};endpoint='/x/dynamic/feed/create/dyn';content_type='application/json'
      }else{
        const bvid=bvidOf(target.bvid),relation=(await this._get('/x/web-interface/archive/relation',{bvid})).data
        if(kind==='bilibili.coin'){coin=target.multiply??1;if(![1,2].includes(coin))throw new BilibiliError('单次投币只允许1或2',{code:'invalid_input'});if(Number(relation.coin)>0)return result('not_started','该视频已投过币，无需重复提交');params={bvid,multiply:String(coin),select_like:'0',csrf:cred.bili_jct};endpoint='/x/web-interface/coin/add'}
        else{const like=target.like===false?'2':'1';if((like==='1')===(Number(relation.like)>0))return result('not_started','视频点赞状态已经符合目标，无需重复提交');params={bvid,like,csrf:cred.bili_jct};endpoint='/x/web-interface/archive/like'}
      }
      // Resolve every local image before the first upload; a missing sticker never degrades to a different text-only publication.
      const local=[];for(const id of images){if(!this.assets?.read)throw new BilibiliError('原生图片资产读取尚未接入',{code:'invalid_asset'});let asset;try{asset=await this.assets.read(text(id,160))}catch{throw new BilibiliError('原生图片资产缺失或完整性校验失败',{code:'invalid_asset'})}if(!canPublishAsset(asset,{platform:'bilibili'}))throw new BilibiliError('图片未获得公开发表许可；QQ私图或未知素材不会上传',{code:'invalid_asset'});const bytes=Buffer.from(asset?.bytes??[]);if(!bytes.length||bytes.length>8*1024*1024)throw new BilibiliError('图片资产不存在或过大',{code:'invalid_asset'});local.push({bytes,...imageInfo(bytes)})}
      const nav=await this._nav(cred);this._assertAccount(nav)
      const pictures=[]
      for(const image of local){const form=new FormData();form.append('file_up',new Blob([image.bytes],{type:image.media_type}),'upload.'+image.extension);form.append('category','daily');form.append('csrf',cred.bili_jct);const upload=await this._http(HOST+'/x/dynamic/feed/draw/upload_bfs',{method:'POST',body:form,cred,onWrite,continuation:marked,is_reply});if(!upload.response.ok||upload.payload.code!==0||!upload.payload.data?.image_url)throw new BilibiliError('图片上传未确认，正文未发表',{code:'image_upload_unconfirmed'});const data=upload.payload.data;pictures.push({img_src:trustedBiliUrl(data.image_url,{cdn:true}).href,img_width:Number(data.image_width)||image.width,img_height:Number(data.image_height)||image.height})}
      if(pictures.length){if(params)params.pictures=JSON.stringify(pictures);else{requestBody.dyn_req.pics=pictures.map(row=>({img_src:row.img_src,img_width:row.img_width,img_height:row.img_height}));requestBody.dyn_req.scene=2}}
      const signature=new URLSearchParams(signedWbi(params??{platform:'web'},nav.wbi_img,this._now())),query=new URLSearchParams({w_rid:signature.get('w_rid'),wts:signature.get('wts')});if(requestBody){query.set('platform','web');query.set('csrf',cred.bili_jct)}
      const url=apiHost+endpoint+(['comment','dynamic'].includes(channel)?'?'+query:'')
      const sent=await this._http(url,{method:'POST',body:requestBody?JSON.stringify(requestBody):new URLSearchParams(params).toString(),cred,onWrite,coin,content_type,continuation:marked,is_reply})
      if(!sent.response.ok||sent.payload.code!==0){const explicit=typeof sent.payload.code==='number'&&sent.payload.code!==0;let message=String(sent.payload.message??sent.payload.msg??'').slice(0,1000);for(const secret of Object.values(cred).filter(value=>typeof value==='string'&&value.length>=8))message=message.split(secret).join('[REDACTED_SECRET]');message=redactText(message).replace(/[\r\n]+/g,' ');return result(explicit?'blocked':'unknown','B站未确认发表（HTTP '+sent.response.status+'，code='+String(sent.payload.code??'unknown')+'）'+(message?'：'+message:''),explicit?{source:'server_receipt',accepted:false,rejected:true,code:sent.payload.code,...(message?{message}:{})}:undefined)}
      let server_id
      if(channel==='dm')server_id=nonzero(sent.payload.data?.msg_key_str??sent.payload.data?.msg_key)
      else if(channel==='live'){let extra={};try{extra=exactJson(sent.payload.data?.mode_info?.extra??'{}')}catch{}server_id=nonzero(sent.payload.data?.dmid_str??sent.payload.data?.dmid??sent.payload.data?.msgid??extra.dmid_str??extra.dmid)}
      else if(channel==='comment')server_id=nonzero(sent.payload.data?.rpid_str??sent.payload.data?.rpid)
      else if(channel==='dynamic')server_id=nonzero(sent.payload.data?.dyn_id_str??sent.payload.data?.dyn_id)
      else{
        // Like/coin endpoints have no publication ID: verify the exact requested state with a fresh read, never invent a receipt ID.
        const checked=(await this._get('/x/web-interface/archive/relation',{bvid:target.bvid})).data,accepted=kind==='bilibili.coin'?Number(checked.coin)>=coin:(Number(checked.like)>0)===(target.like!==false)
        if(!accepted)return result('unknown','写入返回成功，但关系状态尚未回读确认')
        const observed={source:'server_state_read',state_verified:true,target_bvid:bvidOf(target.bvid),kind,...(kind==='bilibili.coin'?{coin:Number(checked.coin)}:{like:Number(checked.like)>0})}
        await this._source({body:'观察到视频 '+target.bvid+' 的当前'+(kind==='bilibili.coin'?'投币数为 '+Number(checked.coin):'点赞状态为 '+(Number(checked.like)>0?'已点赞':'未点赞'))+'。不据此推断本次动作有独立发表回执。',ref:'https://www.bilibili.com/video/'+target.bvid,source_id:'relation:'+action.id,visibility:'owner'})
        return result('unknown','关系状态已回读符合目标，但接口没有独立服务器回执ID；保留结果，不自动重发',observed)
      }
      if(!server_id){if(channel==='live')try{await this.liveHistory({room_id:target.room_id,limit:20})}catch{}return result('unknown','B站返回成功码，但未返回非零发表ID；不自动重发')}
      this._saveState({last_write_at:this._now()})
      return result('confirmed','服务器已确认',{source:'server_receipt',accepted:true,code:0,server_id,...(['bilibili.like','bilibili.coin'].includes(kind)?{verified_by:'fresh_relation_read',target_bvid:target.bvid}:{})})
    }catch(error){
      const stored=action?.id?this.store.db.prepare('SELECT metadata_json FROM actions WHERE id=?').get(action.id):null;if(stored&&JSON.parse(stored.metadata_json).network_started)started=true
      return result(started?'unknown':error instanceof BilibiliError&&['unsupported_share_target','invalid_action','invalid_action_lease','invalid_reply_target','target_not_resolved','permission_denied','invalid_asset','invalid_target','invalid_input','verification_required','account_mismatch'].includes(error.code)?'blocked':'not_started',error instanceof BilibiliError?error.message:'B站操作未完成，未自动重试')
    }finally{if(ownsFlight)this.inflight.delete(action.id)}
  }
  close(){this.closed=true;this.liveConnection?.public.close();if(this.auth){this.auth.status='cancelled';delete this.auth.key;delete this.auth.image}}
}
