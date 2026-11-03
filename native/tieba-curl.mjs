/** Controlled native curl transport. No jar, legacy module, shell or temporary credential file. */
import {spawn} from 'node:child_process'

const HOSTS=new Set(['tieba.baidu.com','tiebac.baidu.com'])
const HEADERS=new Set(['user-agent','accept-language','referer','cookie','x_bd_data_type','content-type','origin'])
const HEADER_LIMIT=128*1024,BODY_LIMIT=32*1024*1024
const failure=(code='tieba_transport_failed')=>Object.assign(new Error({tieba_transport_invalid_input:'贴吧受控传输参数无效',tieba_transport_aborted:'贴吧受控传输已取消',tieba_transport_spawn_failed:'贴吧本机传输程序尚未就绪',tieba_transport_not_started:'贴吧网络开始检查未通过，未发送请求',tieba_transport_size_limit:'贴吧传输内容超过容量限制',tieba_transport_response_invalid:'贴吧响应状态或响应头无法核验'}[code]??'贴吧受控传输未完成；未自动重试'),{name:'TiebaCurlTransportError',code})
const quote=value=>'"'+value.replace(/\\/g,'\\\\').replace(/"/g,'\\"')+'"'
function officialUrl(input){
  if(!(typeof input==='string'||input instanceof URL))throw failure('tieba_transport_invalid_input')
  const raw=typeof input==='string'?input:input.href
  if(/[\0\r\n]/.test(raw)||/%(?:00|0a|0d)/i.test(raw)||raw.length>16384)throw failure('tieba_transport_invalid_input')
  let url;try{url=new URL(raw)}catch{throw failure('tieba_transport_invalid_input')}
  if(url.protocol!=='https:'||!HOSTS.has(url.hostname)||url.username||url.password||url.port||url.hash)throw failure('tieba_transport_invalid_input')
  for(const[key,value]of url.searchParams)if(/bduss|stoken|cookie|tbs|password|passwd|access_token|csrf|authorization|credential|secret/i.test(key)||/(?:bduss|stoken|cookie|tbs|password|passwd|access_token|csrf|authorization)\s*[:=]/i.test(value))throw failure('tieba_transport_invalid_input')
  return url
}
function requestHeaders(input,url){
  if(input===undefined)return new Map()
  let entries
  if(input instanceof Headers)entries=[...input.entries()]
  else if(Array.isArray(input))entries=input
  else if(input&&typeof input==='object'&&Object.getPrototypeOf(input)===Object.prototype)entries=Object.entries(input)
  else throw failure('tieba_transport_invalid_input')
  const headers=new Map();let bytes=0
  for(const row of entries){
    if(!Array.isArray(row)||row.length!==2||typeof row[0]!=='string'||typeof row[1]!=='string')throw failure('tieba_transport_invalid_input')
    const name=row[0].toLowerCase(),value=row[1]
    if(!HEADERS.has(name)||headers.has(name)||/[^\x20-\x7e]/.test(value)||value.length>262144||name==='cookie'&&url.hostname!=='tieba.baidu.com')throw failure('tieba_transport_invalid_input')
    if(name==='referer')officialUrl(value)
    if(name==='origin'){const origin=officialUrl(value);if(origin.origin!==value||origin.pathname!=='/'||origin.search)throw failure('tieba_transport_invalid_input')}
    bytes+=Buffer.byteLength(name+value);if(bytes>512*1024)throw failure('tieba_transport_size_limit')
    headers.set(name,value)
  }
  return headers
}
async function bodyBytes(body,headers,method,url){
  if(body===undefined||body===null)return method==='POST'?Buffer.alloc(0):null
  if(method==='GET')throw failure('tieba_transport_invalid_input')
  let bytes
  if(body instanceof FormData){
    if(headers.has('content-type')&&!/^multipart\/form-data(?:\s*;|$)/i.test(headers.get('content-type')))throw failure('tieba_transport_invalid_input')
    const request=new Request(url,{method:'POST',body});headers.set('content-type',request.headers.get('content-type'));bytes=Buffer.from(await request.arrayBuffer())
  }else if(body instanceof URLSearchParams){bytes=Buffer.from(body.toString());if(!headers.has('content-type'))headers.set('content-type','application/x-www-form-urlencoded;charset=UTF-8')}
  else if(typeof body==='string')bytes=Buffer.from(body)
  else if(body instanceof Uint8Array)bytes=Buffer.from(body)
  else if(body instanceof ArrayBuffer)bytes=Buffer.from(new Uint8Array(body))
  else if(body instanceof Blob){bytes=Buffer.from(await body.arrayBuffer());if(body.type&&!headers.has('content-type'))headers.set('content-type',body.type)}
  else throw failure('tieba_transport_invalid_input')
  if(bytes.length>BODY_LIMIT)throw failure('tieba_transport_size_limit')
  return bytes
}
function responseOf(rawHeaders,bytes){
  const blocks=rawHeaders.toString('latin1').split(/\r?\n\r?\n/).filter(part=>/^HTTP\//.test(part)),last=blocks.at(-1)
  if(!last)throw failure('tieba_transport_response_invalid')
  const lines=last.split(/\r?\n/),status=/^HTTP\/(?:1\.[01]|2|3)\s+([1-5]\d{2})(?:\s.*)?$/.exec(lines.shift()),headers=new Headers()
  if(!status||Number(status[1])<200)throw failure('tieba_transport_response_invalid')
  try{for(const line of lines){const at=line.indexOf(':');if(at<1||/^[ \t]/.test(line)||! /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(line.slice(0,at)))throw failure('tieba_transport_response_invalid');headers.append(line.slice(0,at),line.slice(at+1).trim())}}
  catch{throw failure('tieba_transport_response_invalid')}
  const code=Number(status[1]);if([204,205,304].includes(code)&&bytes.length)throw failure('tieba_transport_response_invalid')
  return new Response([204,205,304].includes(code)?null:bytes,{status:code,headers})
}

/** fetch-compatible transport. The caller still owns policy/quota/leases and
 * supplies mark_network_started only for an actual publication, not every POST.
 * stdin config is withheld until spawn succeeds and that callback completes.
 */
export function createTiebaCurlFetcher({binary='/usr/bin/curl',spawn_impl=spawn,max_bytes=8*1024*1024}={}){
  if(typeof binary!=='string'||!binary.startsWith('/')||/[\0\r\n]/.test(binary)||typeof spawn_impl!=='function'||!Number.isSafeInteger(max_bytes)||max_bytes<1||max_bytes>64*1024*1024)throw failure('tieba_transport_invalid_input')
  const fetcher=async(input,options={})=>{
    if(!options||typeof options!=='object'||Array.isArray(options)||Object.keys(options).some(key=>!['method','headers','body','signal','redirect','mark_network_started'].includes(key)))throw failure('tieba_transport_invalid_input')
    const url=officialUrl(input),method=options.method??'GET',signal=options.signal,mark=options.mark_network_started
    if(!['GET','POST'].includes(method)||options.redirect!==undefined&&options.redirect!=='error'||mark!==undefined&&typeof mark!=='function'||signal!==undefined&&!(signal instanceof AbortSignal))throw failure('tieba_transport_invalid_input')
    if(signal?.aborted)throw failure('tieba_transport_aborted')
    let headers,body;try{headers=requestHeaders(options.headers,url);body=await bodyBytes(options.body,headers,method,url.href)}catch(error){throw failure(['tieba_transport_invalid_input','tieba_transport_size_limit'].includes(error?.code)?error.code:'tieba_transport_invalid_input')}
    if(signal?.aborted)throw failure('tieba_transport_aborted')
    const lines=['silent','show-error','globoff','compressed','no-location','proto = "=https"','proto-redir = "=https"','max-redirs = "0"','connect-timeout = "10"','max-time = "30"','dump-header = "/dev/fd/4"','output = "-"','request = '+quote(method),'url = '+quote(url.href)]
    for(const[name,value]of headers)lines.push('header = '+quote(name+': '+value))
    if(body!==null)lines.push('data-binary = "@/dev/fd/3"')
    const config=lines.join('\n')+'\n'
    return new Promise((resolve,reject)=>{
      let child,settled=false,started=false,timer,killTimer,total=0,headerSize=0;const chunks=[],headerChunks=[]
      const cleanup=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort)}
      const finish=(error,value)=>{if(settled)return;settled=true;cleanup();error?reject(error):resolve(value)}
      const stop=error=>{if(settled)return;try{child?.stdin?.destroy();child?.stdio?.[3]?.destroy();child?.kill('SIGTERM')}catch{}killTimer=setTimeout(()=>{try{child?.kill('SIGKILL')}catch{}},1000);killTimer.unref?.();finish(error)}
      const abort=()=>stop(failure('tieba_transport_aborted'))
      try{
        const env={...process.env};delete env.SSLKEYLOGFILE
        child=spawn_impl(binary,['--disable','--config','-'],{stdio:['pipe','pipe','pipe','pipe','pipe'],shell:false,env,windowsHide:true})
      }catch{finish(failure('tieba_transport_spawn_failed'));return}
      if(!child?.stdin||!child.stdout||!child.stderr||!child.stdio?.[3]||!child.stdio?.[4]||typeof child.once!=='function'){stop(failure('tieba_transport_spawn_failed'));return}
      child.once('error',()=>stop(failure(started?'tieba_transport_failed':'tieba_transport_spawn_failed')))
      for(const stream of [child.stdin,child.stdout,child.stderr,child.stdio[3],child.stdio[4]])stream.on('error',()=>stop(failure('tieba_transport_failed')))
      child.stdout.on('data',chunk=>{if(settled)return;total+=chunk.length;if(total>max_bytes){stop(failure('tieba_transport_size_limit'));return}chunks.push(Buffer.from(chunk))})
      child.stdio[4].on('data',chunk=>{if(settled)return;headerSize+=chunk.length;if(headerSize>HEADER_LIMIT){stop(failure('tieba_transport_size_limit'));return}headerChunks.push(Buffer.from(chunk))})
      child.stderr.on('data',()=>{}) // Drain diagnostics, never expose them or credential-bearing stdout on failure.
      child.once('close',code=>{clearTimeout(killTimer);if(settled)return;if(code!==0){finish(failure('tieba_transport_failed'));return}try{finish(null,responseOf(Buffer.concat(headerChunks),Buffer.concat(chunks)))}catch{finish(failure('tieba_transport_response_invalid'))}})
      child.once('spawn',()=>{started=true;void(async()=>{try{if(settled||signal?.aborted){if(!settled)abort();return}if(mark)await mark();if(settled||signal?.aborted){if(!settled)abort();return}child.stdin.end(config);child.stdio[3].end(body??Buffer.alloc(0))}catch{stop(failure('tieba_transport_not_started'))}})()})
      signal?.addEventListener('abort',abort,{once:true});timer=setTimeout(()=>stop(failure('tieba_transport_aborted')),32000);timer.unref?.();if(signal?.aborted)abort()
    })
  }
  Object.defineProperty(fetcher,'controlled_network_start',{value:true,enumerable:true})
  return fetcher
}
