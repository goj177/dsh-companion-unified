/** Self-contained, reversible model view of verified public Tieba source rows.
 * Original native returns, evidence bytes, permissions and server reads stay intact. */
import {isDeepStrictEqual} from 'node:util'
import {createHash} from 'node:crypto'
import {isPlainObject} from './contracts.mjs'

export const READ_RECORD_VIEW_FORMAT='native-record-view:1'
const sources=new WeakMap(),snapshots=new Map(),SNAPSHOT_TTL_MS=60000,SNAPSHOT_MAX_ENTRIES=64,SNAPSHOT_MAX_BYTES=8*1024*1024
let snapshotBytes=0
const own=(v,k)=>Object.hasOwn(v,k),copy=structuredClone
const SOURCE_KEYS=['source_id','floor','has_images','author_uid','author_name','author_role','reply_to_uid','mentioned_uids','text']
const EXTRA_KEYS=['first_person_owner_uid','addressed_to_self','address_kind']
const HEADER_KEYS=['platform','source_kind','parent_post_id','account_self_uid','topic_author_uid','parent_author_uid','narrator','command_authority','bar','thread_id']
const CONTEXT_DEFAULT_KEYS=['visibility','mentioned_uids','mentioned_self','has_unresolved_text_mentions','addressed_to_self','address_kind','narrator','source_author_is_self','private_identity_link']
const RESERVED=['original_fields','source_text_window','source_records_complete','source_record_count']
const ALIASES=[...SOURCE_KEYS,...EXTRA_KEYS].map(key=>[key,key]).concat([
 ['attribution.source_id','source_id'],['attribution.current_speaker_uid','author_uid'],['attribution.author_name','author_name'],['attribution.author_role','author_role'],['attribution.first_person_owner_uid','first_person_owner_uid'],['attribution.reply_to_uid','reply_to_uid'],['attribution.mentioned_uids','mentioned_uids'],['attribution.addressed_to_self','addressed_to_self'],['attribution.address_kind','address_kind'],
 ['author.uid','author_uid'],['author.name','author_name'],['author.name_show','author_name'],['total_chars','@text_length'],['total_content_parts','@parts_length'],['floor','@unknown_floor'],
])
const get=(object,path)=>path.split('.').reduce((value,key)=>isPlainObject(value)&&own(value,key)?value[key]:undefined,object)
function remove(object,path){const keys=path.split('.'),last=keys.pop(),parent=keys.reduce((v,key)=>v?.[key],object);if(parent)delete parent[last];if(keys.length&&isPlainObject(object[keys[0]])&&!Object.keys(object[keys[0]]).length)delete object[keys[0]]}
function put(object,path,value){const keys=path.split('.'),last=keys.pop();let node=object;for(const key of keys){if(!own(node,key))node[key]={};if(!isPlainObject(node[key]))throw Error('结构化读取字段冲突');node=node[key]}if(own(node,last))throw Error('结构化读取字段重复');Object.defineProperty(node,last,{value:copy(value),enumerable:true,writable:true,configurable:true})}
const aliasValue=(row,key)=>key==='@text_length'?row.text?.length:key==='@parts_length'?row.content_parts?.length:key==='@unknown_floor'?row.floor===null?0:undefined:own(row,key)?row[key]:undefined
const intern=(values,value)=>{const old=values.findIndex(v=>isDeepStrictEqual(v,value));if(old>=0)return old;values.push(value);return values.length-1}
const pathValue=(object,path)=>path.reduce((value,key)=>value?.[key],object)
const validPath=path=>Array.isArray(path)&&(path.length===0||path.length===1&&['thread','sub_replies'].includes(path[0]))
const assert=condition=>{if(!condition)throw Error('结构化读取视图无法核验')}
const canonical=value=>Array.isArray(value)?value.map(canonical):isPlainObject(value)?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value
const digest=value=>createHash('sha256').update(JSON.stringify(canonical(value))).digest('base64url')
const maskOf=indices=>indices.reduce((mask,index)=>mask+2**index,0).toString(36)
function indicesOf(value,length){assert(typeof value==='string'&&/^[0-9a-z]{1,7}$/.test(value));const mask=parseInt(value,36);assert(Number.isSafeInteger(mask)&&mask>=0&&mask<2**length);return Array.from({length},(_,i)=>i).filter(i=>Math.floor(mask/2**i)%2===1)}
const headerValue=(section,key)=>own(section.source_context??{},key)?section.source_context[key]:key==='parent_post_id'?section.post_id:section[key]
function encodeHeader(header,section){if(!isDeepStrictEqual(Object.keys(header),HEADER_KEYS.filter(key=>own(header,key))))return null;const indices=HEADER_KEYS.flatMap((key,i)=>own(header,key)?[i]:[]),extra=Object.fromEntries(indices.map(i=>HEADER_KEYS[i]).filter(key=>!isDeepStrictEqual(header[key],headerValue(section,key))).map(key=>[key,copy(header[key])]));return[maskOf(indices),extra]}
function decodeHeader(value,section){assert(Array.isArray(value)&&value.length===2&&isPlainObject(value[1])&&Object.keys(value[1]).every(key=>HEADER_KEYS.includes(key)));return Object.fromEntries(indicesOf(value[0],HEADER_KEYS.length).map(i=>{const key=HEADER_KEYS[i],v=own(value[1],key)?value[1][key]:headerValue(section,key);assert(v!==undefined);return[key,copy(v)]}))}
const contexts=output=>[output,output.thread,output.sub_replies].filter(section=>isPlainObject(section?.source_context)).map(section=>section.source_context)
function factorContexts(output){const rows=contexts(output);if(rows.length<2)return;const defaults=Object.fromEntries(CONTEXT_DEFAULT_KEYS.filter(key=>rows.every(row=>own(row,key)&&isDeepStrictEqual(row[key],rows[0][key]))).map(key=>[key,copy(rows[0][key])]))
  const before=JSON.stringify(rows),after=rows.map(row=>({...Object.fromEntries(Object.entries(row).filter(([key])=>!own(defaults,key))),same_as_context_defaults:true}));if(!Object.keys(defaults).length||JSON.stringify({defaults,rows:after}).length>=before.length)return
  rows.forEach(row=>{for(const key of Object.keys(defaults))delete row[key];row.same_as_context_defaults=true});output.read_projection.context_defaults=defaults
}

