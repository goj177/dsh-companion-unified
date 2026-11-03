/** Shared local CNY token budget. Integer nano-yuan avoids floating-point drift.
 * Official price reference: https://api-docs.deepseek.com/zh-cn/quick_start/pricing/
 * Verified 2026-10-29; token prices only, independent of account recharge balance. */
import {createHash,randomUUID} from 'node:crypto'
import {NativeStore} from './store.mjs'
import {isPlainObject,stringifyJson} from './contracts.mjs'
import {shanghaiTime,valleyDecision} from '../policy.mjs'
import calendar from '../holidays-2026.json' with {type:'json'}

export const MONEY_PRICING_VERSION='deepseek-cny-20261029'
export const CNY_NANO=1000000000
const hash=value=>createHash('sha256').update(value).digest('hex'),valid=value=>Number.isSafeInteger(value)&&value>=0
const billingHolidays=calendar.ranges.flatMap(([a,b])=>{const days=[];for(let at=Date.parse(a+'T00:00:00Z');at<=Date.parse(b+'T00:00:00Z');at+=86400000)days.push(new Date(at).toISOString().slice(0,10));return days})
const billingPhase=at=>valleyDecision(at,{holidays:billingHolidays})
const canonicalUsage=usage=>{
  if(!isPlainObject(usage)||!valid(usage.inputTokens)||!valid(usage.outputTokens)||['cacheReadTokens','cacheWriteTokens'].some(key=>usage[key]!==undefined&&!valid(usage[key])))return null
  const value={inputTokens:usage.inputTokens,outputTokens:usage.outputTokens,cacheReadTokens:usage.cacheReadTokens??0,cacheWriteTokens:usage.cacheWriteTokens??0},total=Object.values(value).reduce((a,b)=>a+b,0)
  if(!valid(total)||usage.totalTokens!==undefined&&(!valid(usage.totalTokens)||usage.totalTokens!==total))return null
  return value
}
export function moneyRates(model,peak=false){
  const flash=['deepseek-flash','deepseek-v4-flash','deepseek-v4-flash-vision-exp'].includes(model),pro=model==='deepseek-v4-pro'
  if(!flash&&!pro)return null
  const multiplier=peak?2:1
  return {input:(flash?1000:4500)*multiplier,cache_read:(flash?20:150)*multiplier,cache_write:(flash?1000:4500)*multiplier,output:(flash?4000:13500)*multiplier}
}
export function moneyUsageCost(usage,rates){const v=canonicalUsage(usage);if(!v)return null;const cost=v.inputTokens*rates.input+v.cacheReadTokens*rates.cache_read+v.cacheWriteTokens*rates.cache_write+v.outputTokens*rates.output;return valid(cost)?{nano:cost,usage:v}:null}
export class MoneyBudgetError extends Error{constructor(message,reason='budget'){super('[companion_money_budget] '+message);this.code='COMPANION_MONEY_BUDGET';this.reason=reason}}
const metadata=row=>JSON.parse(row.metadata_json)
const effective=m=>Math.max(m.charged_nano??0,m.reservation_open?m.reserved_nano??0:0)
export function validateMoneyRecord(row){
  const m=typeof row.metadata_json==='string'?metadata(row):row.metadata
  if(row.kind!=='model.money'||!isPlainObject(m)||m.schema_version!==1||m.record_type!=='money_reservation'||!/^\d{4}-\d{2}-\d{2}$/.test(m.day??'')||m.platform!==row.platform||typeof m.session_id!=='string'||!['reserved_nano','charged_nano','known_nano','lease_until'].every(key=>valid(m[key]))||typeof m.reservation_open!=='boolean'||typeof m.usage_known!=='boolean'||typeof m.started!=='boolean'||m.pricing_version!==MONEY_PRICING_VERSION)throw new Error('原生费用记录字段无效')
  const allowed=[moneyRates(m.model),moneyRates(m.model,true)].filter(Boolean);if(!allowed.some(rates=>['input','output','cache_read','cache_write'].every(key=>rates[key]===m.rates?.[key])))throw new Error('原生费用单价快照无效')
  if(m.usage_known&&(!m.last_usage||moneyUsageCost(m.last_usage,m.rates)?.nano!==m.charged_nano||m.reservation_open))throw new Error('原生已核验费用与用量不一致')
  return m
}
export const effectiveMoneyNano=effective
// One UTF-8 byte is a conservative text-token bound. Include system and tool
// history as well as visible turns; reserve all input as cache misses. The SDK
// sends image references separately, so add the official per-image maximum.
// https://api-docs.deepseek.com/zh-cn/guides/vision/ (1024 tokens/image).
export function moneyRequestBound(request,rates){
  let imageCount=0,blocks=0,opaqueFile=false,bytes
  try{
    const body=JSON.stringify({system:request.system??'',messages:request.messages??[],tools:request.tools??[],toolHistory:request.toolHistory??null},(_key,value)=>{
      if(value&&typeof value==='object'&&typeof value.type==='string'){blocks++;if(['image','image_url','input_image'].includes(value.type))imageCount++;if(value.type==='file')opaqueFile=true}
      if(value instanceof Map)return [...value.entries()]
      return value instanceof Uint8Array?'[binary image]':value
    })
    bytes=Buffer.byteLength(body)
  }catch{throw new MoneyBudgetError('请求内容无法核对，未调用模型','unknown_request')}
  const framing=4096+128*((request.messages?.length??0)+(request.tools?.length??0)+blocks)
  const input=opaqueFile?1048576:Math.min(1048576,bytes+imageCount*1024+framing)
  const output=valid(request.maxTokens)&&request.maxTokens>0?Math.min(request.maxTokens,393216):393216
  const nano=input*rates.input+output*rates.output;if(!valid(nano))throw new MoneyBudgetError('无法核对本次请求的费用预留','unknown_request')
  return {nano,input_ceiling:input,output_ceiling:output,image_ceiling:imageCount>0,image_count:imageCount,visible_bytes:bytes,framing_tokens:framing,method:opaqueFile?'opaque_file_context_ceiling':'request_utf8_visual_upper_bound'}
}

