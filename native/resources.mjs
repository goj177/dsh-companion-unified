import fs from 'node:fs'
import path from 'node:path'
import {createHash,randomUUID} from 'node:crypto'
import {spawn} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {NativeStore} from './store.mjs'
import {createQQBridgeCacheReader} from './qq-bridge-cache.mjs'

const hash=value=>createHash('sha256').update(value).digest('hex')
const physical=directory=>{
  const absolute=path.resolve(directory)
  let current=path.parse(absolute).root
  for(const part of absolute.slice(current.length).split(path.sep).filter(Boolean)){
    current=path.join(current,part)
    if(fs.existsSync(current)){if(fs.lstatSync(current).isSymbolicLink()||!fs.statSync(current).isDirectory())throw new Error('原生资源目录不能使用链接或文件')}
    else fs.mkdirSync(current,{mode:0o700})
  }
  return absolute
}
const publicError=message=>Object.assign(new Error(message),{code:'resource_unavailable'})

/** Used before opening the store during an offline restore. */
export function assertNativeRuntimeQuiescent({data_root,runtime_root}={}){
  if(typeof data_root!=='string'||!path.isAbsolute(data_root)||typeof runtime_root!=='string'||!path.isAbsolute(runtime_root))throw new Error('需明确原生资料及运行目录')
  const directory=path.join(runtime_root,'processes',hash(data_root));if(!fs.existsSync(directory))return true
  let cursor=path.parse(directory).root
  for(const part of directory.slice(cursor.length).split(path.sep).filter(Boolean)){cursor=path.join(cursor,part);if(fs.lstatSync(cursor).isSymbolicLink())throw new Error('运行实例目录不能是链接')}
  for(const name of fs.readdirSync(directory).filter(x=>x.endsWith('.json'))){const file=path.join(directory,name);if(fs.lstatSync(file).isSymbolicLink())throw new Error('运行实例记录异常，未替换资料')
    let value;try{value=JSON.parse(fs.readFileSync(file,'utf8'))}catch{throw new Error('运行实例状态无法核对，未替换资料')}
    if(value.schema_id!=='companion.runtime_process'||value.schema_version!==1||value.root_sha256!==hash(data_root)||!Number.isSafeInteger(value.pid)||value.pid<1)throw new Error('运行实例记录无效，未替换资料')
    let alive=true;try{process.kill(value.pid,0)}catch(error){if(error.code==='ESRCH')alive=false}
    if(alive)throw new Error('仍有Harness实例使用这套资料，请完全退出后重启恢复')
    fs.unlinkSync(file)
  }
  return true
}

function run(program,args,{input,timeout_ms=120000,signal,max_output=8*1024*1024}={}){
  return new Promise((resolve,reject)=>{
    if(signal?.aborted)return reject(publicError('媒体处理已取消'))
    const env={...process.env,PYTHONUNBUFFERED:'1'};for(const key of ['PYTHONPATH','PYTHONHOME','VIRTUAL_ENV','BILI_ASR_HOME','BILI_ASR_PYTHON'])delete env[key]
    const child=spawn(program,args,{stdio:['pipe','pipe','pipe'],shell:false,env})
    const out=[],errors=[];let size=0,done=false,timer,killTimer
    const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);error?reject(error):resolve(value)}
    const abort=()=>{child.kill('SIGTERM');killTimer=setTimeout(()=>child.kill('SIGKILL'),2000);killTimer.unref?.();finish(publicError('媒体处理已取消或超时'))}
    child.on('error',()=>finish(publicError('原生媒体程序不可用')))
    child.stdout.on('data',chunk=>{size+=chunk.length;if(size>max_output)abort();else out.push(chunk)})
    child.stderr.on('data',chunk=>{if(errors.reduce((n,x)=>n+x.length,0)<32768)errors.push(chunk)})
    child.on('close',code=>{clearTimeout(killTimer);finish(code===0?null:publicError('本地媒体处理未完成；没有把失败结果当作已观看或准确转写'),Buffer.concat(out))})
    signal?.addEventListener('abort',abort,{once:true});timer=setTimeout(abort,timeout_ms);timer.unref?.()
    child.stdin.on('error',()=>{});child.stdin.end(input)
  })
}