// The official tools pipeline JSON-snapshots and freezes native returns before
// render. Bridge that copy by the digest of the *entire* already-read result,
// not by thread ID. This short-lived sidecar never serves a platform read and
// never reads disk, changes evidence or adds fields to the native return.
function pruneSnapshots(now=Date.now()){for(const [key,row]of snapshots){if(row.expires>now&&snapshots.size<=SNAPSHOT_MAX_ENTRIES&&snapshotBytes<=SNAPSHOT_MAX_BYTES)continue;snapshots.delete(key);snapshotBytes-=row.bytes}}
function sourceFor(value){const direct=sources.get(value);if(direct!==undefined)return direct;pruneSnapshots();return snapshots.get(digest(value))?.body}
export function registerNativeReadSource(value,body){
  if(isPlainObject(value)&&typeof body==='string'){
    sources.set(value,body);pruneSnapshots();const bytes=body.length*2
    if(bytes<=SNAPSHOT_MAX_BYTES){const key=digest(value),old=snapshots.get(key);if(old){snapshotBytes-=old.bytes;snapshots.delete(key)}snapshots.set(key,{body,bytes,expires:Date.now()+SNAPSHOT_TTL_MS});snapshotBytes+=bytes;pruneSnapshots()}
  }
  return value
}

function encodeRow(raw,record){
  if(!isPlainObject(raw)||RESERVED.some(key=>own(raw,key)))return null
  const attr=raw.attribution
  if(!isPlainObject(attr)||!['source_id','current_speaker_uid','author_name','author_role','first_person_owner_uid','reply_to_uid','mentioned_uids'].every(key=>own(attr,key)))return null
  const expected={source_id:record.source_id,current_speaker_uid:record.author_uid,author_name:record.author_name,author_role:record.author_role,first_person_owner_uid:record.author_uid,reply_to_uid:record.reply_to_uid,mentioned_uids:record.mentioned_uids}
  if(Object.entries(expected).some(([key,value])=>!isDeepStrictEqual(attr[key],value)))return null
  if(own(raw,'text')&&raw.text!==record.text||own(raw,'author_uid')&&raw.author_uid!==record.author_uid||raw.author?.uid&&raw.author.uid!==record.author_uid)return null
  const output={...copy(record),first_person_owner_uid:record.author_uid},remaining=copy(raw),plan=[]
  for(const key of ['addressed_to_self','address_kind'])if(own(attr,key))output[key]=copy(attr[key])
  for(const key of ['content_parts','image_refs'])if(own(raw,key))output[key]=copy(raw[key])
  for(let code=0;code<ALIASES.length;code++){
    const [path,key]=ALIASES[code],value=get(remaining,path),expected=aliasValue(output,key)
    if(value!==undefined&&expected!==undefined&&isDeepStrictEqual(value,expected)){remove(remaining,path);plan.push(code)}
  }
  const conflicts={}
  for(const [key,value]of Object.entries(remaining)){if(own(output,key)){if(!isDeepStrictEqual(output[key],value))conflicts[key]=copy(value)}else output[key]=copy(value)}
  if(Object.keys(conflicts).length)output.original_fields=conflicts
  return {row:output,plan}
}

