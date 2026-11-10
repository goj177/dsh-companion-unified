/** Owner-dashboard read model. Never attach this output to agent/tool status. */
import {createHash} from 'node:crypto'
import {NativeStore} from './store.mjs'
import {redactText} from './memory-rules.mjs'
const hash=x=>createHash('sha256').update(x).digest('hex')
const parse=x=>{try{return JSON.parse(x??'{}')}catch{return {}}}
const clean=(x,max=16000)=>typeof x==='string'?redactText(x.slice(0,64000).toWellFormed()).slice(0,max).toWellFormed():''
const identifier=x=>typeof x==='string'&&/^[1-9]\d{0,30}$/.test(x)?x:''
const names={tieba:'贴吧',bilibili:'B站',qq:'QQ',harness:'本机',system:'系统'}
const placeholders=n=>Array(n).fill('?').join(',')
const isComment=a=>['tieba.reply','bilibili.comment','bilibili.reply'].includes(a.kind)
function actionReport(row){
 const target=parse(row.target_json),receipt=parse(row.receipt_json),meta=parse(row.metadata_json),body=clean(row.body),id=identifier(receipt.server_id),tid=identifier(target.thread_id??receipt.thread_id??receipt.readback?.thread_id),parent=identifier(target.post_id),floor=receipt.readback?.floor
 let label=({'tieba.message':'回复私信','tieba.post':'发布主题','tieba.reply':parent?'回复楼中楼':'普通回帖','tieba.sign':'签到','tieba.follow':'关注','bilibili.dynamic':'发布动态','bilibili.comment':'发表评论','bilibili.reply':'回复评论','bilibili.like':'点赞','bilibili.coin':'投币','bilibili.share':'分享内容','qq.send':'发送消息','qq.mute':'禁言成员','qq.unmute':'解除禁言','qq.profile':'更新自身资料'})[row.kind]??'平台操作',destination='',url=''
 if(row.kind==='tieba.message')destination='贴吧私信 · '+clean(target.recipient_uid,100)
 if(row.platform==='tieba'&&row.kind!=='tieba.message'){destination=(clean(target.bar,80)?clean(target.bar,80).replace(/吧$/,'')+'吧':'贴吧')+(tid?' · 帖子'+tid:'');if(parent)destination+=' · 回复评论'+parent+'下的楼中楼';else if(Number.isSafeInteger(floor)&&floor>0)destination+=' · 第'+floor+'楼';if(tid)url='https://tieba.baidu.com/p/'+tid}
 if(row.kind==='qq.mute'&&Number.isSafeInteger(target.duration_seconds)&&target.duration_seconds>0)label+=' '+Math.ceil(target.duration_seconds/60)+'分钟'
 if(row.platform==='bilibili'){
  if(target.channel==='dm'||target.via==='dm')label='回复私信';if(target.channel==='live')label='发送直播弹幕'
  if(row.kind==='bilibili.dynamic'){destination='B站动态';if(id)url='https://t.bilibili.com/'+id}
  else{const oid=identifier(target.object_id),type=String(target.object_type??'');destination=target.channel==='dm'?'B站私信':target.channel==='live'?'直播间':type==='1'?'视频'+(oid?' av'+oid:''):oid?'内容'+oid:'B站内容';if(identifier(target.parent_reply_id))destination+=' · 回复评论'+target.parent_reply_id;if(type==='1'&&oid)url='https://www.bilibili.com/video/av'+oid}
 }
 if(row.platform==='qq'){const conversation=clean(target.conversation_id,100);destination=conversation.startsWith('group:')?'QQ群 '+conversation.slice(6):conversation.startsWith('private:')?'QQ私聊 '+conversation.slice(8):'QQ会话';if(identifier(target.member_uid))destination+=' · 成员'+target.member_uid}
 const status_label=({confirmed:row.platform==='qq'?'已确认送达':'服务器已确认',queued:'等待发送',draft:'原稿待确认',leased:'准备发送',submitting:'正在提交',submitted:'已提交，等待确认',unknown:'结果未确认，不重发',blocked:'发表受限',cancelled:'已取消',failed:'发表失败'})[row.status]??'状态待核对'
 return {id:row.id,kind:row.kind,label,status:row.status,status_label,destination,url,text:body,text_preview:body.slice(0,240).toWellFormed(),text_complete:(row.body?.length??0)<=16000,text_truncated:body.length>240,original_chars:row.body?.length??0,detail:clean(meta.last_detail,500)}
}
/** Store small facts from already-returned native tools, without raw args or responses. */
export function recordNativeTaskToolResult(store,{batch_id,call_id,name,args,value,is_error=false,step,at=Date.now()}={}){
 if(!(store instanceof NativeStore)||!batch_id||!call_id||!value||typeof value!=='object')return
 let outcome=null
 if(name==='companion_read'){
  const operation=args?.operation,platform=args?.platform
  if(['tieba','bilibili'].includes(platform)&&['browse','thread','watch','video','sub_replies','conversation'].includes(operation)){
   const items=Array.isArray(value.items)?value.items:[],ids=items.filter(x=>x.reading_claim!=='unavailable'&&x.seen!==false).map(x=>x.thread_id??x.bvid??x.video?.bvid).filter(x=>typeof x==='string'&&(platform==='tieba'?identifier(x):/^BV[a-zA-Z0-9]{10}$/.test(x))).slice(0,30)
   if(['thread','sub_replies','conversation'].includes(operation)&&!is_error){const id=value.thread_id??args.args?.thread_id;if(typeof id==='string')ids.push(id)}
   if(operation==='watch'&&value.seen===true&&typeof value.watch_id==='string'&&typeof (value.bvid??args.args?.bvid)==='string')ids.push(value.bvid??args.args.bvid)
   outcome={kind:platform==='bilibili'&&!['browse','watch'].includes(operation)?'read_detail':'read',platform,operation,resource_ids:is_error?[]:[...new Set(ids)],...(operation==='watch'?{watch_id:value.watch_id??'',content_kind:value.content?.asset_ids?.length?'sampled_frames':value.content?.transcription?'unverified_transcription':value.content?.available?'subtitles':'unavailable',asset_refs:value.content?.asset_ids??[]}:{}),attempted:Number.isSafeInteger(value.opened)?value.opened:operation==='browse'?items.length:1,successful:is_error?0:ids.length,comment_samples:items.reduce((n,item)=>n+(item.comment_context?.candidates?.length??0),0),label:is_error?'读取未完成':operation==='browse'?'取得内容预览':operation==='watch'?'取得视频片段或字幕':operation==='video'?'读取视频信息':'读取帖子或评论内容'}
   if(!is_error){const candidates=[...new Set([...(Array.isArray(value.evidence_ids)?value.evidence_ids:[]),...items.flatMap(item=>Array.isArray(item.evidence_ids)?item.evidence_ids:[])])].filter(id=>typeof id==='string'&&id.length<=160).slice(0,128);outcome.evidence_ids=candidates.filter(id=>{const row=store.db.prepare("SELECT ref,source_json FROM evidence WHERE id=? AND platform=? AND visibility='public' AND direction='observation' AND source_type='platform' AND status='confirmed' AND confirmation='source_observation'").get(id,platform);if(!row)return false;const source=parse(row.source_json);if(source.kind!=='platform_read'||source.explicit!==true)return false;return platform!=='tieba'||ids.some(resource=>row.ref==='https://tieba.baidu.com/p/'+resource||row.ref.startsWith('https://tieba.baidu.com/p/'+resource+'?'))})}
  }
 }
 if(!is_error&&name==='companion_diary'&&value.written===true)outcome={kind:'diary',label:(args?.kind??args?.args?.kind)==='private'?'写了私密日记':'写了公开日记',record_id:clean(value.id,180)}
 if(!is_error&&name==='companion_image'&&typeof args?.asset_ref==='string'&&value.attachment)outcome={kind:'image_view',label:'读取视频或图片的实际画面',asset_ref:clean(args.asset_ref,180)}
 if(!is_error&&name==='memory_remember'&&value.ok!==false&&!value.error&&(value.status||value.id||value.entry_id))outcome={kind:'memory',label:value.status==='pending_confirmation'?'记录了待核对记忆':'处理了记忆记录',record_id:clean(value.id??value.entry_id,180),status:clean(value.status,80)}
 if(!is_error&&name==='companion_learning'&&value.ok!==false)outcome={kind:'learning',label:'记录了学习线索或行为反思',status:clean(value.status,80)}
 if(!is_error&&name==='companion_mood'&&value.ok!==false&&['observe','relationship','apply'].includes(args?.operation))outcome={kind:'mood',label:'处理了共享心情或关系观察',status:clean(value.status,80)}
 if(!outcome)return
 store.appendJournalEvent({event_key:'task-result:'+hash(batch_id+'\0'+call_id),event_type:'log',platform:outcome.platform??'system',direction:'internal',status:is_error?'failed':'recorded',visibility:'owner',text:'',source_at:at,source_type:'native_task_result',metadata:{subtype:'task_tool_result',batch_id,tool:name,...(Number.isSafeInteger(step)?{step}:{}),outcome}})
}
export function ownerActivityReports(store,status,{limit=120}={}){
 if(!(store instanceof NativeStore))throw Error('任务详情必须来自本机原生存储')
 const selected=[...(status.tasks??[])].sort((a,b)=>(b.updated_at??0)-(a.updated_at??0)).slice(0,Math.min(120,limit)),ids=selected.map(x=>x.id)
 if(!ids.length)return {...status,tasks:[],total_tasks:status.tasks?.length??0}
 const rows=store.db.prepare('SELECT id,platform,kind,status,target_json,CAST(body AS BLOB) AS raw_body,body_digest,metadata_json,created_at,updated_at,source_evidence_id FROM actions WHERE id IN ('+placeholders(ids.length)+')').all(...ids),byId=new Map(rows.map(r=>[r.id,{...r,body:Buffer.from(r.raw_body).toString('utf8'),meta:parse(r.metadata_json),target:parse(r.target_json)}])),batches=[...new Set(rows.map(r=>parse(r.metadata_json).batch_id).filter(Boolean))],linked=[...new Set(rows.filter(r=>parse(r.metadata_json).execution==='publication').map(r=>parse(r.target_json).action_id).filter(Boolean))]
 let actions=[]
 if(batches.length||linked.length){const clauses=[],args=[];if(batches.length){clauses.push("json_extract(metadata_json,'$.prepared_in.round_id') IN ("+placeholders(batches.length)+')');args.push(...batches)}if(linked.length){clauses.push('id IN ('+placeholders(linked.length)+')');args.push(...linked)}actions=store.db.prepare("SELECT id,platform,kind,status,target_json,CAST(body AS BLOB) raw_body,body_digest,receipt_json,metadata_json FROM actions WHERE kind NOT LIKE 'activity.%' AND ("+clauses.join(' OR ')+')').all(...args).map(r=>({...r,body:Buffer.from(r.raw_body).toString('utf8')}))}
 const events=batches.length?store.db.prepare("SELECT metadata_json,source_at,recorded_at FROM journal_events WHERE json_extract(metadata_json,'$.batch_id') IN ("+placeholders(batches.length)+") OR json_extract(metadata_json,'$.round_id') IN ("+placeholders(batches.length)+')').all(...batches,...batches).map(r=>({...r,meta:parse(r.metadata_json)})):[]
 const earliest=Math.min(...rows.map(r=>r.created_at)),legacyReads=store.db.prepare("SELECT platform,metadata_json,recorded_at FROM journal_events WHERE source_type='native_tieba' AND json_extract(metadata_json,'$.subtype')='thread_read' AND recorded_at>=? ORDER BY recorded_at DESC LIMIT 5001").all(earliest).map(r=>({...r,meta:parse(r.metadata_json)}))
 const tasks=selected.map(task=>{
  const row=byId.get(task.id);if(!row)return task
  const batch=row.meta.batch_id,group=events.filter(e=>(e.meta.batch_id??e.meta.round_id)===batch),attempts=new Set(group.filter(e=>e.meta.subtype==='browse_item_reserved').map(e=>e.meta.resource_id)),direct=group.filter(e=>e.meta.subtype==='task_tool_result').map(e=>e.meta.outcome),reads=new Set(direct.filter(x=>x.kind==='read').flatMap(x=>x.resource_ids??[])),started=group.filter(e=>e.meta.event_name==='activity.started').map(e=>e.source_at??e.recorded_at),start=started.length?Math.min(...started):null,end=row.meta.completed_at??Number.MAX_SAFE_INTEGER
  if(task.platform==='tieba'&&start!==null&&attempts.size&&legacyReads.length<=5000)for(const r of legacyReads)if(r.recorded_at>=start&&r.recorded_at<=end&&attempts.has(r.meta.thread_id))reads.add(r.meta.thread_id)
  const related=actions.filter(a=>row.meta.execution==='publication'?a.id===row.target.action_id:parse(a.metadata_json).prepared_in?.round_id===batch).filter(a=>row.meta.execution!=='publication'||a.body_digest===row.body_digest),reports=related.slice(0,24).map(actionReport),comments=related.filter(isComment),confirmed=related.filter(a=>a.status==='confirmed').length,pending=related.filter(a=>['queued','leased','submitting','submitted'].includes(a.status)).length,uncertain=related.filter(a=>a.status==='unknown').length
  const readKnown=direct.some(x=>x.kind==='read'&&x.operation!=='video')||task.platform==='tieba'&&start!==null&&attempts.size>0&&legacyReads.length<=5000
  const peers=batch?rows.filter(r=>parse(r.metadata_json).batch_id===batch&&parse(r.metadata_json).execution==='model').length:0
  const commentSamples=direct.reduce((n,x)=>n+(x.comment_samples??0),0)
  const notes=[...new Set(direct.filter(x=>x.kind!=='read').map(x=>x.label))].slice(0,8)
  const summary=[];if(peers>1&&row.meta.execution==='model')summary.push('同批处理'+peers+'条消息，以下为该批结果');if(!readKnown&&attempts.size)summary.push('尝试打开'+attempts.size+(task.platform==='bilibili'?'个视频；未保存内容读取明细':'帖；未保存内容读取明细'));else if(attempts.size||reads.size){const unit=task.platform==='bilibili'?'个视频预览':'帖内容';summary.push('已读取'+reads.size+unit+(attempts.size>reads.size?'，尝试打开'+attempts.size+'个':''))}if(commentSamples)summary.push('带入'+commentSamples+'条评论供选择');if(related.length){const doneComments=comments.filter(a=>a.status==='confirmed').length,drafts=related.filter(a=>a.status==='draft').length;summary.push((doneComments?'已确认发表'+doneComments+'条回复':confirmed?'已确认'+confirmed+'项操作':'尚无确认发表')+(confirmed>doneComments&&doneComments?'，另完成'+(confirmed-doneComments)+'项操作':'')+(pending?'，待发送'+pending+'项':'')+(drafts?'，待确认原稿'+drafts+'份':'')+(uncertain?'，'+uncertain+'项结果未确认':''))}if(!summary.length&&notes.length)summary.push(notes.join('、'));if(!summary.length)summary.push(({completed:'流程已结束，旧记录未保存具体操作明细',queued:'等待执行，尚无结果',running:'正在处理，结果持续更新',unknown:'本轮未完整结束，按下面已记录结果核对',blocked:'当前受限，尚无确认结果',draft:'等待确认原稿'})[task.status]??'暂无可追溯结果')
  const protectedTail=/token保护上限|步骤上限|输出.*长度上限/i.test(task.reason??''),title=row.meta.execution==='publication'?(reports[0]?.label??'发表内容'):task.kind==='activity.explore'?'浏览一轮':task.kind==='activity.chat'?'主动搭话':task.kind==='activity.maintenance'?({memory:'整理记忆',mood:'观察共享心情',learning:'整理学习线索',people:'整理熟人印象'})[row.target.maintenance_kind]??'后台整理':'回应消息'
  const planned=group.find(e=>e.meta.subtype==='browse_round_started')?.meta.limits?.read??row.target.round_limits?.read_per_round,read_target=Number.isSafeInteger(planned)&&planned>0?planned:null
  const stage=task.status==='queued'?(task.reason==='peak'?'等待谷时':'等待执行'):pending?'正在发表':uncertain||task.status==='unknown'?'结果待核对':task.status==='completed'?'已完成':task.status==='blocked'?'受限':task.status==='running'||task.status==='leased'?(task.kind==='activity.explore'&&read_target!==null&&reads.size<read_target?'正在浏览':'正在处理'):'等待处理'
  const progress={stage,read_target,read_current:readKnown?reads.size:['queued','leased','running'].includes(task.status)?0:null,confirmed_actions:confirmed,pending_actions:pending}
  return {...task,report:{title,progress,summary:summary.join('；'),reads:readKnown?reads.size:null,read_attempts:attempts.size,confirmed_actions:confirmed,confirmed_comments:comments.filter(a=>a.status==='confirmed').length,pending_actions:pending,unknown_actions:uncertain,actions:reports,actions_total:related.length,notes,finish_note:protectedTail?(/输出.*长度上限/.test(task.reason)?'单次输出达到长度限制。':/步骤上限/.test(task.reason)?'达到本轮步骤限制。':'达到单轮Token保护。')+'已停止追加思考；已确认的发表结果保留，不重跑。':task.status==='unknown'?'本轮没有正常结束；只有标为“已确认”的内容才能算已完成。':'',historical_detail_missing:!related.length&&!attempts.size&&!direct.length,model_tokens:row.meta.actual_tokens??null,model_usage_known:row.meta.usage_known===true}}
 })
 return {...status,tasks,total_tasks:status.tasks?.length??0,details_scope:'local_owner_only'}
}
