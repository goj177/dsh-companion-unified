import {isDeepStrictEqual} from 'node:util'
import {isPlainObject,stringifyJson} from './contracts.mjs'

const own=(value,key)=>Object.hasOwn(value,key),bytes=value=>Buffer.byteLength(stringifyJson(value))
const FORMAT='native-read-view:1'
export const NATIVE_READ_PROJECTION_POLICY=Object.freeze({minimum_saved_utf8_bytes:64,minimum_saved_ratio:0.03})
const ROW_FIELDS={post:{post_id:'source_id',floor:'floor',author_uid:'author_uid',name:'author_name'},sub:{sub_reply_id:'source_id',author_uid:'author_uid',reply_to_uid:'reply_to_uid'}}
const SOURCE_ATTR={source_id:'source_id',current_speaker_uid:'author_uid',author_name:'author_name',first_person_owner_uid:'author_uid',author_role:'author_role',reply_to_uid:'reply_to_uid',mentioned_uids:'mentioned_uids'}
const ROW_ATTR={
  tieba:{source_id:'row.post_id ?? row.sub_reply_id',current_speaker_uid:'row.author_uid',author_name:'row.name ?? row.author.name_show ?? row.author.name',first_person_owner_uid:'row.author_uid',mentioned_uids:'row.mention_uids'},
  bilibili:{source_id:'row.rpid',current_speaker_uid:'row.uid',author_name:'row.name',first_person_owner_uid:'row.uid',mentioned_uids:'row.mention_uids'},
}
const rowValues=(row,platform)=>({source_id:platform==='bilibili'?row.rpid:row.post_id??row.sub_reply_id,current_speaker_uid:platform==='bilibili'?row.uid:row.author_uid,
  author_name:row.name??row.author?.name_show??row.author?.name,first_person_owner_uid:platform==='bilibili'?row.uid:row.author_uid,mentioned_uids:row.mention_uids})
