import { NativeStore } from './store.mjs'
import {assertTiebaPublishableText} from './tieba-content.mjs'
import {assertTiebaActionTarget,tiebaReplyPaused} from './tieba-target.mjs'
import {checkedTiebaEmotes} from './tieba-media.mjs'
import {NativeRoundPolicy} from './round-policy.mjs'
import { NativeOutbox,actionVisibility } from './outbox.mjs'
import { isPlainObject } from './contracts.mjs'
import {NativeSharing,isCompletedShareIntent,SharingPolicyError} from './sharing.mjs'
import {moderationTarget} from './qq-moderation.mjs'
import {currentRunScope,withRunScope,assertRunActive,abortableRun} from './run-scope.mjs'

const KINDS=new Set(['qq.send','qq.profile','tieba.reply','tieba.post','tieba.message','tieba.sign','tieba.follow','tieba.unfollow',
  'bilibili.comment','bilibili.reply','bilibili.dynamic','bilibili.share','bilibili.like','bilibili.coin','qq.mute','qq.unmute'])
const fields=(v,keys)=>{if(!isPlainObject(v)||Object.keys(v).some(k=>!keys.includes(k)))throw new Error('社交操作包含不支持的字段')}
const PLATFORM_LABEL={qq:'QQ',tieba:'贴吧',bilibili:'B站'}
const finiteTime=value=>Number.isSafeInteger(value)&&value>=0
export const isQQModeration=kind=>kind==='qq.mute'||kind==='qq.unmute'
const isStateAction=kind=>isQQModeration(kind)||kind==='tieba.sign'
export function normalizeQQModerationTarget(kind,target,context={}){
  if(!isQQModeration(kind))throw new Error('未知群管理操作')
  fields(target,['conversation_id','member_uid','duration_seconds'])
  const conversation_id=target.conversation_id??context.moderation_intent?.conversation_id??(context.platform==='qq'&&/^group:[1-9]\d*$/.test(context.conversation_id??'')?context.conversation_id:undefined),member_uid=target.member_uid,duration_seconds=target.duration_seconds??(kind==='qq.unmute'?0:context.moderation_intent?.duration_seconds)
  if(conversation_id===undefined)throw new Error('请明确要管理的QQ群号；群内命令可使用本群')
  if(member_uid===undefined)throw new Error('请明确成员QQ号或真实@成员，不能按昵称猜人')
  if(duration_seconds===undefined)throw new Error('禁言需要明确时长，缺少时请先问清')
  const checked=moderationTarget(kind,{conversation_id,member_uid,duration_seconds})
  return {conversation_id:checked.conversation_id,member_uid:checked.member_uid,duration_seconds:checked.duration_seconds}
}
export function qqModerationAuthorized(kind,target,context={}){
  if(!isQQModeration(kind)||context.autonomous===true||!['qq','harness'].includes(context.platform)||context.can_moderate_group!==true||!context.source_scope)return false
  const intent=context.moderation_intent
  return intent?.kind===kind&&intent.conversation_id===target.conversation_id&&intent.member_uid===target.member_uid&&intent.duration_seconds===target.duration_seconds
}

