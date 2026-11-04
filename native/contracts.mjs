/** Canonical v3 contracts. No legacy file shape or table name is accepted here. */
export const NATIVE_FORMAT = 'dsh-companion-native'
export const NATIVE_SCHEMA_VERSION = 3
export const NATIVE_APPLICATION_ID = 0x4f4a5633
const forbidden = new Set(['__proto__', 'prototype', 'constructor'])
export const isPlainObject = value => value !== null && typeof value === 'object'
  && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value))
const freeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { for (const child of Object.values(value)) freeze(child); Object.freeze(value) }
  return value
}

export function validateJson(value, { object = false, maxBytes = 1024 * 1024 } = {}) {
  const seen = new Set()
  const visit = (node, at, depth) => {
    if (depth > 32) throw new Error(at + '嵌套过深')
    if (node === null || typeof node === 'boolean' || typeof node === 'string') return
    if (typeof node === 'number') {
      if (!Number.isFinite(node) || Number.isInteger(node) && !Number.isSafeInteger(node)) throw new Error(at + '数值必须有限且整数精确；大ID请使用字符串')
      return
    }
    if (!Array.isArray(node) && !isPlainObject(node)) throw new Error(at + '必须是标准JSON值')
    if (seen.has(node)) throw new Error(at + '包含循环引用')
    seen.add(node)
    for (const [key, child] of Object.entries(node)) {
      if (forbidden.has(key)) throw new Error(at + '包含不支持的键')
      visit(child, at + '.' + key, depth + 1)
    }
    if (Array.isArray(node) && Object.keys(node).length !== node.length) throw new Error(at + '不能包含稀疏数组')
    seen.delete(node)
  }
  if (object && !isPlainObject(value)) throw new Error('文档值必须是JSON对象')
  visit(value, '$', 0)
  const text = stringifyJson(value)
  if (Buffer.byteLength(text) > maxBytes) throw new Error('JSON内容超过容量限制')
  return JSON.parse(text)
}

/** JSON.stringify normally erases -0; keep source numeric semantics intact. */
export function stringifyJson(value) {
  return JSON.stringify(value, (_key, child) => typeof child === 'number' && Object.is(child, -0) ? JSON.rawJSON('-0') : child)
}

const string = (max = 4096, extra = {}) => ({ kind: 'string', max, ...extra })
const number = (min = -Number.MAX_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER) => ({ kind: 'number', min, max })
const integer = (min = 0, max = Number.MAX_SAFE_INTEGER) => ({ kind: 'integer', min, max })
const boolean = { kind: 'boolean' }
const choice = (...values) => ({ kind: 'choice', values })
const array = (item, max = 1000) => ({ kind: 'array', item, max })
const object = (fields, required = []) => ({ kind: 'object', fields, required })
const nullable = item => ({ kind: 'nullable', item })
const identifier = string(160, { pattern: /^[a-z][a-z0-9_.:/-]*$/ })
const namespace = string(32, { pattern: /^[a-z][a-z0-9_-]*$/ })
const uid = string(240, { nonempty: true })
const timestamp = integer(0, 8640000000000000)
const date = string(10, { pattern: /^\d{4}-\d{2}-\d{2}$/, calendar_date: true })
const hour = integer(0, 23)
const nonnegative = number(0)
const platform = choice('qq', 'tieba', 'bilibili', 'web', 'harness', 'system')
const dimensions = object(Object.fromEntries(['happy','calm','sweet','heartache','worry','sad','jealous'].map(key => [key, number(0, 100)])))

export const PERSONA_TRAITS = freeze(object({ abstract: number(0, 10), sharp: number(0, 10), gentle: number(0, 10), talkative: number(0, 10), image_bias: number(0, 10) }))
export const PERSONA_VOICE = freeze(object({
  samples: array(string(2000), 100), quirks: array(string(500), 100), particles: array(string(120), 100), patterns: array(string(500), 100),
  sentence_len: choice('short','medium','long'), punctuation: choice('light','normal'),
}))

const settings = object({
  enabled: boolean, time_zone: string(80), default_persona_id: identifier,
  activity_document_id: identifier, mood_document_id: identifier, speech_document_id: identifier, learning_document_id: identifier,
  platform_document_ids: object({ qq: identifier, tieba: identifier, bilibili: identifier }),
  familiarity: object({ sharing: choice('platform','global'), score_version: string(80), max_people: integer(1,3),
    max_context_chars: integer(32,180), public_summary_enabled: boolean, measurement_ref: identifier }),
  memory: object({ enabled: boolean, hit_limit: integer(0, 50), prompt_language: choice('zh','en'), max_injection_chars: integer(0, 32000),
    consolidation_enabled: boolean, consolidation_batches_per_day: integer(0, 100), consolidation_source_limit: integer(1, 100),
    consolidation_max_chars: integer(96, 64000), backup_enabled: boolean, disabled_workspace_ids: array(string(512), 1000) }),
}, ['enabled'])

