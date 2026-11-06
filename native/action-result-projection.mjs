import {isDeepStrictEqual} from 'node:util'
import {isPlainObject,stringifyJson} from './contracts.mjs'

const FORMAT='native-action-echo:1',TASK_FIELDS=['platform','status','body','body_digest','source_evidence_id','created_at','updated_at','not_before'],TARGET_FIELDS={action_id:'id',request_digest:'request_digest'},own=(value,key)=>Object.hasOwn(value,key)
const bytes=value=>Buffer.byteLength(stringifyJson(value))
export const NATIVE_ACTION_PROJECTION_POLICY=Object.freeze({minimum_saved_utf8_bytes:64,minimum_saved_ratio:0.03})

/** Keep the complete authoritative action and receipt. Only exact duplicate
 * fields of its native publication carrier become self-contained references. */
export function projectNativeActionToolResult(value){
  if(!isPlainObject(value)||own(value,'action_projection')||value.ok!==true||!isPlainObject(value.action)||!isPlainObject(value.task)||!['tieba','bilibili'].includes(value.action.platform))return value
  const {action,task}=value,origin=action.metadata?.prepared_in
  if(typeof origin?.task_id!=='string'||!origin.task_id.startsWith('activity-batch:')||origin.round_id!==origin.task_id||task.metadata?.record_type!=='activity_task'||task.metadata.execution!=='publication')return value
  const shared=TASK_FIELDS.filter(key=>own(action,key)&&own(task,key)&&isDeepStrictEqual(action[key],task[key])),target=isPlainObject(task.target)?task.target:null,fields=target?Object.fromEntries(Object.entries(TARGET_FIELDS).filter(([key,source])=>own(target,key)&&own(action,source)&&isDeepStrictEqual(target[key],action[source]))):{}
  if(!shared.length&&!Object.keys(fields).length)return value
  const projectedTask={...task};for(const key of shared)delete projectedTask[key]
  if(Object.keys(fields).length){projectedTask.target={...target};for(const key of Object.keys(fields))delete projectedTask.target[key]}
  const projected={...value,task:projectedTask,action_projection:{format:FORMAT,...(shared.length?{task_fields_from_action:shared}:{}),...(Object.keys(fields).length?{task_target_fields_from_action:fields}:{})}}
  const before=bytes(value),saved=before-bytes(projected)
  return saved>=NATIVE_ACTION_PROJECTION_POLICY.minimum_saved_utf8_bytes&&saved/before>=NATIVE_ACTION_PROJECTION_POLICY.minimum_saved_ratio?projected:value
}

export function restoreNativeActionToolResult(value){
  if(!isPlainObject(value)||value.action_projection?.format!==FORMAT)return value
  const output=structuredClone(value),view=output.action_projection,{action,task}=output
  if(!isPlainObject(action)||!isPlainObject(task))throw new Error('动作投影缺少原始动作或队列记录')
  if(view.task_fields_from_action!==undefined){
    if(!Array.isArray(view.task_fields_from_action)||new Set(view.task_fields_from_action).size!==view.task_fields_from_action.length)throw new Error('动作投影字段别名无效')
    for(const key of view.task_fields_from_action){if(!TASK_FIELDS.includes(key)||!own(action,key)||own(task,key))throw new Error('动作投影字段别名冲突');task[key]=structuredClone(action[key])}
  }
  if(view.task_target_fields_from_action!==undefined){
    if(!isPlainObject(view.task_target_fields_from_action)||!isPlainObject(task.target))throw new Error('动作投影目标别名无效')
    for(const[key,source]of Object.entries(view.task_target_fields_from_action)){if(TARGET_FIELDS[key]!==source||!own(action,source)||own(task.target,key))throw new Error('动作投影目标别名冲突');task.target[key]=structuredClone(action[source])}
  }
  delete output.action_projection
  return output
}
