import { isPlainObject } from './contracts.mjs'

const collections=new Set(['shared_stickers','tieba_images'])
const imageTypes=new Set(['image/png','image/jpeg','image/gif','image/webp'])

/** Publication ACL only. The caller must obtain this asset from NativeAssets
 * so its bytes/hash/type have already been verified; this never reads files. */
export function canPublishAsset(asset,{platform,bar}={}){
  if(!['bilibili','tieba'].includes(platform)||!isPlainObject(asset)||!imageTypes.has(asset.media_type)||!isPlainObject(asset.manifest))return false
  if(bar!==undefined&&(typeof bar!=='string'||!bar.isWellFormed()||/[\0\r\n]/.test(bar)))return false
  const manifest=asset.manifest,registrations=Array.isArray(manifest.registrations)?manifest.registrations.filter(isPlainObject):[]
  const manifests=[manifest,...registrations.map(row=>row.manifest).filter(isPlainObject)],entries=[]
  for(const source of manifests){
    if(Array.isArray(source.catalog_entries))entries.push(...source.catalog_entries.filter(isPlainObject))
    // Bare legacy collection labels or sticker kinds do not establish consent.
    if(collections.has(source.collection)&&source.historical===false)entries.push(source)
  }
  const active=entries.filter(row=>collections.has(row.collection)&&row.historical!==true)
  for(const row of active){
    if(row.historical!==undefined&&typeof row.historical!=='boolean'||row.enabled!==undefined&&typeof row.enabled!=='boolean')return false
    if(row.disabled_bars!==undefined&&(!Array.isArray(row.disabled_bars)||row.disabled_bars.some(value=>typeof value!=='string')))return false
    if(row.enabled===false||platform==='tieba'&&bar!==undefined&&(row.disabled_bars??[]).includes(bar.trim()))return false
  }
  // A second public registration can authorize the identical SHA bytes, while
  // an explicit current catalog prohibition still wins over every public grant.
  return active.length>0||manifest.visibility==='public'||registrations.some(row=>row.visibility==='public')
}
