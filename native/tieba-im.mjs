/** Tieba official IM wire protocol. Independently encoded from the public
 * aiotieba protocol descriptions (lumina37/aiotieba, Unlicense).
 * The fixed legacy endpoint has no TLS. No account authentication is allowed
 * until the local owner has explicitly enabled allow_legacy_auth.
 * Keys and credentials stay in memory; no retries of message submissions.
 */
import net from 'node:net'
import {createHash,randomBytes,pbkdf2Sync,createCipheriv,createDecipheriv,publicEncrypt,createPublicKey,constants} from 'node:crypto'
import {gunzipSync} from 'node:zlib'
import {TiebaError,tiebaId,pbBytes,pbString,pbInt,pbFields} from './tieba-http.mjs'

const HOST='im.tieba.baidu.com',PORT=8000,MAX=2*1024*1024
const PUBLIC_KEY='MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAwQpwBZxXJV/JVRF/uNfyMSdu7YWwRNLM8+2xbniGp2iIQHOikPpTYQjlQgMi1uvq1kZpJ32rHo3hkwjy2l0lFwr3u4Hk2Wk7vnsqYQjAlYlK0TCzjpmiI+OiPOUNVtbWHQiLiVqFtzvpvi4AU7C1iKGvc/4IS45WjHxeScHhnZZ7njS4S1UgNP/GflRIbzgbBhyZ9kEW5/OO5YfG1fy6r4KSlDJw4o/mw5XhftyIpL+5ZBVBC6E1EIiP/dd9AbK62VV1PByfPMHMixpxI3GM2qwcmFsXcCcgvUXJBa9k6zP8dDQ3csCM2QNT+CQAOxthjtp/TFWaD7MzOdsIYb3THwIDAQAB'
const field=(bytes,n)=>pbFields(bytes).find(x=>x.field===n),str=(bytes,n)=>{const x=field(bytes,n);return x?.bytes?new TextDecoder('utf-8',{fatal:true}).decode(x.bytes):''},id=(bytes,n)=>{const x=field(bytes,n);if(x?.value!==undefined)return x.value.toString();if(x?.bytes){const text=x.bytes.toString('utf8');if(/^[0-9]{1,100}$/.test(text))return text}return '0'}
export function imError(bytes){const error=field(bytes,1)?.bytes;if(!error)return;const code=id(error,1);if(code!=='0')throw new TiebaError('贴吧私信接口拒绝请求（code='+code+'）','im_rejected',{server_code:Number(code)})}
export function imKey(secret){return pbkdf2Sync(secret,Buffer.from('a40bc834d695f313','hex'),5,32,'sha1')}
export function encodeImPacket(data,cmd,request_id,secret,{encrypt=true}={}){
  let payload=Buffer.from(data);if(payload.length>MAX)throw new TiebaError('私信包过大','invalid_input')
  if(encrypt){const cipher=createCipheriv('aes-256-ecb',imKey(secret),null);payload=Buffer.concat([cipher.update(payload),cipher.final()])}
  const header=Buffer.alloc(9);header[0]=encrypt?0x88:0x08;header.writeUInt32BE(cmd,1);header.writeUInt32BE(request_id,5);return Buffer.concat([header,payload])
}
export function decodeImPacket(input,secret){
  const bytes=Buffer.from(input);if(bytes.length<9||bytes.length>MAX)throw new TiebaError('私信包边界无效','invalid_response')
  const flag=bytes[0];if(![0,8].includes(flag&0x3f))throw new TiebaError('未知私信协议版本','invalid_response')
  let body=bytes.subarray(9)
  if(flag&0x80){const cipher=createDecipheriv('aes-256-ecb',imKey(secret),null);body=Buffer.concat([cipher.update(body),cipher.final()])}
  if(flag&0x40)body=gunzipSync(body,{maxOutputLength:MAX})
  return {cmd:bytes.readUInt32BE(1),request_id:bytes.readUInt32BE(5),body}
}
export function encodeImLogin(bduss,secret){const key=createPublicKey({key:Buffer.from(PUBLIC_KEY,'base64'),type:'spki',format:'der'}),encrypted=publicEncrypt({key,padding:constants.RSA_PKCS1_PADDING},secret);return Buffer.concat([pbString(1,'-|com.baidu.tieba22.12.1.0'),pbBytes(2,Buffer.concat([pbString(1,bduss),pbString(2,JSON.stringify({_client_type:'2',_client_version:'22.12.1.0'})),pbBytes(3,encrypted)]))])}
export function decodeImLogin(bytes,expected_uid){imError(bytes);const data=field(bytes,2)?.bytes,user=data&&field(data,2)?.bytes,uid=user?id(user,1):'0';if(!data||!user||uid==='0'||uid!==tiebaId(expected_uid)||id(data,6)!==uid)throw new TiebaError('私信登录身份与已绑定账号不一致','account_mismatch');return {uid,name:str(user,2),groups:pbFields(data).filter(x=>x.field===1&&x.bytes).map(x=>({group_id:id(x.bytes,1),type:Number(id(x.bytes,20)),last_message_id:id(x.bytes,21)}))}}
export function encodeImHistory(group_id){return Buffer.concat([pbString(1,'-|com.baidu.tieba_mini12.35.1.0'),pbBytes(2,Buffer.concat([pbBytes(6,Buffer.concat([pbInt(1,tiebaId(group_id)),pbInt(2,0)])),pbString(7,'1')]))])}
export function decodeImHistory(bytes,self_uid){
  imError(bytes);const data=field(bytes,2)?.bytes;if(!data)throw new TiebaError('私信响应缺少消息组','invalid_response')
  const rows=[];for(const group of pbFields(data).filter(x=>x.field===1&&x.bytes)){const info=field(group.bytes,1)?.bytes;if(!info||id(info,1)==='0')throw new TiebaError('官方未返回可核验的私信历史，未视为空收件箱','im_history_unavailable');if(id(info,20)!=='6')continue
    for(const row of pbFields(group.bytes).filter(x=>x.field===2&&x.bytes)){const user=field(row.bytes,10)?.bytes;if(!user)continue;const message_id=id(row.bytes,1),from_uid=id(user,1);if(message_id==='0'||from_uid==='0')continue
      rows.push({message_id,from_uid,to_uid:self_uid,type:Number(id(row.bytes,3)),text:str(row.bytes,5),source_at:Number(id(row.bytes,8))*1000})
    }
  }
  return rows
}
export function encodeImMessage({recipient_uid,body,record_id}){return pbBytes(1,Buffer.concat([pbInt(2,tiebaId(recipient_uid)),pbInt(3,1),pbString(4,body),pbInt(6,tiebaId(record_id))]))}
export function decodeImReceipt(bytes,{recipient_uid,record_id}){
  imError(bytes);const data=field(bytes,2)?.bytes;if(!data)throw new TiebaError('私信缺少发表回执','unknown_receipt')
  const block=field(data,6)?.bytes;if(block&&id(block,1)!=='0')throw new TiebaError('私信被平台拒绝（code='+id(block,1)+'）','im_rejected',{server_code:Number(id(block,1))})
  const server_id=id(data,1),echoed_recipient=id(data,4),echoed_record=id(data,3),observed={server_id,echoed_recipient,echoed_record,response_sha256:createHash('sha256').update(bytes).digest('hex'),field_layout:pbFields(data).map(x=>({field:x.field,wire:x.wire,size:x.bytes?.length??0}))}
  // Optional protobuf echoes may be omitted. The encrypted RPC response already
  // matches this request's command and request_id. Reject conflicting echoes,
  // but do not invent a requirement that the server always populates them.
  if(server_id==='0'||echoed_recipient!=='0'&&echoed_recipient!==tiebaId(recipient_uid)||echoed_record!=='0'&&echoed_record!==tiebaId(record_id))throw new TiebaError('私信回执坐标未核验，不重发','unknown_receipt',{observed})
  return {server_id,recipient_uid,record_id,echoed_recipient,echoed_record,accepted:true,code:0,source:'server_receipt',response_sha256:observed.response_sha256}
}
export function websocketFrame(payload,opcode=2){
  payload=Buffer.from(payload);if(payload.length>MAX)throw new TiebaError('私信帧过大','invalid_input')
  const mask=randomBytes(4),head=Buffer.alloc(payload.length<126?2:payload.length<65536?4:10);head[0]=0x80|opcode;head[1]=0x80|(payload.length<126?payload.length:payload.length<65536?126:127)
  if(payload.length>=65536)head.writeBigUInt64BE(BigInt(payload.length),2);else if(payload.length>=126)head.writeUInt16BE(payload.length,2)
  const out=Buffer.from(payload);for(let i=0;i<out.length;i++)out[i]^=mask[i%4];return Buffer.concat([head,mask,out])
}
export class TiebaImConnection{
  constructor({allow_legacy_auth=false,socket_factory=()=>net.connect({host:HOST,port:PORT}),timeout_ms=15000}={}){this.allowed=allow_legacy_auth===true;this.socketFactory=socket_factory;this.timeout=timeout_ms;this.waiters=new Map();this.requestId=Math.floor(Date.now()/1000);this.buffer=Buffer.alloc(0);this.closed=false;this.ready=false;this.secret=randomBytes(31)}
  connect(input){if(this.uid&&this.uid!==tiebaId(input.uid))return Promise.reject(new TiebaError('同一私信连接不能切换账号','account_mismatch'));if(this.ready)return Promise.resolve(this.account);if(this.connecting)return this.connecting;const work=this._open(input);this.connecting=work;return work.finally(()=>{if(this.connecting===work)this.connecting=null})}
  async _open({bduss,uid,before_auth}){
    if(!this.allowed)throw new TiebaError('贴吧官方旧版IM首次认证不使用TLS，需要主人明确允许后才会发送登录态','legacy_im_auth_required')
    if(this.ready&&this.uid===uid)return
    if(this.closed)throw new TiebaError('私信连接已关闭','closed')
    if(typeof bduss!=='string'||!bduss||bduss.length>65536||/[\r\n\0]/.test(bduss))throw new TiebaError('私信凭据无效','authentication_required')
    this.uid=tiebaId(uid);this.socket=this.socketFactory();const key=randomBytes(16).toString('base64'),expected=createHash('sha1').update(key+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
    await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{reject(new TiebaError('私信握手超时','im_unavailable'));this.close()},this.timeout)
      const fail=()=>{clearTimeout(timer);reject(new TiebaError('私信连接未建立','im_unavailable'));this.close()}
      this.socket.once('error',fail);this.socket.once('end',fail)
      this.socket.on('data',chunk=>{try{this.buffer=Buffer.concat([this.buffer,chunk]);if(this.buffer.length>MAX)throw Error();if(!this.handshake){const at=this.buffer.indexOf('\r\n\r\n');if(at<0){if(this.buffer.length>32768)throw Error();return}const header=this.buffer.subarray(0,at).toString(),accept=/^sec-websocket-accept:\s*(.+)$/im.exec(header)?.[1]?.trim();if(!/^HTTP\/1\.1 101\b/.test(header)||accept!==expected)throw Error();this.handshake=true;this.buffer=this.buffer.subarray(at+4);clearTimeout(timer);resolve()}this._frames()}catch(error){this.failure_code=error?.code??error?.name??'invalid_frame';fail()}})
      this.socket.once('connect',()=>this.socket.write('GET / HTTP/1.1\r\nHost: '+HOST+':'+PORT+'\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: '+key+'\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Extensions: im_version=2.3\r\nUser-Agent: dsh-companion-unified\r\n\r\n'))
    })
    const login=await this.request(1001,encodeImLogin(bduss,this.secret),{encrypt:false,before_send:before_auth});const account=decodeImLogin(login,this.uid);this.account=account;this.ready=true;return account
  }
  _frames(){
    while(this.buffer.length>=2){const first=this.buffer[0],second=this.buffer[1];if(!(first&0x80)||second&0x80)throw Error();let length=second&127,head=2
      if(length===126){if(this.buffer.length<4)return;length=this.buffer.readUInt16BE(2);head=4}else if(length===127){if(this.buffer.length<10)return;const big=this.buffer.readBigUInt64BE(2);if(big>BigInt(MAX))throw Error();length=Number(big);head=10}
      if(length>MAX)throw Error();if(this.buffer.length<head+length)return;const payload=this.buffer.subarray(head,head+length);this.buffer=this.buffer.subarray(head+length);const opcode=first&15
      if(opcode===8){this.close();return}if(opcode===9){this.socket.write(websocketFrame(payload,10));continue}if(opcode!==2)continue
      this.last_packet_header=payload.length>=9?{flag:payload[0],cmd:payload.readUInt32BE(1),request_id:payload.readUInt32BE(5),bytes:payload.length}:{bytes:payload.length}
      const packet=decodeImPacket(payload,this.secret),waiting=this.waiters.get(packet.request_id);if(waiting&&packet.cmd===waiting.cmd){this.waiters.delete(packet.request_id);clearTimeout(waiting.timer);waiting.resolve(packet.body)}
    }
  }
  async request(cmd,data,{encrypt=true,before_send}={}){
    if(this.closed||!this.handshake)throw new TiebaError('私信连接未就绪','im_unavailable')
    const request_id=++this.requestId,packet=encodeImPacket(data,cmd,request_id,this.secret,{encrypt})
    return await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.waiters.delete(request_id);reject(new TiebaError('私信响应超时，写入结果不明，不重发','unknown_receipt'));this.close()},this.timeout);this.waiters.set(request_id,{cmd,timer,resolve,reject});Promise.resolve().then(()=>before_send?.()).then(()=>{if(this.closed)throw Error();this.socket.write(websocketFrame(packet))}).catch(()=>{clearTimeout(timer);this.waiters.delete(request_id);reject(new TiebaError('私信发送前校验失败，未继续','invalid_action_lease'))})})
  }
  close(){if(this.closed)return;this.closed=true;this.ready=false;this.socket?.destroy();for(const waiting of this.waiters.values()){clearTimeout(waiting.timer);waiting.reject(new TiebaError('私信连接关闭，未确认的消息不重发','unknown_receipt'))}this.waiters.clear();this.secret.fill(0)}
}
