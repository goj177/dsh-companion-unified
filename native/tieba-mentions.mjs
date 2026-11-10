/** Official mobile message UI protocol, independently implemented from:
 * tb1.bdstatic.com/tb/mobile/message_4365fd7.js and list_loader_6fd1483.js.
 * Feed previews never establish authorship; exact posts are reread before queueing. */
import {TiebaError,tiebaId,decodeHtml,encodeSubRequest,parseSubPage} from './tieba-http.mjs'
import {tiebaReplyPaused} from './tieba-target.mjs'
import {packTiebaIncomingImageContext} from './tieba-vision.mjs'
const DAY=86400000
const content=(html,css)=>decodeHtml(new RegExp('<(?:span|div)\\b[^>]*class=["\'][^"\']*\\b'+css+'\\b[^"\']*["\'][^>]*>([\\s\\S]*?)<\\/(?:span|div)>','i').exec(html)?.[1]??'').trim()
function listedTime(text,now){
 const today=new Date(now+28800000).toISOString().slice(0,10),year=Number(today.slice(0,4));let day=today,hour,minute,m
 if((m=/^(\d{1,2}):(\d{2})$/.exec(text))){hour=m[1];minute=m[2]}
 else if((m=/^昨天\s*(\d{1,2}):(\d{2})$/.exec(text))){day=new Date(now+28800000-DAY).toISOString().slice(0,10);hour=m[1];minute=m[2]}
 else if((m=/^(?:(\d{4})[-年])?(\d{1,2})[-月](\d{1,2})(?:日)?\s+(\d{1,2}):(\d{2})$/.exec(text))){day=(m[1]??year)+'-'+m[2].padStart(2,'0')+'-'+m[3].padStart(2,'0');hour=m[4];minute=m[5]}
 else return null
 let at=Date.parse(day+'T'+String(hour).padStart(2,'0')+':'+minute+':00+08:00');if(!Number.isFinite(at))return null
 if(at>now+60000&&/^\d{1,2}:/.test(text))at-=DAY
 if(at>now+DAY&&/^\d{1,2}[-月]/.test(text))at=Date.parse((year-1)+day.slice(4)+'T'+String(hour).padStart(2,'0')+':'+minute+':00+08:00')
 return at<=now+60000?at:null
}
export function parseMentionNotifications(input,{page=1,now=Date.now()}={}){
 let value;try{value=typeof input==='string'?JSON.parse(input):input}catch{throw new TiebaError('官方艾特通知没有返回JSON','invalid_response')}
 const data=value?.data,p=data?.page;if(String(value?.no)!=='0'||typeof data?.content!=='string'||data.content.length>2*1024*1024||Number(p?.pn)!==page||![0,1,false,true].includes(p?.has_more))throw new TiebaError('官方艾特分页或内容无法核验','invalid_response')
 const items=[],seen=new Set()
 for(const match of data.content.matchAll(/<li\b[^>]*class=["'][^"']*\bhome_msg_item\b[^"']*["'][^>]*>([\s\S]*?)<\/li>/gi)){
  const html=match[1],href=/<a\b[^>]*href=["']([^"']+)["']/.exec(html)?.[1];let url
  try{url=new URL(decodeHtml(href??''),'https://tieba.baidu.com')}catch{throw new TiebaError('官方艾特链接无效','invalid_response')}
  if(url.origin!=='https://tieba.baidu.com'||url.username||url.password||url.pathname!=='/mo/q/m')throw new TiebaError('官方艾特链接不是原帖坐标','invalid_response')
  const thread_id=tiebaId(url.searchParams.get('kz')),reply_id=tiebaId(url.searchParams.get('sc')),forum_id=tiebaId(url.searchParams.get('fid')),bar=content(html,'home_msg_forum').replace(/^来自/,'').replace(/吧$/,''),source_time_raw=content(html,'home_msg_time')
  if(!bar||seen.has(reply_id))throw new TiebaError('官方艾特条目缺少吧名或出现重复坐标','invalid_response');seen.add(reply_id)
  items.push({thread_id,reply_id,forum_id,bar,text:content(html,'home_msg_reply'),actor_name:content(html,'home_msg_user'),title:content(html,'home_msg_title'),source_time_raw,source_at:listedTime(source_time_raw,now)})
  if(items.length>30)throw new TiebaError('官方艾特单页数量超过正常范围','invalid_response')
 }
 if(data.content.trim()&&!items.length&&!/暂无|没有.{0,12}(?:艾特|提到|消息)/.test(decodeHtml(data.content)))throw new TiebaError('官方艾特条目结构发生变化，未标记空收件箱','invalid_response')
 return{items,page,has_more:!!p.has_more}
}
export class NativeTiebaMentions{
 constructor(service){this.service=service;this.flight=null;this.health=null}
 get store(){return this.service.store}
 accountKey(){return this.service.replies.accountKey()}
 state(){const key=this.accountKey(),id='tieba-mentions-state-'+key,doc=this.store.getDocument(id);return{id,revision:doc?.revision??0,value:doc?.value??{platform:'tieba',account_key:key,baseline:false,watermark_at:0,seen_ids:[],last_poll_at:null}}}
 async readPage(page,cred){const r=await this.service._http('https://tieba.baidu.com/home/msg?msg_type=atme&is_ajax=1&pn='+page,{cred,max_bytes:4*1024*1024});if(!r.response.ok)throw new TiebaError('官方艾特页读取失败','read_failed');return parseMentionNotifications(r.text,{page,now:this.service._now()})}
 async locate(row,cred){
  const s=this.service;let found,is_sub_reply=false
  try{const p=await s._postPage(row.thread_id,0,cred,row.reply_id);if(p.thread_id!==row.thread_id||p.forum_id!==row.forum_id)throw new TiebaError('艾特楼所属主题或吧不一致','invalid_target');found=p.posts.find(p=>p.post_id===row.reply_id)}catch(error){if(!['invalid_response','read_failed'].includes(error.code))throw error}
  if(!found){const raw=await s._pb('/c/f/pb/floor?cmd=302002',encodeSubRequest({thread_id:row.thread_id,post_id:row.reply_id,bduss:cred.bduss}),cred),p=s._readPageEnvelope(raw.bytes,parseSubPage);if(p.thread_id!==row.thread_id||!p.parent_post_id||p.forum_id!==row.forum_id)throw new TiebaError('艾特子楼所属主题或吧不一致','invalid_target');found=p.posts.find(p=>p.post_id===row.reply_id);for(let n=1;!found&&n<=Math.min(10,p.page.total_page);n++){if(n===p.page.current_page)continue;found=(await s._subPage(row.thread_id,p.parent_post_id,n,cred)).posts.find(p=>p.post_id===row.reply_id)}is_sub_reply=true}
  if(!found?.author_uid||!found.text?.trim()||!Number.isSafeInteger(found.source_at)||found.source_at<=0)throw new TiebaError('真实艾特楼正文或作者不可定位，未改发主帖','target_not_resolved')
  return{...row,is_sub_reply,text:found.text,source_at:found.source_at,actor:{uid:found.author_uid,name:row.actor_name},quote_author:{uid:''},context:row.title}
 }
 async seed(){return this.poll({force:true,seed_only:true})}
 async poll({force=false,seed_only=false}={}){if(this.flight)return this.flight;this.flight=this._poll({force,seed_only});try{const result=await this.flight;this.health={...result,checked_at:this.service._now()};return result}catch(error){this.health={polled:false,queued:0,unresolved:1,reason:error.code??'check_failed',checked_at:this.service._now()};throw error}finally{this.flight=null}}
 async _poll({force,seed_only}){
  const s=this.service,cfg=s.replies.settings(),state=this.state(),now=s._now();s._assertRun()
  if(!force&&cfg.enabled!==true)return{enabled:false,polled:false,queued:0}
  if(!force&&state.value.last_poll_at&&now-state.value.last_poll_at<(cfg.poll_interval_ms??60000))return{polled:false,queued:0}
  const cred=await s._credential(),account=await s._self(cred),bound=this.store.listPlatformIdentities({namespace:'tieba',role:'account',entity_id:s._settings().value.account_entity_id,limit:10});s._assertRun()
  if(!bound.some(p=>p.platform_uid===account.uid))throw new TiebaError('艾特监测账号与绑定账号不同','account_mismatch')
  const first=await this.readPage(1,cred),seed=seed_only||!state.value.baseline&&cfg.seed_on_start!==false,seen=new Set(state.value.seen_ids),rows=new Map(first.items.map(r=>[r.reply_id,r]));let tail=first,pages=1,queued=0,already_handled=0,observed=0;const errors=[]
  const before=row=>seen.has(row.reply_id)||row.source_at!==null&&row.source_at+60000<=state.value.watermark_at
  if(seed){for(const row of first.items)seen.add(row.reply_id)}else{
   while(tail.has_more&&!tail.items.every(before)&&pages<(cfg.max_pages??10)){s._assertRun();tail=await this.readPage(++pages,cred);for(const row of tail.items)rows.set(row.reply_id,row)}
   for(const preview of [...rows.values()].reverse()){
    s._assertRun();if(seen.has(preview.reply_id))continue
    if(before(preview)||s.replies.existing(preview)||this.store.db.prepare("SELECT id FROM actions WHERE platform='tieba' AND kind='activity.incoming' AND json_extract(metadata_json,'$.execution')='model' AND json_extract(target_json,'$.thread_id')=? AND json_extract(target_json,'$.source_message_id')=? LIMIT 1").get(preview.thread_id,preview.reply_id)){seen.add(preview.reply_id);already_handled++;continue}
    try{const row=await this.locate(preview,cred);s._assertRun();if(row.source_at<state.value.watermark_at||row.actor.uid===account.uid){seen.add(row.reply_id);already_handled++;continue}const{target,source_context,public_image_sources}=await s.replies.resolve(row,cred,{self_uid:account.uid});s._assertRun();if(!source_context.mentioned_self){if(source_context.address_kind==='third_party'){seen.add(row.reply_id);already_handled++;continue}throw new TiebaError('原楼没有核实提及当前账号UID','target_not_resolved')}
     if(tiebaReplyPaused(s._settings().config,row.actor.uid,s._now(),row.source_at)||s.participation?.paused({platform:'tieba',actor_uid:row.actor.uid,conversation_id:'thread:'+row.thread_id+':'+target.post_id,source_at:row.source_at,source_message_id:row.reply_id})){seen.add(row.reply_id);already_handled++;continue}
     if(this.accountKey()!==state.value.account_key||s._settings().value.credential_ref!==cred.secret_ref)throw new TiebaError('艾特监测账号已变化','account_changed')
     const conversation_id='thread:'+row.thread_id+':'+target.post_id;s._rememberForum(row.thread_id,row.bar);observed++
     const evidence=s.memoryRuntime?.ingestHumanMessage?await s.memoryRuntime.ingestHumanMessage({platform:'tieba',conversation_id,actor_uid:row.actor.uid,display_name:row.actor.name,text:row.text,source_message_id:'reply:'+row.reply_id,source_at:row.source_at,visibility:'public'}):s.replies.memory.recordEvidence({platform:'tieba',conversation_id,actor_uid:row.actor.uid,direction:'in',kind:'message',text:row.text,source_message_id:'reply:'+row.reply_id,source_at:row.source_at,source_type:'user',visibility:'public',source:{kind:'user',explicit:false,pipeline:'native-tieba-mentions'}})
     s._assertRun();const result=s.activity.enqueueIncoming({platform:'tieba',kind:'incoming',trigger:force?'manual':'incoming',human:true,heavy:false,idempotency_key:'tieba:replies:'+this.accountKey()+':'+row.reply_id,source_evidence_id:evidence.id,target:{...target,channel:'comment',conversation_id,actor_uid:row.actor.uid,source_message_id:row.reply_id},body:row.text},{public_context:packTiebaIncomingImageContext({source_context,quoted_context:{text:row.context,author_uid:null,authority:'quoted_public_source'},notification_kind:'mention'},public_image_sources)});if(!result.duplicate)queued++;seen.add(row.reply_id)
    }catch(error){s._assertRun();errors.push({reply_id:preview.reply_id,code:error.code??'queue_failed'});if(['verification_required','risk_pause','authentication_required','account_changed'].includes(error.code))break}
   }
  }
  s._assertRun();if(this.accountKey()!==state.value.account_key||s._settings().value.credential_ref!==cred.secret_ref)throw new TiebaError('艾特监测期间账号已变化','account_changed')
  const current=this.state();this.store.putDocument({id:state.id,type:'tieba_reply_inbox_state',expected_revision:current.revision,value:{...current.value,baseline:true,watermark_at:seed?Math.floor(now/1000)*1000:state.value.watermark_at,seen_ids:[...seen].slice(-2000),last_poll_at:s._now()}})
  return{polled:true,seeded:seed,queued,observed,already_handled,pages,scan_complete:!tail.has_more||tail.items.every(before),unresolved:errors.length,errors,model_calls:0}
 }
}
