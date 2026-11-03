/** Deterministic, explicit group moderation. No model, nickname lookup or alternate sender. */
import {createHash,createHmac,randomBytes} from 'node:crypto'
import {isPlainObject,stringifyJson} from './contracts.mjs'
export const QQ_MAX_MUTE_SECONDS=30*86400
const hash=value=>createHash('sha256').update(value).digest('hex')
const canonical=value=>Array.isArray(value)?value.map(canonical):isPlainObject(value)?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value
const encode=value=>stringifyJson(canonical(value))
const uid=value=>typeof value==='string'&&/^[1-9]\d{0,19}$/.test(value)
const at=value=>Number.isSafeInteger(value)&&value>=0
const deny=message=>Object.assign(new Error(message),{native_action_outcome:'blocked'})
const sameIntent=(a,b)=>a&&b&&['operation','conversation_id','member_uid','duration_seconds'].every(key=>a[key]===b[key])
const fields=(value,allowed)=>{if(!isPlainObject(value)||Object.keys(value).some(key=>!allowed.includes(key)))throw deny('禁言操作含未授权字段')}
const chineseNumber=value=>{const digits={零:0,〇:0,一:1,二:2,两:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9},units={十:10,百:100,千:1000};let sum=0,current=0;for(const c of value){if(c in digits)current=digits[c];else if(c in units){sum+=(current||1)*units[c];current=0}else return null}return sum+current}

/** Complete direct command, exact UID and explicit numeric duration. Native @
 * segments are supplied as ordinary @UID text; quoted/media expansions never enter here. */
