/** Pure selection of explicitly managed Tieba images. No storage, model,
 * transport, persona mutation or publication. The sender rechecks everything. */
import {isPlainObject} from './contracts.mjs'
import {canPublishAsset} from './asset-policy.mjs'

const COLLECTIONS=new Set(['tieba_images','shared_stickers'])
const TYPES=new Set(['image/png','image/jpeg','image/gif','image/webp'])
const ASSET=/^asset:[a-f0-9]{64}$/
const COOLDOWN=86400000,MAX_BYTES=2*1024*1024
const stop=new Set('我 你 他 她 它 的 了 吗 呢 啊 吧 是 在 这 那 一个 这个 那个 一张 图片 表情 表情包 收藏 现在 可以 想要 觉得 感觉'.split(' '))
const emotionalTokens=new Set('笑 哭 乐 怒 汗 萌 怕 困 急 麻 绷 哈 唉 哇 赞 爱'.split(' '))
const morphologyStop=new Set([...stop,...'这 那 有 和 就 都 能 会 还 又 让 把 被 很 太 不 没 才 给 着 过 得 地 可 真 大 小 多 少 上 下 中 里 内 外 前 后 一 二 三 四 五 六 七 八 九 十'.split(' ')])
const segmenter=typeof Intl.Segmenter==='function'?new Intl.Segmenter('zh',{granularity:'word'}):null
const normal=value=>String(value??'').normalize('NFKC').toLowerCase().replace(/\s+/g,' ').trim()
const clipped=(value,max)=>{let end=Math.min(value.length,max);if(end>0&&end<value.length&&/[\uD800-\uDBFF]/.test(value[end-1])&&/[\uDC00-\uDFFF]/.test(value[end]))end--;return value.slice(0,end)}
const clean=(value,max)=>clipped(String(value??'').replace(/[\0\r\n\t]+/g,' ').trim(),max)
const nonnegative=(value,name)=>{if(!Number.isSafeInteger(value)||value<0)throw new Error(name+'必须是非负精确整数');return value}
const terms=value=>[...new Set((segmenter?[...segmenter.segment(value)].filter(row=>row.isWordLike).map(row=>row.segment):value.match(/[\p{Script=Han}]|[a-z0-9_-]{2,}/gu)??[]).filter(word=>!stop.has(word)&&!/^\d+$/.test(word)&&(word.length>1||emotionalTokens.has(word))))].slice(0,40)
const morphologyTerms=value=>{
  if(!segmenter||/来源|作者|昵称|用户名|网名|姓名|名叫/u.test(value))return []
  return [...new Set([...segmenter.segment(value)].filter(row=>row.isWordLike).map(row=>/^[\p{Script=Han}][了着过]$/u.test(row.segment)?row.segment[0]:row.segment).filter(word=>/^\p{Script=Han}$/u.test(word)&&!morphologyStop.has(word)))].slice(0,8)
}
const manifests=manifest=>[manifest,...(Array.isArray(manifest.registrations)?manifest.registrations.filter(isPlainObject).map(row=>row.manifest).filter(isPlainObject):[])]
function entriesOf(manifest){
  return manifests(manifest).flatMap(source=>[
    ...(Array.isArray(source.catalog_entries)?source.catalog_entries.filter(isPlainObject):[]),
    ...(COLLECTIONS.has(source.collection)&&source.historical===false?[source]:[]),
  ]).filter(entry=>COLLECTIONS.has(entry.collection)&&entry.historical!==true)
}
function relevance(item,query,words){
  if(!query)return 0
  // Imported catalogue notes often quote the comment where an image was
  // collected. Neither its author nor that comment describes the pixels.
  const name=/^[a-f0-9]{8,64}$/i.test(item.name)?'':normal(item.name),description=item.description_kind==='source_note'?'':normal(item.description),tags=item.tags.map(normal)
  let score=name===query?60:name.includes(query)?24:0
  if(description.includes(query))score+=12
  if(tags.includes(query))score+=30
  for(const word of words){
    if(tags.includes(word))score+=12
    else if(tags.some(tag=>tag.includes(word)))score+=7
    if(name.includes(word))score+=9
    if(description.includes(word))score+=3
  }
  // A single meaningful word such as 钓 can discover a visually tagged 钓鱼
  // image. This is weaker than every full-word match and never applies to
  // source notes, file hashes, displayed names or unverified old descriptions.
  if(score===0&&item.description_kind==='visual_summary'&&(item.visual_scene_tags??[]).some(tag=>morphologyTerms(query).some(word=>normal(tag).includes(word))))score=2
  return score
}