const activity = object({
  enabled: boolean, time_zone: string(80), holidays: array(date, 1000),
  budget: object({ daily_wake_limit: integer(), daily_token_limit: integer(), reserve_tokens: integer(), human_reserve_tokens: integer(),
    max_task_tokens: integer(), max_steps: integer(1, 100), urgent_human_allowed: boolean, money_budget_enabled:boolean, daily_cost_limit_fen:integer(0,100000000), money_request_timeout_ms:integer(1000,3600000) }),
  batching: object({ batch_ms: integer(), human_batch_ms: integer(), max_batch: integer(1, 1000), max_concurrent: integer(1, 100), max_per_platform: integer(1, 100),
    lease_ms: integer(1), task_timeout_ms: integer(1), min_valley_remaining_ms: integer() }),
  idle: object({ enabled: boolean, min_idle_ms: integer(), explore_every_ms: integer(1), chat_every_ms: integer(1),
    explore_platforms: array(platform, 6), qq_targets: array(choice('owner','group'), 2) }),
  qq: object({ owner_conversation: string(240), group_conversations: array(string(240), 1000), profile_authorized: boolean, quiet_start_hour: hour, quiet_end_hour: hour }),
  model: object({ reasoning_effort: choice('off','low','medium','high','max'), max_output_tokens: integer(1), peak_max_output_tokens: integer(1) }),
  mood_judge: object({ min_interval_minutes: integer(), max_per_day: integer(), reserve_tokens: integer() }),
}, ['enabled'])

const activityState = object({
  idle: object({ last_activity_at: timestamp, next_explore_at: timestamp, next_chat_at: timestamp, explore_cursor: integer(), chat_cursor: integer() }),
  blocks: array(object({ platform, reason: string(2000), blocked_at: timestamp, until: nullable(timestamp) }, ['platform']), 20),
}, [])

const mood = object({
  enabled: boolean, shared: choice(true), self_profile_id: identifier, owner_entity_id: identifier, owner_address: string(80),
  policy: object({ baseline: number(0, 100), floor: number(0, 100), decay_half_hours: number(0.01, 10000), auto_judge: boolean,
    inject_mode: choice('off','mood','event'), inject_confidence: number(0, 100), significant_delta: number(0, 100),
    significant_dimension_delta: number(0, 100), inject_per_day: integer(), judge_provider: string(160), judge_model: string(160) }),
  state: object({ value: number(0, 100), dimensions, reason: string(4000), updated_at: timestamp, last_decay_at: timestamp,
    last_injected_at: nullable(timestamp), source_event_id: identifier, last_confidence: nullable(number(0,100)),
    injected_for: nullable(timestamp), last_injected_text: string(4000), said_at: array(timestamp,10000),
    last_noted_value: nullable(number(0,100)), minor: boolean, kind: string(160) }),
}, ['enabled'])

const hormoneValues=object({stress:number(0,100),energy:number(0,100),reward:number(0,100),boredom:number(0,100)},['stress','energy','reward','boredom'])
const hormone=object({enabled:boolean,mode:choice('active','observe'),policy:object({
  daily_token_budget:integer(1,1000000000),rest_after_minutes:number(0.01,10000),recovery_half_hours:number(0.01,10000),
  day_energy_baseline:number(0,100),night_energy_baseline:number(0,100),night_start_hour:hour,night_end_hour:hour,daily_recovery:number(0,100),
  stress_half_hours:number(0.01,10000),reward_half_minutes:number(0.01,10000),boredom_after_minutes:number(0.01,10000),boredom_half_hours:number(0.01,10000),
  debt_ratio:number(0,10),debt_max:number(0,80),debt_decay_hours:number(0.01,10000),
  stress_cost:number(0,3),reward_cost:number(0,3),reward_stress_decay:number(0,0.95),stress_recovery:number(0,3),
  stress_high:number(0,100),energy_low:number(0,100),reward_high:number(0,100),boredom_high:number(0,100),reminder_minutes:number(0.01,10000),
})},['enabled','mode'])
const hormoneHash=string(64,{pattern:/^[a-f0-9]{64}$/})
const hormoneState=object({version:choice(1),updated_at:timestamp,day:date,last_work_at:timestamp,last_user_at:timestamp,values:hormoneValues,
  debts:array(object({amount:number(0,80),at:timestamp},['amount','at']),400),
  emit:object({active:array(choice('stress','energy','reward','boredom'),4),at:timestamp},['active','at']),
  rounds:array(object({id:hormoneHash,session_hash:hormoneHash,turn:integer(),updated_at:timestamp,tokens:integer(),tool_count:integer(),error_count:integer(),consecutive_errors:integer(),
    requests:array(object({id:hormoneHash,total_tokens:integer()},['id','total_tokens']),256)},['id','session_hash','turn','updated_at','tokens','tool_count','error_count','consecutive_errors','requests']),128),
  history:array(object({at:timestamp,reason:string(80),platform,values:hormoneValues,debt:number(0,80)},['at','reason','platform','values','debt']),400),
},['version','updated_at','day','last_work_at','last_user_at','values','debts','emit','rounds','history'])

