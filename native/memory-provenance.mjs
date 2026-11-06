import {NativeStore} from './store.mjs'
import {contextOf,digest,fields,identifier,rawText,timestamp,uid} from './memory-rules.mjs'

const SOURCE_TYPE='native_memory_provenance',keyOf=id=>'native:memory-source-binding:'+id
const consumptionKey=id=>'native:memory-source-consumption:'+id
const sourceOf=(store,id)=>store.db.prepare('SELECT id,platform,conversation_id,visibility,recorded_at FROM evidence WHERE id=?').get(id)
const domainOf=row=>({platform:row.platform,conversation_id:row.conversation_id,visibility:row.visibility})
const sameDomain=(a,b)=>a?.platform===b?.platform&&a?.conversation_id===b?.conversation_id&&a?.visibility===b?.visibility
const bindingOf=(store,id)=>{
  const row=store.db.prepare('SELECT metadata_json FROM journal_events WHERE event_key=? AND source_type=?').get(keyOf(id),SOURCE_TYPE)
  if(!row)return null
  const value=JSON.parse(row.metadata_json)
  return value.subtype==='memory_source_binding'&&value.evidence_id===id&&value.authority==='trusted_native_backend_only'?value:null
}
const consumptionOf=(store,id)=>{
  const row=store.db.prepare('SELECT metadata_json FROM journal_events WHERE event_key=? AND source_type=?').get(consumptionKey(id),SOURCE_TYPE)
  if(!row)return null
  const value=JSON.parse(row.metadata_json)
  return value.subtype==='memory_source_consumption'&&value.evidence_id===id&&value.authority==='trusted_native_backend_only'?value:null
}
function authority(store,context){
  if(!context)return {allowed:false,reason:'missing_source_context'}
  const settings=store.getDocument('settings')?.value
  if(settings?.memory?.disabled_workspace_ids?.includes(context.workspace_id))return {allowed:false,reason:'workspace_memory_disabled'}
  if(['read_memory','write_memory','consolidate_memory'].some(key=>context[key]===false))return {allowed:false,reason:'original_context_denied'}
  const policies=store.db.prepare("SELECT value_json FROM documents WHERE type='session_policy' AND json_extract(value_json,'$.session_id')=?").all(context.session_id).map(row=>JSON.parse(row.value_json))
  if(policies.some(row=>row.workspace_id&&row.workspace_id!==context.workspace_id||['read_memory','write_memory','consolidate_memory'].some(key=>row[key]===false)))return {allowed:false,reason:'session_policy_denied'}
  return {allowed:true,reason:'bound_original_source'}
}
function normalize(value){
  if(value===undefined||value===null)return null
  fields(value,['session_id','workspace_id','platform','conversation_id','owner_authorized','include_secret','allow_global_summary','read_memory','write_memory','consolidate_memory'],'可信记忆来源上下文')
  const session_id=uid(value.session_id,'session_id'),workspace_id=rawText(value.workspace_id,'workspace_id',512,true)
  if(!session_id||workspace_id.includes('\0')||workspace_id.trim()!==workspace_id)throw new Error('可信记忆来源缺少原会话或工作区')
  const context=contextOf(Object.fromEntries(['platform','conversation_id','owner_authorized','include_secret','allow_global_summary'].filter(key=>value[key]!==undefined).map(key=>[key,value[key]])))
  if(!context.platform||context.conversation_id===undefined)throw new Error('可信记忆来源缺少确切平台或会话')
  for(const key of ['read_memory','write_memory','consolidate_memory'])if(value[key]!==undefined&&typeof value[key]!=='boolean')throw new Error('记忆来源权限必须为布尔值')
  return {session_id,workspace_id,platform:context.platform,conversation_id:context.conversation_id,owner_authorized:context.owner_authorized===true,
    read_memory:value.read_memory!==false,write_memory:value.write_memory!==false,consolidate_memory:value.consolidate_memory!==false}
}

/** Trusted host ingestion only; never expose as a model/admin write tool.
 * Call once, immediately after a newly recorded (!duplicate) evidence result,
 * even if its original host context is unknown. The first immutable binding,
 * including a denial, cannot be replaced by a later read in a stronger session.
 * Old evidence is deliberately not backfilled from a current adapter/session.
 */
