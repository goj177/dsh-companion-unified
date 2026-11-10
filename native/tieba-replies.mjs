/** Public reply notifications. Protocol reference: lumina37/aiotieba get_replys (Unlicense). */
import {createHash} from 'node:crypto'
import {NativeMemory} from './memory.mjs'
import {TiebaError,tiebaId,pbFields,pbInt,pbBytes,pbString,encodeSubRequest,encodePageRequest,parseSubPage,parsePostPage,parseTiebaContent} from './tieba-http.mjs'
import {parseTiebaReadText} from './tieba-content.mjs'
import {redactText} from './memory-rules.mjs'
import {publicSourceContext,explicitSourceReplyUid} from './source-context.mjs'
import {tiebaReplyPaused} from './tieba-target.mjs'
import {packTiebaIncomingImageContext} from './tieba-vision.mjs'
import {lowInformationTiebaReply,tiebaContextRecord,publicTiebaPeerContext} from './tieba-incoming.mjs'

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
    const x=fields(row.bytes),fragments=x.rows.filter(x=>x.field===28&&x.bytes).map(part=>parseTiebaContent(pbFields(part.bytes).filter(c=>c.field===1&&c.bytes).map(c=>c.bytes))),current=fragments.at(-1)?.text?fragments.at(-1):parseTiebaReadText(x.text(6))
    const seconds=Number(x.int(3));if(!Number.isSafeInteger(seconds)||seconds<=0)throw new TiebaError('回复通知时间无法核验','invalid_response')
    items.push({thread_id:tiebaId(x.int(1).toString()),reply_id:tiebaId(x.int(2).toString()),source_at:seconds*1000,bar:safe(x.text(5),160),text:safe(current.text),content_parts:current.content_parts,is_sub_reply:x.int(7)!==0n,quote_post_id:x.int(14).toString(),actor:user(x.bytes(9)),quote_author:user(x.bytes(15)),context:safe(fragments.slice(0,-1).map(part=>part.text).join('\n'),1600),context_content_parts:fragments.slice(0,-1).map((part,index)=>({fragment:index,content_parts:part.content_parts}))})
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
  async resolve(row,cred,{self_uid}={}){
    const s=this.service,target={bar:row.bar,thread_id:row.thread_id,post_id:row.reply_id},children=[];let current=null
    if(!row.bar||row.actor.uid==='0'||!row.text.trim())throw new TiebaError('回复通知缺少真实作者、吧名或正文','target_not_resolved')
    if(row.is_sub_reply){
      // The feed quote can point to another child. Ask the official floor API
      // for this actual child and retain its returned parent, never guess it.
      const raw=await s._pb('/c/f/pb/floor?cmd=302002',encodeSubRequest({thread_id:row.thread_id,post_id:row.reply_id,bduss:cred.bduss}),cred),page=s._readPageEnvelope(raw.bytes,parseSubPage)
      if(page.thread_id!==row.thread_id||!page.parent_post_id)throw new TiebaError('通知楼中楼父坐标无法核验','target_not_resolved')
      children.push(...page.posts)
      let found=page.posts.find(x=>x.post_id===row.reply_id),foundPage=page.page.current_page
      for(let n=1;!found&&n<=Math.min(page.page.total_page,10);n++){if(n===page.page.current_page)continue;const next=await s._subPage(row.thread_id,page.parent_post_id,n,cred);children.push(...next.posts);found=next.posts.find(x=>x.post_id===row.reply_id);if(found)foundPage=n}
      if(!found||found.author_uid!==row.actor.uid)throw new TiebaError('原子评论已不可定位，不改发新楼','target_not_resolved')
      current=found
      s._rememberLocations('sub',row.thread_id+':'+page.parent_post_id,[{sub_reply_id:row.reply_id}],'sub_reply_id',foundPage)
      Object.assign(target,{post_id:page.parent_post_id,sub_reply_id:row.reply_id,reply_uid:row.actor.uid})
    }
    // The submitter rereads both parent and child. Cache the server-returned
    // parent page too, so a reply on page 2+ cannot accidentally look on page 1.
    const page=await s._postPage(row.thread_id,0,cred,target.post_id),found=page.posts.find(x=>x.post_id===target.post_id)
    if(!found||!found.author_uid||!row.is_sub_reply&&found.author_uid!==row.actor.uid)throw new TiebaError('原楼层已不可定位，不改发新楼','target_not_resolved')
    s._rememberLocations('post',row.thread_id,[found],'post_id',page.page.current_page)
    current??=found
    const mentions=current.mention_uids??[],reply_to_uid=explicitSourceReplyUid(current)||(/^[1-9]\d*$/.test(row.quote_author?.uid??'')?row.quote_author.uid:'')||(row.is_sub_reply?found.author_uid:''),parent_author_uid=row.is_sub_reply?found.author_uid:'',knownTopic=page.posts.find(post=>post.floor===1)
    let topic_author_uid=knownTopic?.author_uid??''
    if(!row.is_sub_reply&&self_uid&&reply_to_uid!==self_uid&&!mentions.includes(self_uid)&&!topic_author_uid){const first=await s._postPage(row.thread_id,1,cred);topic_author_uid=first.posts.find(post=>post.floor===1)?.author_uid??''}
    const text=safe(current.text)||row.text,source_context=publicSourceContext({platform:'tieba',source_kind:row.is_sub_reply?'comment_reply':'topic_comment',self_uid,topic_author_uid,author_uid:row.actor.uid,parent_author_uid,reply_to_uid,mentioned_uids:mentions,text}),records=[]
    for(const candidate of [found,...children.filter(item=>item.post_id===row.quote_post_id&&item.author_uid===row.quote_author?.uid)]){
      if(candidate.post_id===row.reply_id||records.some(item=>item.source_id===candidate.post_id))continue
      const record=tiebaContextRecord(candidate,{self_uid,topic_author_uid});if(record)records.push(record)
    }
    if(/^[1-9]\d*$/.test(self_uid??'')&&row.quote_author?.uid===self_uid&&/^[1-9]\d*$/.test(row.quote_post_id??'')&&!records.some(item=>item.source_id===row.quote_post_id)){
      const prior=this.store.db.prepare("SELECT body,body_digest,target_json,receipt_json FROM actions WHERE platform='tieba' AND kind='tieba.reply' AND status='confirmed' AND json_extract(receipt_json,'$.server_id')=? ORDER BY confirmed_at DESC LIMIT 1").get(row.quote_post_id),receipt=prior?JSON.parse(prior.receipt_json):null
      if(prior&&receipt.source==='server_receipt'&&receipt.accepted===true&&receipt.readback?.author_uid===self_uid&&JSON.parse(prior.target_json).thread_id===row.thread_id&&hash(prior.body)===prior.body_digest){const record=tiebaContextRecord({post_id:row.quote_post_id,author_uid:self_uid,text:prior.body},{self_uid,topic_author_uid,verification:'confirmed_local_receipt'});if(record)records.push(record)}
    }
    const public_image_sources=s.imageSources?.(current,{thread_id:row.thread_id,...(row.is_sub_reply?{post_id:target.post_id}:{})})??[]
    if(public_image_sources.some(source=>source.source_message_id!==row.reply_id||source.author_uid!==row.actor.uid))throw new TiebaError('图片原楼ID或作者与已核验通知不一致','target_not_resolved')
    return {target,text,source_context,speaker:{uid:row.actor.uid,name:row.actor.name,role:'counterpart'},quoted_context:{records:records.slice(0,2),authority:'quoted_public_source'},public_image_sources}
  }
  existing(row){return this.store.db.prepare("SELECT id,status FROM actions WHERE platform='tieba' AND kind='tieba.reply' AND status IN ('confirmed','queued','leased','submitting','submitted','unknown') AND json_extract(target_json,'$.thread_id')=? AND (json_extract(target_json,'$.sub_reply_id')=? OR (json_extract(target_json,'$.post_id')=? AND json_extract(target_json,'$.sub_reply_id') IS NULL)) LIMIT 1").get(row.thread_id,row.reply_id,row.reply_id)}
  async poll({force=false}={}){if(this.flight)return this.flight;const work=this._poll({force});this.flight=work;try{const result=await work;this.health={...result,checked_at:this.service._now()};return result}catch(error){this.health={polled:false,queued:0,unresolved:1,reason:typeof error.code==='string'?error.code:'check_failed',checked_at:this.service._now(),model_calls:0};throw error}finally{this.flight=null}}
  async _poll({force}){
    const s=this.service;s._assertRun?.();const cfg=this.settings(),state=this.state(),now=s._now()
    if(!force&&cfg.enabled!==true)return {enabled:false,polled:false,queued:0,model_calls:0}
    if(!force&&state.value.last_poll_at&&now-state.value.last_poll_at<(cfg.poll_interval_ms??60000))return {polled:false,queued:0,model_calls:0}
    const cred=await s._credential(),account=await s._self(cred),bound=this.store.listPlatformIdentities({namespace:'tieba',role:'account',entity_id:s._settings().value.account_entity_id,limit:10})
    s._assertRun?.()
    if(!bound.some(row=>row.platform_uid===account.uid))throw new TiebaError('评论监测登录账号与绑定身份不一致','account_mismatch')
    if(!s.activity?.enqueueIncoming)throw new TiebaError('评论回复统一队列尚未就绪','queue_unavailable')
    const first=await this.readPage(1,cred),seed=!state.value.baseline&&cfg.seed_on_start!==false,seen=new Set(state.value.seen_ids),rows=new Map(first.items.map(x=>[x.reply_id,x]));let pages=1,complete=!first.has_more,tail=first
    s._assertRun?.()
    const before=row=>row.source_at<state.value.watermark_at||row.source_at===state.value.watermark_at&&seen.has(row.reply_id)
    if(seed){for(const row of first.items)seen.add(row.reply_id);complete=true}
    else while(tail.has_more&&!tail.items.every(before)&&pages<(cfg.max_pages??10)){s._assertRun?.();tail=await this.readPage(++pages,cred);s._assertRun?.();for(const row of tail.items)rows.set(row.reply_id,row);complete=!tail.has_more}
    if(!seed&&tail.items.length&&tail.items.every(before))complete=true
    const errors=[];let queued=0,observed=0,already_handled=0,filtered_low_information=0
    if(!seed)for(const row of [...rows.values()].sort((a,b)=>a.source_at-b.source_at||a.reply_id.localeCompare(b.reply_id))){
      s._assertRun?.()
      if(seen.has(row.reply_id)||row.source_at<state.value.watermark_at)continue
      if(row.actor.uid===account.uid||this.existing(row)){seen.add(row.reply_id);already_handled++;continue}
      observed++
      try{
        if(lowInformationTiebaReply(row)){
          const prior=row.quote_author?.uid===account.uid&&/^[1-9]\d*$/.test(row.quote_post_id)?this.store.db.prepare("SELECT body,body_digest,receipt_json FROM actions WHERE platform='tieba' AND kind='tieba.reply' AND status='confirmed' AND json_extract(receipt_json,'$.server_id')=? ORDER BY confirmed_at DESC LIMIT 1").get(row.quote_post_id):null,receipt=prior?JSON.parse(prior.receipt_json):null,previous_text=prior&&receipt.source==='server_receipt'&&receipt.accepted===true&&(receipt.code===undefined||receipt.code===0)&&hash(prior.body)===prior.body_digest?prior.body:''
          if(lowInformationTiebaReply(row,{previous_text})){
            this.store.appendJournalEvent({event_key:'tieba:low-information:'+this.accountKey()+':'+row.reply_id,event_type:'log',platform:'tieba',actor_uid:row.actor.uid,direction:'internal',status:'recorded',visibility:'owner',text:safe(row.text,240),source_at:row.source_at,source_type:'native_tieba_replies',metadata:{subtype:'low_information_skipped',thread_id:row.thread_id,source_message_id:row.reply_id,reason:'仅有水经验或无实际内容的短反应',model_calls:0,no_publication:true}})
            seen.add(row.reply_id);filtered_low_information++;continue
          }
        }
        const {target,source_context,public_image_sources,speaker,quoted_context,text= row.text}=await this.resolve(row,cred,{self_uid:account.uid}),conversation_id='thread:'+row.thread_id+':'+target.post_id
        s._assertRun?.()
        if(tiebaReplyPaused(s._settings().config,row.actor.uid,s._now(),row.source_at)||s.participation?.paused({platform:'tieba',actor_uid:row.actor.uid,conversation_id:'thread:'+row.thread_id+':'+target.post_id,source_at:row.source_at,source_message_id:row.reply_id})){seen.add(row.reply_id);already_handled++;continue}
        if(!source_context.addressed_to_self){if(source_context.address_kind==='third_party'){seen.add(row.reply_id);already_handled++;continue}throw new TiebaError('通知未确认是回复当前账号或提及当前UID，保留为第三方上下文','target_not_resolved')}
        s._rememberForum?.(row.thread_id,row.bar)
        let evidence
        if(s.memoryRuntime?.ingestHumanMessage)evidence=await s.memoryRuntime.ingestHumanMessage({platform:'tieba',conversation_id,actor_uid:row.actor.uid,display_name:row.actor.name,text,source_message_id:'reply:'+row.reply_id,source_at:row.source_at,visibility:'public'})
        else{const prior=this.store.getPlatformIdentity('tieba',row.actor.uid),identity=this.store.upsertPlatformIdentity({namespace:'tieba',platform_uid:row.actor.uid,...(prior?{entity_id:prior.entity_id,role:prior.role}:{role:'person'}),display_name:row.actor.name});evidence=this.memory.recordEvidence({platform:'tieba',conversation_id,actor_uid:row.actor.uid,actor_entity_id:identity.entity_id,direction:'in',kind:'message',text,source_message_id:'reply:'+row.reply_id,source_at:row.source_at,source_type:'user',visibility:'public',source:{kind:'user',explicit:false,pipeline:'native-tieba-replies'}})}
        s._assertRun?.()
        const peer_context=publicTiebaPeerContext(this.store,{actor_uid:row.actor.uid,self_uid:account.uid,conversation_id,exclude_evidence_id:evidence.id})
        const delivery=s.activity.enqueueIncoming({platform:'tieba',kind:'incoming',trigger:force?'manual':'incoming',human:true,heavy:false,idempotency_key:'tieba:replies:'+this.accountKey()+':'+row.reply_id,source_evidence_id:evidence.id,target:{...target,channel:'comment',conversation_id,actor_uid:row.actor.uid,source_message_id:row.reply_id},body:text},{public_context:packTiebaIncomingImageContext({source_context,...(speaker?{speaker}:{}),...(quoted_context?{quoted_context}:{}),...(peer_context?{peer_context}:{})},public_image_sources)})
        s._assertRun?.()
        if(!delivery.duplicate)queued++;seen.add(row.reply_id)
      }catch(error){s._assertRun?.();errors.push({reply_id:row.reply_id,code:typeof error.code==='string'?error.code:'queue_failed'});if(['verification_required','risk_pause','authentication_required','account_changed'].includes(error.code))break}
    }
    s._assertRun?.()
    if(this.accountKey()!==state.value.account_key||s._settings().value.credential_ref!==cred.secret_ref)throw new TiebaError('评论监测期间账号发生变化，检查点保持原样','account_changed')
    const watermark_at=seed?Math.max(0,...first.items.map(x=>x.source_at),first.items.length?0:now):complete&&!errors.length?Math.max(state.value.watermark_at,...[...rows.values()].map(x=>x.source_at)):state.value.watermark_at
    const current=this.state();this.store.putDocument({id:state.id,type:'tieba_reply_inbox_state',expected_revision:current.revision,value:{...current.value,baseline:true,seen_ids:[...seen].slice(-2000),watermark_at,last_poll_at:s._now()}})
    return {polled:true,seeded:seed,observed,queued,already_handled,filtered_low_information,pages,scan_complete:complete,unresolved:errors.length,errors,model_calls:0}
  }
}
