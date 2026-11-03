import { randomUUID } from 'node:crypto'
import { OneBotConnection,OneBotActionError,OneBotNotConnectedError } from './protocol/connection.js'

// connection.js and errors.js have no filesystem/configuration persistence.
// Keep their forward/reverse authentication, heartbeat and reconnect algorithms;
// replace only JSON/receipt handling so no ID or delivery evidence is lost.
export function parseOneBotFrame(text){
  return JSON.parse(String(text),(key,value,context)=>{
    if(typeof value==='number'&&Number.isInteger(value)&&context?.source&&/^-?\d+$/.test(context.source)
      &&(/(?:^|_)(?:id|uid|mid|pid)$/.test(key)||!Number.isSafeInteger(value)))return context.source
    return value
  })
}
export function encodeOneBotFrame(value){
  return JSON.stringify(value,(key,item)=>typeof item==='string'&&/^(?:user_id|group_id|message_id|self_id|target_id|operator_id)$/.test(key)&&/^-?\d+$/.test(item)?JSON.rawJSON(item):item)
}
export class NativeQQTransport extends OneBotConnection {
  call(action,params,{mark_started=()=>{}}={}){
    const socket=this.socket
    if(!socket||socket.readyState!==1||this.stopping)return Promise.reject(new OneBotNotConnectedError())
    const echo=randomUUID()
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(echo);reject(new OneBotActionError('OneBot回执超时，结果未知'))},this.config.callTimeoutMs??30000)
      this.pending.set(echo,{resolve,reject,timer})
      const assert_send_ready=()=>{if(!this.pending.has(echo)||this.socket!==socket||socket.readyState!==1||this.stopping)throw new OneBotNotConnectedError()}
      const fail=error=>{if(!this.pending.has(echo))return;this.pending.delete(echo);clearTimeout(timer);reject(error)}
      const send=finalize=>{try{assert_send_ready();if(typeof finalize==='function')finalize({assert_send_ready});assert_send_ready();socket.send(encodeOneBotFrame({action,params,echo}))}catch(error){fail(error)}}
      try{assert_send_ready();const gate=mark_started({assert_send_ready});if(gate&&typeof gate.then==='function')Promise.resolve(gate).then(send,fail);else send(gate)}catch(error){fail(error)}
    })
  }
  onFrame(bytes){
    let frame
    try{frame=parseOneBotFrame(bytes.toString())}catch{return}
    if(!frame||typeof frame!=='object'||Array.isArray(frame))return
    if(typeof frame.echo==='string'&&this.pending.has(frame.echo)){
      const pending=this.pending.get(frame.echo);this.pending.delete(frame.echo);clearTimeout(pending.timer)
      // Preserve the complete, correlated server envelope. The caller decides
      // whether status/code/data prove completion, rejection or uncertainty.
      pending.resolve(frame);return
    }
    if(typeof frame.self_id==='string'&&/^[1-9]\d*$/.test(frame.self_id))this.selfId=frame.self_id
    if(frame.post_type==='message')Promise.resolve(this.onMessage(frame)).catch(()=>this.log('warn','QQ入站处理失败，未重放来源'))
    else if(frame.post_type==='meta_event')Promise.resolve(this.onMeta(frame)).catch(()=>this.log('warn','QQ连接身份暂未确认'))
  }
}
