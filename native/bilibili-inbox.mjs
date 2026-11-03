/** Native private/live inbox primitives. Source messages stay separate from public publication receipts. */
import {createHash} from 'node:crypto'
import {inflateSync,brotliDecompressSync} from 'node:zlib'
import {BilibiliError,biliId,exactJson,cleanSourceText} from './bilibili-http.mjs'

const hash=value=>createHash('sha256').update(value).digest('hex'),LIVE='https://api.live.bilibili.com',DM='https://api.vc.bilibili.com'
const safeText=value=>{if(typeof value!=='string'||!value.isWellFormed()||value.includes('\0')||value.length>64000)throw new BilibiliError('消息正文结构无效',{code:'invalid_source'});return value}
const integerString=value=>{if(typeof value==='number'&&!Number.isSafeInteger(value))throw new BilibiliError('消息时间或序号精度丢失',{code:'invalid_source'});const v=String(value??'');if(!/^\d{1,100}$/.test(v))throw new BilibiliError('消息时间或序号缺失',{code:'invalid_source'});return v}
const later=(a,b)=>BigInt(a)>BigInt(b)
export function normalizeDirectMessage(row){
  const type=Number(row.msg_type??1),uid=biliId(row.sender_uid),timestamp_raw=integerString(row.timestamp),key=row.msg_key!==undefined?biliId(row.msg_key):row.msg_seqno!==undefined?'sequence:'+integerString(row.msg_seqno):'observation:'+hash(JSON.stringify([timestamp_raw,uid,row.content])),seq=row.msg_seqno===undefined?null:integerString(row.msg_seqno)
  let content=safeText(String(row.content??'')),withdrawn_key=null
  try{const parsed=exactJson(content);if(type===5)withdrawn_key=String(parsed.msg_key_str??parsed.msg_key??parsed);else content=String(parsed.content??parsed.text??content)}catch{}
  return {key,uid,timestamp_raw,seq,type,text:safeText(content),withdrawn_key}
}
export function parseLiveFrames(input,depth=0){
  const bytes=Buffer.from(input);if(bytes.length>8*1024*1024||depth>3)throw new BilibiliError('直播包超过安全容量',{code:'invalid_live_packet'})
  const packets=[];let at=0
  while(at<bytes.length){if(at+16>bytes.length)throw new BilibiliError('直播包头不完整',{code:'invalid_live_packet'});const size=bytes.readUInt32BE(at),header=bytes.readUInt16BE(at+4),version=bytes.readUInt16BE(at+6),operation=bytes.readUInt32BE(at+8);if(size<header||header<16||size>8*1024*1024||at+size>bytes.length)throw new BilibiliError('直播包边界无效',{code:'invalid_live_packet'});const body=bytes.subarray(at+header,at+size);if(version===2||version===3){const unpacked=version===2?inflateSync(body,{maxOutputLength:8*1024*1024}):brotliDecompressSync(body,{maxOutputLength:8*1024*1024});packets.push(...parseLiveFrames(unpacked,depth+1))}else if(operation===5||operation===8){packets.push({operation,data:body.length?exactJson(body.toString('utf8').replace(/\0+$/,'')):{}})}at+=size;if(packets.length>2000)throw new BilibiliError('直播包条数过多',{code:'invalid_live_packet'})}
  return packets
}
export function livePacket(operation,body=''){
  const payload=Buffer.from(body),header=Buffer.alloc(16);header.writeUInt32BE(16+payload.length,0);header.writeUInt16BE(16,4);header.writeUInt16BE(1,6);header.writeUInt32BE(operation,8);header.writeUInt32BE(1,12);return Buffer.concat([header,payload])
}
function sourceTime(raw){const value=String(raw??'');if(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)){const at=Date.parse(value.replace(' ','T')+'+08:00');if(Number.isSafeInteger(at))return{source_at:at,source_time_raw:value}}return{source_at:null,source_time_raw:value}}
export function normalizeLiveMessage(row,{websocket=false}={}){
  if(websocket){if(!String(row.cmd??'').startsWith('DANMU_MSG')||!Array.isArray(row.info))return null;const info=row.info,raw=info[0]?.[4],sec=typeof raw==='number'&&Number.isSafeInteger(raw)&&raw>=0&&raw<8640000000000?raw:null,uid=biliId(info[2]?.[0]),text=safeText(String(info[1]??'')),name=cleanSourceText(info[2]?.[1],200),id=info[9]?.dmid??info[0]?.[9]?.dmid,source_at=sec===null?null:sec*1000,fingerprint='observation:'+hash(JSON.stringify([uid,source_at??String(raw??''),text]));return {key:id!==undefined?biliId(id):fingerprint,fingerprint,server_id:id!==undefined?biliId(id):'',uid,name,text,source_at,source_time_raw:String(raw??'')}}
  const uid=biliId(row.uid),text=safeText(String(row.text??'')),server_id=row.id_str!==undefined&&/^\d+$/.test(String(row.id_str))?biliId(row.id_str):'',time=sourceTime(row.timeline)
  const fingerprint='observation:'+hash(JSON.stringify([uid,time.source_at??time.source_time_raw,text]));return {key:server_id||fingerprint,fingerprint,server_id,uid,name:cleanSourceText(row.nickname,200),text,...time}
}
export function ownerUids(service){const owner=service._settings().config.sharing?.owner_entity_id;return service.store.listPlatformIdentities({namespace:'bilibili',role:'owner',...(owner?{entity_id:owner}:{}),limit:100}).map(row=>row.platform_uid)}
export async function readDirectHistory(service,{talker_uid,checkpoint,max_pages=10}={}){
  talker_uid=biliId(talker_uid);if(!Number.isSafeInteger(max_pages)||max_pages<1||max_pages>10)throw new BilibiliError('私信分页上限无效',{code:'invalid_input'})
  const rows=[],seen=new Set();let cursor='0'
  for(let page=0;page<max_pages;page++){
    const{data}=await service._get('/svr_sync/v1/svr_sync/fetch_session_msgs',{talker_id:talker_uid,session_type:1,size:30,begin_seqno:cursor},{host:DM,signed:true});if(!Array.isArray(data.messages))throw new BilibiliError('私信历史结构未确认，保留检查点',{code:'invalid_source'})
    const batch=data.messages.map(normalizeDirectMessage);for(const row of batch)if(!seen.has(row.key)){seen.add(row.key);rows.push(row)}
    if(!checkpoint?.baseline||batch.some(row=>later(checkpoint.last_timestamp_raw,row.timestamp_raw))||[0,'0',false].includes(data.has_more)||data.has_more===undefined&&batch.length<30)break
    const seqs=batch.filter(row=>row.seq).map(row=>BigInt(row.seq));if(!seqs.length)throw new BilibiliError('私信历史缺少可靠分页序号，未推进检查点',{code:'invalid_source'});const next=seqs.reduce((a,b)=>a<b?a:b).toString();if(next===cursor||cursor!=='0'&&BigInt(next)>=BigInt(cursor))throw new BilibiliError('私信分页没有前进，未推进检查点',{code:'invalid_source'});if(page===max_pages-1)throw new BilibiliError('私信积压超过本次上限，未推进检查点',{code:'backlog_limit'});cursor=next
  }
  rows.sort((a,b)=>BigInt(a.timestamp_raw)<BigInt(b.timestamp_raw)?-1:BigInt(a.timestamp_raw)>BigInt(b.timestamp_raw)?1:a.seq&&b.seq?(BigInt(a.seq)<BigInt(b.seq)?-1:BigInt(a.seq)>BigInt(b.seq)?1:0):a.key.localeCompare(b.key))
  const withdrawn=new Set(rows.filter(row=>row.type===5).map(row=>row.withdrawn_key)),boundary=checkpoint?.last_timestamp_raw??'0',keys=new Set(checkpoint?.last_keys??[])
  return {rows,messages:rows.filter(row=>row.type===1&&row.uid===talker_uid&&!withdrawn.has(row.key)&&(later(row.timestamp_raw,boundary)||row.timestamp_raw===boundary&&!keys.has(row.key)))}
}
export async function pollDirectMessages(service,state,policy){
  const scope=policy.dm_scope??'owner',owners=ownerUids(service);let targets
  if(scope==='owner')targets=owners
  else if(scope==='allowlist')targets=(policy.dm_allowed_uids??[]).map(uid=>biliId(uid))
  else if(scope==='all'){const{data}=await service._get('/session_svr/v1/session_svr/get_sessions',{session_type:4,group_fold:0,unfollow_fold:0,sort_rule:2,size:100,build:0,mobi_app:'web'},{host:DM});if(data.has_more&&data.has_more!=='0')throw new BilibiliError('私信会话超过本次持久检查点上限，请明确允许名单',{code:'backlog_limit'});targets=(data.session_list??[]).filter(row=>Number(row.session_type)===1&&!Number(row.system_msg_type??0)).map(row=>biliId(row.talker_id))}
  else throw new BilibiliError('私信范围设置无效',{code:'invalid_input'})
  const unique=[...new Set(targets)];if(unique.length>100)throw new BilibiliError('本次私信会话过多，保持检查点',{code:'backlog_limit'})
  if(scope==='owner'&&!unique.length)return {queued:0,observed:0,reason:'尚未绑定明确B站主人UID'}
  let queued=0,observed=0,seeded=0
  for(const uid of unique){const prior=state.value.dm_sessions.find(row=>row.talker_uid===uid),history=await readDirectHistory(service,{talker_uid:uid,checkpoint:prior}),seed=!prior?.baseline&&policy.dm_seed_on_start!==false;observed+=history.messages.length
    if(!seed)for(const row of history.messages){const delivery=await service._incoming({channel:'dm',key:row.key,uid,name:'',body:row.text,conversation_id:'dm:'+uid,source_at:null,source_time_raw:row.timestamp_raw,target:{channel:'dm',recipient_uid:uid},visibility:'conversation'});if(delivery?.duplicate!==true)queued++}
    else seeded+=history.messages.length
    const last=history.rows.at(-1),last_timestamp_raw=last?.timestamp_raw??prior?.last_timestamp_raw??'0',last_keys=history.rows.filter(row=>row.timestamp_raw===last_timestamp_raw).map(row=>row.key)
    const next={talker_uid:uid,baseline:true,last_timestamp_raw,last_keys:last_keys.length?last_keys.slice(-200):prior?.last_keys??[],last_polled_at:service._now()};state.value.dm_sessions=state.value.dm_sessions.filter(row=>row.talker_uid!==uid).concat(next);service._saveInboxState(state)
  }
  return {queued,observed,seeded}
}
export async function liveRoom(service,room_id){room_id=biliId(room_id);const mapping=service._cacheGet('room-mapping',room_id);if(mapping)return {...mapping,title:'',live:null,cached:true};const{data}=await service._get('/room/v1/Room/get_info',{room_id},{host:LIVE}),value={room_id:biliId(data.room_id),anchor_uid:biliId(data.uid)};service._cachePut('room-mapping',room_id,value,86400000);return {...value,title:cleanSourceText(data.title,300),live:Number(data.live_status)===1,cached:false}}
export async function liveHistory(service,{room_id,limit=20}={}){if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw new BilibiliError('直播历史数量无效',{code:'invalid_input'});const room=await liveRoom(service,room_id),{data}=await service._get('/xlive/web-room/v1/dM/gethistory',{roomid:room.room_id,room_type:0},{host:LIVE});return {...room,items:(data.room??[]).map(row=>normalizeLiveMessage(row)).slice(-limit)}}
export function shouldQueueLive(service,message,policy,room,state){
  if((policy.live_ignore_uids??[]).includes(message.uid)||service.store.listPlatformIdentities({namespace:'bilibili',role:'account',limit:100}).some(row=>row.platform_uid===message.uid))return false
  const owners=ownerUids(service),names=typeof service.selfNames==='function'?service.selfNames():[],account=service.store.listPlatformIdentities({namespace:'bilibili',role:'account',limit:100}).map(row=>row.display_name).filter(Boolean),mentioned=[...names,...account].some(name=>typeof name==='string'&&name&&message.text.includes('@'+name)),scope=policy.live_scope??'owner'
  const authorized=scope==='owner'?owners.includes(message.uid):scope==='mention'?mentioned:scope==='all';if(!authorized)return false
  // Only obvious promotional loops are suppressed; ordinary emojis and casual human lines remain valid.
  if(!owners.includes(message.uid)&&!mentioned&&/^(?:欢迎.{1,40}(?:直播间|等你好久)|感谢.{1,40}(?:礼物|盲盒|舰长)|喜欢主播.{0,30}关注|谢谢.{0,30}(?:关注|礼物))/.test(message.text))return false
  return !state.recent_texts.some(row=>row.uid===message.uid&&row.text_sha256===hash(message.text)&&service._now()-row.seen_at<60000)
}
export async function handleLiveMessage(service,message,{room,policy,state,seed=false}){
  if(!message||!policy.enabled||!policy.channels?.includes('live'))return {queued:0};const checkpoint=state.value.live_rooms.find(row=>row.room_id===room.room_id)??{room_id:room.room_id,baseline:false,seen_keys:[],recent_texts:[],last_polled_at:null}
  if(checkpoint.seen_keys.includes(message.key)||message.fingerprint&&checkpoint.seen_keys.includes(message.fingerprint))return{queued:0}
  let queued=0
  if(!seed&&shouldQueueLive(service,message,policy,room,checkpoint)){const delivery=await service._incoming({channel:'live',key:message.key,uid:message.uid,name:message.name,body:message.text,conversation_id:'live:'+room.room_id,source_at:message.source_at,source_time_raw:message.source_time_raw,target:{channel:'live',room_id:room.room_id,reply_uid:message.uid,...(message.server_id?{reply_dmid:message.server_id}:{})},visibility:'public'});queued=delivery?.duplicate===true?0:1;checkpoint.recent_texts.push({uid:message.uid,text_sha256:hash(message.text),seen_at:service._now()})}
  checkpoint.baseline=true;checkpoint.seen_keys=[...new Set([...checkpoint.seen_keys,message.key,...(message.fingerprint?[message.fingerprint]:[])])].slice(-2000);checkpoint.recent_texts=checkpoint.recent_texts.filter(row=>service._now()-row.seen_at<3600000).slice(-100);checkpoint.last_polled_at=service._now();state.value.live_rooms=state.value.live_rooms.filter(row=>row.room_id!==room.room_id).concat(checkpoint);service._saveInboxState(state)
  return {queued}
}
export async function pollLive(service,state,policy){if(!policy.room_uid)return {queued:0,observed:0,reason:'尚未设置直播房间号'};const result=await liveHistory(service,{room_id:policy.room_uid,limit:100}),checkpoint=state.value.live_rooms.find(row=>row.room_id===result.room_id),seed=!checkpoint?.baseline&&policy.live_seed_on_start!==false;let queued=0;for(const row of result.items)queued+=(await handleLiveMessage(service,row,{room:result,policy,state,seed})).queued;if(!result.items.length){state.value.live_rooms=state.value.live_rooms.filter(row=>row.room_id!==result.room_id).concat({...checkpoint,room_id:result.room_id,baseline:true,seen_keys:checkpoint?.seen_keys??[],recent_texts:checkpoint?.recent_texts??[],last_polled_at:service._now()});service._saveInboxState(state)}return{queued,observed:result.items.length,seeded:seed?result.items.length:0}}
export async function connectLive(service,{signal}={}){
  if(signal?.aborted)throw new BilibiliError('直播监听已取消',{code:'cancelled'})
  const inbox=service._inboxPolicy();if(!inbox.enabled||!inbox.channels?.includes('live')||!inbox.room_uid)throw new BilibiliError('直播监测未开启或未设置房间',{code:'disabled'})
  if(service.liveConnection){if(service.liveConnection.requested_room===inbox.room_uid)return service.liveConnection.public;service.liveConnection.public.close()}
  const room=await liveRoom(service,inbox.room_uid),initial=service._inboxState();if(!initial.value.live_rooms.some(row=>row.room_id===room.room_id&&row.baseline))await pollLive(service,initial,inbox)
  const cred=await service._credential(),nav=await service._nav(cred),{data}=await service._get('/xlive/web-room/v1/index/getDanmuInfo',{id:room.room_id,type:0},{host:LIVE,signed:true}),host=data.host_list?.find(row=>Number(row.wss_port)===443||row.wss_port===undefined)?.host
  if(typeof host!=='string'||!/(?:^|\.)chat\.bilibili\.com$/.test(host)||!/^[A-Za-z0-9.-]+$/.test(host)||typeof data.token!=='string')throw new BilibiliError('直播连接地址或凭据未核验',{code:'invalid_live_endpoint'})
  const factory=service.websocketFactory??(url=>new WebSocket(url)),socket=factory('wss://'+host+'/sub'),connection={socket,room,requested_room:inbox.room_uid,timer:null,closed:false,processing:Promise.resolve()},stop=()=>{if(connection.closed)return;connection.closed=true;if(connection.timer)clearInterval(connection.timer);try{socket.close()}catch{}if(service.liveConnection===connection)service.liveConnection=null;signal?.removeEventListener('abort',stop)}
  connection.public={room_id:room.room_id,status:'connecting',close:stop};service.liveConnection=connection;socket.binaryType='arraybuffer'
  const send=payload=>{if(!connection.closed)socket.send(payload)}
  socket.addEventListener('open',()=>{try{service._reserve('read');const uid=biliId(nav.mid),body='{"uid":'+uid+',"roomid":'+room.room_id+',"protover":3,"buvid":'+JSON.stringify(cred.buvid3)+',"platform":"web","type":2,"key":'+JSON.stringify(data.token)+'}';send(livePacket(7,body));connection.timer=setInterval(()=>{try{service._checkEnabled();const policy=service._inboxPolicy();if(!policy.enabled||!policy.channels?.includes('live')||policy.room_uid!==connection.requested_room){stop();return}send(livePacket(2,'[object Object]'))}catch{stop()}},30000)}catch{stop()}})
  socket.addEventListener('message',event=>{connection.processing=connection.processing.then(async()=>{if(connection.closed)return;const policy=service._inboxPolicy();if(!policy.enabled||!policy.channels?.includes('live')||policy.room_uid!==connection.requested_room){stop();return}const bytes=event.data instanceof Blob?Buffer.from(await event.data.arrayBuffer()):Buffer.from(event.data);for(const packet of parseLiveFrames(bytes)){if(packet.operation===8){if(packet.data.code!==0){service._saveState({verification_required:true,verification_reason:'直播身份验证未通过，等待主人处理'});stop();return}connection.public.status='connected'}else{const message=normalizeLiveMessage(packet.data,{websocket:true}),state=service._inboxState();if(message)await handleLiveMessage(service,message,{room,policy,state})}}}).catch(()=>stop())})
  socket.addEventListener('error',stop);socket.addEventListener('close',stop);if(signal?.aborted)stop();else signal?.addEventListener('abort',stop,{once:true});return connection.public
}
