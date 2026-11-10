/** One-time owner-generated picture descriptions, cached by the original SHA.
 * These are weak visual metadata, never persona, source consent or a new catalog. */
import {createHash} from 'node:crypto'
import {NativeStore} from './store.mjs'
import {NativeAssets} from './assets.mjs'
import {isPlainObject} from './contracts.mjs'
import {redactText} from './memory-rules.mjs'

export const EXPRESSION_VISUAL_POLICY=Object.freeze({analysis_version:1,minimum_confidence:0.65,description_chars:160,scene_tags:8,emotion_tags:6,visible_text_chars:160,avoid_in:4})
const ASSET=/^asset:[a-f0-9]{64}$/,TYPES=new Set(['image/png','image/jpeg','image/gif','image/webp']),COLLECTIONS=new Set(['shared_stickers','tieba_images']),PREFIX='expression.visual:'
const fields=(value,keys)=>{if(!isPlainObject(value)||Object.keys(value).some(key=>!keys.includes(key)))throw new Error('图片描述参数包含未知字段或类型错误')}
const text=(value,max,required=false)=>{if(typeof value!=='string'||!value.isWellFormed()||value.includes('\0')||value.length>max||required&&!value.trim())throw new Error('图片描述文本无效或过长');const clean=redactText(value).replace(/[\r\n\t]+/g,' ').trim();if(clean.length>max)throw new Error('图片描述文本打码后超过长度限制');return clean}
const tags=(value,count,max)=>{if(!Array.isArray(value)||value.length>count)throw new Error('图片描述标签数量无效');return [...new Set(value.map(item=>text(item,max,true)))]}
const hash=value=>createHash('sha256').update(value).digest('hex')
function managedEntries(manifest){
  const sources=[manifest,...(Array.isArray(manifest.registrations)?manifest.registrations.filter(isPlainObject).map(row=>row.manifest).filter(isPlainObject):[])]
  return sources.flatMap(source=>[...(Array.isArray(source.catalog_entries)?source.catalog_entries.filter(isPlainObject):[]),...(COLLECTIONS.has(source.collection)&&source.historical===false?[source]:[])]).filter(entry=>COLLECTIONS.has(entry.collection)&&entry.historical!==true)
}
export function isManagedExpressionAsset(asset){
  if(!isPlainObject(asset)||!ASSET.test(asset.id??'')||!['image','sticker'].includes(asset.kind)||!TYPES.has(asset.media_type)||!isPlainObject(asset.manifest))return false
  const entries=managedEntries(asset.manifest)
  return entries.length>0&&!entries.some(entry=>entry.enabled===false||entry.enabled!==undefined&&typeof entry.enabled!=='boolean'||entry.historical!==undefined&&typeof entry.historical!=='boolean')
}
function content(input){
  fields(input,['asset_ref','description','scene_tags','emotion_tags','visible_text','avoid_in','confidence','model_id'])
  if(!ASSET.test(input.asset_ref??'')||typeof input.confidence!=='number'||!Number.isFinite(input.confidence)||input.confidence<0||input.confidence>1)throw new Error('图片描述引用或可信度无效')
  return {asset_ref:input.asset_ref,description:text(input.description,160,true),scene_tags:tags(input.scene_tags??[],8,20),emotion_tags:tags(input.emotion_tags??[],6,16),visible_text:text(input.visible_text??'',160),avoid_in:tags(input.avoid_in??[],4,40),confidence:input.confidence,model_id:text(input.model_id,120,true)}
}
function cached(value,asset){
  if(!isPlainObject(value)||value.analysis_version!==1||value.asset_sha256!==asset.id.slice(6)||value.asset_ref!==asset.id||!Number.isSafeInteger(value.generated_at)||value.generated_at<0||!isManagedExpressionAsset(asset))return null
  try{const clean=content(Object.fromEntries(['asset_ref','description','scene_tags','emotion_tags','visible_text','avoid_in','confidence','model_id'].map(key=>[key,value[key]])));return {...clean,asset_sha256:value.asset_sha256,analysis_version:1,generated_at:value.generated_at,source:'model_visual_analysis',fact_verified:false}}catch{return null}
}
export class NativeExpressionVisual{
  constructor({store,assets,now=store?.now??Date.now}={}){if(!(store instanceof NativeStore)||assets!==undefined&&!(assets instanceof NativeAssets)||typeof now!=='function')throw new Error('图片描述缓存需要原生资料库、素材仓库和可信时钟');this.store=store;this.assets=assets??new NativeAssets({store});if(this.assets.store!==store)throw new Error('图片描述与素材必须使用同一资料库');this.now=now}
  _row(asset){const row=this.store.db.prepare("SELECT schema_id,schema_version,value_json FROM cache_entries WHERE key=? AND kind='expression.visual'").get(PREFIX+asset.id.slice(6));if(row?.schema_id!=='companion.expression_visual'||row.schema_version!==1)return null;try{return cached(JSON.parse(row.value_json),asset)}catch{return null}}
  read(asset_ref){if(!ASSET.test(asset_ref??''))throw new Error('请提供完整原生素材引用');const asset=this.assets.read(asset_ref);return isManagedExpressionAsset(asset)?this._row(asset):null}
  decorate(rows){if(!Array.isArray(rows)||rows.length>10000)throw new Error('图片描述缓存读取数量无效');return rows.map(asset=>{if(!isManagedExpressionAsset(asset))return asset;const visual=this._row(asset);return visual?{...asset,visual}:asset})}
  write(input,trusted={}){
    if(trusted.owner_authorized!==true||trusted.can_manage!==true||!['harness','system'].includes(trusted.platform??'harness')||trusted.visibility==='public')throw new Error('图片描述整理只允许可信本机主人')
    this.store._write();const clean=content(input),asset=this.assets.read(clean.asset_ref)
    if(!isManagedExpressionAsset(asset))throw new Error('只能整理已明确管理的当前收藏图片；未知图片或私聊原图不升级为共享素材')
    if(asset.sha256!==asset.id.slice(6)||hash(asset.bytes)!==asset.sha256)throw new Error('原图SHA核验失败')
    const at=this.now();if(!Number.isSafeInteger(at)||at<0)throw new Error('图片描述缓存时钟无效')
    const value={...clean,asset_sha256:asset.sha256,analysis_version:1,generated_at:at,source:'model_visual_analysis',fact_verified:false},old=this._row(asset)
    if(old&&Object.entries(clean).every(([key,item])=>JSON.stringify(old[key])===JSON.stringify(item)))return {written:false,duplicate:true,cached:true,value:old,model_calls:0,source_changed:false}
    this.store.db.prepare('INSERT INTO cache_entries(key,kind,schema_id,schema_version,value_json,created_at,expires_at) VALUES(?,?,?,?,?,?,NULL) ON CONFLICT(key) DO UPDATE SET kind=excluded.kind,schema_id=excluded.schema_id,schema_version=excluded.schema_version,value_json=excluded.value_json,created_at=excluded.created_at,expires_at=NULL').run(PREFIX+asset.sha256,'expression.visual','companion.expression_visual',1,JSON.stringify(value),at)
    return {written:true,duplicate:false,cached:true,value,model_calls:0,source_changed:false}
  }
}
