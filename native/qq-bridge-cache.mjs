/** Explicit owner-bound OneBot image-cache reader. No discovery, legacy path,
 * remote command, model filesystem authority or caller URL interpretation. */
import fs from 'node:fs'
import path from 'node:path'
import {spawnSync} from 'node:child_process'

const denied=()=>new Error('OneBot图片缓存不在已授权的物理目录内，或文件状态无法安全核验')
const fingerprint=stat=>['dev','ino','size','mtimeNs','ctimeNs'].map(key=>String(stat[key])).join(':')
const regular=value=>value.isFile()&&value.nlink===1n
function darwinDescriptorPath(descriptor){
  // macOS fdescfs cannot walk a directory FD. Query only this process's exact
  // opened FD using the system metadata reader; no path, URL or credential is
  // a command argument, and no shell/diagnostic text is interpreted.
  const result=spawnSync('/usr/sbin/lsof',['-a','-p',String(process.pid),'-d',String(descriptor),'-F0n'],{encoding:'utf8',shell:false,timeout:3000,maxBuffer:65536,stdio:['ignore','pipe','ignore']})
  if(result.error||result.status!==0)throw denied()
  const names=result.stdout.split('\0').map(value=>value.replace(/^\n/,'' )).filter(value=>value.startsWith('n')).map(value=>value.slice(1))
  if(names.length!==1||!path.isAbsolute(names[0]))throw denied()
  return names[0]
}
function physicalRoot(input){
  if(typeof input!=='string'||!path.isAbsolute(input)||path.resolve(input)!==input||/[\0\r\n]/.test(input))throw denied()
  let current=path.parse(input).root
  for(const part of input.slice(current.length).split(path.sep).filter(Boolean)){current=path.join(current,part);const stat=fs.lstatSync(current);if(stat.isSymbolicLink()||!stat.isDirectory())throw denied()}
  if(fs.realpathSync(input)!==input)throw denied()
  return input
}

/** bridge_root is the known OneBot/container path corresponding exactly to
 * cache_root. Both are host configuration, never values taken from a message. */
export function createQQBridgeCacheReader({cache_root,bridge_root=cache_root}={}){
  const root=physicalRoot(cache_root)
  if(typeof bridge_root!=='string'||!bridge_root.startsWith('/')||path.posix.normalize(bridge_root)!==bridge_root||bridge_root==='/'||/[\0\r\n\\]/.test(bridge_root))throw denied()
  const read=({bridge_file,kind,max_bytes}={})=>{
    if(kind!=='image'||typeof bridge_file!=='string'||!bridge_file.startsWith(bridge_root+'/')||path.posix.normalize(bridge_file)!==bridge_file||/[\0\r\n\\]/.test(bridge_file)||!Number.isSafeInteger(max_bytes)||max_bytes<1||max_bytes>64*1024*1024)throw denied()
    const parts=bridge_file.slice(bridge_root.length+1).split('/')
    if(!parts.length||parts.some(part=>!part||part==='.'||part==='..'||part.length>255))throw denied()
    const opened=[]
    try{
      physicalRoot(root)
      let file
      const target=path.join(root,...parts)
      if(process.platform==='darwin'){
        let directory=root
        for(const part of parts.slice(0,-1)){directory=path.join(directory,part);const stat=fs.lstatSync(directory);if(stat.isSymbolicLink()||!stat.isDirectory())throw denied()}
        file=fs.openSync(target,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW)
      }
      else if(process.platform==='linux'){
        // Linux permits openat-like descriptor-relative walking through proc.
        let directory=fs.openSync(root,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);opened.push(directory)
        for(const part of parts.slice(0,-1)){directory=fs.openSync('/proc/self/fd/'+directory+'/'+part,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);opened.push(directory)}
        file=fs.openSync('/proc/self/fd/'+directory+'/'+parts.at(-1),fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW)
      }else throw denied()
      opened.push(file)
      const before=fs.fstatSync(file,{bigint:true})
      if(!regular(before)||before.size<1n||before.size>BigInt(max_bytes))throw denied()
      if(process.platform==='darwin'){
        const actual=darwinDescriptorPath(file),current=fs.lstatSync(target,{bigint:true})
        if(actual!==target||fs.realpathSync(actual)!==target||!regular(current)||fingerprint(before)!==fingerprint(current))throw denied()
      }
      const bytes=Buffer.alloc(Number(before.size));let offset=0
      while(offset<bytes.length){const count=fs.readSync(file,bytes,offset,bytes.length-offset,offset);if(!count)throw denied();offset+=count}
      const after=fs.fstatSync(file,{bigint:true})
      if(!regular(after)||fingerprint(before)!==fingerprint(after)||BigInt(bytes.length)!==after.size)throw denied()
      return {bytes,source_kind:'onebot_image_cache'}
    }catch{throw denied()}finally{for(const descriptor of opened.reverse())try{fs.closeSync(descriptor)}catch{}}
  }
  Object.defineProperty(read,'cache_authority',{value:'explicit_physical_onebot_image_cache'})
  return read
}
