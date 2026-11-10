/** Evidence-backed expression preferences, separate from the owner's persona.
 * No model/network calls, profile writes, synthetic praise or visit-count
 * personality changes. Adoption records references to immutable learning use
 * and feedback events; rendering still obeys each original card's scope. */
import {createHash,randomUUID} from 'node:crypto'
import {NativeStore} from './store.mjs'
import {NativeProfileService} from './profile-service.mjs'
import {NativeLearningLoop} from './learning-loop.mjs'
import {isPlainObject} from './contracts.mjs'
import {maskSpeechText} from './speech-core.mjs'

export const EXPRESSION_EVOLUTION_DEFAULTS=Object.freeze({enabled:true,auto_adopt:false,policy:Object.freeze({max_rules:4,max_context_chars:360,max_versions:16})})
const CORE=['name','self_ref','owner_address','body_md'],PLATFORMS=new Set(['main','qq','tieba','bilibili']),HASH=/^[a-f0-9]{64}$/
const clone=value=>structuredClone(value),canonical=value=>Array.isArray(value)?value.map(canonical):isPlainObject(value)?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value
const hash=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(canonical(value))).digest('hex')
const fields=(value,allowed)=>{if(!isPlainObject(value)||Object.keys(value).some(key=>!allowed.includes(key)))throw new Error('语风参数包含未知字段')}
const revision=value=>{if(!Number.isSafeInteger(value)||value<0)throw new Error('语风修改需要expected_revision')}
const owner=c=>c?.owner_authorized===true&&c.visibility!=='public'&&!(c.platform==='qq'&&c.conversation_id?.startsWith('group:'))&&!(c.platform==='bilibili'&&/^(?:comment:|live:)/.test(c.conversation_id??''))
const readable=(card,c)=>card.visibility==='public'||owner(c)||card.visibility==='conversation'&&card.platform===c.platform&&card.conversation_id===c.conversation_id
const scopeHash=c=>hash((c.platform??'harness')+'\0'+(c.conversation_id??'')+'\0'+(['harness','system','web'].includes(c.platform??'harness')?c.session_id??'':c.conversation_id?'':c.session_id??''))
const safeReason=value=>{if(typeof value!=='string'||!value.trim()||value.length>240||!value.isWellFormed()||value.includes('\0'))throw new Error('请填写有效的语风变更原因');return value.trim()}
const textOf=content=>typeof content==='string'?content:Array.isArray(content)?content.filter(row=>row?.type==='text').map(row=>row.text??row.data?.text??'').join('\n'):''
const forbidden=/(?:名字|自称|主人|身份|人设|权限|账号).{0,12}(?:改成|改为|替换|覆盖|设置)|(?:改成|改为|替换|覆盖|伪装|扮演).{0,12}(?:主人|身份|人设|权限|账号)|owner_authorized|follow_main|main_profile_id|companion_action|系统提示词|(?:忽略|绕过|放开).{0,12}(?:规则|权限|限制|验证)|(?:运行|执行).{0,12}(?:命令|脚本)|(?:你是|我叫|你叫)[^，。！？\n]{1,24}/i
const GUIDE_SUFFIX='只借表达习惯，当前人设、情绪、事实和明确要求优先；不照抄例句，不强定温柔或生气，不改变身份或权限。'

