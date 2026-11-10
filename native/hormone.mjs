/** Shared event-driven state, adapted from y258dd/dsh-hormone 0.4.0 (MIT).
 * Copyright (c) 2026 y258dd. The upstream notice is retained in legal/.
 * The model cannot write this state. Reads are pure; accepted host events and
 * actual-request acknowledgements use the same native SQLite transaction.
 */
import {createHash} from 'node:crypto'
import {NativeStore} from './store.mjs'
import {isPlainObject,validateDocument} from './contracts.mjs'

const freeze=value=>{for(const child of Object.values(value))if(child&&typeof child==='object')freeze(child);return Object.freeze(value)}
export const HORMONE_DEFAULTS=freeze({enabled:true,mode:'active',policy:{daily_token_budget:13000000,rest_after_minutes:30,recovery_half_hours:4,day_energy_baseline:90,night_energy_baseline:45,night_start_hour:0,night_end_hour:7,daily_recovery:80,stress_half_hours:3,reward_half_minutes:40,boredom_after_minutes:25,boredom_half_hours:5,debt_ratio:1.3,debt_max:40,debt_decay_hours:24,stress_cost:0.4,reward_cost:0.5,reward_stress_decay:0.35,stress_recovery:1.5,stress_high:75,energy_low:20,reward_high:60,boredom_high:55,reminder_minutes:40}})
const KEYS=['stress','energy','reward','boredom'],PLATFORMS=['qq','tieba','bilibili','harness','system','web'],HOUR=3600000,MINUTE=60000,DAY=86400000,OFFSET=8*HOUR,MAX_HISTORY=400,MAX_ROUNDS=128,MAX_REQUESTS=256,MAX_TOTAL_REQUESTS=4096
const hash=value=>createHash('sha256').update(value).digest('hex')
const clamp=(n,min=0,max=100)=>Math.min(max,Math.max(min,n))
const integer=(n,label,min=0,max=Number.MAX_SAFE_INTEGER)=>{if(!Number.isSafeInteger(n)||n<min||n>max)throw new Error(label+'必须为范围内安全整数');return n}
const fields=(v,allowed)=>{if(!isPlainObject(v)||Object.keys(v).some(k=>!allowed.includes(k)))throw new Error('激素参数含未知字段或类型错误')}
const keyText=(v,label,max=512)=>{if(typeof v!=='string'||!v||v.length>max||/[\0\r\n]/.test(v))throw new Error(label+'无效');return v}
const round=n=>Math.round(n*1000000)/1000000
const dayOf=at=>new Date(at+OFFSET).toISOString().slice(0,10)
const hourOf=at=>new Date(at+OFFSET).getUTCHours()
const midnight=at=>Math.floor((at+OFFSET)/DAY)*DAY-OFFSET
const night=(at,p)=>{const hour=hourOf(at),a=p.night_start_hour,b=p.night_end_hour;return a===b?false:a<b?hour>=a&&hour<b:hour>=a||hour<b}
const baseline=(at,p)=>night(at,p)?p.night_energy_baseline:p.day_energy_baseline
const blankValues=p=>({stress:20,energy:p.day_energy_baseline,reward:10,boredom:5})
export const freshHormoneState=(at,policy=HORMONE_DEFAULTS.policy)=>({version:1,updated_at:at,day:dayOf(at),last_work_at:at,last_user_at:at,values:blankValues(policy),debts:[],emit:{active:[],at:0},rounds:[],history:[]})
const debtAt=(state,p,at)=>clamp(state.debts.reduce((n,d)=>n+d.amount*Math.max(0,1-Math.max(0,at-d.at)/(p.debt_decay_hours*HOUR)),0),0,p.debt_max)

/** Conservative cue recognition only. Quoted/source text is not an appraisal
 * of this assistant; neither negated praise nor instructions to repeat praise
 * are counted. The adapter must still prove this is a consumed human message. */
