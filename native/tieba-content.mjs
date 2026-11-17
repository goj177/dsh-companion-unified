/** Tieba protocol markers are source metadata, never text to publish. */
export class TiebaContentError extends Error{
  constructor(message){super(message);this.name='TiebaContentError';this.code='invalid_content'}
}

export const TIEBA_EMOTICON_READ_PLACEHOLDER='[贴吧表情]'
const protectedRanges=text=>[...text.matchAll(/```[\s\S]*?(?:```|$)|`[^`\r\n]*`|https?:\/\/[^\s<>"'`]+/g)].map(match=>[match.index,match.index+match[0].length])
const protocolPattern=()=>/image_emoticon\d*|\[贴吧(?:表情|图片|内容片段)(?:[:：][^\]\r\n]{0,80})?\]/gi
const bareMarkers=text=>{const ranges=protectedRanges(text);return [...text.matchAll(protocolPattern())].filter(match=>!ranges.some(([start,end])=>match.index>=start&&match.index+match[0].length<=end))}
const foreignFaceLabel=/^(?:s[ \t]*:[ \t]*[\p{L}\p{N}_~-]{1,24}(?:[ \t]*:[ \t]*[\p{L}\p{N}_~-]{1,32})?|表情[ \t]*:[ \t]*[\p{L}\p{N}_~-]{1,40})$/iu
const otherFaceLabel=/^(?:[\p{L}]{0,5}(?:眼笑|嘴笑)|diss|doge|狗头|笑哭|哭笑|微笑|大笑|可爱|捂脸|捂嘴|流汗|无语|吧唧(?:吧唧)?)$/iu
const replyFaceFallbacks=new Map([['乐','😄'],['二哈','🐶']])
const replyLabels=/^[\p{L}][\p{L}\p{N}_~-]*$/u
const ordinaryReplyLabels=new Set(['附注','补充说明'])
const bracketLabels=()=>/\[([^\]\r\n]{1,80})\]|［([^］\r\n]{1,80})］/gu
const faceLabel=(half,full)=>(half??full).normalize('NFKC').trim()

export function normalizeTiebaReplyEmotes(body){
  const ranges=protectedRanges(body)
  return body.replace(bracketLabels(),(match,half,full,offset)=>{
    if(ranges.some(([start,end])=>offset>=start&&offset+match.length<=end))return match
    return replyFaceFallbacks.get(faceLabel(half,full))??match
  })
}

export function stripTiebaReplyPrefix(body,verifiedName){
  if(!verifiedName)return body
  const space='[\\p{Zs}\\t]*'
  const prefix=space+'回复'+space+RegExp.escape(verifiedName)+space+'[:：]'+space
  return body.replace(new RegExp('^(?:'+prefix+')+','u'),'')
}

/** Legacy flat notifications may already contain a protocol token. Keep code
 * and ordinary URLs exact; unrendered prose tokens become read-only markers. */
export function parseTiebaReadText(value){
  const original=typeof value==='string'?value:'',markers=bareMarkers(original),content_parts=[];let text='',offset=0
  for(const match of markers){text+=original.slice(offset,match.index);const start=text.length;text+=TIEBA_EMOTICON_READ_PLACEHOLDER;content_parts.push({index:content_parts.length,type:2,kind:'emoticon',start,end:text.length,protocol_token:match[0],source_kind:'flat_protocol_marker',display_text:TIEBA_EMOTICON_READ_PLACEHOLDER});offset=match.index+match[0].length}
  text+=original.slice(offset);return {text,content_parts}
}
export function renderTiebaReadText(value){return parseTiebaReadText(value).text}

/** Plain text stays in row.text, not duplicated in metadata. Protocol fields
 * retain exact source values for inspection; no field is guessed as an emoji. */