const qqSettings = object({
  transport: object({ mode: choice('forward','reverse'), url: string(4096), host: string(512), port: integer(0, 65535), credential_ref: identifier,
    connect_timeout_ms: integer(), reconnect_max_attempts: integer() }),
  access: object({ admin_uids: array(uid), dm_policy: choice('open','allowlist','disabled'), allowed_private_uids: array(uid),
    group_policy: choice('open','allowlist','disabled'), allowed_group_uids: array(uid), require_mention: boolean, ignore_self: boolean,
    allow_all_users: boolean, restricted_member_prefix: boolean }),
  conversation: object({ new_message_policy: choice('queue','steer'), auto_steer_policy: choice('admin','all'), rate_limit_per_minute: integer(),
    interim_messages: boolean, send_error_notice: boolean, agent_preset_id: string(160), workspace_id: string(512),
    unknown_command: choice('intercept','passthrough'), interim_recall: boolean, interim_recall_ms: integer(), deferred_timeout_ms: integer(), chat_idle_evict_days: number(0) }),
  media: object({ text_image_threshold: integer(), stt_enabled: boolean, stt_model: string(160), asset_collection_id: identifier,
    temp_ttl_hours: number(0), outbound_image_max_bytes: integer(), inbound_image_max_px: integer(), max_voice_bytes: integer(), max_file_bytes: integer(),
    inbound_file_max_bytes: integer(), allow_private_hosts: boolean, stt_engine: string(160), stt_command_ref: identifier,
    interpreter_ref: string(512), stt_args: array(string(4000), 100), stt_timeout_ms: integer(), card_footer: string(1000),
    font_files: array(string(2000), 100), font_families: array(string(240), 100) }),
  moderation: object({ enabled: boolean, allowed_group_uids: array(uid,1000), allow_local_owner: boolean,
    default_duration_seconds: integer(1,2592000), nickname_fuzzy_match: boolean, max_duration_seconds: integer(1,2592000), command_ttl_ms: integer(1000,600000) }),
  writes: object({ per_minute: integer(), per_day: integer() }),
  diagnostics: object({ log_level: choice('debug','info','warn','error'), trace_enabled: boolean, action_audit_enabled: boolean,
    sensitive_patterns: array(string(4000), 1000), trace_level: choice('debug','warn'), record_inbound: boolean, inbox_redact: boolean }),
  dedup_window_seconds: number(0),
})

const tiebaSettings = object({
  bars: array(string(160), 1000), keywords: array(string(240), 1000),
  permissions: object({ sign: boolean, follow: boolean, sign_all_followed: boolean, reply: boolean, answer_questions: boolean,
    sub_reply: boolean, new_thread: boolean, images: boolean, experimental_image_post: boolean, direct_message:boolean }),
  inbox:object({enabled:boolean,poll_interval_ms:integer(15000),seed_on_start:boolean,allow_legacy_auth:boolean,auth_until:nullable(timestamp),authorized_peer_uids:array(uid,100),daily_limit:integer(1,500),gap_ms:integer(1000)}),
  comment_inbox:object({enabled:boolean,poll_interval_ms:integer(15000),seed_on_start:boolean,max_pages:integer(1,30)}),
  limits: object({ read_per_round: integer(), reply_per_round: integer(), reply_per_day: integer(), sub_reply_per_round: integer(),
    sub_reply_per_day: integer(), new_thread_per_day: integer(), image_per_day: integer(), reply_gap_ms: integer() }),
  requests: object({ gap_ms: integer(), breaker_ms: integer(), dedupe_days: integer() }),
  learning: object({ persona_evolution_enabled: boolean, hot_only: boolean, bar_style_enabled: boolean }),
  diary: object({ enabled: boolean, private_enabled: boolean }),
  expression: object({ tone_gate_enabled: boolean, mention_name: string(240), mention_uid: string(240), mention_every_reply: boolean }),
})