/** assets are verified NativeAssets rows with id/kind/media_type/byte_size and
 * parsed manifest. last_used_at_by_asset must include upload-attempt history,
 * since an unknown publication must not silently make the image reusable. */
export function selectTiebaMedia({assets=[],bar='',query='',now=Date.now(),limit=6,last_used_at_by_asset={},budget={}}={}){
  if(!Array.isArray(assets)||assets.length>10000||typeof bar!=='string'||bar.length>1440||typeof query!=='string'||query.length>4000)throw new Error('贴吧图片候选参数无效')
  if(!Number.isSafeInteger(limit)||limit<1||limit>50)throw new Error('贴吧图片候选数量必须为1至50')
  nonnegative(now,'当前时间')
  if(!(last_used_at_by_asset instanceof Map)&&!isPlainObject(last_used_at_by_asset)||!isPlainObject(budget))throw new Error('贴吧图片可用状态无效')
  const daily_limit=nonnegative(budget.daily_limit??10,'图片日上限'),daily_used=nonnegative(budget.daily_used??0,'图片日用量'),round_limit=nonnegative(budget.round_limit??1,'图片轮上限'),round_used=nonnegative(budget.round_used??0,'图片轮用量')
  const currentBar=bar.trim(),needle=normal(query),words=terms(needle),items=[],blocked={},seen=new Set();let next_available_at=null
  const block=reason=>{blocked[reason]=(blocked[reason]??0)+1}
  for(const asset of assets){
    if(!isPlainObject(asset)||!ASSET.test(asset.id??'')||!isPlainObject(asset.manifest)){block('invalid_asset');continue}
    if(seen.has(asset.id))continue;seen.add(asset.id)
    if(!['image','sticker'].includes(asset.kind)||!TYPES.has(asset.media_type)){block('unsupported_type');continue}
    const manifest=asset.manifest,entries=entriesOf(manifest)
    // A public image read from somebody's post is not a collected expression.
    // An explicit current managed registration is the publication grant, even
    // when the original bytes retain an owner/conversation visibility label.
    if(!entries.length){block(manifest.visibility==='public'?'unmanaged':'private');continue}
    if(entries.some(entry=>entry.enabled===false)){block('disabled');continue}
    if(entries.some(entry=>entry.disabled_bars!==undefined&&(!Array.isArray(entry.disabled_bars)||entry.disabled_bars.some(value=>typeof value!=='string')))){block('invalid_policy');continue}
    if(!currentBar&&entries.some(entry=>entry.disabled_bars?.length)){block('bar_scope_unknown');continue}
    if(entries.some(entry=>(entry.disabled_bars??[]).some(value=>value.trim()===currentBar))){block('bar_disabled');continue}
    if(!canPublishAsset(asset,{platform:'tieba',bar:currentBar})){block('not_publishable');continue}
    if(!Number.isSafeInteger(asset.byte_size)||asset.byte_size<=0){block('size_unknown');continue}
    if(asset.byte_size>MAX_BYTES){block('oversize');continue}
    const used=last_used_at_by_asset instanceof Map?last_used_at_by_asset.get(asset.id):last_used_at_by_asset[asset.id]
    const times=[used,...entries.map(entry=>entry.last_used_at)].filter(value=>Number.isSafeInteger(value)&&value>0),last_used_at=times.length?Math.max(...times):0
    if(last_used_at&&now-last_used_at<COOLDOWN){const until=last_used_at+COOLDOWN;next_available_at=next_available_at===null?until:Math.min(next_available_at,until);block('cooldown');continue}
    if(daily_used>=daily_limit){block('daily_limit');continue}
    if(round_used>=round_limit){block('round_limit');continue}
    const rankedEntries=[...entries].sort((a,b)=>(a.collection==='tieba_images'?0:1)-(b.collection==='tieba_images'?0:1))
    const entry=rankedEntries.find(row=>row.description||row.display_name||row.name)??rankedEntries[0]
    const rawTags=(Array.isArray(entry.tags)?entry.tags:[]).slice(0,12).map(tag=>clean(tag,40)).filter(Boolean),sourceNote=rawTags.includes('偷来的'),description=clean(entry.description??manifest.description??'',180),candidate=asset.visual
    const visual=isPlainObject(candidate)&&candidate.asset_ref===asset.id&&candidate.asset_sha256===asset.id.slice(6)&&candidate.analysis_version===1&&typeof candidate.description==='string'&&candidate.description.trim()&&typeof candidate.confidence==='number'&&candidate.confidence>=0.65&&candidate.confidence<=1&&Array.isArray(candidate.scene_tags)&&Array.isArray(candidate.emotion_tags)?candidate:null
    const originalName=clean(entry.display_name??entry.name??manifest.display_name??manifest.name??'收藏图片',120),visualTags=visual?[...visual.scene_tags,...visual.emotion_tags].slice(0,14).map(tag=>clean(tag,40)).filter(Boolean):[]
    const item={asset_id:asset.id,name:visual&&/^[a-f0-9]{8,64}$/i.test(originalName)?clean(visual.description,24):originalName,description:visual?clean(visual.description,160):sourceNote?description.replace(/^[^：:]{1,50}[：:]/u,''):description,tags:[...new Set([...rawTags.filter(tag=>tag!=='偷来的'),...visualTags])].slice(0,20),...(visual?{description_kind:'visual_summary',visual_confidence:visual.confidence,visual_scene_tags:visual.scene_tags.map(value=>clean(value,20)),...(visual.visible_text?{visual_text:clean(visual.visible_text,160)}:{}),avoid_in:(visual.avoid_in??[]).slice(0,4).map(value=>clean(value,40))}:sourceNote?{description_kind:'source_note'}:{}),needs_visual_check:!visual,media_type:asset.media_type,byte_size:asset.byte_size,available:true,last_used_at}
    const score=relevance(item,needle,words)
    if(needle&&score===0){block('query_unmatched');continue}
    items.push({...item,relevance:score})
  }
  items.sort((a,b)=>b.relevance-a.relevance||a.last_used_at-b.last_used_at||a.asset_id.localeCompare(b.asset_id))
  return {items:items.slice(0,limit),available_count:items.length,blocked,next_available_at,
    selection_hint:items.length?'只列当前可发表的已管理收藏图；按内容选合适的一张，不合适就不用。':'当前没有符合本吧、冷却和额度要求的相关收藏图；可以只发文字或合适的自带表情。'}
}