export class NativeExpressionEvolution{
  constructor({store,profiles,loop,now=store?.now??Date.now,background_capability}={}){
    if(!(store instanceof NativeStore)||typeof now!=='function')throw new Error('语风服务需要NativeStore和可信时钟')
    this.store=store;this.profiles=profiles??new NativeProfileService({store});this.loop=loop??new NativeLearningLoop({store,now});this.now=now
    if(this.profiles.store!==store||this.loop.store!==store)throw new Error('语风、学习和人设必须使用同一原生库')
    if(background_capability!==undefined&&!['symbol','object'].includes(typeof background_capability)||background_capability===null)throw new Error('语风后台能力需要不可由JSON重建的宿主引用')
    this.backgroundCapability=background_capability;this.configId='expression-evolution'
  }
  _now(){const at=this.now();if(!Number.isSafeInteger(at)||at<0)throw new Error('语风时钟无效');return at}
  _config(){const doc=this.store.getDocument(this.configId);if(doc&&doc.type!=='expression_evolution')throw new Error('语风设置类型错误');const saved=doc?.value??EXPRESSION_EVOLUTION_DEFAULTS;return{document:doc,value:{...EXPRESSION_EVOLUTION_DEFAULTS,...saved,policy:{...EXPRESSION_EVOLUTION_DEFAULTS.policy,...saved.policy}},enabled:this.store.getDocument('settings')?.value.enabled!==false&&this.store.getDocument('learning')?.value.enabled!==false&&saved.enabled!==false}}
  _authority(c,{background=false}={}){
    if(this.store.readOnly)throw new Error('语风服务当前只读')
    if(owner(c))return
    if(background&&this.backgroundCapability!==undefined&&c?.capability===this.backgroundCapability)return
    throw new Error('语风管理需要主人设置或已注册的可信后台能力')
  }
  _resolve(platform='main'){
    if(!PLATFORMS.has(platform))throw new Error('请选择主对话、QQ、贴吧或B站语风')
    const resolved=this.profiles.resolve(platform),effective=this.store.getPersonaProfile(resolved.effective_profile_id)
    if(!effective||!PLATFORMS.has(effective.platform))throw new Error('当前有效人设来源不存在')
    return{requested_platform:platform,source_platform:effective.platform,profile_id:effective.id,core_hash:hash(Object.fromEntries(CORE.map(key=>[key,resolved[key]]))),document_id:'expression-voice:'+hash(effective.id)}
  }
  _state(info){
    const doc=this.store.getDocument(info.document_id);if(doc&&doc.type!=='expression_voice')throw new Error('语风状态类型错误')
    const at=this._now(),baseline={version:0,core_hash:info.core_hash,rules:[],at,reason:'初始语风参考'}
    return{document:doc,value:clone(doc?.value??{version:1,platform:info.source_platform,profile_id:info.profile_id,core_hash:info.core_hash,paused:false,pause_reason:'',current_version:0,rules:[],baseline,history:[baseline],updated_at:at})}
  }
  _cas(state,expected){revision(expected);if(expected!==(state.document?.revision??0))throw new Error('语风版本冲突，请读取最新状态')}
  _save(info,state){return this.store.putDocument({id:info.document_id,type:'expression_voice',expected_revision:state.document?.revision??0,value:state.value})}
  _event(info,subtype,state,metadata={}){return this.store.appendJournalEvent({event_key:'expression-evolution:'+randomUUID(),event_type:'learning',platform:info.source_platform==='main'?'harness':info.source_platform,direction:'internal',visibility:'owner',text:'',source_at:this._now(),source_type:'native_expression_evolution',metadata:{subtype,profile_id:info.profile_id,voice_version:state.value.current_version,core_hash:info.core_hash,persona_changed:false,identity_changed:false,mastery_claimed:false,...metadata}})}
  _version(state,reason){state.value.current_version++;state.value.updated_at=this._now();state.value.history.push({version:state.value.current_version,core_hash:state.value.core_hash,rules:clone(state.value.rules),at:state.value.updated_at,reason});state.value.history=state.value.history.slice(-this._config().value.policy.max_versions)}
  _guide(card){const content=card.content;return'【当前语风参考】'+content.meaning+'\n适用：'+content.applies_to.join('；')+'\n避用：'+content.avoid_in.join('；')+'\n'+GUIDE_SUFFIX}
  _card(id){const card=this.store.getDocument(id);return card?.type==='learning_item'?card:null}
  _scopeAllowed(card,info){return card.platform===info.requested_platform||card.platform===info.source_platform||info.source_platform==='main'&&['harness','system'].includes(card.platform)}
  _actualUse(metadata){
    const use=metadata?.usage;if(!use||use.id!==metadata.usage_id||use.card_id!==metadata.card_id||use.card_revision!==metadata.card_revision||use.context_hash!==metadata.context_hash||!HASH.test(use.output_hash??'')||!Number.isSafeInteger(use.at)||use.at>this._now()+60000)return null
    if(use.source_ref?.startsWith('session:'))return ['harness','system','web'].includes(use.platform)?use:null
    const action=this.store.db.prepare('SELECT *,CAST(body AS BLOB) AS body_bytes FROM actions WHERE id=?').get(use.source_ref)
    if(!action||action.status!=='confirmed'||action.platform!==use.platform||!['qq','tieba','bilibili'].includes(action.platform))return null
    let receipt,target,body=Buffer.from(action.body_bytes).toString('utf8');try{receipt=JSON.parse(action.receipt_json);target=JSON.parse(action.target_json)}catch{return null}
    if(receipt.source!=='server_receipt'||receipt.accepted!==true||receipt.rejected||receipt.code!==undefined&&receipt.code!==0||typeof receipt.server_id!=='string'||!receipt.server_id.trim()||['0','-1','null','undefined'].includes(receipt.server_id.toLowerCase()))return null
    let conversation_id
    if(action.platform==='qq'){
      if(action.kind!=='qq.send'||target.origin!=='reply'||!target.conversation_id)return null
      conversation_id=target.conversation_id
      try{body=textOf(JSON.parse(body))}catch{return null}
      const turn=this.store.db.prepare("SELECT metadata_json FROM actions WHERE platform='qq' AND kind='qq.turn' AND status='completed' AND EXISTS(SELECT 1 FROM json_each(actions.metadata_json,'$.delivery_action_ids') WHERE value=?) ORDER BY created_at DESC LIMIT 1").get(action.id)
      let meta;try{meta=JSON.parse(turn?.metadata_json??'null')}catch{return null}
      if(meta?.model_outcome!=='completed'||meta.response_kind!=='answer'||meta.delivery_status!=='delivered')return null
    }else if(action.platform==='tieba'){
      if(action.kind!=='tieba.reply'||!target.thread_id)return null
      conversation_id='thread:'+target.thread_id+':'+(target.post_id??receipt.server_id)
    }else{
      if(!['bilibili.comment','bilibili.reply'].includes(action.kind)||['dm','live'].includes(target.channel)||!target.object_id)return null
      conversation_id='comment:'+(target.object_type??'1')+':'+target.object_id+':'+(target.root_reply_id&&target.root_reply_id!=='0'?target.root_reply_id:receipt.server_id)
    }
    return hash(body)===use.output_hash&&scopeHash({platform:use.platform,conversation_id})===use.context_hash?{...use,conversation_id}:null
  }
  _maturity(card){
    const value=card.value,content=hash(value.content),versions=this.loop._sameContentVersions(card),uses=[],feedback=[]
    for(const row of this.store.db.prepare("SELECT id,metadata_json FROM journal_events WHERE source_type='native_learning_loop' AND json_extract(metadata_json,'$.subtype')='used' AND json_extract(metadata_json,'$.card_id')=? ORDER BY rowid").all(card.id)){
      let meta;try{meta=JSON.parse(row.metadata_json)}catch{continue}
      if(!versions.has(meta.card_revision))continue
      const use=this._actualUse(meta);if(!use||value.visibility==='conversation'&&(use.platform!==value.platform||use.context_hash!==scopeHash({platform:value.platform,conversation_id:value.conversation_id})))continue
      if(!uses.some(item=>item.use.id===use.id))uses.push({event_id:row.id,use})
    }
    const byUsage=new Map(uses.map(row=>[row.use.id,row.use])),feedbackProofs=new Set()
    for(const row of this.store.db.prepare("SELECT id,metadata_json FROM journal_events WHERE source_type='native_learning_loop' AND json_extract(metadata_json,'$.subtype')='feedback' AND json_extract(metadata_json,'$.card_id')=? AND json_extract(metadata_json,'$.polarity')='positive' ORDER BY rowid").all(card.id)){
      let meta;try{meta=JSON.parse(row.metadata_json)}catch{continue}
      const use=byUsage.get(meta.usage_id);if(!use||!versions.has(meta.card_revision)||meta.context_hash!==use.context_hash||!Array.isArray(meta.evidence_ids)||!meta.evidence_ids.length)continue
      if(meta.evidence_ids.some(id=>feedbackProofs.has(id)))continue
      const proofs=meta.evidence_ids.map(id=>this.store.db.prepare('SELECT * FROM evidence WHERE id=?').get(id))
      if(proofs.some(proof=>{if(!proof||proof.source_type!=='user'||proof.direction!=='in'||proof.platform!==use.platform||use.conversation_id!==undefined&&proof.conversation_id!==use.conversation_id||['rejected','unknown'].includes(proof.status)||!Number.isSafeInteger(proof.source_at)||proof.source_at<use.at||proof.source_at>this._now()+60000||use.actor_uid&&proof.actor_uid!==use.actor_uid)return true;let source;try{source=JSON.parse(proof.source_json)}catch{return true}return!['user','human','user_statement'].includes(source.kind)||!this.loop._feedbackTone(proof,'positive',value.content.label)}))continue
      for(const id of meta.evidence_ids)feedbackProofs.add(id)
      feedback.push({event_id:row.id,evidence_ids:[...meta.evidence_ids]})
    }
    const policy=this.store.getDocument('learning-loop')?.value.policy??{},distinct=new Set(uses.map(row=>row.use.output_hash)).size,minUses=Math.max(2,policy.trial_uses_required??2),minPositive=Math.max(1,policy.positive_feedback_required??1)
    return{content_hash:content,verified_uses:uses.length,distinct_outputs:distinct,human_positive_feedback:feedback.length,mature:uses.length>=minUses&&distinct>=2&&feedback.length>=minPositive,use_event_ids:uses.slice(-32).map(row=>row.event_id),feedback_event_ids:feedback.slice(-16).map(row=>row.event_id)}
  }
  _candidate(card,info,state){
    const value=card.value,maturity=this._maturity(card),context_chars=this._guide(value).length
    const reason=!['habit','phrase'].includes(value.kind)?'not_expression_rule':!this._scopeAllowed(value,info)?'other_platform':value.status!=='active'?'not_active':forbidden.test([value.content.label,value.content.meaning,value.content.example_good,...value.content.applies_to,...value.content.avoid_in].join(' '))?'core_or_permission_instruction':!maturity.mature?'insufficient_verified_application':context_chars>this._config().value.policy.max_context_chars?'context_too_long':null
    const adopted=state.value.rules.some(rule=>rule.card_id===card.id&&rule.card_revision===value.revision&&rule.content_hash===maturity.content_hash)
    return{card_id:card.id,card_revision:value.revision,label:value.content.label,meaning:value.content.meaning,visibility:value.visibility,platform:value.platform,conversation_id:value.conversation_id,context_chars,...maturity,ready:!reason,reason,already_adopted:adopted}
  }
  _ruleCurrent(rule,c,info){
    const card=this._card(rule.card_id);if(!card||card.value.status!=='active'||card.value.revision!==rule.card_revision||hash(card.value.content)!==rule.content_hash||card.value.visibility!==rule.visibility||card.value.platform!==rule.platform||card.value.conversation_id!==rule.conversation_id||!readable(card.value,c)||!this._scopeAllowed(card.value,info))return null
    if(this.loop._state().value.blocks.some(row=>row.card_id===card.id&&row.context_hash===scopeHash(c)))return null
    return card
  }
  _drift(state,from){
    const baseline=from===undefined?state.value.baseline:state.value.history.find(row=>row.version===from)
    if(!baseline)throw new Error('没有这个语风比较版本')
    const previous=new Map(baseline.rules.map(rule=>[rule.card_id,rule])),current=new Map(state.value.rules.map(rule=>[rule.card_id,rule]))
    return{kind:'expression_set_change',from_version:baseline.version,to_version:state.value.current_version,added:[...current.keys()].filter(id=>!previous.has(id)),removed:[...previous.keys()].filter(id=>!current.has(id)),updated:[...current].filter(([id,rule])=>previous.has(id)&&(previous.get(id).content_hash!==rule.content_hash||previous.get(id).card_revision!==rule.card_revision)).map(([id])=>id),note:'这里只比较采用的表达偏好集合，不衡量人格变化、智能程度或学习质量。'}
  }
  status(input={},trusted={}){
    fields(input,['platform','from_version']);if(!owner(trusted)&&!(this.backgroundCapability!==undefined&&trusted.capability===this.backgroundCapability))throw new Error('语风详情只向主人或可信后台提供')
    const info=this._resolve(input.platform),state=this._state(info),config=this._config(),c={...trusted,platform:trusted.platform??(info.requested_platform==='main'?'harness':info.requested_platform)}
    return{...info,enabled:config.enabled,auto_adopt:config.value.auto_adopt,revision:state.document?.revision??0,current_version:state.value.current_version,paused:state.value.paused,pause_reason:state.value.pause_reason,core_unchanged:state.value.core_hash===info.core_hash,rules:state.value.rules.map(rule=>({card_id:rule.card_id,card_revision:rule.card_revision,label:this._card(rule.card_id)?.value.content.label??'',current:!!this._ruleCurrent(rule,c,info)})),history:state.value.history.map(row=>({version:row.version,at:row.at,reason:row.reason,rule_ids:row.rules.map(rule=>rule.card_id)})),drift:this._drift(state,input.from_version),persona_changed:false,model_calls:0}
  }
  candidates(input={},trusted={}){
    fields(input,['platform']);if(!owner(trusted)&&!(this.backgroundCapability!==undefined&&trusted.capability===this.backgroundCapability))throw new Error('语风候选只向主人或可信后台提供')
    const info=this._resolve(input.platform),state=this._state(info),items=this.store.listDocuments({type:'learning_item',limit:1000}).filter(row=>['habit','phrase'].includes(row.value.kind)&&this._scopeAllowed(row.value,info)).map(row=>this._candidate(row,info,state))
    return{...info,revision:state.document?.revision??0,items,model_calls:0}
  }
  _adopt(info,state,card_id,reason){
    const card=this._card(card_id);if(!card)throw new Error('没有这张学习卡')
    const candidate=this._candidate(card,info,state);if(!candidate.ready)throw new Error('语风候选尚不能采用：'+candidate.reason)
    if(state.value.core_hash!==info.core_hash)throw new Error('主人已修改核心人设，请先重置语风基线后重新核验')
    if(candidate.already_adopted)return{changed:false,status:'already_adopted',card_id}
    const previous=state.value.rules.find(rule=>rule.card_id===card_id)
    if(!previous&&state.value.rules.length>=this._config().value.policy.max_rules)throw new Error('当前语风规则已达上限，请先选择移除旧规则')
    const rule={card_id,card_revision:card.value.revision,content_hash:candidate.content_hash,visibility:card.value.visibility,platform:card.value.platform,conversation_id:card.value.conversation_id,adopted_at:this._now(),use_event_ids:candidate.use_event_ids,feedback_event_ids:candidate.feedback_event_ids}
    state.value.rules=[...state.value.rules.filter(row=>row.card_id!==card_id),rule];this._version(state,reason)
    const saved=this._save(info,state);this._event(info,'voice_adopted',state,{card_id,card_revision:rule.card_revision,source_evidence_ids:card.value.evidence_ids,use_event_ids:rule.use_event_ids,feedback_event_ids:rule.feedback_event_ids,reason})
    return{changed:true,status:'adopted',card_id,revision:saved.revision,current_version:state.value.current_version,persona_changed:false,model_calls:0}
  }
  adopt(input,trusted={}){
    fields(input,['platform','card_id','expected_revision','reason']);this._authority(trusted);if(!this._config().enabled)throw new Error('语风学习当前关闭')
    return this.store.transaction(()=>{const info=this._resolve(input.platform),state=this._state(info);this._cas(state,input.expected_revision);return this._adopt(info,state,input.card_id,safeReason(input.reason??'主人采用已验证的表达习惯'))})
  }
  scan(input,trusted={}){
    fields(input,['platform','expected_revision']);this._authority(trusted,{background:true})
    const config=this._config();if(!config.enabled||!config.value.auto_adopt)return{changed:false,status:'auto_disabled',model_calls:0}
    return this.store.transaction(()=>{const info=this._resolve(input.platform),state=this._state(info);this._cas(state,input.expected_revision)
      if(state.value.paused)return{changed:false,status:'paused',model_calls:0}
      if(state.value.core_hash!==info.core_hash)return{changed:false,status:'core_changed',model_calls:0}
      const candidates=this.store.listDocuments({type:'learning_item',limit:1000}).filter(row=>row.value.status==='active'&&['habit','phrase'].includes(row.value.kind)&&this._scopeAllowed(row.value,info)).map(row=>this._candidate(row,info,state)).filter(row=>row.ready&&!row.already_adopted).sort((a,b)=>b.human_positive_feedback-a.human_positive_feedback||b.distinct_outputs-a.distinct_outputs||a.card_id.localeCompare(b.card_id))
      if(!candidates.length)return{changed:false,status:'no_mature_candidates',model_calls:0}
      if(state.value.rules.length>=config.value.policy.max_rules&&!state.value.rules.some(rule=>rule.card_id===candidates[0].card_id))return{changed:false,status:'capacity',model_calls:0}
      return this._adopt(info,state,candidates[0].card_id,'依据实际应用与真人反馈采用表达习惯')})
  }
  manage(input,trusted={}){
    fields(input,['platform','operation','expected_revision','version','card_id','reason']);this._authority(trusted)
    if(!['pause','resume','rollback','remove','reset'].includes(input.operation))throw new Error('请选择暂停、恢复、回滚、移除或重置语风')
    return this.store.transaction(()=>{const info=this._resolve(input.platform),state=this._state(info);this._cas(state,input.expected_revision);const reason=safeReason(input.reason??{pause:'主人暂停语风学习',resume:'主人恢复语风学习',rollback:'主人回滚语风',remove:'主人移除表达规则',reset:'主人重新确认当前人设的语风基线'}[input.operation])
      if(input.operation==='pause'||input.operation==='resume'){state.value.paused=input.operation==='pause';state.value.pause_reason=state.value.paused?reason:'';state.value.updated_at=this._now()}
      else if(input.operation==='reset'){state.value.core_hash=info.core_hash;state.value.rules=[];this._version(state,reason);state.value.baseline=clone(state.value.history.at(-1))}
      else{
        if(state.value.core_hash!==info.core_hash)throw new Error('核心人设已变，请先重置语风基线')
        if(input.operation==='remove'){if(!state.value.rules.some(rule=>rule.card_id===input.card_id))throw new Error('当前语风没有这条规则');state.value.rules=state.value.rules.filter(rule=>rule.card_id!==input.card_id)}
        else{if(!Number.isSafeInteger(input.version)||input.version<0)throw new Error('回滚需要语风版本号');const snapshot=state.value.history.find(row=>row.version===input.version);if(!snapshot)throw new Error('没有这个语风历史版本');if(snapshot.core_hash!==info.core_hash)throw new Error('旧语风属于另一份核心人设，不能连同核心一起恢复');for(const rule of snapshot.rules){const card=this._card(rule.card_id);if(!card||card.value.status!=='active'||card.value.revision!==rule.card_revision||hash(card.value.content)!==rule.content_hash)throw new Error('旧语风含已暂停或修订的学习项，请先复核');}state.value.rules=clone(snapshot.rules)}
        this._version(state,reason)
      }
      const saved=this._save(info,state);this._event(info,'voice_'+input.operation,state,{reason,...(input.version===undefined?{}:{restored_from:input.version}),...(input.card_id?{card_id:input.card_id}:{})});return{changed:true,status:input.operation,revision:saved.revision,current_version:state.value.current_version,persona_changed:false,model_calls:0}})
  }
  context(input={},trusted={}){
    fields(input,['platform','query','scene','max_chars']);const config=this._config();if(!config.enabled||trusted.memory_only)return ''
    const query=typeof input.query==='string'?maskSpeechText(input.query).text.replace(/\0/g,' '):'',scene=typeof input.scene==='string'?input.scene:'',max=input.max_chars??config.value.policy.max_context_chars
    if(!Number.isSafeInteger(max)||max<0||max>1000)throw new Error('语风上下文字数上限无效');if(!max||!query.trim())return ''
    const info=this._resolve(input.platform),state=this._state(info);if(state.value.paused||state.value.core_hash!==info.core_hash)return ''
    const c={...trusted,platform:trusted.platform??(info.requested_platform==='main'?'harness':info.requested_platform)},ranked=[]
    for(const rule of state.value.rules){const card=this._ruleCurrent(rule,c,info);if(!card)continue;const score=this.loop._match(card.value,query,scene,c.serious===true);if(score>0)ranked.push({card,score})}
    ranked.sort((a,b)=>b.score-a.score||a.card.id.localeCompare(b.card.id))
    for(const row of ranked){const line=this._guide(row.card.value);if(line.length<=Math.min(max,config.value.policy.max_context_chars))return line}
    return ''
  }
}
