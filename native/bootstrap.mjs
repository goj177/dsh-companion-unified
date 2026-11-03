import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {createHash} from 'node:crypto'
import {NativeStore} from './store.mjs'
import {initNativeDefaults} from './defaults.mjs'
import {applyPendingRestore} from './portable.mjs'
import {assertNativeRuntimeQuiescent} from './resources.mjs'

const hash=value=>createHash('sha256').update(value).digest('hex')
export function nativePaths({data_home,dsh_home,runtime_root}={}){
  const dsh=path.resolve(dsh_home??process.env.DSH_HOME??path.join(os.homedir(),'.dsh'))
  const root=path.resolve(data_home??process.env.DSH_COMPANION_HOME??path.join(dsh,'companion'))
  const runtime=path.resolve(runtime_root??path.join(path.dirname(root),'companion-runtime'))
  if(root===runtime||root.startsWith(runtime+path.sep)||runtime.startsWith(root+path.sep))throw new Error('资料目录和运行环境必须独立')
  return {root,runtime,store_file:path.join(root,'companion.sqlite'),guard_file:path.join(runtime,'installation-'+hash(root)+'.json')}
}

/** Restore before any service opens SQLite; the runtime never probes old formats. */
export async function openNativeInstallation(options={}){
  const paths=nativePaths(options)
  await applyPendingRestore({store_file:paths.store_file,assert_quiescent:()=>assertNativeRuntimeQuiescent({data_root:paths.root,runtime_root:paths.runtime})})
  const exists=fs.existsSync(paths.store_file)
  let audit_only=process.env.DSH_COMPANION_AUDIT_ONLY==='1'
  if(fs.existsSync(paths.guard_file)){
    if(fs.lstatSync(paths.guard_file).isSymbolicLink())throw new Error('安装状态文件不能是链接')
    const guard=JSON.parse(fs.readFileSync(paths.guard_file,'utf8'))
    if(guard.schema_id!=='companion.installation_guard'||guard.schema_version!==1||guard.root_sha256!==hash(paths.root)||!['audit','active'].includes(guard.mode))throw new Error('安装状态无法确认；未启动渠道')
    if(!exists)throw new Error('已登记的原生安装资料尚未就位；未创建默认稿，请先完成切换或恢复备份。')
    audit_only ||= guard.mode==='audit'
  }
  if(!exists&&fs.existsSync(paths.root)&&fs.readdirSync(paths.root).length)throw new Error('此目录仍有待转换资料；请先完成离线原生迁移。没有创建新默认稿或读取旧插件。')
  const store=new NativeStore({file:paths.store_file,create:!exists})
  try{initNativeDefaults(store)
    return {...paths,store,audit_only}
  }catch(error){store.close();throw error}
}