export class NativeMoneyBudget{
  constructor({store,now=Date.now}={}){if(!(store instanceof NativeStore)||typeof now!=='function')throw new Error('费用预算需要原生存储');this.store=store;this.now=now;this.live=new Set();this.latest=new Map();this.positions=new Map();this.denials=new Map()}
  _policy(){const id=this.store.getDocument('settings')?.value.activity_document_id??'activity';return this.store.getDocument(id)?.value.budget??{}}
  enabled(){return this._policy().money_budget_enabled===true}
  _rows(day){return this.store.db.prepare("SELECT * FROM actions WHERE kind='model.money' AND json_extract(metadata_json,'$.day')=?").all(day)}
  status({day=shanghaiTime(this.now()).date}={}){
    let known=0,uncertain=0,reserved=0
    for(const row of this._rows(day)){const m=metadata(row),value=effective(m);if(m.reservation_open)reserved+=value;else if(m.usage_known)known+=value;else uncertain+=value}
    const p=this._policy(),limit=(p.daily_cost_limit_fen??500)*10000000,total=known+uncertain+reserved
    return {enabled:p.money_budget_enabled===true,scope:'all_companion_and_qq',day,currency:'CNY',limit_nano:limit,known_nano:known,uncertain_nano:uncertain,reserved_nano:reserved,counted_nano:total,remaining_nano:Math.max(0,limit-total),pricing_version:MONEY_PRICING_VERSION,model_calls:0}
  }
  _row(id){const row=this.store.db.prepare("SELECT * FROM actions WHERE id=? AND kind='model.money'").get(id);if(!row)throw new Error('费用预留不存在');return {row,value:metadata(row)}}
  _write(id,value,status){this.store.db.prepare('UPDATE actions SET status=?,updated_at=?,metadata_json=? WHERE id=?').run(status,this.now(),stringifyJson(value),id)}
  recover(){
    const rows=this.store.db.prepare("SELECT * FROM actions WHERE kind='model.money' AND json_extract(metadata_json,'$.reservation_open')=1").all()
    for(const row of rows){const m=metadata(row);if(!this.live.has(row.id)&&m.lease_until<=this.now())this._write(row.id,{...m,reservation_open:false,charged_nano:m.started?Math.max(m.charged_nano,m.reserved_nano):0,usage_known:false,recovered_unknown:true},m.started?'unknown':'cancelled')}
  }
  reserve(request,{scope='qq',platform='qq'}={}){
    if(!this.enabled())return null
    if(!['deepseek-account','deepseek'].includes(request.provider)||!moneyRates(request.model))throw new MoneyBudgetError('当前模型单价尚未核验，费用预算已阻止新调用','unknown_model')
    return this.store.transaction(()=>{
      this.recover();const at=this.now(),policy=this._policy(),phase=billingPhase(at),rates=moneyRates(request.model,phase.peak),bound=moneyRequestBound(request,moneyRates(request.model,true)),status=this.status()
      if(bound.nano>status.remaining_nano)throw Object.assign(new MoneyBudgetError('日上限¥'+(status.limit_nano/1e9).toFixed(2)+'；已核算¥'+(status.known_nano/1e9).toFixed(4)+'，待核对占额¥'+(status.uncertain_nano/1e9).toFixed(4)+'，进行中预留¥'+(status.reserved_nano/1e9).toFixed(4)+'；本次还需预留¥'+(bound.nano/1e9).toFixed(4)+'，可用额度不足。预留不是已消费。',status.reserved_nano>0&&bound.nano<=status.remaining_nano+status.reserved_nano?'inflight':'budget'),{required_nano:bound.nano})
      const id='money:'+randomUUID(),position=this.positions.get(request.sessionId)??{},value={schema_version:1,record_type:'money_reservation',day:shanghaiTime(at).date,scope,platform,session_id:request.sessionId??'',...position,provider:request.provider,model:request.model,pricing_version:MONEY_PRICING_VERSION,rates,reserved_nano:bound.nano,charged_nano:0,known_nano:0,reservation_open:true,usage_known:false,started:false,lease_until:at+(policy.money_request_timeout_ms??900000),started_at:null,bound}
      this.store.db.prepare('INSERT INTO actions(id,platform,kind,target_json,body,body_digest,request_digest,status,created_at,updated_at,metadata_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id,platform,'model.money',stringifyJson({session_id:value.session_id,scope}),'',hash(''),hash(id),'reserved',at,at,stringifyJson(value))
      this.live.add(id);this.latest.set(value.session_id,id);return id
    })
  }
  markStarted(id){if(!id)return;this.store.transaction(()=>{const{value}=this._row(id);if(!value.reservation_open)throw new MoneyBudgetError('费用预留已结束，未调用模型');this._write(id,{...value,started:true,started_at:this.now()},'running')})}
  usage(id,usage){if(!id)return;this.store.transaction(()=>{const{row,value}=this._row(id),priced=moneyUsageCost(usage,value.rates);if(!priced||priced.nano<value.known_nano)return;this._write(id,{...value,known_nano:priced.nano,last_usage:priced.usage,...(!value.reservation_open?{charged_nano:priced.nano,usage_known:true}:{} )},value.reservation_open?row.status:'confirmed')})}
  finish(id,{completed=false}={}){if(!id)return;try{this.store.transaction(()=>{const{value}=this._row(id);if(!value.reservation_open)return;const known=completed&&!!value.last_usage;this._write(id,{...value,reservation_open:false,charged_nano:!value.started?0:known?value.known_nano:Math.max(value.reserved_nano,value.known_nano),usage_known:known,completed_at:this.now()},!value.started?'cancelled':known?'confirmed':'unknown')})}finally{this.live.delete(id)}}
  onRequest({agent,turn,step}){const sid=agent?.session?.id??agent?.session?.header?.id;if(sid)this.positions.set(sid,{turn,step})}
  onEvent(session,event){
    const sid=session?.id??session?.header?.id,id=this.latest.get(sid);if(!id||!['assistant/message','assistant/attempt'].includes(event.type))return
    const {value}=this._row(id),data=event.data??{};if(data.turn!==value.turn||data.step!==value.step||value.usage_known)return
    if(data.usage)this.usage(id,data.usage)
  }
  denial(session_id){return this.denials.get(session_id)??null}
  async *stream(request,next,{scope='qq',platform='qq',through}={}){
    if(!this.enabled()){yield* (through?through(next):next());return}
    let id,complete=false
    try{
      if(request.signal?.aborted)throw request.signal.reason??new Error('请求已取消')
      for(let attempt=0;;attempt++){
        try{id=this.reserve(request,{scope,platform});break}catch(error){if(!(error instanceof MoneyBudgetError)||error.reason!=='inflight'||attempt>=30)throw error;if(request.signal?.aborted)throw request.signal.reason??new Error('请求已取消');await new Promise(resolve=>setTimeout(resolve,1000))}
      }
      this.denials.delete(request.sessionId)
      const start=()=>{this.markStarted(id);return next()},stream=through?through(start):start()
      for await(const chunk of stream){if(chunk?.type==='usage')this.usage(id,chunk.usage);if(chunk?.type==='finish')complete=true;yield chunk}
      complete=true
    }catch(error){if(error instanceof MoneyBudgetError){this.denials.set(request.sessionId,{at:this.now(),...this.positions.get(request.sessionId),reason:error.reason,message:error.message,required_nano:error.required_nano});if(this.denials.size>1000)this.denials.delete(this.denials.keys().next().value)}throw error}
    finally{this.finish(id,{completed:complete})}
  }
  importUsage({key,session_id,platform,at,model,provider='deepseek-account',usage,uncertain_tokens=0}){
    const rates=moneyRates(model,billingPhase(at).peak);if(!rates||!valid(at)||typeof key!=='string')throw new Error('历史费用来源无效')
    const priced=moneyUsageCost(usage,rates),nano=priced?.nano??uncertain_tokens*moneyRates(model,true).output;if(!valid(nano))throw new Error('历史费用用量无效')
    const id='money:import:'+hash(key),day=shanghaiTime(at).date,value={schema_version:1,record_type:'money_reservation',day,scope:'historical_companion',platform,session_id,provider,model,pricing_version:MONEY_PRICING_VERSION,rates,reserved_nano:0,charged_nano:nano,known_nano:priced?.nano??0,reservation_open:false,usage_known:!!priced,started:true,lease_until:0,started_at:at,import_key:key,...(priced?{last_usage:priced.usage}:{uncertain_tokens})}
    this.store.db.prepare('INSERT OR IGNORE INTO actions(id,platform,kind,target_json,body,body_digest,request_digest,status,created_at,updated_at,metadata_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id,platform,'model.money',stringifyJson({session_id}),'',hash(''),hash(id),priced?'confirmed':'unknown',at,this.now(),stringifyJson(value));return id
  }
}