function walk(value,callback){
  if(Array.isArray(value)){value.forEach(child=>walk(child,callback));return}
  if(!isPlainObject(value))return
  callback(value)
  for(const [key,child]of Object.entries(value))if(key!=='read_projection'&&key!=='text_json')walk(child,callback)
}
function rowAliases(output,platform,view){
  const used=new Set()
  walk(output,row=>{
    const attr=row.attribution,values=rowValues(row,platform)
    if(!isPlainObject(attr)||own(attr,'same_as_row')||own(attr,'same_as_source_record'))return
    const fields=Object.keys(ROW_ATTR[platform])
    if(fields.some(key=>!own(attr,key)))return
    let changed=false
    for(const key of fields)if(values[key]!==undefined&&isDeepStrictEqual(values[key],attr[key])){delete attr[key];used.add(key);changed=true}
    if(changed)attr.same_as_row=true
  })
  if(used.size)view.row_attribution_aliases=Object.fromEntries([...used].map(key=>[key,ROW_ATTR[platform][key]]))
}
function sourceRows(section,parsed,view){
  for(const key of ['posts','items'])if(Array.isArray(section[key]))for(const row of section[key]){
    if(!isPlainObject(row)||own(row,'source_record'))continue
    const id=row.post_id??row.sub_reply_id
    if(typeof id!=='string'||!id)continue
    const matches=parsed.records.map((record,index)=>({record,index})).filter(item=>item.record?.source_id===id)
    if(matches.length!==1)continue
    const {record,index}=matches[0],kind=own(row,'post_id')?'post':own(row,'sub_reply_id')?'sub':null,mapping=ROW_FIELDS[kind],attr=row.attribution
    const direct=!!mapping&&Object.entries(mapping).every(([field,source])=>own(row,field)&&own(record,source)&&isDeepStrictEqual(row[field],record[source]))
    const attributed=isPlainObject(attr)&&!own(attr,'same_as_source_record')&&!own(attr,'same_as_row')&&Object.entries(SOURCE_ATTR).every(([field,source])=>own(attr,field)&&own(record,source)&&isDeepStrictEqual(attr[field],record[source]))
    if(!direct&&!attributed)continue
    row.source_record={index,kind:direct?kind:null}
    if(direct){for(const field of Object.keys(mapping))delete row[field];view.source_row_aliases??={};view.source_row_aliases[kind]=structuredClone(mapping)}
    if(attributed){for(const field of Object.keys(SOURCE_ATTR))delete attr[field];attr.same_as_source_record=true;view.source_attribution_aliases=structuredClone(SOURCE_ATTR)}
  }
}
function completeSourceJson(output,view,{linkRows=false}={}){
  walk(output,section=>{
    if(section.source_context?.platform!=='tieba'||typeof section.text!=='string'||section.offset!==undefined&&section.offset!==0||section.next_offset!==undefined&&section.next_offset!==null||section.total_chars!==section.text.length)return
    let parsed
    try{parsed=JSON.parse(section.text)}catch{return}
    // Partial pages, custom/legacy encodings, unknown source formats and any
    // serialization difference keep their original source string verbatim.
    if(!isPlainObject(parsed)||parsed.source_context?.platform!=='tieba'||!['thread','sub_reply'].includes(parsed.source_context.source_kind)||parsed.source_context.source_kind!==section.source_context.source_kind||!Array.isArray(parsed.records)
      ||parsed.records.some(record=>!isPlainObject(record)||['source_id','author_uid','author_name','author_role','reply_to_uid','mentioned_uids','text'].some(key=>!own(record,key)))||JSON.stringify(parsed)!==section.text)return
    section.text_json=parsed;delete section.text;view.text_json='原text的完整JSON，不代表整帖；JSON.stringify(text_json)还原原text，source_record指同段text_json.records。'
    if(linkRows)sourceRows(section,parsed,view)
  })
}
function contextDefaults(output,view,platform){
  const contexts=[]
  walk(output,value=>{const context=value.source_context;if(isPlainObject(context)&&context.platform===platform&&!own(context,'same_as_context_defaults'))contexts.push(context)})
  if(contexts.length<2)return
  const base=Object.fromEntries(Object.entries(contexts[0]).filter(([key,value])=>value!==undefined&&contexts.every(context=>own(context,key)&&isDeepStrictEqual(context[key],value))))
  if(!Object.keys(base).length)return
  const projected=contexts.map(context=>({...Object.fromEntries(Object.entries(context).filter(([key])=>!own(base,key))),same_as_context_defaults:true}))
  if(bytes({context_defaults:base,contexts:projected})>=bytes({contexts}))return
  contexts.forEach(context=>{for(const key of Object.keys(base))delete context[key];context.same_as_context_defaults=true});view.context_defaults=base
}
function candidate(value,platform,mode){
  const output=structuredClone(value),view={format:FORMAT,platform}
  if(mode==='source'||mode==='source_rows')completeSourceJson(output,view,{linkRows:mode==='source_rows'})
  if(mode==='aliases')rowAliases(output,platform,view)
  contextDefaults(output,view,platform)
  if(Object.keys(view).length===2)return value
  output.read_projection=view
  return output
}

/** Model output only; raw provider results, source evidence, learning ingestion,
 * publication checks and paging are untouched. Every removed field has an
 * explicit exact-value alias and a deterministic inverse. No source text is
 * shortened, and no cached observation is presented as a new platform read.
 */
export function projectNativeReadToolResult(args,value){
  if(!isPlainObject(value)||own(value,'read_projection')||own(value,'attribution_aliases'))return value
  const platform=args?.platform??value.source_context?.platform??value.thread?.source_context?.platform??(Array.isArray(value.items)?value.items.find(item=>item?.source_context)?.source_context.platform:undefined)
  if(!['tieba','bilibili'].includes(platform)||!['browse','thread','sub_replies','conversation','comments','video','subtitles'].includes(args?.operation))return value
  if(value.source_context?.platform!==platform&&value.thread?.source_context?.platform!==platform&&!value.items?.some?.(item=>item?.source_context?.platform===platform))return value
  let collision=false
  walk(value,row=>{if(['text_json','source_record','same_as_context_defaults','same_as_row','same_as_source_record'].some(key=>own(row,key)))collision=true})
  if(collision)return value
  const originalSize=bytes(value)
  let best=value,size=originalSize
  for(const mode of platform==='tieba'?['aliases','contexts','source','source_rows']:['aliases','contexts']){
    const projected=candidate(value,platform,mode),length=bytes(projected)
    if(length<size){best=projected;size=length}
  }
  // A tiny byte difference is not evidence of a Token win; keep the ordinary
  // representation instead of adding an alias contract for a handful of bytes.
  const saved=originalSize-size
  return saved>=NATIVE_READ_PROJECTION_POLICY.minimum_saved_utf8_bytes&&saved/originalSize>=NATIVE_READ_PROJECTION_POLICY.minimum_saved_ratio?best:value
}