/** Managed runtime resources. No old plugin directory or executable fallback. */
export class NativeResources {
  constructor({store,runtime_root,tools={},now=Date.now}={}){
    if(!(store instanceof NativeStore)||typeof now!=='function')throw new Error('资源服务需要原生存储')
    this.store=store;this.root=path.dirname(store.file);const runtime=path.resolve(runtime_root??path.join(path.dirname(this.root),'companion-runtime'))
    if(runtime===this.root||runtime.startsWith(this.root+path.sep)||this.root.startsWith(runtime+path.sep))throw new Error('运行环境须独立于在线记忆资料目录')
    this.runtime=physical(runtime)
    this.tools=tools;this.now=now;this.process_id=randomUUID();this.process_file=null;this.timer=null;this.probed=null
    this.qq_cache_state='unbound';this.qqBridgeCacheReader=this._qqBridgeCache()
  }
  _qqBridgeCache(){
    const file=path.join(this.runtime,'bindings','qq-media.json')
    try{
      if(!fs.existsSync(file))return undefined
      let current=path.parse(file).root
      for(const part of file.slice(current.length).split(path.sep).filter(Boolean)){current=path.join(current,part);if(fs.lstatSync(current).isSymbolicLink())throw new Error('链接')}
      const stat=fs.lstatSync(file)
      if(!stat.isFile()||stat.nlink!==1||stat.size>8192||(stat.mode&0o777)!==0o600||process.getuid&&stat.uid!==process.getuid())throw new Error('权限')
      const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);let binding
      try{const opened=fs.fstatSync(fd);if(opened.dev!==stat.dev||opened.ino!==stat.ino||opened.size!==stat.size)throw new Error('变更');binding=JSON.parse(fs.readFileSync(fd,'utf8'))}finally{fs.closeSync(fd)}
      if(binding.schema_id!=='companion.qq_image_cache_binding'||binding.schema_version!==2||Object.keys(binding).some(key=>!['schema_id','schema_version','bridge_url','roots'].includes(key))||!Array.isArray(binding.roots)||binding.roots.length<1||binding.roots.length>4)throw new Error('格式')
      const url=new URL(binding.bridge_url)
      if(url.protocol!=='ws:'||!['127.0.0.1','[::1]','localhost'].includes(url.hostname)||url.username||url.password||url.search||url.hash)throw new Error('连接')
      const readers=binding.roots.map(root=>{if(!root||Object.keys(root).some(key=>!['cache_root','bridge_root'].includes(key)))throw new Error('格式');return{bridge_root:root.bridge_root,read:createQQBridgeCacheReader(root)}})
      if(readers.some((root,index)=>readers.some((other,j)=>j!==index&&(root.bridge_root===other.bridge_root||root.bridge_root.startsWith(other.bridge_root+'/')))))throw new Error('重复目录')
      this.qq_cache_state='bound'
      return input=>{
        const qq=this.store.getDocument('qq')?.value.qq?.transport
        if(qq?.mode!=='forward'||qq.url!==binding.bridge_url)throw publicError('当前QQ桥接与图片缓存绑定不一致')
        const root=readers.find(root=>typeof input?.bridge_file==='string'&&input.bridge_file.startsWith(root.bridge_root+'/'))
        if(!root)throw publicError('OneBot图片缓存不在已授权的图片或表情目录内')
        return root.read(input)
      }
    }catch{this.qq_cache_state='invalid';return undefined}
  }
  workspace(id){
    if(typeof id!=='string'||!id||id.length>512||/[\0\r\n]/.test(id))throw new Error('工作区标识无效')
    return physical(path.join(this.root,'workspaces',hash(id)))
  }
  _tool(name){
    const configured=this.tools[name],candidates=configured?[configured]:[path.join('/opt/homebrew/bin',name),path.join('/usr/local/bin',name),path.join('/usr/bin',name)]
    for(const candidate of candidates){try{const file=fs.realpathSync(candidate);if(fs.statSync(file).isFile()){fs.accessSync(file,fs.constants.X_OK);return file}}catch{}}
    throw publicError('本地'+name+'尚未准备好')
  }
  _python(){
    const file=path.join(this.runtime,'asr',process.platform==='win32'?'Scripts/python.exe':'bin/python')
    try{if(fs.existsSync(file)){fs.accessSync(file,fs.constants.X_OK);return file}}catch{}
    throw publicError('本地转写环境尚未准备好')
  }
  async probe(){
    if(this.probed&&this.probed.checked_at+600000>this.now())return {...this.probed}
    let ffmpeg=false,asr=false
    try{await run(this._tool('ffmpeg'),['-version'],{timeout_ms:10000,max_output:65536});ffmpeg=true}catch{}
    try{const result=await run(this._python(),['-c','import json,sys,faster_whisper; print(json.dumps({"prefix":sys.prefix,"module":faster_whisper.__file__}))'],{timeout_ms:30000,max_output:65536});const value=JSON.parse(result.toString());asr=path.resolve(value.prefix)===path.join(this.runtime,'asr')&&path.resolve(value.module).startsWith(path.join(this.runtime,'asr')+path.sep)}catch{}
    return this.probed={ffmpeg,asr,qq_image_cache:this.qq_cache_state,checked_at:this.now(),model_calls:0}
  }
  async _download(url,fetcher,file,max_bytes,signal){
    if(typeof fetcher!=='function')throw publicError('缺少受控媒体下载器')
    const response=await fetcher(url,{method:'GET',signal})
    if(!response.ok)throw publicError('媒体下载未成功')
    const advertised=Number(response.headers?.get?.('content-length')??0)
    if(advertised>max_bytes)throw publicError('媒体超过本轮大小上限')
    const fd=fs.openSync(file,'wx',0o600);let total=0
    try{
      if(response.body?.getReader){const reader=response.body.getReader();try{for(;;){const {value,done}=await reader.read();if(done)break;total+=value.length;if(total>max_bytes){await reader.cancel();throw publicError('媒体超过本轮大小上限')}fs.writeSync(fd,value)}}finally{reader.releaseLock()}}
      else{const bytes=Buffer.from(await response.arrayBuffer());total=bytes.length;if(total>max_bytes)throw publicError('媒体超过本轮大小上限');fs.writeSync(fd,bytes)}
      fs.fsyncSync(fd)
    }finally{fs.closeSync(fd)}
    if(total===0)throw publicError('媒体为空')
    return total
  }
  async transcribe({bytes,model='small',signal,timeout_ms=120000}={}){
    if(!(bytes instanceof Uint8Array)||bytes.length>128*1024*1024||!bytes.length||!['tiny','base','small','medium'].includes(model))throw publicError('转写媒体或模型设置无效')
    const work=fs.mkdtempSync(path.join(physical(path.join(this.runtime,'tmp')),'asr-')),input=path.join(work,'input.media'),wav=path.join(work,'audio.wav')
    try{
      fs.writeFileSync(input,bytes,{mode:0o600})
      await run(this._tool('ffmpeg'),['-nostdin','-hide_banner','-loglevel','error','-protocol_whitelist','file,pipe','-i',input,'-ar','16000','-ac','1','-f','wav',wav],{signal,timeout_ms:Math.min(timeout_ms,60000)})
      const worker=fileURLToPath(new URL('./transcribe.py',import.meta.url)),models=physical(path.join(this.runtime,'models'))
      const result=await run(this._python(),[worker,'--input',wav,'--model',model,'--models-dir',models],{signal,timeout_ms,max_output:8*1024*1024})
      const parsed=JSON.parse(result.toString('utf8'));if(typeof parsed.text!=='string'||!parsed.text.isWellFormed())throw publicError('转写未返回有效文字')
      return parsed.text
    }finally{fs.rmSync(work,{recursive:true,force:true})}
  }
  transcriber=async({bytes,signal,settings})=>this.transcribe({bytes,signal,model:settings?.model??'small',timeout_ms:settings?.timeout_ms??60000})
  resourceRunner=async(input)=>{
    if(!['bilibili.asr','bilibili.frames'].includes(input?.operation))throw publicError('未开放此媒体资源操作')
    const work=fs.mkdtempSync(path.join(physical(path.join(this.runtime,'tmp')),'bili-')),media=path.join(work,'download.media')
    try{
      await this._download(input.url,input.fetcher,media,input.max_bytes??128*1024*1024,input.signal)
      if(input.operation==='bilibili.asr')return {text:await this.transcribe({bytes:fs.readFileSync(media),model:input.model??'small',signal:input.signal,timeout_ms:600000}),uncertain:true}
      const match=/^([1-4])x([1-4])$/.exec(input.grid??'3x3');if(!match||!Number.isFinite(input.duration)||input.duration<=0||!input.assets?.put)throw publicError('取帧参数或图像资产服务无效')
      const columns=Number(match[1]),rows=Number(match[2]),count=columns*rows,frames=[]
      for(let index=0;index<count;index++){
        const file=path.join(work,'frame-'+index+'.jpg'),at=(index+0.5)/count*input.duration
        await run(this._tool('ffmpeg'),['-nostdin','-hide_banner','-loglevel','error','-ss',String(at),'-protocol_whitelist','file,pipe','-i',media,'-frames:v','1','-vf','scale=480:-2',file],{signal:input.signal,timeout_ms:60000})
        frames.push({bytes:fs.readFileSync(file),at})
      }
      const {createCanvas,loadImage}=await import('@napi-rs/canvas'),width=480,height=300,canvas=createCanvas(width*columns,height*rows),context=canvas.getContext('2d')
      context.fillStyle='#171b22';context.fillRect(0,0,canvas.width,canvas.height);context.font='16px sans-serif'
      for(let index=0;index<frames.length;index++){const image=await loadImage(frames[index].bytes),x=index%columns*width,y=Math.floor(index/columns)*height,scale=Math.min(width/image.width,(height-24)/image.height)
        context.drawImage(image,x+(width-image.width*scale)/2,y,image.width*scale,image.height*scale);context.fillStyle='#fff';context.fillText(frames[index].at.toFixed(1)+'s',x+8,y+height-7)}
      const asset=await input.assets.put({kind:'image',media_type:'image/jpeg',bytes:canvas.toBuffer('image/jpeg',85),source_ref:'https://www.bilibili.com/video/'+input.bvid,visibility:'public',
        manifest:{schema_version:1,platform:'bilibili',bvid:input.bvid,source_kind:'sampled_video_frames',sample_count:count,full_video_view_claim:false}})
      return {asset_ids:[asset.id],sample_count:count,full_video_view_claim:false,model_calls:0}
    }finally{fs.rmSync(work,{recursive:true,force:true})}
  }
  cardRenderer=async({text,footer=''})=>{
    if(typeof text!=='string'||text.length>20000)throw publicError('图卡文字过长，请使用分段文字')
    const {createCanvas}=await import('@napi-rs/canvas'),width=1200,padding=40,lineHeight=27,probe=createCanvas(width,20),ctx=probe.getContext('2d');ctx.font='20px "PingFang SC","Microsoft YaHei",sans-serif'
    const lines=[]
    for(const paragraph of text.split('\n')){let line='';for(const part of new Intl.Segmenter('zh',{granularity:'grapheme'}).segment(paragraph)){if(line&&ctx.measureText(line+part.segment).width>width-padding*2){lines.push(line);line=''}line+=part.segment}lines.push(line)}
    const height=padding*2+lines.length*lineHeight+(footer?35:0);if(height>8192)throw publicError('图卡过长，请使用分段文字')
    const canvas=createCanvas(width,Math.max(120,height)),context=canvas.getContext('2d');context.fillStyle='#fafbfd';context.fillRect(0,0,width,canvas.height);context.fillStyle='#202b3a';context.font=ctx.font
    lines.forEach((line,index)=>context.fillText(line,padding,padding+(index+0.8)*lineHeight))
    if(footer){context.font='15px sans-serif';context.fillStyle='#687789';context.fillText(footer.slice(0,200),padding,canvas.height-20)}
    return {bytes:canvas.toBuffer('image/png')}
  }
  registerProcess(){
    if(this.process_file)return
    const directory=physical(path.join(this.runtime,'processes',hash(this.root)))
    this.process_file=path.join(directory,process.pid+'-'+this.process_id+'.json')
    const update=()=>{if(!this.process_file)return;const value={schema_id:'companion.runtime_process',schema_version:1,root_sha256:hash(this.root),pid:process.pid,token:this.process_id,updated_at:this.now()}
      const tmp=this.process_file+'.tmp';fs.writeFileSync(tmp,JSON.stringify(value),{mode:0o600});fs.renameSync(tmp,this.process_file)}
    update();this.timer=setInterval(update,10000);this.timer.unref?.()
  }
  isRegisteredProcessActive({pid,token}={}){
    if(!Number.isSafeInteger(pid)||pid<1||typeof token!=='string'||!/^[a-f0-9-]{36}$/.test(token))return false
    const file=path.join(this.runtime,'processes',hash(this.root),pid+'-'+token+'.json')
    try{if(fs.lstatSync(file).isSymbolicLink())return false;const value=JSON.parse(fs.readFileSync(file,'utf8'))
      if(value.schema_id!=='companion.runtime_process'||value.schema_version!==1||value.root_sha256!==hash(this.root)||value.pid!==pid||value.token!==token)return false
      try{process.kill(pid,0);return true}catch(error){return error.code!=='ESRCH'}
    }catch{return false}
  }
  assertQuiescent(){
    return assertNativeRuntimeQuiescent({data_root:this.root,runtime_root:this.runtime})
  }
  close(){clearInterval(this.timer);this.timer=null;if(this.process_file){try{fs.unlinkSync(this.process_file)}catch(error){if(error.code!=='ENOENT')throw error}this.process_file=null}}
}
