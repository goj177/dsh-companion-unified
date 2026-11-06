/** Source-grounded expression learning. Host proof owns source, delivery and
 * feedback attribution. This module never calls a model, changes a persona,
 * grants a permission, or publishes anything. */
import {createHash} from 'node:crypto'
import {isDeepStrictEqual} from 'node:util'
import {NativeStore} from './store.mjs'
import {isPlainObject} from './contracts.mjs'
import {redactText} from './memory-rules.mjs'
import {maskSpeechText} from './speech-core.mjs'
import {shanghaiTime} from '../policy.mjs'
import {accountSourceUid} from './source-context.mjs'

const freeze=value=>{for(const child of Object.values(value))if(child&&typeof child==='object')freeze(child);return Object.freeze(value)}
export const LEARNING_LOOP_DEFAULTS=freeze({enabled:true,policy:{max_cards:200,max_hint_chars:360,meme_cooldown_minutes:30,recent_window_minutes:180,max_meme_uses_per_context:2,trial_uses_required:2,positive_feedback_required:1,review_interval_minutes:240,review_sources_per_batch:3,review_max_per_day:3,review_retry_minutes:60,review_max_attempts:3}})
export const freshLearningLoopState=(at=0)=>({version:1,revision:0,updated_at:at,reviews:[],offers:[],usages:[],blocks:[]})
const MINUTE=60000,DAY=86400000,PLATFORMS=['qq','tieba','bilibili','harness','system','web'],KINDS=['meme','phrase','habit'],STATUSES=['trial','active','paused','retired']
const hash=value=>createHash('sha256').update(value).digest('hex'),clone=value=>structuredClone(value),normal=value=>String(value??'').normalize('NFKC').toLowerCase()
/** Model output only. The current card remains complete; an exact historical
 * duplicate points to it, while stored/admin versions stay untouched. */
export function projectNativeLearningToolResult(value){
  const current=value?.item?.value
  if(value?.ok!==true||!isPlainObject(current)||!Array.isArray(current.versions))return value
  let changed=false
  const versions=current.versions.map(version=>{
    if(!isPlainObject(version)||Object.hasOwn(version,'same_as_current'))return version
    const same=['content','evidence_ids'].filter(key=>Object.hasOwn(current,key)&&Object.hasOwn(version,key)&&isDeepStrictEqual(version[key],current[key]))
    if(!same.length)return version
    const projected={...version,same_as_current:same};for(const key of same)delete projected[key]
    if(JSON.stringify(projected).length>=JSON.stringify(version).length)return version
    changed=true;return projected
  })
  return changed?{...value,item:{...value.item,value:{...current,versions}}}:value
}
const fields=(v,allowed)=>{if(!isPlainObject(v)||Object.keys(v).some(k=>!allowed.includes(k)))throw new Error('学习卡参数包含未知字段')}
const text=(value,max,label='学习文本')=>{if(typeof value!=='string'||!value.isWellFormed()||value.length>max||value.includes('\0'))throw new Error(label+'无效');return redactText(value).replace(/[\r\n\t]+/g,' ').replace(/\s+/g,' ').trim()}
const high=n=>n>=0xd800&&n<=0xdbff,low=n=>n>=0xdc00&&n<=0xdfff
const truncate=(value,max)=>{let end=Math.min(value.length,Math.max(0,max));if(end>0&&end<value.length&&high(value.charCodeAt(end-1))&&low(value.charCodeAt(end)))end--;return value.slice(0,end)}
const keyText=(v,max=512)=>{if(typeof v!=='string'||!v||v.length>max||/[\0\r\n]/.test(v))throw new Error('需要稳定的原生来源标识');return v}
const arrayText=(value,max,count)=>{if(!Array.isArray(value)||!value.length||value.length>count)throw new Error('学习卡需要明确场景、触发线索和避用条件');const out=[...new Set(value.map(v=>text(v,max)))];if(out.some(v=>!v))throw new Error('学习卡场景不能为空');return out}
const boundIds=c=>new Set(Array.isArray(c.bound_evidence_ids)?c.bound_evidence_ids:[])
const stop=new Set('一个 这个 那个 可以 应该 不要 不宜 不适合 时候 场景 情境 内容 对方 别人 有人 我们 自己 他们 出现 使用 表达 情况 关于 以及 对于'.split(' '))
const terms=value=>[...new Set((typeof Intl.Segmenter==='function'?[...new Intl.Segmenter('zh',{granularity:'word'}).segment(normal(value))].filter(x=>x.isWordLike).map(x=>x.segment):normal(value).match(/[\p{Script=Han}]{2,6}|[a-z0-9]{2,20}/gu)??[]).filter(x=>x.length>1&&!stop.has(x)))].slice(0,40)
// A reaction word or an approximate count alone does not identify a scene.
// Retain them in the saved card; only exclude them as automatic recall anchors.
const weakCues=new Set('离谱 好笑 搞笑 看到 看见 看着 回复 发帖 帖子 开头 句尾 句末 常跟 一类 一下 列举 越长 越多 很多 多个 几十 上百 几百'.split(' '))
const cueAnchor=value=>!weakCues.has(value)&&!/^(?:[零一二三四五六七八九十百千万两\d]+|[几数上][十百千万]+)(?:个(?:人)?|人|名|位|项)?$/.test(value)
// "非游戏场合" and "没有幼稚行为" describe negated conditions. Splitting
// these into 游戏/幼稚 would forbid the very contexts the card applies to.
// Keep a negated clause intact; the original avoid text still reaches the model.
const avoidTerms=value=>value.split(/[、，,；;。]|或/u).flatMap(part=>{
  const clause=normal(part.trim());if(!clause)return[]
  return /(?:^非|没有|并非|并不|不是|不属于|泛指|所有|任何|全体)/u.test(clause)?[clause.replace(/^泛指/u,'')]:terms(clause)
})
const forbidden=/image_emoticon|\[贴吧(?:表情|图片|内容片段)\]|(?:名字|自称|人设|人格|身份).{0,8}(?:改成|设为|替换|改为)|(?:提升|绕过|忽略|放开).{0,12}(?:权限|验证|限制|系统)|owner_authorized|follow_main|main_profile_id|系统提示词|bili_jct|sessdata|bduss|凭据|令牌/i
const serious=value=>/去世|病危|自杀|轻生|丧事|抑郁|受伤|事故|灾难|欺凌|骚扰|诉讼|起诉|报案|医疗|诊断|赔偿|欠款|还贷|严肃|认真回答|(?:正经|认真)(?:的)?求助|怎么.{0,20}委婉|(?:想|希望).{0,6}委婉|不要玩梗|别玩梗|不开玩笑/i.test(value)
const explanation=value=>/(?:梗|词|说法).{0,10}(?:什么意思|啥意思|解释|含义|来源|用法)|(?:解释|科普|定义|翻译|复述|原样|照抄|引用).{0,20}|意思是|这个梗叫|这个梗指|我学会了|已学会|学到了|学习卡|教学示例|举个例子|例如|比如|正例[:：]|反例[:：]/i.test(value.replace(/(?:别|不要|不用|无需|不必|请勿)(?:再|给我)?(?:解释|科普|定义|翻译|复述|照抄|引用)(?:过程|含义|用法|原文)?/g,''))
function bodyOf(input){try{const value=JSON.parse(input),out=[];const walk=(node,key='')=>{if(typeof node==='string'){if(['text','body','content','subtitle'].includes(key))out.push(node);return}if(Array.isArray(node))node.forEach(v=>walk(v,key));else if(isPlainObject(node))for(const[k,v]of Object.entries(node))if(!/author|user|nickname|portrait|uid|mid|avatar|url|ref|id$/i.test(k))walk(v,k)};walk(value);return out.join('\n')}catch{return input}}
function contextOf(input={}){
  const platform=input.platform??'harness',conversation_id=input.conversation_id??'',session_id=input.session_id??''
  if(!PLATFORMS.includes(platform)||typeof conversation_id!=='string'||conversation_id.length>512||typeof session_id!=='string'||session_id.length>512)throw new Error('学习卡上下文无效')
  const c={...input,platform,conversation_id,session_id,owner_authorized:input.owner_authorized===true,autonomous:input.autonomous===true}
  c.context_hash=hash(platform+'\0'+conversation_id+'\0'+(['harness','system','web'].includes(platform)?session_id:conversation_id?'':session_id));c.session_hash=hash(session_id)
  return c
}
const ownerSurface=c=>c.owner_authorized&&c.visibility!=='public'&&!(c.platform==='qq'&&c.conversation_id.startsWith('group:'))&&!(c.platform==='bilibili'&&/^(?:comment:|live:)/.test(c.conversation_id))
const readable=(v,c)=>v.visibility==='public'||ownerSurface(c)||v.visibility==='conversation'&&v.platform===c.platform&&v.conversation_id===c.conversation_id
const sourceBody=row=>normal(bodyOf(row.text??'')).replace(/\s+/g,' ').trim()
const contentHash=value=>hash(JSON.stringify(value))
const cardId=(kind,label,visibility,platform,conversation)=>'learning-card:'+hash(JSON.stringify([kind,normal(label),visibility,visibility==='public'?'':platform,visibility==='conversation'?conversation:'']))
function quoteOnlyFromSelf(row,quote,store){
  const needle=normal(quote),self=accountSourceUid(store,row.platform);let parsed
  try{parsed=JSON.parse(row.text)}catch{}
  if(parsed&&isPlainObject(parsed)){
    const context=parsed.source_context??{},selfUid=context.account_self_uid??self,records=Array.isArray(parsed.records)?parsed.records:null
    if(records){const matched=records.filter(r=>normal(String(r.text??'')).replace(/\s+/g,' ').includes(needle));if(!matched.length)return true;return matched.every(r=>(r.author_role??r.attribution?.author_role)==='account_self'||!!selfUid&&String(r.author_uid??r.uid??r.attribution?.current_speaker_uid??'')===selfUid)}
    if(context.source_author_is_self===true)return true
  }
  if(!self)return false
  const lines=String(row.text).split(/\r?\n/).filter(line=>normal(line).replace(/\s+/g,' ').includes(needle))
  return lines.length>0&&lines.every(line=>{const id=/\buid\s*=\s*([1-9]\d*)\b/.exec(line)?.[1]??/^\s*([1-9]\d{2,})\s/.exec(line)?.[1];return id===self})
}