export function detectUserTone(text){
  if(typeof text!=='string'||!text.trim())return null
  const clean=text.slice(0,16000).replace(/```[\s\S]*?(?:```|$)/g,'').replace(/^\s*>.*$/gm,'').replace(/“[^”]*”|「[^」]*」|『[^』]*』|"[^"\n]*"|'[^'\n]*'/g,'').replace(/\bhttps?:\/\/\S+/g,'')
  if(/(?:别人|有人|他说|她说|它说|原文|引用|翻译|复述|转述|举例|例如|假设|假如|提示词|系统提示|代码|正则|关键词|这句|这句话)/.test(clean))return null
  if(!/(?:不是|并非|没有说|没说).{0,4}(?:你|你们).{0,8}(?:错了|不对|搞错|弄错|理解错|搞砸|没用|不行|不靠谱)/.test(clean)&&/(?:你|你们).{0,16}(?:又错|错了|不对|搞错|弄错|理解错|搞砸|没用|不行|不靠谱)|^(?:又错了|不对|错了|不是这个|怎么又|说了多少遍|别瞎猜)|你能不能认真/.test(clean))return 'blame'
  if(/(?:并不|不是|不算|哪里|哪有|一点也不|根本不|谈不上|别说|不要说|不能说|不够).{0,8}(?:好棒|太棒|厉害|不错|牛逼|牛啊|超赞|靠谱|漂亮|乖|喜欢你|爱你)|(?:不|没)(?:感谢|谢谢|喜欢|爱你)|(?:请|让|叫|说一遍|输出|回答).{0,8}(?:谢谢|感谢|辛苦了|喜欢你|爱你|好棒|太棒|厉害|牛逼|超赞)/.test(clean))return null
  return /(?:你|你们).{0,16}(?:好棒|太棒|好厉害|厉害了|不错|牛逼|牛啊|超赞|靠谱|辛苦了|真漂亮|真乖)|(?:谢谢你|感谢你|喜欢你|爱你)|^(?:好棒|太棒了?|好厉害|厉害了|不错[啊呀哦]?|牛逼|牛啊|超赞|靠谱[啊呀]?|辛苦了|谢谢[啦啊]?|感谢[啦啊]?|真漂亮|真乖)[，。！？!?；;\s]*$/.test(clean)?'praise':null
}

/** Exact integrated stress decay while reward itself decays. Unlike a frozen
 * multiplier this gives the same result across intermediate projections. */
function stressAt(state,p,at){
  const dt=Math.max(0,at-state.updated_at),k=Math.LN2/(p.reward_half_minutes*MINUTE),a=p.reward_stress_decay*state.values.reward/100
  const integrated=dt+(a>0?Math.log((1-a*Math.exp(-k*dt))/(1-a))/k:0)
  return clamp(state.values.stress*Math.exp(-Math.LN2*integrated/(p.stress_half_hours*HOUR)))
}
const rewardAt=(state,p,at)=>clamp(state.values.reward*2**(-Math.max(0,at-state.updated_at)/(p.reward_half_minutes*MINUTE)))
function energyStep(state,p,energy,from,to){
  if(to<=from)return energy
  const mid=(from+to)/2,rate=Math.LN2/(p.recovery_half_hours*HOUR*(1+p.stress_recovery*stressAt(state,p,mid)/100)),target=Math.min(baseline(mid,p),100-debtAt(state,p,mid))
  return clamp(target+(energy-target)*Math.exp(-rate*(to-from)),0,100-debtAt(state,p,to))
}
function integrateEnergy(state,p,energy,from,to,depth=0){
  const mid=(from+to)/2,whole=energyStep(state,p,energy,from,to),half=energyStep(state,p,energyStep(state,p,energy,from,mid),mid,to)
  if(depth>=16||Math.abs(whole-half)<0.000001||to-from<=1000)return half
  return integrateEnergy(state,p,integrateEnergy(state,p,energy,from,mid,depth+1),mid,to,depth+1)
}
/** Project decay/recovery without changing a stored timestamp or history.
 * Circadian boundaries use Asia/Shanghai even when the host runs elsewhere. */
