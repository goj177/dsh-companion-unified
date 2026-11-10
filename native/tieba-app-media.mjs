/** Pure App AddPost encoder, adapted from the bundled dsh-tieba-scroll MIT
 * protocol implementation (attribution in tieba-http.mjs). No legacy I/O.
 * Field contract: clb-128258/tbclient.protobuf/proto/AddPost/DataReq.proto.
 * Only an already-rendered, authorized new draft reaches this encoder; it does
 * not acquire credentials, submit, solve a challenge or choose a fallback. */
import {isPlainObject} from './contracts.mjs'
import {TiebaError,tiebaId,pbInt,pbBytes,pbString} from './tieba-http.mjs'

const fields=['thread_id','forum_id','bar','content','tbs','bduss','post_id','sub_reply_id','reply_uid','name_show','parent_floor']
const text=(value,max,{empty=false}={})=>{if(typeof value!=='string'||!value.isWellFormed()||value.length>max||!empty&&!value||/\0/.test(value))throw new TiebaError('原生表情回帖编码参数无效','invalid_input');return value}
export function encodeTiebaAppMediaReply(input){
 if(!isPlainObject(input)||Object.keys(input).some(key=>!fields.includes(key)))throw new TiebaError('原生表情回帖包含未知编码字段','invalid_input')
 const thread_id=tiebaId(input.thread_id),forum_id=tiebaId(input.forum_id),bar=text(input.bar,160),content=text(input.content,64000),tbs=text(input.tbs,65536),bduss=text(input.bduss,65536),name_show=text(input.name_show??'',160,{empty:true}),post_id=input.post_id?tiebaId(input.post_id):'',sub_reply_id=input.sub_reply_id?tiebaId(input.sub_reply_id):'',reply_uid=input.reply_uid?tiebaId(input.reply_uid):'',floor=input.parent_floor??0
 if(!Number.isSafeInteger(floor)||floor<0||!post_id&&(sub_reply_id||reply_uid||floor)||post_id&&!reply_uid||sub_reply_id&&sub_reply_id===post_id||/[\r\n]/.test(bar+tbs+bduss+name_show))throw new TiebaError('原生表情回帖的父楼、子楼或作者关系无效','invalid_input')
 const common=Buffer.concat([pbInt(1,2),pbString(2,'22.12.1.0'),pbString(10,bduss),pbString(11,tbs)]),data=Buffer.concat([
  pbBytes(1,common),pbString(4,tbs),pbString(19,content),pbString(26,forum_id),pbString(30,bar),pbString(45,thread_id),
  ...(post_id?[pbString(46,post_id),pbString(49,post_id)]:[]),...(sub_reply_id?[pbString(50,sub_reply_id)]:[]),...(reply_uid?[pbString(20,reply_uid)]:[]),
  pbString(48,String(floor)),pbString(6,'1'),pbString(18,'1'),pbString(16,'12'),...(!post_id?[pbString(55,'13')]:[]),...(name_show?[pbString(58,name_show)]:[]),
 ])
 return pbBytes(1,data)
}