export class NativeLearningLoop{
  constructor({store,now=store?.now??Date.now}={}){if(!(store instanceof NativeStore)||typeof now!=='function')throw new Error('学习闭环必须使用原生NativeStore');this.store=store;this.now=now}
  _now(){const n=this.now();if(!Number.isSafeInteger(n)||n<0)throw new Error('学习闭环时钟无效');return n}
  _config(){const row=this.store.getDocument('learning-loop');if(row&&row.type!=='learning_loop')throw new Error('学习闭环配置类型无效');const value=row?.value??LEARNING_LOOP_DEFAULTS;return{document:row,enabled:this.store.getDocument('settings')?.value.enabled!==false&&this.store.getDocument('learning')?.value.enabled!==false&&value.enabled!==false,policy:{...LEARNING_LOOP_DEFAULTS.policy,...value.policy}}}
  _state(){const row=this.store.getDocument('learning-loop-state');if(row&&row.type!=='learning_loop_state')throw new Error('学习闭环状态类型无效');return{document:row,value:clone(row?.value??freshLearningLoopState(this._now()))}}
  _save(state){state.value.revision++;state.value.updated_at=this._now();state.value.offers=state.value.offers.slice(-200);state.value.usages=state.value.usages.slice(-200);state.value.blocks=state.value.blocks.slice(-200);state.value.reviews=state.value.reviews.slice(-3000);this.store.putDocument({id:'learning-loop-state',type:'learning_loop_state',expected_revision:state.document?.revision??0,value:state.value})}
  _mutable(c){if(this.store.readOnly||!this._config().enabled)throw new Error('学习闭环当前关闭或只读');if(!c.owner_authorized&&!c.autonomous&&!c.allow_current_learning)throw new Error('需要可信主人、当前教学或活动能力')}
  _event(key,c,subtype,metadata={}){const event_key='learning-loop:'+subtype+':'+hash(key);const old=this.store.db.prepare('SELECT id FROM journal_events WHERE event_key=?').get(event_key);if(old)return{id:old.id,duplicate:true};return this.store.appendJournalEvent({event_key,event_type:'learning',platform:c.platform,direction:'internal',visibility:'owner',text:'',source_at:this._now(),source_type:'native_learning_loop',metadata:{subtype,task_id:c.task_id??'',source_scope:c.source_scope??'',world_fact_verified:false,persona_or_permission_mutation:false,...metadata}})}
  _rows(){return this.store.listDocuments({type:'learning_item',limit:1000})}
  _get(id){keyText(id,160);const row=this.store.getDocument(id);if(!row||row.type!=='learning_item')throw new Error('没有这张原生学习卡');return row}
  _snapshot(value){return{revision:value.revision,status:value.status,content:clone(value.content),evidence_ids:[...value.evidence_ids],at:value.updated_at}}
  _version(card,revision){const indexed=card.value.versions.find(x=>x.revision===revision);if(indexed)return indexed;const row=this.store.db.prepare("SELECT metadata_json FROM journal_events WHERE source_type='native_learning_loop' AND json_extract(metadata_json,'$.card_id')=? AND json_extract(metadata_json,'$.snapshot.revision')=? ORDER BY rowid DESC LIMIT 1").get(card.id,revision);return row?JSON.parse(row.metadata_json).snapshot:null}
  _sameContentVersions(card){const digest=contentHash(card.value.content),versions=new Set(card.value.versions.filter(x=>contentHash(x.content)===digest).map(x=>x.revision));for(const row of this.store.db.prepare("SELECT json_extract(metadata_json,'$.snapshot.revision') revision FROM journal_events WHERE source_type='native_learning_loop' AND json_extract(metadata_json,'$.card_id')=? AND json_extract(metadata_json,'$.content_hash')=?").all(card.id,digest))if(Number.isSafeInteger(row.revision))versions.add(row.revision);return versions}
  _proof(id,c){
    keyText(id,160);const row=this.store.db.prepare('SELECT * FROM evidence WHERE id=?').get(id)
    if(row){const source=JSON.parse(row.source_json);return{...row,source}}
    const op=c.human_source
    if(c.verified_human_source===true&&op?.id===id&&typeof op.text==='string'&&op.platform===c.platform&&op.conversation_id===c.conversation_id&&(!c.actor_uid||op.actor_uid===c.actor_uid))return{id,text:op.text,platform:op.platform,conversation_id:op.conversation_id,actor_uid:op.actor_uid,source_type:'user',direction:'in',visibility:op.platform==='harness'?'owner':'conversation',source_at:op.source_at,source:{kind:'user',pipeline:'trusted-human-operation'}}
    return null
  }
  _registered(id){return !!this.store.db.prepare("SELECT 1 FROM journal_events WHERE source_type='native_learning' AND json_extract(metadata_json,'$.subtype')='learning_observation' AND (json_extract(metadata_json,'$.evidence_id')=? OR EXISTS(SELECT 1 FROM json_each(metadata_json,'$.evidence_ids') WHERE value=?)) LIMIT 1").get(id,id)}
  _public(row,registered_ids){return row?.visibility==='public'&&row.direction==='observation'&&row.source_type==='platform'&&row.status==='confirmed'&&row.confirmation==='source_observation'&&row.source.kind==='platform_read'&&row.source.explicit===true&&(registered_ids===undefined?this._registered(row.id):registered_ids.has(row.id))}
  _human(row,c){return !!row&&row.source_type==='user'&&row.direction==='in'&&['user','human','user_statement'].includes(row.source?.kind)&&boundIds(c).has(row.id)&&row.platform===c.platform&&row.conversation_id===c.conversation_id&&(!c.actor_uid||row.actor_uid===c.actor_uid)&&!['rejected','unknown'].includes(row.status)}
  _content(input,c){
    const kind=input.kind??'meme';if(!KINDS.includes(kind))throw new Error('学习卡类别无效')
    const content={label:text(input.label,40),meaning:text(input.meaning,240),cues:arrayText(input.cues,60,8),applies_to:arrayText(input.applies_to,80,6),avoid_in:arrayText(input.avoid_in,80,6),example_good:text(input.example_good,240),example_bad:text(input.example_bad,240),source_quotes:input.source_quotes}
    if(!content.label||!content.meaning||!content.example_good||!content.example_bad||normal(content.example_good)===normal(content.example_bad)||forbidden.test(content.label+' '+content.meaning+' '+content.example_good))throw new Error('学习卡需要含义、不同的正反例，且不得改变身份或权限')
    if(kind!=='habit'&&!normal(content.example_good).includes(normal(content.label)))throw new Error('正例必须展示这张表达卡的实际用词')
    const ids=Array.isArray(input.evidence_ids)?[...new Set(input.evidence_ids.map(x=>keyText(x,160)))]:[]
    if(!ids.length||ids.length>4)throw new Error('学习卡的evidence_ids需要1至4个真实来源ID；从sources结果或source_quotes.evidence_id取值')
    if(!Array.isArray(content.source_quotes)||!content.source_quotes.length||content.source_quotes.length>4)throw new Error('学习卡的source_quotes需要1至4条含evidence_id和quote的原文片段')
    const proofs=ids.map(id=>this._proof(id,c));if(proofs.some(x=>!x))throw new Error('学习来源不存在或尚未实际消费')
    content.source_quotes=content.source_quotes.map(part=>{fields(part,['evidence_id','quote']);if(!ids.includes(part.evidence_id))throw new Error('原文片段必须引用本卡来源');const quote=text(part.quote,300),proof=proofs.find(x=>x.id===part.evidence_id);if(!quote||!sourceBody(proof).includes(normal(quote)))throw new Error('学习片段未在实际原文中找到');return{evidence_id:part.evidence_id,quote}})
    for(const part of content.source_quotes){const proof=proofs.find(p=>p.id===part.evidence_id);if(this._public(proof)&&quoteOnlyFromSelf(proof,part.quote,this.store)&&!content.source_quotes.some(other=>normal(other.quote)===normal(part.quote)&&this._public(proofs.find(p=>p.id===other.evidence_id))&&!quoteOnlyFromSelf(proofs.find(p=>p.id===other.evidence_id),other.quote,this.store)))throw new Error('不能把账号自己的旧回复或归属不明的跨作者片段回炉当新学习来源')}
    if(!content.source_quotes.some(x=>normal(x.quote).includes(normal(content.label))))throw new Error('梗名label未在source_quotes.quote中出现；请逐字引用包含该标签的真实原文片段')
    let visibility='public',platform=c.platform,conversation_id='',source_kind='public_read'
    if(proofs.every(p=>this._public(p))&&(!c.allow_current_learning||c.autonomous||c.owner_authorized)){
      if(!c.owner_authorized&&!c.autonomous)throw new Error('公开深读学习需要可信活动边界')
      platform=proofs[0].platform
    }else{
      if(!c.owner_authorized&&!c.allow_current_learning||proofs.some(p=>!this._human(p,c)))throw new Error('教学学习必须引用本轮已消费的真人原话')
      const teaching=proofs.map(p=>maskSpeechText(p.text).text).join(' ')
      if(!/意思是|是指|表示|用来|用于|用在|适合|不适合|表达习惯|(?:以后|可以|应该|希望|记住|学|教).{0,24}(?:说|用|表达|细节|梗)/.test(teaching))throw new Error('真人原话没有明确教学语境；不能把普通一句话当成全局学习指令')
      source_kind='owner_teaching';visibility=proofs.some(p=>p.visibility==='owner')?'owner':'conversation';platform=c.platform;conversation_id=visibility==='conversation'?c.conversation_id:''
      if(visibility==='conversation'&&!conversation_id)throw new Error('私域教学缺少原会话')
      if(!c.owner_authorized)visibility='conversation'
    }
    return{kind,content,evidence_ids:ids,visibility,platform,conversation_id,source_kind}
  }
  ensure(){if(this.store.readOnly)return{initialized:false,status:'read_only'};return this.store.transaction(()=>{const config=this._config(),state=this._state();let initialized=false;if(!config.document){this.store.putDocument({id:'learning-loop',type:'learning_loop',expected_revision:0,value:clone(LEARNING_LOOP_DEFAULTS)});initialized=true}if(!state.document){this.store.putDocument({id:'learning-loop-state',type:'learning_loop_state',expected_revision:0,value:state.value});initialized=true}return{initialized,status:'ready'}})}
  create(input,trusted={}){
    fields(input,['kind','label','meaning','cues','applies_to','avoid_in','example_good','example_bad','source_quotes','evidence_ids']);const c=contextOf(trusted);this._mutable(c);const data=this._content(input,c)
    return this.store.transaction(()=>{const id=cardId(data.kind,data.content.label,data.visibility,data.platform,data.conversation_id),old=this.store.getDocument(id);if(old){if(contentHash(old.value.content)===contentHash(data.content))return{ok:true,duplicate:true,item:old};throw new Error('同名学习卡已有内容，请先核对版本再修订')}
      if(this._rows().length>=this._config().policy.max_cards)throw new Error('学习卡数量已达上限；原卡与来源保留')
      const at=this._now(),value={id:'learning-item-'+hash(id).slice(0,40),...data,status:'trial',revision:1,created_at:at,updated_at:at,used:0,positive:0,negative:0,last_used_at:0,last_offered_at:0,versions:[{revision:1,status:'trial',content:clone(data.content),evidence_ids:[...data.evidence_ids],at}]},doc=this.store.putDocument({id,type:'learning_item',expected_revision:0,value});this._event(id,c,'card_created',{card_id:id,card_revision:1,source_kind:data.source_kind,evidence_ids:data.evidence_ids,content_hash:contentHash(value.content),snapshot:this._snapshot(value)});return{ok:true,status:'trial',item:doc,model_calls:0}
    })
  }
  revise(input,trusted={}){
    fields(input,['id','expected_revision','kind','label','meaning','cues','applies_to','avoid_in','example_good','example_bad','source_quotes','evidence_ids']);const c=contextOf(trusted);this._mutable(c)
    return this.store.transaction(()=>{const old=this._get(input.id);if(old.revision!==input.expected_revision)throw new Error('学习卡版本冲突');if(!readable(old.value,c))throw new Error('当前会话无权修订这张学习卡');if(!c.owner_authorized&&!c.autonomous)throw new Error('修订卡片需要可信复核能力');const data=this._content(Object.fromEntries(Object.entries(input).filter(([k])=>!['id','expected_revision'].includes(k))),c),v=clone(old.value)
      if(old.value.visibility!=='public'&&(data.visibility!==old.value.visibility||data.platform!==old.value.platform||data.conversation_id!==old.value.conversation_id))throw new Error('修订不能扩大原卡的私域可见范围')
      Object.assign(v,data,{status:'trial',revision:v.revision+1,updated_at:this._now()});v.versions.push({revision:v.revision,status:v.status,content:clone(v.content),evidence_ids:[...v.evidence_ids],at:this._now()});v.versions=v.versions.slice(-8);const doc=this.store.putDocument({id:old.id,type:old.type,expected_revision:old.revision,value:v});this._event(old.id+':'+v.revision,c,'card_revised',{card_id:old.id,card_revision:v.revision,content_hash:contentHash(v.content),snapshot:this._snapshot(v)});return{ok:true,item:doc}
    })
  }
  _match(card,query,scene='',seriousFlag=false){
    const body=normal(query+' '+scene),meaning=card.content
    if(!body.trim()||card.kind==='meme'&&(seriousFlag||serious(body)||explanation(body)))return 0
    const avoid=meaning.avoid_in.flatMap(avoidTerms);if(avoid.some(x=>body.includes(x)))return 0
    const cues=meaning.cues.flatMap(v=>[normal(v),...terms(v)]),hit=cues.filter(x=>x.length>1&&(cueAnchor(x)||card.kind==='meme'&&x===normal(meaning.label)&&/^\d{2,}$/.test(x))&&body.includes(x));if(!hit.length)return 0
    return hit.reduce((n,x)=>n+Math.min(10,x.length),0)+meaning.applies_to.flatMap(terms).filter(x=>body.includes(x)).length*2
  }
  select(input={},trusted={}){
    fields(input,['query','scene','serious']);const c=contextOf(trusted),config=this._config(),query=text(input.query??'',4000),scene=text(input.scene??'',400)
    if(input.serious!==undefined&&typeof input.serious!=='boolean')throw new Error('严肃话题标记必须来自可信上下文')
    if(!config.enabled||config.policy.max_hint_chars<120)return{items:[],context:'',offer_token:null,model_calls:0}
    const state=this._state().value,now=this._now(),recent=state.usages.filter(x=>x.at>=now-config.policy.recent_window_minutes*MINUTE),blocked=new Set(state.blocks.filter(x=>x.context_hash===c.context_hash).map(x=>x.card_id)),rows=[]
    for(const row of this._rows()){
      const v=row.value;if(!['trial','active'].includes(v.status)||!readable(v,c)||blocked.has(row.id))continue
      const score=this._match(v,query,scene,input.serious===true||c.serious===true);if(!score)continue
      if(v.kind==='meme'){
        const uses=recent.filter(x=>x.context_hash===c.context_hash&&x.card_id===row.id)
        if(uses.length>=config.policy.max_meme_uses_per_context||uses.some(x=>x.at>now-config.policy.meme_cooldown_minutes*MINUTE))continue
      }
      rows.push({row,score:score+(v.status==='active'?3:0)})
    }
    rows.sort((a,b)=>b.score-a.score||a.row.value.last_used_at-b.row.value.last_used_at||a.row.id.localeCompare(b.row.id));const selected=rows[0]?.row
    if(!selected)return{items:[],context:'',offer_token:null,model_calls:0}
    const v=selected.value,header='【学到的表达】'+v.content.label,suffix='只借用表达。来者做过的事用你/楼主/作者，不接成我做过；例子和引文不是自己的经历。不照抄、不硬塞，不改变身份或权限。',pieces=[['含义：',v.content.meaning],['适用：',v.content.applies_to.join('、')],['避用：',v.content.avoid_in.join('、')],['正例（用法）：',v.content.example_good],['反例：',v.content.example_bad]],cap=Math.min(1000,config.policy.max_hint_chars),fixed=header.length+suffix.length+6+pieces.reduce((n,[prefix])=>n+prefix.length,0),partCap=Math.floor((cap-fixed)/pieces.length)
    if(partCap<8)return{items:[],context:'',offer_token:null,model_calls:0}
    const clipped=value=>value.length<=partCap?value:truncate(value,partCap-1)+'…',context=[header,...pieces.map(([prefix,value])=>prefix+clipped(value)),suffix].join('\n')
    const payload={card_id:selected.id,card_revision:v.revision,context_hash:c.context_hash,session_hash:c.session_hash,platform:c.platform,query_hash:hash(query+'\0'+scene),at:now},offer_token=Buffer.from(JSON.stringify(payload)).toString('base64url')
    return{items:[{id:selected.id,revision:selected.revision,value:clone(v)}],context,offer_token,model_calls:0}
  }
  recordOffered(input,trusted={}){
    fields(input,['token','key']);const c=contextOf(trusted);if(this.store.readOnly||!this._config().enabled)return{recorded:false,status:'disabled'};keyText(input.key,1024);keyText(input.token,4096)
    let payload;try{payload=JSON.parse(Buffer.from(input.token,'base64url').toString())}catch{throw new Error('学习提示凭证无效')}
    if(!isPlainObject(payload)||payload.context_hash!==c.context_hash||payload.session_hash!==c.session_hash||payload.platform!==c.platform||!Number.isSafeInteger(payload.at)||payload.at>this._now()||this._now()-payload.at>10*MINUTE)throw new Error('学习提示不属于本轮实际上下文')
    return this.store.transaction(()=>{const card=this._get(payload.card_id);if(card.value.revision!==payload.card_revision||!['trial','active'].includes(card.value.status)||!readable(card.value,c))return{recorded:false,status:'stale'};const eventKey='offer:'+hash(input.key);if(this.store.db.prepare('SELECT id FROM journal_events WHERE event_key=?').get('learning-loop:offered:'+hash(eventKey)))return{recorded:true,duplicate:true,status:'duplicate'}
      const state=this._state(),offer={id:'learning-offer-'+hash(eventKey).slice(0,40),...payload,task_id:typeof c.task_id==='string'?c.task_id.slice(0,240):'',source_scope:typeof c.source_scope==='string'?c.source_scope.slice(0,512):''};state.value.offers.push(offer);this._save(state);const v=clone(card.value);v.last_offered_at=this._now();this.store.putDocument({id:card.id,type:card.type,expected_revision:card.revision,value:v});this._event(eventKey,c,'offered',{offer_id:offer.id,card_id:card.id,card_revision:v.revision,context_hash:c.context_hash});return{recorded:true,id:offer.id,status:'offered'}
    })
  }
  _actualPublication(input,c){
    if(c.output_kind!=='publication_receipt')return null
    const row=this.store.db.prepare('SELECT * FROM actions WHERE id=?').get(input.source_ref);if(!row||row.status!=='confirmed'||row.platform!==c.platform)return null
    const receipt=JSON.parse(row.receipt_json),metadata=JSON.parse(row.metadata_json),target=JSON.parse(row.target_json)
    if(receipt.source!=='server_receipt'||receipt.accepted!==true||typeof receipt.server_id!=='string'||!receipt.server_id.trim()||['0','-1'].includes(receipt.server_id)||receipt.rejected===true)return null
    let body=row.body
    if(c.platform==='qq'){try{const segments=JSON.parse(body);body=segments.filter(x=>x.type==='text').map(x=>x.text??x.data?.text??'').join('\n')}catch{return null}}
    if(body!==input.text)return null
    if(target.conversation_id&&target.conversation_id!==c.conversation_id)return null
    const expected=c.platform==='bilibili'&&['bilibili.comment','bilibili.reply'].includes(row.kind)?'comment:'+(target.object_type??'1')+':'+target.object_id+':'+(target.root_reply_id&&target.root_reply_id!=='0'?target.root_reply_id:receipt.server_id):c.platform==='tieba'&&row.kind==='tieba.reply'?'thread:'+target.thread_id+':'+(target.post_id??receipt.server_id):null
    if(expected&&c.conversation_id!==expected)return null
    return{origin_task_id:metadata.prepared_in?.task_id??metadata.prepared_in?.round_id??'',metadata}
  }
  recordUsage(input,trusted={}){
    fields(input,['key','text','source_ref','source_at','card_ids']);const c=contextOf(trusted);keyText(input.key,1024);keyText(input.source_ref,512)
    if(this.store.readOnly||!this._config().enabled)return{recorded:false,status:'disabled',items:[]}
    if(c.verified_output!==true||!['assistant_final','publication_receipt'].includes(c.output_kind))throw new Error('学习应用只能来自实际生成或服务器确认的发表')
    if(typeof input.text!=='string'||input.text.length>200000||!input.text.isWellFormed())throw new Error('实际输出无效')
    const publication=this._actualPublication(input,c);if(c.output_kind==='publication_receipt'&&!publication)throw new Error('发表尚无真实成功回执或正文不一致')
    const at=input.source_at??this._now();if(!Number.isSafeInteger(at)||at<0||at>this._now()+MINUTE)throw new Error('实际应用时间无效')
    const plain=maskSpeechText(input.text).text.replace(/\0+/g,' ').trim(),query=typeof c.query==='string'?c.query:'',scene=typeof c.scene==='string'?c.scene:''
    if(!plain||explanation(plain)||explanation(query)||normal(plain)===normal(query))return{recorded:false,status:'explanation_or_echo',items:[]}
    return this.store.transaction(()=>{
      const state=this._state(),candidateIds=Array.isArray(input.card_ids)?new Set(input.card_ids):null,origin=c.origin_task_id??c.offer_task_id??c.task_id??'',items=[]
      const offers=state.value.offers.filter(o=>o.at<=at&&at-o.at<=DAY&&(!candidateIds||candidateIds.has(o.card_id))&&(o.context_hash===c.context_hash&&o.session_hash===c.session_hash||publication&&origin&&publication.origin_task_id===origin&&o.task_id===origin))
      for(const offer of offers.reverse()){
        const card=this._get(offer.card_id),v=clone(card.value);if(items.some(x=>x.card_id===card.id)||!['trial','active'].includes(v.status)||!readable(v,c)||v.revision!==offer.card_revision)continue
        if(v.visibility!=='public'&&offer.context_hash!==c.context_hash)continue
        if(v.kind==='meme'&&(c.serious===true||serious(query)||serious(plain)))continue
        const label=normal(v.content.label),body=normal(plain),surface=value=>normal(value).replace(/[\p{P}\p{Z}\s]/gu,''),habitExample=surface(v.content.example_good)
        let index=body.indexOf(label)
        if(index<0){if(v.kind!=='habit'||habitExample.length<6||!surface(body).includes(habitExample))continue;index=0}
        if(v.kind!=='habit'&&(plain.length<=v.content.label.length+2||/^(?:[，。！？!?,.\s]*)$/.test(body.replace(label,''))))continue
        if(query&&!this._match(v,query,scene,c.serious===true))continue
        const key='usage:'+hash(input.key+'\0'+card.id);if(this.store.db.prepare('SELECT id FROM journal_events WHERE event_key=?').get('learning-loop:used:'+hash(key)))continue
        let excerptStart=Math.max(0,index-24);if(excerptStart>0&&low(plain.charCodeAt(excerptStart))&&high(plain.charCodeAt(excerptStart-1)))excerptStart--
        const excerpt=text(truncate(plain.slice(excerptStart),120),120),usage={id:'learning-use-'+hash(key).slice(0,40),card_id:card.id,card_revision:v.revision,context_hash:c.context_hash,session_hash:c.session_hash,platform:c.platform,at,excerpt,source_ref:input.source_ref,output_hash:hash(input.text),...(typeof c.actor_uid==='string'&&c.actor_uid?{actor_uid:c.actor_uid.slice(0,240)}:{})}
        state.value.usages.push(usage);v.used++;v.last_used_at=at;v.updated_at=this._now();this.store.putDocument({id:card.id,type:card.type,expected_revision:card.revision,value:v});this._event(key,c,'used',{usage_id:usage.id,card_id:card.id,card_revision:v.revision,context_hash:c.context_hash,source_ref:input.source_ref,output_hash:usage.output_hash,usage});items.push({id:usage.id,card_id:card.id})
        if(v.kind==='meme')break
      }
      if(items.length)this._save(state);return{recorded:items.length>0,status:items.length?'used':'no_verified_use',items,model_calls:0}
    })
  }
  _feedbackTone(proof,polarity,label=''){const own=maskSpeechText(proof.text).text;if(!own.trim())return false;if(polarity==='positive')return /(?:这个|这句|这次|刚才|你|说得|用得|接得).{0,20}(?:贴切|自然|好笑|合适|不错|有用|喜欢|对了|到位)|^(?:好笑|贴切|用得好|接得好|这句不错)[！!。\s]*$/.test(own)&&!/(?:不|没|别|哪有|谈不上).{0,6}(?:贴切|自然|好笑|合适|不错|喜欢|有用)|(?:请|让|输出|重复|翻译).{0,20}/.test(own);const expression=/梗|用法|说法|表达|这句|这样说|这么说|玩笑|硬套|用错|说错|说得|用得|接得/.test(own)||label&&normal(own).includes(normal(label));return !!expression&&/别再|不要再|不合适|不贴切|硬套|错场景|玩错|用错|说错|太多|重复|机械|生硬|不好笑|别玩梗|不自然|不对|不喜欢|尴尬|纠正/.test(own)}
  feedback(input,trusted={}){
    fields(input,['key','usage_id','polarity','evidence_ids']);const c=contextOf(trusted);keyText(input.key,1024);keyText(input.usage_id,80)
    if(!['positive','negative','correction'].includes(input.polarity))throw new Error('反馈类型无效')
    if(this.store.readOnly||!this._config().enabled)return{recorded:false,status:'disabled'}
    return this.store.transaction(()=>{const state=this._state(),usage=state.value.usages.find(x=>x.id===input.usage_id);if(!usage||usage.context_hash!==c.context_hash)throw new Error('反馈必须关联同一语境的真实最近应用');if(usage.actor_uid&&usage.actor_uid!==c.actor_uid)throw new Error('这次用法回应的是另一位来者，不能替他人投反馈')
      const latest=state.value.usages.filter(x=>x.context_hash===c.context_hash).at(-1);if(latest?.id!==usage.id||this._now()-usage.at>DAY)throw new Error('反馈不能替历史或其他应用投票')
      if(!Array.isArray(input.evidence_ids)||!input.evidence_ids.length||input.evidence_ids.length>4)throw new Error('反馈需要本轮真人来源')
      const card=this._get(usage.card_id);if(!readable(card.value,c))throw new Error('当前会话不能评价其他私域学习卡')
      const ids=[...new Set(input.evidence_ids.map(id=>keyText(id,160)))],proofs=ids.map(id=>this._proof(id,c));if(proofs.some(p=>!this._human(p,c)||!Number.isSafeInteger(p.source_at)||p.source_at<usage.at||p.source_at>this._now()+MINUTE||!this._feedbackTone(p,input.polarity,card.value.content.label)))throw new Error('反馈必须是已消费的本人明确评价，不能自评、引用或默认沉默')
      const feedbackKey='feedback:'+hash(JSON.stringify([usage.id,ids.sort()]));if(this.store.db.prepare('SELECT id FROM journal_events WHERE event_key=?').get('learning-loop:feedback:'+hash(feedbackKey)))return{recorded:true,duplicate:true,status:'duplicate'}
      const v=clone(card.value);if(input.polarity==='positive')v.positive++;else v.negative++
      let newStatus=v.status
      if(input.polarity!=='positive'){
        if(c.owner_authorized)newStatus='paused';else if(!state.value.blocks.some(x=>x.card_id===card.id&&x.context_hash===c.context_hash))state.value.blocks.push({card_id:card.id,context_hash:c.context_hash,at:this._now()})
      }else if(v.status==='trial'){
        const sameVersions=this._sameContentVersions(card),uses=this.store.db.prepare("SELECT metadata_json FROM journal_events WHERE source_type='native_learning_loop' AND json_extract(metadata_json,'$.subtype')='used' AND json_extract(metadata_json,'$.card_id')=?").all(card.id).map(r=>JSON.parse(r.metadata_json)).filter(x=>sameVersions.has(x.card_revision)),positive=this.store.db.prepare("SELECT metadata_json FROM journal_events WHERE source_type='native_learning_loop' AND json_extract(metadata_json,'$.subtype')='feedback' AND json_extract(metadata_json,'$.card_id')=? AND json_extract(metadata_json,'$.polarity')='positive'").all(card.id).map(r=>JSON.parse(r.metadata_json)).filter(x=>sameVersions.has(x.card_revision)).length+1
        if(new Set(uses.map(x=>x.usage_id)).size>=Math.max(2,this._config().policy.trial_uses_required)&&positive>=Math.max(1,this._config().policy.positive_feedback_required))newStatus='active'
      }
      if(newStatus!==v.status){v.status=newStatus;v.revision++;v.versions.push({revision:v.revision,status:v.status,content:clone(v.content),evidence_ids:[...v.evidence_ids],at:this._now()});v.versions=v.versions.slice(-8)}v.updated_at=this._now()
      const item=this.store.putDocument({id:card.id,type:card.type,expected_revision:card.revision,value:v});this._save(state);this._event(feedbackKey,c,'feedback',{usage_id:usage.id,card_id:card.id,card_revision:usage.card_revision,polarity:input.polarity,evidence_ids:ids,global_pause:c.owner_authorized&&input.polarity!=='positive',context_hash:c.context_hash,...(newStatus!==card.value.status?{content_hash:contentHash(v.content),snapshot:this._snapshot(v)}:{})});return{recorded:true,status:v.status,item,context_blocked:state.value.blocks.some(x=>x.card_id===card.id&&x.context_hash===c.context_hash),model_calls:0}
    })
  }
  recentUsages(input={},trusted={}){
    fields(input,['limit']);const c=contextOf(trusted),limit=Math.min(20,input.limit??5);if(!Number.isSafeInteger(limit)||limit<0)throw new Error('最近应用数量无效')
    const items=this._state().value.usages.filter(x=>x.context_hash===c.context_hash&&this._now()-x.at<=DAY).reverse().slice(0,limit).flatMap(x=>{const card=this._get(x.card_id);return readable(card.value,c)?[{id:x.id,card_id:x.card_id,label:card.value.content.label,at:x.at,source_ref:x.source_ref,...(x.actor_uid?{actor_uid:x.actor_uid}:{})}]:[]})
    return{items,model_calls:0}
  }
  feedbackCurrent(input,trusted={}){
    fields(input,['key','polarity','evidence_ids']);const c=contextOf(trusted),recent=this.recentUsages({limit:20},c).items
    if(!recent.length)return{recorded:false,status:'no_recent_usage'}
    if(recent[0].actor_uid&&recent[0].actor_uid!==c.actor_uid)return{recorded:false,status:'wrong_feedback_actor'}
    const latest=recent.filter(x=>x.source_ref===recent[0].source_ref&&x.at===recent[0].at),proofs=(input.evidence_ids??[]).map(id=>this._proof(id,c)),own=proofs.filter(p=>this._human(p,c)).map(p=>maskSpeechText(p.text).text).join(' '),mentions=latest.filter(u=>normal(own).includes(normal(u.label))),cards=new Set(latest.map(x=>x.card_id))
    if(cards.size>1&&!mentions.length)return{recorded:false,status:'ambiguous_usage'}
    const chosen=mentions[0]??recent[0]
    // A named older expression is still not substituted for another latest
    // output. The caller can request an explicit, attributable review instead.
    if(chosen.id!==recent[0].id)return{recorded:false,status:'ambiguous_usage'}
    return this.feedback({...input,usage_id:chosen.id},c)
  }
  manage(input,trusted={}){
    fields(input,['id','operation','expected_revision','version']);const c=contextOf(trusted);this._mutable(c);if(!ownerSurface(c))throw new Error('管理学习卡需要主人私有设置入口')
    if(!['pause','resume','rollback','retire'].includes(input.operation))throw new Error('学习卡管理操作无效')
    return this.store.transaction(()=>{const card=this._get(input.id);if(card.revision!==input.expected_revision)throw new Error('学习卡版本冲突');const v=clone(card.value)
      if(input.operation==='rollback'){const version=this._version(card,input.version);if(!version)throw new Error('没有这个学习卡版本');v.content=clone(version.content);v.evidence_ids=[...version.evidence_ids];v.status=version.status==='active'?'trial':version.status}
      else v.status=input.operation==='pause'?'paused':input.operation==='retire'?'retired':'trial'
      if(input.operation==='resume'){const state=this._state(),prior=state.value.blocks.length;state.value.blocks=state.value.blocks.filter(x=>x.card_id!==card.id);if(state.value.blocks.length!==prior)this._save(state)}
      v.revision++;v.updated_at=this._now();v.versions.push({revision:v.revision,status:v.status,content:clone(v.content),evidence_ids:[...v.evidence_ids],at:this._now()});v.versions=v.versions.slice(-8);const item=this.store.putDocument({id:card.id,type:card.type,expected_revision:card.revision,value:v});this._event(card.id+':'+v.revision,c,'managed',{card_id:card.id,operation:input.operation,version:input.version??null,card_revision:v.revision,content_hash:contentHash(v.content),snapshot:this._snapshot(v)});return{ok:true,item}
    })
  }
  list(input={},trusted={}){fields(input,['query','status','limit']);const c=contextOf(trusted),query=normal(input.query??''),limit=Math.min(200,input.limit??50);if(!Number.isSafeInteger(limit)||limit<0||input.status!==undefined&&!STATUSES.includes(input.status))throw new Error('学习卡列表参数无效');const items=this._rows().filter(row=>readable(row.value,c)&&(!input.status||row.value.status===input.status)&&(!query||normal(row.value.content.label+' '+row.value.content.meaning).includes(query))).sort((a,b)=>b.value.updated_at-a.value.updated_at).slice(0,limit);return{items,model_calls:0}}
  status(trusted={}){const c=contextOf(trusted),rows=this._rows().filter(row=>readable(row.value,c)),items=this.list({limit:200},c).items,counts=Object.fromEntries(STATUSES.map(status=>[status,rows.filter(row=>row.value.status===status).length]));return{enabled:this._config().enabled,counts,revision:this._state().value.revision,pending_sources:this.pendingSources({limit:1},c).pending_count,items,model_calls:0}}
  searchMemory(input={},trusted={}){
    fields(input,['query','platform','limit','max_chars']);const c=contextOf(trusted),query=text(input.query??'',1000),limit=Math.min(50,input.limit??2),cap=Math.min(6400,input.max_chars??1800)
    if(input.platform!==undefined&&!PLATFORMS.includes(input.platform))throw new Error('学习检索平台无效')
    if(!Number.isSafeInteger(limit)||limit<0||!Number.isSafeInteger(cap)||cap<0)throw new Error('学习记忆索引分页无效')
    if(!this._config().enabled||!query)return{items:[],text:'',chars:0,untrusted:true,model_calls:0}
    const blocked=new Set(this._state().value.blocks.filter(x=>x.context_hash===c.context_hash).map(x=>x.card_id)),words=terms(query),scored=this._rows().filter(row=>['trial','active'].includes(row.value.status)&&readable(row.value,c)&&!blocked.has(row.id)&&(input.platform===undefined||row.value.platform===input.platform)).map(row=>{const v=row.value,body=normal(v.content.label+' '+v.content.meaning+' '+v.content.cues.join(' ')+' '+v.content.applies_to.join(' '));return{row,score:(normal(query).includes(normal(v.content.label))?20:0)+words.reduce((n,w)=>n+(body.includes(w)?Math.min(8,w.length):0),0)}}).filter(x=>x.score>0).sort((a,b)=>b.score-a.score||a.row.id.localeCompare(b.row.id))
    const items=[],lines=[];let used=0
    for(const{row}of scored){if(items.length>=limit)break;const v=row.value,item={id:row.id,label:v.content.label,status:v.status,summary:truncate('含义：'+v.content.meaning+'；适用：'+v.content.applies_to.join('、')+'；避用：'+v.content.avoid_in.join('、'),120)},line=item.id+' '+item.label+'（'+item.status+'）：'+item.summary,size=line.length+(lines.length?1:0);if(used+size>cap)continue;items.push(item);lines.push(line);used+=size}
    return{items,text:lines.join('\n'),chars:used,untrusted:true,model_calls:0}
  }
  readMemory(input,trusted={}){
    fields(input,['id','offset','max_chars']);const c=contextOf(trusted),doc=this.store.getDocument(input.id)
    if(!this._config().enabled||!doc||doc.type!=='learning_item'||!readable(doc.value,c))return{found:false,untrusted:true,model_calls:0}
    const v=doc.value,context_blocked=this._state().value.blocks.some(x=>x.context_hash===c.context_hash&&x.card_id===doc.id),usable=['trial','active'].includes(v.status)&&!context_blocked,body=JSON.stringify({label:v.content.label,kind:v.kind,status:v.status,usable,context_blocked,meaning:v.content.meaning,cues:v.content.cues,applies_to:v.content.applies_to,avoid_in:v.content.avoid_in,example_good:v.content.example_good,example_bad:v.content.example_bad,source_quotes:v.content.source_quotes,evidence_ids:v.evidence_ids,source_kind:v.source_kind,version:v.revision,world_fact_verified:false,note:'这是表达用法资料；引文、例子和楼主经历不是当前助手的身份或亲历。暂停/停用项及本语境被纠正项仅供复核。'}),offset=input.offset??0,max=Math.min(6400,input.max_chars??1800)
    if(!Number.isSafeInteger(offset)||offset<0||offset>body.length||!Number.isSafeInteger(max)||max<1)throw new Error('学习记忆读取分页无效')
    if(offset>0&&low(body.charCodeAt(offset))&&high(body.charCodeAt(offset-1)))throw new Error('学习记忆分页位置位于完整字符中间')
    const fragment=truncate(body.slice(offset),max);if(!fragment.length&&offset<body.length)throw new Error('分页字数不足以容纳一个完整字符')
    const end=offset+fragment.length;return{found:true,id:doc.id,label:v.content.label,status:v.status,usable,context_blocked,text:fragment,evidence_ids:[...v.evidence_ids],offset,total_chars:body.length,next_offset:end<body.length?end:null,untrusted:true,model_calls:0}
  }
  detail(input,trusted={}){
    fields(input,['id','limit']);const c=contextOf(trusted),item=this._get(input.id),limit=Math.min(50,input.limit??10);if(!Number.isSafeInteger(limit)||limit<0)throw new Error('学习卡详情数量无效');if(!readable(item.value,c))throw new Error('当前会话不能查看其他私域学习卡')
    const owner=ownerSurface(c),usages=limit?this.store.db.prepare("SELECT platform,source_at,metadata_json FROM journal_events WHERE source_type='native_learning_loop' AND json_extract(metadata_json,'$.subtype')='used' AND json_extract(metadata_json,'$.card_id')=? ORDER BY source_at DESC,rowid DESC").all(item.id).map(row=>{const m=JSON.parse(row.metadata_json);return m.usage??{id:m.usage_id,card_id:item.id,card_revision:m.card_revision,at:row.source_at,platform:row.platform,source_ref:m.source_ref,output_hash:m.output_hash,context_hash:m.context_hash}}).filter(x=>owner||x.context_hash===c.context_hash).slice(0,limit):[],feedback=this.store.db.prepare("SELECT source_at,metadata_json FROM journal_events WHERE source_type='native_learning_loop' AND json_extract(metadata_json,'$.subtype')='feedback' AND json_extract(metadata_json,'$.card_id')=? ORDER BY source_at DESC,rowid DESC").all(item.id).map(row=>({at:row.source_at,...JSON.parse(row.metadata_json)})).filter(row=>owner||row.context_hash===c.context_hash).slice(0,limit),version_history=this.store.db.prepare("SELECT json_extract(metadata_json,'$.snapshot.revision') revision,json_extract(metadata_json,'$.snapshot.status') status,json_extract(metadata_json,'$.snapshot.at') at FROM journal_events WHERE source_type='native_learning_loop' AND json_extract(metadata_json,'$.card_id')=? AND json_extract(metadata_json,'$.snapshot.revision') IS NOT NULL ORDER BY rowid DESC").all(item.id)
    return{item,usages,feedback,version_history,model_calls:0}
  }
  _sourceRows(){return this.store.db.prepare("SELECT id,platform,ref,source_at,metadata_json FROM journal_events WHERE source_type='native_learning' AND json_extract(metadata_json,'$.subtype')='learning_observation' ORDER BY source_at DESC,rowid DESC").all()}
  _reviewLedger(state,policy){
    const current=new Map(state.reviews.map(x=>[x.evidence_id,x])),history=new Map(),queued=new Set()
    for(const row of this.store.db.prepare("SELECT source_at,metadata_json FROM journal_events WHERE source_type='native_learning_loop' AND json_extract(metadata_json,'$.subtype')='review_batch' ORDER BY rowid").all()){
      const meta=JSON.parse(row.metadata_json)
      for(const id of meta.evidence_ids??[]){if(current.has(id))continue;const snapshot=meta.reviews?.find(x=>x.evidence_id===id);if(snapshot){history.set(id,snapshot);continue}const old=history.get(id)??{evidence_id:id,attempts:0,retry_after:0,completed_at:0,status:'queued',last_task_id:''};if(['done','skipped'].includes(old.status))continue;const key=id+'\0'+meta.task_id;if(meta.outcome==='queued'&&!queued.has(key)){old.attempts++;queued.add(key)}old.status=meta.outcome;old.last_task_id=meta.task_id;old.retry_after=meta.outcome==='queued'?row.source_at+15*MINUTE:meta.outcome==='failed'?row.source_at+policy.review_retry_minutes*MINUTE:0;old.completed_at=['done','skipped'].includes(meta.outcome)?row.source_at:0;history.set(id,old)}
    }
    return new Map([...history,...current])
  }
  pendingSources(input={},trusted={}){
    fields(input,['limit','manual']);const c=contextOf(trusted),config=this._config(),state=this._state().value,now=this._now(),limit=Math.min(10,input.limit??config.policy.review_sources_per_batch);if(!Number.isSafeInteger(limit)||limit<0)throw new Error('学习整理数量无效')
    const day=shanghaiTime(now),batches=this.store.db.prepare("SELECT source_at,metadata_json FROM journal_events WHERE source_type='native_learning_loop' AND json_extract(metadata_json,'$.subtype')='review_batch' AND json_extract(metadata_json,'$.outcome')='queued' ORDER BY source_at DESC").all().map(r=>({at:r.source_at,...JSON.parse(r.metadata_json)})),used=new Set(batches.filter(r=>r.at>=day.midnight&&r.at<day.midnight+DAY).map(r=>r.task_id)).size,last=batches[0]?.at??0,next_at=Math.max(last+config.policy.review_interval_minutes*MINUTE,used>=config.policy.review_max_per_day?day.midnight+DAY:0),manual=input.manual===true&&ownerSurface(c),eligible=config.enabled&&used<config.policy.review_max_per_day&&(manual||now>=next_at)
    const candidates=[],seen=new Set(),ledger=this._reviewLedger(state,config.policy),sources=this._sourceRows().map(row=>{const m=JSON.parse(row.metadata_json);return m.evidence_ids??(m.evidence_id?[m.evidence_id]:[])})
    // These IDs come only from the canonical registered-read journal query.
    // Reuse its proof within this call, rather than rescan the entire journal
    // for every candidate. Evidence/privacy/review checks still run per row;
    // no registration snapshot survives into the next call or write action.
    const registered_ids=new Set();for(const ids of sources)for(const id of ids)registered_ids.add(id)
    for(const ids of sources){
      for(const id of ids){if(seen.has(id))continue;seen.add(id);const old=ledger.get(id);if(old&&(['done','skipped'].includes(old.status)||old.attempts>=config.policy.review_max_attempts||old.retry_after>now))continue;const proof=this._proof(id,c);if(!this._public(proof,registered_ids))continue;candidates.push({evidence_id:id,platform:proof.platform,ref:proof.ref,excerpt:text(truncate(bodyOf(proof.text),600),600)})}
    }
    return{items:eligible?candidates.slice(0,limit):[],pending_count:candidates.length,review:{eligible,next_at,used_today:used,max_per_day:config.policy.review_max_per_day},model_calls:0}
  }
  markReviewed(input,trusted={}){
    fields(input,['evidence_ids','outcome','task_id']);const c=contextOf(trusted);this._mutable(c);if(!c.owner_authorized&&!c.autonomous)throw new Error('整理状态只能由可信后台任务更新');keyText(input.task_id,240)
    if(!Array.isArray(input.evidence_ids)||!input.evidence_ids.length||input.evidence_ids.length>10||!['queued','done','skipped','failed'].includes(input.outcome))throw new Error('整理来源或状态无效')
    return this.store.transaction(()=>{const state=this._state(),at=this._now(),ids=[...new Set(input.evidence_ids.map(id=>keyText(id,160)))],key=JSON.stringify([input.task_id,input.outcome,ids.sort()]);if(this.store.db.prepare('SELECT id FROM journal_events WHERE event_key=?').get('learning-loop:review_batch:'+hash(key)))return{recorded:true,duplicate:true}
      for(const id of ids){if(!this._public(this._proof(id,c)))throw new Error('整理只能标记真实已登记的公开阅读来源');let row=state.value.reviews.find(x=>x.evidence_id===id);if(!row){row={evidence_id:id,attempts:0,retry_after:0,completed_at:0,status:'queued',last_task_id:''};state.value.reviews.push(row)}if(['done','skipped'].includes(row.status))continue;if(input.outcome==='queued'&&row.last_task_id!==input.task_id)row.attempts++;row.status=input.outcome;row.last_task_id=input.task_id;row.retry_after=input.outcome==='queued'?at+15*MINUTE:input.outcome==='failed'?at+this._config().policy.review_retry_minutes*MINUTE:0;row.completed_at=['done','skipped'].includes(input.outcome)?at:0}
      this._save(state);this._event(key,c,'review_batch',{task_id:input.task_id,outcome:input.outcome,evidence_ids:ids,manual:c.manual===true,reviews:state.value.reviews.filter(x=>ids.includes(x.evidence_id))});return{recorded:true,outcome:input.outcome}
    })
  }
}
