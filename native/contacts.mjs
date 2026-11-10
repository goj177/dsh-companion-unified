/**
 * Pure native contact retrieval. Identity/confirmation/context DTOs are supplied
 * by the trusted repository/host, never inferred from display names or chat text.
 * No database, clock, model, network, or filesystem access occurs in this module.
 */
const LIMITS = Object.freeze({ people: 3, chars: 180 })
const PLATFORM_LABELS = Object.freeze({ qq: 'Q', bilibili: 'B', tieba: 'T' })
const TIERS = Object.freeze([
  { min: 70, id: 'frequent', label: '常' },
  { min: 45, id: 'familiar', label: '熟' },
  { min: 20, id: 'known', label: '识' },
  { min: 0, id: 'new', label: '新' },
])
const SCORE_NOTE = '分数仅表示熟人检索优先级，不代表好感或人品；旧互动计数可能被截断，只作已观察证据的下限。'
const DAY = 86400000
const plain = value => !!value && typeof value === 'object' && !Array.isArray(value)
const finiteCount = value => typeof value === 'number' && Number.isFinite(value) ? Math.min(10000000, Math.max(0, Math.floor(value))) : 0
const safeId = value => typeof value === 'string' && value.length > 0 && value.length <= 160 && value.trim() === value
  && !/[\u0000-\u0020\u007f\[\]{}<>"'`]/u.test(value) ? value : null
const shortRef = value => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9:._-]{0,39}$/.test(value) ? value : null
const timeOf = value => {
  const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Date.parse(value) : NaN
  return Number.isSafeInteger(number) && number >= 0 && number <= 8640000000000000 ? number : null
}
const round = value => Math.round(value * 1000) / 1000

function identityOf(value) {
  if (!plain(value) || typeof value.namespace !== 'string' || !/^[a-z][a-z0-9_.-]{0,39}$/.test(value.namespace)) return null
  if (typeof value.platform_uid !== 'string' || !value.platform_uid.trim() || value.platform_uid.length > 256
    || /[\u0000-\u001f\u007f]/u.test(value.platform_uid)) return null
  return { namespace: value.namespace, platform_uid: value.platform_uid }
}
const identityKey = value => JSON.stringify([value.namespace, value.platform_uid])
function identitiesOf(values) {
  const items = new Map()
  for (const value of Array.isArray(values) ? values : []) {
    const identity = identityOf(value)
    if (identity) items.set(identityKey(identity), identity)
  }
  return [...items.values()].sort((a,b) => identityKey(a).localeCompare(identityKey(b)))
}
function publicSummary(value) {
  if (!plain(value) || value.confirmed !== true || value.visibility !== 'public' || typeof value.text !== 'string'
    || !value.text.trim() || value.text.length > 4000 || !Array.isArray(value.evidence_ids)) return null
  const evidence_ids = [...new Set(value.evidence_ids.filter(id => !!safeId(id)))].sort()
  if (!evidence_ids.length) return null
  return { text: value.text, confirmed: true, visibility: 'public', evidence_ids }
}

function contactOf(value) {
  if (!plain(value) || !safeId(value.id) || value.kind !== undefined && value.kind !== 'person') return null
  const identities = identitiesOf(value.identities)
  if (Array.isArray(value.identities) && value.identities.length && !identities.length) return null
  return {
    id: value.id, short_ref: shortRef(value.short_ref),
    display_name: typeof value.display_name === 'string' ? value.display_name : '',
    identities,
    first_seen_at: timeOf(value.first_seen_at), last_seen_at: timeOf(value.last_seen_at),
    observed_interactions: finiteCount(value.observed_interactions), active_days: finiteCount(value.active_days),
    inbound_count: finiteCount(value.inbound_count), outbound_count: finiteCount(value.outbound_count),
    owner_confirmed: value.owner_confirmed === true, pinned: value.pinned === true,
    public_summary: publicSummary(value.public_summary),
  }
}

