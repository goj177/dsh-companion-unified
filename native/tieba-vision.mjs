/** Images from exact, already-read Tieba rows. Model arguments are opaque
 * references, never URLs; public source pictures do not enter the sticker catalog. */
import {createHash,randomUUID} from 'node:crypto'
import {TiebaError,tiebaId} from './tieba-http.mjs'
import {readPublicImageBytes} from './public-image.mjs'
import {currentRunScope,abortableRun} from './run-scope.mjs'

const hash=value=>createHash('sha256').update(value).digest('hex'),TTL=3600000
const HOSTS=new Set(['tiebapic.baidu.com','imgsrc.baidu.com','imgsa.baidu.com'])
const fail=(message,code='invalid_image_source')=>new TiebaError(message,code)
export function trustedTiebaImageUrl(value){
  try{const url=new URL(value);if(!['http:','https:'].includes(url.protocol)||!HOSTS.has(url.hostname)||url.username||url.password||url.port||url.hash||!url.pathname.startsWith('/forum/')||url.href.length>8192)return null;url.protocol='https:';return url.href}catch{return null}
}
function checkedSource(source){
  if(!source||typeof source!=='object')throw fail('贴吧图片来源未登记')
  const url=trustedTiebaImageUrl(source.url)
  if(!url||!Number.isSafeInteger(source.part_index)||source.part_index<0||source.part_index>1000)throw fail('贴吧图片来源不是已读官方图片')
  const result={thread_id:tiebaId(source.thread_id),post_id:tiebaId(source.post_id),...(source.sub_reply_id?{sub_reply_id:tiebaId(source.sub_reply_id)}:{}),source_message_id:tiebaId(source.source_message_id),author_uid:tiebaId(source.author_uid),part_index:source.part_index,url}
  if(result.source_message_id!==(result.sub_reply_id??result.post_id))throw fail('贴吧图片归属坐标不一致')
  return result
}
export function tiebaRowImageSources(row,{thread_id,post_id=''}={}){
  const author_uid=row?.author_uid??row?.author?.uid,own=row?.post_id??row?.sub_reply_id
  if(!/^[1-9]\d*$/.test(String(author_uid??''))||!/^[1-9]\d*$/.test(String(own??'')))return []
  const out=[]
  for(const part of row.content_parts??[]){
    if(part.type!==3)continue
    const original=part.protocol_fields?.find(field=>field.field===25&&field.base64),raw=part.protocol_fields?.find(field=>field.field===2&&field.base64),candidates=[...(original?[Buffer.from(original.base64,'base64').toString('utf8')]:[]),part.src,part.link,part.c,...(raw?[Buffer.from(raw.base64,'base64').toString('utf8')]:[])],url=candidates.map(trustedTiebaImageUrl).find(Boolean)
    if(!url)continue
    try{out.push(checkedSource({thread_id,post_id:post_id||row.post_id, ...(post_id?{sub_reply_id:own}:{}),source_message_id:own,author_uid,part_index:part.index??out.length,url}))}catch{/* Unknown coordinates cannot be attached to a neighbour. */}
    if(out.length===10)break
  }
  return out
}
export {packPublicImageContext as packTiebaIncomingImageContext} from './public-image.mjs'