/** Inverse for audit/tests and native consumers needing the complete original
 * shape. Alias maps are validated against this module's fixed data contract;
 * they never execute instructions supplied by a source.
 */
export function restoreNativeReadToolResult(value){
  if(!isPlainObject(value)||value.read_projection?.format!==FORMAT)return value
  const output=structuredClone(value),view=output.read_projection
  if(!['tieba','bilibili'].includes(view.platform))throw new Error('读取投影平台无效')
  if(view.source_row_aliases)for(const [kind,mapping]of Object.entries(view.source_row_aliases))if(!own(ROW_FIELDS,kind)||!isDeepStrictEqual(mapping,ROW_FIELDS[kind]))throw new Error('读取投影行别名无效')
  if(view.source_attribution_aliases&&!isDeepStrictEqual(view.source_attribution_aliases,SOURCE_ATTR))throw new Error('读取投影来源归属别名无效')
  if(view.row_attribution_aliases&&!Object.entries(view.row_attribution_aliases).every(([key,alias])=>own(ROW_ATTR[view.platform],key)&&ROW_ATTR[view.platform][key]===alias))throw new Error('读取投影行归属别名无效')
  walk(output,section=>{
    const context=section.source_context
    if(context?.same_as_context_defaults===true){if(!isPlainObject(view.context_defaults))throw new Error('读取投影缺少上下文默认值');delete context.same_as_context_defaults;for(const [key,item]of Object.entries(view.context_defaults))if(!own(context,key))Object.defineProperty(context,key,{value:structuredClone(item),writable:true,enumerable:true,configurable:true})}
    if(!isPlainObject(section.text_json)||!Array.isArray(section.text_json.records))return
    for(const key of ['posts','items'])for(const row of Array.isArray(section[key])?section[key]:[]){
      if(!isPlainObject(row)||!own(row,'source_record'))continue
      const ref=row.source_record,record=section.text_json.records[ref?.index]
      if(!Number.isSafeInteger(ref?.index)||ref.index<0||!isPlainObject(record)||ref.kind!==null&&!own(view.source_row_aliases??{},ref.kind))throw new Error('读取投影来源行引用无效')
      if(ref.kind!==null)for(const [field,source]of Object.entries(view.source_row_aliases[ref.kind])){if(own(row,field)||!own(record,source))throw new Error('读取投影来源行字段冲突');row[field]=structuredClone(record[source])}
      if(row.attribution?.same_as_source_record===true){if(!view.source_attribution_aliases)throw new Error('读取投影缺少来源归属别名');delete row.attribution.same_as_source_record;for(const [field,source]of Object.entries(SOURCE_ATTR)){if(own(row.attribution,field)||!own(record,source))throw new Error('读取投影来源归属冲突');row.attribution[field]=structuredClone(record[source])}}
      delete row.source_record
    }
  })
  if(view.row_attribution_aliases)walk(output,row=>{
    if(row.attribution?.same_as_row!==true)return
    const values=rowValues(row,view.platform)
    for(const key of Object.keys(view.row_attribution_aliases))if(!own(row.attribution,key)){if(values[key]===undefined)throw new Error('读取投影缺少原行字段');row.attribution[key]=structuredClone(values[key])}
    delete row.attribution.same_as_row
  })
  walk(output,section=>{if(own(section,'text_json')){if(typeof view.text_json!=='string'||!isPlainObject(section.text_json)||own(section,'text'))throw new Error('读取投影原文引用无效');section.text=JSON.stringify(section.text_json);delete section.text_json}})
  delete output.read_projection
  return output
}

export const projectNativeBilibiliReadResult=(value,operation='thread')=>projectNativeReadToolResult({platform:'bilibili',operation},value)
export const projectNativeTiebaReadToolResult=(value,operation='thread')=>projectNativeReadToolResult({platform:'tieba',operation},value)
