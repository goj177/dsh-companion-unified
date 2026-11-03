import { createHash,randomUUID } from 'node:crypto'
import { NativeStore } from './store.mjs'
import { fields,choice,page,identifier,timestamp,safeText,visible,contextOf } from './memory-rules.mjs'
import { shanghaiTime } from '../policy.mjs'

const sha=value=>createHash('sha256').update(value).digest('hex')

/** Two native journals. Writing either one never publishes to a platform. */
export class NativeDiary {
  constructor({store,now=Date.now}={}){if(!(store instanceof NativeStore)||typeof now!=='function')throw new Error('日记需显式原生存储');this.store=store;this.now=now}
  _enabled(platform,kind){
    if(this.store.getDocument('settings')?.value.enabled===false)return false
    const doc=this.store.getDocument(platform)?.value
    if(doc?.enabled===false)return false
    const settings=doc?.[platform]?.diary
    return kind==='private'?settings?.private_enabled!==false:settings?.enabled!==false
  }
  status(trusted_context={}){
    const context=contextOf(trusted_context),counts={public:0,private:0}
    for(const row of this.store.db.prepare("SELECT platform,visibility,conversation_id,metadata_json FROM journal_events WHERE event_type='diary'").all()){
      const metadata=JSON.parse(row.metadata_json),kind=metadata.diary_kind
      if(['public','private'].includes(kind)&&visible(row,context))counts[kind]++
    }
    const platforms=Object.fromEntries(['bilibili','tieba','qq'].map(p=>[p,{public:this._enabled(p,'public'),private:this._enabled(p,'private')}]))
    return {enabled:Object.values(platforms).some(row=>row.public||row.private),counts,platforms}
  }
  write(input,trusted_context={}){
    fields(input,['platform','kind','text','evidence_ids','source_at','idempotency_key'],'日记')
    const platform=choice(input.platform,['qq','tieba','bilibili','harness'],'platform'),kind=choice(input.kind,['public','private'],'kind')
    const text=safeText(input.text,'text',64000,true);if(!text.trim())throw new Error('日记内容不能为空')
    const context=contextOf(trusted_context)
    if(kind==='public'&&['tieba','bilibili'].includes(trusted_context.platform)&&/^dm:/.test(trusted_context.conversation_id??''))throw new Error('私信上下文不得写入公开日记')
    if(!this._enabled(platform,kind))return {written:false,status:'disabled'}
    if(!Array.isArray(input.evidence_ids??[])||(input.evidence_ids??[]).length>100)throw new Error('日记来源数量无效')
    const ids=[...new Set(input.evidence_ids??[])].sort();ids.forEach(id=>identifier(id))
    const key=input.idempotency_key??randomUUID();if(typeof key!=='string'||!key||key.length>512||/[\0\r\n]/.test(key))throw new Error('日记标识无效')
    const eventKey='diary:'+platform+':'+kind+':'+key,id='diary-'+sha(eventKey)
    return this.store.transaction(()=>{
      for(const evidenceId of ids){const row=this.store.db.prepare('SELECT * FROM evidence WHERE id=?').get(evidenceId)
        if(!row||!visible(row,context))throw new Error('日记引用的来源不存在或当前会话无权限')
        if(kind==='public'&&(row.visibility!=='public'||row.status!=='confirmed'))throw new Error('公开日记只能引用已确认读取的公开来源；私人内容请写入私密日记')
      }
      const old=this.store.getJournalEvent(id),at=input.source_at===undefined?old?.source_at??timestamp(this.now(),'日记时钟'):timestamp(input.source_at,'source_at')
      const row=this.store.appendJournalEvent({id,event_key:eventKey,event_type:'diary',platform,direction:'internal',status:'recorded',visibility:kind==='private'?'owner':'public',
        text,source_at:at,source_type:'native_diary',metadata:{diary_kind:kind,diary_date:shanghaiTime(at).date,evidence_ids:ids,
          event_name:'diary.entry',content_kind:'personal_record',independently_verified:false}})
      for(const evidenceId of ids){const relationId='diary-evidence-'+sha(id+'\0'+evidenceId)
        this.store.db.prepare("INSERT OR IGNORE INTO relations(id,subject_kind,subject_id,relation,object_kind,object_id,created_at,metadata_json) VALUES(?,?,?,?,?,?,?,?)")
          .run(relationId,'journal_event',id,'references','evidence',evidenceId,at,'{}')
      }
      return {written:true,id:row.id,kind,status:'recorded',duplicate:row.duplicate===true,published:false}
    })
  }
  list(input={},trusted_context={}){
    fields(input,['kind','platform','before','limit'],'日记列表')
    const kind=choice(input.kind??'public',['public','private'],'kind'),context=contextOf(trusted_context)
    if(kind==='private'&&context.owner_authorized!==true)return {items:[],next_cursor:null,restricted:true}
    const count=input.limit??20;if(!Number.isSafeInteger(count)||count<1||count>100)throw new Error('日记条数无效')
    if(input.platform!==undefined)choice(input.platform,['qq','tieba','bilibili','harness'],'platform')
    let cursor
    if(input.before!==undefined&&input.before!==null&&input.before!==''){
      if(typeof input.before!=='string'||!/^[A-Za-z0-9_-]{1,600}$/.test(input.before))throw new Error('日记分页标识无效')
      try{cursor=JSON.parse(Buffer.from(input.before,'base64url').toString('utf8'))}catch{throw new Error('日记分页标识无效')}
      if(!Array.isArray(cursor)||cursor.length!==3||typeof cursor[0]!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(cursor[0])||!Number.isSafeInteger(cursor[1])||cursor[1]<-1||typeof cursor[2]!=='string')throw new Error('日记分页标识无效')
    }
    const conditions=["event_type='diary'","json_extract(metadata_json,'$.diary_kind')=?"],args=[kind]
    if(input.platform){conditions.push('platform=?');args.push(input.platform)}
    const dayOrder="COALESCE(NULLIF(json_extract(metadata_json,'$.diary_date'),''),date(source_at/1000,'unixepoch','+8 hours'),'0000-00-00')",timeOrder='COALESCE(source_at,-1)'
    if(cursor){conditions.push(`(${dayOrder}<? OR (${dayOrder}=? AND (${timeOrder}<? OR (${timeOrder}=? AND id<?))))`);args.push(cursor[0],cursor[0],cursor[1],cursor[1],cursor[2])}
    const rows=this.store.db.prepare(`SELECT id,platform,visibility,conversation_id,source_at,recorded_at,CAST(text AS BLOB) text_bytes,metadata_json,${dayOrder} sort_day,${timeOrder} sort_at FROM journal_events WHERE `+conditions.join(' AND ')
      +' ORDER BY sort_day DESC,sort_at DESC,id DESC LIMIT ?').all(...args,count+1).filter(row=>visible(row,context))
    const items=rows.slice(0,count).map(row=>({id:row.id,platform:row.platform,kind,visibility:row.visibility,source_at:row.source_at,
      diary_date:JSON.parse(row.metadata_json).diary_date??'',text:page(Buffer.from(row.text_bytes).toString('utf8'),{max_chars:320}).text}))
    const last=rows[count-1]
    return {items,next_cursor:rows.length>count&&last?Buffer.from(JSON.stringify([last.sort_day,last.sort_at,last.id])).toString('base64url'):null}
  }
}