export class NativeTiebaVision{
  constructor(service){this.service=service;this.flights=new Map()}
  _session(value){if(typeof value!=='string'||!value||value.length>1024||/[\0\r\n]/.test(value))throw fail('贴吧图片必须绑定当前读取会话');return hash(value)}
  register(sources,session_id){
    const s=this.service;s._assertRun();if(!sources.length||!session_id)return []
    const session_hash=this._session(session_id),out=[]
    for(const raw of sources.slice(0,20)){const source=checkedSource(raw),image_ref='tieba-image:'+hash(JSON.stringify({session_hash,...source})),key='tieba.image:'+image_ref.slice(12),value={session_hash,source}
      if(out.some(row=>row.image_ref===image_ref))continue
      const prior=s.store.db.prepare('SELECT kind,schema_id,schema_version,value_json FROM cache_entries WHERE key=?').get(key)
      let cached;try{cached=JSON.parse(prior?.value_json??'null')}catch{}
      if(prior?.kind==='tieba.image'&&prior.schema_id==='companion.tieba.image'&&prior.schema_version===1&&cached?.session_hash===session_hash&&JSON.stringify(cached.source)===JSON.stringify(source)&&/^asset:[a-f0-9]{64}$/.test(cached.asset_ref??''))value.asset_ref=cached.asset_ref
      s.store.db.prepare('INSERT INTO cache_entries(key,kind,schema_id,schema_version,value_json,created_at,expires_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,created_at=excluded.created_at,expires_at=excluded.expires_at').run(key,'tieba.image','companion.tieba.image',1,JSON.stringify(value),s._now(),s._now()+TTL)
      const {url,...attribution}=source;out.push({image_ref,...attribution})
    }
    s.store.db.prepare("DELETE FROM cache_entries WHERE key IN (SELECT key FROM cache_entries WHERE kind='tieba.image' ORDER BY created_at DESC,key LIMIT -1 OFFSET 500)").run()
    return out
  }
  rows(rows,{thread_id,post_id='',session_id=''}){return rows.map(row=>{const image_refs=this.register(tiebaRowImageSources(row,{thread_id,post_id}),session_id);return image_refs.length?{...row,image_refs}:row})}
  async read({image_ref,session_id}={}){
    const s=this.service,scope=currentRunScope();s._assertRun(scope);s._enabled()
    const session_hash=this._session(session_id)
    if(typeof image_ref!=='string'||!/^tieba-image:[a-f0-9]{64}$/.test(image_ref))throw fail('请使用本次已读楼层返回的image_ref')
    const key='tieba.image:'+image_ref.slice(12),row=s.store.db.prepare("SELECT * FROM cache_entries WHERE key=? AND kind='tieba.image' AND expires_at>?").get(key,s._now())
    let value;try{value=JSON.parse(row?.value_json??'null')}catch{}
    if(row?.schema_id!=='companion.tieba.image'||row.schema_version!==1||value?.session_hash!==session_hash)throw fail('图片引用已过期或不属于当前会话')
    const source=checkedSource(value.source),expected='tieba-image:'+hash(JSON.stringify({session_hash,...source}));if(expected!==image_ref)throw fail('图片登记与来源摘要不一致')
    if(value.asset_ref){const asset=s.assets.read(value.asset_ref);return {...this._result(asset,source),cached:true}}
    if(this.flights.has(image_ref))return abortableRun(this.flights.get(image_ref),scope)
    const work=this._download({source,session_hash,key,image_ref,scope});this.flights.set(image_ref,work)
    try{return await work}finally{this.flights.delete(image_ref)}
  }
  _result(asset,source){const {url,...attribution}=source;return {asset_ref:asset.id,media_type:asset.media_type,byte_size:asset.byte_size,source:attribution,read_only:true,model_calls:0}}
  async _download({source,session_hash,key,image_ref,scope}){
    const s=this.service;if(!s.assets?.put||!s.assets?.read)throw fail('原生图片仓库尚未就绪','unavailable')
    const {bytes,media_type:type}=await readPublicImageBytes({url:source.url,fetcher:s.imageFetcher,check:()=>{s._assertRun(scope);s._enabled()},scope})
    const {url,...attribution}=source,asset=await s.assets.put({bytes,kind:'image',media_type:type,source_ref:url,visibility:'public',manifest:{platform:'tieba',source_kind:'public_post_image',trust:'untrusted_source',attribution}});s._assertRun(scope)
    s.store.db.prepare("UPDATE cache_entries SET value_json=? WHERE key=? AND schema_id='companion.tieba.image'").run(JSON.stringify({session_hash,source,asset_ref:asset.id}),key)
    s._journal('image_read',{image_ref,asset_ref:asset.id,...attribution},{event_type:'platform_read',visibility:'public',ref:'https://tieba.baidu.com/p/'+source.thread_id,event_key:image_ref+':'+asset.id+':'+randomUUID()})
    return {...this._result(asset,source),cached:false}
  }
  async input({sources,session_id,limit=2}={}){
    if(!Array.isArray(sources)||sources.length>20||!Number.isSafeInteger(limit)||limit<1||limit>3)throw fail('贴吧首轮图片输入范围无效')
    const refs=this.register(sources,session_id),images=[],unavailable=[]
    for(const ref of refs.slice(0,limit)){try{const result=await this.read({image_ref:ref.image_ref,session_id}),asset=this.service.assets.read(result.asset_ref);images.push({bytes:asset.bytes,media_type:asset.media_type,asset_ref:asset.id,name:'贴吧图片·'+ref.author_uid+'·'+ref.source_message_id,source:result.source})}catch(error){this.service._assertRun();unavailable.push({source_message_id:ref.source_message_id,part_index:ref.part_index,reason:typeof error.code==='string'?error.code:'image_unavailable'})}}
    return {images,unavailable,omitted:Math.max(0,refs.length-limit)}
  }
}
