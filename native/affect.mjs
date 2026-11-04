import {createHash,randomUUID} from 'node:crypto'
import {NativeStore} from './store.mjs'
import {detectUserTone} from './hormone.mjs'
import {admittedHumanSources} from './input-sources.mjs'

const hash=value=>createHash('sha256').update(value).digest('hex')
const sidOf=value=>value?.session?.id??value?.session?.header?.id??value?.id??value?.header?.id??''
const textOf=value=>typeof value==='string'?value:Array.isArray(value)?value.filter(x=>x?.type==='text').map(x=>x.text??'').join('\n'):''
const platformOf=value=>['qq','bilibili','tieba'].includes(value)?value:'harness'
const integer=value=>Number.isSafeInteger(value)&&value>=0
function usageTotal(value){
  if(!value||!integer(value.inputTokens)||!integer(value.outputTokens))return null
  const fields=[value.inputTokens,value.outputTokens,value.cacheReadTokens??0,value.cacheWriteTokens??0]
  if(fields.some(x=>!integer(x)))return null
  const total=fields.reduce((a,b)=>a+b,0)
  return integer(total)&&(value.totalTokens===undefined||value.totalTokens===total)?total:null
}

/** One background instruction. Mood owns emotional tone; physiological state
 * only adjusts expression. It never schedules, publishes or refuses a task. */
export function composeAffectContext(moodText,preview){
  const mood=typeof moodText==='string'?moodText.replace(/^【心情】/,'').replace(/。只是背景，按当前话题接。$/,''):''
  const keys=preview?.enabled&&preview.mode==='active'?preview.keys??[]:[]
  if(!keys.length)return moodText??''
  const v=preview.values,states=[],hints=[]
  if(keys.includes('stress'))states.push('压力'+Math.round(v.stress))
  if(keys.includes('energy'))states.push('精力'+Math.round(v.energy))
  if(keys.includes('reward'))states.push('兴致'+Math.round(v.reward))
  if(keys.includes('boredom'))states.push('无聊'+Math.round(v.boredom))
  if(preview.active?.includes('energy')||preview.active?.includes('stress'))hints.push('表达简洁，保留必要信息')
  else if(keys.includes('reward'))hints.push('按当前话题需要自然展开')
  if(keys.includes('boredom'))hints.push('合适时在当前对话接一个新鲜话题')
  const line='【状态】'+[mood,...states].filter(Boolean).join('；')+'。语气沿用当前人设和心情；'+hints.join('；')+'。不改变已授权任务与权限。'
  return line.length<=240?line:''
}

/** SDK adapter: only admitted human sources and actual own session events can
 * influence state. Tool contents, quotes, memory and autonomous wake prompts
 * are never treated as a human praising or criticizing the companion. */
