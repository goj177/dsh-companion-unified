/** Fixed names and markup from the official PC editor (core:1774/core:1581).
 * Only trusted native upload receipts supply picture handles; no model URL or HTML.
 * Source: https://tb3.bdstatic.com/tb/pc/pc-main-core/static/js/pb.b69f12af.js
 */
import {TiebaContentError,assertTiebaPublishableText} from './tieba-content.mjs'
import {parseUploadReceipt} from './tieba-http.mjs'
import {createHash} from 'node:crypto'
const pairs=[["image_emoticon","呵呵"],["image_emoticon2","哈哈"],["image_emoticon3","吐舌"],["image_emoticon24","太开心"],["image_emoticon22","笑眼"],["image_emoticon20","花心"],["image_emoticon66","小乖"],["image_emoticon28","乖"],["image_emoticon67","捂嘴笑"],["image_emoticon25","滑稽"],["image_emoticon68","你懂的"],["image_emoticon12","不高兴"],["image_emoticon6","怒"],["image_emoticon8","汗"],["image_emoticon10","黑线"],["image_emoticon9","泪"],["image_emoticon13","真棒"],["image_emoticon33","喷"],["image_emoticon30","惊哭"],["image_emoticon16","阴险"],["image_emoticon11","鄙视"],["image_emoticon5","酷"],["image_emoticon4","啊"],["image_emoticon27","狂汗"],["image_emoticon69","what"],["image_emoticon15","疑问"],["image_emoticon70","酸爽"],["image_emoticon71","呀咩爹"],["image_emoticon19","委屈"],["image_emoticon32","惊讶"],["image_emoticon29","睡觉"],["image_emoticon72","笑尿"],["image_emoticon73","挖鼻"],["image_emoticon17","吐"],["image_emoticon74","犀利"],["image_emoticon75","小红脸"],["image_emoticon76","懒得理"],["image_emoticon26","勉强"],["image_emoticon7","开心"],["image_emoticon14","钱"],["image_emoticon18","咦"],["image_emoticon21","呼~"],["image_emoticon23","冷"],["image_emoticon61","升起"],["image_emoticon97","突然兴奋"],["image_emoticon100","黑头高兴"],["image_emoticon95","欢呼"],["image_emoticon88","嘿嘿嘿"],["image_emoticon91","微微一笑"],["image_emoticon86","吃瓜"],["image_emoticon92","托腮"],["image_emoticon93","摊手"],["image_emoticon90","困成狗"],["image_emoticon85","暗中观察"],["image_emoticon94","柯基暗中观察"],["image_emoticon87","喝酒"],["image_emoticon89","噗"],["image_emoticon98","紧张"],["image_emoticon96","炸药"],["image_emoticon133","香槟"],["image_emoticon99","黑头瞪眼"],["image_emoticon128","望远镜"],["image_emoticon126","不听"],["image_emoticon127","干饭"],["image_emoticon130","老虎"],["image_emoticon131","嗷呜"],["image_emoticon136","鼠1"],["image_emoticon137","鼠2"],["image_emoticon134","文字啊"],["image_emoticon135","文字对"],["image_emoticon132","烟花"],["image_emoticon129","菜狗"],["image_emoticon125","奥特曼"],["image_emoticon34","爱心"],["image_emoticon35","心碎"],["image_emoticon36","玫瑰"],["image_emoticon37","礼物"],["image_emoticon38","彩虹"],["image_emoticon40","太阳"],["image_emoticon39","星星月亮"],["image_emoticon41","钱币"],["image_emoticon43","茶杯"],["image_emoticon44","蛋糕"],["image_emoticon48","大拇指"],["image_emoticon47","胜利"],["image_emoticon46","haha"],["image_emoticon50","OK"],["image_emoticon77","沙发"],["image_emoticon78","手纸"],["image_emoticon79","香蕉"],["image_emoticon80","便便"],["image_emoticon81","药丸"],["image_emoticon82","红领巾"],["image_emoticon83","蜡烛"],["image_emoticon84","三道杠"],["image_emoticon45","音乐"],["image_emoticon42","灯泡"]]
const names=new Map(pairs.map(([key,name])=>[name,key])),keys=new Map(pairs)
// The PC catalogue includes faces the WAP reply parser treats as literal text.
// Restrict native reply choices to TiebaLite's active *_WEB_MAP entries.
const wapNames=new Set(['滑稽','呵呵','哈哈','啊','开心','酷','汗','怒','鄙视','不高兴','泪','吐舌','黑线','乖','呼~','花心','惊哭','惊讶','狂汗','冷','勉强','喷','噗','钱','生气','睡觉','太开心','吐','委屈','笑眼','咦','阴险','疑问','真棒','爱心','心碎','玫瑰','礼物','彩虹','星星月亮','太阳','钱币','灯泡','茶杯','蛋糕','音乐','haha','胜利','大拇指','弱','OK'])
const wapPairs=pairs.filter(([,name])=>wapNames.has(name))
export function tiebaEmotes({query='',limit=12}={}){
 if(typeof query!=='string'||query.length>240||!Number.isSafeInteger(limit)||limit<1||limit>30)throw new TiebaContentError('贴吧表情查询范围无效')
 return {items:wapPairs.filter(([key,name])=>!query||name.includes(query)||key===query).slice(0,limit).map(([key,name])=>({name,emote_id:key})),total:wapPairs.length,...(query?{unsupported_names:pairs.filter(([key,name])=>!wapNames.has(name)&&(name.includes(query)||key===query)).map(([,name])=>name)}:{}),model_calls:0,usage:'仅返回当前回帖通道支持的表情，target.emotes填写name；Unicode emoji可直接写正文。不支持的名称不要手写(#表情名)或#(表情名)'}
}
export function checkedTiebaEmotes(values=[]){
 if(!Array.isArray(values)||values.length>3||values.some(name=>typeof name!=='string'||!names.has(name)))throw new TiebaContentError('贴吧自带表情仅接受emotes查询返回的名称，每条最多3个')
 if(values.some(name=>!wapNames.has(name)))throw new TiebaContentError('当前贴吧回帖通道不支持此表情：'+values.filter(name=>!wapNames.has(name)).join('、')+'。请查询emotes选择可用名称，或正文直接写Unicode emoji（如🤭），不要手写协议标记')
 return values
}
export function compileTiebaMedia(body,{emotes=[],images=[]}={}){
 assertTiebaPublishableText(body);checkedTiebaEmotes(emotes)
 if(!Array.isArray(images)||images.length>1)throw new TiebaContentError('每条最多一张收藏图片')
 return body+emotes.map(name=>'#('+name+')').join('')+images.map(image=>{
  if(!image||!/^[-a-zA-Z0-9_]{1,160}$/.test(image.pic_id)||!Number.isSafeInteger(image.width)||!Number.isSafeInteger(image.height)||image.width<1||image.height<1||image.width*image.height>100000000)throw new TiebaContentError('官方图片上传回执无效')
  return '#(pic,'+image.pic_id+','+image.width+','+image.height+')'
 }).join('')
}
// Current official PC editor core:1581 serializes an emotion as #(name).
// A raw HTML img belongs to the editor DOM, not its submitted content field.
// This face-only serializer deliberately accepts no WAP picture upload handle.
export function compileTiebaPcMedia(body,{emotes=[]}={}){
 return compileTiebaMedia(body,{emotes})
}
// HTML serialization is retained for the existing theme adapter. Reply media
// uses the WAP serializer below, which has actual typed-face readback receipts.
// A rejected or unknown reply must never be retried with this representation.
export function compileTiebaWebMedia(body,{emotes=[],images=[]}={}){
 compileTiebaMedia(body,{emotes,images})
 if(!emotes.length&&!images.length)return body
 const escape=value=>value.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;')
 return escape(body).replace(/\r?\n/g,'<br>')+emotes.map(name=>'<img class="BDE_Smiley" type="face" width="30" height="30" changedsize="false" src="https://tb2.bdstatic.com/tb/editor/images/client/'+names.get(name)+'.png" alt="'+escape(name)+'">').join('')+images.map(image=>'<img class="BDE_Image" pic_type="0" src="'+escape(image.url)+'" width="'+image.width+'" height="'+image.height+'">').join('')
}
// The mobile web reply API uses (#name), not the new PC editor's #(name).
// Protocol references: TiebaLite EmotionUtil.REGEX_WEB and WebTiebaApi.webReply.
export function compileTiebaWapMedia(body,{emotes=[]}={}){
 assertTiebaPublishableText(body);checkedTiebaEmotes(emotes)
 return body+emotes.map(name=>'(#'+name+')').join('')
}
export function parseTiebaWapPictureUpload(text){
 const parsed=parseUploadReceipt(text);let info=parsed.image_info,url=parsed.image_url
 try{const value=JSON.parse(text),data=value.data??value;if(Number(value.no??value.error_code??data.errno??0)!==0)return null;info=info||data.imageInfo||data.image_info;url=url||data.imageSrc||data.image_src}catch{}
 if(typeof info!=='string'||!info||info.length>65536||/[\0\r\n]/.test(info)||typeof url!=='string')return null
 try{let value=new URL(url.startsWith('//')?'https:'+url:url);if(value.hostname==='m.tiebaimg.com'&&value.pathname==='/timg'&&['http:','https:'].includes(value.protocol)&&!value.username&&!value.password&&!value.port){const source=value.searchParams.get('src');if(!source)return null;value=new URL(source)}if(!['http:','https:'].includes(value.protocol)||!['tiebapic.baidu.com','imgsrc.baidu.com','imgsa.baidu.com'].includes(value.hostname)||value.username||value.password||value.port)return null;value.protocol='https:';return {image_info:info,url:value.href}}catch{return null}
}
/** Use only the canonical identity and dimensions explicitly returned by the
 * official upload. A content SHA, arbitrary opaque handle or filename inferred
 * from another source is never promoted to a platform picture ID. */
