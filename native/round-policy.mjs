import {createHash} from 'node:crypto'
import {NativeStore} from './store.mjs'

const hash=value=>createHash('sha256').update(value).digest('hex')
const comment=action=>action.kind==='tieba.reply'||action.platform==='bilibili'&&(['bilibili.comment','bilibili.reply'].includes(action.kind)&&!['dm','live'].includes(action.target.channel)&&action.target.via!=='dm'||action.kind==='bilibili.share'&&action.target.via==='comment')

/** Per-browse-round limits. Incoming notifications and individual replies do not
 * become browse rounds; settings, manual rounds and autonomous rounds share it. */
export class NativeRoundPolicy{
  constructor({store,platform,now=Date.now,settings}={}){if(!(store instanceof NativeStore)||!['tieba','bilibili'].includes(platform)||typeof now!=='function')throw new Error('浏览轮次需要原生存储与平台');this.store=store;this.platform=platform;this.now=now;this.settings=settings??(()=>{const id=store.getDocument('settings')?.value.platform_document_ids?.[platform]??platform;return store.getDocument(id)?.value[platform]??{}})}
  _scope(scope){if(typeof scope!=='string'||scope.length>512||/[\0\r\n]/.test(scope))throw new Error('浏览轮次标识无效');return scope}
  _key(scope){return 'browse-round:'+this.platform+':'+hash(this._scope(scope))}
  active(scope=''){return !!scope&&!!this.store.db.prepare('SELECT id FROM journal_events WHERE event_key=?').get(this._key(scope))}
  limits(scope=''){const value=this.settings().limits??{},base={read:value.read_per_round??(this.platform==='tieba'?5:1),reply:value.reply_per_round??1,sub_reply:value.sub_reply_per_round??1},row=scope?this.store.db.prepare('SELECT metadata_json FROM journal_events WHERE event_key=?').get(this._key(scope)):null;return {...base,...(row?JSON.parse(row.metadata_json).limits??{}:{})}}
  begin(scope='',options={}){
    if(!scope)return;this._scope(scope)
    let limits=this.limits()
    if(options.limits!==undefined){const input=options.limits;if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!['read_per_round','reply_per_round','sub_reply_per_round'].includes(key)))throw new Error('本轮覆盖字段无效');for(const [key,value]of Object.entries(input))if(!Number.isSafeInteger(value)||value<(key==='read_per_round'?1:0)||value>30)throw new Error('本轮浏览须为1至30、评论须为0至30');const base=this.limits();limits={read:input.read_per_round??base.read,reply:input.reply_per_round??base.reply,sub_reply:input.sub_reply_per_round??base.sub_reply}}
    this.store.transaction(()=>{if(this.active(scope)){if(options.limits!==undefined&&JSON.stringify(this.limits(scope))!==JSON.stringify(limits))throw new Error('已经开始的同一轮不能改变覆盖数量');return}this.store.appendJournalEvent({event_key:this._key(scope),event_type:'log',platform:this.platform,direction:'internal',status:'recorded',visibility:'owner',text:'',source_at:this.now(),source_type:'native_round_policy',metadata:{subtype:'browse_round_started',round_id:scope,limits}})})
  }
  state(scope=''){this._scope(scope);const rows=scope?this.store.db.prepare("SELECT metadata_json FROM journal_events WHERE platform=? AND json_extract(metadata_json,'$.subtype') IN ('browse_item_reserved','browse_item_failed') AND json_extract(metadata_json,'$.round_id')=?").all(this.platform,scope).map(row=>JSON.parse(row.metadata_json)):[],ids=rows.filter(row=>row.subtype==='browse_item_reserved').map(row=>row.resource_id),failed_ids=rows.filter(row=>row.subtype==='browse_item_failed').map(row=>row.resource_id),limit=this.limits(scope).read;return {limit,ids,failed_ids,used:ids.filter(id=>!failed_ids.includes(id)).length,attempt_limit:this.platform==='bilibili'?limit*2:limit}}
  reserve(resource_id,scope=''){
    if(!this.active(scope))return
    this.store.transaction(()=>{const state=this.state(scope);if(state.failed_ids.includes(resource_id))throw Object.assign(new Error('本轮已失败的候选不重复读取，请使用其他候选'),{code:'round_failed_item'});if(state.ids.includes(resource_id))return;if(state.used>=state.limit)throw Object.assign(new Error('本轮浏览数量上限已达到，重复打开或翻页不重复计数'),{code:'round_read_limit'});if(state.ids.length>=state.attempt_limit)throw Object.assign(new Error('本轮候选尝试上限已达到，停止补位'),{code:'round_read_attempt_limit'});this.store.appendJournalEvent({event_key:this._key(scope)+':item:'+hash(resource_id),event_type:'log',platform:this.platform,direction:'internal',status:'recorded',visibility:'owner',text:'',source_at:this.now(),source_type:'native_round_policy',metadata:{subtype:'browse_item_reserved',round_id:scope,resource_id,confirmation:'open_attempt_not_full_view'}})})
  }
  recordFailed(resource_id,scope='',code='read_failed'){
    if(this.platform!=='bilibili'||!this.active(scope))return
    if(typeof code!=='string'||!/^\w{1,80}$/.test(code))throw Error('读取失败类型无效')
    this.store.transaction(()=>{const state=this.state(scope);if(!state.ids.includes(resource_id)||state.failed_ids.includes(resource_id))return;this.store.appendJournalEvent({event_key:this._key(scope)+':failed:'+hash(resource_id),event_type:'log',platform:this.platform,direction:'internal',status:'failed',visibility:'owner',text:'',source_at:this.now(),source_type:'native_round_policy',metadata:{subtype:'browse_item_failed',round_id:scope,resource_id,code,confirmation:'read_failed_not_viewed'}})})
  }
  checkApproval(action){
    const scope=action.metadata?.prepared_in?.round_id
    if(!comment(action)||!this.active(scope))return
    const occupied=this.store.db.prepare("SELECT id,platform,kind,status,target_json,metadata_json FROM actions WHERE platform=? AND id<>? AND json_extract(metadata_json,'$.prepared_in.round_id')=?").all(this.platform,action.id,scope)
      .filter(row=>comment({...row,target:JSON.parse(row.target_json)})&&(['queued','leased','submitting','confirmed','unknown'].includes(row.status)||JSON.parse(row.metadata_json).network_started===true))
    const limits=this.limits(scope)
    if(occupied.length>=limits.reply)throw new Error('本轮评论总上限已达到，普通评论和回复合计')
    if(this.platform==='tieba'&&(action.target.post_id||action.target.sub_reply_id)&&occupied.filter(row=>{const target=JSON.parse(row.target_json);return target.post_id||target.sub_reply_id}).length>=limits.sub_reply)throw new Error('本轮楼中楼评论上限已达到')
  }
}