function encodeSection(section,body,path){
  if(!isPlainObject(section)||RESERVED.some(key=>own(section,key))||section.source_context?.platform!=='tieba'||!['thread','sub_reply'].includes(section.source_context.source_kind))return null
  const field=Array.isArray(section.posts)?'posts':Array.isArray(section.items)?'items':null,rawRows=field?section[field]:null
  if(!field||!rawRows.length||typeof section.text!=='string'||!Number.isSafeInteger(section.offset)||section.offset<0||section.total_chars!==body.length||section.text!==body.slice(section.offset,section.offset+section.text.length)||section.next_offset!==null&&(!Number.isSafeInteger(section.next_offset)||section.next_offset<0))return null
  let parsed;try{parsed=JSON.parse(body)}catch{return null}
  if(!isPlainObject(parsed)||!isDeepStrictEqual(Object.keys(parsed),['source_context','records'])||JSON.stringify(parsed)!==body||parsed.source_context?.platform!=='tieba'||parsed.source_context.source_kind!==section.source_context.source_kind||parsed.source_context.narrator!=='source_author'||!Array.isArray(parsed.records))return null
  const records=parsed.records
  if(records.some(row=>!isPlainObject(row)||!isDeepStrictEqual(Object.keys(row),SOURCE_KEYS.filter(key=>own(row,key)))||['source_id','author_uid','author_name','author_role','reply_to_uid','mentioned_uids','text'].some(key=>!own(row,key))||!/^[1-9]\d*$/.test(row.source_id??'')||!/^[1-9]\d*$/.test(row.author_uid??'')||typeof row.text!=='string'))return null
  const index=new Map(records.map((row,i)=>[row.source_id,i]));if(index.size!==records.length)return null
  const prefix='{"source_context":'+JSON.stringify(parsed.source_context)+',"records":[',encodedRecords=records.map(row=>JSON.stringify(row)),starts=[];let position=prefix.length
  for(const text of encodedRecords){starts.push(position);position+=text.length+1}
  const selected=new Set(),nativeIndices=[]
  for(const raw of rawRows){const id=raw.post_id??raw.sub_reply_id??raw.attribution?.source_id,at=index.get(id);if(at===undefined||nativeIndices.includes(at))return null;selected.add(at);nativeIndices.push(at)}
  const end=section.offset+section.text.length
  for(let i=0;i<records.length;i++)if(starts[i]<end&&starts[i]+encodedRecords[i].length+1>section.offset)selected.add(i)
  if([...selected].reduce((n,i)=>n+JSON.stringify(records[i].text).length,0)>=JSON.stringify(section).length)return null
  const indices=[...selected].sort((a,b)=>a-b),rows=indices.map(i=>({...copy(records[i]),first_person_owner_uid:records[i].author_uid})),plans=[],native_rows=[],shapes=[],shape_ids=indices.map(i=>intern(shapes,maskOf(SOURCE_KEYS.flatMap((key,n)=>own(records[i],key)?[n]:[]))))
  for(let n=0;n<rawRows.length;n++){const at=indices.indexOf(nativeIndices[n]),encoded=encodeRow(rawRows[n],records[nativeIndices[n]]);if(!encoded)return null;rows[at]=encoded.row;native_rows.push([at,intern(plans,maskOf(encoded.plan))])}
  const output={...copy(section),[field]:rows,source_text_window:{offset:section.offset,total_chars:section.total_chars,next_offset:section.next_offset},source_records_complete:indices.length===records.length,source_record_count:records.length}
  for(const key of ['text','offset','total_chars','next_offset'])delete output[key]
  const header=section.offset<prefix.length&&end>0?encodeHeader(parsed.source_context,section):undefined;if(header===null)return null
  return {output,plan:{path,field,native_rows,plans,shapes,shape_ids,starts:indices.map(i=>starts[i]),length:section.text.length,...(header?{header}:{})}}
}