export function parseWapUploadAppPicture(text){
 const upload=parseTiebaWapPictureUpload(text);if(!upload)return null
 const fields=/^([a-fA-F0-9]{40}),([1-9]\d{0,3}),([1-9]\d{0,3}),(true|false)$/.exec(upload.image_info);if(!fields)return null
 const width=Number(fields[2]),height=Number(fields[3]);if(width>8000||height>8000||width*height>40000000)return null
 try{const url=new URL(upload.url),file=/^\/forum\/pic\/item\/([a-fA-F0-9]{40})\.(?:jpg|jpeg|png|gif|webp)$/i.exec(url.pathname)
  if(url.protocol!=='https:'||!['tiebapic.baidu.com','imgsrc.baidu.com','imgsa.baidu.com'].includes(url.hostname)||url.username||url.password||url.port||url.search||url.hash||!file||file[1]!==fields[1])return null
  return{pic_id:fields[1],width,height,url:url.href}
 }catch{return null}
}
export function parseTiebaPictureUpload(value){
 if(!value||typeof value!=='object'||Number(value.error_code??value.no??value.error?.errno??0)!==0)return null
 const data=value.data??value,info=data.pic_info??data.picInfo,origin=info?.origin_pic??info?.originPic,ref={pic_id:String(data.pic_id??data.picId??''),width:Number(origin?.width),height:Number(origin?.height),url:origin?.pic_url??origin?.picUrl??''}
 if(Number(data.errno??data.error_code??0)!==0)return null
 try{compileTiebaMedia('',{images:[ref]});const url=new URL(ref.url);if(!['http:','https:'].includes(url.protocol)||!['tiebapic.baidu.com','imgsrc.baidu.com','imgsa.baidu.com'].includes(url.hostname)||url.username||url.password||url.port)return null;url.protocol='https:';ref.url=url.href}catch{return null}
 return ref
}
export function tiebaPictureUploadShape(value){
 const data=value?.data??value,info=data?.pic_info??data?.picInfo,origin=info?.origin_pic??info?.originPic
 const keys=node=>node&&typeof node==='object'&&!Array.isArray(node)?Object.keys(node).slice(0,30):[]
 let url;try{url=new URL(origin?.pic_url??origin?.picUrl??'')}catch{}
 return {top_keys:keys(value),data_keys:keys(data),picture_keys:keys(info),origin_keys:keys(origin),picture_id_type:typeof(data?.pic_id??data?.picId),width_type:typeof origin?.width,height_type:typeof origin?.height,url_protocol:url?.protocol??'',url_host:url?.hostname??''}
}
function emoteName(part){
 for(const value of [part.protocol_token,part.c]){if(typeof value!=='string')continue;const key=/^image_emoticon\d*$/.exec(value)?.[0];if(key&&keys.has(key))return keys.get(key);if(names.has(value))return value;const name=/^#\(([^)]+)\)$/.exec(value)?.[1];if(names.has(name))return name}
 return ''
}
// WAP publication may replace the upload handle. Only an exact byte match to
// the selected native asset can establish that an unrelated handle is ours.
export async function verifyTiebaReadbackImage(row,{body,emotes=[],image,fetcher=fetch,signal}={}){
 if(!/^[a-f0-9]{64}$/.test(image?.asset_sha256??''))return null
 const pictures=(row.content_parts??[]).filter(part=>part.type===3)
 if(pictures.length!==1)return null
 const field=pictures[0].protocol_fields?.find(field=>field.field===25&&field.base64)
 let url;try{url=new URL(field?Buffer.from(field.base64,'base64').toString('utf8'):pictures[0].src??pictures[0].link);if(url.protocol!=='https:'||!['tiebapic.baidu.com','imgsrc.baidu.com','imgsa.baidu.com'].includes(url.hostname)||url.username||url.password||url.port||url.hash||!/^\/forum\/pic\/item\/[a-zA-Z0-9_-]+\.(?:jpg|jpeg|png|gif|webp)$/.test(url.pathname))return null}catch{return null}
 const verified={...image,url:url.href}
 if(!matchesTiebaMedia(row,{body,emotes,images:[verified]}))return null
 const response=await fetcher(url.href,{method:'GET',redirect:'error',credentials:'omit',signal})
 if(!response.ok||!/^image\//i.test(response.headers.get('content-type')??'')||Number(response.headers.get('content-length')??0)>2*1024*1024){await response.body?.cancel().catch(()=>{});return null}
 let size=0;const hash=createHash('sha256'),reader=response.body?.getReader()
 if(!reader)return null
 try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>2*1024*1024)return null;hash.update(value)}}finally{await reader.cancel().catch(()=>{})}
 return size&&hash.digest('hex')===image.asset_sha256?verified:null
}
export function matchesTiebaMedia(row,{body,emotes=[],images=[]}={}){
 const parts=row.content_parts??[],faces=parts.filter(part=>part.type===2),pics=parts.filter(part=>part.type===3)
 if(faces.length!==emotes.length||pics.length!==images.length||faces.some((part,i)=>emoteName(part)!==emotes[i]))return false
 for(let i=0;i<images.length;i++){
  const expected=new URL(images[i].url).pathname.split('/').at(-1),values=[pics[i].src,pics[i].link,...(pics[i].protocol_fields??[]).filter(p=>p.base64).map(p=>Buffer.from(p.base64,'base64').toString('utf8'))]
  if(!values.some(value=>{try{const url=new URL(value);return ['http:','https:'].includes(url.protocol)&&['tiebapic.baidu.com','imgsrc.baidu.com','imgsa.baidu.com'].includes(url.hostname)&&url.pathname.split('/').at(-1)===expected}catch{return false}}))return false
 }
 const ranges=parts.filter(part=>part.type===2||part.type===3).sort((a,b)=>b.start-a.start);let plain=row.text
 for(const part of ranges){if(!Number.isSafeInteger(part.start)||!Number.isSafeInteger(part.end)||part.start<0||part.end<part.start||part.end>plain.length)return false;plain=plain.slice(0,part.start)+plain.slice(part.end)}
 const compact=s=>s.replace(/\s+/gu,'');return compact(plain)===compact(body)
}