export function recordNativeMemorySourceBinding({store,evidence,context,now=store?.now}={}){
  if(!(store instanceof NativeStore)||typeof now!=='function')throw new Error('记忆来源绑定需原生存储与可信时钟')
  store._open();identifier(evidence?.id,'evidence.id')
  if(store.readOnly)return {recorded:false,status:'read_only'}
  return store.transaction(()=>{
    const previous=bindingOf(store,evidence.id)
    if(previous)return {recorded:false,duplicate:true,accepted:previous.accepted,reason:previous.reason}
    const row=sourceOf(store,evidence.id)
    if(!row||!sameDomain(row,evidence))throw new Error('记忆来源绑定必须引用已保存且域一致的真实证据')
    const bound=normalize(context),policy=authority(store,bound)
    let reason=policy.reason,accepted=policy.allowed
    if(bound&&(bound.platform!==row.platform||bound.conversation_id!==row.conversation_id)){accepted=false;reason='source_domain_mismatch'}
    if(row.visibility==='secret'){accepted=false;reason='secret_source_excluded'}
    else if(row.visibility==='owner'&&bound?.owner_authorized!==true){accepted=false;reason='owner_authority_missing'}
    const recorded_at=timestamp(now(),'来源绑定时钟')
    const event=store.appendJournalEvent({id:'journal:'+digest(keyOf(row.id)),event_key:keyOf(row.id),event_type:'log',platform:'harness',direction:'internal',status:'recorded',visibility:'owner',text:'',source_at:recorded_at,source_type:SOURCE_TYPE,
      metadata:{subtype:'memory_source_binding',evidence_id:row.id,source_domain:domainOf(row),source_recorded_at:row.recorded_at,context:bound,accepted,reason,authority:'trusted_native_backend_only',no_publication:true}})
    return {recorded:true,accepted,reason,journal_id:event.id}
  })
}

/** Collector ingress has no SDK session yet. Only the first actual leased
 * incoming task may bind that source to its real consuming session. This is
 * not a duplicate-read upgrade: an explicit original denial always wins, and
 * arbitrary historical evidence without a first ingress record stays unbound.
 */
export function recordNativeMemorySourceConsumption({store,task,context,now=store?.now}={}){
  if(!(store instanceof NativeStore)||typeof now!=='function')throw new Error('记忆消费绑定需原生存储与可信时钟')
  store._open();identifier(task?.id,'task.id')
  if(store.readOnly)return {recorded:false,status:'read_only'}
  return store.transaction(()=>{
    const action=store.db.prepare('SELECT id,platform,kind,status,request_digest,source_evidence_id,target_json,metadata_json,CAST(body AS BLOB) body_bytes FROM actions WHERE id=?').get(task.id)
    const metadata=action?JSON.parse(action.metadata_json):null,target=action?JSON.parse(action.target_json):null,at=timestamp(now(),'记忆消费时钟')
    if(!action||action.kind!=='activity.incoming'||!['leased','running'].includes(action.status)||action.request_digest!==task.request_digest||!action.source_evidence_id||action.source_evidence_id!==task.source_evidence_id
      ||metadata.execution!=='model'||metadata.human!==true||!metadata.batch_id||metadata.batch_id!==task.metadata?.batch_id||!Number.isSafeInteger(metadata.lease_until)||metadata.lease_until<=at||!metadata.lease_token)throw new Error('来源消费必须属于当前真实来信模型任务和有效租约')
    const original=bindingOf(store,action.source_evidence_id)
    if(!original||original.accepted||original.reason!=='missing_source_context'||original.context)return {recorded:false,accepted:false,status:'original_binding_preserved'}
    const previous=consumptionOf(store,action.source_evidence_id)
    if(previous)return {recorded:false,duplicate:true,accepted:previous.accepted,reason:previous.reason}
    const row=store.db.prepare('SELECT id,platform,conversation_id,visibility,recorded_at,direction,source_type,actor_uid,CAST(text AS BLOB) text_bytes FROM evidence WHERE id=?').get(action.source_evidence_id),bound=normalize(context)
    if(!row||row.source_type!=='user'||row.direction!=='in'||!row.actor_uid||row.platform!==action.platform||!sameDomain(row,original.source_domain)||row.recorded_at!==original.source_recorded_at
      ||target.conversation_id!==row.conversation_id||target.actor_uid!==row.actor_uid||!Buffer.from(row.text_bytes).equals(Buffer.from(action.body_bytes))
      ||!bound||bound.platform!==row.platform||bound.conversation_id!==row.conversation_id)throw new Error('来信消费绑定与真实证据、原任务正文或会话域不符')
    // Incoming public/private source data never grants owner or global power.
    bound.owner_authorized=false
    const policy=authority(store,bound),accepted=policy.allowed&&!['owner','secret'].includes(row.visibility),reason=['owner','secret'].includes(row.visibility)?'private_authority_excluded':policy.reason
    const event=store.appendJournalEvent({id:'journal:'+digest(consumptionKey(row.id)),event_key:consumptionKey(row.id),event_type:'log',platform:'harness',direction:'internal',status:'recorded',visibility:'owner',text:'',source_at:at,source_type:SOURCE_TYPE,
      metadata:{subtype:'memory_source_consumption',evidence_id:row.id,source_domain:domainOf(row),source_recorded_at:row.recorded_at,context:bound,accepted,reason,task_id:action.id,request_digest:action.request_digest,batch_id:metadata.batch_id,authority:'trusted_native_backend_only',no_publication:true}})
    return {recorded:true,accepted,reason,journal_id:event.id}
  })
}