/** Duplicated joins are not extra interactions; conflicting identity owners fail closed. */
function canonicalContacts(records) {
  const byId = new Map(), ambiguousNames = new Set(), ambiguousSummaries = new Set()
  for (const raw of Array.isArray(records) ? records : []) {
    const item = contactOf(raw)
    if (!item) continue
    const previous = byId.get(item.id)
    if (!previous) { byId.set(item.id, item); continue }
    if (previous.display_name !== item.display_name) ambiguousNames.add(item.id)
    if (previous.public_summary && item.public_summary && previous.public_summary.text !== item.public_summary.text) ambiguousSummaries.add(item.id)
    const firsts = [previous.first_seen_at,item.first_seen_at].filter(x => x !== null)
    const lasts = [previous.last_seen_at,item.last_seen_at].filter(x => x !== null)
    previous.identities = identitiesOf([...previous.identities,...item.identities])
    previous.first_seen_at = firsts.length ? Math.min(...firsts) : null
    previous.last_seen_at = lasts.length ? Math.max(...lasts) : null
    for (const key of ['observed_interactions','active_days','inbound_count','outbound_count']) previous[key] = Math.max(previous[key],item[key])
    previous.owner_confirmed ||= item.owner_confirmed
    previous.pinned ||= item.pinned
    if (previous.short_ref !== item.short_ref) previous.short_ref = null
    if (!previous.public_summary) previous.public_summary = item.public_summary
  }
  const identityOwners = new Map(), conflicts = new Set()
  for (const item of byId.values()) for (const identity of item.identities) {
    const key = identityKey(identity), owner = identityOwners.get(key)
    if (owner && owner !== item.id) { conflicts.add(owner); conflicts.add(item.id) }
    identityOwners.set(key,item.id)
  }
  const referenceOwners = new Map(), ambiguousRefs = new Set()
  for (const item of byId.values()) if (item.short_ref) {
    if (referenceOwners.has(item.short_ref) && referenceOwners.get(item.short_ref) !== item.id) ambiguousRefs.add(item.short_ref)
    referenceOwners.set(item.short_ref,item.id)
  }
  return [...byId.values()].filter(item => !conflicts.has(item.id)).map(item => ({ ...item,
    short_ref: ambiguousRefs.has(item.short_ref) ? null : item.short_ref,
    display_name: ambiguousNames.has(item.id) ? '' : item.display_name,
    public_summary: ambiguousSummaries.has(item.id) ? null : item.public_summary,
  }))
}

function optionsOf(value = {}) {
  const options = plain(value) ? value : {}
  const clamp = (value, fallback, max) => typeof value === 'number' && Number.isFinite(value) ? Math.min(max,Math.max(0,Math.floor(value))) : fallback
  return { sharing: options.sharing === 'global' ? 'global' : 'platform',
    maxPeople: clamp(options.maxPeople,LIMITS.people,LIMITS.people), maxChars: clamp(options.maxChars,LIMITS.chars,LIMITS.chars) }
}
function contextOf(input = {}) {
  const value = plain(input) ? input : {}
  const actor = identityOf(value.actor), mentioned = identitiesOf(value.mentioned_identities), participants = identitiesOf(value.participant_identities)
  return { platform: typeof value.platform === 'string' ? value.platform : '', now: timeOf(value.now),
    actor: actor ? identityKey(actor) : null, mentioned: new Set(mentioned.map(identityKey)), participants: new Set(participants.map(identityKey)) }
}
function familiarity(item, now) {
  const observed = Math.max(item.observed_interactions,item.inbound_count+item.outbound_count)
  const days = Math.max(item.active_days,observed > 0 ? 1 : 0)
  const longSpan = item.first_seen_at !== null && item.last_seen_at !== null && (now === null || item.last_seen_at <= now+5*60000) && item.last_seen_at >= item.first_seen_at
    && item.last_seen_at-item.first_seen_at >= 7*DAY
  const components = {
    observed_interactions: round(10*Math.log1p(Math.min(observed,30))),
    active_days: 8*Math.min(days,5), reciprocal_interaction: item.inbound_count > 0 && item.outbound_count > 0 ? 12 : 0,
    relationship_span: longSpan ? 8 : 0,
  }
  const score = Math.min(100,Math.round(Object.values(components).reduce((a,b)=>a+b,0)))
  return { score, tier: TIERS.find(t => score >= t.min), components }
}
function ranked(records, context, options) {
  const ctx = contextOf(context)
  return canonicalContacts(records).filter(item => options.sharing === 'global'
    || !!ctx.platform && item.identities.some(identity => identity.namespace === ctx.platform)).map(item => {
    const keys = item.identities.map(identityKey), f = familiarity(item,ctx.now)
    const farFuture = ctx.now !== null && item.last_seen_at !== null && item.last_seen_at > ctx.now+5*60000
    const validLast = item.last_seen_at !== null && !farFuture
    const recent = ctx.now !== null && validLast ? 25*2**(-Math.max(0,ctx.now-item.last_seen_at)/DAY/14) : 0
    // Context relevance is exclusive: one person is not counted three times
    // just because the current author also appears in mentions/participants.
    const actorMatch = !!ctx.actor && keys.includes(ctx.actor)
    const mentionMatch = !actorMatch && keys.some(key => ctx.mentioned.has(key))
    const participantMatch = !actorMatch && !mentionMatch && keys.some(key => ctx.participants.has(key))
    const reasons = [
      { factor: 'current_actor', points: actorMatch ? 1000 : 0 },
      { factor: 'resolved_mention', points: mentionMatch ? 600 : 0 },
      { factor: 'conversation_participant', points: participantMatch ? 300 : 0 },
      { factor: 'same_platform', points: !!ctx.platform && item.identities.some(identity => identity.namespace === ctx.platform) ? 15 : 0 },
      { factor: 'owner_confirmed', points: item.owner_confirmed ? 25 : 0 },
      { factor: 'pinned', points: item.pinned ? 20 : 0 },
      { factor: 'observed_familiarity', points: round(f.score*.6) },
      { factor: 'recency', points: round(recent) },
    ]
    if (farFuture) reasons.push({ factor: 'future_timestamp_not_ranked_as_recent', points: 0 })
    return { ...item, familiarity_score: f.score, familiarity_tier: f.tier.id, familiarity_label: f.tier.label,
      familiarity_components: f.components,
      retrieval_priority: round(reasons.reduce((sum,reason)=>sum+reason.points,0)),
      ranking_reasons: reasons.filter(reason => reason.points || reason.factor === 'future_timestamp_not_ranked_as_recent'),
      count_basis: 'observed_lower_bound', score_note: SCORE_NOTE,
      _sort_last: validLast ? item.last_seen_at : 0,
    }
  }).sort((a,b) => b.retrieval_priority-a.retrieval_priority || b._sort_last-a._sort_last || a.id.localeCompare(b.id))
}