const biliSettings = object({
  limits: object({read_per_round: integer(),reply_per_round: integer()}),
  preferences: object({ like: array(string(240), 1000), dislike: array(string(240), 1000), keywords: array(string(240), 1000) }),
  interaction: object({reply_to_comments:boolean,comment_sample_size:integer(1,10)}),
  permissions: object({ comment: boolean, dynamic: boolean, mood_context: boolean, stickers: boolean, direct_message: boolean, live_danmaku: boolean }),
  sharing: object({ enabled: boolean, via: choice('qq','comment','dm'), min_score: number(0, 100), silent_after_days: integer(),
    ai_comment_guard: boolean, ai_threshold: number(0, 100), daily_limit: integer(), owner_entity_id: identifier,
    qq_document_id: identifier, private_recipient_uid: string(240), group_recipient_uid: string(240) }),
  transcription: object({ enabled: boolean, model: string(160), interpreter_ref: string(512) }),
  risk: object({ min_gap_ms: integer(), read_hourly: integer(), read_daily: integer(), write_hourly: integer(), write_daily: integer(),
    write_gap_ms: integer(), dm_gap_ms: integer(),reply_daily:integer() }),
  diary: object({ enabled: boolean, private_enabled: boolean, push_enabled: boolean }),
  notification: object({ channel: choice('none','desktop','webhook','command','qq','dm','stdout','file'), destination_ref: identifier, command_ref: identifier, template: string(2000) }),
  session: object({ rotation_days: integer(0, 365), persona_once_per_session: boolean }),
  inbox_document_id: identifier,
})

const providerSettings = object({ platform: choice('qq','tieba','bilibili'), enabled: boolean, account_entity_id: identifier, credential_ref: identifier,
  qq: qqSettings, tieba: tiebaSettings, bilibili: biliSettings }, ['platform','enabled'])

const platformState = object({
  platform, account_entity_id: identifier, paused_until: nullable(timestamp), verification_required: boolean, verification_reason: string(2000),
  last_poll_at: nullable(timestamp), last_read_at: nullable(timestamp), last_write_at: nullable(timestamp), read_failures: integer(), write_failures: integer(),
  cursors: object({ replies: string(2000), mentions: string(2000), dm: string(2000), live: string(2000), feed: string(2000) }),
  active_conversation_id: string(240),
}, ['platform'])

const quota = object({ platform, metric: choice('tokens','wakes','actions','reads','images','bytes'), category: choice('read','write','share','reply','post','image','mood','activity'),
  day: date, limit: integer(), used: integer(), reserved: integer(), reset_at: nullable(timestamp), minimum_gap_ms: integer(), last_action_at: nullable(timestamp) }, ['platform','category','day'])
