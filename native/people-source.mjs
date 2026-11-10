/** Owner UI only. Resolve a source through the selected person's current
 * detail allowlist, mask the entire immutable source, then paginate. No model,
 * network, URI/path resolution or changes to the ordinary memory reader. */
import {createHash} from 'node:crypto'
import {NativeStore} from './store.mjs'
import {NativePeople} from './people.mjs'
import {fields,identifier,redactText,page} from './memory-rules.mjs'

const kinds=new Set(['memory','evidence','journal'])
const localOwner=context=>context?.owner_authorized===true&&context.platform==='harness'&&context.visibility!=='public'
const unavailable=()=>({found:false,text:'没有这条人物依据或当前无读取权限。',redacted:true,model_calls:0,read_only:true})

export function readNativePeopleSource({store,people}={},input={},trusted={}){
  if(!localOwner(trusted))throw Error('人物依据仅限主人本机设置查看')
  if(!(store instanceof NativeStore)||!(people instanceof NativePeople)||people.store!==store)throw Error('人物依据需要同一原生熟人仓库')
  fields(input,['entity_id','kind','id','offset','max_chars'],'人物依据查询')
  const {entity_id,kind,id,offset=0,max_chars=1200}=input
  identifier(entity_id,'entity_id');identifier(id,'id')
  if(!kinds.has(kind)||!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(max_chars)||max_chars<1||max_chars>1800)throw Error('人物依据类型或分页范围无效')
  store._open()
  // A SAVEPOINT starts a deferred read snapshot even on a writable host store.
  // It also nests inside a host transaction without upgrading it to a write.
  store.db.exec('SAVEPOINT companion_people_source_read')
  try{
    const detail=people.ownerDetail({entity_id,event_limit:10},trusted)
    const allowed=detail?.found===true&&detail.person?.id===entity_id&&[...(detail.impressions??[]),...(detail.recent_events??[])].some(row=>Array.isArray(row.sources)&&row.sources.some(source=>source?.kind===kind&&source.id===id))
    let result=unavailable()
    if(allowed){
      // Fixed statements only: neither table/column names nor raw SQL come
      // from a source ID, URL, platform message or model argument.
      const row=kind==='memory'
        ?store.db.prepare("SELECT visibility,CAST(content AS BLOB) text_bytes FROM memory_entries WHERE id=?").get(id)
        :kind==='evidence'
          ?store.db.prepare("SELECT visibility,CAST(text AS BLOB) text_bytes FROM evidence WHERE id=?").get(id)
          :store.db.prepare("SELECT visibility,CAST(text AS BLOB) text_bytes FROM journal_events WHERE id=?").get(id)
      if(row&&['public','conversation','owner'].includes(row.visibility)){
        const raw=Buffer.from(row.text_bytes).toString('utf8')
        // Corrupt/oversized records fail closed; never mask just a raw slice,
        // since a token or assignment may straddle a pagination boundary.
        if(raw.length<=64000&&raw.isWellFormed()){
          const safe=redactText(raw.replace(/\0/g,' '))
          if(offset>safe.length)throw Error('分页位置超出人物依据范围')
          result={found:true,entity_id,kind,id,...page(safe,{offset,max_chars}),source_hash:createHash('sha256').update(safe).digest('hex'),redacted:true,model_calls:0,read_only:true}
        }
      }
    }
    store.db.exec('RELEASE SAVEPOINT companion_people_source_read')
    return result
  }catch(error){
    store.db.exec('ROLLBACK TO SAVEPOINT companion_people_source_read');store.db.exec('RELEASE SAVEPOINT companion_people_source_read');throw error
  }
}
