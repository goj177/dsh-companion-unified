/** Check whether the selected DSH model can consume the verified attachment. */
import {createHash} from 'node:crypto'
import {NativeStore} from './store.mjs'
import {isPlainObject} from './contracts.mjs'
import {assertRunActive,currentRunScope} from './run-scope.mjs'

const hash=value=>createHash('sha256').update(value).digest('hex')
const TYPES=new Set(['image/png','image/jpeg','image/gif','image/webp'])
const unavailable=reason=>({unavailable:reason})

export class NativeImageDescription{
  constructor({store,llm,selected}={}){
    if(!(store instanceof NativeStore))throw new Error('图片读取需要原生资料库')
    this.store=store;this.llm=llm;this.selected=selected
  }
  async describe({session_id,asset_ref,bytes,media_type,signal}={}){
    const scope=currentRunScope(),check=()=>{assertRunActive(scope);signal?.throwIfAborted()};check()
    if(typeof session_id!=='string'||!session_id||session_id.length>240||/[\0\r\n]/.test(session_id)||!/^asset:[a-f0-9]{64}$/.test(asset_ref??'')||!(bytes instanceof Uint8Array)||!bytes.length||bytes.length>8*1024*1024||!TYPES.has(media_type)||hash(bytes)!==asset_ref.slice(6))throw new Error('图片描述只接受当前已授权素材的真实图片字节')
    if(this.store.readOnly||typeof this.selected!=='function'||typeof this.llm?.prepareCall!=='function')return unavailable('vision_unavailable')
    let selection,primary
    try{selection=await this.selected(session_id);if(!isPlainObject(selection)||typeof selection.provider!=='string'||typeof selection.model!=='string')return unavailable('model_unavailable');primary=await this.llm.prepareCall({provider:selection.provider,model:selection.model},signal??scope?.signal)}catch(error){check();return unavailable('model_capability_unavailable')}
    check()
    if(primary?.inputModalities?.includes('image'))return {native_image:true,provider:selection.provider,model:selection.model}
    return unavailable('当前 DSH 模型不支持图像输入')
  }
}
