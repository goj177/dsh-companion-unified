import {createHash} from 'node:crypto'
import {isDeepStrictEqual} from 'node:util'
import {redactText} from './memory-rules.mjs'
import {assertRunActive} from './run-scope.mjs'
import {NativeExpressionVisual,isManagedExpressionAsset} from './expression-visual.mjs'
import {selectTiebaMedia,tiebaMediaEntries,compactTiebaMediaHint} from './tieba-media-selection.mjs'
import {shanghaiTime} from '../policy.mjs'

const platforms=new Set(['qq','bilibili','tieba'])
const publicImageKinds=new Set(['public_post_image','public_comment_image'])
const producers=['shared_sticker_collect','shared_sticker_usage']
const assetPattern=/^asset:[a-f0-9]{64}$/
const hash=value=>createHash('sha256').update(value).digest('hex')
const turnKey=context=>context?.session_id&&context.source_scope&&platforms.has(context.platform)?hash(context.session_id+'\0'+context.source_scope):''
const note=(value,max)=>{
  if(typeof value!=='string'||!value.isWellFormed()||/[\0\r\n]/.test(value)||value.length>max||!value.trim()||redactText(value)!==value)throw new Error('表情用法需要简短且不含私密信息的说明')
  return value.trim()
}
const notes=(values,count,max)=>{
  if(!Array.isArray(values)||values.length>count)throw new Error('表情用法条数无效')
  return [...new Set(values.map(value=>note(value,max)))]
}

export class NativeExpressionLibrary{
  constructor({store,assets,now=store.now}){
    this.store=store;this.assets=assets;this.now=now;this.views=new Map()
    this.visual=new NativeExpressionVisual({store,assets,now})
  }
  preference(){return this.store.getDocument('settings')?.value.expression?.media_preference??5}
  viewed(asset_ref,context){
    const key=turnKey(context)
    if(!key||!assetPattern.test(asset_ref??''))return
    const items=this.views.get(key)??new Set()
    if(items.size<16)items.add(asset_ref)
    this.views.delete(key);this.views.set(key,items)
    if(this.views.size>160)this.views.delete(this.views.keys().next().value)
  }
  list({query='',limit=12,platform='qq'}={}){
    const rows=this.store.db.prepare("SELECT id,kind,media_type,byte_size,manifest_json FROM assets WHERE kind IN ('image','sticker') ORDER BY created_at DESC,id LIMIT 10000").all()
    const assets=this.visual.decorate(rows.map(({manifest_json,...row})=>({...row,manifest:JSON.parse(manifest_json)})))
    return selectTiebaMedia({assets,platform,query,limit,now:this.now(),budget:{daily_limit:1}})
  }
  hint(selection,platform){
    const level=this.preference(),items=selection.items.filter(item=>item.relevance>=11-level)
    const action=platform==='qq'?'合适时用 qq_send_image 发图':platform==='bilibili'?'评论或动态用 target.asset_ids 发图':'回帖用 target.asset_ids 发图'
    const tendency=level<=3?'只在明显贴合时考虑。':level>=8?'合适的场合主动找表情。':'按这句话的语气决定。'
    const summary='【共享表情 '+level+'/10】'+tendency+action+'；'+(platform==='qq'?'可用 Unicode。':'自带表情可查 emotes。')
    const lookup='用 companion_expression list 找表情包。'+(platform==='qq'?'收到 QQ 原生表情包':'看到合适的公开梗图')+'，看原图后可用 collect 收藏，用 remember 记已有表情的用法。'
    const candidates=items.length?compactTiebaMediaHint({...selection,items},{max_chars:200,max_items:1,...(platform==='qq'?{send_with:'qq_send_image',view_with:'qq_read_asset'}:{})}):''
    return [summary,candidates||lookup].join('\n')
  }
  save(operation,input,context,{verifiedQQSticker=false}={}){
    assertRunActive()
    const scope=turnKey(context),asset_ref=input.asset_ref
    if(!scope||!this.views.get(scope)?.has(asset_ref))throw new Error('请先在本轮查看原图或表情包，再保存或记用法')
    const asset=this.assets.read(asset_ref),entries=tiebaMediaEntries(asset.manifest),collect=operation==='collect'
    if(asset.byte_size>2*1024*1024||!['image/png','image/jpeg','image/gif','image/webp'].includes(asset.media_type))throw new Error('共享表情图必须是 2 MB 以内的受支持图片')
    if(collect&&entries.length)return {asset_ref,already_collected:true,can_remember:isManagedExpressionAsset(asset)}
    const publicImage=asset.manifest.registrations?.some(row=>row.visibility==='public'&&['tieba','bilibili'].includes(row.manifest?.platform)&&publicImageKinds.has(row.manifest?.source_kind))
    if(collect&&!publicImage&&!verifiedQQSticker)throw new Error('自主收藏只接受已核验的公开原图或本轮收到的 QQ 原生表情包')
    if(!collect&&!isManagedExpressionAsset(asset))throw new Error('只有已启用的共享表情包才能记录用法')
    const use_when=note(input.use_when,120),avoid_when=notes(input.avoid_when??[],4,40)
    const latest=entries.filter(row=>producers.includes(row.producer)).sort((a,b)=>(b.learned_at??0)-(a.learned_at??0))[0]
    if(latest?.use_when===use_when&&isDeepStrictEqual(latest.avoid_when,avoid_when))return {asset_ref,unchanged:true}
    const at=this.now(),day=shanghaiTime(at).date,counts=this.store.db.prepare(`SELECT COUNT(*) AS daily, COALESCE(MAX(json_extract(entry.value,'$.turn_scope')=?),0) AS turn_used
      FROM assets, json_each(assets.manifest_json,'$.catalog_entries') entry
      WHERE json_extract(entry.value,'$.producer') IN ('shared_sticker_collect','shared_sticker_usage') AND json_extract(entry.value,'$.day')=?`).get(scope,day)
    if(counts.turn_used||counts.daily>=this.preference())throw new Error('本轮或今天的自主表情收藏和用法记录次数已用完')
    const entry={collection:'shared_stickers',enabled:true,historical:false,producer:collect?producers[0]:producers[1],learned_at:at,day,turn_scope:scope,learned_on:context.platform,use_when,avoid_when,
      ...(collect?{display_name:note(input.name,80),description:note(input.description,160),tags:notes(input.tags??[],8,24)}:{})}
    this.assets.put({bytes:asset.bytes,kind:'sticker',media_type:asset.media_type,source_ref:'shared-expression:'+asset_ref,visibility:collect&&publicImage?'public':'owner',manifest:{catalog_entries:[entry]}})
    return {asset_ref,collected:collect,usage_saved:true,use_when,avoid_when,model_calls:0}
  }
}