export function projectHormoneState(state,policy,at){
  const p={...HORMONE_DEFAULTS.policy,...policy},now=Math.max(at,state.updated_at),elapsed=now-state.updated_at,values={...state.values}
  values.stress=stressAt(state,p,now);values.reward=rewardAt(state,p,now)
  const bored=Math.max(0,now-Math.max(state.updated_at,state.last_user_at+p.boredom_after_minutes*MINUTE))
  values.boredom=clamp(100-(100-values.boredom)*2**(-bored/(p.boredom_half_hours*HOUR)))
  let energy=values.energy,cursor=state.updated_at,iterations=0
  const recoveryAt=state.last_work_at+p.rest_after_minutes*MINUTE
  while(cursor<now){
    const today=midnight(cursor),candidates=[now,today+DAY,today+p.night_start_hour*HOUR,today+p.night_end_hour*HOUR,recoveryAt,...state.debts.map(d=>d.at+p.debt_decay_hours*HOUR)],end=Math.min(...candidates.filter(t=>t>cursor))
    if(cursor>=recoveryAt)energy=integrateEnergy(state,p,energy,cursor,end)
    else energy=Math.min(energy,100-debtAt(state,p,end))
    cursor=end
    if(cursor===today+DAY)energy=Math.min(clamp(energy+p.daily_recovery),100-debtAt(state,p,cursor))
    // Years of clock movement must not hang a settings read. After 4096 day
    // segments, use a bounded final-day projection. Ordinary recovery remains
    // boundary-exact; no stored value is changed by this defensive branch.
    if(++iterations>16384&&cursor<now){cursor=Math.max(cursor,midnight(now));energy=Math.min(clamp(energy+p.daily_recovery),100-debtAt(state,p,cursor));iterations=0}
  }
  values.energy=clamp(energy,0,100-debtAt(state,p,now))
  return {values,sleep_debt:debtAt(state,p,now),energy_ceiling:100-debtAt(state,p,now),elapsed}
}
const activeKeys=(v,p)=>[...(v.stress>p.stress_high?['stress']:[]),...(v.energy<p.energy_low?['energy']:[]),...(v.reward>p.reward_high?['reward']:[]),...(v.boredom>p.boredom_high?['boredom']:[])]
function recoveredBetween(state,p,key,from,to){
  // Only energy can leave and re-enter a threshold without a new event (day
  // recovery followed by a low night baseline). Other trajectories between
  // events are monotonic, and record() handles their discrete crossings.
  if(key!=='energy'||to<=from)return false
  let cursor=Math.max(state.updated_at,from),steps=0
  while(cursor<to){
    if(projectHormoneState(state,p,cursor).values.energy>=p.energy_low)return true
    const start=midnight(cursor),next=Math.min(to,...[start+DAY,start+p.night_start_hour*HOUR,start+p.night_end_hour*HOUR].filter(at=>at>cursor))
    cursor=next
    if(++steps>256){cursor=Math.max(cursor,midnight(to));steps=0}
  }
  return false
}
function settleKnownRound(state,p,roundState,{at,work_at=at,success=false,cancelled=false,reward_eligible=true}){
  if(roundState.tool_count===0)return null
  const scale=clamp(1+p.stress_cost*state.values.stress/100-p.reward_cost*Math.sqrt(state.values.reward/100),0.4,2.5),cost=roundState.tokens/p.daily_token_budget*100*scale
  const reason=cancelled?'work_cancelled':success&&roundState.error_count===0?'work_done':'work_failed'
  state.values.energy=clamp(state.values.energy-cost)
  if(reason==='work_done'&&reward_eligible){state.values.stress=clamp(state.values.stress-20);state.values.reward=clamp(state.values.reward+35);state.values.boredom=clamp(state.values.boredom-25)}
  if(cost>0&&night(work_at,p)){
    const remaining=Math.max(0,1-Math.max(0,at-work_at)/(p.debt_decay_hours*HOUR)),room=Math.max(0,p.debt_max-debtAt(state,p,at)),amount=remaining>0?Math.min(room/remaining,cost*p.debt_ratio,p.debt_max):0
    if(amount>0){if(state.debts.length>=400)throw new Error('睡眠债记录已满；未延长或合并旧债');state.debts.push({amount,at:work_at})}
  }
  state.values.energy=Math.min(state.values.energy,100-debtAt(state,p,at));state.last_work_at=Math.max(state.last_work_at,work_at)
  return reason
}

