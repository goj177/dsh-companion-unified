import {createCipheriv,createDecipheriv,randomBytes} from 'node:crypto'
import {redactText} from './memory-rules.mjs'

const base64=/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
const utf8=new TextDecoder('utf-8',{fatal:true})

export function encodeTiebaPublicText(text){
  const key=randomBytes(32),nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,nonce)
  const ciphertext=Buffer.concat([cipher.update(text,'utf8'),cipher.final()])
  return Buffer.from(JSON.stringify({alg:'AES-256-GCM',key:key.toString('base64'),nonce:nonce.toString('base64'),tag:cipher.getAuthTag().toString('base64'),ciphertext:ciphertext.toString('base64')})).toString('base64')
}

export function tiebaThreadUsesEncryptedReplies(store,threadId){
  if(!/^[1-9]\d*$/.test(threadId??''))return false
  return !!store.db.prepare(`SELECT 1 FROM actions
    WHERE platform='tieba' AND kind='tieba.post' AND status='confirmed'
    AND json_extract(target_json,'$.encrypt_replies')=1 AND json_extract(receipt_json,'$.thread_id')=?
    AND json_extract(receipt_json,'$.source')='server_receipt' AND json_extract(receipt_json,'$.accepted')=1 LIMIT 1`).get(threadId)
}

function decodeBase64(value){
  if(typeof value!=='string'||!value||!base64.test(value))return null
  const bytes=Buffer.from(value,'base64')
  return bytes.toString('base64')===value?bytes:null
}

/** Recognize the self-contained packet used in public Tieba discussions. */
export function decodeTiebaPublicText(value,{redact=true}={}){
  if(typeof value!=='string'||value.length>16000)return null
  const encoded=value.trim().replace(/^回复\s+[^:：\r\n]{1,80}[:：][\t ]*/u,'')
  if(!encoded.startsWith('eyJ'))return null
  try{
    const outer=decodeBase64(encoded)
    if(!outer)return null
    const packet=JSON.parse(utf8.decode(outer))
    if(packet?.alg!=='AES-256-GCM'||Object.keys(packet).length!==5)return null
    const key=decodeBase64(packet.key),nonce=decodeBase64(packet.nonce),tag=decodeBase64(packet.tag),ciphertext=decodeBase64(packet.ciphertext)
    if(key?.length!==32||nonce?.length!==12||tag?.length!==16||!ciphertext)return null
    const decipher=createDecipheriv('aes-256-gcm',key,nonce,{authTagLength:16})
    decipher.setAuthTag(tag)
    const plaintext=utf8.decode(Buffer.concat([decipher.update(ciphertext),decipher.final()]))
    if(!plaintext.trim()||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(plaintext))return null
    return redact?redactText(plaintext):plaintext
  }catch{return null}
}
