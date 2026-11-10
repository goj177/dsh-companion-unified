/** One query contract. Automatic recall derives a small index; manual search
 * still validates the original caller's query against the hard service limit. */
export const MEMORY_QUERY_MAX_CHARS=500
export const AUTOMATIC_MEMORY_QUERY_MAX_CHARS=Math.min(180,MEMORY_QUERY_MAX_CHARS)
const graphemes=new Intl.Segmenter('zh',{granularity:'grapheme'})

/** Derived retrieval text only. Public Tieba's reply-routing prefix and media
 * placeholders are protocol framing, not the message's semantic caption.
 * DMs/other platforms keep their original text; no source or authority changes. */
export function semanticMessageText(value,{platform,conversation_id}={}){
  if(typeof value!=='string')return ''
  const thread=conversation_id===undefined||conversation_id===''||typeof conversation_id==='string'&&conversation_id.startsWith('thread:')
  if(platform!=='tieba'||!thread)return value
  return value.replace(/^\s*回复[ \t]+[^:：\r\n]{1,160}[:：][ \t]*/u,'').replace(/\[(?:图片|贴吧图片|贴吧表情)\]/gu,' ').trim()
}

function fragment(value,max,tail=false){
  const units=[...graphemes.segment(value)].map(part=>part.segment),chosen=[];let length=0
  if(tail)units.reverse()
  for(const unit of units){if(length+unit.length>max)break;chosen.push(unit);length+=unit.length}
  if(tail)chosen.reverse()
  return chosen.join('').trim()
}

/** This changes only the optional search index, never source text or authority.
 * Invalid host hints are skipped; clipped UTF-16 from a producer is repaired in
 * the derived index and grapheme boundaries are preserved. */
export function automaticMemoryQuery(value){
  if(typeof value!=='string')return ''
  const clean=value.toWellFormed().replace(/\0/g,' ').replace(/\s+/gu,' ').trim()
  if(clean.length<=48)return clean
  // A small tail fragment usually contains the current question. Put it first
  // so the search engine's finite term budget cannot spend itself on a long
  // introduction before reaching that question.
  const tail=fragment(clean,48,true),head=fragment(clean,48)
  return [...new Set([tail,head].filter(Boolean))].join(' ')
}