export class NativeHormone{
  constructor(options={}){fields(options,['store','now']);const {store,now=store?.now??Date.now}=options;if(!(store instanceof NativeStore)||typeof now!=='function')throw new Error('激素引擎必须使用原生NativeStore和时钟');this.store=store;this.now=now}
  _now(){return integer(this.now(),'激素时钟',0,8640000000000000-OFFSET)}
  _data(){
    const config=this.store.getDocument('hormone'),document=this.store.getDocument('hormone-state'),now=this._now()
    if(config&&config.type!=='hormone'||document&&document.type!=='hormone_state')throw new Error('激素文档类型错误')
    if(config)validateDocument(config);if(document)validateDocument(document)
    const settings=config?.value??HORMONE_DEFAULTS,policy={...HORMONE_DEFAULTS.policy,...settings.policy},state=document?.value??freshHormoneState(now,policy)
    return {config,document,policy,state,now,enabled:this.store.getDocument('settings')?.value.enabled!==false&&settings.enabled!==false,mode:settings.mode??'active'}
  }
  ensure(){
    if(this.store.readOnly)return {initialized:false,status:'read_only'}
    return this.store.transaction(()=>{
      const data=this._data();let initialized=false
      if(!data.config){this.store.putDocument({id:'hormone',type:'hormone',expected_revision:0,value:structuredClone(HORMONE_DEFAULTS)});initialized=true}
      if(!data.document){this.store.putDocument({id:'hormone-state',type:'hormone_state',expected_revision:0,value:data.state});initialized=true}
      return {initialized,status:'ready'}
    })
  }
  status(){const d=this._data(),projected=projectHormoneState(d.state,d.policy,d.now);return {enabled:d.enabled,mode:d.mode,values:projected.values,sleep_debt:projected.sleep_debt,energy_ceiling:projected.energy_ceiling,computed_at:d.now,updated_at:d.state.updated_at,policy:{...d.policy},history:structuredClone(d.state.history),model_calls:0}}
  preview(){
    const d=this._data(),s=projectHormoneState(d.state,d.policy,d.now),active=activeKeys(s.values,d.policy),fresh=active.filter(k=>!d.state.emit.active.includes(k)||recoveredBetween(d.state,d.policy,k,d.state.emit.at,d.now)),remind=active.length&&d.now-d.state.emit.at>=d.policy.reminder_minutes*MINUTE
    const keys=d.enabled&&d.mode==='active'?(fresh.length?fresh:remind?active:[]):[]
    return {enabled:d.enabled,mode:d.mode,active,keys,values:s.values,sleep_debt:s.sleep_debt,energy_ceiling:s.energy_ceiling,token:hash(JSON.stringify([d.document?.revision??0,active,keys])),model_calls:0}
  }
  acknowledge(input){
    fields(input,['keys','token']);if(!Array.isArray(input.keys)||input.keys.length>4||new Set(input.keys).size!==input.keys.length||input.keys.some(k=>!KEYS.includes(k)))throw new Error('实际注入的激素状态无效');keyText(input.token,'状态提示版本',64)
    if(this.store.readOnly)return {acknowledged:false,status:'read_only'}
    return this.store.transaction(()=>{
      const d=this._data(),preview=this.preview()
      if(!d.enabled||d.mode!=='active')return {acknowledged:false,status:'disabled'}
      if(preview.token!==input.token||input.keys.some(k=>!preview.keys.includes(k)))return {acknowledged:false,status:'stale'}
      if(!input.keys.length)return {acknowledged:false,status:'empty'}
      const state=structuredClone(d.state);state.emit={active:[...new Set([...state.emit.active.filter(k=>preview.active.includes(k)),...input.keys])],at:d.now}
      this.store.putDocument({id:'hormone-state',type:'hormone_state',expected_revision:d.document?.revision??0,value:state})
      return {acknowledged:true,status:'recorded'}
    })
  }
  /** Close known local accounting after a quiescent restore, or only the
   * explicitly tracked sessions during normal shutdown. Never replays work. */
  settlePending(input){
    fields(input,['key','session_ids']);keyText(input.key,'未完成轮次结算标识',1024)
    if(input.session_ids!==undefined&&(!Array.isArray(input.session_ids)||input.session_ids.length>10000))throw new Error('待结算会话列表无效')
    const allowed=input.session_ids===undefined?null:new Set(input.session_ids.map(id=>hash(keyText(id,'待结算会话标识'))))
    if(this.store.readOnly)return {settled:0,status:'read_only',model_calls:0}
    return this.store.transaction(()=>{
      const d=this._data(),eventKey='hormone:settle-pending:'+hash(input.key)
      if(this.store.db.prepare('SELECT id FROM journal_events WHERE event_key=?').get(eventKey))return {settled:0,status:'duplicate',duplicate:true,model_calls:0}
      const rounds=d.state.rounds.filter(row=>allowed===null||allowed.has(row.session_hash))
      if(!rounds.length)return {settled:0,status:'empty',model_calls:0}
      const at=Math.max(d.now,d.state.updated_at),state=structuredClone(d.state),projected=projectHormoneState(state,d.policy,at);state.values=projected.values;state.updated_at=at;state.day=dayOf(at);state.debts=state.debts.filter(row=>at-row.at<d.policy.debt_decay_hours*HOUR)
      let work=0
      for(const pending of rounds){
        const turnKey='hormone:turn:'+pending.id
        if(!this.store.db.prepare('SELECT id FROM journal_events WHERE event_key=?').get(turnKey)){
          const reason=settleKnownRound(state,d.policy,pending,{at,work_at:pending.updated_at,success:false,cancelled:true,reward_eligible:false})
          if(reason){work++;state.history.push({at,reason,platform:'harness',values:Object.fromEntries(KEYS.map(k=>[k,round(state.values[k])])),debt:round(debtAt(state,d.policy,at))})}
          this.store.appendJournalEvent({event_key:turnKey,event_type:'log',platform:'harness',direction:'internal',status:'recorded',visibility:'owner',text:'',source_at:at,source_type:'native_hormone',metadata:{subtype:'turn_settled',session_hash:pending.session_hash,turn:pending.turn,worked:!!reason,success:false,cancelled:true,tokens:pending.tokens,recovery:true}})
        }
      }
      const ids=new Set(rounds.map(row=>row.id));state.rounds=state.rounds.filter(row=>!ids.has(row.id));state.history=state.history.slice(-MAX_HISTORY)
      state.emit.active=state.emit.active.filter(k=>activeKeys(state.values,d.policy).includes(k)&&!recoveredBetween(d.state,d.policy,k,d.state.emit.at,at))
      this.store.putDocument({id:'hormone-state',type:'hormone_state',expected_revision:d.document?.revision??0,value:state})
      this.store.appendJournalEvent({event_key:eventKey,event_type:'log',platform:'harness',direction:'internal',status:'recorded',visibility:'owner',text:'',source_at:at,source_type:'native_hormone',metadata:{subtype:'pending_turns_settled',turns:rounds.length,work_rounds:work}})
      return {settled:rounds.length,work_rounds:work,status:'recorded',model_calls:0}
    })
  }
  record(input){
    fields(input,['kind','key','session_id','turn','platform','at','tone','failed','request_key','cumulative_tokens','success','cancelled','reward_eligible'])
    if(!['human','tool','usage','turn_end'].includes(input.kind))throw new Error('激素事件类型无效')
    keyText(input.key,'激素事件标识',1024);keyText(input.session_id,'激素会话标识');const platform=input.platform??'harness';if(!PLATFORMS.includes(platform))throw new Error('激素来源平台无效')
    if(input.at!==undefined)integer(input.at,'激素事件时间',0,8640000000000000-OFFSET)
    if(input.kind==='human'&&input.tone!==undefined&&!['neutral','praise','blame'].includes(input.tone))throw new Error('真人语气类型无效')
    if(input.kind!=='human')integer(input.turn,'激素事件轮次')
    if(input.kind==='tool'&&typeof input.failed!=='boolean')throw new Error('工具结果必须明确成功或失败')
    if(input.kind==='usage'){keyText(input.request_key,'模型请求标识',1024);integer(input.cumulative_tokens,'真实累计Token')}
    if(input.kind==='turn_end'&&(typeof input.success!=='boolean'||input.cancelled!==undefined&&typeof input.cancelled!=='boolean'||input.reward_eligible!==undefined&&typeof input.reward_eligible!=='boolean'))throw new Error('轮次结束必须明确成功与否')
    if(this.store.readOnly)return {recorded:false,status:'read_only'}
    return this.store.transaction(()=>{
      const d=this._data();if(!d.enabled)return {recorded:false,status:'disabled'}
      if(input.at!==undefined&&input.at>d.now+MINUTE)throw new Error('激素事件时间超过当前时钟')
      const eventKey='hormone:event:'+hash(input.kind+'\0'+input.key),turnKey=input.kind==='human'?null:'hormone:turn:'+hash(input.session_id+'\0'+input.turn)
      if(this.store.db.prepare('SELECT id FROM journal_events WHERE event_key=?').get(eventKey))return {recorded:true,duplicate:true,status:'duplicate'}
      if(turnKey&&this.store.db.prepare('SELECT id FROM journal_events WHERE event_key=?').get(turnKey))return {recorded:false,status:'closed_turn'}
      const at=Math.max(d.state.updated_at,Math.min(input.at??d.now,d.now)),state=structuredClone(d.state),projected=projectHormoneState(state,d.policy,at),priorActive=activeKeys(projected.values,d.policy)
      state.values=projected.values;state.updated_at=at;state.day=dayOf(at);state.debts=state.debts.filter(row=>at-row.at<d.policy.debt_decay_hours*HOUR)
      state.emit.active=state.emit.active.filter(k=>priorActive.includes(k)&&!recoveredBetween(d.state,d.policy,k,d.state.emit.at,at))
      let reason=null,delta={},roundState,work=false
      if(input.kind==='human'){
        state.last_user_at=at;delta.boredom=-30;reason='human'
        if(input.tone==='praise'){delta.reward=40;delta.boredom-=10;reason='praised'}else if(input.tone==='blame'){delta.stress=12;reason='blamed'}
      }else{
        const id=hash(input.session_id+'\0'+input.turn),sessionHash=hash(input.session_id)
        roundState=state.rounds.find(row=>row.id===id)
        if(!roundState){
          if(state.rounds.length>=MAX_ROUNDS)throw new Error('并发激素轮次已达上限；未覆盖其他会话状态')
          roundState={id,session_hash:sessionHash,turn:input.turn,updated_at:at,tokens:0,tool_count:0,error_count:0,consecutive_errors:0,requests:[]};state.rounds.push(roundState)
        }
        roundState.updated_at=at
        if(input.kind==='tool'){
          roundState.tool_count++;if(input.failed){roundState.error_count++;roundState.consecutive_errors++;const repeated=roundState.consecutive_errors%3===0;delta.stress=8+(repeated?15:0);reason=repeated?'repeated_errors':'tool_error'}else roundState.consecutive_errors=0
        }else if(input.kind==='usage'){
          const requestId=hash(input.request_key),old=roundState.requests.find(row=>row.id===requestId)
          if(!old&&(roundState.requests.length>=MAX_REQUESTS||state.rounds.reduce((n,row)=>n+row.requests.length,0)>=MAX_TOTAL_REQUESTS))throw new Error('本轮模型请求统计已达上限；未丢弃旧用量')
          const additional=Math.max(0,input.cumulative_tokens-(old?.total_tokens??0))
          if(!Number.isSafeInteger(roundState.tokens+additional))throw new Error('本轮Token累计溢出')
          roundState.tokens+=additional;if(old)old.total_tokens=Math.max(old.total_tokens,input.cumulative_tokens);else roundState.requests.push({id:requestId,total_tokens:input.cumulative_tokens})
        }else{
          work=roundState.tool_count>0;reason=settleKnownRound(state,d.policy,roundState,{at,success:input.success,cancelled:input.cancelled===true,reward_eligible:input.reward_eligible!==false})
          state.rounds=state.rounds.filter(row=>row.id!==id)
          this.store.appendJournalEvent({event_key:turnKey,event_type:'log',platform,direction:'internal',status:'recorded',visibility:'owner',text:'',source_at:at,source_type:'native_hormone',metadata:{subtype:'turn_settled',session_hash:sessionHash,turn:input.turn,worked:work,success:input.success===true&&!input.cancelled&&roundState.error_count===0,cancelled:input.cancelled===true,tokens:roundState.tokens}})
        }
      }
      for(const key of KEYS)state.values[key]=clamp(state.values[key]+(delta[key]??0))
      state.values.energy=Math.min(state.values.energy,100-debtAt(state,d.policy,at))
      if(reason){state.history.push({at,reason,platform,values:Object.fromEntries(KEYS.map(k=>[k,round(state.values[k])])),debt:round(debtAt(state,d.policy,at))});state.history=state.history.slice(-MAX_HISTORY)}
      this.store.appendJournalEvent({event_key:eventKey,event_type:'log',platform,direction:'internal',status:'recorded',visibility:'owner',text:'',source_at:at,source_type:'native_hormone',metadata:{subtype:'state_event',kind:input.kind,reason:reason??'accounting',session_hash:hash(input.session_id),...(input.kind==='usage'?{request_hash:hash(input.request_key),cumulative_tokens:input.cumulative_tokens}:{})}})
      this.store.putDocument({id:'hormone-state',type:'hormone_state',expected_revision:d.document?.revision??0,value:state})
      return {recorded:true,duplicate:false,status:'recorded',values:{...state.values},reason,model_calls:0}
    })
  }
}
