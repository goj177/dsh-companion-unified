/** Render canonical persona_reference data only. No migration, files, store or legacy schema dependencies. */
export function renderPersonaReference(entry,profile,{max_chars=360,allow_candidate=false}={}){
  if(!entry||!profile||!Number.isSafeInteger(max_chars)||max_chars<1||max_chars>6400||entry.usage!=='style_reference_only'||entry.profile_id!==profile.id||entry.platform!==profile.platform
    ||typeof profile.name!=='string'||!Array.isArray(entry.segments)||!['active',...(allow_candidate?['candidate']:[])].includes(entry.status))return ''
  let body=''
  for(const segment of entry.segments){if(segment?.type==='self_name'&&Object.keys(segment).length===1){if(!profile.name)return '';body+=profile.name}else if(segment?.type==='text'&&typeof segment.text==='string'&&Object.keys(segment).every(key=>['type','text'].includes(key)))body+=segment.text;else return ''}
  if(!body.trim())return ''
  const label=entry.claim_type==='fictional_example'?'虚构语气例句，不作本人经历':entry.claim_type==='historical_observation'?'历史观察，尚未核验':entry.kind==='scene_tactic'?'场景表达参考':'表达习惯参考'
  const result=label+'：'+JSON.stringify(body)
  return result.length<=max_chars?result:''
}
