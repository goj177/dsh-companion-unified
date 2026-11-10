/** Public comment pictures keep exact rpid/author ownership. No private-message
 * images, model URLs, source permissions or sticker-catalog writes are inferred. */
import {createHash,randomUUID} from 'node:crypto'
import {BilibiliError,biliId,trustedBiliUrl} from './bilibili-http.mjs'
import {assertRunActive,currentRunScope,abortableRun} from './run-scope.mjs'
import {readPublicImageBytes} from './public-image.mjs'

const hash=value=>createHash('sha256').update(value).digest('hex'),TTL=3600000
const fail=message=>new BilibiliError(message,{code:'invalid_image_source'})
export function trustedBiliImageUrl(value){try{const url=trustedBiliUrl(value,{cdn:true});if(url.hash||url.href.length>8192||!/^\/bfs\//.test(url.pathname))return null;return url.href}catch{return null}}
export function biliPictureSources(pictures){return (Array.isArray(pictures)?pictures:[]).slice(0,9).map((row,part_index)=>({url:trustedBiliImageUrl(row?.img_src??row?.url),part_index})).filter(row=>row.url)}
function checkedSource(source){
  const url=trustedBiliImageUrl(source?.url)
  if(!url||!Number.isSafeInteger(source?.part_index)||source.part_index<0||source.part_index>1000)throw fail('请使用实际已读B站评论里的图片')
  const result={object_id:biliId(source.object_id),object_type:biliId(source.object_type),root_reply_id:biliId(source.root_reply_id),parent_reply_id:biliId(source.parent_reply_id),source_message_id:biliId(source.source_message_id),author_uid:biliId(source.author_uid),part_index:source.part_index,url}
  if(result.source_message_id!==result.parent_reply_id)throw fail('评论图片与真实原评论坐标不符')
  return result
}
export function biliRowImageSources(row,{object_id,object_type='1'}={}){
  if(!row?.rpid||!row.uid)return []
  const sources=[]
  for(const picture of row.pictures??[])try{sources.push(checkedSource({object_id,object_type,root_reply_id:row.root==='0'?row.rpid:row.root,parent_reply_id:row.rpid,source_message_id:row.rpid,author_uid:row.uid,part_index:picture.part_index,url:picture.url}))}catch{/* Invalid image pointers do not break text comments. */}
  return sources
}
export class NativeBilibiliVision{
  constructor(service){this.service=service;this.flights=new Map()}
  _session(value){if(typeof value!=='string'||!value||value.length>1024||/[\0\r\n]/.test(value))throw fail('B站图片必须绑定当前读取会话');return hash(value)}
  register(sources,session_id){
    assertRunActive();if(!sources.length||!session_id)return []
    const s=this.service,session_hash=this._session(session_id),out=[]
    for(const raw of sources.slice(0,20)){const source=checkedSource(raw),image_ref='bilibili-image:'+hash(JSON.stringify({session_hash,...source})),key='bilibili.image:'+image_ref.slice(15)
      if(out.some(row=>row.image_ref===image_ref))continue
      const prior=s.store.db.prepare('SELECT kind,schema_id,schema_version,value_json FROM cache_entries WHERE key=?').get(key),value={session_hash,source}
      let cached;try{cached=JSON.parse(prior?.value_json??'null')}catch{}
      if(prior?.kind==='bilibili.image'&&prior.schema_id==='companion.bilibili.image'&&prior.schema_version===1&&cached?.session_hash===session_hash&&JSON.stringify(cached.source)===JSON.stringify(source)&&/^asset:[a-f0-9]{64}$/.test(cached.asset_ref??''))value.asset_ref=cached.asset_ref
      s.store.db.prepare('INSERT INTO cache_entries(key,kind,schema_id,schema_version,value_json,created_at,expires_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,created_at=excluded.created_at,expires_at=excluded.expires_at').run(key,'bilibili.image','companion.bilibili.image',1,JSON.stringify(value),s._now(),s._now()+TTL)
      const {url,...attribution}=source;out.push({image_ref,...attribution})
    }
    s.store.db.prepare("DELETE FROM cache_entries WHERE key IN (SELECT key FROM cache_entries WHERE kind='bilibili.image' ORDER BY created_at DESC,key LIMIT -1 OFFSET 500)").run()
    return out
  }
  rows(rows,{object_id,object_type='1',session_id=''}){return rows.map(row=>{const image_refs=this.register(biliRowImageSources(row,{object_id,object_type}),session_id),{pictures,...rest}=row;return {...rest,...(pictures?.length?{picture_count:pictures.length}:{}),...(image_refs.length?{image_refs}:{})}})}
  async read({image_ref,session_id}={}){
    const s=this.service,scope=currentRunScope();s._checkEnabled();const session_hash=this._session(session_id)
    if(typeof image_ref!=='string'||!/^bilibili-image:[a-f0-9]{64}$/.test(image_ref))throw fail('请使用本次已读评论返回的image_ref')
    const key='bilibili.image:'+image_ref.slice(15),row=s.store.db.prepare("SELECT * FROM cache_entries WHERE key=? AND kind='bilibili.image' AND expires_at>?").get(key,s._now())
    let value;try{value=JSON.parse(row?.value_json??'null')}catch{}
    if(row?.schema_id!=='companion.bilibili.image'||row.schema_version!==1||value?.session_hash!==session_hash)throw fail('图片引用已过期或不属于当前会话')
    const source=checkedSource(value.source);if('bilibili-image:'+hash(JSON.stringify({session_hash,...source}))!==image_ref)throw fail('图片登记与来源摘要不一致')
    if(value.asset_ref)return {...this._result(s.assets.read(value.asset_ref),source),cached:true}
    if(this.flights.has(image_ref))return abortableRun(this.flights.get(image_ref),scope)
    const work=this._download({source,session_hash,key,image_ref,scope});this.flights.set(image_ref,work)
    try{return await work}finally{this.flights.delete(image_ref)}
  }
  _result(asset,source){const {url,...attribution}=source;return {asset_ref:asset.id,media_type:asset.media_type,byte_size:asset.byte_size,source:attribution,read_only:true,model_calls:0}}
  async _download({source,session_hash,key,image_ref,scope}){
    const s=this.service;if(!s.assets?.put||!s.assets?.read)throw new BilibiliError('原生图片仓库尚未就绪',{code:'unavailable'})
    const {bytes,media_type}=await readPublicImageBytes({url:source.url,fetcher:(url,options)=>s._mediaFetch(url,options),check:()=>s._checkEnabled(),scope})
    const {url,...attribution}=source,asset=await s.assets.put({bytes,kind:'image',media_type,source_ref:url,visibility:'public',manifest:{platform:'bilibili',source_kind:'public_comment_image',trust:'untrusted_source',attribution}});assertRunActive(scope)
    s.store.db.prepare("UPDATE cache_entries SET value_json=? WHERE key=? AND schema_id='companion.bilibili.image'").run(JSON.stringify({session_hash,source,asset_ref:asset.id}),key)
    const event_key='bilibili:image_read:'+image_ref+':'+asset.id+':'+randomUUID()
    s.store.appendJournalEvent({event_key,event_type:'platform_read',platform:'bilibili',direction:'observation',status:'confirmed',visibility:'public',text:'',ref:'bilibili:comment:'+source.object_type+':'+source.object_id+':'+source.source_message_id,source_at:s._now(),source_type:'native_bilibili',metadata:{subtype:'image_read',image_ref,asset_ref:asset.id,...attribution}})
    return {...this._result(asset,source),cached:false}
  }
  async input({sources,session_id,limit=2}={}){
    if(!Array.isArray(sources)||sources.length>20||!Number.isSafeInteger(limit)||limit<1||limit>3)throw fail('B站首轮图片输入范围无效')
    const refs=this.register(sources,session_id),images=[],unavailable=[]
    for(const ref of refs.slice(0,limit))try{const result=await this.read({image_ref:ref.image_ref,session_id}),asset=this.service.assets.read(result.asset_ref);images.push({bytes:asset.bytes,media_type:asset.media_type,asset_ref:asset.id,name:'B站图片·'+ref.author_uid+'·'+ref.source_message_id,source:result.source})}catch(error){assertRunActive();unavailable.push({source_message_id:ref.source_message_id,part_index:ref.part_index,reason:typeof error.code==='string'?error.code:'image_unavailable'})}
    return {images,unavailable,omitted:Math.max(0,refs.length-limit)}
  }
}
