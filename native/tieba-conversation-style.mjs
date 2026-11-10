/** Read-only cadence hints from actual outgoing replies; never posts or edits. */
import {createHash} from 'node:crypto'
import {NativeStore} from './store.mjs'
import {maskSpeechText} from './speech-core.mjs'
import {accountSourceUid} from './source-context.mjs'

export const SEVEN_WORDS=Object.freeze(['典','绷','急','孝','赢','乐','麻'])
export const SEVEN_WORD_POLICY='【遇到辱骂时的七字回击】'
const uid=value=>typeof value==='string'&&/^[1-9]\d{0,29}$/.test(value)?value:''
const parse=value=>{try{return JSON.parse(value??'{}')}catch{return{}}}
const hash=value=>createHash('sha256').update(value).digest('hex')
const patterns=[
 ['典',/(?:太|好|够)典(?:了)?(?=$|[\s\p{P}])|(?:^|[\s\p{P}])典(?:了|中典)?(?=$|[\s\p{P}])/u],
 ['绷',/绷不住|没绷住|难绷|好绷(?:了|啊)?(?=$|[\s\p{P}])|(?:^|[\s\p{P}])绷(?:了)?(?=$|[\s\p{P}])/u],
 ['急',/别(?:着)?急|不着急|急了|急眼|急啥|急什么|着什么急|(?:^|[\s\p{P}])急(?=$|[\s\p{P}])/u],
 ['孝',/孝子|尽孝|孝死|(?:^|[\s\p{P}])孝(?:了)?(?=$|[\s\p{P}])/u],
 ['赢',/赢了|赢麻|又赢|算你赢|包赢|(?:^|[\s\p{P}])赢(?=$|[\s\p{P}])/u],
 ['乐',/乐子|乐了|乐死|乐麻|乐不|(?:^|[\s\p{P}])乐(?=$|[\s\p{P}])/u],
 ['麻',/麻了|麻中麻|(?:^|[\s\p{P}])麻(?=$|[\s\p{P}])/u],
]
export function sevenWordUsage(value){
 if(typeof value!=='string'||!value.isWellFormed()||value.length>200000)return[]
 const body=maskSpeechText(value).text.normalize('NFKC');return patterns.filter(([,pattern])=>pattern.test(body)).map(([word])=>word)
}
// This is a conservative cue for offering an optional style hint, not a
// sentiment verdict or authority to act. Quotes, reports and product criticism
// remain ordinary discussion; the model must still judge the current sentence.
export function directPersonalInsult(value){
 if(typeof value!=='string')return false
 const body=maskSpeechText(value).text.normalize('NFKC').replace(/^\s*回复\s+[^:：\n]{1,80}[:：]\s*/u,'').slice(0,4000),word='(?:傻[逼比卵屌]|煞笔|蠢货|蠢鱼|傻鱼|脑残|智障|狗东西|\\bsb\\b)'
 if(!new RegExp(word,'iu').test(body))return false
 const own=/我.{0,8}骂你|老子.{0,8}骂你/u.test(body)
 if(!own&&/(?:有人|别人|楼主|他说|她说|他骂|她骂|骂你|说你)/u.test(body))return false
 if(new RegExp('(?:他|她|楼主|作品|模型|游戏|角色|deepseek|chatgpt).{0,6}'+word,'iu').test(body))return false
 if(new RegExp('(?:你|您|大肥鱼|欧鲸鲸|这条鱼).{0,6}'+word,'iu').test(body))return true
 return body.replace(new RegExp(word,'giu'),'').replace(/[你您这条个真是就死滚啊呀吧了\s\p{P}]/gu,'').length===0
}
function recipient(store,row,now){
 const target=parse(row.target_json),receipt=parse(row.receipt_json),a=uid(target.reply_uid),b=uid(receipt.reply_uid)
 if(a&&b&&a!==b)return''
 if(a||b)return a||b
 // Pending top-level replies do not have a receipt yet. The official reader's
 // exact target cache may identify the recipient; never infer it from names.
 if(!uid(target.thread_id)||!uid(target.post_id))return''
 const child=uid(target.sub_reply_id),key=child?'tieba.location.sub:'+target.thread_id+':'+target.post_id+':'+child:'tieba.location.post:'+target.thread_id+':'+target.post_id,cache=store.db.prepare('SELECT kind,value_json,expires_at FROM cache_entries WHERE key=?').get(key)
 if(!cache||cache.kind!=='tieba.location.'+(child?'sub':'post')||cache.expires_at<=now)return''
 return uid(parse(cache.value_json).author_uid)
}
export function tiebaConversationSevenState({store,actor_uid,now=Date.now()}={}){
 if(!(store instanceof NativeStore))throw Error('贴吧连聊提示需要原生存储')
 const disabled={enabled:false,context:''},actor=uid(actor_uid),profile=store.listPersonaProfiles().find(row=>row.platform==='tieba')
 if(!actor||!profile||profile.follow_main||!profile.body_md.includes(SEVEN_WORD_POLICY)||!Number.isSafeInteger(now)||profile.updated_at>now)return disabled
 const settings=store.getDocument('settings')?.value,entity=store.getDocument(settings?.platform_document_ids?.tieba??'tieba')?.value.account_entity_id
 if(actor===accountSourceUid(store,'tieba',entity))return disabled
 const since=0,confirmed=store.db.prepare("SELECT *,CAST(body AS BLOB) body_bytes FROM actions WHERE platform='tieba' AND kind='tieba.reply' AND status='confirmed' AND confirmed_at>=? AND (json_extract(target_json,'$.reply_uid')=? OR json_extract(receipt_json,'$.reply_uid')=?) ORDER BY confirmed_at DESC,id DESC LIMIT 48").all(since,actor,actor),recent=[]
 for(const row of confirmed){
  const receipt=parse(row.receipt_json),body=Buffer.from(row.body_bytes).toString('utf8')
  if(receipt.source!=='server_receipt'||receipt.accepted!==true||receipt.rejected===true||!uid(receipt.server_id)||hash(body)!==row.body_digest||recipient(store,row,now)!==actor)continue
  const words=sevenWordUsage(body);if(!words.length)continue;recent.push({id:row.id,words});if(recent.length===6)break
 }
 const pending=store.db.prepare("SELECT *,CAST(body AS BLOB) body_bytes FROM actions WHERE platform='tieba' AND kind='tieba.reply' AND status IN ('queued','leased','submitting','submitted','unknown') AND created_at>=? ORDER BY created_at DESC,id DESC LIMIT 48").all(since),reserved=new Set(),uncertain=new Set(),future=[]
 for(const row of pending){const body=Buffer.from(row.body_bytes).toString('utf8');if(hash(body)!==row.body_digest||recipient(store,row,now)!==actor)continue;const words=sevenWordUsage(body);for(const word of words){reserved.add(word);if(row.status==='unknown')uncertain.add(word)}if(row.status!=='unknown')future.push({id:row.id,words})}
 const counts=Object.fromEntries(SEVEN_WORDS.map(word=>[word,recent.filter(row=>row.words.includes(word)).length])),used=SEVEN_WORDS.filter(word=>counts[word]>0),planned=SEVEN_WORDS.filter(word=>reserved.has(word)),projected=[...recent].reverse().concat([...future].reverse()).slice(-6),projectedWords=new Set(projected.flatMap(row=>row.words));let candidates=SEVEN_WORDS.filter(word=>!projectedWords.has(word)&&!uncertain.has(word))
 if(!candidates.length){const free=SEVEN_WORDS.filter(word=>!uncertain.has(word)),pool=free.length?free:SEVEN_WORDS,fewest=Math.min(...pool.map(word=>projected.filter(row=>row.words.includes(word)).length));candidates=pool.filter(word=>projected.filter(row=>row.words.includes(word)).length===fewest)}
 const context='【同人回击备选·UID '+actor+'】仅对明确骂你本人的原句使用：近'+recent.length+'次已用'+(used.join('、')||'无')+'；待发预留'+(planned.join('、')||'无')+'。可从'+candidates.join('、')+'选贴合字义的一个或相关句式，换字换说法。普通聊天也可自然用；质疑、纠错、批评模型不等于骂你，别因此硬怼；不每句硬加。'
 return{enabled:true,actor_uid:actor,confirmed_reply_count:recent.length,used,reserved:planned,candidates,context}
}
