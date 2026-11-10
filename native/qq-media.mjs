import http from 'node:http'
import https from 'node:https'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { createHash } from 'node:crypto'
export {createQQBridgeCacheReader} from './qq-bridge-cache.mjs'

const hash=bytes=>createHash('sha256').update(bytes).digest('hex')
const opaqueMediaFile=value=>typeof value==='string'&&/^[a-z0-9][a-z0-9_.-]{0,239}$/i.test(value)&&value!=='.'&&value!=='..'
function boundedBase64(value,max_bytes){
  if(typeof value!=='string'||value.length>Math.ceil(max_bytes*4/3)+8||!/^[a-z0-9+/]*={0,2}$/i.test(value))throw new Error('媒体base64无效或超出限制')
  const bytes=Buffer.from(value,'base64');if(!bytes.length||bytes.length>max_bytes)throw new Error('媒体为空或超过入站限制');return bytes
}
const privateIP=address=>{
  const ip=address.toLowerCase()
  if(ip.includes(':'))return ip==='::'||ip==='::1'||/^f[cd]/.test(ip)||/^fe[89ab]/.test(ip)||ip.startsWith('::ffff:')&&privateIP(ip.slice(7))||!/^2[0-9a-f]{3}:/.test(ip)
  const [a,b]=ip.split('.').map(Number)
  return a===0||a===10||a===127||a===169&&b===254||a===172&&b>=16&&b<=31||a===192&&b===168||a===100&&b>=64&&b<=127||a>=224||a===198&&(b===18||b===19)
}
export function imageType(bytes){
  if(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return 'image/png'
  if(bytes[0]===255&&bytes[1]===216&&bytes[2]===255)return 'image/jpeg'
  if(/^GIF8[79]a$/.test(bytes.subarray(0,6).toString()))return 'image/gif'
  if(bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP')return 'image/webp'
  return ''
}
function dimensions(bytes,type){
  if(type==='image/png'&&bytes.length>=24)return {width:bytes.readUInt32BE(16),height:bytes.readUInt32BE(20)}
  if(type==='image/gif'&&bytes.length>=10)return {width:bytes.readUInt16LE(6),height:bytes.readUInt16LE(8)}
  if(type==='image/webp'&&bytes.length>=30&&bytes.subarray(12,16).toString()==='VP8X')return {width:1+bytes.readUIntLE(24,3),height:1+bytes.readUIntLE(27,3)}
  if(type==='image/jpeg')for(let offset=2;offset+8<bytes.length;){if(bytes[offset++]!==255)continue;const marker=bytes[offset++];if(marker===216||marker===217||marker>=208&&marker<=215)continue;const length=bytes.readUInt16BE(offset);if(length<2||offset+length>bytes.length)break;if([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker))return {height:bytes.readUInt16BE(offset+3),width:bytes.readUInt16BE(offset+5)};offset+=length}
  return null
}
/** Byte-only equivalent of the bundled image-shrink algorithm. Source files
 * are retained separately; animated GIFs keep their original animation. */
export async function shrinkQQImage(bytes,max_px){
  const type=imageType(bytes),size=dimensions(bytes,type)
  if(size&&(size.width>8192||size.height>8192||size.width*size.height>40000000))throw new Error('图片超过安全解码像素上限')
  if(max_px<=0||type==='image/gif'||size&&Math.max(size.width,size.height)<=max_px)return null
  const {createCanvas,loadImage}=await import('@napi-rs/canvas'),image=await loadImage(bytes)
  if(image.width>8192||image.height>8192)throw new Error('图片超过安全解码像素上限')
  if(Math.max(image.width,image.height)<=max_px)return null
  const scale=max_px/Math.max(image.width,image.height),canvas=createCanvas(Math.max(1,Math.round(image.width*scale)),Math.max(1,Math.round(image.height*scale)))
  canvas.getContext('2d').drawImage(image,0,0,canvas.width,canvas.height)
  return {bytes:canvas.toBuffer('image/jpeg',85),media_type:'image/jpeg'}
}
function mediaType(bytes,kind,fallback){
  if(kind==='image')return imageType(bytes)
  if(kind==='video'&&bytes.subarray(4,8).toString()==='ftyp')return 'video/mp4'
  if(kind==='voice'){
    if(bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WAVE')return 'audio/wav'
    if(bytes.subarray(0,4).toString()==='OggS')return 'audio/ogg'
    if(bytes.subarray(0,5).toString()==='#!AMR')return 'audio/amr'
    if(bytes.subarray(0,16).toString().includes('#!SILK_V3'))return 'audio/silk'
    if(bytes.subarray(0,3).toString()==='ID3'||bytes[0]===255&&(bytes[1]&224)===224)return 'audio/mpeg'
  }
  return fallback
}
/** Bounded, redirect-checked and DNS-pinned download. No local-file or command
 * interpretation exists. An explicit native private-host setting is required
 * for a local NapCat media endpoint. */
export async function downloadQQMedia({url,max_bytes=20*1024*1024,allow_private_hosts=false,timeout_ms=30000}){
  const deadline=Date.now()+timeout_ms
  for(let hops=0,current=url;hops<=3;hops++){
    const parsed=new URL(current)
    if(!['http:','https:'].includes(parsed.protocol)||parsed.username||parsed.password)throw new Error('媒体下载只允许无身份信息的HTTP/HTTPS链接')
    const hostname=parsed.hostname.replace(/^\[|\]$/g,''),addresses=isIP(hostname)?[{address:hostname,family:isIP(hostname)}]:await lookup(hostname,{all:true,verbatim:true})
    if(!addresses.length||!allow_private_hosts&&addresses.some(item=>privateIP(item.address)))throw new Error('媒体下载目标被私网围栏拒绝')
    const address=addresses[0],remaining=deadline-Date.now()
    if(remaining<=0)throw new Error('媒体下载超时')
    const response=await new Promise((resolve,reject)=>{
      const request=(parsed.protocol==='https:'?https:http).get(parsed,{lookup:(_host,options,callback)=>{const done=typeof options==='function'?options:callback;if(options?.all===true)done(null,[{address:address.address,family:address.family}]);else done(null,address.address,address.family)},timeout:remaining},resolve)
      request.on('timeout',()=>request.destroy(new Error('媒体下载超时')));request.on('error',reject)
    })
    if([301,302,303,307,308].includes(response.statusCode)){
      const location=response.headers.location;response.destroy();if(!location||hops===3)throw new Error('媒体重定向缺失或过多');current=new URL(location,parsed).href;continue
    }
    if(response.statusCode!==200){response.destroy();throw new Error('媒体服务返回非成功状态')}
    const chunks=[];let size=0
    for await(const chunk of response){size+=chunk.length;if(Date.now()>deadline){response.destroy();throw new Error('媒体下载超时')};if(size>max_bytes){response.destroy();throw new Error('媒体超过字节上限')};chunks.push(chunk)}
    return {bytes:Buffer.concat(chunks),media_type:String(response.headers['content-type']??'application/octet-stream').split(';')[0]}
  }
  throw new Error('媒体重定向过多')
}

export class NativeQQMedia {
  constructor({store,assets,download=downloadQQMedia,transcriber,card_renderer,bridge_cache_reader}={}){this.store=store;this.assets=assets;this.download=download;this.transcriber=transcriber;this.card_renderer=card_renderer;this.bindBridgeCacheReader(bridge_cache_reader)}
  bindBridgeCacheReader(reader){if(reader!==undefined&&typeof reader!=='function')throw new Error('OneBot缓存读取必须由可信宿主显式绑定');this.bridge_cache_reader=reader}
  ready(){if(!this.assets?.put||!this.assets?.read)throw new Error('NativeAssets媒体服务尚未就绪')}
  async put(bytes,{kind,media_type,source_ref='',visibility='conversation'}={}){
    this.ready();if(!Buffer.isBuffer(bytes)&&!(bytes instanceof Uint8Array))throw new Error('媒体必须为真实字节')
    const result=await this.assets.put({bytes:Buffer.from(bytes),kind,media_type,source_ref,visibility})
    if(!result?.id||!this.store.db.prepare('SELECT id FROM assets WHERE id=?').get(result.id))throw new Error('媒体服务未返回已登记原生asset_ref')
    return result
  }
  async read(asset_ref,{max_bytes=20*1024*1024,image=false}={}){
    this.ready();if(typeof asset_ref!=='string')throw new Error('媒体必须提供asset_ref')
    const row=this.store.db.prepare('SELECT id,sha256,byte_size,media_type FROM assets WHERE id=?').get(asset_ref)
    if(!row)throw new Error('媒体asset_ref未登记')
    const value=await this.assets.read(asset_ref),bytes=Buffer.from(value?.bytes??[])
    if(!bytes.length||bytes.length>max_bytes||bytes.length!==row.byte_size||hash(bytes)!==row.sha256)throw new Error('媒体字节与原生登记不符或超过限制')
    if(image&&!imageType(bytes))throw new Error('媒体不是已验证图片')
    return {...value,bytes,media_type:row.media_type}
  }
  async resolve(ref,{call,settings={}}){
    this.ready();let file=ref.file??'',url=ref.url,media_type='application/octet-stream',bytes,cache_source=false
    const max_bytes=Math.max(1,settings.inbound_file_max_bytes||20*1024*1024)
    if(file.startsWith('base64://'))bytes=boundedBase64(file.slice(9),max_bytes)
    else if(ref.kind==='image'?opaqueMediaFile(file):!url&&file&&!file.startsWith('file:')&&!file.startsWith('/')){
      const action=ref.kind==='image'?'get_image':ref.kind==='voice'?'get_record':'get_file';let data
      try{data=await call(action,ref.kind==='file'?{file_id:ref.fileId??file}:{file})}catch(error){if(ref.kind!=='image'||!url)throw error}
      url=typeof data?.url==='string'?data.url:url
      if(data?.bytes instanceof Uint8Array)bytes=Buffer.from(data.bytes)
      else if(typeof data?.base64==='string')bytes=boundedBase64(data.base64,max_bytes)
      else if(typeof data?.file==='string'&&data.file.startsWith('base64://'))bytes=boundedBase64(data.file.slice(9),max_bytes)
      else if(ref.kind==='image'&&typeof data?.file==='string'&&data.file.startsWith('/')&&this.bridge_cache_reader){const cached=await this.bridge_cache_reader({bridge_file:data.file,kind:'image',max_bytes});if(!(cached?.bytes instanceof Uint8Array))throw new Error('OneBot缓存未返回可核验的真实图片字节');bytes=Buffer.from(cached.bytes);cache_source=true}
    }
    if(!bytes&&url){const downloaded=await this.download({url,max_bytes,allow_private_hosts:settings.allow_private_hosts===true});bytes=downloaded.bytes;media_type=downloaded.media_type}
    if(!bytes)throw new Error('媒体未提供可下载字节；本地路径需先登记为原生资源')
    bytes=Buffer.from(bytes);if(!bytes.length||bytes.length>max_bytes)throw new Error('媒体为空或超过入站限制')
    media_type=mediaType(bytes,ref.kind,media_type)
    if(ref.kind==='image'&&!media_type)throw new Error('图片格式未通过验证')
    const derivative=ref.kind==='image'?await shrinkQQImage(bytes,settings.inbound_image_max_px??2048):null
    const original=await this.put(bytes,{kind:ref.kind,media_type,source_ref:cache_source?'qq:onebot-image-cache':url??'',visibility:'conversation'})
    let asset=original
    if(ref.kind==='image'){
      if(derivative){asset=await this.put(derivative.bytes,{kind:'image',media_type:derivative.media_type,visibility:'conversation'});const relation='relation:'+hash(Buffer.from(asset.id+'\0derived_from\0'+original.id));this.store.db.prepare("INSERT OR IGNORE INTO relations(id,subject_kind,subject_id,relation,object_kind,object_id,created_at,metadata_json) VALUES(?,'asset',?,'derived_from','asset',?,?,'{}')").run(relation,asset.id,original.id,this.store.now())}
    }
    let transcript
    if(ref.kind==='voice'&&settings.stt_enabled!==false&&this.transcriber){let timer;const controller=new AbortController();try{transcript=await Promise.race([Promise.resolve(this.transcriber({asset_ref:asset.id,bytes,signal:controller.signal,settings:{engine:settings.stt_engine,model:settings.stt_model,timeout_ms:settings.stt_timeout_ms??60000,command_ref:settings.stt_command_ref,interpreter_ref:settings.interpreter_ref,args:settings.stt_args??[]}})),new Promise(resolve=>{timer=setTimeout(()=>{controller.abort();resolve(undefined)},settings.stt_timeout_ms??60000)})])}catch{}finally{clearTimeout(timer)}}
    return {asset_ref:asset.id,kind:ref.kind,...(original.id!==asset.id?{original_asset_ref:original.id}:{}),...(typeof transcript==='string'?{transcript:transcript.slice(0,16000)}:{})}
  }
  async card(text,settings={}){
    if(!this.card_renderer)throw new Error('原生文字图资源渲染器尚未就绪')
    const result=await this.card_renderer({text,footer:settings.card_footer??'',font_refs:settings.font_files??[],font_families:settings.font_families??[]})
    return this.put(result.bytes??result,{kind:'image',media_type:'image/png',visibility:'conversation'})
  }
}
