import {createHash,randomUUID} from 'node:crypto'
import {maskSpeechText} from './speech-core.mjs'

const hash=value=>createHash('sha256').update(value).digest('hex')
const norm=value=>String(value??'').normalize('NFKC').toLowerCase().trim()
const STOP=new Set('一个 这个 这些 那个 那些 什么 怎么 为什么 不是 就是 还是 然后 因为 所以 但是 可以 没有 现在 今天 明天 昨天 你们 我们 他们 自己 知道 觉得 感觉 有点 一下 真的 哈哈 确实 回复 评论 话题 内容 视频 帖子 来源 学习 别人 人类 我的 你的 他的 我是 一句 一条 一次 一天 一点 一些 一样 喜欢 不会 这种 也是 都是 主人 大肥 邪恶 时间 工作 开始 一直 为了 出来 不懂 经验 不如 不能 可能 问题 不过 不知道 朋友 直接 当时 个人 只是 支持 以后 之后 加油 to in of up the and for with from that this'.split(' '))
const wordTokens=value=>[...new Set([...new Intl.Segmenter('zh',{granularity:'word'}).segment(norm(value))].filter(row=>row.isWordLike&&row.segment.length>=2&&row.segment.length<=32&&!STOP.has(row.segment)&&!/^\d+$/.test(row.segment)).map(row=>hash(row.segment)))].slice(0,16)
const contains=(text,term)=>/^[a-z0-9 _-]+$/.test(term)?text.split(/[^a-z0-9_-]+/).includes(term):text.includes(term)

/** Local candidate selection and durable rolling topic slots. No LLM calls.
 * Tokens/identities are hashed. Public learning can suggest interests, never
 * private-chat material. The existing reply model decides whether to speak. */