const inbox = object({
  platform, enabled: boolean, channels: array(choice('replies','mentions','dm','live'), 4), poll_interval_ms: integer(1),
  scope: choice('replies','mentions','both','owner','mention','all'), all_day: boolean, once_per_person: boolean, mention_summary: boolean,
  room_uid: string(240), live_scope: choice('owner','mention','all'), cursor: string(2000), last_poll_at: nullable(timestamp), unread_count: integer(),
  dm_scope: choice('owner','allowlist','all'), dm_allowed_uids: array(uid,1000), dm_seed_on_start: boolean,
  live_ignore_uids: array(uid,1000), live_seed_on_start: boolean,
}, ['platform','enabled'])
const bilibiliInboxState = object({platform:choice('bilibili'),account_key:string(64,{pattern:/^[a-f0-9]{64}$/}),
  reply_seen_ids:array(string(240),2000),reply_seen_people_uids:array(uid,2000),reply_baseline:boolean,reply_last_timestamp_raw:string(100),
  dm_sessions:array(object({talker_uid:uid,baseline:boolean,last_timestamp_raw:string(100),last_keys:array(string(240),200),last_polled_at:nullable(timestamp)},
    ['talker_uid','baseline','last_timestamp_raw','last_keys','last_polled_at']),100),
  live_rooms:array(object({room_id:uid,baseline:boolean,seen_keys:array(string(240),2000),recent_texts:array(object({uid,text_sha256:string(64,{pattern:/^[a-f0-9]{64}$/}),seen_at:timestamp},
    ['uid','text_sha256','seen_at']),100),last_polled_at:nullable(timestamp)},['room_id','baseline','seen_keys','recent_texts','last_polled_at']),20),
  last_poll_at:nullable(timestamp),dm_device_id:string(64),
},['platform','account_key','reply_seen_ids','reply_seen_people_uids','reply_baseline','reply_last_timestamp_raw','dm_sessions','live_rooms','last_poll_at'])
const tiebaInboxState=object({platform:choice('tieba'),account_key:string(64,{pattern:/^[a-f0-9]{64}$/}),baseline:boolean,last_poll_at:nullable(timestamp),cursors:array(object({talker_uid:uid,last_message_id:uid},['talker_uid','last_message_id']),100)},['platform','account_key','baseline','last_poll_at','cursors'])
const tiebaReplyInboxState=object({platform:choice('tieba'),account_key:string(64,{pattern:/^[a-f0-9]{64}$/}),baseline:boolean,watermark_at:timestamp,seen_ids:array(uid,2000),last_poll_at:nullable(timestamp)},['platform','account_key','baseline','watermark_at','seen_ids','last_poll_at'])
const learning = object({ enabled: boolean, evidence_required: choice(true), shared_interests: choice(true), max_reflections_per_task: integer(0, 100),
  max_context_chars: integer(0, 4000), max_topics: integer(0, 1000), active_revision: integer() }, ['enabled'])