export function renderTiebaContentParts(parts=[]){
  if(!Array.isArray(parts))throw new TiebaContentError('贴吧来源内容片段无效')
  let text='';const content_parts=[]
  for(const part of parts){
    const type=part.type??0,source=typeof part.source_text==='string'?part.source_text:'',start=text.length,read=type===2?{text:TIEBA_EMOTICON_READ_PLACEHOLDER,content_parts:[]}:type===3&&!source.trim()?{text:'[图片]',content_parts:[]}:parseTiebaReadText(source)
    text+=read.text
    const item={index:content_parts.length,type,kind:({0:'text',1:'link',2:'emoticon',3:'image',4:'mention'})[type]??'protocol_content',start,end:text.length,source_chars:source.length}
    if(type===2){item.protocol_token=source;item.display_text=TIEBA_EMOTICON_READ_PLACEHOLDER;item.source_kind='protobuf_type_2'}
    if(type!==0&&part.protocol_fields?.length)item.protocol_fields=part.protocol_fields
    for(const field of ['link','src','c','uid','is_native_app'])if(part[field]!==undefined)item[field]=part[field]
    if(read.content_parts.length)item.embedded_markers=read.content_parts.map(marker=>({...marker,start:start+marker.start,end:start+marker.end}))
    content_parts.push(item)
  }
  return {text,content_parts}
}

export function pageTiebaContentParts(parts,{offset=0,limit=40}={}){
  if(!Array.isArray(parts)||!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>100)throw new TiebaContentError('贴吧来源片段分页参数无效')
  const end=Math.min(parts.length,offset+limit);return {items:parts.slice(offset,end),offset,total_parts:parts.length,next_offset:end<parts.length?end:null,read_only:true}
}

export function assertTiebaPublishableText(body,{knownFace=()=>false,reply=false}={}){
  if(typeof body!=='string'||!body.isWellFormed())throw new TiebaContentError('贴吧发表正文必须是完整文本')
  if(bareMarkers(body).length)throw new TiebaContentError('正文包含未渲染的贴吧协议占位；请改用自然文字或已支持的真实媒体，不改写已冻结草稿')
  const ranges=protectedRanges(body)
  for(const match of body.matchAll(bracketLabels())){
    if(ranges.some(([start,end])=>match.index>=start&&match.index+match[0].length<=end))continue
    const label=faceLabel(match[1],match[2])
    if(foreignFaceLabel.test(label))throw new TiebaContentError('正文包含贴吧不能渲染的表情代码或占位；请移除，或使用贴吧支持的原生表情；不改写已冻结草稿')
    if(knownFace(label)||replyFaceFallbacks.has(label)||otherFaceLabel.test(label))throw new TiebaContentError('正文包含未渲染的方括号表情；请移除，或使用贴吧支持的原生表情；不改写已冻结草稿')
    if(reply&&replyLabels.test(label)&&!ordinaryReplyLabels.has(label))throw new TiebaContentError('正文包含未识别的方括号标签。普通称呼去掉括号；表情请用 Unicode、emotes 返回的原生表情，或 images 返回的表情包素材 ID')
  }
  if([...body.matchAll(/\(#[\p{L}\p{N}_~]{1,30}\)|#\((?:[\p{L}\p{N}_~]{1,30}|pic,[^()\r\n]{1,200})\)/gu)].some(match=>!ranges.some(([start,end])=>match.index>=start&&match.index+match[0].length<=end)))throw new TiebaContentError('正文包含手写贴吧表情协议，请把可用名称放入target.emotes，或直接使用Unicode emoji；不改写已冻结草稿')
  return body
}

/** A literal face label and the same native face can render twice on Tieba. */
export function assertNoDuplicateTiebaFaces(body,emotes=[]){
  const ranges=protectedRanges(body)
  for(const match of body.matchAll(/\[([^\]\r\n]{1,30})\]/gu)){
    if(emotes.includes(match[1])&&!ranges.some(([start,end])=>match.index>=start&&match.index+match[0].length<=end))throw new TiebaContentError('正文与原生表情重复；请保留一种表达后再准备发表')
  }
}