/** All foreground, autonomous and prepared publications reach these providers. */
export class NativeSocial {
  constructor({store,providers={},memory_runtime,activity,now=Date.now}={}){
    if(!(store instanceof NativeStore)||typeof now!=='function')throw new Error('社交操作需要原生存储')
    this.store=store;this.providers=providers;this.memory=memory_runtime;this.activity=activity;this.now=now
    this.outbox=new NativeOutbox({store,now});this.running=new Map()
    this.sharing=new NativeSharing({store,qq:providers.qq,bilibili:providers.bilibili,now})
    // NativeQQ's own flush must use the same network-boundary policy. Host Core
    // may inject a guarded callback instead; never replace an existing guard.
    if(providers.qq&&providers.qq.before_send===undefined)providers.qq.before_send=action=>this.before_send(action)
  }
  _now(){const at=this.now();if(!finiteTime(at))throw new Error('社交时钟无效');return at}
  _permission(kind,target={}){
    const platform=kind.split('.')[0],cfg=this.store.getDocument(platform)?.value
    if(!cfg||cfg.enabled!==true||this.store.getDocument('settings')?.value.enabled===false)throw new Error(PLATFORM_LABEL[platform]+'功能已关闭')
    const permissions=cfg[platform]?.permissions??{}
    if(platform==='bilibili'){
      const dm=target.channel==='dm'||target.via==='dm',live=target.channel==='live',via=target.via??cfg.bilibili?.sharing?.via
      const flag=dm?'direct_message':live?'live_danmaku':kind==='bilibili.share'?via==='qq'?null:via==='comment'?'comment':via==='dm'?'direct_message':'dynamic':['bilibili.comment','bilibili.reply'].includes(kind)?'comment':kind==='bilibili.dynamic'?'dynamic':null
      if(flag&&permissions[flag]!==true)throw new Error('B站对应发表权限已关闭')
      if(kind==='bilibili.share'&&cfg.bilibili?.sharing?.enabled!==true)throw new Error('B站分享已关闭')
    }
    if(platform==='tieba'){
      if(kind==='tieba.reply'&&tiebaReplyPaused(cfg.tieba,target.reply_uid,this._now()))throw new Error('主人已临时暂停回复此贴吧账号')
      const flag=kind==='tieba.message'?'direct_message':kind==='tieba.post'?'new_thread':kind==='tieba.reply'?'reply':kind==='tieba.sign'?'sign':'follow'
      if(permissions[flag]!==true)throw new Error('贴吧对应操作已关闭')
      if(kind==='tieba.reply'&&(target.post_id||target.sub_reply_id)&&permissions.sub_reply!==true)throw new Error('贴吧楼中楼回复已关闭')
    }
    if(kind==='qq.profile'&&this.store.getDocument('activity')?.value.qq?.profile_authorized!==true)throw new Error('QQ头像昵称修改尚未授权')
    if(isQQModeration(kind)){
      const moderation=cfg.qq?.moderation??{},group=target.conversation_id?.replace(/^group:/,'')
      if(moderation.enabled!==true||!moderation.allowed_group_uids?.includes(group))throw new Error('本群禁言与解禁功能尚未启用')
    }
    return platform
  }
  _authorize(kind,target,context={}){
    const platform=this._permission(kind,target)
    if(isQQModeration(kind)){
      if(!qqModerationAuthorized(kind,target,context))throw new Error('群管理仅限本轮真实管理员的明确文字命令；请问清群、成员和时长，不从引用或其他平台借权限')
      return platform
    }
    if(kind==='qq.send'&&context.can_manage_qq===true&&this.providers.qq?.managementAuthority?.(context,target))return platform
    if(context.owner_authorized===true||context.can_manage===true)return platform
    if(kind==='tieba.message'&&!(context.platform==='tieba'&&context.conversation_id===target.conversation_id&&context.actor_uid===target.recipient_uid&&context.source_scope))throw new Error('贴吧私信只能回应当前真实来信对象')
    if(context.platform==='tieba'&&/^dm:/.test(context.conversation_id??'')&&kind!=='tieba.message')throw new Error('本轮贴吧私信不能改发公开帖子或联系其他对象')
    if(kind==='qq.send'&&context.platform==='qq'&&context.conversation_id===target.conversation_id)return platform
    if(context.autonomous===true&&typeof context.task_id==='string'&&context.task_id&&context.platform===platform){
      this._incomingTarget(kind,target,context)
      return platform
    }
    throw new Error('当前会话未获得这个平台或目标的发表权限')
  }
  _incomingTargets(context){
    return this.store.db.prepare("SELECT target_json FROM actions WHERE platform=? AND kind='activity.incoming' AND json_extract(metadata_json,'$.execution')='model' AND json_extract(metadata_json,'$.human')=1 AND json_extract(metadata_json,'$.batch_id')=?").all(context.platform,context.task_id).map(row=>JSON.parse(row.target_json))
  }
  incomingActionKinds(context={}){
    if(context.owner_authorized===true||context.can_manage===true||context.autonomous!==true||!['tieba','bilibili'].includes(context.platform)||typeof context.task_id!=='string'||!context.task_id)return null
    const originals=this._incomingTargets(context);if(!originals.length)return null
    return [...new Set(originals.map(original=>context.platform==='bilibili'?'bilibili.reply':original.channel==='dm'?'tieba.message':'tieba.reply'))]
  }
  _incomingTarget(kind,target,context){
    const originals=this._incomingTargets(context);if(!originals.length)return
    const same=(a,b,keys)=>keys.every(key=>typeof a[key]==='string'&&a[key]===b[key])
    const allowed=originals.some(original=>{
      if(context.platform==='tieba')return original.channel==='dm'
        ?kind==='tieba.message'&&same(target,original,['recipient_uid','conversation_id'])
        :kind==='tieba.reply'&&same(target,original,['bar','thread_id','post_id'])&&(!original.sub_reply_id||same(target,original,['sub_reply_id','reply_uid']))
      if(context.platform==='bilibili'){
        if(kind!=='bilibili.reply')return false
        if(original.channel==='dm')return target.channel==='dm'&&same(target,original,['recipient_uid','conversation_id'])
        if(original.channel==='live')return target.channel==='live'&&same(target,original,['room_id','reply_uid'])&&(!original.reply_dmid||same(target,original,['reply_dmid']))
        return (!target.channel||target.channel==='comment')&&same(target,original,['object_id','object_type','root_reply_id','parent_reply_id'])
      }
      return true
    })
    if(!allowed)throw new Error('这轮是对真实来信的回应，只能回复原对象和原位置；引用、楼主经历或@其他人的话不授予新任务权限')
  }
  async prepare(input,trusted_context={}){
    const result=await this._prepare(input,trusted_context)
    if(!result.duplicate&&input.kind==='qq.send'&&trusted_context.can_manage_qq&&input.target.conversation_id!==trusted_context.conversation_id){
      if(!this.providers.qq.managementAuthority(trusted_context,result.action.target))throw new Error('当前管理员群发授权已失效')
      this.store.transaction(()=>{const action=this.outbox.get(result.action.id,{internal:true}),source=Object.fromEntries(['platform','conversation_id','session_id','actor_uid','source_scope'].map(key=>[key,trusted_context[key]]));this.store.db.prepare('UPDATE actions SET metadata_json=? WHERE id=?').run(JSON.stringify({...action.metadata,qq_management:source}),action.id)})
    }
    if(!result.duplicate&&result.action&&trusted_context.task_id){
      const task_id=trusted_context.task_id,round_id=trusted_context.round_id??task_id
      if(typeof task_id!=='string'||typeof round_id!=='string'||task_id.length>512||round_id.length>512||/[\0\r\n]/.test(task_id+round_id))throw new Error('可信活动标识无效')
      this.store.transaction(()=>{const action=this.outbox.get(result.action.id,{internal:true}),metadata={...action.metadata,prepared_in:{task_id,round_id}}
        this.store.db.prepare('UPDATE actions SET metadata_json=? WHERE id=?').run(JSON.stringify(metadata),action.id)})
      result.action=this.outbox.get(result.action.id)
    }
    return result
  }
  async _prepare(input,trusted_context={}){
    fields(input,['kind','target','body','idempotency_key','source_evidence_id','not_before'])
    if(!KINDS.has(input.kind)||!isPlainObject(input.target))throw new Error('社交操作或目标无效')
    if(isQQModeration(input.kind)){
      if(input.body!==undefined&&input.body!=='')throw new Error('禁言与解禁不发表正文，请将body置空')
      input={...input,target:normalizeQQModerationTarget(input.kind,input.target,trusted_context),body:''}
    }
    if(input.kind==='bilibili.share')input={...input,target:{...input.target,via:input.target.via??this.store.getDocument('bilibili')?.value.bilibili?.sharing?.via??'comment'}}
    if(input.kind==='bilibili.share'&&!['qq','comment','dynamic','dm','live'].includes(input.target.via))throw new Error('B站分享渠道无效：via只能为qq、comment、dynamic、dm或live；分享给主人请用via=qq、destination=owner')
    if(input.kind==='bilibili.reply'&&!['comment','dm','live'].includes(input.target.channel??'comment'))throw new Error('B站回复渠道无效：channel只能为comment、dm或live；回复评论可省略channel')
    const platform=this._authorize(input.kind,input.target,trusted_context),provider=this.providers[platform]
    if(!provider)throw new Error(PLATFORM_LABEL[platform]+'执行器尚未就绪')
    if(platform==='tieba'&&input.kind!=='tieba.message'){assertTiebaActionTarget(input.kind,input.target);checkedTiebaEmotes(input.target.emotes??[])}
    if(input.kind==='qq.send'){
      if(!provider.prepare)throw new Error('QQ统一准备接口尚未就绪')
      const target=input.target,origin=trusted_context.platform==='qq'&&trusted_context.conversation_id===target.conversation_id?'reply':'proactive'
      const segments=target.segments??[{type:'text',text:input.body??''}]
      return provider.prepare({conversation_id:target.conversation_id,segments,origin,idempotency_key:input.idempotency_key,
        source_evidence_id:input.source_evidence_id,...(trusted_context.session_id?{session_id:trusted_context.session_id}:{})})
    }
    if(input.kind==='qq.profile'){
      if(!provider.prepareProfile)throw new Error('QQ资料准备接口尚未就绪')
      return provider.prepareProfile({...input.target,idempotency_key:input.idempotency_key})
    }
    if(isQQModeration(input.kind)){
      if(typeof provider.prepareModeration!=='function')throw new Error('原生QQ群管理执行器尚未就绪')
      return provider.prepareModeration({operation:input.kind==='qq.mute'?'mute':'unmute',...input.target,idempotency_key:input.idempotency_key,...(input.source_evidence_id?{source_evidence_id:input.source_evidence_id}:{})},trusted_context)
    }
    if(typeof input.body!=='string')throw new Error('请提供完整正文；不自动改写已准备内容')
    if(platform==='tieba'&&['tieba.reply','tieba.post'].includes(input.kind))assertTiebaPublishableText(input.body)
    if(input.kind==='bilibili.share'&&input.target.via==='qq')return this.sharing.prepare(input,trusted_context)
    const result=this.outbox.prepare({platform,kind:input.kind,target:input.target,body:input.body,idempotency_key:input.idempotency_key,
      source_evidence_id:input.source_evidence_id,not_before:input.not_before,approval:'required'})
    if(input.kind==='bilibili.share')result.action=this.sharing.decorate(result.action,trusted_context)
    return result
  }
  approve(action_id,{expected_digest},trusted_context={}){
    return this.store.transaction(()=>{
      const action=this.outbox.get(action_id,{internal:true});if(!action)throw new Error('草稿不存在')
      this._authorize(action.kind,action.target,trusted_context)
      if(action.status==='draft'&&['tieba','bilibili'].includes(action.platform))new NativeRoundPolicy({store:this.store,platform:action.platform,now:this.now}).checkApproval(action)
      return this.outbox.approve(action_id,{expected_digest})
    })
  }
  async execute(input,{mode='dry',context={}}={}){
    if(!['dry','go'].includes(mode))throw new Error('请选择预览或执行')
    const prepared=await this.prepare(input,context)
    if(mode==='dry')return {ok:true,status:prepared.action.status,action:prepared.action,duplicate:prepared.duplicate}
    if(!['draft','queued'].includes(prepared.action.status)){const done=prepared.action.status==='confirmed'||isCompletedShareIntent(this.store,prepared.action);return {ok:done,status:prepared.action.status,action:prepared.action,duplicate:true,published:!isStateAction(prepared.action.kind)&&done,...(isStateAction(prepared.action.kind)?{executed:done}:{})}}
    const approval=this.approve(prepared.action.id,{expected_digest:prepared.action.request_digest},context)
    // Explicit operator commands do not enter autonomous quiet-hour scheduling
    // or reserve a model wake. The exact same Outbox/QQ dispatcher still owns
    // the network boundary, receipt and unknown/no-replay behavior.
    if(isQQModeration(prepared.action.kind)||prepared.action.kind==='qq.send'&&context.platform==='qq'&&(context.can_manage===true||context.can_manage_qq===true)&&context.conversation_id?.startsWith('private:'))return this.dispatch(prepared.action.id,{authorization:approval.authorization,expected_digest:prepared.action.request_digest})
    if(this.activity){
      const carrier=this.activity.enqueuePublication({platform:prepared.action.platform,action_id:prepared.action.id})
      if(carrier.task.status==='draft')this.activity.activatePublication(carrier.task.id,{expected_digest:carrier.task.request_digest})
      return {ok:true,status:this.outbox.get(prepared.action.id).status,action:this.outbox.get(prepared.action.id),task:this.activity.get(carrier.task.id),published:false}
    }
    return this.dispatch(prepared.action.id,{authorization:approval.authorization,expected_digest:prepared.action.request_digest})
  }
  async dispatch(action_id,grant,controls){
    return withRunScope(controls?{...controls,now:this.now}:undefined,()=>this._dispatchShared(action_id,grant))
  }
  async _dispatchShared(action_id,grant){
    assertRunActive()
    const action=this.outbox.get(action_id,{internal:true})
    if(!action||!grant?.authorization||action.approval_token!==grant.authorization||action.request_digest!==grant.expected_digest)throw new Error('发表授权或正文目标已变化')
    if(this.running.has(action_id))return this.running.get(action_id)
    const work=this._dispatch(action_id,grant);this.running.set(action_id,work)
    try{return await work}finally{if(this.running.get(action_id)===work)this.running.delete(action_id)}
  }
  async _dispatch(action_id,{authorization,expected_digest}={}){
    const scope=currentRunScope()
    assertRunActive(scope)
    const original=this.outbox.get(action_id,{internal:true})
    if(!original||!authorization||original.approval_token!==authorization||original.request_digest!==expected_digest)throw new Error('发表授权或正文目标已变化')
    if(original.status==='confirmed'||isCompletedShareIntent(this.store,original))return {ok:true,status:original.status,action:this.outbox.get(action_id),duplicate:true,published:!isStateAction(original.kind),...(isStateAction(original.kind)?{executed:true}:{})}
    if(original.status!=='queued')return {ok:false,status:original.status,action:this.outbox.get(action_id),published:false}
    try{this._permission(original.kind,original.target)}catch(error){return {ok:false,status:'disabled',message:error.message,action:this.outbox.get(action_id),published:false}}
    const provider=this.providers[original.platform]
    if(!provider)throw new Error('平台执行器尚未就绪')
    const not_before=provider.nextPublicationAt?.(original)
    if(finiteTime(not_before)&&not_before>this._now()){
      const detail=provider.publicationWaitDetail?.(original)??'等待平台发表间隔，尚未领取发送租约'
      this.store.db.prepare("UPDATE actions SET not_before=?,metadata_json=? WHERE id=? AND status='queued' AND request_digest=?").run(not_before,JSON.stringify({...original.metadata,last_detail:detail}),action_id,expected_digest)
      const action=this.outbox.get(action_id)
      return {ok:false,status:action.status,action,published:false,not_before:action.not_before,message:detail}
    }
    if(original.kind==='bilibili.share'&&original.target.via==='qq')return this.sharing.dispatch(action_id,{authorization,expected_digest})
    if(original.platform==='qq'){
      await provider.dispatch(action_id);const action=this.outbox.get(action_id)
      return {ok:action.status==='confirmed',status:action.status,action,published:!isQQModeration(action.kind)&&action.status==='confirmed',...(isQQModeration(action.kind)?{executed:action.status==='confirmed'}:{}),not_before:action.not_before}
    }
    const images=original.target.asset_ids?.length??0,gap=this.store.getDocument(original.platform)?.value[original.platform]?.risk?.write_gap_ms??0
    // A scheduled publication owns bounded preflight time, not merely the old
    // two-minute write lease. It can never outlive its carrier or task timeout.
    const lease_ms=Number.isSafeInteger(scope?.deadline_at)?Math.min(3600000,Math.max(1,scope.deadline_at-this._now())):
      Math.min(3600000,Math.max(120000,(images+1)*Math.max(0,gap)+120000))
    const lease=this.outbox.lease(action_id,{authorization,expected_digest,lease_ms})
    if(!lease.allowed)return {ok:false,status:lease.action.status,action:lease.action,published:false,not_before:lease.action.not_before}
    let network_started=false,result,policy_failure
    try{
      if(original.kind==='bilibili.share')this.sharing.check(original)
      result=await abortableRun(provider.submit(this.outbox.get(action_id,{internal:true}),{mark_network_started:()=>{
        try{this.store.transaction(()=>{
          assertRunActive(scope)
          const action=this.outbox.get(action_id,{internal:true})
          if(!action||!['leased','submitting'].includes(action.status)||action.request_digest!==expected_digest||action.metadata.lease_token!==lease.lease_token||action.metadata.lease_until<=this._now())throw new Error('发表动作租约已结束，未继续网络写入')
          this.before_send(action)
          if(network_started)return
          scope?.mark_started?.()
          this.outbox.markNetworkStarted(action_id,lease.lease_token)
          network_started=true
        })}catch(error){policy_failure=error;throw error}
      },signal:scope?.signal,deadline_at:scope?.deadline_at,assert_active:()=>assertRunActive(scope),round_id:original.metadata.prepared_in?.round_id}),scope)
      if(policy_failure&&!network_started)throw policy_failure
      if(!result||!['confirmed','unknown','blocked','not_started'].includes(result.outcome))throw new Error('平台未返回可核对结果')
      this.outbox.finish(action_id,{lease_token:lease.lease_token,outcome:result.outcome,proof:result.proof,detail:result.detail??''})
    }catch(error){
      const outcome=network_started?'unknown':error.native_action_outcome==='blocked'?'blocked':'not_started'
      if(['leased','submitting'].includes(this.outbox.get(action_id)?.status))this.outbox.finish(action_id,{lease_token:lease.lease_token,outcome,detail:error.native_action_outcome?error.message:'本次提交未获得完整回执；原动作保留，未确认的发送不会自动重发。'})
      result={outcome,detail:error.native_action_outcome?error.message:'未获得完整平台回执',...(finiteTime(error.not_before)?{not_before:error.not_before}:{})}
    }
    const action=this.outbox.get(action_id)
    if(action.status==='queued'&&finiteTime(result.not_before))this.store.db.prepare('UPDATE actions SET not_before=? WHERE id=?').run(result.not_before,action_id)
    const platformState=this.store.getDocument('platform-state-'+action.platform)?.value
    if(action.status==='blocked'&&(result.platform_block_requested===true||platformState?.verification_required===true
      ||finiteTime(platformState?.paused_until)&&platformState.paused_until>this._now()))this.activity?.blockPlatform?.(action.platform,{reason:result.detail||'平台要求完成验证',until:platformState?.verification_required?null:platformState?.paused_until??null})
    // Local receipt registration cannot cause a confirmed network action to
    // be sent again, even if the memory writer is temporarily unavailable.
    const registered=typeof result.memory_evidence_id==='string'?this.store.db.prepare('SELECT platform,status,source_type,source_message_id,CAST(text AS BLOB) text_bytes FROM evidence WHERE id=?').get(result.memory_evidence_id):null
    const alreadyRecorded=action.status==='confirmed'&&registered?.platform===action.platform&&registered.status==='confirmed'&&registered.source_type==='server_action'
      &&registered.source_message_id===action.receipt.server_id&&Buffer.from(registered.text_bytes).toString('utf8')===action.body
    if(this.memory&&!alreadyRecorded&&action.kind!=='tieba.sign'){try{
      const visibility=actionVisibility(action),receipt=action.status==='confirmed'?{ok:true,status:'confirmed',id:action.receipt.server_id,code:0}:{ok:false,status:action.status}
      this.memory.ingestActionReceipt({platform:action.platform,conversation_id:visibility.conversation_id||String(action.target.thread_id??action.target.object_id??'public'),
        actor_uid:'self',kind:['reply','comment','post','dynamic'].includes(action.kind.split('.')[1])?action.kind.split('.')[1]:'action',text:action.body,
        source_message_id:action.receipt.server_id??'',source_at:action.confirmed_at??action.updated_at,visibility:visibility.visibility,receipt})
    }catch{}}
    return {ok:action.status==='confirmed',status:action.status,action,published:action.kind!=='tieba.sign'&&action.status==='confirmed',...(action.kind==='tieba.sign'?{executed:action.status==='confirmed'}:{}),message:result.detail??'',not_before:this.outbox.get(action_id).not_before}
  }
  async publicationRunner(batch,controls={}){
    const publication=batch.publication
    if(!publication)throw new Error('缺少已冻结的发表动作')
    const timeout=this.store.getDocument(this.activity?.policy_id??'activity')?.value.batching?.task_timeout_ms??600000
    const deadline_at=Math.min(...[controls.deadline_at,batch.lease_until,this._now()+timeout].filter(finiteTime))
    const assert_active=()=>{
      controls.assert_active?.()
      // Retain a carrier check even when an older caller omits controls.
      for(const task of batch.tasks??[]){
        const row=this.store.db.prepare('SELECT status,metadata_json FROM actions WHERE id=?').get(task.id),metadata=row?JSON.parse(row.metadata_json):{}
        if(!row||!['leased','running'].includes(row.status)||metadata.batch_id!==batch.id||metadata.lease_until<=this._now())throw new Error('活动发表租约已结束，未继续网络写入')
      }
    }
    const scope={signal:controls.signal,deadline_at,now:this.now,assert_active,mark_started:controls.mark_started}
    const result=await this.dispatch(publication.id,{authorization:publication.approval_token,expected_digest:publication.request_digest},scope)
    if(controls.signal?.aborted||this._now()>=deadline_at)return {status:'unknown',reason:'活动已取消或超时，原动作结果不自动重放'}
    return result.status==='confirmed'||isCompletedShareIntent(this.store,result.action)?{status:'completed'}:result.status==='queued'||result.status==='disabled'?{status:'not_started',retry:true,not_before:finiteTime(result.not_before)&&result.not_before>this._now()?result.not_before:this._now()+60000,reason:result.message??result.status}:
      {status:result.status==='blocked'?'blocked':'unknown',reason:result.message??result.status}
  }
  before_send(action){
    if(!action||typeof action.kind!=='string')throw new Error('发送闸缺少原生动作')
    if(action.target?.share_intent_id)this._permission('bilibili.share',{via:'qq'})
    this._permission(action.kind,action.target)
    if(action.metadata?.qq_management&&!this.providers.qq?.managementAuthority?.(action.metadata.qq_management,action.target))throw new Error('原私聊管理员指令已失效，未开始发送，不补发')
    const proactive=action.kind==='bilibili.share'||action.kind==='qq.profile'||action.kind==='qq.send'&&action.target.origin!=='reply'&&!action.metadata?.qq_management
    if(proactive){
      const activity=this.store.getDocument(this.activity?.policy_id??'activity')?.value,state=this.store.getDocument(this.activity?.state_id??'activity:state')?.value,platforms=action.target.share_intent_id?['bilibili','qq']:[action.platform],now=this._now()
      if(activity?.enabled===false)throw new SharingPolicyError('自主活动已暂停，发送保持未开始',{code:'activity_disabled',retryable:true,retry_at:now+60000})
      const block=state?.blocks?.find(row=>platforms.includes(row.platform)&&(row.until===null||row.until===undefined||row.until>now))
      if(block)throw new SharingPolicyError('平台活动已暂停：'+block.reason,{code:'activity_platform_blocked',retryable:true,retry_at:block.until??now+300000})
      for(const platform of platforms){const platformState=this.store.getDocument('platform-state-'+platform)?.value;if(platformState?.verification_required||platformState?.paused_until>now)throw new SharingPolicyError('平台要求验证或退避，未开始发送',{code:'platform_verification',retryable:true,retry_at:platformState.paused_until??now+300000})}
    }
    return this.sharing.before_send(action)
  }
}
