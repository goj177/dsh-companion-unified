/** Public reply notifications. Protocol reference: lumina37/aiotieba get_replys (Unlicense). */
import {createHash} from 'node:crypto'
import {NativeMemory} from './memory.mjs'
import {TiebaError,tiebaId,pbFields,pbInt,pbBytes,pbString,encodeSubRequest,encodePageRequest,parseSubPage,parsePostPage} from './tieba-http.mjs'
import {redactText} from './memory-rules.mjs'

const hash=value=>createHash('sha256').update(value).digest('hex')
const str=bytes=>{try{return new TextDecoder('utf-8',{fatal:true}).decode(bytes)}catch{throw new TiebaError('回复通知文字编码无法核验','invalid_response')}}
const fields=bytes=>{const rows=pbFields(bytes);return {rows,int:n=>rows.find(x=>x.field===n)?.value??0n,text:n=>{const b=rows.find(x=>x.field===n)?.bytes;return b?str(b):''},bytes:n=>rows.find(x=>x.field===n)?.bytes}}
const safe=(value,max=16000)=>redactText(String(value??'').slice(0,max))
const user=bytes=>{const x=fields(bytes??Buffer.alloc(0));return {uid:x.int(2).toString(),name:safe(x.text(4)||x.text(3),240)}}
export function encodeReplyNotifications({page=1,bduss=''}){return pbBytes(1,Buffer.concat([pbInt(1,page),pbBytes(3,Buffer.concat([pbInt(1,2),pbString(2,'22.12.1.0'),pbString(10,bduss)]))]))}
export function parseReplyNotifications(bytes){
  const top=fields(bytes),error=top.bytes(1),data=top.bytes(2)
  if(error){const code=fields(error).int(1);if(code!==0n)throw new TiebaError('官方评论回复通知读取被拒绝','read_failed',{server_code:Number(code)})}
  if(!data)throw new TiebaError('官方评论回复通知数据缺失','invalid_response')
  const body=fields(data),pageBytes=body.bytes(1);if(!pageBytes)throw new TiebaError('评论回复通知缺少分页信息','invalid_response')
  const page=fields(pageBytes),items=[]
  for(const row of body.rows.filter(x=>x.field===2&&x.bytes)){
    const x=fields(row.bytes),fragments=x.rows.filter(x=>x.field===28&&x.bytes).map(part=>pbFields(part.bytes).filter(c=>c.field===1&&c.bytes).map(c=>fields(c.bytes).text(2)).join(''))
    const seconds=Number(x.int(3));if(!Number.isSafeInteger(seconds)||seconds<=0)throw new TiebaError('回复通知时间无法核验','invalid_response')
    items.push({thread_id:tiebaId(x.int(1).toString()),reply_id:tiebaId(x.int(2).toString()),source_at:seconds*1000,bar:safe(x.text(5),160),text:safe(fragments.at(-1)||x.text(6)),is_sub_reply:x.int(7)!==0n,quote_post_id:x.int(14).toString(),actor:user(x.bytes(9)),quote_author:user(x.bytes(15)),context:safe(fragments.slice(0,-1).join('\n'),1600)})
  }
  const current_page=Number(page.int(3));if(!Number.isSafeInteger(current_page)||current_page<1)throw new TiebaError('回复通知页码无法核验','invalid_response')
  return {items,page:current_page,has_more:page.int(6)!==0n}
}

