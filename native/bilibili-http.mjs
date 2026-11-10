/** Bilibili protocol primitives, isolated from every legacy path/config/traffic reader. */
import {createHash} from 'node:crypto'

const MIXIN=[46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52]
export const BILIBILI_RISK_CODES=new Set([-412,-352,-799,-509,-10403])
export class BilibiliError extends Error {constructor(message,{code='unavailable',http_status=0,server_code=null}={}){super(message);this.name='BilibiliError';this.code=code;this.http_status=http_status;this.server_code=server_code}}
export function exactJson(text){return JSON.parse(text,(_key,value,context)=>typeof value==='number'&&Number.isInteger(value)&&!Number.isSafeInteger(value)?context.source:value)}
export function biliId(value,{zero=false}={}){if(typeof value==='number'){if(!Number.isSafeInteger(value))throw new BilibiliError('平台ID必须保持精确字符串',{code:'invalid_target'});value=String(value)}if(typeof value!=='string'||!/^\d{1,100}$/.test(value)||!zero&&/^0+$/.test(value))throw new BilibiliError('平台ID必须为完整非零数字字符串',{code:'invalid_target'});return value}
export function bvidOf(value){if(typeof value!=='string'||!/^BV[A-Za-z0-9]{10}$/.test(value))throw new BilibiliError('需要完整BV号',{code:'invalid_target'});return value}
export function signedWbi(params,images,now){
  const key=url=>String(url??'').split('/').at(-1).split('.')[0],raw=key(images?.img_url)+key(images?.sub_url)
  if(raw.length!==64)throw new BilibiliError('B站签名密钥尚未就绪',{code:'wbi_unavailable'})
  const mixin=MIXIN.map(i=>raw[i]).join('').slice(0,32),values={...params,wts:Math.floor(now/1000)};delete values.w_rid
  const query=Object.keys(values).sort().map(key=>encodeURIComponent(key)+'='+encodeURIComponent(String(values[key]).replace(/[!'()*]/g,''))).join('&')
  return query+'&w_rid='+createHash('md5').update(query+mixin).digest('hex')
}
export function trustedBiliUrl(input,{cdn=false,login=false}={}){
  let url;try{url=new URL(String(input).startsWith('//')?'https:'+input:input)}catch{throw new BilibiliError('平台返回了无效地址',{code:'invalid_remote_url'})}
  const host=url.hostname.toLowerCase(),allowed=cdn?['bilibili.com','hdslb.com','bilivideo.com','bilivideo.cn'].some(root=>host===root||host.endsWith('.'+root)):login?['passport.bilibili.com','account.bilibili.com'].includes(host):['api.bilibili.com','api.vc.bilibili.com','api.live.bilibili.com','passport.bilibili.com'].includes(host)
  if(url.protocol!=='https:'||url.username||url.password||url.port&&url.port!=='443'||!allowed)throw new BilibiliError('平台返回了不受信任的地址',{code:'invalid_remote_url'})
  return url
}
export async function boundedBody(response,maxBytes=8*1024*1024){
  const declared=Number(response.headers?.get?.('content-length'));if(declared>maxBytes)throw new BilibiliError('平台响应超过容量限制',{code:'response_too_large'})
  if(!response.body?.getReader){const bytes=Buffer.from(await response.arrayBuffer());if(bytes.length>maxBytes)throw new BilibiliError('平台响应超过容量限制',{code:'response_too_large'});return bytes}
  const reader=response.body.getReader(),chunks=[];let size=0
  try{for(;;){const{done,value}=await reader.read();if(done)break;size+=value.length;if(size>maxBytes)throw new BilibiliError('平台响应超过容量限制',{code:'response_too_large'});chunks.push(Buffer.from(value))}return Buffer.concat(chunks)}finally{await reader.cancel().catch(()=>{})}
}
export function cleanSourceText(value,max=64000){return String(value??'').replace(/<[^>]*>/g,'').slice(0,max)}
export function pageText(text,{offset=0,max_chars=1800}={}){if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(max_chars)||max_chars<1||max_chars>6400)throw new BilibiliError('分页范围无效',{code:'invalid_input'});const end=Math.min(text.length,offset+max_chars);return{text:text.slice(offset,end),offset,total_chars:text.length,next_offset:end<text.length?end:null}}
export function imageInfo(bytes){
  const data=Buffer.from(bytes)
  if(data.length>=24&&data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return{media_type:'image/png',extension:'png',width:data.readUInt32BE(16),height:data.readUInt32BE(20)}
  if(data.length>=10&&/^GIF8[79]a$/.test(data.subarray(0,6).toString('ascii')))return{media_type:'image/gif',extension:'gif',width:data.readUInt16LE(6),height:data.readUInt16LE(8)}
  if(data.length>=4&&data[0]===255&&data[1]===216){let at=2;while(at+9<data.length){if(data[at]!==255){at++;continue}const marker=data[at+1];if(marker>=192&&marker<=207&&![196,200,204].includes(marker))return{media_type:'image/jpeg',extension:'jpg',width:data.readUInt16BE(at+7),height:data.readUInt16BE(at+5)};const length=data.readUInt16BE(at+2);if(length<2)break;at+=2+length}}
  throw new BilibiliError('评论或动态图片需使用有效PNG、JPG或GIF原生资产',{code:'invalid_asset'})
}
