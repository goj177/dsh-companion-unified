/** Native schema3 data bundles only. No legacy reader, plugin code, shell/archive program or network is used. */
import fs from 'node:fs'
import path from 'node:path'
import {createHash,randomUUID} from 'node:crypto'
import {DatabaseSync,backup as sqliteBackup} from 'node:sqlite'
import {NativeStore,NATIVE_DDL,NATIVE_TABLES,countOpenNativeStores} from './store.mjs'
import {NativeAssets,nativeResourceFiles} from './assets.mjs'
import {NativeSecrets} from './secrets.mjs'
import {NativeBudget} from './budget.mjs'
import {NativeHormone} from './hormone.mjs'
import {NATIVE_FORMAT,NATIVE_SCHEMA_VERSION,NATIVE_APPLICATION_ID,isPlainObject,validateJson,validateDocument,validatePersona,stringifyJson} from './contracts.mjs'
import {makeNativeZip,readNativeZip,ZIP_LIMITS,safeZipName} from './zip.mjs'
import {validateModerationStateProof} from './qq-moderation.mjs'
import {validateMoneyRecord,effectiveMoneyNano} from './money-budget.mjs'

const FORMAT='companion.native_bundle',VERSION=1,DB_ENTRY='database.sqlite',MANIFEST='manifest.json'
const sha=value=>createHash('sha256').update(value).digest('hex')
const canonical=value=>Array.isArray(value)?value.map(canonical):isPlainObject(value)?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value
const encode=value=>stringifyJson(canonical(value)),clone=value=>structuredClone(value)
const failure=message=>new Error(message??'原生资料包校验失败；当前资料未替换')
const exists=file=>{try{return fs.lstatSync(file)}catch(error){if(error.code==='ENOENT')return null;throw error}}
const same=(a,b)=>a?.dev===b?.dev&&a?.ino===b?.ino
const identifier=value=>typeof value==='string'&&/^[a-z][a-z0-9_.:/-]{0,159}$/.test(value)
const timestamp=value=>Number.isSafeInteger(value)&&value>=0&&value<=8640000000000000
function confirmedReceipt(row){
  const receipt=jsonObject(row.receipt_json)
  if(row.platform==='qq'&&['qq.mute','qq.unmute'].includes(row.kind))return validateModerationStateProof({...row,target:JSON.parse(row.target_json),metadata:jsonObject(row.metadata_json)},receipt,{historical:true})
  if(receipt.source!=='server_receipt'||receipt.accepted!==true||receipt.rejected===true||receipt.code!==undefined&&receipt.code!==0||typeof receipt.server_id!=='string'||!receipt.server_id.trim()||/^(?:0|-1|null|undefined)$/i.test(receipt.server_id))throw failure('已确认的原生动作缺少有效服务器回执')
  return true
}
function fields(value,allowed){if(!isPlainObject(value)||Object.keys(value).some(key=>!allowed.includes(key)))throw failure('原生搬家资料包含未知字段或类型')}
function physical(file,{directory=false,private_mode=false,missing=false}={}){
  if(typeof file!=='string'||!path.isAbsolute(file)||path.resolve(file)!==file||file.includes('\0'))throw failure('资料路径必须是规范绝对路径')
  let cursor=path.parse(file).root
  for(const part of file.slice(cursor.length).split(path.sep).filter(Boolean)){
    cursor=path.join(cursor,part);const stat=exists(cursor)
    if(!stat){if(missing&&cursor===file)return null;throw failure('资料路径不存在')}
    if(stat.isSymbolicLink()||cursor!==file&&!stat.isDirectory())throw failure('资料路径不能经过符号链接或文件')
  }
  const stat=exists(file)
  if(directory?!stat.isDirectory():!stat.isFile()||stat.nlink!==1)throw failure('资料必须是普通私有文件或目录')
  if(private_mode&&((stat.mode&0o777)!==(directory?0o700:0o600)||process.getuid&&stat.uid!==process.getuid()))throw failure('资料权限须为私有目录0700、文件0600')
  return stat
}
function mkdir(file){physical(path.dirname(file),{directory:true});if(!exists(file))try{fs.mkdirSync(file,{mode:0o700})}catch(error){if(error.code!=='EEXIST')throw failure()};physical(file,{directory:true,private_mode:true});return file}
function readFile(file,max=ZIP_LIMITS.max_file_bytes,{private_mode=true}={}){
  physical(file,{private_mode});const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW)
  try{const before=fs.fstatSync(fd);if(before.size>max)throw failure('资料超过搬家包容量限制');const parts=[];let size=0;for(;;){const chunk=Buffer.alloc(Math.min(65536,max-size+1)),n=fs.readSync(fd,chunk,0,chunk.length,null);if(!n)break;size+=n;if(size>max)throw failure('资料超过搬家包容量限制');parts.push(chunk.subarray(0,n))}const after=fs.fstatSync(fd),named=physical(file,{private_mode});if(!same(before,after)||!same(after,named)||before.size!==after.size||before.mtimeMs!==after.mtimeMs||size!==after.size)throw failure('资料在读取期间变化，请稍后重试');return Buffer.concat(parts)}finally{fs.closeSync(fd)}
}
function writeFile(file,bytes,{replace=false,private_parent=true}={}){
  physical(path.dirname(file),{directory:true,private_mode:private_parent});const old=exists(file);if(old){physical(file,{private_mode:true});if(!replace)throw failure('目标文件已存在，未覆盖')}
  const temporary=path.join(path.dirname(file),'.tmp-'+randomUUID()),fd=fs.openSync(temporary,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600)
  try{fs.fchmodSync(fd,0o600);fs.writeFileSync(fd,bytes);fs.fsyncSync(fd)}finally{fs.closeSync(fd)}
  try{if(replace){if(old&&!same(old,exists(file)))throw failure();fs.renameSync(temporary,file)}else{fs.linkSync(temporary,file);fs.unlinkSync(temporary)}const folder=fs.openSync(path.dirname(file),fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{fs.fsyncSync(folder)}finally{fs.closeSync(folder)}}finally{try{fs.unlinkSync(temporary)}catch(error){if(error.code!=='ENOENT')throw failure()}}
}
function listFiles(root){const files=[];const visit=prefix=>{for(const name of fs.readdirSync(path.join(root,prefix)).sort()){const relative=prefix?prefix+'/'+name:name,target=path.join(root,...relative.split('/')),stat=exists(target);if(stat.isSymbolicLink())throw failure('原生资料目录包含链接');if(stat.isDirectory()){physical(target,{directory:true,private_mode:true});visit(relative)}else{physical(target,{private_mode:true});files.push(relative)}}};visit('');return files}
function strictJson(bytes){const text=bytes.toString('utf8');if(!Buffer.from(text).equals(bytes))throw failure('资料JSON编码无效');try{return JSON.parse(text)}catch{throw failure('资料JSON格式无效')}}
const schemaRows=db=>db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all().map(row=>({...row,sql:row.sql?.replace(/\s+/g,' ').trim()}))
let expectedSchema
function trustedSchema(){if(!expectedSchema){const db=new DatabaseSync(':memory:');try{db.exec(NATIVE_DDL);expectedSchema=schemaRows(db)}finally{db.close()}}return expectedSchema}

/** Validate the native DB before writable open; imported SQL cannot introduce extra views/triggers/indexes. */
function validateDatabase(file){
  physical(file,{private_mode:true});const db=new DatabaseSync(file,{readOnly:true})
  try{
    db.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF;')
    if(db.prepare('PRAGMA application_id').get().application_id!==NATIVE_APPLICATION_ID||db.prepare('PRAGMA user_version').get().user_version!==NATIVE_SCHEMA_VERSION||encode(schemaRows(db))!==encode(trustedSchema()))throw failure('只接受当前原生schema3资料，不接受旧格式或自定义SQL入口')
    const integrity=db.prepare('PRAGMA integrity_check').all();if(integrity.length!==1||Object.values(integrity[0])[0]!=='ok'||db.prepare('PRAGMA foreign_key_check').all().length)throw failure('原生数据库或引用关系校验失败')
    const counts=Object.fromEntries(NATIVE_TABLES.map(name=>[name,db.prepare('SELECT count(*) AS n FROM '+name).get().n]))
    for(const row of db.prepare('SELECT id,type,schema_id,schema_version,value_json FROM documents').iterate()){if(!identifier(row.id))throw failure('原生文档标识无效');validateDocument({...row,value:strictJson(Buffer.from(row.value_json))})}
    const profiles=new Map(db.prepare('SELECT id,platform FROM persona_profiles').all().map(row=>[row.id,row.platform]))
    for(const table of ['persona_profiles','persona_versions'])for(const row of db.prepare('SELECT * FROM '+table).iterate()){
      validatePersona({id:row.profile_id??row.id,platform:row.platform??profiles.get(row.profile_id),follow_main:row.follow_main===1,main_profile_id:row.main_profile_id,name:row.name,self_ref:row.self_ref,owner_address:row.owner_address,body_md:row.body_md,traits:JSON.parse(row.traits_json),voice:JSON.parse(row.voice_json)})
      if(!timestamp(row.created_at)||row.updated_at!==undefined&&!timestamp(row.updated_at))throw failure('人格版本时间无效')
    }
    for(const row of db.prepare('SELECT id,platform,kind,status,request_digest,body_digest,CAST(body AS BLOB) AS bytes,target_json,receipt_json,metadata_json FROM actions').iterate()){
      if(!identifier(row.id)||sha(row.bytes)!==row.body_digest||!Buffer.from(Buffer.from(row.bytes).toString('utf8')).equals(Buffer.from(row.bytes)))throw failure('动作原稿摘要、编码或标识不一致')
      if(row.kind==='model.money')validateMoneyRecord(row)
      if(row.status==='confirmed'&&outboxRow(row))confirmedReceipt(row)
    }
    const graph={entity:'entities',evidence:'evidence',memory_entry:'memory_entries',journal_event:'journal_events',action:'actions',asset:'assets',document:'documents',persona_profile:'persona_profiles',persona_version:'persona_versions'}
    for(const row of db.prepare('SELECT subject_kind,subject_id,object_kind,object_id FROM relations').iterate())for(const [kind,id]of [[row.subject_kind,row.subject_id],[row.object_kind,row.object_id]])if(graph[kind]&&!db.prepare('SELECT 1 FROM '+graph[kind]+' WHERE id=?').get(id))throw failure('原生资料关系存在悬空引用')
    return {counts,assets:db.prepare('SELECT id,relative_path,sha256,byte_size FROM assets ORDER BY id').all(),resources:resourceManifest(db)}
  }catch(error){if(error.message?.startsWith('只接受')||error.message?.startsWith('原生')||error.message?.startsWith('人格')||error.message?.startsWith('动作'))throw error;throw failure('原生数据库字段或schema不受支持')}
  finally{db.close()}
}
function resourceManifest(db){
  const refs=new Map(),add=(kind,ref)=>{if(typeof ref==='string'&&ref)refs.set(kind+'\0'+ref,{kind,ref,portable:false,requires_host_binding:true})}
  for(const row of db.prepare("SELECT type,value_json FROM documents WHERE type IN ('platform_settings','conversation_binding','session_policy')").all()){
    const value=JSON.parse(row.value_json)
    if(row.type==='platform_settings'){
      add('workspace',value.qq?.conversation?.workspace_id);add('interpreter',value.qq?.media?.interpreter_ref);add('command',value.qq?.media?.stt_command_ref);for(const font of value.qq?.media?.font_files??[])add('font',font)
      add('interpreter',value.bilibili?.transcription?.interpreter_ref)
    }else{add('workspace',value.workspace_id);add('host_session',value.session_id)}
  }
  return {schema_id:'companion.resource_manifest',schema_version:1,bindings:[...refs.values()].sort((a,b)=>(a.kind+a.ref).localeCompare(b.kind+b.ref)),runtime_code_included:false,legacy_fallback:false}
}
const countsOf=(info,entries)=>({files:entries.length,bytes:entries.reduce((n,row)=>n+row.byte_size,0),assets:info.counts.assets,documents:info.counts.documents,personas:info.counts.persona_profiles,memories:info.counts.memory_entries,people:info.counts.entities,journal_events:info.counts.journal_events,actions:info.counts.actions,secret_records:entries.filter(row=>row.role==='secret_record').length})
function entryRole(name){if(name===DB_ENTRY)return 'database';if(/^assets\/[a-f0-9]{64}\.[a-z0-9]{1,12}$/.test(name))return 'asset';if(name==='.secrets/.integrity-key')return 'secret_key';if(/^\.secrets\/[a-f0-9]{64}\.json$/.test(name))return 'secret_record';return null}
function manifestShape(value){
  fields(value,['schema_id','schema_version','native_format','native_schema_version','exported_at','include_credentials','database_entry','schema_fingerprint','entries','counts','tables','resources'])
  if(value.schema_id!==FORMAT||value.schema_version!==VERSION||value.native_format!==NATIVE_FORMAT||value.native_schema_version!==NATIVE_SCHEMA_VERSION||value.database_entry!==DB_ENTRY||value.schema_fingerprint!==sha(NATIVE_DDL.replace(/\s+/g,' ').trim())||!timestamp(value.exported_at)||typeof value.include_credentials!=='boolean'||!Array.isArray(value.entries))throw failure('资料包不是受支持的全新原生格式')
  const seen=new Set();for(const row of value.entries){fields(row,['path','sha256','byte_size','role']);const role=entryRole(safeZipName(row.path));if(!role||role!==row.role||seen.has(row.path)||!Number.isSafeInteger(row.byte_size)||row.byte_size<0||!/^[a-f0-9]{64}$/.test(row.sha256)||!value.include_credentials&&role.startsWith('secret_'))throw failure('资料包含未知入口或重复项目');seen.add(row.path)}
  if(!seen.has(DB_ENTRY)||[...seen].some(name=>/^\.secrets\/[a-f0-9]{64}\.json$/.test(name))&&!seen.has('.secrets/.integrity-key'))throw failure('原生数据库或完整私密资源缺失')
}
function manifestOf(files){
  const bytes=files.get(MANIFEST);if(!bytes||bytes.length>4*1024*1024)throw failure('缺少原生资料包manifest')
  const value=strictJson(bytes);manifestShape(value);if(value.entries.length!==files.size-1)throw failure('资料包入口数量不一致')
  const seen=new Set()
  for(const row of value.entries){fields(row,['path','sha256','byte_size','role']);const role=entryRole(safeZipName(row.path)),data=files.get(row.path);if(!role||role!==row.role||seen.has(row.path)||!data||!Number.isSafeInteger(row.byte_size)||row.byte_size!==data.length||sha(data)!==row.sha256||!value.include_credentials&&role.startsWith('secret_'))throw failure('资料包包含未知入口、重复项目或SHA不符');seen.add(row.path)}
  if(!seen.has(DB_ENTRY)||value.include_credentials&&[...seen].some(name=>name.startsWith('.secrets/'))&&!seen.has('.secrets/.integrity-key'))throw failure('原生数据库或完整私密资源缺失')
  return {value,bytes}
}

/** Interrupted imported work is never retried. The original ledger is retained in immutable owner events. */
function recoverRuntime(store,{now,restore_id}){
  const report={model_reservations:0,unknown_actions:0,archived_process_leases:0,cache_entries:0},policyId=store.getDocument('settings')?.value.activity_document_id??'activity',budget=new NativeBudget({store,now:()=>now,policy_document_id:policyId})
  store.transaction(()=>{
    const rows=store.db.prepare('SELECT id,platform,kind,status,approval_token,updated_at,metadata_json FROM actions ORDER BY id').all()
    for(const row of rows){const metadata=JSON.parse(row.metadata_json),openModel=row.kind==='model.reservation'&&metadata.reservation_open===true,active=['leased','running','submitting','submitted','reserved'].includes(row.status)
      if(!openModel&&!active&&!metadata.lease_token&&!metadata.lease_until)continue
      const history={action_id:row.id,kind:row.kind,previous_status:row.status,previous_updated_at:row.updated_at,previous_metadata:{...metadata},previous_approval_digest:row.approval_token?sha(row.approval_token):'',restore_id}
      if(history.previous_metadata.lease_token){history.previous_metadata.lease_token_digest=sha(String(history.previous_metadata.lease_token));delete history.previous_metadata.lease_token}
      store.appendJournalEvent({event_key:'portable:'+restore_id+':previous:'+row.id,event_type:'log',platform:row.platform||'system',direction:'internal',status:'recorded',visibility:'owner',text:'导入前的运行状态原账；此记录不授权继续原执行。',source_at:now,source_type:'native_portable_restore',recorded_at:now,metadata:history})
      if(openModel){budget.finish(row.id,{outcome:'unknown'});report.model_reservations++}
      const current=store.db.prepare('SELECT status,metadata_json FROM actions WHERE id=?').get(row.id),next=JSON.parse(current.metadata_json),processOnly=row.kind==='qq.binding'
      if(next.lease_token!==undefined)next.lease_token='';if(next.lease_until!==undefined)next.lease_until=0
      next.restore={restore_id,previous_status:row.status,original_process_resume:false,queued_execution_preserved:!active&&!openModel,restored_at:now}
      const status=openModel?current.status:active?processOnly?'cancelled':'unknown':current.status
      store.db.prepare('UPDATE actions SET status=?,approval_token=?,updated_at=?,metadata_json=? WHERE id=?').run(status,active?'':row.approval_token,now,stringifyJson(next),row.id)
      if(active&&!openModel){if(processOnly)report.archived_process_leases++;else report.unknown_actions++}
    }
    if(store.getDocument('hormone-state')?.value.rounds?.length)report.hormone_rounds=new NativeHormone({store,now:()=>now}).settlePending({key:'portable:'+restore_id}).settled
    report.cache_entries=store.db.prepare('SELECT count(*) AS n FROM cache_entries').get().n;store.db.prepare('DELETE FROM cache_entries').run()
    store.appendJournalEvent({event_key:'portable:'+restore_id+':completed',event_type:'log',platform:'system',direction:'internal',status:'recorded',visibility:'owner',text:'原生资料已完成离线恢复整理；未确认执行归档，未重放请求或虚构退款。',source_at:now,source_type:'native_portable_restore',recorded_at:now,metadata:{restore_id,...report,queued_and_draft_preserved:true}})
  })
  return report
}

const jsonObject=value=>{const parsed=JSON.parse(value);if(!isPlainObject(parsed))throw failure('原生运行元数据无效');return parsed}
function liveProgress(store){return store.transaction(()=>({
  actions:store.db.prepare('SELECT *,CAST(body AS BLOB) AS body_bytes FROM actions ORDER BY id').all().map(row=>{const bytes=Buffer.from(row.body_bytes),body=bytes.toString('utf8');if(!Buffer.from(body).equals(bytes))throw failure('当前动作原文编码无法保真');const {body_bytes,...rest}=row;return {...rest,body}}),
  quotas:store.db.prepare("SELECT id,value_json FROM documents WHERE type='quota' AND json_extract(value_json,'$.platform')='system' AND json_extract(value_json,'$.category')='activity' AND json_extract(value_json,'$.metric') IN ('tokens','wakes')").all().map(row=>({id:row.id,value:JSON.parse(row.value_json)})),
  money_policy:store.getDocument(store.getDocument('settings')?.value.activity_document_id??'activity')?.value.budget,
}))}
function archiveMetadata(value){const metadata=clone(value);for(const field of ['lease_token','authorization','approval_token'])if(Object.hasOwn(metadata,field)){metadata[field+'_digest']=sha(String(metadata[field]));delete metadata[field]}return metadata}
const activeStatuses=new Set(['leased','running','submitting','submitted','reserved'])
const authoritativeStatuses=new Set(['confirmed','unknown','blocked','cancelled','expired'])
const internalTerminals=new Set(['completed','delivered','failed','skipped'])
const outboxRow=row=>row.kind.startsWith(row.platform+'.')&&!jsonObject(row.metadata_json).record_type&&!['qq.turn','qq.session','qq.binding','qq.command','qq.inbound'].includes(row.kind)
function mergeProgress(store,current,{now,restore_id}){
  const report={status_high_water:0,archived_current_actions:0,budget_days:0,budget_token_floor:0,budget_wake_floor:0},conflicts=[]
  const stages=store.db.prepare('SELECT *,CAST(body AS BLOB) AS body_bytes FROM actions').all(),byId=new Map(current.actions.map(row=>[row.id,row])),byDigest=new Map()
  for(const row of current.actions){const list=byDigest.get(row.request_digest)??[];list.push(row);byDigest.set(row.request_digest,list)}
  for(const row of stages){const latest=byId.get(row.id);if(latest&&(latest.request_digest!==row.request_digest||latest.platform!==row.platform||latest.kind!==row.kind||outboxRow(row)&&(latest.body_digest!==row.body_digest||encode(JSON.parse(latest.target_json))!==encode(JSON.parse(row.target_json)))))conflicts.push({action_id:row.id,code:'same_id_different_frozen_request'})}
  if(conflicts.length){const error=failure('当前资料与包内同ID动作内容冲突，未猜测或覆盖');Object.defineProperty(error,'conflicts',{value:conflicts});throw error}
  return store.transaction(()=>{
    const stageIds=new Set(stages.map(row=>row.id)),dedupeArchive=(row)=>{
      const metadata=jsonObject(row.metadata_json),archive={action_id:row.id,platform:row.platform,kind:row.kind,target:JSON.parse(row.target_json),request_digest:row.request_digest,body_digest:row.body_digest,status:row.status,receipt:JSON.parse(row.receipt_json),source_evidence_id:row.source_evidence_id,created_at:row.created_at,updated_at:row.updated_at,not_before:row.not_before,submitted_at:row.submitted_at,confirmed_at:row.confirmed_at,metadata:archiveMetadata(metadata),approval_digest:row.approval_token?sha(row.approval_token):'',live_replay_allowed:false},key='portable:'+restore_id+':current:'+sha(encode(archive)+'\0'+row.body)
      if(!store.db.prepare('SELECT id FROM journal_events WHERE event_key=?').get(key)){store.appendJournalEvent({event_key:key,event_type:'log',platform:row.platform,direction:'internal',status:'recorded',visibility:'owner',text:row.body,source_at:row.updated_at,source_type:'native_portable_restore',recorded_at:now,metadata:{subtype:'current_action_archive',restore_id,...archive}});report.archived_current_actions++}
    }
    const stageById=new Map(stages.map(row=>[row.id,row]))
    if(current.money_policy?.money_budget_enabled){const id=store.getDocument('settings')?.value.activity_document_id??'activity',doc=store.getDocument(id);if(doc){const budget=doc.value.budget??{},limit=Math.min(current.money_policy.daily_cost_limit_fen??500,budget.daily_cost_limit_fen??500);store.putDocument({id,type:'activity',expected_revision:doc.revision,value:{...doc.value,budget:{...budget,money_budget_enabled:true,daily_cost_limit_fen:limit}}})}}
    const moneyIds=new Set([...stages,...current.actions].filter(row=>row.kind==='model.money').map(row=>row.id))
    for(const id of moneyIds){
      const stage=stageById.get(id),present=current.actions.find(row=>row.id===id),rows=[stage,present].filter(Boolean),chosen=rows.sort((a,b)=>effectiveMoneyNano(jsonObject(b.metadata_json))-effectiveMoneyNano(jsonObject(a.metadata_json))||b.updated_at-a.updated_at)[0],m=validateMoneyRecord(chosen),floor=Math.max(...rows.map(row=>effectiveMoneyNano(jsonObject(row.metadata_json)))),known=!m.reservation_open&&m.usage_known&&m.charged_nano===floor
      const value={...m,reservation_open:false,reserved_nano:0,charged_nano:floor,usage_known:known,lease_until:0,restore_high_water:true},status=known?'confirmed':floor?'unknown':'cancelled'
      if(stage)store.db.prepare('UPDATE actions SET status=?,updated_at=?,metadata_json=? WHERE id=?').run(status,now,stringifyJson(value),id)
      else store.db.prepare('INSERT INTO actions(id,platform,kind,target_json,body,body_digest,request_digest,status,created_at,updated_at,metadata_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id,chosen.platform,'model.money',chosen.target_json,'',sha(''),chosen.request_digest,status,chosen.created_at,now,stringifyJson(value))
    }
    for(const row of current.actions){const previous=stageById.get(row.id);if(!stageIds.has(row.id)||['status','metadata_json','receipt_json','body_digest','updated_at','confirmed_at','submitted_at'].some(field=>row[field]!==previous[field]))dedupeArchive(row)}
    for(const row of stages){
      const metadata=jsonObject(row.metadata_json),eligible=['draft','queued','leased','running','submitting','submitted','reserved'].includes(row.status)||row.status==='unknown'&&metadata.restore?.original_process_resume===false||metadata.restore_progress?.restore_id===restore_id
      if(!eligible||['model.reservation','model.money'].includes(row.kind))continue
      let latest=byId.get(row.id)
      if(!latest&&outboxRow(row))latest=(byDigest.get(row.request_digest)??[]).filter(candidate=>outboxRow(candidate)&&candidate.platform===row.platform&&candidate.kind===row.kind&&candidate.body_digest===row.body_digest&&encode(JSON.parse(candidate.target_json))===encode(JSON.parse(row.target_json))&&(candidate.status==='confirmed'||candidate.status==='unknown'||activeStatuses.has(candidate.status)))
        .sort((a,b)=>(b.status==='confirmed')-(a.status==='confirmed')||b.updated_at-a.updated_at)[0]
      if(!latest||!authoritativeStatuses.has(latest.status)&&!activeStatuses.has(latest.status)&&!internalTerminals.has(latest.status))continue
      dedupeArchive(latest)
      const status=authoritativeStatuses.has(latest.status)?latest.status:'unknown',receipt=jsonObject(latest.receipt_json)
      if(status==='confirmed')confirmedReceipt(latest)
      const next={...metadata,lease_token:'',lease_until:0,restore_progress:{restore_id,current_action_id:latest.id,current_status:latest.status,current_updated_at:latest.updated_at,original_snapshot_status:row.status,resume_allowed:false}}
      store.db.prepare('UPDATE actions SET status=?,approval_token=?,receipt_json=?,submitted_at=?,confirmed_at=?,updated_at=?,metadata_json=? WHERE id=?').run(status,'',latest.receipt_json,latest.submitted_at,latest.confirmed_at,now,stringifyJson(next),row.id)
      report.status_high_water++
    }
    const floors=new Map(),add=(value)=>{if(!/^\d{4}-\d{2}-\d{2}$/.test(value.day)||!['tokens','wakes'].includes(value.metric)||!Number.isSafeInteger(value.used??0)||!Number.isSafeInteger(value.reserved??0)||(value.used??0)<0||(value.reserved??0)<0)throw failure('每日预算高水位无效');const day=floors.get(value.day)??{tokens:0,wakes:0};day[value.metric]=Math.max(day[value.metric],(value.used??0)+(value.metric==='tokens'?value.reserved??0:0));floors.set(value.day,day)}
    for(const row of current.quotas)add(row.value)
    for(const row of store.db.prepare("SELECT value_json FROM documents WHERE type='quota' AND json_extract(value_json,'$.platform')='system' AND json_extract(value_json,'$.category')='activity' AND json_extract(value_json,'$.metric') IN ('tokens','wakes')").all())add(JSON.parse(row.value_json))
    const policy=store.getDocument(store.getDocument('settings')?.value.activity_document_id??'activity')?.value??{}
    for(const[day,floor]of floors){
      const tid='quota:system:activity:tokens:'+day,wid='quota:system:activity:wakes:'+day,tokens=store.getDocument(tid),wakes=store.getDocument(wid),tokenDelta=Math.max(0,floor.tokens-(tokens?.value.used??0)),wakeDelta=Math.max(0,floor.wakes-(wakes?.value.used??0))
      if(!tokenDelta&&!wakeDelta&&!(tokens?.value.reserved??0))continue
      const record='reservation:portable-floor:'+sha(restore_id+'\0'+day).slice(0,40),existing=store.db.prepare('SELECT metadata_json FROM actions WHERE id=?').get(record),previous=existing?jsonObject(existing.metadata_json):null,metadata={schema_version:1,record_type:'model_reservation',platform:'system',kind:'restore_budget_floor',day,reserved_tokens:(previous?.reserved_tokens??0)+tokenDelta,reservation_open:false,actual_known:false,actual_tokens:0,charged_tokens:(previous?.charged_tokens??0)+tokenDelta,wake_charge:0,started:true,lease_until:0,restore_id,conservative_floor:true}
      if(tokenDelta){if(existing)store.db.prepare('UPDATE actions SET updated_at=?,metadata_json=? WHERE id=?').run(now,stringifyJson(metadata),record);else store.db.prepare('INSERT INTO actions(id,platform,kind,target_json,body,body_digest,request_digest,status,created_at,updated_at,metadata_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(record,'system','model.reservation',stringifyJson({restore_id,day}),'',sha(''),sha(record),'unknown',now,now,stringifyJson(metadata))}
      store.putDocument({id:tid,type:'quota',expected_revision:tokens?.revision??0,value:{...(tokens?.value??{platform:'system',category:'activity',metric:'tokens',day,limit:policy.budget?.daily_token_limit??300000}),used:Math.max(tokens?.value.used??0,floor.tokens),reserved:0}})
      store.putDocument({id:wid,type:'quota',expected_revision:wakes?.revision??0,value:{...(wakes?.value??{platform:'system',category:'activity',metric:'wakes',day,limit:policy.budget?.daily_wake_limit??18}),used:Math.max(wakes?.value.used??0,floor.wakes),reserved:0}})
      store.appendJournalEvent({event_key:'portable:'+restore_id+':budget-floor:'+sha(encode([day,floor,metadata.charged_tokens])),event_type:'log',platform:'system',direction:'internal',status:'unknown',visibility:'owner',text:'导入采用同日预算高水位最大值，未将重叠消费相加；差额保守占额，不代表已核实费用。',source_at:now,source_type:'native_portable_restore',recorded_at:now,metadata:{restore_id,day,source:'current_and_bundle_max',previous_tokens:tokens?.value??null,previous_wakes:wakes?.value??null,current_floor:floor,token_delta:tokenDelta,wake_delta:wakeDelta}})
      report.budget_days++;report.budget_token_floor+=tokenDelta;report.budget_wake_floor+=wakeDelta
    }
    return report
  })
}

export class NativePortable{
  constructor(options={}){
    fields(options,['store','assets','secrets','now','assert_quiescent','backup_rate'])
    if(!(options.store instanceof NativeStore)||options.now!==undefined&&typeof options.now!=='function'||options.assert_quiescent!==undefined&&typeof options.assert_quiescent!=='function'||options.assets&&options.assets.store!==options.store||options.secrets&&options.secrets.store!==options.store)throw failure('搬家资源必须使用同一个NativeStore')
    this.store=options.store;this.file=this.store.file;this.root=path.dirname(this.file);this.dbName=path.basename(this.file);this.files=nativeResourceFiles(this.store);this.assets=options.assets??new NativeAssets({store:this.store});this.secrets=options.secrets??new NativeSecrets({store:this.store});this.now=options.now??this.store.now;this.assertQuiescent=options.assert_quiescent
    this.rate=options.backup_rate??100;if(!Number.isSafeInteger(this.rate)||this.rate<1||this.rate>10000)throw failure('快照速率无效')
    this.control=path.join(path.dirname(this.root),'.native-portable-'+sha(this.file).slice(0,16));this.busy=false
  }
  _now(){const at=this.now();if(!timestamp(at))throw failure('搬家时钟无效');return at}
  _control(){if(!exists(this.control))mkdir(this.control);physical(this.control,{directory:true,private_mode:true});return this.control}
  _folder(name){if(!/^[a-z][a-z0-9-]{0,100}$/.test(name))throw failure();return mkdir(path.join(this._control(),name))}
  _pending(){return path.join(this._control(),'pending.json')}
  async _exclusive(work){
    if(this.busy)throw failure('已有原生搬家操作正在处理');this.busy=true;const lock=path.join(this._control(),'.operation.lock');let fd,stat
    try{
      try{fd=fs.openSync(lock,'wx',0o600)}catch(openError){
        if(openError.code!=='EEXIST')throw openError
        const before=physical(lock,{private_mode:true}),old=strictJson(readFile(lock,4096));fields(old,['schema_id','schema_version','pid','root_sha256','nonce'])
        if(old.schema_id!=='companion.portable_lock'||old.schema_version!==1||old.root_sha256!==sha(this.file)||!Number.isSafeInteger(old.pid)||old.pid<1)throw failure('搬家锁无法核对，未覆盖')
        let dead=false;try{process.kill(old.pid,0)}catch(error){dead=error.code==='ESRCH'}
        if(!dead||!same(before,exists(lock)))throw failure('其他原生搬家操作尚未结束')
        fs.unlinkSync(lock);fd=fs.openSync(lock,'wx',0o600)
      }
      stat=fs.fstatSync(fd);fs.writeFileSync(fd,encode({schema_id:'companion.portable_lock',schema_version:1,pid:process.pid,root_sha256:sha(this.file),nonce:randomUUID()}));fs.fsyncSync(fd);return await work()
    }finally{if(fd!==undefined){fs.closeSync(fd);if(same(stat,exists(lock)))try{fs.unlinkSync(lock)}catch{}}this.busy=false}
  }
  _vault(){
    const dir=this.secrets.files.directory('.secrets');if(!dir)return new Map()
    const result=new Map(),names=fs.readdirSync(dir).sort();if(names.some(name=>name!=='.integrity-key'&&!/^[a-f0-9]{64}\.json$/.test(name)))throw failure('登录资源含未知项目或正在写入，请稍后重试')
    for(const name of names){const row=this.secrets.files.read('.secrets',name,name==='.integrity-key'?32:1024*1024+65536);if(!row)throw failure('登录资源在快照期间变化');if(name==='.integrity-key'&&row.bytes.length!==32)throw failure('私密资源根密钥不完整');if(name.endsWith('.json')){const record=strictJson(row.bytes);if(record.schema_id!=='companion.secret_record'||typeof record.envelope?.secret_ref!=='string'||sha(record.envelope.secret_ref)+'.json'!==name)throw failure('私密资源记录格式无效');this.secrets.get(record.envelope.secret_ref)}result.set('.secrets/'+name,row.bytes)}
    return result
  }
  async _snapshot({include_credentials=false,output_path}={}){
    this.store._open();if(this.store._depth)throw failure('导出不能在SQL事务内部执行')
    if(output_path!==undefined){if(typeof output_path!=='string'||!path.isAbsolute(output_path)||path.resolve(output_path)!==output_path||output_path===this.file||output_path.startsWith(this.root+path.sep))throw failure('搬家包必须选择在线根外的规范路径');physical(path.dirname(output_path),{directory:true})}
    const temp=fs.mkdtempSync(path.join(this._folder('staging'),'export-'));fs.chmodSync(temp,0o700);let snapshot
    try{
      const vault=include_credentials?this._vault():new Map(),snapshotPath=path.join(temp,DB_ENTRY)
      await sqliteBackup(this.store.db,snapshotPath,{rate:this.rate});fs.chmodSync(snapshotPath,0o600);validateDatabase(snapshotPath)
      snapshot=new NativeStore({file:snapshotPath});snapshot.db.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE;');snapshot.close();snapshot=null
      const info=validateDatabase(snapshotPath),files=new Map([[DB_ENTRY,readFile(snapshotPath)]])
      for(const row of info.assets){const asset=this.assets.read(row.id);if(asset.sha256!==row.sha256||asset.byte_size!==row.byte_size||asset.relative_path!==row.relative_path)throw failure('素材在快照期间变化');files.set(row.relative_path,asset.bytes)}
      if(include_credentials){const after=this._vault();if(encode([...vault].map(([name,value])=>[name,sha(value)]))!==encode([...after].map(([name,value])=>[name,sha(value)])))throw failure('登录态在导出期间变化，请重试');for(const entry of vault)files.set(...entry)}
      const entries=[...files].map(([name,bytes])=>({path:name,sha256:sha(bytes),byte_size:bytes.length,role:entryRole(name)})),counts=countsOf(info,entries),manifest={schema_id:FORMAT,schema_version:VERSION,native_format:NATIVE_FORMAT,native_schema_version:NATIVE_SCHEMA_VERSION,exported_at:this._now(),include_credentials,database_entry:DB_ENTRY,schema_fingerprint:sha(NATIVE_DDL.replace(/\s+/g,' ').trim()),entries,counts,tables:info.counts,resources:info.resources}
      files.set(MANIFEST,Buffer.from(encode(manifest)+'\n'))
      const output=output_path??path.join(this._folder('exports'),'companion-'+this._now()+'-'+randomUUID()+'.zip');physical(path.dirname(output),{directory:true,private_mode:output_path===undefined});if(output===this.file||output.startsWith(this.root+path.sep))throw failure('搬家包必须放在在线根目录之外')
      writeFile(output,makeNativeZip(files),{private_parent:output_path===undefined});return {bundle_path:output,counts,include_credentials,resources_need_binding:info.resources.bindings.length}
    }finally{snapshot?.close();fs.rmSync(temp,{recursive:true,force:true})}
  }
  exportBundle(options={}){fields(options,['include_credentials','output_path']);if(options.include_credentials!==undefined&&typeof options.include_credentials!=='boolean')throw failure('是否包含登录态必须为明确布尔值');return this._exclusive(()=>this._snapshot(options))}
  _verifyRoot(root,manifest){
    manifestShape(manifest);physical(root,{directory:true,private_mode:true});const info=validateDatabase(path.join(root,this.dbName)),expected=new Map(manifest.entries.map(row=>[row.path===DB_ENTRY?this.dbName:row.path,row]))
    const actual=listFiles(root);if(actual.length!==expected.size||actual.some(name=>!expected.has(name)))throw failure('隔离资料含未登记项目')
    for(const [name,row]of expected){const bytes=readFile(path.join(root,...name.split('/')));if(bytes.length!==row.byte_size||sha(bytes)!==row.sha256)throw failure('隔离资料SHA或大小不符')}
    const declared=manifest.entries.filter(row=>row.role==='asset');if(declared.length!==info.assets.length||info.assets.some(row=>{const entry=expected.get(row.relative_path);return !entry||entry.role!=='asset'||entry.sha256!==row.sha256||entry.byte_size!==row.byte_size||row.id!=='asset:'+row.sha256}))throw failure('SQLite登记素材与包内字节不一致')
    let reader
    if(encode(info.counts)!==encode(manifest.tables)||encode(countsOf(info,manifest.entries))!==encode(manifest.counts)||encode(info.resources)!==encode(manifest.resources))throw failure('原生资料统计或资源声明与数据库不符')
    try{reader=new NativeStore({file:path.join(root,this.dbName),readOnly:true});const media=new NativeAssets({store:reader});for(const asset of info.assets)media.read(asset.id);if(manifest.include_credentials){const vault=new NativeSecrets({store:reader});if(actual.includes('.secrets/.integrity-key')&&readFile(path.join(root,'.secrets','.integrity-key'),32).length!==32)throw failure('私密资源根密钥不完整');for(const name of actual.filter(name=>/^\.secrets\/[a-f0-9]{64}\.json$/.test(name))){const record=strictJson(readFile(path.join(root,name)));if(record.schema_id!=='companion.secret_record'||typeof record.envelope?.secret_ref!=='string'||sha(record.envelope.secret_ref)+'.json'!==path.basename(name))throw failure('私密资源引用与文件名不符');vault.get(record.envelope.secret_ref)}}}finally{reader?.close()}
    return info
  }
  _refreshStage(stage,manifest,current,restore_id){
    let store,report
    try{store=new NativeStore({file:path.join(stage,this.dbName)});report=mergeProgress(store,current,{now:this._now(),restore_id});store.db.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE;')}finally{store?.close()}
    const info=validateDatabase(path.join(stage,this.dbName)),data=readFile(path.join(stage,this.dbName)),entries=manifest.entries.map(row=>row.role==='database'?{...row,sha256:sha(data),byte_size:data.length}:row),updated={...manifest,entries,tables:info.counts,counts:countsOf(info,entries),resources:info.resources}
    this._verifyRoot(stage,updated);return {manifest:updated,report}
  }
  _verifyAppliedRoot(marker){
    validateDatabase(this.file);let reader
    try{
      reader=new NativeStore({file:this.file,readOnly:true})
      if(!reader.db.prepare("SELECT id FROM journal_events WHERE event_key=? AND source_type='native_portable_restore'").get('portable:'+marker.restore_id+':completed'))throw failure('当前资料不属于已准备的恢复，未猜测覆盖')
      const assets=new NativeAssets({store:reader});for(const row of reader.db.prepare('SELECT id FROM assets').all())assets.read(row.id)
    }finally{reader?.close()}
  }
  async importBundle(options={}){
    fields(options,['bundle_path','confirmed']);const {bundle_path,confirmed=false}=options
    if(confirmed!==true)throw failure('必须由主人明确确认导入这个资料包')
    return this._exclusive(async()=>{
      this.store._open();if(this.store._depth)throw failure('导入不能在SQL事务内部执行');if(exists(this._pending()))throw failure('已有待重启导入，未覆盖之前的选择')
      const input=readFile(bundle_path,ZIP_LIMITS.max_archive_bytes,{private_mode:false}),files=readNativeZip(input),source=manifestOf(files),id='restore-'+randomUUID(),directory=mkdir(path.join(this._folder('restores'),id)),stage=mkdir(path.join(directory,'native-root'));let stagedStore,accepted=false
      try{
        for(const row of source.value.entries){const relative=row.path===DB_ENTRY?this.dbName:row.path,target=path.join(stage,...relative.split('/'));if(path.dirname(target)!==stage&&!exists(path.dirname(target)))mkdir(path.dirname(target));writeFile(target,files.get(row.path))}
        const info=this._verifyRoot(stage,source.value);if(encode(info.counts)!==encode(source.value.tables)||encode(countsOf(info,source.value.entries))!==encode(source.value.counts)||encode(info.resources)!==encode(source.value.resources))throw failure('资料包统计或资源声明与数据库不符')
        stagedStore=new NativeStore({file:path.join(stage,this.dbName)});const recovery=recoverRuntime(stagedStore,{now:this._now(),restore_id:id});stagedStore.db.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE;');stagedStore.close();stagedStore=null
        const preparedEntries=source.value.entries.map(row=>row.role==='database'?{...row,sha256:sha(readFile(path.join(stage,this.dbName))),byte_size:fs.statSync(path.join(stage,this.dbName)).size}:row),after=validateDatabase(path.join(stage,this.dbName)),prepared={...source.value,entries:preparedEntries,tables:after.counts,counts:countsOf(after,preparedEntries),resources:after.resources};this._verifyRoot(stage,prepared)
        const backup=await this._snapshot({include_credentials:true,output_path:path.join(this._folder('backups'),'before-import-'+this._now()+'-'+randomUUID()+'.zip')})
        const refreshed=this._refreshStage(stage,prepared,liveProgress(this.store),id);Object.assign(recovery,{current_progress:refreshed.report})
        const preparedBytes=Buffer.from(encode(refreshed.manifest)+'\n');writeFile(path.join(directory,'prepared-manifest.json'),preparedBytes);writeFile(path.join(directory,'source-manifest.json'),source.bytes)
        const marker={schema_id:'companion.pending_restore',schema_version:1,restore_id:id,target_file_sha256:sha(this.file),target_db_name:this.dbName,prepared_manifest_sha256:sha(preparedBytes),source_bundle_sha256:sha(input),backup_bundle:path.basename(backup.bundle_path),created_at:this._now(),phase:'prepared',recovery}
        writeFile(this._pending(),Buffer.from(encode(marker)+'\n'));accepted=true;return {accepted:true,pending_restart:true,restore_id:id,backup_path:backup.bundle_path,counts:source.value.counts,recovery,include_credentials:source.value.include_credentials}
      }finally{stagedStore?.close();if(!accepted)fs.rmSync(directory,{recursive:true,force:true})}
    })
  }
  async applyPendingRestore(){
    if(!exists(this.control))return {applied:false,pending:false}
    physical(this.control,{directory:true,private_mode:true});if(!exists(path.join(this.control,'pending.json')))return {applied:false,pending:false}
    const stopped=async()=>{
      if(!this.store.closed||countOpenNativeStores(this.file)>0)throw failure('仍有同进程NativeStore连接，未替换运行中的资料')
      if(this.assertQuiescent){let verdict;try{verdict=await this.assertQuiescent({data_root:this.root,store_file:this.file})}catch{throw failure('宿主仍持有资料目录，导入尚未应用')};if(verdict===false)throw failure('宿主尚未确认全部实例停止')}
    }
    await stopped()
    return this._exclusive(async()=>{
      const pending=this._pending();if(!exists(pending))return {applied:false,pending:false}
      const marker=strictJson(readFile(pending,1024*1024));fields(marker,['schema_id','schema_version','restore_id','target_file_sha256','target_db_name','prepared_manifest_sha256','source_bundle_sha256','backup_bundle','created_at','phase','recovery','before_database_sha256'])
      if(marker.schema_id!=='companion.pending_restore'||marker.schema_version!==1||marker.target_file_sha256!==sha(this.file)||marker.target_db_name!==this.dbName||!/^restore-[a-f0-9-]{36}$/.test(marker.restore_id)||!['prepared','switching','old_moved','new_moved'].includes(marker.phase)||!/^before-import-\d+-[a-f0-9-]{36}\.zip$/.test(marker.backup_bundle))throw failure('待恢复记录无效')
      const directory=path.join(this._folder('restores'),marker.restore_id),manifestPath=path.join(directory,'prepared-manifest.json'),bytes=readFile(manifestPath,4*1024*1024);if(sha(bytes)!==marker.prepared_manifest_sha256)throw failure('隔离恢复声明被改变，未替换')
      let manifest=strictJson(bytes);const stage=path.join(directory,'native-root'),rollback=path.join(this._folder('rollback'),marker.restore_id)
      const update=()=>writeFile(pending,Buffer.from(encode(marker)+'\n'),{replace:true})
      const complete=(interrupted=false)=>{fs.unlinkSync(pending);let cleanup_durable=true;const fd=fs.openSync(this.control,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{fs.fsyncSync(fd)}catch{cleanup_durable=false}finally{fs.closeSync(fd)};return {applied:true,pending:false,restore_id:marker.restore_id,backup_path:path.join(this.control,'backups',marker.backup_bundle),rollback_root:rollback,counts:manifest.counts,recovery:marker.recovery,requires_reopen:true,recovered_interrupted_switch:interrupted,cleanup_durable,cross_process_checked:!!this.assertQuiescent}}
      // A crash after either directory rename is identified by the private marker and verified bytes.
      if(exists(rollback)&&!exists(stage)&&exists(this.root)){if(marker.phase==='prepared')throw failure('恢复目录状态不一致，未猜测覆盖');this._verifyAppliedRoot(marker);await stopped();return complete(true)}
      if(exists(rollback)&&exists(stage)&&!exists(this.root)){if(marker.phase==='prepared')throw failure('恢复目录状态不一致，未猜测覆盖');this._verifyRoot(stage,manifest);if(marker.before_database_sha256&&sha(readFile(path.join(rollback,this.dbName)))!==marker.before_database_sha256)throw failure('恢复前原件校验失败，未继续切换');await stopped();fs.renameSync(stage,this.root);this._verifyRoot(this.root,manifest);return complete(true)}
      if(exists(rollback)||!exists(stage)||!exists(this.root))throw failure('恢复目录组合无法确认，全部原件已保留')
      this._verifyRoot(stage,manifest)
      let currentReader,progress
      try{currentReader=new NativeStore({file:this.file,readOnly:true});progress=liveProgress(currentReader)}finally{currentReader?.close()}
      const refreshed=this._refreshStage(stage,manifest,progress,marker.restore_id);manifest=refreshed.manifest;const preparedBytes=Buffer.from(encode(manifest)+'\n');writeFile(manifestPath,preparedBytes,{replace:true});marker.prepared_manifest_sha256=sha(preparedBytes);marker.recovery.current_progress_at_restart=refreshed.report;marker.before_database_sha256=sha(readFile(this.file));marker.phase='switching';update()
      await stopped();if(countOpenNativeStores(this.file)>0)throw failure('恢复期间出现新的NativeStore连接，未替换')
      physical(this.root,{directory:true,private_mode:true});let movedOld=false,movedNew=false
      try{fs.renameSync(this.root,rollback);movedOld=true;marker.phase='old_moved';update();fs.renameSync(stage,this.root);movedNew=true;marker.phase='new_moved';update();this._verifyRoot(this.root,manifest);return complete()}
      catch{if(movedNew)try{fs.renameSync(this.root,stage)}catch{throw failure('资料切换未完成，保留两套私有目录，请勿启动写入')};if(movedOld)fs.renameSync(rollback,this.root);throw failure('资料切换失败，已恢复旧目录，未重放任务')}
    })
  }
}

/** Entry-point bootstrap only: call with the configured native file before opening any live store.
 * No alternative database filename or staging runtime authority is ever selected. */
export async function applyPendingRestore({store_file,now=Date.now,assert_quiescent}={}){
  if(typeof store_file!=='string'||!path.isAbsolute(store_file)||path.resolve(store_file)!==store_file||store_file.includes('\0')||typeof now!=='function'||assert_quiescent!==undefined&&typeof assert_quiescent!=='function')throw failure('启动恢复需要明确原生数据库路径')
  physical(path.dirname(path.dirname(store_file)),{directory:true})
  const operation=Object.create(NativePortable.prototype);Object.assign(operation,{store:{file:store_file,closed:true},file:store_file,root:path.dirname(store_file),dbName:path.basename(store_file),control:path.join(path.dirname(path.dirname(store_file)),'.native-portable-'+sha(store_file).slice(0,16)),now,assertQuiescent:assert_quiescent,busy:false})
  return operation.applyPendingRestore()
}