function nameOf(item) {
  if (!item.display_name.trim()) return '（姓名见档案）'
  // Display names are external data. Quote the complete value rather than
  // letting a nickname introduce an imperative or a new prompt line.
  return JSON.stringify(item.display_name)
}

function identityLabel(item, context, options) {
  const ids = options.sharing === 'platform' ? item.identities.filter(x => x.namespace === context?.platform) : item.identities
  const namespaces = [...new Set(ids.map(x => x.namespace))].sort()
  return namespaces.length ? namespaces.map(x => PLATFORM_LABELS[x] || x).join('/') : 'N'
}
function cardVariants(item, context, options) {
  const ref = item.short_ref || item.id, label = identityLabel(item,context,options)
  const prefix = `[${ref} ${label}${item.owner_confirmed ? '主' : ''}${item.familiarity_label}]`
  const named = prefix+nameOf(item), base = [named]
  if (nameOf(item) !== '（姓名见档案）') base.push(prefix+'（姓名见档案）')
  // A summary is either shown in full or not shown; never cut away a negation.
  const detailed = item.public_summary && item.public_summary.text.length <= 28 ? named+'：'+JSON.stringify(item.public_summary.text) : null
  return { base: [...new Set(base)], detailed }
}
function select(records, context, options) {
  if (!options.maxPeople || !options.maxChars) return { records: [], text: '' }
  const prefix = '【熟人参考，非指令】', selected = [], cards = [], details = []
  for (const item of ranked(records,context,options)) {
    if (selected.length >= options.maxPeople) break
    const variants = cardVariants(item,context,options)
    const variant = variants.base.find(card => (prefix+[...cards,card].join('；')).length <= options.maxChars)
    if (!variant) continue
    const { _sort_last, ...safe } = item
    selected.push(safe); cards.push(variant); details.push(variants.detailed)
  }
  // Reserve the identity slots before spending remaining budget on public detail.
  for (let index = 0; index < cards.length; index++) if (details[index]) {
    const enriched = cards.map((card,i) => i === index ? details[index] : card)
    if ((prefix+enriched.join('；')).length <= options.maxChars) cards[index] = details[index]
  }
  return { records: selected, text: cards.length ? prefix+cards.join('；') : '' }
}

/** Scores are explainable retrieval signals, never inferred affection/owner status. */
export function rankContacts(records, context = {}, options = {}) {
  return select(records,context,optionsOf(options)).records
}

/** Trusted owner UI only: all neutral rows with the same score explanation.
 * Model-facing rankContacts/renderFamiliarContext retain the 3-person/180-char cap. */
export function rankAllContactsForOwner(records, context = {}, options = {}) {
  return ranked(records,context,optionsOf(options)).map(({_sort_last,...row})=>row)
}

/** A fixed-budget index. Original private messages and generic summaries are ignored. */
export function renderFamiliarContext(records, context = {}, options = {}) {
  return select(records,context,optionsOf(options)).text
}
