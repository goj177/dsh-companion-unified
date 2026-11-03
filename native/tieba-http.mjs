/** Protocol/HTML algorithms adapted from bundled dsh-tieba-scroll 1.28.2.
 * Copyright (c) 2026 dsh-tieba-scroll contributors. MIT License.
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies
 * of the Software, and to permit persons to whom the Software is furnished to do
 * so, subject to the following conditions: The above copyright notice and this
 * permission notice shall be included in all copies or substantial portions of
 * the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
 * EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
 * MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO
 * EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES
 * OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE,
 * ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
 * DEALINGS IN THE SOFTWARE.
 * Exact AddPost fields: https://github.com/clb-128258/tbclient.protobuf/blob/main/proto/AddPost/DataReq.proto
 * This file is pure: no credentials, files, child processes, timers or network access.
 */
import {createHash} from 'node:crypto'
export const TIEBA_HOST='https://tieba.baidu.com',TIEBA_APP='https://tiebac.baidu.com'
export const TIEBA_UA='Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'
export class TiebaError extends Error{constructor(message,code='unavailable',details={}){super(message);this.name='TiebaError';this.code=code;Object.assign(this,details)}}
export function tiebaId(value,{zero=false}={}){if(typeof value==='number'){if(!Number.isSafeInteger(value))throw new TiebaError('平台坐标必须保持完整数字字符串','invalid_target');value=String(value)}if(typeof value!=='string'||!/^\d{1,100}$/.test(value)||!zero&&/^0+$/.test(value))throw new TiebaError('平台坐标必须保持完整非零数字字符串','invalid_target');return value}
export const exactTiebaJson=text=>JSON.parse(text,(_key,value,context)=>typeof value==='number'&&Number.isInteger(value)&&!Number.isSafeInteger(value)?context.source:value)
export function trustedTiebaUrl(input){let url;try{url=new URL(input)}catch{throw new TiebaError('贴吧请求地址无效','invalid_url')}if(url.protocol!=='https:'||!['tieba.baidu.com','tiebac.baidu.com'].includes(url.hostname)||url.username||url.password||url.port&&url.port!=='443')throw new TiebaError('贴吧请求地址不受信任','invalid_url');return url}
export const appSignature=params=>createHash('md5').update(Object.keys(params).sort().map(key=>key+'='+params[key]).join('')+'tiebaclient!!!').digest('hex')
// Current official pc-common request library, SubappType.PC:
// https://tb3.bdstatic.com/tb/pc/pc-common/static/js/base.4b3c29af.js This is a public
// protocol constant, not an account credential or a verification token.
export const pcSignature=params=>createHash('md5').update(Object.keys(params).filter(key=>!['sign','sig'].includes(key)).sort().map(key=>key+'='+params[key]).join('')+'36770b1f34c9bbf2e7d1a99d2b82fa9e').digest('hex')
export const decodeHtml=value=>String(value??'').replace(/<br\s*\/?>/gi,'\n').replace(/<[^>]+>/g,'').replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&#(x[0-9a-f]+|\d+);/gi,(_,v)=>{const n=v[0].toLowerCase()==='x'?parseInt(v.slice(1),16):Number(v);return n>=0&&n<=0x10ffff?String.fromCodePoint(n):''})
export function parseBarHtml(html){
  const threads=[],seen=new Set(),re=/<a[^>]+href=["'](?:(?:https?:)?\/\/tieba\.baidu\.com)?\/p\/(\d+)[^"']*["'][^>]*>([\s\S]*?)<\/a>/g;let m
  while((m=re.exec(html))){const title=decodeHtml(m[2]).replace(/\s+/g,' ').trim();if(!title||seen.has(m[1]))continue;seen.add(m[1]);const tail=html.slice(re.lastIndex,re.lastIndex+400);threads.push({thread_id:m[1],title,reply_count:Number(/ti_num[^>]*>\s*(\d+)/.exec(tail)?.[1]??0)})}
  return {bar:decodeHtml(/<title[^>]*>([^<]+)/i.exec(html)?.[1]??'').replace(/吧_百度贴吧.*/,''),forum_id:/fid=(\d+)/.exec(html)?.[1]??'',following:/"is_like"\s*:\s*"?1"?/.test(html),signed:/"is_sign_in"\s*:\s*"?1"?/.test(html),threads}
}
export function parsePcBar(data,bar){
  const value=data.data??data,forum=value.forum??{},threads=[],seen=new Set()
  for(const row of value.page_data?.feed_list??[]){const item=row.feed?.business_info_map;if(!item||!item.thread_id||!item.title)continue;const thread_id=tiebaId(item.thread_id);if(seen.has(thread_id)||item.forum_name&&item.forum_name!==bar)continue;seen.add(thread_id);threads.push({thread_id,title:decodeHtml(item.title).trim(),reply_count:Number(item.reply_num??item.reply_count??0)})}
  const first=value.page_data?.feed_list?.find(row=>row.feed?.business_info_map?.forum_id)?.feed.business_info_map
  return {bar,forum_id:tiebaId(forum.id??forum.fid??first?.forum_id),following:String(forum.is_like??first?.forum_is_liked??'0')==='1',signed:String(value.sign_info?.user_info?.is_sign_in??forum.is_sign_in??'0')==='1',threads}
}
export function parseThreadHtml(html){
  const floors=[],owners=[],images=[],seen=new Set(),re=/<div class=["']([^"']*content[^"']*)["'][^>]*>([\s\S]*?)<\/div>/g;let m
  while((m=re.exec(html))){if(m[1].includes('top_bar'))continue;const body=decodeHtml(m[2]).trim();if(body){const before=html.slice(Math.max(0,m.index-4000),m.index),names=[...before.matchAll(/class=["']user_name[^"']*["'][^>]*>([\s\S]*?)<\//g)];floors.push(body);owners.push(decodeHtml(names.at(-1)?.[1]??'').replace(/[:：]\s*$/,''))}
    for(const image of m[2].matchAll(/(?:data-src|src|data-url)=["']([^"']+)["']/g)){let value=image[1].replace(/&amp;/g,'&');if(value.startsWith('//'))value='https:'+value;if(!/^https:\/\//.test(value)||/editor\/images|image_emoticon/.test(value)||seen.has(value))continue;seen.add(value);images.push(value)}}
  return {title:decodeHtml(/<title[^>]*>([^<]+)/i.exec(html)?.[1]??''),bar:/"fname"\s*:\s*"([^"]+)"/.exec(html)?.[1]??'',floors,owners,images:images.slice(0,20),image_count:images.length}
}
export function pbVarint(input){let value=typeof input==='bigint'?input:typeof input==='string'&&/^\d+$/.test(input)?BigInt(input):typeof input==='number'&&Number.isSafeInteger(input)&&input>=0?BigInt(input):null;if(value===null||value<0n||value>0xffffffffffffffffn)throw new TiebaError('protobuf整数无效','invalid_input');const bytes=[];while(value>127n){bytes.push(Number(value&127n)|128);value>>=7n}bytes.push(Number(value));return Buffer.from(bytes)}
export const pbInt=(field,value)=>Buffer.concat([pbVarint(field*8),pbVarint(value)])
export const pbBytes=(field,value)=>Buffer.concat([pbVarint(field*8+2),pbVarint(value.length),Buffer.from(value)])
export const pbString=(field,value)=>pbBytes(field,Buffer.from(String(value)))
export function pbFields(input){
  const bytes=Buffer.from(input),rows=[];let pos=0
  const integer=()=>{let value=0n;for(let i=0;i<10;i++){if(pos>=bytes.length)throw new TiebaError('protobuf响应截断','invalid_response');const b=bytes[pos++];value|=BigInt(b&127)<<BigInt(i*7);if(!(b&128)){if(value>0xffffffffffffffffn)throw new TiebaError('protobuf整数溢出','invalid_response');return value}}throw new TiebaError('protobuf整数无效','invalid_response')}
  while(pos<bytes.length){const tag=integer(),field=Number(tag>>3n),wire=Number(tag&7n);if(!field||field>536870911)throw new TiebaError('protobuf字段无效','invalid_response');if(wire===0)rows.push({field,wire,value:integer()});else if(wire===2){const n=integer();if(n>BigInt(bytes.length-pos))throw new TiebaError('protobuf响应截断','invalid_response');const size=Number(n);rows.push({field,wire,bytes:bytes.subarray(pos,pos+size)});pos+=size}else if(wire===1||wire===5){const n=wire===1?8:4;if(pos+n>bytes.length)throw new TiebaError('protobuf响应截断','invalid_response');pos+=n}else throw new TiebaError('不支持的protobuf字段','invalid_response')}
  return rows
}
const small=value=>{if(value>BigInt(Number.MAX_SAFE_INTEGER))throw new TiebaError('平台计数超出精确范围','invalid_response');return Number(value)}
const utf8=bytes=>{try{return new TextDecoder('utf-8',{fatal:true}).decode(bytes)}catch{throw new TiebaError('平台文字编码无法核验','invalid_response')}}
const pbText=bytes=>pbFields(bytes).filter(row=>row.field===2&&row.bytes).map(row=>utf8(row.bytes)).join('')
const common=(bduss,version='22.12.1.0',tbs='')=>Buffer.concat([pbInt(1,2),pbString(2,version),pbString(10,bduss),...(tbs?[pbString(11,tbs)]:[])])
export function encodePageRequest({thread_id,post_id,page=1,limit=30,sort=1,bduss=''}){return pbBytes(1,Buffer.concat([pbBytes(25,common(bduss,'12.64.1.1')),pbInt(4,tiebaId(thread_id)),...(post_id?[pbInt(7,tiebaId(post_id))]:[]),pbInt(5,0),pbInt(6,sort),pbInt(13,limit),pbInt(18,page),pbInt(8,0),pbInt(9,0),pbInt(74,1)]))}
export function encodeSubRequest({thread_id,post_id,page=1,bduss=''}){return pbBytes(1,Buffer.concat([pbInt(1,tiebaId(thread_id)),pbInt(2,tiebaId(post_id)),pbInt(4,page),pbBytes(9,common(bduss))]))}
function pbUser(bytes){const row={uid:'',name:'',name_show:'',portrait:''};for(const f of pbFields(bytes)){if(f.field===2&&f.value!==undefined)row.uid=f.value.toString();else if(f.bytes&&f.field===3)row.name=utf8(f.bytes);else if(f.bytes&&f.field===4)row.name_show=utf8(f.bytes);else if(f.bytes&&f.field===5)row.portrait=utf8(f.bytes)}if(!row.name_show)row.name_show=row.name;return row}
export function encodeProfileRequest({portrait,bduss=''}){return pbBytes(1,Buffer.concat([pbInt(2,1),pbInt(15,1),pbString(16,portrait),pbBytes(9,common(bduss))]))}
export function parseUserProfile(bytes){const fields=pbFields(bytes),error=fields.find(x=>x.field===1)?.bytes;if(error){const code=pbFields(error).find(x=>x.field===1)?.value??0n;if(code!==0n){const failure=new TiebaError('官方用户资料读取被拒绝','read_failed');failure.server_code=Number(code);throw failure}}const data=fields.find(x=>x.field===2)?.bytes,user=data&&pbFields(data).find(x=>x.field===1)?.bytes;if(!user)throw new TiebaError('官方用户资料缺少身份字段','invalid_response');return pbUser(user)}
export function parsePagePosts(bytes){const rows=[];for(const top of pbFields(bytes))if(top.field===2&&top.bytes)for(const p of pbFields(top.bytes))if(p.field===6&&p.bytes){const row={post_id:'',floor:0,author_uid:'',likes:0,reply_count:0,source_at:0,text:''};for(const f of pbFields(p.bytes)){if(f.value!==undefined){if(f.field===1)row.post_id=f.value.toString();else if(f.field===3)row.floor=small(f.value);else if(f.field===4)row.source_at=small(f.value)*1000;else if(f.field===19)row.author_uid=f.value.toString();else if(f.field===13)row.reply_count=small(f.value)}else if(f.field===5&&f.bytes)row.text+=pbText(f.bytes);else if(f.field===37&&f.bytes)for(const a of pbFields(f.bytes))if(a.field===1&&a.value!==undefined)row.likes=small(a.value)}if(row.floor&&row.post_id)rows.push(row)}return rows}
/** Pagination and forum identity from the same official PbPage response. */
export function parsePostPage(bytes){
  const top=pbFields(bytes),data=top.find(row=>row.field===2)?.bytes,error=top.find(row=>row.field===1)?.bytes
  if(error){const rows=pbFields(error),code=rows.find(row=>row.field===1)?.value??0n;if(code!==0n)throw new TiebaError('官方楼层读取被拒绝','read_failed',{server_code:small(code)})}
  if(!data)throw new TiebaError('官方楼层数据缺失','invalid_response')
  const fields=pbFields(data),page=fields.find(row=>row.field===3)?.bytes,forum=fields.find(row=>row.field===2)?.bytes,ints=page?pbFields(page):[]
  const number=field=>{const value=ints.find(row=>row.field===field)?.value;return value===undefined?null:small(value)},current_page=number(3),total_page=number(5)
  if(!current_page||!total_page||current_page>total_page||total_page>1000000)throw new TiebaError('官方分页坐标无法核验','invalid_response')
  const forum_id=forum?pbFields(forum).find(row=>row.field===1)?.value?.toString()??'':''
  return {posts:parsePagePosts(bytes),forum_id,page:{current_page,total_page,total_count:number(4)},response_sha256:createHash('sha256').update(bytes).digest('hex')}
}
export function parseSubPosts(bytes){const rows=[];for(const top of pbFields(bytes))if(top.field===2&&top.bytes)for(const p of pbFields(top.bytes))if(p.field===4&&p.bytes){const row={sub_reply_id:'',floor:0,likes:0,source_time:0,text:'',author:{uid:'',name:'',name_show:'',portrait:''}};for(const f of pbFields(p.bytes)){if(f.value!==undefined){if(f.field===1)row.sub_reply_id=f.value.toString();else if(f.field===3)row.source_time=small(f.value);else if(f.field===6)row.floor=small(f.value)}else if(f.field===2&&f.bytes){row.text+=pbText(f.bytes);const content=pbFields(f.bytes),type=content.find(part=>part.field===1)?.value,uid=content.find(part=>part.field===15)?.value;if(type===4n&&uid)row.mention_uids=[...(row.mention_uids??[]),uid.toString()]}else if(f.field===7&&f.bytes)row.author=pbUser(f.bytes);else if(f.field===9&&f.bytes)for(const a of pbFields(f.bytes))if(a.field===1&&a.value!==undefined)row.likes=small(a.value)}if(row.sub_reply_id)rows.push(row)}return rows}
export function parseSubPage(bytes){
  const top=pbFields(bytes),data=top.find(row=>row.field===2)?.bytes,error=top.find(row=>row.field===1)?.bytes
  if(error){const code=pbFields(error).find(row=>row.field===1)?.value??0n;if(code!==0n)throw new TiebaError('官方楼中楼读取被拒绝','read_failed',{server_code:small(code)})}
  if(!data)throw new TiebaError('官方楼中楼数据缺失','invalid_response')
  const fields=pbFields(data),pageBytes=fields.find(row=>row.field===1)?.bytes,ints=pageBytes?pbFields(pageBytes):[],number=field=>{const value=ints.find(row=>row.field===field)?.value;return value===undefined?null:small(value)},posts=parseSubPosts(bytes),empty=posts.length===0&&(number(4)??0)===0&&(number(5)??0)===0,current_page=empty&&!(number(3)>1)?1:number(3),total_page=empty?1:number(5)
  if(!current_page||!total_page||current_page>total_page||total_page>1000000)throw new TiebaError('官方楼中楼分页无法核验','invalid_response')
  const id=field=>{const raw=fields.find(row=>row.field===field)?.bytes;return raw?pbFields(raw).find(row=>row.field===1)?.value?.toString()??'':''}
  return {posts:posts.map(row=>({...row,post_id:row.sub_reply_id,author_uid:row.author.uid,source_at:row.source_time*1000})),forum_id:id(8)||id(6),thread_id:id(5),parent_post_id:id(3),page:{current_page,total_page,total_count:number(4)},response_sha256:createHash('sha256').update(bytes).digest('hex')}
}
const challengeValue=value=>value!==null&&value!==undefined&&value!==false&&value!==0&&value!==''&&value!=='0'&&value!=='false'
const captchaIn=(value,container=false)=>value&&typeof value==='object'?Object.entries(value).some(([key,child])=>/^(?:verify_url|vcode_url|need_vcode|vcode_md5)$/i.test(key)&&typeof child!=='object'&&challengeValue(child)||/^(?:vcode|captcha)$/i.test(key)&&(typeof child==='object'?captchaIn(child,true):challengeValue(child))||container&&/^(?:url|str_reason)$/i.test(key)&&typeof child==='string'&&!!child||captchaIn(child,container)):false
export function parseAddReceipt(bytes){
  const raw=Buffer.from(bytes),text=raw.toString('utf8').trim(),sha256=createHash('sha256').update(raw).digest('hex')
  const base={valid:false,code:null,message:'',post_id:'',thread_id:'',captcha_present:false,response_sha256:sha256}
  if(text.startsWith('{')){let j;try{j=exactTiebaJson(text)}catch{return base};const outer=Number(j.no??j.error_code??j.error?.errno??NaN),code=outer===0&&Number(j.data?.errno)?Number(j.data.errno):outer,post=j.data?.pid??j.data?.post_id??j.data?.spid??'';return {...base,valid:Number.isSafeInteger(code),code:Number.isSafeInteger(code)?code:null,message:String(j.error_msg??j.error?.errmsg??j.data?.errmsg??(typeof j.error==='string'?j.error:'')),post_id:/^\d+$/.test(String(post))?String(post):'',thread_id:/^\d+$/.test(String(j.data?.tid??''))?String(j.data.tid):'',captcha_present:captchaIn(j),...(j.data?.is_post_visible===undefined?{}:{visible:j.data.is_post_visible!==0})}}
  if(/^\s*(?:<!doctype|<html)/i.test(text))return {...base,message:'平台返回网页而非发表回执',captcha_present:/<title[^>]*>[^<]*(?:安全验证|验证码)|(?:captcha|vcode)_url/i.test(text)}
  try{let recognized=false,code=0,message='',post_id='',thread_id='',captcha_present=false;for(const top of pbFields(raw)){if(top.field===1&&top.bytes){recognized=true;for(const f of pbFields(top.bytes)){if(f.field===1&&f.value!==undefined)code=small(f.value);if(f.field===2&&f.bytes)message=f.bytes.toString('utf8')}}else if(top.field===2&&top.bytes)for(const f of pbFields(top.bytes)){if(f.field===3&&f.bytes){post_id=f.bytes.toString('utf8');if(/^\d+$/.test(post_id))recognized=true}if(f.field===2&&f.bytes)thread_id=f.bytes.toString('utf8');if(f.field===17&&f.bytes?.length)captcha_present=true}}return {...base,valid:recognized,code:recognized?code:null,message,post_id,thread_id,captcha_present}}catch{return base}
}
export function parseUploadReceipt(text){try{const j=exactTiebaJson(text);if(Number(j.no)===0&&typeof j.data?.upload_img_info==='string')return {ok:true,image_info:j.data.upload_img_info,image_url:j.data.upload_img_url??''};if(Number.isFinite(Number(j.no)))return {ok:false,code:Number(j.no),captcha_present:captchaIn(j)}}catch{}const info=/imageInfo:'([^']+)'/.exec(text)?.[1],src=/imageSrc:'([^']*)'/.exec(text)?.[1];return {ok:!!info,image_info:info??'',image_url:(src??'').replace(/\\\//g,'/')}}
export function imageReplyFields({bar,thread_id,forum_id,tbs,content,image_info,now}){return {co:content,_t:String(now),tag:'11',upload_img_info:image_info,fid:forum_id,src:'1',word:bar,tbs,z:thread_id,lp:'6026'}}
export function outboundAllowed(value){const masked=String(value).replace(/```[\s\S]*?```|`[^`\n]*`|^>[^\n]*/gm,'');return !/(?:\b(?:bduss|stoken|password|passwd)\b|\.dsh\b|\/(?:Users|home|root)\/|[A-Za-z]:\\)/i.test(masked)}