export class NativeAffectRuntime{
  constructor({store,hormone,mood,now=Date.now,enabled=()=>true}={}){
    if(!(store instanceof NativeStore)||!hormone||typeof now!=='function'||typeof enabled!=='function')throw new Error('统一状态需要原生存储与可信运行服务')
    this.store=store;this.hormone=hormone;this.mood=mood;this.now=now;this.enabled=enabled
    this.positions=new Map();this.calls=new Map();this.previews=new Map();this.requests=new Map();this.closed=false
  }
  _enabled(){return !this.closed&&!this.store.readOnly&&this.enabled()&&this.store.getDocument('settings')?.value.enabled!==false}
  _record(input){if(this._enabled())return this.hormone.record(input)}
  _trim(map,max=256){while(map.size>max)map.delete(map.keys().next().value)}
  request(agent,{turn,step}={}){
    const sid=sidOf(agent);if(!sid||!integer(turn)||!integer(step))return
    const prior=this.positions.get(sid)??{};this.positions.set(sid,{...prior,turn,step});this._trim(this.positions)
  }
  admit(agent,messages,{context={},task,memory,qq,turn}={}){
    if(!this._enabled())return
    const sid=sidOf(agent);if(!sid||!integer(turn)||context.memory_only)return
    this.request(agent,{turn,step:this.positions.get(sid)?.step??1})
    for(const source of admittedHumanSources({store:this.store,agent,messages,context,task,memory,qq}))this._record({kind:'human',key:source.key,session_id:sid,turn,platform:platformOf(source.platform),tone:detectUserTone(source.text)??'neutral',at:this.now()})
  }
  context(input={}){
    if(this.closed||input.context?.memory_only)return ''
    const mood=this.mood?.context(input)??'',preview=this.hormone.preview(),line=composeAffectContext(mood,preview),sid=sidOf(input.agent)
    if(sid){this.previews.set(sid,{text:line,preview});this._trim(this.previews)}
    return line
  }
  stream(request,next,{context={},is_loop_request=false}={}){
    const self=this,sid=request?.sessionId
    return (async function*(){
      if(!is_loop_request||!self._enabled()||!sid){yield* next();return}
      const position=self.positions.get(sid),key='request:'+randomUUID()
      if(position){self.requests.set(sid,{key,turn:position.turn,step:position.step});self._trim(self.requests)}
      const prepared=self.previews.get(sid),outbound=[textOf(request.system),...(request.messages??[]).map(m=>textOf(m.content))].join('\n')
      // Assembly and settings previews do not consume a reminder. A cancelled
      // request or unrelated text cannot acknowledge the prepared background.
      let first=true
      for await(const chunk of next()){
        // Budget/admission failures can occur inside the downstream iterator.
        // A real first chunk proves it passed those gates. Affect bookkeeping
        // must never prevent the provider's actual answer from reaching SDK.
        if(first){first=false;if(!request.signal?.aborted&&!context.memory_only&&prepared?.text&&prepared.preview.keys.length&&outbound.includes(prepared.text))try{self.hormone.acknowledge({keys:prepared.preview.keys,token:prepared.preview.token})}catch{}}
        yield chunk
      }
    })()
  }
  onEvent(session,event,{context={},task}={}){
    if(!this._enabled()||!event||session?.header?.origin==='subagent')return
    const sid=sidOf(session),data=event.data??{}
    if(!sid||integer(event.seq)&&event.seq<(session.inheritedEventCount??0))return
    const platform=platformOf(context.platform),eventKey='sdk:'+sid+':'+(integer(event.seq)?event.seq:hash(JSON.stringify([event.type,data.turn,data.step,data.callId,data.message?.toolCallId,data.message?.id,event.time])))
    if(event.type==='turn/start'){
      if(integer(data.turn)){this.positions.set(sid,{turn:data.turn,step:0});this._trim(this.positions)}
      this.requests.delete(sid);this.previews.delete(sid);return
    }
    const position=this.positions.get(sid),turn=data.turn??position?.turn
    if(!integer(turn))return
    if(event.type==='tool/call'&&typeof data.callId==='string'&&integer(data.turn)){
      this.calls.set(sid+'\0'+data.callId,{turn:data.turn,seq:event.seq});this._trim(this.calls,1024);return
    }
    if(event.type==='tool/result'){
      const callId=data.message?.toolCallId,call=this.calls.get(sid+'\0'+callId)
      if(!call||call.turn!==turn||integer(call.seq)&&!event.sourceEventSeqs?.includes(call.seq))return
      this.calls.delete(sid+'\0'+callId)
      this._record({kind:'tool',key:eventKey,session_id:sid,turn,platform,failed:data.message?.isError===true,at:this.now()});return
    }
    if(['assistant/message','assistant/attempt'].includes(event.type)){
      const request=this.requests.get(sid)
      if(!request||request.turn!==turn||request.step!==data.step)return
      const candidates=[...(data.stream??[]).filter(x=>x.chunk?.type==='usage').map(x=>x.chunk.usage),...(data.usage?[data.usage]:[])]
      const values=candidates.map(usageTotal).filter(x=>x!==null)
      if(values.length)this._record({kind:'usage',key:eventKey,session_id:sid,turn,platform,request_key:request.key,cumulative_tokens:Math.max(...values),at:this.now()})
      return
    }
    if(event.type==='turn/end'){
      const success=data.reason?.kind==='completed'&&!task?.blocked&&!task?.unknown
      this._record({kind:'turn_end',key:eventKey,session_id:sid,turn,platform,success,reward_eligible:!task?.maintenance_kind&&!context.memory_only,at:this.now()})
      this.positions.delete(sid);this.requests.delete(sid);this.previews.delete(sid)
      for(const key of this.calls.keys())if(key.startsWith(sid+'\0'))this.calls.delete(key)
    }
  }
  dispose(){
    if(this.closed)return
    const sessions=[...this.positions.keys()];this.closed=true
    if(!this.store.readOnly&&sessions.length)this.hormone.settlePending({key:'runtime-close:'+randomUUID(),session_ids:sessions})
    for(const map of [this.positions,this.calls,this.previews,this.requests])map.clear()
  }
}
