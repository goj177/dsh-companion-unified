/** One query contract. Automatic recall derives a small index; manual search
 * still validates the original caller's query against the hard service limit. */
export const MEMORY_QUERY_MAX_CHARS=500
export const AUTOMATIC_MEMORY_QUERY_MAX_CHARS=Math.min(180,MEMORY_QUERY_MAX_CHARS)
const graphemes=new Intl.Segmenter('zh',{granularity:'grapheme'})

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
