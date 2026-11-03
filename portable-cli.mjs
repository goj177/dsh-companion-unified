#!/usr/bin/env node
import path from 'node:path'
import {pathToFileURL} from 'node:url'
import {openNativeInstallation} from './native/bootstrap.mjs'
import {NativePortable} from './native/portable.mjs'
import {NativeResources} from './native/resources.mjs'
import {NativeDiary} from './native/diary.mjs'
import {NATIVE_TABLES} from './native/store.mjs'

const HELP=`欧鲸鲸原生资料工具
  dsh-companion status
  dsh-companion export [--output /绝对路径/companion.zip] [--include-credentials]
  dsh-companion import --file /绝对路径/companion.zip --confirm
  dsh-companion apply-restore
  可选：--data-home /绝对资料目录 --dsh-home /绝对Harness目录

导出默认不含登录状态。导入先校验并备份，完整退出 Harness 后重新打开完成恢复。
资料包含私人记忆及日记，请仅供自己搬家。`
const COMMON=['data-home','dsh-home'],VALUES=['data-home','dsh-home','output','file']
const COMMANDS={status:COMMON,export:[...COMMON,'output','include-credentials'],import:[...COMMON,'file','confirm'],'apply-restore':COMMON}
export async function runPortableCli(args){
  if(!args.length||['help','--help'].includes(args[0]))return {help:HELP}
  const [command,...rest]=args,allowed=COMMANDS[command],flags={}
  if(!allowed)throw new Error('未知命令；请运行 dsh-companion --help')
  for(let i=0;i<rest.length;i++){
    const name=rest[i].replace(/^--/,'');if(rest[i]!=='--'+name||!allowed.includes(name)||Object.hasOwn(flags,name))throw new Error('参数无效或重复')
    if(VALUES.includes(name)){const value=rest[++i];if(!value||!path.isAbsolute(value)||value!==path.resolve(value))throw new Error('路径须为规范绝对路径');flags[name]=value}else flags[name]=true
  }
  if(command==='import'&&(!flags.file||!flags.confirm))throw new Error('请选择 --file 并用 --confirm 确认恢复')
  const options={...(flags['data-home']?{data_home:flags['data-home']}:{ }),...(flags['dsh-home']?{dsh_home:flags['dsh-home']}:{ })}
  const installation=await openNativeInstallation(options),{store}=installation
  try{
    const resources=new NativeResources({store,runtime_root:installation.runtime}),portable=new NativePortable({store,assert_quiescent:()=>resources.assertQuiescent()})
    if(command==='export')return {ok:true,...await portable.exportBundle({include_credentials:!!flags['include-credentials'],...(flags.output?{output_path:flags.output}:{})})}
    if(command==='import')return {ok:true,...await portable.importBundle({bundle_path:flags.file,confirmed:true})}
    return {ok:true,native:true,schema_version:3,audit_only:installation.audit_only,tables:Object.fromEntries(NATIVE_TABLES.map(name=>[name,store.db.prepare('SELECT COUNT(*) n FROM '+name).get().n])),diaries:new NativeDiary({store}).status({platform:'harness',owner_authorized:true}).counts,
      bilibili_follow_main:store.getPersonaProfile('persona-bilibili')?.follow_main,restored_before_open:true}
  }finally{store.close()}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  try{const result=await runPortableCli(process.argv.slice(2));process.stdout.write(result.help??JSON.stringify(result,null,2)+'\n')}
  catch(error){process.stderr.write('欧鲸鲸：'+error.message+'\n');process.exitCode=1}
}
