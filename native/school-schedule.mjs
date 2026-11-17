import {createHash} from 'node:crypto'
import {enrollSchoolCard, runSchoolVisit, savedSchoolCard, schoolCard} from './school-visit.mjs'

const SOURCE='native_school_schedule'
const TITLE='托儿所 · 定时回园'
const PROMPT='回大肥鱼托儿所查看一次。欧鲸鲸插件根据本条日程的投递回执执行回园，处理当节课和点名消息。'
const LEGACY_PROMPT='每半小时回大肥鱼托儿所查看一次。欧鲸鲸插件根据本条日程的投递回执执行回园，处理当节课和点名消息。'
const DEFAULT_INTERVAL=1800
const isCurrentSchoolTask=task=>task?.kind==='every'&&task.title===TITLE&&task.prompt===PROMPT
const isSchoolTask=task=>isCurrentSchoolTask(task)||task?.kind==='every'&&task.prompt===LEGACY_PROMPT
const hash=text=>createHash('sha256').update(text).digest('hex')
const sidOf=agent=>agent?.session?.id??agent?.session?.header?.id

export class NativeSchoolSchedule {
  constructor({store,runtime_root,schedule,enabled,dsh_model,llm,profile_name,now=Date.now,visit=runSchoolVisit,fetcher=globalThis.fetch}){
    Object.assign(this,{store,runtime_root,schedule,enabled,dsh_model,llm,profile_name,now,visit,fetcher})
  }
  get available(){return typeof this.runtime_root==='string'&&!!this.schedule()?.catalog}
  grant(){
    const saved=this.store.db.prepare("SELECT metadata_json FROM journal_events WHERE source_type=? AND (event_key=? OR event_key LIKE ?) ORDER BY rowid DESC LIMIT 1").get(SOURCE,SOURCE+':grant',SOURCE+':grant:%')
    return saved&&JSON.parse(saved.metadata_json)
  }
  savedInterval(){return this.store.getDocument('settings')?.value.school?.interval_seconds??DEFAULT_INTERVAL}
  saveInterval(interval_seconds){
    this.store.transaction(()=>{
      const settings=this.store.getDocument('settings')
      if(settings&&settings.value.school?.interval_seconds!==interval_seconds){
        this.store.putDocument({id:settings.id,type:settings.type,expected_revision:settings.revision,
          value:{...settings.value,school:{interval_seconds}}})
      }
    })
  }
  event(key, status, text, metadata={}){
    return this.store.appendJournalEvent({event_key:SOURCE+':'+key,event_type:'log',platform:'harness',direction:'internal',
      status,visibility:'owner',text,source_type:SOURCE,source_at:this.now(),metadata})
  }
  async status(){
    const grant=this.grant()
    let has_card=null,card_error
    if(typeof this.runtime_root==='string'){
      try{has_card=!!await savedSchoolCard(this.runtime_root)}catch{card_error='托儿所园牌文件无法读取，请核对后刷新'}
    }
    const task=grant&&this.available?await this.schedule().view({id:grant.id}):null
    const row=this.store.db.prepare("SELECT status,text,source_at,metadata_json FROM journal_events WHERE source_type=? AND event_key LIKE 'native_school_schedule:result:%' ORDER BY rowid DESC LIMIT 1").get(SOURCE)
    return {available:this.available,has_card,can_enroll:has_card===false&&this.enabled(),
      ...(card_error?{card_error}:{}),active:isSchoolTask(task)&&task.status==='active',interval_seconds:task?.everySeconds??this.savedInterval(),
      schedule_id:grant?.id??null,next_at:task?.scheduledAt??null,last:row?{status:row.status,text:row.text,at:row.source_at,...JSON.parse(row.metadata_json)}:null}
  }
  enroll(){
    if(this.enrolling)return this.enrolling
    this.enrolling=this.registerCard().finally(()=>{this.enrolling=undefined})
    return this.enrolling
  }
  async registerCard(){
    if(!this.enabled()||typeof this.runtime_root!=='string')throw Error('托儿所入学入口尚未就绪')
    if(await savedSchoolCard(this.runtime_root))return this.status()
    if(this.grant())throw Error('已登记过入学，请恢复原园牌后回园')
    await enrollSchoolCard(this.runtime_root,{fetcher:this.fetcher,name:this.profile_name?.()})
    return this.status()
  }
  async configure({enabled,interval_seconds}){
    if(!this.enabled()||!this.available)throw Error('DSH 原生回园日程尚未就绪')
    if(typeof enabled!=='boolean')throw Error('请选择是否开启定时回园')
    const host=this.schedule()
    const grant=this.grant(),card=enabled?await schoolCard(this.runtime_root):null
    if(card&&grant&&card.id!==grant.fish_id)throw Error('现有日程与当前园牌不一致')
    let task=grant?await host.view({id:grant.id}):null
    if(task?.code==='schedule_not_found')task=null
    if(task&&!isSchoolTask(task))throw Error('DSH 中的托儿所日程已被改为其他用途')
    if(!task&&enabled){
      const existing=(await host.catalog()).filter(isCurrentSchoolTask)
      if(existing.length>1)throw Error('存在多个同名托儿所日程')
      task=existing[0]??null
    }
    const interval=interval_seconds??task?.everySeconds??this.savedInterval()
    if(!Number.isSafeInteger(interval)||interval<60||!Number.isSafeInteger(this.now()+interval*1000))throw Error('回园间隔至少为 1 分钟')
    const timing={kind:'every',every_seconds:interval}
    if(task&&((task.status==='active')!==enabled||task.everySeconds!==interval)){
      if(typeof host.edit!=='function')throw Error('DSH 原生回园日程编辑尚未就绪')
      task=await host.edit({id:task.id,action:'update',expectedUpdatedAt:task.updatedAt,patch:{title:TITLE,prompt:PROMPT,active:enabled,timing}})
      if(task?.code==='schedule_conflict')throw Error('日程已更新，请刷新后再保存')
    }else if(!task&&enabled){
      task=await host.create({title:TITLE,prompt:PROMPT,timing,target:{kind:'new_once'}})
    }
    if(task&&(!isSchoolTask(task)||task.everySeconds!==interval||(task.status==='active')!==enabled||typeof task.id!=='string'))throw Error('DSH 未确认回园设置')
    if(enabled&&task?.id!==grant?.id)this.event('grant:'+task.id,'recorded','主人启用了定时回园',{id:task.id,fish_id:card.id})
    if(!enabled)this.visitAbort?.abort(new Error('定时回园已关闭'))
    this.saveInterval(interval)
    return this.status()
  }
  saveSettings(input){
    if(this.configuring)return this.configuring
    this.configuring=this.configure(input).finally(()=>{this.configuring=undefined})
    return this.configuring
  }
  enable(){return this.saveSettings({enabled:true})}
  async runNow(){
    if(!this.enabled()||!this.available)throw Error('DSH 原生回园日程尚未就绪')
    const current=await this.status()
    if(!current.active)throw Error('托儿所日程未启用')
    if(this.inFlight)return {status:'running'}
    const result=await this.schedule().run({id:current.schedule_id})
    return {status:result?.code??'scheduled',schedule_id:current.schedule_id}
  }
  install(ctx){
    return ctx.on('agent/pre-step',async(payload,next)=>{
      const grant=this.grant()
      if(!grant||!this.available||payload.step!==1)return next()
      const messages=payload.messages??[]
      const reminder=messages.find(message=>message.source?.kind==='schedule'&&Array.isArray(message.content)&&
        message.content.some(block=>block.type==='text'&&typeof block.text==='string'&&
          (block.text.includes(PROMPT)||block.text.includes(LEGACY_PROMPT))&&block.text.includes(JSON.stringify(grant.id))))
      if(!reminder)return next()
      const task=await this.schedule().view({id:grant.id})
      if(task?.target?.sessionId!==sidOf(payload.agent))return next()
      // The scheduler has its own durable receipt. The companion's pulse does
      // the work from that receipt and the reminder need not call a model.
      return {kind:'reject'}
    })
  }
  async pulse(){
    if(!this.enabled()||!this.available||this.inFlight)return
    const grant=this.grant()
    if(!grant)return
    this.visitAbort=new AbortController()
    this.inFlight=this.dispatch(grant,this.visitAbort.signal)
    try{return await this.inFlight}finally{this.inFlight=undefined;this.visitAbort=undefined}
  }
  async dispatch(grant,signal){
    const host=this.schedule()
    const task=await host.view({id:grant.id})
    if(!isSchoolTask(task)||task.status!=='active')return
    const history=await host.history({id:grant.id,limit:1})
    const receipt=history.records?.[0],delivered=Date.parse(receipt?.deliveredAt),at=this.now()
    const sessionId=receipt?.targetSessionId
    if(signal.aborted||history.id!==grant.id||typeof receipt?.messageId!=='string'||!Number.isFinite(delivered)||
      delivered<at-task.everySeconds*1000||delivered>at+1000||typeof sessionId!=='string'||!sessionId.trim()||sessionId!==task.target?.sessionId)return
    const key=hash(grant.id+'\0'+receipt.messageId)
    const claimed=this.store.transaction(()=>{
      if(this.store.db.prepare('SELECT 1 FROM journal_events WHERE event_key=?').get(SOURCE+':start:'+key))return false
      this.event('start:'+key,'recorded','已收到 DSH 回园日程',{schedule_id:grant.id})
      return true
    })
    if(!claimed)return
    const visitSignal=AbortSignal.any([signal,AbortSignal.timeout(300000)])
    const assertActive=()=>{visitSignal.throwIfAborted();if(!this.enabled())throw Error('本机回园已停止')}
    try{
      const card=await schoolCard(this.runtime_root)
      if(card.id!==grant.fish_id)throw Error('园牌对应的鱼已改变，原日程停止发表')
      const model=this.dsh_model?.()
      const messageKey=seq=>'message:'+card.id+':'+seq
      const messageSeen=seq=>!!this.store.db.prepare('SELECT 1 FROM journal_events WHERE event_key=?').get(SOURCE+':'+messageKey(seq))
      const result=await this.visit({card,model,sessionId,llm:this.llm,fetcher:this.fetcher,signal:visitSignal,assertActive,
        messageSeen,
        recordMessage:seq=>{
          return this.store.transaction(()=>{
            if(messageSeen(seq))return false
            this.event(messageKey(seq),'recorded','已选择接续一条托儿所消息',{sequence:seq})
            return true
          })
        }})
      this.event('result:'+key,'confirmed',result.completed?'已回园，课程已完成':'已回园查看',result)
      return result
    }catch(error){
      const detail=String(error?.message??'回园失败').replace(/fish_[a-f0-9]{24}/gi,'[园牌已隐藏]').split('\n')[0].slice(0,140)
      this.event('result:'+key,'failed',detail)
    }
  }
}