export function parseModerationRequest(text,{conversation_id='',bot_uid='',mention_uids=[],default_duration_seconds=null}={}){
  if(typeof text!=='string'||text.length>4000||!text.isWellFormed()||/[\r\n\0]/.test(text))return null
  let value=text.trim();if(uid(bot_uid)&&mention_uids.includes(bot_uid)&&value.startsWith('@'+bot_uid))value=value.slice(bot_uid.length+1).trim()
  // A leading native @ of the target is an explicit identifier, even when a
  // redundant nickname follows the verb. Plain copied @ text has no such grant.
  const leading=/^@([1-9]\d{0,19})\s+(?=(?:请|麻烦|帮我|帮忙|把|禁|解|静音|闭麦|关小黑屋))/.exec(value)
  const mentioned=leading&&mention_uids.includes(leading[1])&&leading[1]!==bot_uid?leading[1]:null
  if(mentioned){if(new Set(mention_uids.filter(id=>id!==bot_uid)).size!==1)return null;value=value.slice(leading[0].length)}
  value=value.replace(/^(?:(?:请|麻烦你|麻烦|帮我|帮忙)\s*)+/,'').replace(/半(?:个)?小时(?=[。！!]?\s*$)/,'30分钟').replace(/半天(?=[。！!]?\s*$)/,'12小时').replace(/([零〇一二两三四五六七八九十百千]+)(?:个)?(秒|分钟|分|小时|时|天)(?=[。！!]?\s*$)/,(_all,n,u)=>String(chineseNumber(n))+u)
  value=value.replace(/(禁言|解禁|解除禁言|取消禁言)(?:一下|下)(?=[。！!]?\s*$)/,'$1')
  value=value.replace(/[,，:：]\s*(?=\d{1,8}\s*(?:秒|分钟|分|小时|时|天)[。！!]?\s*$)/,' ')
  if(mentioned&&/^(?:禁言\s*\d{1,8}\s*(?:秒|分钟|分|小时|时|天)|解禁|解除禁言|取消禁言)[。！!]?\s*$/.test(value))value=value.replace(/^(禁言|禁盐|禁眼|禁严|静音|闭麦|关小黑屋|解禁|解紧|解除禁言|取消禁言)/,'$1 '+mentioned+' ')
  const group=/^(?:在|去|到)?(?:QQ群|群)(?:号)?\s*[:：]?\s*([1-9]\d{0,19})\s*[,，:]?\s*/.exec(value)
  let conversation=group?'group:'+group[1]:/^group:[1-9]\d{0,19}$/.test(conversation_id)?conversation_id:'';if(group)value=value.slice(group[0].length)
  if(!group&&conversation)value=value.replace(/^(?:把)?(?:在|去|到)?(?:这个)?群(?:里|内)(?:的)?\s*/,'')
  if(!conversation)return null
  const first=/^(禁言|禁盐|禁眼|禁严|静音|闭麦|关小黑屋|解禁|解紧|解除禁言|取消禁言)\s*(?:QQ)?\s*@?(.+?)(?:\s*(\d{1,8})\s*(秒|分钟|分|小时|时|天))?\s*[。！!]?$/u.exec(value)
  const last=first?null:/^(?:把\s*)?(?:QQ)?\s*@?(.+?)\s*(禁言|禁盐|禁眼|禁严|静音|闭麦|关小黑屋|解禁|解紧|解除禁言|取消禁言)(?:\s*(\d{1,8})\s*(秒|分钟|分|小时|时|天))?\s*[。！!]?$/u.exec(value)
  if(!first&&!last)return null
  const verb=first?first[1]:last[2],selector=(first?first[2]:last[1]).trim().replace(/^(?:一下|下)\s*/,'').replace(/\s*(?:一下|吧)$/,''),number=first?first[3]:last[3],unit=first?first[4]:last[4],operation=['解禁','解紧','解除禁言','取消禁言'].includes(verb)?'unmute':'mute'
  if(!selector||selector.length>80||/[\0\r\n?？“”‘’"'`<>]/.test(selector))return null
  if(operation==='unmute'&&number!==undefined||operation==='mute'&&number===undefined&&(!Number.isSafeInteger(default_duration_seconds)||default_duration_seconds<1||default_duration_seconds>QQ_MAX_MUTE_SECONDS))return null
  const duration_seconds=operation==='unmute'?0:number===undefined?default_duration_seconds:Number(number)*({秒:1,分钟:60,分:60,小时:3600,时:3600,天:86400}[unit]??0)
  if(!Number.isSafeInteger(duration_seconds)||operation==='mute'&&(duration_seconds<1||duration_seconds>QQ_MAX_MUTE_SECONDS))return null
  if(mentioned&&uid(selector)&&selector!==mentioned)return null
  return {operation,kind:'qq.'+operation,conversation_id:conversation,member_selector:selector,...(mentioned||uid(selector)?{member_uid:mentioned??selector}:{}),duration_seconds}
}
export function parseModerationCommand(text,options){const request=parseModerationRequest(text,options);if(!request?.member_uid)return null;const{member_selector,...intent}=request;return intent}
const memberName=value=>String(value??'').normalize('NFKC').toLowerCase().replace(/[\p{P}\p{Z}\p{So}]/gu,'')
function nameDistance(a,b){const previous=Array.from({length:b.length+1},(_,i)=>i);for(let i=1;i<=a.length;i++){let diagonal=previous[0];previous[0]=i;for(let j=1;j<=b.length;j++){const above=previous[j];previous[j]=Math.min(previous[j]+1,previous[j-1]+1,diagonal+(a[i-1]===b[j-1]?0:1));diagonal=above}}return previous[b.length]}
export function matchQQMembers(rows,query,{fuzzy=true}={}){
  const exact=rows.filter(row=>[String(row.user_id??''),String(row.card??'').trim(),String(row.nickname??'').trim()].includes(query.trim()))
  if(exact.length)return{items:exact,match_kind:'exact'}
  if(/^\d+$/.test(query.trim()))return{items:[],match_kind:'none'}
  const name=memberName(query),normalized=rows.filter(row=>[row.card,row.nickname].some(value=>memberName(value)===name&&name))
  if(normalized.length)return{items:normalized,match_kind:'normalized'}
  if(!fuzzy||name.length<3||name.length>80)return{items:[],match_kind:'none'}
  const threshold=name.length>=6?2:1,ranked=[]
  for(const row of rows){const distances=[row.card,row.nickname].map(memberName).filter(value=>value&&Math.abs(value.length-name.length)<=threshold).map(value=>nameDistance(name,value));const distance=Math.min(...distances);if(distance<=threshold)ranked.push({row,distance})}
  const best=Math.min(...ranked.map(item=>item.distance));return{items:ranked.filter(item=>item.distance===best).map(item=>item.row),match_kind:ranked.length?'similar':'none'}
}
export function moderationConversation(source,policy){return source.conversation_id?.startsWith('private:')&&policy?.allowed_group_uids?.length===1?'group:'+policy.allowed_group_uids[0]:source.conversation_id}
export function moderationTarget(kind,target){
  fields(target,['conversation_id','member_uid','duration_seconds'])
  if(!['qq.mute','qq.unmute'].includes(kind)||!/^group:[1-9]\d{0,19}$/.test(target.conversation_id)||!uid(target.member_uid)||!Number.isSafeInteger(target.duration_seconds)||kind==='qq.mute'&&(target.duration_seconds<1||target.duration_seconds>QQ_MAX_MUTE_SECONDS)||kind==='qq.unmute'&&target.duration_seconds!==0)throw deny('需明确允许群、目标QQUID与1秒至30天时长；解禁时长为0')
  return {operation:kind==='qq.mute'?'mute':'unmute',kind,...target}
}
/** The only server-state confirmation exception. Historical validation retains
 * its original timing relationships; fresh finish also checks current freshness. */
export function validateModerationStateProof(action,proof,{historical=false,now=Date.now()}={}){
  const intent=moderationTarget(action.kind,action.target)
  fields(proof,['source','schema_id','schema_version','accepted','operation','action_kind','request_digest','group_uid','member_uid','duration_seconds','requested_at','observed_at','mute_endtime','bot_role','target_role','write_ack'])
  if(action.platform!=='qq'||action.metadata?.network_started!==true||proof.source!=='server_state_read'||proof.schema_id!=='companion.qq_group_ban_state'||proof.schema_version!==1||proof.accepted!==true||proof.operation!=='set_group_ban'||proof.action_kind!==action.kind||proof.request_digest!==action.request_digest||proof.group_uid!==intent.conversation_id.slice(6)||proof.member_uid!==intent.member_uid||proof.duration_seconds!==intent.duration_seconds||!['owner','admin'].includes(proof.bot_role)||!(proof.target_role==='member'||proof.bot_role==='owner'&&proof.target_role==='admin'))throw deny('禁言状态回执与原生动作、权限或目标不一致')
  fields(proof.write_ack,['status','retcode']);if(proof.write_ack.status!=='ok'||proof.write_ack.retcode!==0||!at(proof.requested_at)||!at(proof.observed_at)||proof.requested_at!==action.metadata.attempted_at||proof.observed_at<proof.requested_at||proof.observed_at-proof.requested_at>120000||!at(proof.mute_endtime)||!historical&&(!at(now)||proof.observed_at>now+1000||now-proof.observed_at>30000))throw deny('禁言状态回执缺少明确ACK、真实字段或新鲜观测')
  const observedSecond=Math.floor(proof.observed_at/1000),expected=Math.floor(proof.requested_at/1000)+intent.duration_seconds
  if(intent.operation==='mute'?proof.mute_endtime<=observedSecond||Math.abs(proof.mute_endtime-expected)>5:proof.mute_endtime>observedSecond)throw deny('实际禁言截止状态未符合本次明确指令')
  return true
}

export class NativeQQModeration{
  constructor(qq){this.qq=qq;this.key=randomBytes(32);this.resolutions=new Map()}
  _request(source){const policy=this.qq.settings().qq?.moderation;return parseModerationRequest(source.text,{conversation_id:moderationConversation(source,policy),bot_uid:this.qq.self_uid,mention_uids:source.mention_uids??[],default_duration_seconds:Math.min(policy?.default_duration_seconds??600,policy?.max_duration_seconds??QQ_MAX_MUTE_SECONDS)})}
  request(source){return this._request(source)}
  _resolutionKey(source){return hash(encode([source.platform,source.session_id,source.source_scope,source.text]))}
  rememberMembers(source,conversation_id,query,items){
    const request=source&&this._request(source)
    if(!request||request.member_uid||request.conversation_id!==conversation_id||request.member_selector!==query||items.length!==1)return
    this.resolutions.set(this._resolutionKey(source),{member_uid:items[0].member_uid,at:this.qq._now()});if(this.resolutions.size>1000)this.resolutions.delete(this.resolutions.keys().next().value)
  }
  intent(source){const request=this._request(source);if(!request)return null;const saved=this.resolutions.get(this._resolutionKey(source)),member_uid=request.member_uid??(saved&&this.qq._now()-saved.at<=120000?saved.member_uid:null);if(!member_uid)return null;const{member_selector,...intent}=request;return{...intent,member_uid}}
  _mac(value){return createHmac('sha256',this.key).update(encode(value)).digest('hex')}
  _policy(){const q=this.qq,cfg=q.settings(),policy=cfg.qq?.moderation;if(cfg.enabled!==true||q.store.getDocument('settings')?.value.enabled===false||!policy?.enabled||q.account_mismatch||!uid(q.self_uid))throw deny('QQ禁言功能未启用或当前账号尚未核验');return policy}
  _source(context){
    if(context.autonomous===true||!['qq','harness'].includes(context.platform)||context.can_moderate_group!==true)throw deny('禁言只接受本轮真实管理员明确指令，不接受自主或其他平台权限')
    const source=context.platform==='qq'?this.qq.moderationSource(context.session_id,{agent:this.qq.sessions.get?.(context.session_id)}):this.qq.local_moderation_source?.({session_id:context.session_id})
    if(!source||source.platform!==context.platform||source.session_id!==context.session_id||source.actor_uid!==context.actor_uid||source.platform==='harness'&&source.actor_entity_id!==context.actor_entity_id)throw deny('禁言来源未绑定本轮真实发言者')
    return source
  }
  _check(intent,source,{queued=false}={}){
    const q=this.qq,p=this._policy();if(!p.allowed_group_uids?.includes(intent.conversation_id.slice(6)))throw deny('该群未在禁言允许名单中')
    if(intent.duration_seconds>(p.max_duration_seconds??QQ_MAX_MUTE_SECONDS))throw deny('禁言时长超过本机配置上限')
    if(intent.member_uid===q.self_uid||intent.member_uid===source.actor_uid||q._admin(intent.member_uid)||source.platform==='harness'&&q.store.listPlatformIdentities({namespace:'qq',entity_id:source.actor_entity_id,limit:100}).some(row=>row.platform_uid===intent.member_uid))throw deny('不能禁言或解禁机器人、配置的bot管理员及命令发起者本人')
    if(source.platform==='qq'){
      if(!q._admin(source.actor_uid))throw deny('发起者不在当前bot管理员配置中')
      const job=q._job(source.inbound_id),turn=q._job(source.turn_id),meta=job?.metadata
      if(job?.kind!=='qq.inbound'||!meta?.direct_moderation_source||meta.moderation_text!==source.text||job.target.session_id!==source.session_id||job.target.conversation_id!==source.conversation_id||meta.actor_uid!==source.actor_uid||meta.source_message_id!==source.source_message_id||turn?.kind!=='qq.turn'||turn.metadata.source_consumed!==true||turn.metadata.actor?.actor_uid!==source.actor_uid||turn.target.session_id!==source.session_id||q.turns.get(source.session_id)?.id!==source.turn_id)throw deny('原始管理员命令已变化或不属于当前QQ回合')
    }else{
      const identity=q.store.getPlatformIdentity('harness',source.actor_uid),entity=identity&&q.store.getEntity(identity.entity_id)
      if(p.allow_local_owner!==true||source.actor_uid!=='local-owner'||source.conversation_id!=='local-owner'||identity?.role!=='owner'||identity.entity_id!==source.actor_entity_id||entity?.metadata.owner_confirmed!==true)throw deny('本机主人禁言入口未启用或身份未明确确认')
    }
    const parsed=this.intent(source)
    if(!sameIntent(intent,parsed))throw deny('目标、群号或时长与本轮原始明确命令不一致')
    if(queued&&(!at(source.issued_at)||q._now()-source.issued_at>(p.command_ttl_ms??120000)||q._now()<source.issued_at))throw deny('原禁言指令已过期，请重新明确发出命令；不会补发')
    return parsed
  }
  async prepare(input,context={}){
    fields(input,['operation','conversation_id','member_uid','duration_seconds','idempotency_key','source_evidence_id'])
    const intent=moderationTarget('qq.'+input.operation,{conversation_id:input.conversation_id,member_uid:input.member_uid,duration_seconds:input.duration_seconds}),source=this._source(context);this._check(intent,source)
    if(input.source_evidence_id!==undefined&&input.source_evidence_id!==source.source_evidence_id)throw deny('禁言不能借用其他来源证据')
    const target={conversation_id:intent.conversation_id,member_uid:intent.member_uid,duration_seconds:intent.duration_seconds},prepared=this.qq.outbox.prepare({platform:'qq',kind:intent.kind,target,body:'',approval:'required',idempotency_key:input.idempotency_key,source_evidence_id:source.source_evidence_id})
    if(!prepared.duplicate){const grant={schema_version:1,source:{...source,issued_at:this.qq._now()},request_digest:prepared.action.request_digest},signed={...grant,signature:this._mac(grant)};this.qq.store.transaction(()=>{const old=this.qq.outbox.get(prepared.action.id,{internal:true});this.qq.store.db.prepare('UPDATE actions SET metadata_json=? WHERE id=?').run(encode({...old.metadata,moderation_grant:signed}),old.id)})}
    return {...prepared,action:this.qq.outbox.get(prepared.action.id)}
  }
  _authority(action){const signed=action.metadata?.moderation_grant;if(!isPlainObject(signed))throw deny('禁言动作缺少本实例真实指令授权');const{signature,...grant}=signed;if(signature!==this._mac(grant)||grant.request_digest!==action.request_digest)throw deny('禁言指令不属于本实例或已被改动，未自动恢复执行');const intent=moderationTarget(action.kind,action.target);this._check(intent,grant.source,{queued:true});return {intent,source:grant.source}}
  async _read(action,params){const q=this.qq;if(!q.connection?.connected)throw deny('QQ桥未连接');const frame=await q.connection.call(action,params);if(frame?.status!=='ok'||frame.retcode!==0||!isPlainObject(frame.data))throw deny('官方群成员状态尚未获得明确回执');return frame.data}
  _member(data,group,member){if(String(data.group_id)!==group||String(data.user_id)!==member||!['member','admin','owner'].includes(data.role))throw deny('官方成员身份或角色缺失，未猜测');return data}
  async _roles(intent){const q=this.qq,group=intent.conversation_id.slice(6),login=await this._read('get_login_info',{});if(String(login.user_id)!==q.self_uid)throw deny('当前桥账号与已绑定机器人不同');const bot=this._member(await this._read('get_group_member_info',{group_id:group,user_id:q.self_uid,no_cache:true}),group,q.self_uid),member=this._member(await this._read('get_group_member_info',{group_id:group,user_id:intent.member_uid,no_cache:true}),group,intent.member_uid);if(!['admin','owner'].includes(bot.role)||!(member.role==='member'||bot.role==='owner'&&member.role==='admin'))throw deny('机器人管理员只能管理普通成员；机器人群主可管理管理员，永远不能管理群主');return {bot,member}}
  async dispatch(action){
    const q=this.qq;if(!q.connection?.connected)return action
    let lease,started=false,requested_at=0,roles
    try{
      lease=q.outbox.lease(action.id,{authorization:action.approval_token,expected_digest:action.request_digest});if(!lease.allowed)return lease.action
      const{intent}=this._authority(q.outbox.get(action.id,{internal:true}));await this._roles(intent);this._authority(q.outbox.get(action.id,{internal:true}))
      const frame=await q.connection.call('set_group_ban',{group_id:intent.conversation_id.slice(6),user_id:intent.member_uid,duration:intent.duration_seconds},{mark_started:async({assert_send_ready}={})=>{
        roles=await this._roles(intent);if(typeof assert_send_ready!=='function')throw deny('当前桥未提供受控网络开始检查')
        return ()=>{assert_send_ready();q.store.transaction(()=>{const current=q.outbox.get(action.id,{internal:true});this._authority(current);q.outbox._lease(action.id,lease.lease_token);if(current.metadata.lease_until<=q._now())throw deny('禁言租约已结束');if(typeof q.before_send!=='function')throw deny('统一社交发送门禁尚未接入');const result=q.before_send(current);if(result&&typeof result.then==='function')throw deny('最终发送门禁必须同步完成');q._chargeWrite('moderation');requested_at=q.outbox.markNetworkStarted(action.id,lease.lease_token).metadata.attempted_at;started=true})}
      }})
      if(frame?.status!=='ok'||frame.retcode!==0){q.outbox.finish(action.id,{lease_token:lease.lease_token,outcome:'unknown',detail:'禁言ACK未明确确认，停止且不重复提交'});return q.outbox.get(action.id)}
      const state=this._member(await this._read('get_group_member_info',{group_id:intent.conversation_id.slice(6),user_id:intent.member_uid,no_cache:true}),intent.conversation_id.slice(6),intent.member_uid)
      const raw=state.shut_up_timestamp,mute_endtime=typeof raw==='number'?raw:typeof raw==='string'&&/^\d+$/.test(raw)?Number(raw):NaN
      const proof={source:'server_state_read',schema_id:'companion.qq_group_ban_state',schema_version:1,accepted:true,operation:'set_group_ban',action_kind:action.kind,request_digest:action.request_digest,group_uid:intent.conversation_id.slice(6),member_uid:intent.member_uid,duration_seconds:intent.duration_seconds,requested_at,observed_at:q._now(),mute_endtime,bot_role:roles.bot.role,target_role:state.role,write_ack:{status:'ok',retcode:0}}
      validateModerationStateProof(q.outbox.get(action.id,{internal:true}),proof,{now:q._now()});q.outbox.finish(action.id,{lease_token:lease.lease_token,outcome:'confirmed',proof,detail:'官方ACK及成员实际禁言截止状态已回读确认'})
    }catch(error){const old=q.outbox.get(action.id,{internal:true});if(old&&['leased','submitting'].includes(old.status))q.outbox.finish(action.id,{lease_token:lease?.lease_token,outcome:started||error.native_action_outcome!=='blocked'?'unknown':'blocked',detail:started?'禁言状态未获得完整确认，停止且不重复提交':'禁言权限、当前命令或平台角色检查未通过，未发送'});else if(old?.status==='queued')q.outbox.cancel(old.id,{expected_digest:old.request_digest,reason:'禁言动作授权未通过，网络未开始；需重新明确发出命令'})}
    return q.outbox.get(action.id)
  }
}