/** Exact-key lookup only. Both the immutable original capabilities and current
 * privacy policy must allow the source; the caller cannot supply a new context.
 */
export function resolveNativeMemorySource({store,evidence}={}){
  if(!(store instanceof NativeStore))throw new Error('记忆来源查询需原生存储')
  store._open();identifier(evidence?.id,'evidence.id')
  let binding=bindingOf(store,evidence.id)
  if(binding&&!binding.accepted&&binding.reason==='missing_source_context'&&!binding.context)binding=consumptionOf(store,evidence.id)
  if(!binding?.accepted||!binding.context)return null
  const row=sourceOf(store,evidence.id)
  if(!row||!sameDomain(row,evidence)||!sameDomain(row,binding.source_domain)||row.recorded_at!==binding.source_recorded_at||row.visibility==='secret')return null
  const context=binding.context
  if(context.platform!==row.platform||context.conversation_id!==row.conversation_id||!authority(store,context).allowed)return null
  if(row.visibility==='owner'&&context.owner_authorized!==true)return null
  return {session_id:context.session_id,workspace_id:context.workspace_id,
    context:{platform:row.platform,conversation_id:row.conversation_id,owner_authorized:row.visibility==='owner'&&context.owner_authorized===true,include_secret:false,allow_global_summary:false},
    read_memory:true,write_memory:true,consolidate_memory:true}
}

/** Read projection for newly derived entries only. A matching original session
 * and native immutable provenance establish applicability; unrelated imported
 * history is left untouched. Consolidation/write switches do not revoke reads.
 */
export function nativeMemorySourceReadPolicy({store,evidence,source_session_id}={}){
  if(!(store instanceof NativeStore))throw new Error('记忆来源读取策略需原生存储')
  store._open();identifier(evidence?.id,'evidence.id');if(source_session_id!==undefined)uid(source_session_id,'source_session_id')
  let binding=bindingOf(store,evidence.id)
  if(binding&&!binding.accepted&&binding.reason==='missing_source_context'&&!binding.context)binding=consumptionOf(store,evidence.id)
  if(!binding?.context||source_session_id!==undefined&&(!source_session_id||!binding.accepted||binding.context.session_id!==source_session_id))return {applies:false,allowed:true}
  const row=sourceOf(store,evidence.id),context=binding.context
  if(!row||!sameDomain(row,evidence)||!sameDomain(row,binding.source_domain)||row.recorded_at!==binding.source_recorded_at||context.platform!==row.platform||context.conversation_id!==row.conversation_id)return {applies:true,allowed:false}
  const settings=store.getDocument('settings')?.value
  if(context.read_memory===false||settings?.memory?.disabled_workspace_ids?.includes(context.workspace_id))return {applies:true,allowed:false}
  const policies=store.db.prepare("SELECT value_json FROM documents WHERE type='session_policy' AND json_extract(value_json,'$.session_id')=?").all(context.session_id).map(item=>JSON.parse(item.value_json))
  return {applies:true,allowed:!policies.some(policy=>policy.read_memory===false||policy.workspace_id&&policy.workspace_id!==context.workspace_id)}
}