const learningState = object({
  revision: integer(), observations: integer(), updated_at: timestamp,
  topics: array(object({ id: identifier, label: string(240), score: number(), reads: integer(), positive: integer(), negative: integer(),
    platform_counts: object({ qq: integer(), tieba: integer(), bilibili: integer(), web: integer(), harness: integer() }),
    evidence_ids: array(identifier, 100), last_seen_at: timestamp }, ['id','label']), 10000),
  questions: array(object({ id: identifier, text: string(2000), evidence_ids: array(identifier, 100), status: choice('open','needs_review','rolled_back','resolved') }, ['id','text','status']), 10000),
  suggestions: array(object({ id: identifier, kind: choice('reflection','habit','phrase','experience'), content: string(4000), question: string(2000),
    evidence_ids: array(identifier, 100), source_at: timestamp, status: choice('proposed','challenged','rolled_back','accepted') }, ['id','kind','content','status']), 10000),
  versions: array(object({ revision: integer(), created_at: timestamp, suggestion_ids: array(identifier, 10000), restored_from: integer() }, ['revision','created_at']), 10000),
}, ['revision','observations'])
const learningLoop = object({enabled:boolean,policy:object({
  max_cards:integer(1,1000),max_hint_chars:integer(0,2000),meme_cooldown_minutes:number(0,10000),recent_window_minutes:number(1,10000),
  max_meme_uses_per_context:integer(1,100),trial_uses_required:integer(1,100),positive_feedback_required:integer(0,100),
  review_interval_minutes:number(1,10000),review_sources_per_batch:integer(1,10),review_max_per_day:integer(0,100),
  review_retry_minutes:number(1,10000),review_max_attempts:integer(1,100),
})},['enabled'])
const learningContent=object({label:string(40),meaning:string(240),cues:array(string(60),8),applies_to:array(string(80),6),avoid_in:array(string(80),6),
  example_good:string(240),example_bad:string(240),source_quotes:array(object({evidence_id:string(160),quote:string(300)},['evidence_id','quote']),4),
},['label','meaning','cues','applies_to','avoid_in','example_good','example_bad','source_quotes'])
const learningItemStatus=choice('trial','active','paused','retired')
const learningItem=object({id:string(80),kind:choice('meme','phrase','habit'),status:learningItemStatus,revision:integer(),content:learningContent,
  evidence_ids:array(string(160),4),source_kind:choice('public_read','owner_teaching'),visibility:choice('public','owner','conversation'),platform,conversation_id:string(512),
  created_at:timestamp,updated_at:timestamp,used:integer(),positive:integer(),negative:integer(),last_used_at:timestamp,last_offered_at:timestamp,
  versions:array(object({revision:integer(),status:learningItemStatus,content:learningContent,evidence_ids:array(string(160),4),at:timestamp},['revision','status','content','evidence_ids','at']),8),
},['id','kind','status','revision','content','evidence_ids','source_kind','visibility','platform','conversation_id','created_at','updated_at','used','positive','negative','last_used_at','last_offered_at','versions'])
const learningHash=string(64,{pattern:/^[a-f0-9]{64}$/})
const learningLoopState=object({version:choice(1),revision:integer(),updated_at:timestamp,
  reviews:array(object({evidence_id:string(160),attempts:integer(),retry_after:timestamp,completed_at:timestamp,status:choice('queued','done','skipped','failed'),last_task_id:string(240)},['evidence_id','attempts','retry_after','completed_at','status','last_task_id']),3000),
  offers:array(object({id:string(80),card_id:string(160),card_revision:integer(),context_hash:learningHash,session_hash:learningHash,platform,at:timestamp,query_hash:learningHash,task_id:string(240),source_scope:string(512)},['id','card_id','card_revision','context_hash','session_hash','platform','at','query_hash','task_id','source_scope']),200),
  usages:array(object({id:string(80),card_id:string(160),card_revision:integer(),context_hash:learningHash,session_hash:learningHash,platform,at:timestamp,excerpt:string(120),source_ref:string(512),output_hash:learningHash,actor_uid:string(240)},['id','card_id','card_revision','context_hash','session_hash','platform','at','excerpt','source_ref','output_hash']),200),
  blocks:array(object({card_id:string(160),context_hash:learningHash,at:timestamp},['card_id','context_hash','at']),200),
},['version','revision','updated_at','reviews','offers','usages','blocks'])
const speech = object({ enabled: boolean, level: choice('light','standard'), repetition_hints: boolean }, ['enabled'])
const speechState = object({ version: integer(1), buckets: array(object({ id:string(64,{pattern:/^[a-f0-9]{64}$/}),
  platform:choice('main','qq','tieba','bilibili','harness'), kind:choice('session','qq-chat'), updated_at:timestamp,
  recent:array(object({ event_id:string(64,{pattern:/^[a-f0-9]{64}$/}), source_at:timestamp, pattern_ids:array(string(64,{pattern:/^[a-z][a-z0-9_-]*$/}),16) },['event_id','source_at','pattern_ids']),3),
},['id','platform','kind','updated_at','recent']),200) },['version','buckets'])
const trafficState = object({ platform,
  accounts:array(object({ id:string(240), day:date, read_day:integer(), write_day:integer(), hour_started_at:timestamp,
    read_hour:integer(), write_hour:integer(), last_write_at:nullable(timestamp) },['id','day']),1000),
  operations:array(object({ id:string(240), source_at:timestamp, status:string(80), endpoint:string(4000) },['id','status']),10000),
  manual_blocks:array(object({ account_id:string(240),source_at:nullable(timestamp),code:number(),http_status:integer(0,999),endpoint:string(4000),reason:string(4000) },['account_id','source_at','code']),1000),
  next_at:nullable(timestamp), last_dispatch_at:nullable(timestamp),
  last:object({ source_at:timestamp, endpoint:string(4000), method:string(24), http_status:integer(0,999), code:number() }),
  streak:integer(), paused_until:nullable(timestamp), reason:string(4000), risk_endpoint:string(4000),
},['platform'])
const sessionPolicy = object({ session_id: string(240, { nonempty: true }), workspace_id: string(512),
  read_memory: boolean, write_memory: boolean, consolidate_memory: boolean,
  last_event_at: nullable(timestamp), last_consolidated_at: nullable(timestamp) }, ['session_id','read_memory','write_memory','consolidate_memory'])
const conversationBinding = object({ platform: choice('qq'), conversation_id: string(240, { nonempty: true }),
  session_id: string(240, { nonempty: true }), workspace_id: string(512, { nonempty: true }), retired: boolean,
  last_registered_at: nullable(timestamp), interim_messages: boolean, goal: string(4000) }, ['platform','conversation_id','session_id','workspace_id','retired'])
