/** On-demand owner report over existing records. No second diary or model call. */
import {NativeStore} from './store.mjs'
import {redactText} from './memory-rules.mjs'
import {isPlainObject} from './contracts.mjs'
import {shanghaiTime} from '../policy.mjs'
export function nativeOwnerDailyReport(store,input={},trusted={}){
 if(!(store instanceof NativeStore)||trusted.owner_authorized!==true)throw Error('活动报告仅限主人设置')
 if(!isPlainObject(input)||Object.keys(input).some(key=>!['date','platform'].includes(key)))throw Error('报告参数包含未知字段')
 const {date=shanghaiTime(store.now()).date,platform}=input
 if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||platform!==undefined&&!['tieba','bilibili','qq'].includes(platform))throw Error('报告日期或平台无效')
 const start=Date.parse(date+'T00:00:00+08:00');if(!Number.isFinite(start)||shanghaiTime(start).date!==date)throw Error('报告日期无效')
 const range=[start,start+86400000,platform??null,platform??null],where="created_at>=? AND created_at<? AND (? IS NULL OR platform=?) AND kind NOT LIKE 'activity.%'"
 const totals=store.db.prepare('SELECT status,COUNT(*) n FROM actions WHERE '+where+' GROUP BY status').all(...range),counts=Object.fromEntries(['confirmed','unknown','blocked','queued','draft','leased','submitting','cancelled','failed'].map(status=>[status,0]));for(const row of totals)counts[row.status]=row.n
 const rows=store.db.prepare('SELECT id,platform,kind,status,CAST(body AS BLOB) body_bytes FROM actions WHERE '+where+' ORDER BY created_at DESC,id DESC LIMIT 101').all(...range),items=rows.slice(0,100).map(r=>({id:r.id,platform:r.platform,kind:r.kind,status:r.status,text:redactText(Buffer.from(r.body_bytes).toString('utf8')).slice(0,500)}))
 const learning=store.db.prepare("SELECT COALESCE(SUM(CASE WHEN json_extract(metadata_json,'$.subtype')='learning_observation' AND COALESCE(json_extract(metadata_json,'$.refresh_only'),0)<>1 THEN 1 ELSE 0 END),0) observations,COALESCE(SUM(CASE WHEN json_extract(metadata_json,'$.subtype')='learning_observation' AND json_extract(metadata_json,'$.refresh_only')=1 THEN 1 ELSE 0 END),0) source_refreshes,COALESCE(SUM(CASE WHEN json_extract(metadata_json,'$.subtype')='used' THEN 1 ELSE 0 END),0) uses,COALESCE(SUM(CASE WHEN json_extract(metadata_json,'$.subtype')='feedback' THEN 1 ELSE 0 END),0) feedback FROM journal_events WHERE source_at>=? AND source_at<? AND (? IS NULL OR platform=?) AND (event_type='learning' OR source_type='native_task_result')").get(...range)
 return {date,platform:platform??'all',counts,counts_complete:true,total_actions:totals.reduce((sum,row)=>sum+row.n,0),learning:{...learning},items,truncated:rows.length>100,model_calls:0,read_only:true}
}
