import {createHash} from 'node:crypto'
import path from 'node:path'
import {NativeStore} from './store.mjs'

const hash=value=>createHash('sha256').update(value).digest('hex')
const clean=value=>[...String(value??'').replace(/\[CQ:[^\]]*\]/g,'').replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/g,'').replace(/\s+/g,' ').trim()].slice(0,16).join('')
const get=(ctx,key)=>{try{return ctx.get?.(key)??ctx[key]}catch{return undefined}}
export function sessionNameTime(value=Date.now()){
 const parts=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).formatToParts(new Date(value)),p=Object.fromEntries(parts.map(x=>[x.type,x.value]))
 return p.month+'-'+p.day+' '+p.hour+':'+p.minute
}
export function activitySessionName(batch,now=Date.now()){
 const platform={qq:'QQ',bilibili:'B站',tieba:'贴吧'}[batch.platform];if(!platform)return undefined
 if(batch.tasks?.some(row=>row.target?.no_publication===true))return platform+' · 定向研读'+(batch.tasks[0].target.topic?' · '+clean(batch.tasks[0].target.topic):'')+' · '+sessionNameTime(now)
 if(batch.platform==='tieba'&&/^dm:/.test(batch.tasks?.[0]?.target?.conversation_id??''))return '贴吧 · 私信 · '+clean(batch.tasks[0].target.display_name??batch.tasks[0].target.recipient_uid)+' · '+sessionNameTime(now)
 const sub=batch.tasks?.[0]?.target?.maintenance_kind,title=batch.kind==='activity.explore'?'浏览一轮':batch.kind==='activity.incoming'?'回应消息':batch.kind==='activity.chat'?'主动搭话':({memory:'整理记忆',mood:'观察心情',learning:'整理学习'})[sub]??'后台任务'
 return platform+' · '+title+' · '+sessionNameTime(now)
}

/** Names come from trusted bindings and platform metadata, never a model guess. */
export class NativeSessionNames{
 constructor({store,ctx,now=Date.now,resolve_group,enabled=()=>true}){if(!(store instanceof NativeStore))throw Error('会话命名需要原生存储');this.store=store;this.ctx=ctx;this.now=now;this.resolveGroup=resolve_group;this.enabled=enabled;this.hints=new Map();this.chains=new Map();this.groupFlights=new Map();this.off=[];this.closed=false}
 _cache(key){const row=this.store.db.prepare("SELECT value_json,expires_at FROM cache_entries WHERE key=? AND kind='session_naming'").get(key);return row&&(!row.expires_at||row.expires_at>this.now())?JSON.parse(row.value_json):null}
 _save(key,value,ttl=null){this.store.db.prepare("INSERT INTO cache_entries(key,kind,schema_id,schema_version,value_json,created_at,expires_at) VALUES(?,'session_naming','companion.session_name',1,?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,created_at=excluded.created_at,expires_at=excluded.expires_at").run(key,JSON.stringify(value),this.now(),ttl===null?null:this.now()+ttl)}
 _bindings(){return this.store.db.prepare("SELECT value_json FROM documents WHERE type='conversation_binding' AND json_extract(value_json,'$.platform')='qq'").all().map(x=>JSON.parse(x.value_json))}
 _describe(session,input){
  if(input.session_title)return{title:input.session_title}
  const bindings=this._bindings(),bound=bindings.find(x=>x.session_id===session.id),events=session.snapshotEvents(),source=[...events].reverse().find(x=>x.type==='user/message'&&x.data?.source?.kind==='plugin:companion-qq')?.data.source
  const conversation=input.platform==='qq'?input.conversation_id:bound?.conversation_id??source?.conversation_id
  const ref=/^(private|group):([1-9]\d*)$/.exec(conversation??'')
  const date=sessionNameTime(session.header.createdAt??this.now())
  if(!ref){const qqIds=new Set(['workspace:qq',...bindings.map(x=>x.workspace_id)]),root=path.dirname(this.store.file),known=[...qqIds].some(id=>session.header.cwd===path.join(root,'workspaces',hash(id)));return known?{title:'QQ · 本地会话（无聊天绑定）· '+date}:null}
  const [,kind,uid]=ref,current=input.platform==='qq'||bound&&!bound.retired,autonomous=input.purpose==='autonomous'
  let label
  if(kind==='group'){const cached=this._cache('session-group:'+uid);label='群聊'+(cached?.name?' · '+cached.name:'')+'（'+uid+'）';if(!cached)this._refreshGroup(uid,session)}
  else{const identity=this.store.getPlatformIdentity('qq',uid),name=identity?.role==='owner'?'主人':clean(identity?.display_name);label=(name==='主人'?'主人私聊':name?'私聊 · '+name:'私聊')+'（'+uid+'）'}
  return{title:(autonomous?'主动搭话 · ':current?'':'历史')+label+(!current||autonomous?' · '+date:'')}
 }
 _refreshGroup(uid,session){
  if(!this.resolveGroup||this.groupFlights.has(uid)||this.closed)return
  const work=Promise.resolve().then(()=>this.resolveGroup(uid)).then(value=>{if(this.closed)return;const name=String(value?.group_id)===uid?clean(value.group_name):'';this._save('session-group:'+uid,{name},name?600000:60000);if(name)void this.update(session)}).catch(()=>{if(!this.closed)this._save('session-group:'+uid,{name:''},60000)}).finally(()=>this.groupFlights.delete(uid))
  this.groupFlights.set(uid,work)
 }
 async _apply(session){
  if(this.closed||!this.enabled()||this.store.readOnly)return{updated:false}
  const titles=get(this.ctx,'sessionTitle');if(!titles?.get||!titles?.rename||typeof session.snapshotEvents!=='function')return{updated:false,available:false}
  const input=this.hints.get(session.id)??{},proposed=this._describe(session,input);if(!proposed)return{updated:false}
  const cap=titles.config?.maxTitleBytes;if(Number.isSafeInteger(cap)&&cap>0){const chars=[...proposed.title];while(chars.length&&Buffer.byteLength(chars.join(''))>cap)chars.pop();proposed.title=chars.join('').trimEnd()}
  const old=titles.get(session),key='session-name:'+hash(session.id),managed=this._cache(key)
  if(old?.source?.kind==='user'&&old.title!==managed?.title)return{updated:false,custom_title:true}
  if(old?.title===proposed.title)return{updated:false,title:old.title}
  const saved=titles.rename(session,proposed.title);await get(this.ctx,'sessions')?.flush?.(session)
  this._save(key,{session_id:session.id,title:saved.title});return{updated:true,title:saved.title}
 }
 update(session,input={}){
  this.hints.set(session.id,{...this.hints.get(session.id),...input})
  const prior=this.chains.get(session.id)??Promise.resolve(),work=prior.catch(()=>{}).then(()=>this._apply(session)).catch(()=>({updated:false,error:'会话命名未完成'}))
  this.chains.set(session.id,work);void work.finally(()=>{if(this.chains.get(session.id)===work)this.chains.delete(session.id)});return work
 }
 attach(){if(typeof this.ctx.on!=='function')return;this.off.push(this.ctx.on('session/created',session=>{void this.update(session)}),this.ctx.on('session/event',(session,event)=>{if(event.type==='user/message'&&event.data?.source?.kind==='plugin:companion-qq')void this.update(session)}))}
 async close(){this.closed=true;for(const off of this.off)off?.();await Promise.allSettled([...this.chains.values(),...this.groupFlights.values()]);this.hints.clear()}
}
