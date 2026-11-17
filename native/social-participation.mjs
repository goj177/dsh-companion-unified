import {createHash} from 'node:crypto'
import {NativeStore} from './store.mjs'
import {isPlainObject} from './contracts.mjs'
import {tiebaReplyPaused} from './tieba-target.mjs'

const SOURCE='native_social_participation',SUBTYPE='self_participation_decision',DAY=86400000
const hash=value=>createHash('sha256').update(value).digest('hex')
const numeric=value=>typeof value==='string'&&/^[1-9][0-9]{0,29}$/.test(value)
const timestamp=value=>Number.isSafeInteger(value)&&value>=0&&value<=8640000000000000
const messageId=value=>typeof value==='string'&&/^(?:reply:)?[1-9][0-9]{0,39}$/.test(value)?value.replace(/^reply:/,''):''
const compact=value=>value.replace(/[\u0000-\u001f\u007f]/g,' ').replace(/\s+/g,' ').trim()
const json=value=>JSON.parse(value)
const fields=(value,allowed)=>{if(!isPlainObject(value)||Object.keys(value).some(key=>!allowed.includes(key)))throw Error('接话决定包含未定义字段')}
export const TIEBA_ADDRESSEES=Object.freeze(['self','other','general','unclear'])
export const TIEBA_ADDRESSEE_GUIDE='先结合原文、父楼、引用和同楼前后文判断这句话实际在跟谁说：addressee=self/other/general/unclear（本人/他人/泛讨论/不明）。提到AI、在自己的楼里或被通知，都不等于在跟你说；在谈其他人时选择skip，不把评论当成对你的攻击。只有确实在与你对话且值得接时选reply。没有已核验的收件UID时，reply还需填context_source_id，引用本次线索中你自己那条被接续的已核验发言。'
const recipientProof=new Set(['explicit_reply_uid','verified_sub_reply_quote','verified_post_quote','structured_mention_uid'])
function checkReplyAddressee(input,meta,scope,source_message_id){
  let envelope;try{envelope=json(meta.public_context)}catch{}
  const source=envelope?.source_context
  if(source?.address_kind==='third_party')throw Error('原来信的收件对象是其他人，不能自动回复')
  if(source?.address_kind==='account_self'&&recipientProof.has(source.recipient_verification)&&(source.reply_to_uid===scope.account_uid||source.mentioned_self===true&&source.mentioned_uids?.includes(scope.account_uid)))return
  const records=[...(envelope?.quoted_context?.records??[]),...(envelope?.nearby_context?.records??[])]
  if(!input.context_source_id||input.context_source_id===source_message_id||!records.some(row=>row.source_id===input.context_source_id&&row.author_uid===scope.account_uid&&['server_read','confirmed_local_receipt'].includes(row.verification)&&typeof row.text==='string'&&row.text.trim()))throw Error('仅收到楼层通知，回复需引用本次线索中一条与你实际接续的已核验发言；指向不明请选择skip')
}

/** A reply grant belongs to a single source and run, never the whole floor. */
export function hasContextualTiebaReplyDecision(store,{incoming_task_id,task_id,source_evidence_id,session_id}={}){
  if(!incoming_task_id||!task_id||!source_evidence_id)return false
  const where=" FROM journal_events WHERE source_type=? AND json_extract(metadata_json,'$.incoming_task_id')=? AND json_extract(metadata_json,'$.source_evidence_id')=?"
  if(store.db.prepare('SELECT 1'+where+" AND json_extract(metadata_json,'$.action') IN ('skip','pause') LIMIT 1").get(SOURCE,incoming_task_id,source_evidence_id))return false
  return !!store.db.prepare('SELECT 1'+where+" AND json_extract(metadata_json,'$.action')='reply' AND json_extract(metadata_json,'$.addressee')='self' AND json_extract(metadata_json,'$.task_id')=?"+(session_id===undefined?'':" AND json_extract(metadata_json,'$.session_id')=?")+' LIMIT 1').get(SOURCE,incoming_task_id,source_evidence_id,task_id,...(session_id===undefined?[]:[session_id]))
}