export class NativeQQParticipation {
  constructor(qq){this.qq=qq;this.store=qq.store;this.now=()=>qq._now();this.id='qq-participation-state'}
  settings(){const cfg=this.qq.settings().qq??{},p=cfg.participation??{};return {mode:p.mode??(cfg.access?.require_mention!==false?'mentions':'all'),window_ms:p.window_ms??600000,max_topics:p.max_topics??3,mention_exempt:p.mention_exempt!==false,address_names:p.address_names??[],interest_terms:p.interest_terms??[],learned_interests:p.learned_interests!==false}}
  _state(){const doc=this.store.getDocument(this.id);return {doc,value:doc?.value??{version:1,topics:[]}}}
  _save(state){this.store.putDocument({id:this.id,type:'qq_participation_state',expected_revision:state.doc?.revision??0,value:state.value})}
  _live(state,cfg){const cutoff=this.now()-cfg.window_ms;return state.value.topics.filter(row=>row.at>cutoff)}
  _interests(cfg){
    const labels=cfg.interest_terms.map(norm).filter(value=>value.length>=2&&!STOP.has(value))
    if(cfg.learned_interests&&this.store.getDocument('learning')?.value.enabled!==false&&this.store.getDocument('settings')?.value.enabled!==false){
      const topics=this.store.getDocument('learning-state')?.value.topics??[]
      for(const row of topics.filter(row=>row.score>=3&&row.reads>=2&&row.negative<=row.positive).sort((a,b)=>b.score-a.score).slice(0,100)){
        const label=norm(row.label);if(label.length<2||STOP.has(label)||label.length>32||!/[\p{L}]/u.test(label))continue
        // Require public original evidence; shared-interest scores alone do
        // not authorize revealing a private interest to another conversation.
        if(row.evidence_ids?.length&&row.evidence_ids.every(id=>{const proof=this.store.db.prepare('SELECT platform,visibility FROM evidence WHERE id=?').get(id);return proof?.visibility==='public'&&(this.store.getDocument('learning')?.value.shared_interests!==false||proof.platform==='qq')}))labels.push(label)
      }
    }
    return [...new Set(labels)].slice(0,128)
  }
  named(text){
    const own=this.store.listPersonaProfiles().find(row=>row.platform==='qq'),effective=own?.follow_main?this.store.getPersonaProfile(own.main_profile_id):own
    const names=[...this.settings().address_names,effective?.name,this.qq.self_uid&&this.store.getPlatformIdentity('qq',this.qq.self_uid)?.display_name].map(norm).filter(value=>value.length>=2)
    const plain=norm(maskSpeechText(text).text)
    return names.some(name=>contains(plain,name))
  }
  admit({conversation_id,inbound_id,source_message_id,text,reply_id='',explicit=false}){
    const cfg=this.settings()
    if(!conversation_id.startsWith('group:')||cfg.mode==='all'&&!this.qq.settings().qq?.participation)return {accepted:true,reason:'unfiltered'}
    if(cfg.mode==='mentions'&&!explicit)return {accepted:false,reason:'mention_required'}
    const plain=norm(maskSpeechText(text).text),interests=explicit?[]:this._interests(cfg).filter(label=>contains(plain,label)).map(hash),tokens=wordTokens(plain)
    return this.store.transaction(()=>{
      const state=this._state(),scope=hash(conversation_id),key=hash(inbound_id),message_key=hash(conversation_id+'\0'+source_message_id)
      state.value.topics=this._live(state,cfg)
      const local=state.value.topics.filter(row=>row.scope===scope),reply_key=reply_id?hash(conversation_id+'\0'+reply_id):''
      // A real quote chain has priority. Otherwise merge only overlapping
      // content words in the recent window; an interest label alone is not a
      // topic identity (two unrelated game questions still use two slots).
      let topic=reply_key?local.find(row=>row.message_keys.includes(reply_key)):null
      if(!topic&&tokens.length)topic=[...local].sort((a,b)=>b.at-a.at).find(row=>{
        const overlap=tokens.filter(token=>row.tokens.includes(token)).length
        return overlap>=2&&overlap/Math.min(tokens.length,row.tokens.length)>=0.5||tokens.length===row.tokens.length&&overlap===tokens.length
      })
      if(cfg.mode==='interest_or_mention'&&!explicit&&!interests.length&&!(topic?.interested&&reply_key))return {accepted:false,reason:'not_interested'}
      const counted=!(explicit&&cfg.mention_exempt),used=local.filter(row=>row.used_at>0&&row.used_at>this.now()-cfg.window_ms||row.pending.length).length
      if(counted&&cfg.max_topics>0&&!topic?.pending.length&&!(topic?.used_at>0&&topic.used_at>this.now()-cfg.window_ms)&&used>=cfg.max_topics)return {accepted:false,reason:'topic_limit'}
      // Never evict a live slot merely to make room; this would reset limits.
      if(!topic&&state.value.topics.length>=256)return explicit&&cfg.mention_exempt?{accepted:true,reason:'directed',explicit:true,counted:false}:{accepted:false,reason:'topic_capacity'}
      if(counted&&topic?.pending.length>=64&&!topic.pending.includes(key))return {accepted:false,reason:'topic_capacity'}
      if(!topic){topic={id:hash(randomUUID()),scope,tokens,interested:interests.length>0,message_keys:[],at:this.now(),used_at:0,pending:[]};state.value.topics.push(topic)}
      topic.at=this.now();topic.interested||=interests.length>0
      topic.message_keys=[...new Set([...topic.message_keys,message_key])].slice(-24)
      if(counted)topic.pending=[...new Set([...topic.pending,key])]
      this._save(state)
      return {accepted:true,reason:explicit?'directed':'interest_candidate',topic_id:topic.id,counted,explicit,inbound_key:key}
    })
  }
  finish(inbound_id,status,{message_id}={}){
    const job=this.qq._job(inbound_id),participation=job?.metadata.participation
    if(!participation?.topic_id)return
    this.store.transaction(()=>{
      const state=this._state(),topic=state.value.topics.find(row=>row.id===participation.topic_id);if(!topic)return
      if(status==='confirmed'){
        if(participation.counted)topic.used_at=this.now()
        topic.at=this.now()
        if(message_id)topic.message_keys=[...new Set([...topic.message_keys,hash(job.target.conversation_id+'\0'+message_id)])].slice(-24)
      }
      if(status!=='unknown')topic.pending=topic.pending.filter(key=>key!==hash(inbound_id))
      this._save(state)
    })
  }
  cancel(participation,inbound_id){
    if(!participation?.topic_id)return
    this.store.transaction(()=>{const state=this._state(),topic=state.value.topics.find(row=>row.id===participation.topic_id);if(!topic)return;topic.pending=topic.pending.filter(key=>key!==hash(inbound_id));this._save(state)})
  }
  outgoing(input){
    // Autonomous group chat uses the same slots as interest replies. Explicit
    // desktop commands, DMs and authorized cross-platform shares keep their
    // existing independent authority/path.
    if(!input.conversation_id.startsWith('group:')||!this.qq.isAutonomousSession(input.session_id)||!this.qq.settings().qq?.participation)return ''
    const id='qq-participation:'+hash(input.session_id+'\0'+(input.idempotency_key??randomUUID())),old=this.qq._job(id)
    if(old)return id
    const result=this.admit({conversation_id:input.conversation_id,inbound_id:id,source_message_id:id,text:input.segments.filter(row=>row.type==='text').map(row=>row.text).join(' ')})
    if(!result.accepted)throw new Error(result.reason==='topic_limit'?'QQ群参与话题达到本时段上限':'QQ群自主发言未命中兴趣候选，保持安静')
    this.qq._newJob({id,kind:'qq.participation',target:{conversation_id:input.conversation_id,session_id:input.session_id},body:'',metadata:{participation:result}})
    return id
  }
  hint(participation){return participation?.reason==='interest_candidate'?'【QQ群参与】这条只是兴趣候选，并未明确找你。由你判断是否真想接这个具体话题；没兴趣、只是别人互聊或没内容可补充，就只输出[[COMPANION_SKIP]]，不发送提示或调用发消息工具。接话时不要抢别人的经历。\n':''}
}
