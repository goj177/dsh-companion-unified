/** Native private vault. Plaintext never enters NativeStore/SQLite, state events or error details. */
import fs from 'node:fs'
import { createHash,createHmac,randomBytes,timingSafeEqual } from 'node:crypto'
import { isDeepStrictEqual,inspect } from 'node:util'
import { isPlainObject,validateJson,stringifyJson } from './contracts.mjs'
import { nativeResourceFiles } from './assets.mjs'

const MAX=1024*1024,KEY='.integrity-key'
const hash=value=>createHash('sha256').update(value).digest('hex')
const canonical=value=>Array.isArray(value)?value.map(canonical):isPlainObject(value)?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value
const encode=value=>stringifyJson(canonical(value))
const error=(code='SECRET_INVALID')=>Object.assign(new Error(code==='SECRET_CONFLICT'?'私密资源引用已存在且内容不同，未覆盖':code==='SECRET_INTEGRITY'?'私密资源完整性校验失败，未使用凭据':code==='SECRET_READ_ONLY'?'私密资源只读或事务边界不允许写入':'私密资源格式、权限或存储操作无效'),{code})
const ref=value=>{if(typeof value!=='string'||!/^[a-z][a-z0-9_.:/-]{0,159}$/.test(value))throw error();return value}
const provider=value=>{if(!['qq','bilibili','tieba'].includes(value))throw error();return value}
const text=(value,max=65536)=>{if(typeof value!=='string'||!value.isWellFormed()||value.length>max||/[\0\r\n]/.test(value))throw error();return value}
const object=(value,allowed)=>{
  if(!isPlainObject(value)||Object.keys(value).some(key=>!allowed.includes(key))||Object.values(Object.getOwnPropertyDescriptors(value)).some(d=>d.get||d.set))throw error()
  return value
}
const tokenName=value=>{text(value,512);if(!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(value))throw error();return value}
function dataOf(value,service,purpose){
  if(purpose==='notification_destination'){
    object(value,['endpoint_url','command_line','arguments','http_headers','output_location'])
    for(const field of ['endpoint_url','command_line','output_location'])if(value[field]!==undefined)text(value[field],65536)
    if(value.endpoint_url){let url;try{url=new URL(value.endpoint_url)}catch{throw error()};if(!['http:','https:'].includes(url.protocol))throw error()}
    if(value.arguments!==undefined&&(!Array.isArray(value.arguments)||value.arguments.length>1000||value.arguments.some(item=>typeof item!=='string')))throw error()
    for(const item of value.arguments??[])text(item,65536)
    if(value.http_headers!==undefined){if(!Array.isArray(value.http_headers)||value.http_headers.length>200)throw error();for(const row of value.http_headers){object(row,['name','value']);tokenName(row.name);text(row.value,65536)}}
  }else if(purpose==='account_authentication'){
    const fields=service==='qq'?['access_token']:service==='bilibili'?['sessdata','bili_jct','buvid3']:['cookie_header','cookies']
    object(value,fields)
    if(!Object.keys(value).length)throw error()
    for(const field of fields.filter(key=>key!=='cookies'))if(value[field]!==undefined)text(value[field],field==='cookie_header'?262144:65536)
    if(value.cookies!==undefined){
      if(!Array.isArray(value.cookies)||value.cookies.length>5000)throw error()
      for(const cookie of value.cookies){
        object(cookie,['domain','include_subdomains','path','secure','http_only','expires_at','name','value'])
        if(!/^\.?[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(text(cookie.domain,512))||!text(cookie.path,2048).startsWith('/'))throw error()
        for(const field of ['include_subdomains','secure','http_only'])if(typeof cookie[field]!=='boolean')throw error()
        if(cookie.expires_at!==null&&(!Number.isSafeInteger(cookie.expires_at)||cookie.expires_at<0||cookie.expires_at>8640000000000000))throw error()
        tokenName(cookie.name);text(cookie.value,65536)
      }
    }
  }else throw error()
  try{return validateJson(value,{object:true,maxBytes:MAX})}catch{throw error()}
}
function envelopeOf(value){
  object(value,['secret_ref','provider','purpose','schema_id','schema_version','data'])
  if(Object.keys(value).length!==6||value.schema_id!=='companion.secret'||value.schema_version!==1)throw error()
  const secret_ref=ref(value.secret_ref),service=provider(value.provider),purpose=text(value.purpose,80)
  return {secret_ref,provider:service,purpose,schema_id:'companion.secret',schema_version:1,data:dataOf(value.data,service,purpose)}
}
const hidden=value=>{Object.defineProperty(value,inspect.custom,{value:()=> '[NativeSecret: private contents hidden]'});return value}
const secureResult=value=>{hidden(value.data);return hidden(value)}
const safeResult=(envelope,duplicate)=>({secret_ref:envelope.secret_ref,provider:envelope.provider,purpose:envelope.purpose,schema_id:'companion.secret',schema_version:1,duplicate})

export class NativeSecrets{
  constructor(options={}){object(options,['store']);this.store=options.store;this.files=nativeResourceFiles(options.store)}
  _write(){try{this.store._write();if(this.store._depth)throw error('SECRET_READ_ONLY')}catch{throw error('SECRET_READ_ONLY')}}
  _key(create=false){
    const readOrCreate=()=>{let found=this.files.read('.secrets',KEY,32)
    if(!found&&create){
      const directory=this.files.directory('.secrets',true)
      if(fs.readdirSync(directory).some(name=>/^[a-f0-9]{64}\.json$/.test(name)))throw error('SECRET_INTEGRITY')
      try{this.files.write('.secrets',KEY,randomBytes(32))}catch(writeError){if(writeError.code!=='RESOURCE_EXISTS')throw error()}
      found=this.files.read('.secrets',KEY,32)
    }
    if(!found||found.bytes.length!==32)throw error('SECRET_INTEGRITY')
    return found.bytes}
    // Every writer waits for the first root key to finish its durable publication.
    return create?this.files.lock('.secrets','.key-init.lock',readOrCreate):readOrCreate()
  }
  _read(secretRef){
    const filename=hash(ref(secretRef))+'.json',found=this.files.read('.secrets',filename,MAX+65536)
    if(!found)return null
    let record,envelope
    try{
      const decoded=found.bytes.toString('utf8');if(!Buffer.from(decoded,'utf8').equals(found.bytes))throw error('SECRET_INTEGRITY')
      record=JSON.parse(decoded);object(record,['schema_id','schema_version','envelope','integrity_hmac'])
      if(Object.keys(record).length!==4||record.schema_id!=='companion.secret_record'||record.schema_version!==1||typeof record.integrity_hmac!=='string'||!/^[a-f0-9]{64}$/.test(record.integrity_hmac))throw error('SECRET_INTEGRITY')
      envelope=envelopeOf(record.envelope)
    }catch{throw error('SECRET_INTEGRITY')}
    const expected=createHmac('sha256',this._key()).update(encode(envelope)).digest(),actual=Buffer.from(record.integrity_hmac,'hex')
    if(envelope.secret_ref!==secretRef||expected.length!==actual.length||!timingSafeEqual(expected,actual))throw error('SECRET_INTEGRITY')
    return {envelope,bytes:found.bytes,filename,stat:found.stat}
  }
  get(secretRef){try{const found=this._read(ref(secretRef));return found?secureResult(found.envelope):null}catch(readError){throw error(readError.code==='SECRET_INTEGRITY'?'SECRET_INTEGRITY':'SECRET_INVALID')}}
  _save(value,replace){
    this._write();let envelope
    try{envelope=envelopeOf(value)}catch{throw error()}
    const filename=hash(envelope.secret_ref)+'.json'
    try{return this.files.lock('.secrets','.'+hash(envelope.secret_ref)+'.lock',()=>{
      const previous=this._read(envelope.secret_ref)
      if(previous){
        if(isDeepStrictEqual(previous.envelope,envelope))return safeResult(envelope,true)
        if(!replace)throw error('SECRET_CONFLICT')
        if(previous.envelope.provider!==envelope.provider||previous.envelope.purpose!==envelope.purpose)throw error('SECRET_CONFLICT')
      }
      const signature=createHmac('sha256',this._key(true)).update(encode(envelope)).digest('hex'),record={schema_id:'companion.secret_record',schema_version:1,envelope,integrity_hmac:signature},bytes=Buffer.from(encode(record)+'\n')
      if(bytes.length>MAX+65536)throw error()
      try{this.files.write('.secrets',filename,bytes,{replace:!!previous,...(previous?{expected_digest:hash(previous.bytes)}:{})})}
      catch{
        // A post-rename durability failure may have published the new record. Restore the prior native record.
        if(previous){let current;try{current=this.files.read('.secrets',filename,MAX+65536)}catch{}if(current&&!current.bytes.equals(previous.bytes))try{this.files.write('.secrets',filename,previous.bytes,{replace:true,expected_digest:hash(current.bytes)})}catch{throw error('SECRET_ROLLBACK_FAILED')}}
        throw error()
      }
      return safeResult(envelope,false)
    })}catch(writeError){throw error(['SECRET_CONFLICT','SECRET_INTEGRITY','SECRET_READ_ONLY','SECRET_ROLLBACK_FAILED'].includes(writeError.code)?writeError.code:'SECRET_INVALID')}
  }
  /** Idempotent import writer: a different value under the same ref is a conflict. */
  put(envelope){return this._save(envelope,false)}
  /** Provider-only private reader and explicit credential rotation writer. No account/document updates occur here. */
  bind(service){
    provider(service)
    const credentials=secretRef=>{
      if(secretRef===undefined||secretRef===null||secretRef==='')return hidden({})
      const envelope=this.get(secretRef);if(!envelope)return hidden({})
      if(envelope.provider!==service||envelope.purpose!=='account_authentication')throw error()
      return envelope.data
    }
    Object.defineProperty(credentials,'save',{value:(secretRef,data,options={})=>{
      object(options,['account']) // Deliberately do not read, persist, return or log options.account.
      return this._save({secret_ref:ref(secretRef),provider:service,purpose:'account_authentication',schema_id:'companion.secret',schema_version:1,data},true)
    }})
    return credentials
  }
}