/** Keep complete asset IDs and complete candidate lines; never truncate an ID
 * into an unpublishable reference or expose excluded/private metadata. */
export function compactTiebaMediaHint(selection,{max_chars=240,max_items=2}={}){
  if(!isPlainObject(selection)||!Array.isArray(selection.items)||!Number.isSafeInteger(max_chars)||max_chars<0||max_chars>240||!Number.isSafeInteger(max_items)||max_items<1||max_items>2)throw new Error('贴吧图片提示参数无效')
  if(max_chars<100)return ''
  if(!selection.items.length){const note='【收藏图】暂无相关候选。想配图可read images不填query查少量收藏，再companion_image看图；不必为配图换话题。';return note.length<=max_chars?note:''}
  const needsLook=selection.items.some(item=>item.needs_visual_check!==false),allNeedLook=selection.items.every(item=>item.needs_visual_check!==false)
  const heading='【收藏图候选·资料】',suffix=allNeedLook?'先companion_image看原图，合适才填target.asset_ids；来源备注不等于画面，不必每条带图。':needsLook?'已有看图描述可据此选；标“待看”的先companion_image，合适才填target.asset_ids，不必每条配图。':'已有原图描述，可据此选；拿不准再companion_image。合适才填target.asset_ids，不必每条配图。',lines=[]
  for(const item of selection.items){
    if(lines.length>=max_items)break
    if(item.available!==true||!ASSET.test(item.asset_id??''))continue
    let line
    for(const chars of [24,12,0]){
      const candidate=item.asset_id+' '+(!allNeedLook&&item.needs_visual_check!==false?'待看 ':'')+JSON.stringify(clean(item.name,12))+(chars?' '+JSON.stringify(clean(item.description,chars)):'')
      if((heading+'\n'+[...lines,candidate].join('\n')+'\n'+suffix).length<=max_chars){line=candidate;break}
    }
    if(line)lines.push(line)
  }
  return lines.length?heading+'\n'+lines.join('\n')+'\n'+suffix:''
}