const tiebaStyleLibrary = object({ platform: choice('tieba'), historical: boolean,
  bars: array(object({ bar: string(160), updated_at: nullable(timestamp), updated_time_raw: string(1000),
    samples: array(object({ text: string(65536), likes: nullable(number()), likes_raw: string(100), floor: number() }, ['text','likes','likes_raw','floor']), 10000),
    statistics: object({ sample_count: integer(), average_length: number(),
      punctuation: object({ period: integer(), question: integer(), exclamation: integer(), ellipsis: integer() }, ['period','question','exclamation','ellipsis']),
      emoji_rate: number(), top_terms: array(string(4000), 10000) }, ['sample_count','average_length','punctuation','emoji_rate','top_terms']),
  }, ['bar','updated_at','updated_time_raw','samples','statistics']), 1000),
}, ['platform','historical','bars'])
const tiebaBarStyles = object({ platform: choice('tieba'), historical: boolean,
  bars: array(object({ bar: string(160), visits: integer(), samples: array(string(65536), 10000), tags: array(string(4000), 1000),
    mode: string(240), updated_at: nullable(timestamp), updated_time_raw: string(1000),
  }, ['bar','visits','samples','tags','mode','updated_at','updated_time_raw']), 1000),
}, ['platform','historical','bars'])
const tiebaAtmosphere=object({version:choice(1),bar:string(160,{nonempty:true}),updated_at:timestamp,
  sources:array(object({evidence_id:identifier,thread_id:string(160,{nonempty:true}),read_at:timestamp,title:string(180),ref:string(4096)},['evidence_id','thread_id','read_at','title','ref']),24),
  samples:array(object({id:string(160,{nonempty:true}),thread_id:string(160,{nonempty:true}),post_id:string(160,{nonempty:true}),author_uid:string(160,{nonempty:true}),text:string(1200,{nonempty:true}),evidence_id:identifier,observed_at:timestamp,scene:choice('help','discussion','banter','other')},['id','thread_id','post_id','author_uid','text','evidence_id','observed_at','scene']),60),
},['version','bar','updated_at','sources','samples'])
const personaReference = object({id:identifier,profile_id:identifier,platform:choice('main','qq','tieba','bilibili'),
  kind:choice('style_rule','scene_tactic','speech_example','meme','learning_observation'),status:choice('active','candidate','archived'),
  visibility:choice('owner','public'),usage:choice('style_reference_only'),title:string(1000),
  segments:array(object({type:choice('text','self_name'),text:string(65536)},['type']),1000),speaker_role:choice('self','source_character','other'),scene:string(2000),
  provenance:array(object({source_ref:string(4096),source_sha256:string(64,{pattern:/^[a-f0-9]{64}$/}),line_start:integer(1),line_end:integer(1),
    fragment_sha256:string(64,{pattern:/^[a-f0-9]{64}$/})},['source_ref','source_sha256','line_start','line_end','fragment_sha256']),1000),
  source_book_kind:choice('style','tactics','persona_quotes','memes','learnings','source_corpus'),source_speaker_role:string(160),
  claim_type:choice('style_rule','fictional_example','historical_observation'),updated_at:timestamp,converter:string(160),evidence_ids:array(identifier,100),
  valid_from:nullable(timestamp),valid_until:nullable(timestamp),
},['id','profile_id','platform','kind','status','visibility','usage','title','segments','provenance','source_book_kind','claim_type','updated_at'])
const runtimeLease = object({scope:choice('channels'),holder_id:string(160,{nonempty:true}),pid:integer(1),lease_until:timestamp,renewed_at:timestamp},
  ['scope','holder_id','pid','lease_until','renewed_at'])
const workspacePersonaBinding = object({workspace_id:string(512,{nonempty:true}),platform:choice('main','qq','tieba','bilibili'),enabled:boolean},
  ['workspace_id','platform','enabled'])

export const DOCUMENT_CONTRACTS = freeze(Object.fromEntries(Object.entries({
  settings, activity, activity_state: activityState, mood, hormone, hormone_state:hormoneState, platform_settings: providerSettings,
  platform_state: platformState, quota, inbox, learning, learning_state: learningState, learning_loop:learningLoop,learning_loop_state:learningLoopState,learning_item:learningItem,speech, speech_state:speechState,
  traffic_state:trafficState, session_policy: sessionPolicy, conversation_binding: conversationBinding, bilibili_inbox_state:bilibiliInboxState,tieba_inbox_state:tiebaInboxState,tieba_reply_inbox_state:tiebaReplyInboxState,
  tieba_style_library: tiebaStyleLibrary, tieba_bar_styles: tiebaBarStyles,tieba_atmosphere:tiebaAtmosphere,
  persona_reference:personaReference,
  runtime_lease:runtimeLease,
  workspace_persona_binding:workspacePersonaBinding,
}).map(([type, value]) => [type, { type, schema_id: 'companion.' + type, schema_version: 1, value }])))