export class NativeTiebaReplies{
  constructor(service){this.service=service;this.memory=service.memory??new NativeMemory(service.store,{now:service.now});this.flight=null;this.health=null}
  get store(){return this.service.store}
  settings(){return this.service._settings().config.comment_inbox??{}}
  accountKey(){const s=this.service._settings().value;return hash(s.account_entity_id??s.credential_ref??'unbound')}
  state(){const key=this.accountKey(),id='tieba-replies-state-'+key,doc=this.store.getDocument(id);return {id,revision:doc?.revision??0,value:doc?.value??{platform:'tieba',account_key:key,baseline:false,watermark_at:0,seen_ids:[],last_poll_at:null}}}
  async readPage(page,cred){const s=this.service,r=await s._pb('/c/u/feed/replyme?cmd=303007',encodeReplyNotifications({page,bduss:cred.bduss}),cred),data=s._readPageEnvelope(r.bytes,parseReplyNotifications);if(data.page!==page)throw new TiebaError('官方回复通知页码没有前进','invalid_response');return data}
  async resolve(row,cred){
    const s=this.service,target={bar:row.bar,thread_id:row.thread_id,post_id:row.reply_id}
    if(!row.bar||row.actor.uid==='0'||!row.text.trim())throw new TiebaError('回复通知缺少真实作者、吧名或正文','target_not_resolved')
    if(row.is_sub_reply){
      // The feed quote can point to another child. Ask the official floor API
      // for this actual child and retain its returned parent, never guess it.
      const raw=await s._pb('/c/f/pb/floor?cmd=302002',encodeSubRequest({thread_id:row.thread_id,post_id:row.reply_id,bduss:cred.bduss}),cred),page=s._readPageEnvelope(raw.bytes,parseSubPage)
      if(page.thread_id!==row.thread_id||!page.parent_post_id)throw new TiebaError('通知楼中楼父坐标无法核验','target_not_resolved')
      let found=page.posts.find(x=>x.post_id===row.reply_id),foundPage=page.page.current_page
      for(let n=1;!found&&n<=Math.min(page.page.total_page,10);n++){if(n===page.page.current_page)continue;const next=await s._subPage(row.thread_id,page.parent_post_id,n,cred);found=next.posts.find(x=>x.post_id===row.reply_id);if(found)foundPage=n}
      if(!found||found.author_uid!==row.actor.uid)throw new TiebaError('原子评论已不可定位，不改发新楼','target_not_resolved')
      s._rememberLocations('sub',row.thread_id+':'+page.parent_post_id,[{sub_reply_id:row.reply_id}],'sub_reply_id',foundPage)
      Object.assign(target,{post_id:page.parent_post_id,sub_reply_id:row.reply_id,reply_uid:row.actor.uid})
    }
    // The submitter rereads both parent and child. Cache the server-returned
    // parent page too, so a reply on page 2+ cannot accidentally look on page 1.
    const raw=await s._pb('/c/f/pb/page?cmd=302001',encodePageRequest({thread_id:row.thread_id,post_id:target.post_id,page:0,sort:0,bduss:cred.bduss}),cred),page=s._readPageEnvelope(raw.bytes,parsePostPage),found=page.posts.find(x=>x.post_id===target.post_id)
    if(!found||!found.author_uid||!row.is_sub_reply&&found.author_uid!==row.actor.uid)throw new TiebaError('原楼层已不可定位，不改发新楼','target_not_resolved')
    s._rememberLocations('post',row.thread_id,[found],'post_id',page.page.current_page)
    return target
  }
  existing(row){return this.store.db.prepare("SELECT id,status FROM actions WHERE platform='tieba' AND kind='tieba.reply' AND status IN ('confirmed','queued','leased','submitting','submitted','unknown') AND json_extract(target_json,'$.thread_id')=? AND (json_extract(target_json,'$.sub_reply_id')=? OR (json_extract(target_json,'$.post_id')=? AND json_extract(target_json,'$.sub_reply_id') IS NULL)) LIMIT 1").get(row.thread_id,row.reply_id,row.reply_id)}
  async poll({force=false}={}){if(this.flight)return this.flight;const work=this._poll({force});this.flight=work;try{const result=await work;this.health={...result,checked_at:this.service._now()};return result}catch(error){this.health={polled:false,queued:0,unresolved:1,reason:typeof error.code==='string'?error.code:'check_failed',checked_at:this.service._now(),model_calls:0};throw error}finally{this.flight=null}}
  async _poll({force}){
    const s=this.service,cfg=this.settings(),state=this.state(),now=s._now()
    if(!force&&cfg.enabled!==true)return {enabled:false,polled:false,queued:0,model_calls:0}
    if(!force&&state.value.last_poll_at&&now-state.value.last_poll_at<(cfg.poll_interval_ms??60000))return {polled:false,queued:0,model_calls:0}
    const cred=await s._credential(),account=await s._self(cred),bound=this.store.listPlatformIdentities({namespace:'tieba',role:'account',entity_id:s._settings().value.account_entity_id,limit:10})
    if(!bound.some(row=>row.platform_uid===account.uid))throw new TiebaError('评论监测登录账号与绑定身份不一致','account_mismatch')
    if(!s.activity?.enqueueIncoming)throw new TiebaError('评论回复统一队列尚未就绪','queue_unavailable')
    const first=await this.readPage(1,cred),seed=!state.value.baseline&&cfg.seed_on_start!==false,seen=new Set(state.value.seen_ids),rows=new Map(first.items.map(x=>[x.reply_id,x]));let pages=1,complete=!first.has_more,tail=first
    const before=row=>row.source_at<state.value.watermark_at||row.source_at===state.value.watermark_at&&seen.has(row.reply_id)
    if(seed){for(const row of first.items)seen.add(row.reply_id);complete=true}
    else while(tail.has_more&&!tail.items.every(before)&&pages<(cfg.max_pages??10)){tail=await this.readPage(++pages,cred);for(const row of tail.items)rows.set(row.reply_id,row);complete=!tail.has_more}
    if(!seed&&tail.items.length&&tail.items.every(before))complete=true
    const errors=[];let queued=0,observed=0,already_handled=0
    if(!seed)for(const row of [...rows.values()].sort((a,b)=>a.source_at-b.source_at||a.reply_id.localeCompare(b.reply_id))){
      if(seen.has(row.reply_id)||row.source_at<state.value.watermark_at)continue
      if(row.actor.uid===account.uid||this.existing(row)){seen.add(row.reply_id);already_handled++;continue}
      observed++
      try{
        const target=await this.resolve(row,cred),conversation_id='thread:'+row.thread_id+':'+target.post_id
        let evidence
        if(s.memoryRuntime?.ingestHumanMessage)evidence=await s.memoryRuntime.ingestHumanMessage({platform:'tieba',conversation_id,actor_uid:row.actor.uid,display_name:row.actor.name,text:row.text,source_message_id:'reply:'+row.reply_id,source_at:row.source_at,visibility:'public'})
        else{const prior=this.store.getPlatformIdentity('tieba',row.actor.uid),identity=this.store.upsertPlatformIdentity({namespace:'tieba',platform_uid:row.actor.uid,...(prior?{entity_id:prior.entity_id,role:prior.role}:{role:'person'}),display_name:row.actor.name});evidence=this.memory.recordEvidence({platform:'tieba',conversation_id,actor_uid:row.actor.uid,actor_entity_id:identity.entity_id,direction:'in',kind:'message',text:row.text,source_message_id:'reply:'+row.reply_id,source_at:row.source_at,source_type:'user',visibility:'public',source:{kind:'user',explicit:false,pipeline:'native-tieba-replies'}})}
        const delivery=s.activity.enqueueIncoming({platform:'tieba',kind:'incoming',trigger:force?'manual':'incoming',human:true,heavy:false,idempotency_key:'tieba:replies:'+this.accountKey()+':'+row.reply_id,source_evidence_id:evidence.id,target:{...target,channel:'comment',conversation_id,actor_uid:row.actor.uid,source_message_id:row.reply_id},body:row.text},{public_context:row.context})
        if(!delivery.duplicate)queued++;seen.add(row.reply_id)
      }catch(error){errors.push({reply_id:row.reply_id,code:typeof error.code==='string'?error.code:'queue_failed'});if(['verification_required','risk_pause','authentication_required','account_changed'].includes(error.code))break}
    }
    if(this.accountKey()!==state.value.account_key||s._settings().value.credential_ref!==cred.secret_ref)throw new TiebaError('评论监测期间账号发生变化，检查点保持原样','account_changed')
    const watermark_at=seed?Math.max(0,...first.items.map(x=>x.source_at),first.items.length?0:now):complete&&!errors.length?Math.max(state.value.watermark_at,...[...rows.values()].map(x=>x.source_at)):state.value.watermark_at
    const current=this.state();this.store.putDocument({id:state.id,type:'tieba_reply_inbox_state',expected_revision:current.revision,value:{...current.value,baseline:true,seen_ids:[...seen].slice(-2000),watermark_at,last_poll_at:s._now()}})
    return {polled:true,seeded:seed,observed,queued,already_handled,pages,scan_complete:complete,unresolved:errors.length,errors,model_calls:0}
  }
}