/** A model may decline its current, actually leased public incoming message.
 * It cannot grant permissions, alter a persona, or address another platform.
 * All effects are immutable local journal facts; ordinary replies need no call.
 */
export class NativeSocialParticipation{
  constructor({store,now=store?.now}={}){
    if(!(store instanceof NativeStore)||typeof now!=='function')throw Error('接话决定需要原生存储和可信时钟')
    this.store=store;this.now=now
  }
  _now(){const at=this.now();if(!timestamp(at))throw Error('接话决定时钟无效');return at}
  _settings(){const id=this.store.getDocument('settings')?.value.platform_document_ids?.tieba??'tieba',doc=this.store.getDocument(id);if(doc&&(doc.type!=='platform_settings'||doc.value.platform!=='tieba'))throw Error('贴吧设置类型错误');return doc?.value??{}}
  _account(){const entity_id=this._settings().account_entity_id,rows=entity_id?this.store.listPlatformIdentities({namespace:'tieba',entity_id,role:'account'}):[];return rows.length===1&&numeric(rows[0].platform_uid)?rows[0].platform_uid:''}
  _scope(input){
    if(input.platform!=='tieba'||!numeric(input.actor_uid)||typeof input.conversation_id!=='string'||!/^thread:[1-9][0-9]{0,29}:[1-9][0-9]{0,29}$/.test(input.conversation_id))throw Error('接话决定仅支持当前贴吧真实来者和精确楼层会话')
    const account_uid=this._account()
    if(!account_uid||input.account_uid!==undefined&&input.account_uid!==account_uid||input.actor_uid===account_uid)throw Error('接话决定账号绑定或来者身份不符')
    const scope={platform:'tieba',actor_uid:input.actor_uid,conversation_id:input.conversation_id,account_uid}
    return {...scope,scope_key:hash(JSON.stringify(scope))}
  }
  _event(key){const row=this.store.db.prepare('SELECT id,metadata_json FROM journal_events WHERE event_key=? AND source_type=?').get(key,SOURCE);return row?{id:row.id,...json(row.metadata_json)}:null}
  _state(scope){
    const row=this.store.db.prepare("SELECT id,metadata_json FROM journal_events WHERE source_type=? AND platform='tieba' AND actor_uid=? AND conversation_id=? AND json_extract(metadata_json,'$.scope_key')=? AND json_extract(metadata_json,'$.action') IN ('pause','resume') ORDER BY recorded_at DESC,rowid DESC LIMIT 1").get(SOURCE,scope.actor_uid,scope.conversation_id,scope.scope_key)
    return row?{id:row.id,...json(row.metadata_json)}:null
  }
  _key(scope,source_message_id){return 'native:social-participation:'+scope.scope_key+':'+source_message_id}
  _trusted(context,selector){
    if(!isPlainObject(context)||context.autonomous!==true||context.manual===true||context.owner_authorized===true||typeof context.task_id!=='string'||!context.task_id||typeof context.session_id!=='string'||!context.session_id||context.source_scope!=='activity:'+context.task_id||typeof context.incoming_task_id!=='string'||!context.incoming_task_id||typeof context.source_evidence_id!=='string'||!context.source_evidence_id)throw Error('接话决定必须绑定当前已消费的自主来信任务')
    const scope=this._scope(context),at=this._now()
    if(selector!==undefined&&selector!==scope.actor_uid)throw Error('actor_uid只能选择本轮真实来者')
    const task=this.store.db.prepare('SELECT id,platform,kind,status,target_json,metadata_json,source_evidence_id,CAST(body AS BLOB) body_bytes FROM actions WHERE id=?').get(context.incoming_task_id),meta=task?json(task.metadata_json):null,target=task?json(task.target_json):null
    if(!task||task.platform!=='tieba'||task.kind!=='activity.incoming'||!['leased','running'].includes(task.status)||task.source_evidence_id!==context.source_evidence_id||meta.execution!=='model'||meta.human!==true||meta.batch_id!==context.task_id||!meta.lease_token||!timestamp(meta.lease_until)||meta.lease_until<=at||meta.trigger==='manual')throw Error('接话决定需当前真实来信模型任务和有效租约；手动任务不受自选暂停影响')
    let account_uid;try{account_uid=json(meta.public_context)?.source_context?.account_self_uid}catch{}
    if(!numeric(account_uid)||account_uid!==scope.account_uid)throw Error('原来信账号未冻结或已换绑，不能跨账号写入接话决定')
    const evidence=this.store.db.prepare('SELECT id,platform,actor_uid,conversation_id,direction,source_type,visibility,status,source_json,source_message_id,source_at,recorded_at,CAST(text AS BLOB) text_bytes FROM evidence WHERE id=?').get(task.source_evidence_id),source=evidence?json(evidence.source_json):null
    const source_message_id=messageId(evidence?.source_message_id)
    if(!evidence||evidence.platform!==scope.platform||evidence.actor_uid!==scope.actor_uid||evidence.conversation_id!==scope.conversation_id||evidence.direction!=='in'||evidence.source_type!=='user'||evidence.visibility!=='public'||!['confirmed','pending','uncertain'].includes(evidence.status)||!['user','human','user_statement'].includes(source.kind)||!source_message_id||target.actor_uid!==scope.actor_uid||target.conversation_id!==scope.conversation_id||messageId(target.source_message_id)!==source_message_id||!Buffer.from(evidence.text_bytes).equals(Buffer.from(task.body_bytes)))throw Error('接话决定与实际来者、会话或原始来信不符')
    return {scope,task,meta,evidence,source_message_id,at}
  }
  /** Read-only prequeue and presend gate. Manual bypass is only for self choice;
   * an owner's explicit pause/cutoff always remains in force. */
  check(input={}){
    if(input.platform!=='tieba')return {paused:false,by:'unsupported_platform',until:0,skip_before:0}
    const scope=this._scope(input),at=this._now(),config=this._settings().tieba??{}
    let source_at=input.source_at,source_message_id=messageId(input.source_message_id)
    if(input.source_evidence_id!==undefined){
      const row=this.store.db.prepare('SELECT platform,actor_uid,conversation_id,visibility,source_type,direction,source_message_id,source_at FROM evidence WHERE id=?').get(input.source_evidence_id)
      if(!row||row.platform!==scope.platform||row.actor_uid!==scope.actor_uid||row.conversation_id!==scope.conversation_id||row.visibility!=='public'||row.source_type!=='user'||row.direction!=='in')throw Error('接话门禁来源不属于当前公开来信')
      if(source_message_id&&source_message_id!==messageId(row.source_message_id)||source_at!==undefined&&source_at!==null&&source_at!==row.source_at)throw Error('接话门禁来源坐标或时间不符')
      source_message_id=messageId(row.source_message_id);source_at=row.source_at
    }
    if(source_at!==undefined&&source_at!==null&&!timestamp(source_at))throw Error('接话门禁来源时间无效')
    if(tiebaReplyPaused(config,scope.actor_uid,at,source_at))return {paused:true,by:'owner',until:Math.max(0,...(config.reply_pauses??[]).filter(row=>row.actor_uid===scope.actor_uid).map(row=>row.until??0)),skip_before:Math.max(0,...(config.reply_pauses??[]).filter(row=>row.actor_uid===scope.actor_uid).map(row=>row.skip_before??0))}
    if(input.manual===true)return {paused:false,by:'manual_override',until:0,skip_before:0}
    const state=this._state(scope),current=source_message_id?this._event(this._key(scope,source_message_id)):null,until=state?.until??0,skip_before=state?.skip_before??0
    if(until>at)return {paused:true,by:'self_pause',until,skip_before}
    if(current&&['skip','pause'].includes(current.action))return {paused:true,by:'self_skip',until,skip_before}
    if(skip_before&&!(timestamp(source_at)))return {paused:true,by:'self_cutoff_unresolved',until,skip_before}
    if(skip_before&&source_at<skip_before)return {paused:true,by:'self_cutoff',until,skip_before}
    return {paused:false,by:'available',until,skip_before}
  }
  paused(input={}){return this.check(input).paused}
  decide(input={},trusted_context={}){
    fields(input,['action','reason','pause_minutes','actor_uid','addressee','context_source_id'])
    if(!['reply','skip','pause','resume'].includes(input.action)||typeof input.reason!=='string'||!input.reason.isWellFormed()||!compact(input.reason)||input.reason.length>240)throw Error('接话决定需要reply/skip/pause/resume和简短具体理由')
    if(input.pause_minutes!==undefined&&input.action!=='pause')throw Error('仅pause可设置暂停分钟数')
    if(input.addressee!==undefined&&!TIEBA_ADDRESSEES.includes(input.addressee))throw Error('谈话对象只能为self/other/general/unclear')
    if(input.context_source_id!==undefined&&!numeric(input.context_source_id))throw Error('上下文来源须为本次线索中的有效source_id')
    if(input.action==='reply'&&!input.addressee)throw Error('先结合上下文判断实际谈话对象，reply必须填写addressee')
    const action=input.action==='reply'&&input.addressee!=='self'?'skip':input.action,addressee=input.addressee??null,context_source_id=input.context_source_id??null
    const minutes=input.action==='pause'?input.pause_minutes??30:0
    if(!Number.isSafeInteger(minutes)||minutes<0||input.action==='pause'&&minutes<1||minutes>1440)throw Error('暂停时间须为1至1440分钟整数')
    this.store._write()
    return this.store.transaction(()=>{
      const {scope,task,meta,evidence,source_message_id,at}=this._trusted(trusted_context,input.actor_uid),reason=compact(input.reason),sourceKey=this._key(scope,source_message_id),key=action==='reply'?sourceKey+':reply:'+hash(JSON.stringify([trusted_context.task_id,trusted_context.session_id])):sourceKey,old=this._event(key)
      if(action==='reply'&&this._event(sourceKey))throw Error('这条来信已决定跳过或暂停，不能改成回复')
      if(old){if(old.action!==action||old.reason!==reason||old.pause_minutes!==minutes||(old.addressee??null)!==addressee||(old.context_source_id??null)!==context_source_id)throw Error('同一来信已有不同接话决定，保留原决定');return {ok:true,duplicate:true,action:old.action,until:old.until,skip_before:old.skip_before,journal_id:old.id,model_calls:0}}
      const state=this._state(scope),owner=tiebaReplyPaused(this._settings().tieba??{},scope.actor_uid,at,evidence.source_at)
      if(owner&&action==='resume')throw Error('模型不能恢复主人暂停的回复对象')
      if(action==='reply'&&(owner||state?.until>at||state?.skip_before&&evidence.source_at<state.skip_before))throw Error('当前来信已暂停接话，不能决定回复')
      if(action==='reply')checkReplyAddressee(input,meta,scope,source_message_id)
      let until=state?.until??0,skip_before=state?.skip_before??0,prior_skip_before=state?.prior_skip_before??0
      if(input.action==='pause'){prior_skip_before=state?.until>at?state.prior_skip_before??0:skip_before;until=Math.max(until,at+minutes*60000);skip_before=Math.max(skip_before,until)}
      if(input.action==='resume'){skip_before=until>at?Math.max(prior_skip_before,at):skip_before;until=0;prior_skip_before=skip_before}
      const metadata={subtype:SUBTYPE,schema_version:1,...scope,action,reason,...(addressee?{addressee}:{}),...(context_source_id?{context_source_id}:{}),pause_minutes:minutes,until,skip_before,prior_skip_before,source_message_id,source_evidence_id:evidence.id,incoming_task_id:task.id,task_id:trusted_context.task_id,session_id:trusted_context.session_id,decided_at:at,authority:'trusted_native_backend_only',emotion_inferred:false,model_calls:0,persona_unchanged:true,permissions_unchanged:true,no_publication:true}
      const event=this.store.appendJournalEvent({id:'journal:'+hash(key),event_key:key,event_type:'log',platform:'tieba',actor_uid:scope.actor_uid,conversation_id:scope.conversation_id,direction:'internal',status:'recorded',visibility:'owner',text:'',source_at:at,recorded_at:at,source_type:SOURCE,metadata})
      return {ok:true,duplicate:false,action,until,skip_before,journal_id:event.id,model_calls:0}
    })
  }
  /** Small factual context only. Incoming text is already in the task body;
   * counts do not imply annoyance, hostility, or an obligation to respond. */
  context(trusted_context={}){
    const {scope,evidence,at}=this._trusted(trusted_context),since=at-DAY
    const incoming=this.store.db.prepare("SELECT COUNT(*) n FROM evidence e WHERE e.platform='tieba' AND e.actor_uid=? AND e.conversation_id=? AND e.visibility='public' AND e.direction='in' AND e.source_type='user' AND e.id<>? AND e.recorded_at>=? AND e.recorded_at<=? AND e.source_at>=? AND e.source_at<=? AND e.status IN ('confirmed','pending','uncertain') AND json_extract(e.source_json,'$.kind') IN ('user','human','user_statement') AND EXISTS(SELECT 1 FROM actions a WHERE a.source_evidence_id=e.id AND a.platform=e.platform AND a.kind='activity.incoming' AND json_extract(a.metadata_json,'$.human')=1 AND json_extract(a.metadata_json,'$.execution')='model' AND json_extract(a.target_json,'$.actor_uid')=e.actor_uid AND json_extract(a.target_json,'$.conversation_id')=e.conversation_id AND CAST(a.body AS BLOB)=CAST(e.text AS BLOB))").get(scope.actor_uid,scope.conversation_id,evidence.id,since,at,since,at).n
    const [,thread_id,post_id]=scope.conversation_id.split(':')
    // Some older actions have no account binding. Only count a receipt that is
    // also attributable to the currently bound account; never guess by nickname.
    const confirmed=this.store.db.prepare("SELECT COUNT(*) n FROM actions a WHERE a.platform='tieba' AND a.kind='tieba.reply' AND a.status='confirmed' AND a.confirmed_at>=? AND a.confirmed_at<=? AND json_extract(a.target_json,'$.reply_uid')=? AND json_extract(a.target_json,'$.thread_id')=? AND json_extract(a.target_json,'$.post_id')=? AND json_extract(a.receipt_json,'$.source')='server_receipt' AND json_extract(a.receipt_json,'$.accepted')=1 AND CAST(json_extract(a.receipt_json,'$.server_id') AS TEXT) NOT IN ('','0') AND EXISTS(SELECT 1 FROM evidence e WHERE e.platform='tieba' AND e.actor_uid=? AND e.conversation_id IN (?,?) AND e.visibility='public' AND e.direction='out' AND e.source_type='server_action' AND e.status='confirmed' AND e.confirmation='server_receipt' AND e.source_message_id=CAST(json_extract(a.receipt_json,'$.server_id') AS TEXT))").get(since,at,scope.actor_uid,thread_id,post_id,scope.account_uid,'thread:'+thread_id,scope.conversation_id).n
    const state=this._state(scope),parts=[]
    if(incoming||confirmed)parts.push('本楼近24小时可核对的此前来信'+incoming+'条、已确认回应'+confirmed+'条。')
    if(state?.action==='pause')parts.push(state.until>at?'此前自己选择暂缓接话，剩余约'+Math.ceil((state.until-at)/60000)+'分钟。':'此前自选暂停已到期；暂停截止前旧来信不补回。')
    if(state?.action==='resume')parts.push('此前已自行恢复接话；旧来信截止线保留。')
    if(parts.length)parts.push('是否接话由当前有效人设和来信内容决定。')
    return parts.join('').slice(0,220)
  }
}
