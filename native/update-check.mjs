import packageInfo from '../package.json' with {type:'json'}

export const COMPANION_REPOSITORY='https://github.com/goj177/dsh-companion-unified'
const endpoint='https://api.github.com/repos/goj177/dsh-companion-unified/releases/latest'
const failure=message=>Object.assign(new Error(message),{httpStatus:502})

function versionOf(input){
  if(typeof input!=='string'||input.length>160)return null
  const text=input.trim().replace(/^v/i,''),match=/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(text)
  if(!match)return null
  const pre=match[4]?.split('.')??[]
  if(pre.some(part=>/^\d+$/.test(part)&&part.length>1&&part[0]==='0'))return null
  return {text,parts:match.slice(1,4).map(BigInt),pre}
}
export function compareUpdateVersions(left,right){
  const a=versionOf(left),b=versionOf(right)
  if(!a||!b)throw failure('版本号无法识别，暂时无法判断是否有更新')
  for(let i=0;i<3;i++)if(a.parts[i]!==b.parts[i])return a.parts[i]>b.parts[i]?1:-1
  if(!a.pre.length||!b.pre.length)return a.pre.length===b.pre.length?0:a.pre.length?-1:1
  for(let i=0;i<Math.max(a.pre.length,b.pre.length);i++){
    const x=a.pre[i],y=b.pre[i];if(x===y)continue
    if(x===undefined||y===undefined)return x===undefined?-1:1
    const nx=/^\d+$/.test(x),ny=/^\d+$/.test(y)
    if(nx&&ny)return BigInt(x)>BigInt(y)?1:-1
    if(nx!==ny)return nx?-1:1
    return x>y?1:-1
  }
  return 0
}
async function releaseJson(response){
  const maximum=262144,reader=response.body?.getReader()
  if(!reader)throw failure('GitHub 返回的版本信息无法读取')
  const parts=[];let size=0
  try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>maximum)throw failure('GitHub 返回的版本信息过大');parts.push(value)}}
  catch(error){await reader.cancel().catch(()=>{});throw error}
  try{return JSON.parse(Buffer.concat(parts).toString('utf8'))}catch{throw failure('GitHub 返回的版本信息无法识别')}
}

/** Local owner action only; no background polling, model calls or installation. */
export class NativeUpdateChecker{
  constructor({fetcher=globalThis.fetch,now=Date.now,current_version=packageInfo.version,cache_ms=60000,timeout_ms=8000}={}){
    this.fetcher=fetcher;this.now=now;this.current_version=current_version;this.cache_ms=cache_ms;this.timeout_ms=timeout_ms;this.last=null;this.inflight=null
  }
  status(){return {current_version:this.current_version,repository_url:COMPANION_REPOSITORY,last_result:this.last?structuredClone(this.last):null}}
  async check(){
    if(this.last&&this.now()-this.last.checked_at>=0&&this.now()-this.last.checked_at<this.cache_ms)return {...structuredClone(this.last),cached:true}
    if(this.inflight)return this.inflight
    this.inflight=this._check().then(result=>{this.last=result;return structuredClone(result)}).finally(()=>{this.inflight=null})
    return this.inflight
  }
  async _check(){
    let response
    try{response=await this.fetcher(endpoint,{method:'GET',headers:{Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','User-Agent':'dsh-companion-unified'},credentials:'omit',redirect:'error',cache:'no-store',signal:AbortSignal.timeout(this.timeout_ms)})}
    catch{throw failure('暂时无法连接 GitHub，请稍后重试')}
    const base={current_version:this.current_version,repository_url:COMPANION_REPOSITORY,checked_at:this.now(),cached:false}
    if(response.status===404)return {...base,status:'unreleased',latest_version:null,release_url:COMPANION_REPOSITORY+'/releases',download_url:null}
    if(response.status===403||response.status===429)throw failure('GitHub 检查次数受限，请稍后重试')
    if(!response.ok)throw failure('GitHub 暂时无法提供版本信息，请稍后重试')
    let release
    try{release=await releaseJson(response)}catch(error){if(error.httpStatus)throw error;throw failure('GitHub 版本信息读取未完成，请稍后重试')}
    const latest=versionOf(release?.tag_name)
    if(!latest||release.draft!==false||release.prerelease!==false)throw failure('GitHub 最新正式版本信息无法识别')
    const relation=compareUpdateVersions(this.current_version,latest.text),tag=encodeURIComponent(release.tag_name),name='dsh-companion-unified-'+latest.text+'.tgz'
    const expected=COMPANION_REPOSITORY+'/releases/download/'+tag+'/'+encodeURIComponent(name)
    const asset=Array.isArray(release.assets)?release.assets.find(row=>row?.name===name&&row.state==='uploaded'&&row.browser_download_url===expected):null
    return {...base,status:relation<0?'available':relation===0?'current':'local_ahead',latest_version:latest.text,release_url:COMPANION_REPOSITORY+'/releases/tag/'+tag,download_url:relation<0&&asset?expected:null}
  }
}
