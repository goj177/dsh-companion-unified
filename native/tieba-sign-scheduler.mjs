import {createHash} from 'node:crypto'
import {NativeStore} from './store.mjs'
import {NativeSocial} from './social.mjs'
import {canonicalBar} from './tieba-atmosphere.mjs'
import {isPlainObject} from './contracts.mjs'
import {withRunScope,assertRunActive} from './run-scope.mjs'
import {shanghaiTime} from '../policy.mjs'

const DAY=86400000,MINUTE=60000,hash=value=>createHash('sha256').update(value).digest('hex')
const at=value=>Number.isSafeInteger(value)&&value>=0
const barsOf=value=>{if(!Array.isArray(value)||value.length>200)throw new Error('关注吧列表无效');return [...new Set(value.map(canonicalBar))]}
const actionId=key=>'action:'+hash('tieba\0'+key)

/** One native account-state action per pulse, with no model wake or activity
 * budget. Core calls pulse without awaiting it on the incoming-reply path.
 * Only the ordinary social dispatcher may cross the write boundary. */
export class NativeTiebaSignScheduler{
  constructor({store,social,tieba,now=store?.now??Date.now,enabled=()=>true}={}){
    if(!(store instanceof NativeStore)||!(social instanceof NativeSocial)||social.store!==store||social.providers.tieba!==tieba||tieba?.store!==store||typeof tieba.followed!=='function'||typeof now!=='function'||typeof enabled!=='function')throw new Error('自动签到需要同库贴吧、统一发件箱与宿主运行状态')
    this.store=store;this.social=social;this.tieba=tieba;this.now=now;this.enabled=enabled;this.next_at=0;this.flight=null;this.closed=false;this.last_result=null;this.controller=null;this.settings_revision=null
  }
  _now(){const value=this.now();if(!at(value))throw new Error('自动签到时钟无效');return value}
  _settings(){const global=this.store.getDocument('settings')?.value??{},id=global.platform_document_ids?.tieba??'tieba',doc=this.store.getDocument(id);if(doc&&(doc.type!=='platform_settings'||doc.value.platform!=='tieba'))throw new Error('自动签到设置类型无效');return{global,revision:doc?.revision??0,document:doc?.value??{},config:doc?.value.tieba??{}}}
  _ready(){
    const settings=this._settings(),state=this.store.getDocument('platform-state-tieba')?.value??{},now=this._now()
    if(this.closed||this.store.readOnly||this.enabled()!==true||settings.global.enabled===false||settings.document.enabled!==true||settings.config.permissions?.sign!==true)return{allowed:false,reason:'disabled',settings}
    if(state.verification_required===true)return{allowed:false,reason:'verification_required',settings}
    if(state.paused_until>now)return{allowed:false,reason:'risk_pause',not_before:state.paused_until,settings}
    if(!settings.document.credential_ref)return{allowed:false,reason:'credential_not_configured',settings}
    return{allowed:true,settings}
  }
  _replyWaiting(){return !!this.store.db.prepare("SELECT 1 FROM actions WHERE platform='tieba' AND ((kind IN ('tieba.reply','tieba.post','tieba.message') AND status IN ('queued','leased','submitting')) OR (kind='activity.incoming' AND status IN ('queued','leased','running'))) LIMIT 1").get()}
  _scope(settings){return hash(String(settings.document.account_entity_id??'')+'\0'+settings.document.credential_ref)}
  _snapshot(day,scope){const row=this.store.db.prepare("SELECT metadata_json FROM journal_events WHERE event_key=? AND source_type='native_tieba_sign_scheduler'").get('tieba-sign-followed:'+day+':'+scope);if(!row)return null;const data=JSON.parse(row.metadata_json);if(data.day!==day||data.account_scope!==scope)return null;return barsOf(data.bars)}
  _recordSnapshot(day,scope,bars){
    return this.store.transaction(()=>{
      const old=this._snapshot(day,scope);if(old)return old
      const now=this._now(),event_key='tieba-sign-followed:'+day+':'+scope
      this.store.appendJournalEvent({id:'journal:'+hash(event_key),event_key,event_type:'log',platform:'tieba',direction:'internal',status:'recorded',visibility:'owner',text:'',source_at:now,source_type:'native_tieba_sign_scheduler',metadata:{subtype:'followed_snapshot',day,account_scope:scope,bars,source:'official_followed_read'}})
      return bars
    })
  }
  _alreadyAttempted(bar,day,ownId){
    return this.store.db.prepare("SELECT id,status,metadata_json FROM actions WHERE platform='tieba' AND kind='tieba.sign' AND json_extract(target_json,'$.bar')=? AND (created_at>=? OR json_extract(metadata_json,'$.attempted_at')>=?) ORDER BY created_at,id").all(bar,day.midnight,day.midnight).some(row=>{
      const metadata=JSON.parse(row.metadata_json)
      return row.id!==ownId&&['draft','queued','leased','submitting'].includes(row.status)||['confirmed','unknown','blocked','cancelled'].includes(row.status)||metadata.network_started===true
    })
  }
  status(){const followed={followed_scope:'verified_returned_items',followed_limit:200,followed_complete:null,followed_truncated:null};let ready;try{ready=this._ready()}catch{return{enabled:false,closed:this.closed,inflight:!!this.flight,next_at:this.next_at,...followed,reason:'settings_unavailable',model_calls:0}}return{enabled:ready.allowed,closed:this.closed,inflight:!!this.flight,next_at:this.next_at,...followed,...(!ready.allowed?{reason:ready.reason}:{}),last_result:this.last_result,model_calls:0}}
  pulse(){
    if(this.flight)return this.flight
    const work=this._pulse().catch(()=>({status:'unavailable',reason:'native_sign_check_failed',model_calls:0})).then(value=>{this.last_result=value;return value});this.flight=work
    return work.finally(()=>{if(this.flight===work)this.flight=null})
  }
  async _pulse(){
    const now=this._now(),day=shanghaiTime(now),ready=this._ready()
    if(!ready.allowed)return{status:ready.reason,...(ready.not_before?{not_before:ready.not_before}:{}),model_calls:0}
    if(this.settings_revision!==ready.settings.revision){this.settings_revision=ready.settings.revision;this.next_at=0}
    if(this.next_at>now)return{status:'waiting',not_before:this.next_at,model_calls:0}
    if(this._replyWaiting())return{status:'reply_priority',model_calls:0}
    const settings=ready.settings,scope=this._scope(settings)
    this.next_at=Math.min(now+MINUTE,day.midnight+DAY)
    const controller=new AbortController();this.controller=controller
    let writeStarted=false
    const controls={now:this.now,signal:controller.signal,deadline_at:Math.min(now+30000,day.midnight+DAY),mark_started:()=>{writeStarted=true},assert_active:()=>{if(!this._ready().allowed||this._scope(this._settings())!==scope)throw new Error('自动签到原设置或账号已变化');if(!writeStarted&&this._replyWaiting())throw new Error('待回消息优先，签到尚未写入')}}
    try{return await withRunScope(controls,async()=>{
      let followed=this._snapshot(day.date,scope)
      if(!followed){
        const listed=await this.tieba.followed({pages:5,limit:200});assertRunActive()
        if(!isPlainObject(listed))throw new Error('关注列表无法核验')
        followed=this._recordSnapshot(day.date,scope,barsOf(listed.items))
        return{status:'followed_observed',bars:followed.length,model_calls:0}
      }
      const config=this._settings().config,selected=config.permissions?.sign_all_followed===true?followed:barsOf(config.bars??[]).filter(bar=>followed.includes(bar))
      for(const bar of selected){
        assertRunActive();if(this._replyWaiting())return{status:'reply_priority',model_calls:0}
        const key='native-daily-sign:'+day.date+':'+scope+':'+hash(bar),id=actionId(key)
        if(this._alreadyAttempted(bar,day,id))continue
        const existing=this.social.outbox.get(id,{internal:true})
        if(existing&&existing.status!=='queued'||existing?.not_before>this._now())continue
        const prepared=this.social.outbox.prepare({platform:'tieba',kind:'tieba.sign',target:{bar},body:'',idempotency_key:key,approval:'authorized'}),action=this.social.outbox.get(prepared.action.id,{internal:true})
        assertRunActive()
        const result=await this.social.dispatch(action.id,{authorization:action.approval_token,expected_digest:action.request_digest},controls)
        if(at(result.not_before)&&result.not_before>this.next_at)this.next_at=Math.min(result.not_before,day.midnight+DAY)
        return{status:result.status,action_id:action.id,day:day.date,model_calls:0}
      }
      this.next_at=day.midnight+DAY
      return{status:'done',day:day.date,selected_bars:selected.length,model_calls:0}
    })}finally{if(this.controller===controller)this.controller=null}
  }
  close(){this.closed=true;this.controller?.abort(new Error('自动签到已停止'));return{closed:true}}
}
