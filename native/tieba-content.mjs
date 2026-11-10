/** Tieba protocol markers are source metadata, never text to publish. */
export class TiebaContentError extends Error{
  constructor(message){super(message);this.name='TiebaContentError';this.code='invalid_content'}
}

export const TIEBA_EMOTICON_READ_PLACEHOLDER='[贴吧表情]'
const protectedRanges=text=>[...text.matchAll(/```[\s\S]*?(?:```|$)|`[^`\r\n]*`|https?:\/\/[^\s<>"'`]+/g)].map(match=>[match.index,match.index+match[0].length])
const protocolPattern=()=>/image_emoticon\d*|\[贴吧(?:表情|图片|内容片段)(?:[:：][^\]\r\n]{0,80})?\]/gi
const bareMarkers=text=>{const ranges=protectedRanges(text);return [...text.matchAll(protocolPattern())].filter(match=>!ranges.some(([start,end])=>match.index>=start&&match.index+match[0].length<=end))}

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

export function assertTiebaPublishableText(body){
  if(typeof body!=='string'||!body.isWellFormed())throw new TiebaContentError('贴吧发表正文必须是完整文本')
  if(bareMarkers(body).length)throw new TiebaContentError('正文包含未渲染的贴吧协议占位；请改用自然文字或已支持的真实媒体，不改写已冻结草稿')
  const ranges=protectedRanges(body)
  if([...body.matchAll(/\(#[\p{L}\p{N}_~]{1,30}\)|#\((?:[\p{L}\p{N}_~]{1,30}|pic,[^()\r\n]{1,200})\)/gu)].some(match=>!ranges.some(([start,end])=>match.index>=start&&match.index+match[0].length<=end)))throw new TiebaContentError('正文包含手写贴吧表情协议，请把可用名称放入target.emotes，或直接使用Unicode emoji；不改写已冻结草稿')
  return body
}
