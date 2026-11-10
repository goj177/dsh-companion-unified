/** Bounded native image bytes for already-authorized public source URLs.
 * URL admission belongs to the platform reader; no model URL or file API. */
import {imageType} from './qq-media.mjs'
import {currentRunScope,abortableRun,assertRunActive} from './run-scope.mjs'
const MAX_BYTES=8*1024*1024
const fail=(message,code)=>Object.assign(new Error(message),{code})
/** Existing source/quote text wins over optional image pointers. */
export function packPublicImageContext(context,sources=[]){
  const selected=[],total=sources.length,pack=()=>JSON.stringify({...context,...(selected.length?{public_image_sources:selected}:{}),...(total>selected.length?{public_images_omitted:total-selected.length}:{})})
  for(const source of sources){if(selected.length===2)break;selected.push(source);if(pack().length>4000)selected.pop()}
  return pack()
}
function dimensions(bytes,type){
  if(type==='image/png'&&bytes.length>=24)return {width:bytes.readUInt32BE(16),height:bytes.readUInt32BE(20)}
  if(type==='image/gif'&&bytes.length>=10)return {width:bytes.readUInt16LE(6),height:bytes.readUInt16LE(8)}
  if(type==='image/jpeg')for(let offset=2;offset+8<bytes.length;){if(bytes[offset++]!==255)continue;const marker=bytes[offset++];if(marker===216||marker===217||marker>=208&&marker<=215)continue;const length=bytes.readUInt16BE(offset);if(length<2||offset+length>bytes.length)break;if([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker))return {height:bytes.readUInt16BE(offset+3),width:bytes.readUInt16BE(offset+5)};offset+=length}
  if(type==='image/webp')for(let offset=12;offset+8<=bytes.length;){const chunk=bytes.subarray(offset,offset+4).toString(),length=bytes.readUInt32LE(offset+4),start=offset+8;if(length>bytes.length-start)break
    if(chunk==='VP8X'&&length>=10)return {width:1+bytes.readUIntLE(start+4,3),height:1+bytes.readUIntLE(start+7,3)}
    if(chunk==='VP8L'&&length>=5&&bytes[start]===47){const bits=bytes.readUInt32LE(start+1);return {width:1+(bits&16383),height:1+((bits>>>14)&16383)}}
    if(chunk==='VP8 '&&length>=10&&bytes.subarray(start+3,start+6).equals(Buffer.from([157,1,42])))return {width:bytes.readUInt16LE(start+6)&16383,height:bytes.readUInt16LE(start+8)&16383}
    offset=start+length+(length%2)
  }
  return null
}
export async function readPublicImageBytes({url,fetcher,check=()=>assertRunActive(),scope=currentRunScope()}={}){
  check();const timeout=AbortSignal.timeout(15000),signal=scope?.signal?AbortSignal.any([scope.signal,timeout]):timeout
  const response=await abortableRun(fetcher(url,{method:'GET',redirect:'error',credentials:'omit',signal}),scope);check()
  const declared=String(response.headers.get('content-type')??'').split(';')[0].trim().toLowerCase().replace('image/jpg','image/jpeg')
  if(!response.ok||response.status>=300||!['image/png','image/jpeg','image/webp','image/gif'].includes(declared)||Number(response.headers.get('content-length')??0)>MAX_BYTES){await response.body?.cancel().catch(()=>{});throw fail('原图未返回可用图片','image_unavailable')}
  let size=0;const chunks=[],reader=response.body?.getReader();if(!reader)throw fail('原图未返回图片字节','image_unavailable')
  try{for(;;){check();const {done,value}=await abortableRun(reader.read(),scope);if(done)break;size+=value.length;if(size>MAX_BYTES)throw fail('图片超过8MiB读取上限','image_too_large');chunks.push(Buffer.from(value))}}finally{await reader.cancel().catch(()=>{})}
  check();const bytes=Buffer.concat(chunks),media_type=imageType(bytes),sizePx=dimensions(bytes,media_type)
  if(!media_type||media_type!==declared||!sizePx||sizePx.width<1||sizePx.height<1||sizePx.width>8192||sizePx.height>8192||sizePx.width*sizePx.height>40000000)throw fail('图片字节、类型或尺寸未通过核验','invalid_image')
  return {bytes,media_type,...sizePx}
}