export function projectNativeRecordView(value){
  if(!isPlainObject(value)||own(value,'read_projection'))return value
  let output=copy(value);const sections=[]
  for(const path of [[],['thread'],['sub_replies']]){
    const section=pathValue(value,path),body=isPlainObject(section)?sourceFor(section):null;if(!body)continue
    const encoded=encodeSection(section,body,path);if(!encoded)continue
    if(path.length)output[path[0]]=encoded.output;else output=encoded.output
    sections.push(encoded.plan)
  }
  if(!sections.length)return value
  output.read_projection={format:READ_RECORD_VIEW_FORMAT,integrity:digest(value),records:'Rows keep full speaker IDs. source_records_complete covers this fetched source, not the thread; when true, its text is already complete and needs no text-window continuation.',sections}
  factorContexts(output)
  try{if(!isDeepStrictEqual(restoreNativeRecordView(JSON.parse(JSON.stringify(output))),value))return value}catch{return value}
  return output
}

export function restoreNativeRecordView(value){
  assert(isPlainObject(value)&&value.read_projection?.format===READ_RECORD_VIEW_FORMAT)
  const output=copy(value),view=output.read_projection;assert(Array.isArray(view.sections)&&view.sections.length>0&&view.sections.length<=2)
  if(view.context_defaults){assert(isPlainObject(view.context_defaults)&&Object.keys(view.context_defaults).every(key=>CONTEXT_DEFAULT_KEYS.includes(key)));for(const row of contexts(output))if(row.same_as_context_defaults===true){delete row.same_as_context_defaults;for(const[key,value]of Object.entries(view.context_defaults)){assert(!own(row,key));row[key]=copy(value)}}}
  const paths=new Set()
  for(const plan of view.sections){
    assert(isPlainObject(plan)&&validPath(plan.path)&&!paths.has(JSON.stringify(plan.path))&&['posts','items'].includes(plan.field));paths.add(JSON.stringify(plan.path))
    const section=pathValue(output,plan.path),rows=section?.[plan.field],window=section?.source_text_window
    assert(Array.isArray(rows)&&isPlainObject(window)&&Number.isSafeInteger(window.offset)&&window.offset>=0&&Number.isSafeInteger(window.total_chars)&&window.total_chars>=0&&Number.isSafeInteger(plan.length)&&plan.length>=0&&Array.isArray(plan.shapes)&&Array.isArray(plan.shape_ids)&&Array.isArray(plan.starts)&&plan.shape_ids.length===rows.length&&plan.starts.length===rows.length&&Array.isArray(plan.plans)&&Array.isArray(plan.native_rows)&&Number.isSafeInteger(section.source_record_count)&&section.source_record_count>=rows.length&&section.source_records_complete===(section.source_record_count===rows.length))
    const pieces=[]
    if(plan.header)pieces.push({start:0,text:'{"source_context":'+JSON.stringify(decodeHeader(plan.header,section))+',"records":['})
    for(let i=0;i<rows.length;i++){
      const row=rows[i],shape=plan.shape_ids[i],keys=indicesOf(plan.shapes[shape],SOURCE_KEYS.length).map(i=>SOURCE_KEYS[i]),start=plan.starts[i];assert(Number.isSafeInteger(shape)&&shape>=0&&isPlainObject(row)&&row.first_person_owner_uid===row.author_uid&&keys.every(key=>own(row,key))&&Number.isSafeInteger(start)&&start>=0&&(!i||start>plan.starts[i-1]))
      const original=Object.fromEntries(keys.map(key=>[key,copy(row[key])])),text=JSON.stringify(original);assert(start+text.length<=window.total_chars-2);pieces.push({start,text});if(start+text.length<window.total_chars-2)pieces.push({start:start+text.length,text:','})
    }
    pieces.push({start:window.total_chars-2,text:']}' });pieces.sort((a,b)=>a.start-b.start)
    const end=window.offset+plan.length;let cursor=window.offset,text=''
    for(const piece of pieces){const finish=piece.start+piece.text.length;if(finish<=cursor||piece.start>=end)continue;assert(piece.start<=cursor);const take=Math.min(finish,end)-cursor;text+=piece.text.slice(cursor-piece.start,cursor-piece.start+take);cursor+=take;if(cursor===end)break}
    assert(cursor===end)
    const native=[],seen=new Set()
    for(const pair of plan.native_rows){
      assert(Array.isArray(pair)&&pair.length===2&&Number.isSafeInteger(pair[0])&&pair[0]>=0&&pair[0]<rows.length&&Number.isSafeInteger(pair[1])&&!seen.has(pair[0]));seen.add(pair[0])
      const row=rows[pair[0]],keys=indicesOf(plan.shapes[plan.shape_ids[pair[0]]],SOURCE_KEYS.length).map(i=>SOURCE_KEYS[i]),codes=indicesOf(plan.plans[pair[1]],ALIASES.length)
      const result=Object.fromEntries(Object.entries(row).filter(([key])=>!keys.includes(key)&&!EXTRA_KEYS.includes(key)&&key!=='original_fields').map(([key,value])=>[key,copy(value)]))
      if(own(row,'original_fields')){assert(isPlainObject(row.original_fields)&&Object.keys(row.original_fields).every(key=>keys.includes(key)||EXTRA_KEYS.includes(key)));for(const[key,value]of Object.entries(row.original_fields))Object.defineProperty(result,key,{value:copy(value),enumerable:true,writable:true,configurable:true})}
      for(const code of codes){const [path,key]=ALIASES[code],value=aliasValue(row,key);assert(value!==undefined);put(result,path,value)}
      native.push(result)
    }
    section[plan.field]=native;section.text=text;section.offset=window.offset;section.total_chars=window.total_chars;section.next_offset=window.next_offset
    delete section.source_text_window;delete section.source_records_complete;delete section.source_record_count
  }
  delete output.read_projection;assert(typeof view.integrity==='string'&&digest(output)===view.integrity);return output
}
