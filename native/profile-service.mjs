import { isDeepStrictEqual } from 'node:util'
import { NativeStore } from './store.mjs'
import { isPlainObject, stringifyJson } from './contracts.mjs'

const PLATFORMS = new Set(['main', 'qq', 'tieba', 'bilibili'])
const CONTENT = ['follow_main', 'main_profile_id', 'name', 'self_ref', 'owner_address', 'body_md', 'traits', 'voice']
const editable = new Set([...CONTENT, 'expected_revision', 'reason'])
const copy = value => JSON.parse(stringifyJson(value))
const pick = row => Object.fromEntries(CONTENT.map(key => [key, key === 'main_profile_id' ? row[key] ?? null : row[key]]))

function platformName(value) {
  if (!PLATFORMS.has(value)) throw new Error('请选择主稿、QQ、贴吧或B站人设')
  return value
}

function owner(context) {
  if (context?.owner_authorized !== true) throw new Error('人设修改需要主人授权的设置会话')
}

function fields(value, allowed) {
  if (!isPlainObject(value) || Object.keys(value).some(key => !allowed.has(key))) throw new Error('人设修改包含不支持的字段')
}

function revision(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('请提供人设的expected_revision')
}

function reasonText(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 4000 || value.includes('\0') || !value.isWellFormed()) throw new Error('请填写有效的人设修改原因')
  return value
}

/** One native profile row decides each platform. No implicit master seed. */
export class NativeProfileService {
  constructor({ store }) {
    if (!(store instanceof NativeStore)) throw new Error('人设服务需要NativeStore')
    this.store = store
  }

  _own(platform) {
    platformName(platform)
    const profile = this.store.listPersonaProfiles().find(row => row.platform === platform)
    if (!profile) throw new Error((platform === 'bilibili' ? 'B站' : platform) + '独立人设尚未配置，请先在设置中补全')
    return profile
  }

  resolve(platform = 'main') {
    // Both reads use one snapshot if another process edits the main profile.
    return this.store.transaction(() => {
      const own = this._own(platform)
      const effective = own.follow_main ? this.store.getPersonaProfile(own.main_profile_id) : own
      if (!effective || own.follow_main && effective.platform !== 'main') throw new Error('跟随的主人设不存在，请检查人设设置')
      return { requested_platform: platform, profile_id: own.id, effective_profile_id: effective.id,
        follow_main: own.follow_main, revision: own.revision, effective_revision: effective.revision,
        name: effective.name, self_ref: effective.self_ref, owner_address: effective.owner_address,
        traits: copy(effective.traits), voice: copy(effective.voice), body_md: effective.body_md }
    })
  }

  ownProfile(platform = 'main') { return copy(this._own(platform)) }

  render(platform = 'main') {
    const profile = this.resolve(platform)
    const label = { main: '主对话', qq: 'QQ', tieba: '贴吧', bilibili: 'B站' }[platform]
    const voice = profile.voice, lines = [
      `【当前有效人设：${label}】`,
      `名字：${profile.name}；自称：${profile.self_ref}；主人称呼：${profile.owner_address}。`,
    ]
    if (Object.keys(profile.traits).length) lines.push('性格参数：' + stringifyJson(profile.traits))
    const lists = [['samples', '参考句'], ['quirks', '习惯'], ['particles', '语气词'], ['patterns', '说话方式']]
    for (const [key, title] of lists) if (voice[key]?.length) lines.push(`${title}：${voice[key].join('；')}`)
    if (voice.sentence_len || voice.punctuation) lines.push([
      voice.sentence_len && '句子长度：' + { short: '短句', medium: '中等', long: '长句' }[voice.sentence_len],
      voice.punctuation && '标点：' + { light: '少量', normal: '正常' }[voice.punctuation],
    ].filter(Boolean).join('；'))
    if (profile.body_md) lines.push(profile.body_md)
    return lines.join('\n')
  }

  save(platform, patch, trustedContext) {
    platformName(platform); owner(trustedContext); fields(patch, editable); revision(patch.expected_revision)
    const reason = reasonText(patch.reason)
    return this.store.transaction(() => {
      const old = this.store.listPersonaProfiles().find(row => row.platform === platform)
      if (patch.expected_revision !== (old?.revision || 0)) throw new Error('人设版本冲突，请刷新后再保存')
      if (!old && CONTENT.filter(key => key !== 'main_profile_id').some(key => !Object.hasOwn(patch, key))) throw new Error('首次保存需要完整的当前平台独立稿')
      const next = { ...(old ? pick(old) : { main_profile_id: null }),
        ...Object.fromEntries(Object.entries(patch).filter(([key]) => CONTENT.includes(key))) }
      // Disabling following retains the unused draft and explicit target for a
      // later user toggle. It never copies the effective main profile over it.
      if (old && isDeepStrictEqual(pick(old), next)) return { changed: false, profile: copy(old), version: null }
      const profile = this.store.putPersonaProfile({ id: old?.id || 'persona-' + platform,
        platform, ...next, expected_revision: patch.expected_revision })
      const previous = this.store.listPersonaVersions(profile.id, { limit: 1 })[0]
      const version = this.store.putPersonaVersion({ profile_id: profile.id, version: (previous?.version || 0) + 1,
        ...pick(profile), reason, status: 'archived' })
      return { changed: true, profile: copy(profile), version: copy(version) }
    })
  }

  restoreBehavior(platform, input, trustedContext) {
    platformName(platform); owner(trustedContext)
    fields(input, new Set(['version_id', 'expected_revision', 'reason']))
    revision(input.expected_revision); reasonText(input.reason)
    return this.store.transaction(() => {
      const profile = this._own(platform), snapshot = this.store.getPersonaVersion(input.version_id)
      if (!snapshot || snapshot.profile_id !== profile.id) throw new Error('请选择当前平台的人设版本')
      // A behavior rollback cannot silently roll back today's name or follow
      // choice. These remain explicit fields in the ordinary settings save.
      return this.save(platform, { expected_revision: input.expected_revision, reason: input.reason,
        body_md: snapshot.body_md, traits: snapshot.traits, voice: snapshot.voice }, trustedContext)
    })
  }
}
