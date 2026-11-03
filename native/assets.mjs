/** Native content-addressed bytes. This is a host capability, never a model-facing file/URL reader. */
import fs from 'node:fs'
import path from 'node:path'
import { createHash,randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { NativeStore } from './store.mjs'
import { isPlainObject,validateJson,stringifyJson } from './contracts.mjs'
import { safeJson,redactText } from './memory-rules.mjs'

const hash=bytes=>createHash('sha256').update(bytes).digest('hex')
const exists=file=>{try{return fs.lstatSync(file)}catch(error){if(error.code==='ENOENT')return null;throw error}}
const sameFile=(a,b)=>a.dev===b.dev&&a.ino===b.ino
const uid=()=>process.getuid?.()
const owned=stat=>uid()===undefined||stat.uid===uid()
const privateFile=stat=>stat?.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1&&owned(stat)&&(stat.mode&0o777)===0o600
const stable=(a,b)=>sameFile(a,b)&&a.size===b.size&&a.mtimeMs===b.mtimeMs&&a.ctimeMs===b.ctimeMs
const generic=()=>new Error('原生资源路径、权限或字节完整性校验失败')
const baseName=name=>typeof name==='string'&&/^[a-zA-Z0-9_.-]{1,180}$/.test(name)&&name!=='.'&&name!=='..'

/** Shared private native-root file primitives. Only assets/.secrets subdirectories are addressable. */
export function nativeResourceFiles(store,root){
  if(!(store instanceof NativeStore))throw new Error('原生资源必须显式接收NativeStore')
  store._open();const file=store.file,authority=path.dirname(file)
  if(root!==undefined&&(typeof root!=='string'||root!==path.resolve(root)||root!==authority))throw new Error('原生资源根目录必须与NativeStore一致')
  const initial=exists(authority),initialDb=exists(file)
  const check=()=>{
    store._open();if(store.file!==file)throw generic()
    let current=path.parse(authority).root
    for(const segment of authority.slice(current.length).split(path.sep).filter(Boolean)){current=path.join(current,segment);const stat=exists(current);if(!stat?.isDirectory()||stat.isSymbolicLink())throw generic()}
    const stat=exists(authority),db=exists(file)
    if(!stat||!initial||!sameFile(stat,initial)||!owned(stat)||(stat.mode&0o777)!==0o700||!privateFile(db)||!sameFile(db,initialDb))throw generic()
    return authority
  }
  const directory=(name,create=false)=>{
    check();if(!['assets','.secrets'].includes(name))throw generic();const result=path.join(authority,name);let stat=exists(result)
    if(!stat&&create){store._write();try{fs.mkdirSync(result,{mode:0o700})}catch(error){if(error.code!=='EEXIST')throw generic()};stat=exists(result)}
    if(!stat)return null
    if(!stat.isDirectory()||stat.isSymbolicLink()||!owned(stat)||(stat.mode&0o777)!==0o700)throw generic()
    return result
  }
  const location=(dir,name,create=false)=>{if(!baseName(name))throw generic();const folder=directory(dir,create);return folder?path.join(folder,name):null}
  const read=(dir,name,max)=>{
    const filePath=location(dir,name);if(!filePath||!exists(filePath))return null
    if(!privateFile(exists(filePath)))throw generic();let descriptor
    try{
      descriptor=fs.openSync(filePath,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW)
      const before=fs.fstatSync(descriptor);if(!privateFile(before)||before.size>max)throw generic()
      const chunks=[];let size=0
      for(;;){const chunk=Buffer.alloc(Math.min(65536,max-size+1)),n=fs.readSync(descriptor,chunk,0,chunk.length,null);if(!n)break;size+=n;if(size>max)throw generic();chunks.push(chunk.subarray(0,n))}
      const after=fs.fstatSync(descriptor),named=exists(filePath);check()
      if(!privateFile(after)||!privateFile(named)||!stable(before,after)||!sameFile(after,named)||size!==after.size)throw generic()
      return {bytes:Buffer.concat(chunks),stat:after}
    }catch{throw generic()}finally{if(descriptor!==undefined)fs.closeSync(descriptor)}
  }
  const syncDirectory=folder=>{const fd=fs.openSync(folder,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{fs.fsyncSync(fd)}finally{fs.closeSync(fd)}}
  const write=(dir,name,bytes,{replace=false,expected_digest}={})=>{
    const target=location(dir,name,true),folder=path.dirname(target),temporary=path.join(folder,'.tmp-'+randomUUID());let descriptor,published=false,createdStat
    const old=exists(target)
    if(old&&!privateFile(old))throw generic()
    if(replace&&expected_digest!==undefined){const current=read(dir,name,2*1024*1024);if(!current||hash(current.bytes)!==expected_digest)throw generic()}
    try{
      descriptor=fs.openSync(temporary,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600)
      fs.fchmodSync(descriptor,0o600);fs.writeFileSync(descriptor,bytes);fs.fsyncSync(descriptor);createdStat=fs.fstatSync(descriptor);fs.closeSync(descriptor);descriptor=undefined
      location(dir,name)
      if(replace){if(old&&!sameFile(old,exists(target)))throw generic();fs.renameSync(temporary,target)}
      else{fs.linkSync(temporary,target);fs.unlinkSync(temporary)}
      published=true;syncDirectory(folder)
      const result=read(dir,name,Math.max(bytes.length,1));if(!result||!result.bytes.equals(bytes))throw generic();return result
    }catch(error){if(published&&!replace){const current=exists(target);if(current&&createdStat&&privateFile(current)&&sameFile(current,createdStat))try{fs.unlinkSync(target);syncDirectory(folder)}catch{}}
      if(error.code==='EEXIST')throw Object.assign(new Error('原生资源已存在，未覆盖'),{code:'RESOURCE_EXISTS'});throw generic()}
    finally{if(descriptor!==undefined)fs.closeSync(descriptor);try{fs.unlinkSync(temporary)}catch(error){if(error.code!=='ENOENT'&&!published)throw generic()}}
  }
  const remove=(dir,name,expected)=>{
    const target=location(dir,name);if(!target)return false;const stat=exists(target);if(!stat)return false
    if(!privateFile(stat)||expected&&!sameFile(stat,expected))throw generic();fs.unlinkSync(target);syncDirectory(path.dirname(target));return true
  }
  const lock=(dir,name,operation)=>{
    const target=location(dir,name,true);let descriptor
    try{descriptor=fs.openSync(target,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600)}catch{throw new Error('原生资源正在写入或锁状态异常，请稍后重试')}
    const stat=fs.fstatSync(descriptor)
    try{return operation()}finally{fs.closeSync(descriptor);const current=exists(target);if(privateFile(current)&&sameFile(stat,current))fs.unlinkSync(target)}
  }
  check();return {root:authority,check,directory,read,write,remove,lock}
}

const KINDS=new Set(['image','sticker','voice','audio','video','file','attachment','source','diary','report','knowledge','subtitle'])
const MIME_ALIASES={'image/jpg':'image/jpeg','audio/x-wav':'audio/wav','audio/wave':'audio/wav','audio/x-silk':'audio/silk','application/x-zip-compressed':'application/zip','text/json':'application/json'}
const LIMITS={image:20*1024*1024,sticker:20*1024*1024,voice:20*1024*1024,audio:32*1024*1024,video:100*1024*1024,file:32*1024*1024,attachment:32*1024*1024,source:16*1024*1024,diary:16*1024*1024,report:16*1024*1024,knowledge:16*1024*1024,subtitle:16*1024*1024}
const MAX_READ=Math.max(...Object.values(LIMITS))
function mediaType(value){if(typeof value!=='string'||value.length>160||/[\0\r\n]/.test(value))throw new Error('素材类型无效');const base=value.toLowerCase().split(';')[0].trim();return MIME_ALIASES[base]??base}
function inspectBytes(bytes,declared,kind){
  if(!KINDS.has(kind)||!bytes.length&&['image','sticker','voice','audio','video'].includes(kind)||bytes.length>LIMITS[kind])throw new Error('素材类型或字节数超过支持范围')
  const first=bytes.subarray(0,16),hex=bytes.subarray(0,4).toString('hex')
  if(first.subarray(0,2).toString()==='MZ'||hex==='7f454c46'||['feedface','feedfacf','cefaedfe','cffaedfe','cafebabe','bebafeca','0061736d'].includes(hex)||first.subarray(0,2).toString()==='#!'&&!first.toString().startsWith('#!AMR')&&!first.toString().startsWith('#!SILK'))throw new Error('不接受可执行素材')
  if(/(?:javascript|ecmascript|x-(?:sh|shellscript|executable|msdownload)|text\/html|image\/svg)/.test(declared))throw new Error('不接受可执行素材类型')
  let detected,extension,family
  if(bytes.length>=24&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))&&bytes.subarray(12,16).toString()==='IHDR'){
    const width=bytes.readUInt32BE(16),height=bytes.readUInt32BE(20);if(!width||!height||width*height>100000000)throw new Error('图片尺寸超过支持范围');[detected,extension,family]=['image/png','png','image']
  }else if(bytes.length>=4&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255)[detected,extension,family]=['image/jpeg','jpg','image']
  else if(bytes.length>=10&&/^GIF8[79]a$/.test(bytes.subarray(0,6).toString())){if(!bytes.readUInt16LE(6)||!bytes.readUInt16LE(8)||bytes.readUInt16LE(6)*bytes.readUInt16LE(8)>100000000)throw new Error('图片尺寸超过支持范围');[detected,extension,family]=['image/gif','gif','image']}
  else if(bytes.length>=20&&bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP')[detected,extension,family]=['image/webp','webp','image']
  else if(bytes.length>=12&&bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WAVE')[detected,extension,family]=['audio/wav','wav','audio']
  else if(bytes.subarray(0,4).toString()==='OggS')[detected,extension,family]=['audio/ogg','ogg','audio']
  else if(bytes.subarray(0,4).toString()==='fLaC')[detected,extension,family]=['audio/flac','flac','audio']
  else if(bytes.subarray(0,6).toString()==='#!AMR\n'||bytes.subarray(0,9).toString()==='#!AMR-WB\n')[detected,extension,family]=['audio/amr','amr','audio']
  else if(bytes.subarray(0,9).toString()==='#!SILK_V3'||bytes.subarray(0,10).toString()==='\x02#!SILK_V3')[detected,extension,family]=['audio/silk','silk','audio']
  else if(bytes.subarray(0,3).toString()==='ID3'||bytes.length>=2&&bytes[0]===255&&(bytes[1]&224)===224)[detected,extension,family]=['audio/mpeg','mp3','audio']
  else if(bytes.length>=12&&bytes.subarray(4,8).toString()==='ftyp'){
    const brand=bytes.subarray(8,12).toString();if(['M4A ','M4B '].includes(brand))[detected,extension,family]=['audio/mp4','m4a','audio'];else if(['isom','iso2','mp41','mp42','avc1','dash','M4V ','3gp4','MSNV','qt  '].includes(brand))[detected,extension,family]=['video/mp4','mp4','video']
  }else if(bytes.subarray(0,5).toString()==='%PDF-')[detected,extension,family]=['application/pdf','pdf','file']
  else if(bytes.length>=4&&['504b0304','504b0506','504b0708'].includes(hex))[detected,extension,family]=['application/zip','zip','file']
  else if(bytes[0]===31&&bytes[1]===139)[detected,extension,family]=['application/gzip','gz','file']
  if(!detected){
    const text=bytes.toString('utf8'),validText=Buffer.from(text,'utf8').equals(bytes)
    if(['application/json','text/plain','text/markdown','text/vtt','application/x-subrip'].includes(declared)){
      if(!validText)throw new Error('文本素材编码无效')
      if(declared==='application/json')try{const parsed=JSON.parse(text);if(!['file','attachment'].includes(kind))validateJson(parsed,{maxBytes:16*1024*1024})}catch{throw new Error('JSON素材格式无效')}
      detected=declared;extension=({'application/json':'json','text/markdown':'md','text/vtt':'vtt','application/x-subrip':'srt'})[declared]??'txt';family='text'
    }else if(declared==='application/octet-stream'&&kind==='source'||['file','attachment'].includes(kind)&&/^(?:application|text|audio|video|image)\/[a-z0-9][a-z0-9.+_-]*$/.test(declared)){detected='application/octet-stream';extension='bin';family='file'}
    else throw new Error('素材字节与声明类型不符')
  }
  if(declared!==detected&&declared!=='application/octet-stream'&&!['file','attachment'].includes(kind)&&!(declared==='audio/opus'&&detected==='audio/ogg'))throw new Error('素材字节与声明类型不符')
  if(['image','sticker'].includes(kind)&&family!=='image'||['voice','audio'].includes(kind)&&family!=='audio'||kind==='video'&&family!=='video'||['diary','report','knowledge','subtitle'].includes(kind)&&family!=='text')throw new Error('素材用途与真实字节类型不符')
  return {media_type:detected,extension}
}
const safeSource=value=>{if(typeof value!=='string'||!value.isWellFormed()||value.length>8192||value.includes('\0'))throw new Error('素材来源标识无效');return redactText(value)}
const publicRow=row=>({id:row.id,kind:row.kind,relative_path:row.relative_path,sha256:row.sha256,byte_size:row.byte_size,media_type:row.media_type,created_at:row.created_at,source_ref:row.source_ref,manifest:JSON.parse(row.manifest_json)})

export class NativeAssets{
  constructor(options={}){
    if(!isPlainObject(options)||Object.keys(options).some(key=>!['store','root'].includes(key)))throw new Error('NativeAssets选项无效')
    this.store=options.store;this.files=nativeResourceFiles(options.store,options.root)
  }
  _row(id){if(typeof id!=='string'||!/^asset:[a-f0-9]{64}$/.test(id))throw new Error('需要已登记原生asset_ref');this.store._open();return this.store.db.prepare('SELECT * FROM assets WHERE id=?').get(id)}
  read(id){
    const row=this._row(id);if(!row)throw new Error('原生素材未登记')
    if(row.sha256!==id.slice(6)||!new RegExp('^assets/'+row.sha256+'\\.[a-z0-9]{1,12}$').test(row.relative_path)||!KINDS.has(row.kind)||!Number.isSafeInteger(row.byte_size)||row.byte_size<0||row.byte_size>LIMITS[row.kind])throw new Error('原生素材登记无效')
    const result=this.files.read('assets',path.basename(row.relative_path),Math.min(MAX_READ,LIMITS[row.kind]))
    if(!result||result.bytes.length!==row.byte_size||hash(result.bytes)!==row.sha256)throw new Error('原生素材缺失或SHA校验失败')
    inspectBytes(result.bytes,mediaType(row.media_type),row.kind)
    return {...publicRow(row),bytes:result.bytes}
  }
  put(input){
    if(!isPlainObject(input)||Object.keys(input).some(key=>!['bytes','kind','media_type','source_ref','manifest','visibility'].includes(key))||!Buffer.isBuffer(input.bytes)&&!(input.bytes instanceof Uint8Array))throw new Error('素材写入参数无效')
    this.store._write();if(this.store._depth)throw new Error('素材文件写入不能包在外层SQL事务内')
    const bytes=Buffer.from(input.bytes),kind=input.kind,detected=inspectBytes(bytes,mediaType(input.media_type),kind),digest=hash(bytes),id='asset:'+digest,source=safeSource(input.source_ref??''),visibility=input.visibility??'owner'
    if(!['public','conversation','owner','secret'].includes(visibility))throw new Error('素材可见性无效')
    let supplied
    try{supplied=safeJson(validateJson(input.manifest??{},{object:true,maxBytes:1024*1024}))}catch{throw new Error('素材说明格式无效')}
    if(Object.hasOwn(supplied,'registrations')||supplied.visibility!==undefined&&supplied.visibility!==visibility||supplied.schema_version!==undefined&&supplied.schema_version!==1)throw new Error('素材说明不能覆盖登记权限或来源列表')
    const registration={kind,media_type:detected.media_type,declared_media_type:mediaType(input.media_type),source_ref:source,visibility,manifest:supplied},filename=digest+'.'+detected.extension
    return this.files.lock('assets','.'+digest+'.lock',()=>{
      let created=null
      try{return this.store.transaction(()=>{
        const existing=this._row(id)
        if(existing){
          const original=this.read(id);if(!original.bytes.equals(bytes))throw new Error('同SHA素材字节冲突')
          const manifest=validateJson(original.manifest,{object:true,maxBytes:1024*1024}),registrations=Array.isArray(manifest.registrations)?manifest.registrations:[]
          if(registrations.some(row=>isDeepStrictEqual(row,registration)))return {...original,bytes:undefined,duplicate:true}
          const catalog=[...(Array.isArray(manifest.catalog_entries)?manifest.catalog_entries:[])]
          for(const entry of Array.isArray(supplied.catalog_entries)?supplied.catalog_entries:[])if(!catalog.some(old=>isDeepStrictEqual(old,entry)))catalog.push(entry)
          const merged={...manifest,...(catalog.length?{catalog_entries:catalog}:{}),registrations:[...registrations,registration]}
          validateJson(merged,{object:true,maxBytes:1024*1024});this.store.db.prepare('UPDATE assets SET manifest_json=? WHERE id=?').run(stringifyJson(merged),id)
          return {...publicRow({...existing,manifest_json:stringifyJson(merged)}),duplicate:true}
        }
        const oldFile=this.files.read('assets',filename,LIMITS[kind])
        if(oldFile){if(!oldFile.bytes.equals(bytes))throw new Error('未登记同SHA路径存在冲突字节')}
        else created=this.files.write('assets',filename,bytes).stat
        const manifest={...supplied,schema_version:1,visibility,registrations:[registration]}
        const row={id,kind,relative_path:'assets/'+filename,sha256:digest,byte_size:bytes.length,media_type:detected.media_type,created_at:this.store._now(),source_ref:source,manifest_json:stringifyJson(manifest)}
        this.store.db.prepare('INSERT INTO assets(id,kind,relative_path,sha256,byte_size,media_type,created_at,source_ref,manifest_json) VALUES(?,?,?,?,?,?,?,?,?)').run(row.id,row.kind,row.relative_path,row.sha256,row.byte_size,row.media_type,row.created_at,row.source_ref,row.manifest_json)
        return {...publicRow(row),duplicate:false}
      })}catch(error){
        if(created){let registered=true;try{registered=!!this._row(id)}catch{}if(!registered)this.files.remove('assets',filename,created)}
        throw error
      }
    })
  }
}