export function validateShape(value, spec, at = '$') {
  if (spec.kind === 'nullable') { if (value === null) return; return validateShape(value, spec.item, at) }
  if (spec.kind === 'string') {
    if (typeof value !== 'string' || value.length > spec.max || value.includes('\0') || !value.isWellFormed() || spec.nonempty && !value.length || spec.pattern && !spec.pattern.test(value)) throw new Error(at + '文本字段无效')
    if (spec.calendar_date) {
      const atUtc = Date.parse(value + 'T00:00:00Z')
      if (!Number.isFinite(atUtc) || new Date(atUtc).toISOString().slice(0,10) !== value) throw new Error(at + '日期无效')
    }
  } else if (spec.kind === 'boolean') { if (typeof value !== 'boolean') throw new Error(at + '必须是布尔值') }
  else if (spec.kind === 'choice') { if (!spec.values.includes(value)) throw new Error(at + '不在允许的取值中') }
  else if (spec.kind === 'integer' || spec.kind === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value) || spec.kind === 'integer' && !Number.isSafeInteger(value)
      || value < spec.min || value > spec.max) throw new Error(at + '数值字段无效')
  } else if (spec.kind === 'array') {
    if (!Array.isArray(value) || value.length > spec.max) throw new Error(at + '数组字段无效')
    value.forEach((child, index) => validateShape(child, spec.item, at + '[' + index + ']'))
  } else if (spec.kind === 'object') {
    if (!isPlainObject(value) || Object.keys(value).some(key => !Object.hasOwn(spec.fields, key)) || spec.required.some(key => !Object.hasOwn(value, key))) throw new Error(at + '缺少必填字段或含未知字段')
    for (const [key, child] of Object.entries(value)) validateShape(child, spec.fields[key], at + '.' + key)
  } else throw new Error('无效原生契约定义')
}

export function validateDocument(input) {
  if (!isPlainObject(input) || !Object.hasOwn(DOCUMENT_CONTRACTS, input.type)) throw new Error('不支持的原生文档type')
  const contract = DOCUMENT_CONTRACTS[input.type]
  if (input.schema_id !== undefined && input.schema_id !== contract.schema_id || input.schema_version !== undefined && input.schema_version !== contract.schema_version) throw new Error('不支持的原生文档schema/version')
  const value = validateJson(input.value, { object: true })
  validateShape(value, contract.value)
  if (input.type === 'platform_settings') {
    const other = ['qq','tieba','bilibili'].filter(name => name !== value.platform)
    if (other.some(name => Object.hasOwn(value, name))) throw new Error('平台文档只能包含对应provider子契约')
    if(['tieba','bilibili'].includes(value.platform)){const limits=value[value.platform]?.limits??{};for(const key of ['read_per_round','reply_per_round','sub_reply_per_round'])if(limits[key]!==undefined&&(limits[key]<(key==='read_per_round'?1:0)||limits[key]>30))throw new Error('每轮数量须在允许范围内：浏览1至30，评论0至30')}
  }
  if(input.type==='persona_reference'){
    if(value.segments.some(part=>part.type==='text'?!Object.hasOwn(part,'text'):Object.hasOwn(part,'text')))throw new Error('例句文字与当前姓名占位必须明确分开')
    if(value.provenance.some(row=>row.line_end<row.line_start))throw new Error('参考来源行范围无效')
  }
  return { type: contract.type, schema_id: contract.schema_id, schema_version: contract.schema_version, value }
}

export function validatePersona(input) {
  if (!isPlainObject(input)) throw new Error('人设必须是原生对象')
  const allowed = ['id','platform','follow_main','main_profile_id','name','self_ref','owner_address','body_md','traits','voice','expected_revision','created_at','updated_at']
  if (Object.keys(input).some(key => !allowed.includes(key))) throw new Error('原生人设包含未知字段')
  validateShape(input.platform, choice('main','qq','tieba','bilibili'), '$.platform')
  validateShape(input.follow_main, boolean, '$.follow_main')
  for (const key of ['name','self_ref','owner_address']) validateShape(input[key], string(160, { nonempty: key === 'name' }), '$.' + key)
  validateShape(input.body_md, string(65536), '$.body_md')
  const traits = validateJson(input.traits, { object: true }), voice = validateJson(input.voice, { object: true })
  validateShape(traits, PERSONA_TRAITS, '$.traits'); validateShape(voice, PERSONA_VOICE, '$.voice')
  if (input.platform === 'main' && (input.follow_main || input.main_profile_id)) throw new Error('主人设不能跟随其他人设')
  if (input.follow_main && typeof input.main_profile_id !== 'string') throw new Error('跟随人设必须明确main_profile_id')
  return { ...input, traits, voice }
}
