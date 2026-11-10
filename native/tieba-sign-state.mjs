import {isPlainObject} from './contracts.mjs'
import {shanghaiTime} from '../policy.mjs'

const at=value=>Number.isSafeInteger(value)&&value>=0
const uid=value=>typeof value==='string'&&/^[1-9]\d{0,159}$/.test(value)

/** Sign-in changes an account state. Its proof is a fresh official signed
 * observation bound to this action, not a publication ID or an acceptance code. */
export function validateTiebaSignStateProof(action,proof,{now=Date.now()}={}){
  const keys=['source','schema_id','schema_version','operation','request_digest','bar','forum_id','account_uid','signed','day','observed_at','write_attempted']
  if(!isPlainObject(proof)||Object.keys(proof).some(key=>!keys.includes(key))||action.platform!=='tieba'||action.kind!=='tieba.sign'||proof.source!=='server_state_read'||proof.schema_id!=='companion.tieba_sign_state'||proof.schema_version!==1||proof.operation!=='tieba.sign'||proof.request_digest!==action.request_digest||typeof action.target?.bar!=='string'||proof.bar!==action.target.bar.trim()||!uid(proof.forum_id)||!uid(proof.account_uid)||proof.signed!==true||proof.write_attempted!==(action.metadata?.network_started===true))throw new Error('签到状态回执与原生动作或账号状态不一致')
  const earliest=action.metadata?.network_started===true?action.metadata.attempted_at:action.created_at
  if(!at(earliest)||!at(proof.observed_at)||!at(now)||proof.observed_at<earliest||proof.observed_at>now||now-proof.observed_at>30000||proof.day!==shanghaiTime(proof.observed_at).date||proof.day!==shanghaiTime(now).date)throw new Error('签到状态回执缺少本日新鲜观测')
  return true
}
