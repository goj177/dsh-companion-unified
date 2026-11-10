import './host-peers.mjs'
import {openNativeInstallation} from './native/bootstrap.mjs'
import {createNativeCore} from './native/core.mjs'

export const name='companion-unified'
// The official headless bundle has no preset/workspace registry or web UI.
// Core accesses those optional ports only when their capability is present.
export const inject=['systemPrompt','tools','agents','sessions','agentDefaultModel','sessionPersistence','attachments','llm']

/** One native lifecycle, one store, one client and one set of platform exits. */
export async function apply(ctx,config={}){
  if(!config||typeof config!=='object'||Array.isArray(config)||Object.keys(config).some(key=>key!=='auditOnly')||config.auditOnly!==undefined&&typeof config.auditOnly!=='boolean')throw new Error('欧鲸鲸实例配置字段无效')
  const installation=await openNativeInstallation()
  let core
  try{
    core=createNativeCore(ctx,{store:installation.store,runtime_root:installation.runtime,audit_only:installation.audit_only||config.auditOnly===true})
    await core.start()
  }catch(error){await core?.close();installation.store.close();throw error}
  let closing
  const close=()=>closing??=(async()=>{await core.close();installation.store.close()})()
  // Cordis collects the disposer returned by async apply; a plain object is
  // an invalid effect and causes the official loader to roll this plugin back.
  return close
}
