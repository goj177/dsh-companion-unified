import {nativeReadParameters,nativeReadDescription} from './read-contracts.mjs'
import {compactNativeReadParameters} from './tool-schema-projection.mjs'
import {isPlainObject} from './contracts.mjs'
import {TIEBA_REPLY_INTENTS,TIEBA_REPLY_INTENT_GUIDE} from './tieba-target.mjs'

const platforms=new Set(['qq','tieba','bilibili'])
const common='统一社交动作。明确执行用mode=go，dry只预览；unknown不重发，以confirmed回执确认。'
const descriptions={
  qq:'QQ发送kind=qq.send、target.conversation_id=group:群号或private:QQ号、body正文。当前会话最终文字自动投递时，不用发送工具重复同一段。禁言qq.mute、解禁qq.unmute用target={conversation_id:"group:群号",member_uid:"完整成员QQ",duration_seconds:秒数}，body空；唯一允许群可省略群号，优先companion_read moderation_target解析本轮真实管理员指令，返回目标和时长；唯一近似昵称可用，重名才确认。未写时长使用默认值，解禁0；不从引用借管理权限。qq.profile仅在原设置授权下修改资料。',
  tieba:'贴吧私信kind=tieba.message，target={recipient_uid:"完整UID",conversation_id:"dm:同一UID"}，先direct_contacts/direct_messages读取；只回当前私信。新主题kind=tieba.post，target={bar,title}；新主题通道未验证真实@，普通@昵称或自行写#(at,...)不算通知；任务必须真实@时，须由官方编辑器选中账号并回读UID，不能省略。自带表情用target.emotes=[名称]，收藏图用target.asset_ids=[asset_ref]；表情每条最多3个、收藏图最多1张；本轮已列出的可用候选可直接引用，其他表情先read emotes查名、其他收藏图先read images或expression list，可配正文、回帖或楼中楼单图，不写内部协议标记。kind=tieba.reply：评论主题、新开一楼用target={bar,thread_id}，不带post_id；回复具体楼层才带post_id，回复子评论再带sub_reply_id、reply_uid。从thread/sub_replies取得真实坐标，定位失败不改发新楼。主人明确在仍存在的父楼点名公开账号时，可带reply_profile_id=主页portrait，系统核验UID并生成引用，不伪造已删除子楼。签到tieba.sign、关注tieba.follow、取关tieba.unfollow仍受原平台权限限制。'+TIEBA_REPLY_INTENT_GUIDE,
  bilibili:'B站评论kind=bilibili.comment，target={object_id:"视频aid",object_type:"1"}；回复kind=bilibili.reply，target={object_id:"视频aid",object_type:"1",root_reply_id:"根评论ID",parent_reply_id:"被回复ID"}。ID均用完整字符串，object_type是数字字符串、不是video，坐标从真实读取取得。发动态kind=bilibili.dynamic，target={}，body完整正文；图片用已授权asset_ids。分享kind=bilibili.share，target={via:"qq",bvid,destination:"owner"|"group"|"both",score?,reason?}。私信回复用bilibili.reply、target.channel=dm，并保留真实recipient_uid、conversation_id；直播回复channel=live，保留room_id、reply_uid及存在的reply_dmid。点赞bilibili.like、投币bilibili.coin用真实bvid，仍受原平台权限限制。',
}
const incomingKinds={tieba:['tieba.reply','tieba.message'],bilibili:['bilibili.reply']}
function incomingActionKinds(profile,platform,available){
  if(!isPlainObject(profile)||Object.keys(profile).some(key=>key!=='action_kinds')||!Array.isArray(profile.action_kinds)||!profile.action_kinds.length||!incomingKinds[platform])return null
  const requested=profile.action_kinds
  if(new Set(requested).size!==requested.length||requested.some(kind=>typeof kind!=='string'||!incomingKinds[platform].includes(kind)||!available.includes(kind)))return null
  return available.filter(kind=>requested.includes(kind))
}
function incomingActionDescription(platform,kinds){
  const finish='mode=go执行，dry只预览；unknown不重发，confirmed回执才算确认。'
  if(platform==='bilibili')return '本轮仅bilibili.reply，回复已核验原对象和原位置。评论target照抄object_id/object_type/root_reply_id/parent_reply_id，ID用字符串、object_type是数字字符串而非video；dm保留channel/recipient_uid/conversation_id，live保留channel/room_id/reply_uid及已有reply_dmid。'+finish
  return '本轮只回应原对象和原位置。'+(kinds.includes('tieba.reply')?'tieba.reply：target照抄bar/thread_id/post_id及存在的sub_reply_id/reply_uid，不改发新楼；表情填target.emotes，收藏图片填target.asset_ids；表情每条最多3个、收藏图最多1张；已列出的可用候选直接引用，其他候选再查emotes/images。'+TIEBA_REPLY_INTENT_GUIDE:'')+(kinds.includes('tieba.message')?'tieba.message：target照抄recipient_uid/conversation_id=dm:同一UID，只回原私信，不公开发帖或联系其他人。':'')+finish
}

/** Presentation only: executors, guards, limits and receipts remain unchanged. */
export function scopeNativeToolDefinitions(tools,platform,profile){
  tools=tools.filter(tool=>tool.name!=='companion_people_summary'||isPlainObject(profile)&&profile.people_maintenance===true)
  if(!platforms.has(platform))return tools
  return tools.filter(tool=>!(platform!=='qq'&&tool.name.startsWith('qq_'))&&!(platform!=='bilibili'&&tool.name==='companion_sharing')&&!(platform!=='tieba'&&tool.name==='companion_participation')).map(tool=>{
    if(tool.name==='companion_read')return {...tool,description:nativeReadDescription(platform),parameters:compactNativeReadParameters(nativeReadParameters(platform))}
    if(tool.name==='companion_persona')return {...tool,parameters:{...tool.parameters,properties:{platform:{type:'string',enum:[platform]}}}}
    if(tool.name!=='companion_action'||!Array.isArray(tool.parameters?.properties?.kind?.enum))return tool
    const available=tool.parameters.properties.kind.enum.filter(kind=>kind.startsWith(platform+'.')),incoming=incomingActionKinds(profile,platform,available)
    const kinds=incoming??available,target=platform==='tieba'&&kinds.includes('tieba.reply')?{...tool.parameters.properties.target,type:'object',properties:{...tool.parameters.properties.target?.properties,intent:{type:'string',enum:[...TIEBA_REPLY_INTENTS],description:'仅tieba.reply可选，填写在target内部；例如target:{bar,thread_id,intent:"chat"}。不可放companion_action顶层。'}}}:tool.parameters.properties.target
    return {...tool,description:incoming?incomingActionDescription(platform,incoming):common+descriptions[platform],parameters:{...tool.parameters,properties:{...tool.parameters.properties,kind:{...tool.parameters.properties.kind,enum:kinds},...(target?{target}:{})}}}
  })
}
