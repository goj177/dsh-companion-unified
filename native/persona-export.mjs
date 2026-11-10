import {createHash} from 'node:crypto'
import {NativeStore} from './store.mjs'
import {NativeProfileService} from './profile-service.mjs'
import {isPlainObject} from './contracts.mjs'
import {redactText} from './memory-rules.mjs'
import {canonicalBar} from './tieba-atmosphere.mjs'

const FORMAT='dsh-companion-expression',VERSION=1,DAY=86400000
const PLATFORMS=['main','qq','tieba','bilibili'],KINDS=['persona','voice','bar_style']
const TRAITS=['abstract','sharp','gentle','talkative','image_bias'],LISTS=['samples','quirks','particles','patterns']
const hash=value=>createHash('sha256').update(value).digest('hex')
const fields=(value,allowed)=>{if(!isPlainObject(value)||Object.keys(value).some(key=>!allowed.includes(key)))throw new Error('表达导出参数包含未知字段')}
const wellFormed=value=>typeof value==='string'&&value.isWellFormed()&&!value.includes('\0')
const validTime=value=>Number.isSafeInteger(value)&&value>=0
const clipped=(value,max)=>{let end=Math.min(max,value.length);if(end>0&&end<value.length&&/[\uD800-\uDBFF]/.test(value[end-1])&&/[\uDC00-\uDFFF]/.test(value[end]))end--;return value.slice(0,end)}
function cleanText(value,path,filtered){
  if(!wellFormed(value))throw new Error('表达导出文本无效')
  const clean=redactText(value).replace(/https?:\/\/[^\s<>"'“”]+/giu,'[链接已省略]')
    .replace(/(?:~\/|\/(?:Users|home|root|private|var|tmp|etc|mnt)\/)[^\s<>"'“”]+|[a-z]:[\\/][^\r\n<>"'“”]+/giu,'[路径已省略]')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?\b/g,'[地址已省略]')
    .replace(/\d{5,}/g,'[数字标识已省略]')
  if(clean!==value)filtered.add(path)
  return clean
}
function voiceOf(profile,filtered){
  const traits={},voice={}
  for(const key of TRAITS)if(profile.traits?.[key]!==undefined){const value=profile.traits[key];if(typeof value!=='number'||!Number.isFinite(value)||value<0||value>10)throw new Error('导出性格参数无效');traits[key]=value}
  for(const key of LISTS)if(profile.voice?.[key]!==undefined){if(!Array.isArray(profile.voice[key])||profile.voice[key].length>100)throw new Error('导出语气列表无效');voice[key]=profile.voice[key].map((value,index)=>cleanText(value,'voice.'+key+'.'+index,filtered)).filter(Boolean)}
  for(const [key,allowed]of [['sentence_len',['short','medium','long']],['punctuation',['light','normal']]])if(profile.voice?.[key]!==undefined){if(!allowed.includes(profile.voice[key]))throw new Error('导出语气选项无效');voice[key]=profile.voice[key]}
  return {traits,voice}
}

/** Pure renderer: allowlisted profile/voice fields only. No file, model,
 * network, memory, diary, account or private-reference lookup. */
export function renderNativePersonaExport(input){
  fields(input,['kind','platform','profile','samples','bar','source','at','format','filtered_fields'])
  const {kind,platform,profile,source={},at,format='json'}=input
  if(!KINDS.includes(kind)||!PLATFORMS.includes(platform)||!validTime(at)||!['json','text'].includes(format))throw new Error('请选择有效的表达导出类型、平台和格式')
  fields(source,['platform','historical','version','revision'])
  if(!PLATFORMS.includes(source.platform??platform)||typeof (source.historical??false)!=='boolean'||source.version!==undefined&&(!Number.isSafeInteger(source.version)||source.version<1)||source.revision!==undefined&&(!Number.isSafeInteger(source.revision)||source.revision<1))throw new Error('表达导出版本无效')
  if(input.filtered_fields!==undefined&&(!Array.isArray(input.filtered_fields)||input.filtered_fields.some(value=>typeof value!=='string'||value.length>120)))throw new Error('表达导出过滤记录无效')
  const filtered=new Set(input.filtered_fields??[]);let data
  if(kind==='bar_style'){
    if(platform!=='tieba'||!Array.isArray(input.samples)||input.samples.length>60)throw new Error('吧内语风导出只接受当前贴吧公开样本')
    const bar=canonicalBar(input.bar)
    data={bar,samples:input.samples.map((row,index)=>{
      fields(row,['text','scene','source'])
      const origin=row.source;fields(origin,['thread_id','post_id','author_uid','observed_at'])
      for(const key of ['thread_id','post_id','author_uid'])if(typeof origin[key]!=='string'||!/^\d+$/.test(origin[key]))throw new Error('公开语风出处坐标无效')
      if(!validTime(origin.observed_at)||!['help','discussion','banter','other'].includes(row.scene))throw new Error('公开语风出处或场景无效')
      return {text:cleanText(row.text,'samples.'+index+'.text',filtered),scene:row.scene,source:{url:'https://tieba.baidu.com/p/'+origin.thread_id+'?pid='+origin.post_id,author_uid:origin.author_uid,observed_at:origin.observed_at}}
    })}
  }else{
    if(!isPlainObject(profile))throw new Error('请提供已选定的人设或历史版本')
    data=voiceOf(profile,filtered)
    if(kind==='persona')data={name:cleanText(profile.name,'name',filtered),self_ref:cleanText(profile.self_ref,'self_ref',filtered),owner_address:cleanText(profile.owner_address,'owner_address',filtered),body_md:cleanText(profile.body_md,'body_md',filtered),...data}
  }
  const payload={format:FORMAT,schema_version:VERSION,kind,requested_platform:platform,source:{platform:source.platform??platform,historical:source.historical??false,...(source.version!==undefined?{version:source.version}:{}),...(source.revision!==undefined?{revision:source.revision}:{})},exported_at:at,data}
  let text
  if(format==='json')text=JSON.stringify(payload,null,2)+'\n'
  else{
    const lines=['# '+({persona:'人设',voice:'语气',bar_style:'吧内语风'})[kind]+' · '+platform]
    if(source.historical)lines.push('历史版本：'+source.version)
    if(kind==='bar_style'){lines.push('吧名：'+data.bar);for(const row of data.samples)lines.push('',row.text,'来源：'+row.source.url+'；公开作者UID '+row.source.author_uid+'；场景 '+row.scene)}
    else{
      if(kind==='persona')lines.push('名字：'+data.name,'自称：'+data.self_ref,'主人称呼：'+data.owner_address,'',data.body_md)
      if(Object.keys(data.traits).length)lines.push('','性格参数：'+JSON.stringify(data.traits))
      for(const [key,label]of [['samples','参考句'],['quirks','习惯'],['particles','语气词'],['patterns','说话方式']])if(data.voice[key]?.length)lines.push('',label+'：',...data.voice[key].map(value=>'- '+value))
      if(data.voice.sentence_len)lines.push('句长：'+data.voice.sentence_len)
      if(data.voice.punctuation)lines.push('标点：'+data.voice.punctuation)
    }
    text=lines.join('\n')+'\n'
  }
  return {kind,format,filename:'dsh-'+kind.replace('_','-')+'-'+platform+(format==='json'?'.json':'.md'),mime_type:format==='json'?'application/json; charset=utf-8':'text/markdown; charset=utf-8',text,filtered:filtered.size>0,filtered_fields:[...filtered].sort()}
}

/** Read-only owner export. It never joins memory, chats, journals, identities,
 * credentials or persona_references into the profile being exported. Public
 * bar samples require original public-read proof and original author binding. */
export class NativePersonaExport{
  constructor({store,profiles,now=store?.now??Date.now}={}){
    if(!(store instanceof NativeStore)||typeof now!=='function')throw new Error('表达导出需要原生资料库与时钟')
    this.store=store;this.profiles=profiles??new NativeProfileService({store});this.now=now
    if(this.profiles.store!==store)throw new Error('表达导出的人设服务必须使用同一资料库')
  }
  export(input={},trusted={}){
    if(trusted.owner_authorized!==true)throw new Error('表达导出需要主人授权的设置会话')
    fields(input,['kind','platform','version_id','bar','format'])
    const kind=input.kind??'persona',platform=input.platform??'tieba',at=this.now()
    if(!KINDS.includes(kind)||!PLATFORMS.includes(platform)||!validTime(at))throw new Error('表达导出类型、平台或时钟无效')
    return this.store.transaction(()=>{
      if(kind==='bar_style'){
        if(input.version_id!==undefined||platform!=='tieba')throw new Error('吧内语风不接受人设历史版本或其他平台')
        const bar=canonicalBar(input.bar),doc=this.store.getDocument('tieba-atmosphere:'+hash(bar)),samples=[],filtered=[]
        for(const [index,row]of (doc?.type==='tieba_atmosphere'&&doc.value.bar===bar&&doc.value.historical!==true?doc.value.samples:[]).entries()){
          const omit=()=>filtered.push('samples.'+index)
          if(row.observed_at<at-30*DAY||row.observed_at>at){omit();continue}
          const proof=this.store.db.prepare('SELECT platform,visibility,direction,source_type,status,confirmation,source_at,recorded_at,source_json,CAST(text AS BLOB) AS text_bytes FROM evidence WHERE id=?').get(row.evidence_id)
          if(!proof||proof.platform!=='tieba'||proof.visibility!=='public'||proof.direction!=='observation'||proof.source_type!=='platform'||proof.status!=='confirmed'||proof.confirmation!=='source_observation'){omit();continue}
          let packet,origin;try{packet=JSON.parse(Buffer.from(proof.text_bytes).toString('utf8'));origin=JSON.parse(proof.source_json)}catch{omit();continue}
          const context=packet?.source_context,record=Array.isArray(packet?.records)?packet.records.find(part=>part.source_id===row.post_id&&part.author_uid===row.author_uid&&['participant','topic_author'].includes(part.author_role)):null
          let sourceBar;try{sourceBar=canonicalBar(context?.bar)}catch{omit();continue}
          if(origin?.kind!=='platform_read'||origin.explicit!==true||context?.platform!=='tieba'||sourceBar!==bar||context.thread_id!==row.thread_id||!context.account_self_uid||record?.author_uid===context.account_self_uid||!wellFormed(record?.text)||row.observed_at!==(proof.source_at??proof.recorded_at)){omit();continue}
          const original=clipped(redactText(record.text.replace(/\[贴吧(?:表情|图片|内容片段)\]/g,' ').replace(/\s+/g,' ').trim()).replace(/https?:\/\/\S+/gi,'[链接]'),1200)
          if(original!==row.text){omit();continue}
          samples.push({text:row.text,scene:row.scene,source:{thread_id:row.thread_id,post_id:row.post_id,author_uid:row.author_uid,observed_at:row.observed_at}})
        }
        return renderNativePersonaExport({kind,platform,bar,samples,at,format:input.format??'json',filtered_fields:filtered})
      }
      if(input.bar!==undefined)throw new Error('只有吧内语风导出可以指定吧名')
      const effective=this.profiles.resolve(platform),own=this.profiles.ownProfile(platform)
      let profile=effective,source={platform:this.store.getPersonaProfile(effective.effective_profile_id)?.platform??platform,historical:false,revision:effective.effective_revision}
      if(input.version_id!==undefined){
        const selected=this.store.getPersonaVersion(input.version_id)
        if(!selected||![own.id,effective.effective_profile_id].includes(selected.profile_id))throw new Error('请选择当前平台或其生效来源的人设历史版本')
        profile=selected;source={platform:this.store.getPersonaProfile(selected.profile_id)?.platform??platform,historical:true,version:selected.version}
      }
      return renderNativePersonaExport({kind,platform,profile,source,at,format:input.format??'json'})
    })
  }
}
