/* 欧鲸鲸统一客户端；由 scripts/build-client.mjs 按顺序拼接，请编辑来源文件。 */
/* Native v3 administration client. This is the only settings client; no legacy plugin page is loaded. */
window.__ModuleLoader__.load({
  id: 'dsh-companion-unified',
  factory: require => {
    const React = require('react'), h = React.createElement
    const API = '/api/companion/v3'
    const NAMES = {main:'主人设',qq:'QQ',bilibili:'B站',tieba:'贴吧'}
    const NAV = [
      ['overview','首页',[['status','运行状态']]],
      ['persona','人设',[['main','主人设'],['qq','QQ人设'],['bilibili','B站人设'],['tieba','贴吧人设'],['speech','表达提醒'],['media','表情与图库'],['state','心情与状态']]],
      ['memory','记忆',[['search','找记忆'],['diary','日记'],['people','熟人'],['learning','学习'],['settings','记忆设置']]],
      ['activity','主动活动',[['queue','最近活动'],['opportunities','日常安排'],['budget','每天用量'],['school','托儿所']]],
      ['platforms','平台',[['bilibili','B站'],['tieba','贴吧'],['qq','QQ']]],
      ['portability','备份与更新',[['export','备份'],['import','恢复'],['update','检查更新']]],
    ]
    NAV.sort((a,b)=>['overview','platforms','activity','persona','memory','portability'].indexOf(a[0])-['overview','platforms','activity','persona','memory','portability'].indexOf(b[0]))
    const f = (path,label,type='text',hint='',extra={}) => ({path,label,type,hint,...extra})
    const bool = (path,label,hint='') => f(path,label,'boolean',hint)
    const num = (path,label,hint='',extra={}) => f(path,label,'number',hint,extra)
    const list = (path,label,hint='每行一项，也可用逗号分隔') => f(path,label,'list',hint)
    const select = (path,label,options,hint='') => f(path,label,'select',hint,{options})
    const choices = (path,label,options,hint='') => f(path,label,'choices',hint,{options})
    const minutes = (path,label,hint='') => num(path,label+'（分钟）',hint,{scale:60000})
    const seconds = (path,label,hint='') => num(path,label+'（秒）',hint,{scale:1000})
    const TIEBA_BARS = 'tieba.bars', PROACTIVE_POST_BARS = 'tieba.proactive_post_bars'
    const FIELDS = {
      persona_platform:{common:[{...bool('persona_enabled','启用此平台的人设','仅在「欧鲸鲸的家」的对应渠道生效。关闭后仍可编辑和保存人设。'),defaultValue:true}],advanced:[]},
      speech:{common:[bool('enabled','开启表达提醒','在生成回复前给大肥鱼加一条表达提示。'),select('level','提示详细程度',[['light','简短'],['standard','标准']]),bool('repetition_hints','提醒最近重复的句式','发现近期多次用了类似的句式时，提示大肥鱼换种说法。')],advanced:[]},
      mood:{common:[bool('enabled','记录共享心情'),bool('policy.auto_judge','低频判断心情变化'),select('policy.inject_mode','带入对话的方式',[['off','不带入'],['mood','当前心情'],['event','有明显变化时']])],advanced:[num('policy.baseline','平常心情基线','0—100',{max:100}),num('policy.floor','心情下限','0—100',{max:100}),num('policy.decay_half_hours','平复一半所需小时','',{min:0.01,decimal:true}),num('policy.significant_delta','明显变化阈值'),num('policy.inject_per_day','每日心情注入上限')]},
      hormone:{common:[bool('enabled','记录精力与压力'),select('mode','如何影响聊天',[['active','结合心情调整表达'],['observe','只观察变化']])],advanced:[
        num('policy.daily_token_budget','精力消耗基准（Token）','',{min:1,max:1000000000}),num('policy.rest_after_minutes','休息多久后恢复（分钟）','',{min:0.01,max:10000,decimal:true}),num('policy.recovery_half_hours','恢复一半所需小时','',{min:0.01,max:10000,decimal:true}),
        num('policy.day_energy_baseline','白天精力基线','',{max:100,decimal:true}),num('policy.night_energy_baseline','夜间精力基线','',{max:100,decimal:true}),num('policy.night_start_hour','夜间开始（几点）','',{max:23}),num('policy.night_end_hour','夜间结束（几点）','',{max:23}),num('policy.daily_recovery','跨天恢复幅度','',{max:100,decimal:true}),
        num('policy.stress_half_hours','压力平复一半所需小时','',{min:0.01,max:10000,decimal:true}),num('policy.reward_half_minutes','愉悦平复一半所需分钟','',{min:0.01,max:10000,decimal:true}),num('policy.boredom_after_minutes','多久无人互动后无聊（分钟）','',{min:0.01,max:10000,decimal:true}),num('policy.boredom_half_hours','无聊增长一半所需小时','',{min:0.01,max:10000,decimal:true}),
        num('policy.debt_ratio','熬夜疲劳累计倍率','',{max:10,decimal:true}),num('policy.debt_max','熬夜最多压低精力上限','',{max:80,decimal:true}),num('policy.debt_decay_hours','熬夜疲劳消退小时','',{min:0.01,max:10000,decimal:true}),
        num('policy.stress_cost','压力对消耗的影响','',{max:3,decimal:true}),num('policy.reward_cost','愉悦对消耗的缓解','',{max:3,decimal:true}),num('policy.reward_stress_decay','愉悦对压力平复的帮助','',{max:0.95,decimal:true}),num('policy.stress_recovery','压力对恢复的影响','',{max:3,decimal:true}),
        num('policy.stress_high','压力提示阈值','',{max:100,decimal:true}),num('policy.energy_low','低精力提示阈值','',{max:100,decimal:true}),num('policy.reward_high','愉悦提示阈值','',{max:100,decimal:true}),num('policy.boredom_high','无聊提示阈值','',{max:100,decimal:true}),num('policy.reminder_minutes','同一状态多久再提醒（分钟）','',{min:0.01,max:10000,decimal:true}),
      ]},
      shared_media:{common:[num('expression.media_preference','表情、表情包与图库使用倾向','',{min:1,max:10,defaultValue:5})],advanced:[]},
      memory:{common:[bool('memory.enabled','启用共享长期记忆'),num('memory.hit_limit','每次最多带入条数'),num('memory.max_injection_chars','每次带入记忆的字数上限')],advanced:[bool('memory.consolidation_enabled','允许整理记忆'),num('memory.consolidation_batches_per_day','每天最多整理批数'),num('memory.consolidation_source_limit','每批最多证据条数'),num('memory.consolidation_max_chars','每批整理字数上限'),bool('memory.backup_enabled','自动备份'),select('familiarity.sharing','熟人检索范围',[['global','全平台相关熟人'],['platform','仅当前平台']]),num('familiarity.max_people','每次最多熟人数','最多3人',{min:1,max:3}),num('familiarity.max_context_chars','熟人片段字数上限','最多180字',{min:32,max:180})]},
      learning:{common:[bool('enabled','从阅读与互动中积累学习'),num('max_reflections_per_task','每个任务最多反思条数'),num('max_context_chars','学习线索上下文字数')],advanced:[num('max_topics','最多保留兴趣主题数')]},
      learning_loop:{common:[bool('enabled','学习表达与用法'),num('policy.review_interval_minutes','自动整理间隔（分钟）','',{min:1,max:10000,decimal:true}),num('policy.review_max_per_day','每天最多自动整理次数','',{min:0,max:100}),num('policy.review_sources_per_batch','每次最多整理几条来源','',{min:1,max:10})],advanced:[
        num('policy.max_cards','最多保留学习项','',{min:1,max:1000}),num('policy.max_hint_chars','每次最多带入学习字数','',{min:0,max:2000}),num('policy.meme_cooldown_minutes','同一个梗再次使用间隔（分钟）','',{min:0,max:10000,decimal:true}),num('policy.recent_window_minutes','重复使用检查范围（分钟）','',{min:1,max:10000,decimal:true}),num('policy.max_meme_uses_per_context','同一话题内最多用梗次数','',{min:1,max:100}),num('policy.trial_uses_required','试用至少几次后评估','',{min:1,max:100}),num('policy.positive_feedback_required','采用前至少几次积极反馈','',{min:0,max:100}),num('policy.review_retry_minutes','整理失败后等待分钟','',{min:1,max:10000,decimal:true}),num('policy.review_max_attempts','每条来源最多整理几次','',{min:1,max:100}),
      ]},
      opportunities:{common:[bool('enabled','活动总开关'),bool('idle.enabled','空闲自主活动'),minutes('idle.min_idle_ms','空闲多久再找机会','贴吧、B站的评论监测与自动回复不重置此计时。'),minutes('idle.explore_every_ms','探索机会间隔'),minutes('idle.chat_every_ms','主动聊天机会间隔'),bool('budget.urgent_human_allowed','为真人新消息保留及时回应')],advanced:[choices('idle.explore_platforms','可探索平台',[['bilibili','B站'],['tieba','贴吧']]),choices('idle.qq_targets','主动聊天对象',[['owner','主人'],['group','群友'],['contact','指定好友']]),f('qq.owner_conversation','主人的QQ号','qq_owner'),f('qq.group_conversations','允许主动聊天的群','qq_groups','每行填写一个群号'),f('qq.private_conversations','允许主动私聊的好友','qq_contacts','每行一个完整QQ号，并勾选上面的“指定好友”。只会联系QQ好友；来信回复仍遵守私聊设置。'),bool('qq.profile_authorized','允许更换自身头像和昵称'),num('qq.quiet_start_hour','QQ安静时段开始','0—23',{max:23}),num('qq.quiet_end_hour','QQ安静时段结束','开始和结束相同表示不另设安静时段',{max:23}),f('time_zone','作息时区'),list('holidays','节假日','每行一个 YYYY-MM-DD')]},
      budget:{common:[num('budget.daily_wake_limit','每日主动唤醒上限（次）','只限制自主浏览、主动搭话与后台整理；手动执行和回应来信不限次数。0暂停自主唤醒。',{min:0}),num('budget.daily_token_limit','每日自动活动Token预算','自主活动和回应来信共用；手动消耗单独统计，不占此预算。'),num('budget.max_task_tokens','单次任务 token 上限'),num('budget.max_steps','单次任务最多步骤','',{min:1,max:100}),num('budget.human_reserve_tokens','为真人消息保留 token')],advanced:[num('batching.max_concurrent','同时思考任务总上限','各平台共用此上限；已生成的评论发表独立运行',{min:1,max:100}),num('batching.max_per_platform','单平台同时思考上限','同平台发表另用独立队列，每个平台一次发表一条',{min:1,max:100}),num('budget.reserve_tokens','保留余额'),num('model.tieba_incoming_max_output_tokens','贴吧自动回复单次输出上限（Token）','其他平台和普通对话继续用各自的额度。',{min:1,max:64000}),num('model.max_output_tokens','谷时单次最大输出'),num('model.peak_max_output_tokens','峰时简短回应最大输出'),seconds('batching.batch_ms','普通消息合并窗口'),num('batching.max_batch','一批最多事件数','',{min:1}),num('mood_judge.max_per_day','每日心情判断上限')]},
      bilibili:{common:[bool('enabled','启用B站'),num('bilibili.limits.read_per_round','每轮最多浏览视频数','读取失败会在本轮换候选；尝试数最多为此值的2倍，不冒充完整看完',{min:1,max:30}),num('bilibili.limits.reply_per_round','每轮评论总上限','视频下评论与回复别人合计；0表示只浏览',{min:0,max:30}),bool('bilibili.permissions.comment','允许评论和回复'),bool('bilibili.interaction.reply_to_comments','主动参与评论区讨论','批量读取少量留言，优先挑有内容的回复；与视频评论共用每轮上限。'),bool('bilibili.permissions.dynamic','允许发动态'),bool('bilibili.permissions.stickers','允许合适的表情包'),list('bilibili.preferences.like','感兴趣的内容'),list('bilibili.preferences.dislike','不感兴趣的内容')],advanced:[num('bilibili.interaction.comment_sample_size','每次批量浏览最多带入评论数','1—10，默认6条，在本批视频间分配；不按视频数倍增，不额外开模型请求。',{min:1,max:10}),list('bilibili.preferences.keywords','关注关键词'),bool('bilibili.sharing.enabled','允许分享内容'),bool('bilibili.permissions.direct_message','允许私信回复'),bool('bilibili.permissions.live_danmaku','允许发送直播弹幕'),num('bilibili.sharing.daily_limit','每天分享上限'),num('bilibili.risk.write_daily','浏览评论与发动态日上限'),num('bilibili.risk.reply_daily','来信回复日上限','独立于浏览评论和动态；未设置时沿用上项数值。每小时时限和发送间隔仍共用。'),seconds('bilibili.risk.write_gap_ms','两次发表最小间隔'),num('bilibili.risk.read_daily','每天读取上限'),bool('bilibili.transcription.enabled','无字幕时允许本地转写'),select('bilibili.transcription.model','转写模型',[['tiny','tiny'],['base','base'],['small','small'],['medium','medium']]),bool('bilibili.diary.enabled','记录公开日记'),bool('bilibili.diary.private_enabled','记录私密日记')]},
      inbox:{common:[bool('enabled','监测回复与提及'),select('scope','监测范围',[['both','回复与提及'],['replies','只看回复'],['mentions','只看提及']]),seconds('poll_interval_ms','收件箱检查间隔'),bool('all_day','全天收集新消息','收集事件本身不调用模型；处理仍遵守统一活动安排')],advanced:[bool('once_per_person','同一人只触发一次'),bool('mention_summary','收集提及摘要'),choices('channels','监测哪些消息',[['replies','评论回复'],['mentions','提到自己'],['dm','私信'],['live','直播弹幕']]),select('dm_scope','私信接收范围',[['owner','仅主人'],['allowlist','允许名单'],['all','全部私信']]),list('dm_allowed_uids','允许接收私信的B站UID'),bool('dm_seed_on_start','首次开启跳过旧私信'),f('room_uid','直播间号'),select('live_scope','直播弹幕范围',[['owner','仅主人'],['mention','提到自己'],['all','全部弹幕']]),list('live_ignore_uids','忽略的直播用户UID'),bool('live_seed_on_start','首次开启跳过历史弹幕')]},
      tieba:{common:[bool('enabled','启用贴吧'),list(TIEBA_BARS,'常逛的吧'),choices(PROACTIVE_POST_BARS,'允许主动发帖的吧',[],'从常逛的吧中勾选。空闲浏览和手动刷一轮都适用，需同时开启「发新帖」。'),list('tieba.ignored_reply_bars','永久忽略来信的吧','每行填写一个实际吧名。忽略这些吧的回复和艾特。'),list('tieba.keywords','关注话题'),num('tieba.limits.read_per_round','每轮最多浏览帖数','按打开的不同帖子计数，翻页不重复；读取失败可能提前结束',{min:1,max:30}),num('tieba.limits.reply_per_round','每轮评论总上限','普通帖子评论与楼中楼合计；0 表示不回帖',{min:0,max:30}),num('tieba.limits.sub_reply_per_round','其中楼中楼上限','包含在评论总上限中；0表示不回楼中楼',{min:0,max:30}),bool('tieba.comment_inbox.enabled','监测并回应评论回复','全天检查别人对自己帖子、评论和楼中楼的回复；空检查不调用模型，不重置主动活动空闲计时。'),seconds('tieba.comment_inbox.poll_interval_ms','评论回复检查间隔'),bool('tieba.permissions.reply','允许评论帖子和回帖'),bool('tieba.permissions.sub_reply','精确回复到楼中楼','回复某楼先定位该楼；回复楼中楼某个人时绑定那条子评论，定位失败不改发新楼'),bool('tieba.permissions.new_thread','允许发新帖'),bool('tieba.permissions.images','允许图片和表情包'),bool('tieba.permissions.direct_message','允许回复贴吧私信'),bool('tieba.inbox.enabled','监测新私信','空收件箱不调用模型；首次开启默认跳过旧消息')],advanced:[num('tieba.reply_context.peer_history_limit','双方历史往来最多几条','大肥鱼和对方合计，优先当前楼的公开往来。0 表示不带入。',{min:0,max:10,defaultValue:3}),num('tieba.reply_context.nearby_reply_limit','同楼附近发言最多几条','用于楼中楼。0 表示不带入，上下文较长时会少带几条。',{min:0,max:10,defaultValue:4}),bool('tieba.comment_inbox.seed_on_start','首次开启跳过旧评论回复'),num('tieba.comment_inbox.max_pages','每次评论通知最多检查页数','每页通常20条；未扫描完保留检查点。',{min:1,max:30}),bool('tieba.inbox.allow_legacy_auth','允许官方旧版IM认证','该官方接口首次认证不使用TLS并传输登录态；消息正文随后加密。仅在理解此风险并明确允许后开启。'),seconds('tieba.inbox.poll_interval_ms','私信检查间隔'),seconds('tieba.inbox.gap_ms','私信发送最小间隔'),num('tieba.inbox.daily_limit','每天最多发送私信数'),bool('tieba.inbox.seed_on_start','首次开启跳过旧私信'),num('tieba.limits.reply_per_day','每天回帖上限'),num('tieba.limits.sub_reply_per_day','每天楼中楼上限'),num('tieba.limits.new_thread_per_day','每天新帖上限'),seconds('tieba.limits.reply_gap_ms','两次回复间隔'),bool('tieba.permissions.sign','自动签到'),bool('tieba.learning.bar_style_enabled','按吧积累说话参考'),bool('tieba.learning.persona_evolution_enabled','允许提出人设表达改进'),bool('tieba.expression.tone_gate_enabled','使用贴吧表达检查'),bool('tieba.diary.enabled','记录公开日记'),bool('tieba.diary.private_enabled','记录私密日记')]},
      qq:{common:[bool('enabled','启用QQ'),select('qq.participation.mode','群里怎么回应',[['all','全部消息'],['mentions','仅明确找我'],['interest_or_mention','感兴趣或明确找我']]),minutes('qq.participation.window_ms','话题统计时长'),num('qq.participation.max_topics','最多参与话题数','每个群独立计算；0表示不设此项上限',{min:0,max:1000}),bool('qq.participation.mention_exempt','明确找我时不受话题上限限制'),list('qq.participation.address_names','我的称呼'),list('qq.participation.interest_terms','额外感兴趣的关键词'),bool('qq.participation.learned_interests','结合公开学习记录选择兴趣'),bool('qq.moderation.enabled','允许管理员禁言和解禁','仅执行管理员本轮明确文字指令；机器人需要群管理权限'),num('qq.moderation.default_duration_seconds','未写时长默认禁言（分钟）','可随时修改；写明时长时优先使用你说的时长',{min:1,max:43200,scale:60}),bool('qq.moderation.nickname_fuzzy_match','识别近似昵称','优先使用@和QQ号；昵称打错字时，唯一近似候选可直接使用，重名才询问'),list('qq.moderation.allowed_group_uids','允许管理的群','每行一个完整群号；仅名单内的群可以管理'),select('qq.access.dm_policy','私聊接收范围',[['open','开放'],['allowlist','允许名单'],['disabled','关闭']]),list('qq.access.allowed_private_uids','允许私聊的QQ','保留完整QQ号，每行一个'),select('qq.access.group_policy','群聊接收范围',[['open','开放'],['allowlist','允许名单'],['disabled','关闭']]),list('qq.access.allowed_group_uids','允许接收消息的群','保留完整群号，每行一个')],advanced:[bool('qq.moderation.allow_local_owner','允许桌面主人管理已授权QQ群'),num('qq.moderation.max_duration_seconds','最长禁言时长（秒）','上限30天',{min:1,max:2592000}),num('qq.moderation.command_ttl_ms','管理指令有效期（秒）','过期指令不继续执行',{min:1,max:600,scale:1000}),select('qq.transport.mode','连接方式',[['forward','正向WebSocket'],['reverse','反向WebSocket']]),f('qq.transport.url','WebSocket地址'),f('qq.transport.host','反向监听地址'),num('qq.transport.port','反向监听端口','',{max:65535}),list('qq.access.admin_uids','会话管理员QQ','管理员权限与主人身份分别设置'),bool('qq.access.ignore_self','忽略自己发送的消息'),num('qq.writes.per_minute','每分钟最多发送数'),num('qq.writes.per_day','每天最多发送数'),bool('qq.conversation.interim_messages','发送处理中提示')]},
    }
    // Presentation only: paths, values, units, bounds and request handlers stay unchanged.
    const PRESENTATION = {
      mood:{labels:{enabled:'共用心情', 'policy.auto_judge':'自动感受心情变化','policy.inject_mode':'聊天时带入心情','policy.baseline':'平常心情（0—100）','policy.floor':'最低心情（0—100）','policy.decay_half_hours':'平复一半要多久（小时）','policy.significant_delta':'多大变化算明显','policy.inject_per_day':'每天最多带入次数'}},
      hormone:{more:[['活动与恢复',['policy.daily_token_budget','policy.rest_after_minutes','policy.recovery_half_hours','policy.day_energy_baseline','policy.daily_recovery']],['夜间与熬夜',['policy.night_start_hour','policy.night_end_hour','policy.night_energy_baseline','policy.debt_ratio','policy.debt_max','policy.debt_decay_hours']],['状态平复',['policy.stress_half_hours','policy.reward_half_minutes','policy.boredom_after_minutes','policy.boredom_half_hours']],['状态联动',['policy.stress_cost','policy.reward_cost','policy.reward_stress_decay','policy.stress_recovery']],['带入聊天',['policy.stress_high','policy.energy_low','policy.reward_high','policy.boredom_high','policy.reminder_minutes']]]},
      memory:{common:['memory.enabled','familiarity.sharing'],labels:{'memory.enabled':'记住发生的事','familiarity.sharing':'聊天时想起哪些熟人','memory.hit_limit':'聊天时最多想起几条','memory.max_injection_chars':'聊天时记忆字数上限','memory.consolidation_enabled':'允许整理记忆','memory.consolidation_batches_per_day':'每天最多整理几次','memory.consolidation_source_limit':'每次整理几条来源','memory.consolidation_max_chars':'每次整理字数上限','memory.backup_enabled':'自动备份','familiarity.max_people':'每次最多想起几个人','familiarity.max_context_chars':'熟人信息字数上限'},more:[['聊天时想起什么',['memory.hit_limit','memory.max_injection_chars','familiarity.max_people','familiarity.max_context_chars']],['整理与备份',['memory.consolidation_enabled','memory.consolidation_batches_per_day','memory.consolidation_source_limit','memory.consolidation_max_chars','memory.backup_enabled']]]},
      learning:{common:['enabled'],labels:{enabled:'学习总开关',max_reflections_per_task:'每轮最多记几条心得',max_context_chars:'聊天时心得字数上限',max_topics:'最多保留几个兴趣话题'}},
      learning_loop:{more:[['聊天时怎么用',['policy.max_hint_chars','policy.meme_cooldown_minutes','policy.recent_window_minutes','policy.max_meme_uses_per_context']],['试用与反馈',['policy.trial_uses_required','policy.positive_feedback_required']],['保存与重试',['policy.max_cards','policy.review_retry_minutes','policy.review_max_attempts']]]},
      opportunities:{labels:{enabled:'活动总开关','idle.enabled':'空闲时自己找事做','idle.min_idle_ms':'空闲多久后活动（分钟）','idle.explore_every_ms':'自动浏览间隔（分钟）','idle.chat_every_ms':'主动聊天间隔（分钟）','budget.urgent_human_allowed':'有人找时及时回应','idle.explore_platforms':'平时逛哪里','idle.qq_targets':'主动找谁聊天','qq.owner_conversation':'主人QQ号','qq.group_conversations':'主动聊天的群号','qq.private_conversations':'主动私聊的好友QQ号','qq.profile_authorized':'可以自己换头像和昵称','qq.quiet_start_hour':'安静时段开始（几点）','qq.quiet_end_hour':'安静时段结束（几点）',time_zone:'时区'},sections:[['什么时候活动',['idle.min_idle_ms','idle.explore_every_ms','idle.chat_every_ms']]],more:[['QQ主动聊天',['idle.qq_targets','qq.owner_conversation','qq.group_conversations','qq.private_conversations','qq.profile_authorized','qq.quiet_start_hour','qq.quiet_end_hour']],['活动范围与日期',['idle.explore_platforms','time_zone','holidays']]]},
      budget:{common:['budget.daily_token_limit','budget.daily_wake_limit'],labels:{'budget.daily_token_limit':'每天自动活动额度（Token）','budget.daily_wake_limit':'每天最多主动活动（次）','budget.max_task_tokens':'一轮最多用多少Token','budget.max_steps':'一轮最多操作几步','budget.human_reserve_tokens':'为新消息留出的Token','batching.max_concurrent':'最多同时处理几件事','batching.max_per_platform':'每个平台同时处理几件事','budget.reserve_tokens':'为一轮活动留出的Token','model.max_output_tokens':'谷时回答长度上限（Token）','model.peak_max_output_tokens':'峰时回答长度上限（Token）','batching.batch_ms':'消息等多久合并（秒）','batching.max_batch':'每批最多几条消息','mood_judge.max_per_day':'每天最多感受几次心情'},more:[['每轮用量',['budget.max_task_tokens','budget.max_steps','budget.reserve_tokens','budget.human_reserve_tokens']],['处理速度与回答',['batching.max_concurrent','batching.max_per_platform','batching.batch_ms','batching.max_batch','model.max_output_tokens','model.peak_max_output_tokens','model.tieba_incoming_max_output_tokens','mood_judge.max_per_day']]]},
      bilibili:{labels:{'bilibili.limits.read_per_round':'一轮最多看几个视频','bilibili.limits.reply_per_round':'一轮最多评论几条','bilibili.permissions.comment':'评论和回复','bilibili.interaction.reply_to_comments':'主动和评论区的人聊天','bilibili.permissions.dynamic':'发动态','bilibili.permissions.stickers':'用表情包','bilibili.interaction.comment_sample_size':'一轮参考几条评论','bilibili.sharing.enabled':'分享看到的内容','bilibili.permissions.direct_message':'回复私信','bilibili.permissions.live_danmaku':'发直播弹幕','bilibili.sharing.daily_limit':'每天最多分享几次','bilibili.risk.write_daily':'浏览评论和动态的每日上限','bilibili.risk.reply_daily':'每天最多回复来信几次','bilibili.risk.write_gap_ms':'两次发表间隔（秒）','bilibili.risk.read_daily':'每天最多读取几次','bilibili.transcription.enabled':'没字幕时转成文字','bilibili.transcription.model':'转写模型'},sections:[['刷视频',['bilibili.limits.read_per_round','bilibili.limits.reply_per_round']],['可以做什么',['bilibili.permissions.comment','bilibili.interaction.reply_to_comments','bilibili.permissions.dynamic','bilibili.permissions.stickers']],['兴趣',['bilibili.preferences.like','bilibili.preferences.dislike']]],more:[['其他互动',['bilibili.sharing.enabled','bilibili.permissions.direct_message','bilibili.permissions.live_danmaku','bilibili.sharing.daily_limit']],['每天的次数',['bilibili.risk.write_daily','bilibili.risk.reply_daily','bilibili.risk.write_gap_ms','bilibili.risk.read_daily']],['阅读与日记',['bilibili.interaction.comment_sample_size','bilibili.preferences.keywords','bilibili.transcription.enabled','bilibili.transcription.model','bilibili.diary.enabled','bilibili.diary.private_enabled']]]},
      inbox:{labels:{enabled:'自动查看新消息',scope:'看哪些提醒',poll_interval_ms:'隔多久检查（秒）',all_day:'全天检查',once_per_person:'每个人只回应一次',mention_summary:'带入被提到的内容',channels:'接收哪些消息',dm_scope:'接收谁的私信',dm_allowed_uids:'允许的B站用户ID',dm_seed_on_start:'开启时跳过旧私信',room_uid:'直播间号',live_scope:'接收哪些弹幕',live_ignore_uids:'忽略的B站用户ID',live_seed_on_start:'开启时跳过旧弹幕'},more:[['消息范围',['channels','once_per_person','mention_summary']],['私信',['dm_scope','dm_allowed_uids','dm_seed_on_start']],['直播弹幕',['room_uid','live_scope','live_ignore_uids','live_seed_on_start']]]},
      tieba:{common:['enabled',TIEBA_BARS,PROACTIVE_POST_BARS,'tieba.limits.read_per_round','tieba.limits.reply_per_round','tieba.limits.sub_reply_per_round','tieba.permissions.reply','tieba.permissions.sub_reply','tieba.permissions.new_thread','tieba.permissions.images','tieba.comment_inbox.enabled','tieba.comment_inbox.poll_interval_ms'],labels:{'tieba.limits.read_per_round':'一轮最多看几个帖子','tieba.limits.reply_per_round':'一轮最多回几条','tieba.limits.sub_reply_per_round':'其中楼中楼最多几条','tieba.ignored_reply_bars':'永久忽略来信的吧','tieba.comment_inbox.enabled':'有人回复时自动回应','tieba.comment_inbox.poll_interval_ms':'隔多久检查回复（秒）','tieba.permissions.reply':'评论和回帖','tieba.permissions.sub_reply':'回复到楼中楼','tieba.permissions.new_thread':'发新帖','tieba.permissions.images':'用图片和表情包','tieba.permissions.direct_message':'回复私信','tieba.inbox.enabled':'自动查看私信','tieba.comment_inbox.seed_on_start':'开启时跳过旧回复','tieba.comment_inbox.max_pages':'每次最多检查几页回复','tieba.inbox.allow_legacy_auth':'启用旧版私信登录','tieba.inbox.poll_interval_ms':'隔多久检查私信（秒）','tieba.inbox.gap_ms':'两条私信间隔（秒）','tieba.inbox.daily_limit':'每天最多发几条私信','tieba.inbox.seed_on_start':'开启时跳过旧私信','tieba.limits.reply_per_day':'每天最多回帖几条','tieba.limits.sub_reply_per_day':'每天最多回楼中楼几条','tieba.limits.new_thread_per_day':'每天最多发几个帖子','tieba.limits.reply_gap_ms':'两次回复间隔（秒）','tieba.learning.bar_style_enabled':'学习各个吧的说话方式','tieba.learning.persona_evolution_enabled':'学习后改进表达','tieba.expression.tone_gate_enabled':'减少客服腔'},sections:[['逛哪些吧',['tieba.bars']],['每轮数量',['tieba.limits.read_per_round','tieba.limits.reply_per_round','tieba.limits.sub_reply_per_round']],['可以做什么',['tieba.permissions.reply','tieba.permissions.sub_reply','tieba.permissions.new_thread','tieba.permissions.images']],['自动看回复',['tieba.comment_inbox.enabled','tieba.comment_inbox.poll_interval_ms','tieba.ignored_reply_bars']]],more:[['回帖上下文',['tieba.reply_context.peer_history_limit','tieba.reply_context.nearby_reply_limit']],['私信',['tieba.permissions.direct_message','tieba.inbox.enabled','tieba.inbox.allow_legacy_auth','tieba.inbox.poll_interval_ms','tieba.inbox.gap_ms','tieba.inbox.daily_limit','tieba.inbox.seed_on_start']],['次数与检查范围',['tieba.comment_inbox.seed_on_start','tieba.comment_inbox.max_pages','tieba.limits.reply_per_day','tieba.limits.sub_reply_per_day','tieba.limits.new_thread_per_day','tieba.limits.reply_gap_ms']],['学习与日记',['tieba.keywords','tieba.permissions.sign','tieba.learning.bar_style_enabled','tieba.learning.persona_evolution_enabled','tieba.expression.tone_gate_enabled','tieba.diary.enabled','tieba.diary.private_enabled']]]},
      qq:{labels:{'qq.access.require_mention':'群里只回应@我','qq.moderation.enabled':'管理员可以让我禁言、解禁','qq.moderation.default_duration_seconds':'没写时间时禁言多久（分钟）','qq.moderation.nickname_fuzzy_match':'能识别打错的昵称','qq.moderation.allowed_group_uids':'可以管理的群号','qq.access.dm_policy':'接收谁的私聊','qq.access.allowed_private_uids':'允许私聊的QQ号','qq.access.group_policy':'接收哪些群的消息','qq.access.allowed_group_uids':'接收消息的群号','qq.moderation.allow_local_owner':'主人可以从桌面管理群','qq.moderation.max_duration_seconds':'最长禁言时间（秒）','qq.moderation.command_ttl_ms':'禁言指令有效时间（秒）','qq.transport.url':'连接地址','qq.transport.host':'监听地址','qq.transport.port':'端口','qq.access.admin_uids':'管理员QQ号','qq.writes.per_minute':'每分钟最多发几条','qq.writes.per_day':'每天最多发几条','qq.conversation.interim_messages':'回复前显示处理中'},sections:[['群里怎么回应',['qq.participation.mode','qq.participation.window_ms','qq.participation.max_topics','qq.participation.mention_exempt','qq.participation.address_names','qq.participation.interest_terms','qq.participation.learned_interests']],['群管理',['qq.moderation.enabled','qq.moderation.default_duration_seconds','qq.moderation.nickname_fuzzy_match','qq.moderation.allowed_group_uids']]],more:[['谁能找我',['qq.access.dm_policy','qq.access.allowed_private_uids','qq.access.group_policy','qq.access.allowed_group_uids','qq.access.admin_uids']],['群管理细项',['qq.moderation.allow_local_owner','qq.moderation.max_duration_seconds','qq.moderation.command_ttl_ms']],['连接与发送',['qq.transport.mode','qq.transport.url','qq.transport.host','qq.transport.port','qq.access.ignore_self','qq.writes.per_minute','qq.writes.per_day','qq.conversation.interim_messages']]]},
    }
    const INPUT_HINTS={'expression.media_preference':'1 档更克制，10 档更愿意找图、收藏和用表情。合适才用，发图仍受各平台权限和额度限制。','qq.participation.mode':'兴趣先由本地候选筛选，再由大肥鱼决定是否开口；不感兴趣就保持安静。明确找我包括@、回复我的消息和直接叫配置的称呼。','qq.participation.window_ms':'滚动统计，每个群独立计算；引用同一话题或内容相近时合并，未发出不算实际参与。','qq.participation.max_topics':'0表示不设此项上限。同一话题连续交流不按消息条数累加，待发或结果未知的回复会暂占名额。','qq.participation.address_names':'每行一个，至少2个字；同时识别当前QQ人设名字。引用里的称呼不算直接找我。','qq.participation.interest_terms':'每行一个，至少2个字；只作为候选，不强制遇到关键词就回。','qq.participation.learned_interests':'只从有公开来源的学习兴趣中补充，不使用其他私聊的内容。','memory.max_injection_chars':'字数越少，聊天带入的记忆越省Token。','budget.daily_wake_limit':'0表示暂停主动活动。','budget.daily_token_limit':'手动执行单独统计。','bilibili.limits.reply_per_round':'0表示只看不说。','tieba.limits.reply_per_round':'0 表示不回帖。新主题使用单独的发帖权限。','tieba.limits.sub_reply_per_round':'包含在上面的回复总数里。','qq.group_conversations':'每行一个群号。','qq.quiet_end_hour':'与开始时间相同，表示不另设安静时段。','holidays':'每行一个日期，如2026-11-03。','tieba.inbox.allow_legacy_auth':'旧接口首次登录未加密，了解风险后再开启。','policy.daily_token_budget':'数值越大，同样的活动消耗精力越少。','policy.debt_max':'状态按0—100显示，这里限制熬夜带来的精力折损。','policy.night_end_hour':'与开始时间相同，表示不另设夜间时段。'}
    const ACTIVITY_SETTING_HELP={
      'idle.enabled':'空闲达到设定时长后，大肥鱼可以自己刷内容或主动聊天。',
      'idle.explore_every_ms':'两次自动浏览机会至少相隔多久。到时间还要符合空闲时长和活动时段。',
      'idle.chat_every_ms':'两次主动 QQ 聊天机会至少相隔多久。实际搭话取决于可联系的对象和安静时段。',
      'idle.explore_platforms':'选择空闲时轮流逛哪些平台。',
      'budget.urgent_human_allowed':'允许符合条件的真人来信在高峰时段也进入处理队列。',
      'budget.daily_wake_limit':'每天主动浏览、主动搭话和后台整理的次数上限。设为 0 会暂停这些活动。',
      'budget.daily_token_limit':'主动活动和来信回复共用的每日 Token 上限。手动执行的用量单独统计。',
      'budget.max_task_tokens':'限制一轮活动的模型总用量。超过上限后结束后续模型调用。',
      'budget.max_steps':'一轮活动最多让模型处理几步。读帖或调用工具后继续思考会进入下一步。',
      'budget.human_reserve_tokens':'每个真人来信任务开始前预留的默认 Token 数。',
      'budget.reserve_tokens':'普通自动任务开始前预留的默认 Token 数。',
      'batching.max_concurrent':'所有平台合计能同时运行几轮模型任务。生成好的内容由发表队列另行发送。',
      'batching.max_per_platform':'同一个平台能同时运行几轮模型任务，同时受总并发上限约束。',
      'batching.batch_ms':'普通自动任务在入队后等待多久再处理，以便合并可一起处理的来信。实时来信使用独立的等待设置。',
      'batching.max_batch':'一轮模型任务最多合并几条同范围的来信。内容过长或预算不足时会分批。',
      'model.max_output_tokens':'谷时每次模型调用最多生成多少 Token。主动活动的手动轮次和真人来信也使用这项上限，贴吧来信可单独设置。',
      'model.peak_max_output_tokens':'进入峰时的普通平台对话，每次模型调用最多生成多少 Token。有单独上限的活动按活动设置执行。',
      'model.tieba_incoming_max_output_tokens':'贴吧来信回复每次模型调用最多生成多少 Token。也包括手动补回的贴吧来信。',
      'mood_judge.max_per_day':'每天最多自动根据真实互动评估几次心情。设为 0 会暂停自动评估。',
    }
    const PLATFORM_SETTING_HELP={
      opportunities:{enabled:'控制后台浏览、主动聊天、来信处理和资料整理。开启后，各项活动继续按自己的设置和时段运行。'},
      tieba:{enabled:'开启后可以浏览贴吧、查看新回复和执行已授权的互动。','tieba.permissions.new_thread':'控制能否发新的贴吧主题。自主浏览和手动刷一轮还要核对允许发帖的吧。'},
      bilibili:{enabled:'开启后可以浏览 B 站、查看新消息和执行已授权的互动。','bilibili.permissions.dynamic':'允许大肥鱼在 B 站发布自己的动态。'},
      qq:{enabled:'开启 QQ 连接并接收符合当前会话规则的消息。'},
    }
    for(const [name,spec]of Object.entries(FIELDS)){
      const view=PRESENTATION[name]??{},all=[...spec.common,...spec.advanced],byPath=new Map(all.map(field=>[field.path,field]))
      for(const field of all){
        field.label=view.labels?.[field.path]??field.label
        field.hint=PLATFORM_SETTING_HELP[name]?.[field.path]??ACTIVITY_SETTING_HELP[field.path]??INPUT_HINTS[field.path]??(field.hint||(['list','lines'].includes(field.type)?'每行一项。':''))
      }
      if(view.common){const selected=new Set(view.common);spec.common=view.common.map(path=>byPath.get(path));spec.advanced=all.filter(field=>!selected.has(field.path))}
      for(const field of all)if(field.options)field.options=field.options.map(([key,label])=>[key,({'global':'所有平台的熟人','platform':'当前平台的熟人','allowlist':'指定名单','mentions':'@我','both':'回复和@我','replies':'评论回复'})[key]??label]);spec.sections=view.sections??[];spec.more_sections=view.more??[]
    }

    const CSS = `
.oj3{--oj-border:var(--dsw-alias-border-l2,#dfe3e9);--oj-muted:var(--dsw-alias-label-tertiary,#687484);--oj-brand:var(--dsw-alias-brand-primary,#3975df);--oj-bg:var(--dsw-alias-background-l1,transparent);container:companion-panel / inline-size;color:var(--dsw-alias-label-primary,#263244);font:13px/1.6 system-ui,sans-serif;width:100%;max-width:1060px;min-width:0;padding:8px 4px 28px;box-sizing:border-box;overflow-wrap:anywhere}
.oj3 *{box-sizing:border-box}
.oj3 h2,.oj3 h3,.oj3 h4{font-weight:600;line-height:1.4;overflow-wrap:anywhere}
.oj3 h2{font-size:20px;margin:0}.oj3 h3{font-size:16px;margin:0 0 6px}.oj3 h4{font-size:13px;margin:0}.oj3 p{margin:7px 0}
.oj3 button,.oj3 input,.oj3 textarea,.oj3 select{font:inherit;color:inherit;max-width:100%}
.oj3 button{cursor:pointer;line-height:1.45}.oj3 button:disabled{cursor:default;opacity:.5}
.oj3 button:focus-visible,.oj3 input:focus-visible,.oj3 textarea:focus-visible,.oj3 select:focus-visible,.oj3 summary:focus-visible{outline:2px solid var(--oj-brand);outline-offset:3px}
.oj3 .oj3-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:17px;min-width:0}.oj3-head>div{min-width:0}.oj3-head>.oj3-btn{flex:none}
.oj3 .oj3-subtitle,.oj3 .oj3-hint{color:var(--oj-muted);font-size:12px;line-height:1.6;overflow-wrap:anywhere}
.oj3 .oj3-nav{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:5px;padding:4px;border:1px solid var(--oj-border);border-radius:12px;margin-bottom:16px;min-width:0}
.oj3 .oj3-tab{border:0;background:transparent;padding:9px 6px;min-height:38px;min-width:0;border-radius:8px;white-space:nowrap;text-align:center}
.oj3 .oj3-tab[aria-selected=true]{background:var(--oj-brand);color:var(--dsw-alias-label-primary-foreground,#fff)}
.oj3 .oj3-layout{display:grid;grid-template-columns:142px minmax(0,1fr);gap:20px;align-items:start;min-width:0}
.oj3 .oj3-subnav{display:flex;flex-direction:column;gap:4px;border-right:1px solid var(--oj-border);padding-right:12px;position:sticky;top:8px;min-width:0}
.oj3 .oj3-subtab{border:0;background:transparent;text-align:left;padding:8px 10px;min-height:36px;min-width:0;border-radius:7px;color:var(--oj-muted);white-space:nowrap}
.oj3 .oj3-subtab[aria-selected=true]{background:rgba(100,130,180,.12);color:var(--oj-brand);font-weight:600}
.oj3 .oj3-content{min-width:0;width:100%}
.oj3 .oj3-card{border:1px solid var(--oj-border);border-radius:12px;padding:18px;margin-bottom:14px;background:var(--oj-bg);min-width:0;max-width:100%}
.oj3 .oj3-note{border-radius:8px;background:rgba(110,130,160,.08);padding:11px 13px;margin:10px 0;white-space:pre-wrap;overflow-wrap:anywhere;min-width:0;max-width:100%}
.oj3 .oj3-error{color:var(--dsw-alias-state-error-primary,#bc3d38);border:1px solid currentColor}.oj3 .oj3-success{color:var(--dsw-alias-state-success-primary,#27815b)}
.oj3 .oj3-row{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;padding:11px 0;border-bottom:1px solid var(--oj-border);min-width:0}.oj3-row>*{min-width:0}.oj3 .oj3-row:last-child{border-bottom:0}
.oj3 .oj3-form-row{display:grid;grid-template-columns:minmax(0,.9fr) minmax(0,1.1fr)}
.oj3 .oj3-label{flex:1;display:block;min-width:0;margin:0;line-height:1.6;overflow-wrap:anywhere}.oj3 .oj3-field-title{display:block;font-weight:500}
.oj3 .oj3-field-label{position:relative;display:flex;align-items:flex-start;gap:6px;min-width:0}.oj3 .oj3-field-label>.oj3-label{flex:0 1 auto}
.oj3 .oj3-setting-help{display:inline-flex;flex:none}
.oj3 .oj3-setting-help-button{display:inline-grid;place-items:center;width:22px;height:22px;min-width:22px;padding:0;border:1px solid var(--oj-border);border-radius:50%;background:transparent;color:var(--oj-muted);font-size:12px;font-weight:600}
.oj3 .oj3-setting-help-button:hover,.oj3 .oj3-setting-help-button[aria-expanded=true]{color:var(--oj-brand);border-color:currentColor}
.oj3 .oj3-setting-help-text{position:absolute;z-index:5;inset-block-start:100%;inset-inline-start:0;width:max-content;max-width:min(300px,calc(100cqi - 40px));padding:8px 10px;border:1px solid var(--oj-border);border-radius:8px;background:var(--dsw-alias-background-l2,light-dark(#fff,#26282c));box-shadow:0 4px 14px #0003;font-size:12px;line-height:1.65}
.oj3 .oj3-setting-help-text[hidden]{display:none}
.oj3 .oj3-field{display:block;background:var(--oj-bg);border:1px solid var(--oj-border);border-radius:7px;padding:8px 10px;width:100%;min-width:0;min-height:38px;line-height:1.5}
.oj3 .oj3-control{flex:0 1 320px;width:100%;min-width:0;max-width:100%}.oj3 .oj3-row-toggle{grid-template-columns:minmax(0,1fr) auto}.oj3 .oj3-control-toggle{width:auto;justify-self:end;display:flex;align-items:flex-start;padding-top:2px}
.oj3 textarea.oj3-field{min-height:86px;resize:vertical}.oj3 .oj3-manuscript{min-height:230px}
.oj3 input[type=checkbox]{display:inline-block;appearance:auto;flex:0 0 17px;width:17px;min-width:17px;max-width:17px;height:17px;min-height:17px;padding:0;accent-color:var(--oj-brand);margin:2px 0}
.oj3 .oj3-actions{display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin-top:14px;min-width:0}
.oj3 .oj3-btn{border:1px solid var(--oj-border);border-radius:7px;padding:7px 12px;min-height:36px;max-width:100%;background:transparent;white-space:normal;overflow-wrap:anywhere;text-align:center}
.oj3 .oj3-school-link{display:inline-flex;align-items:center;color:inherit;text-decoration:none}
.oj3 .oj3-primary{background:var(--oj-brand);border-color:transparent;color:var(--dsw-alias-label-primary-foreground,#fff)}
.oj3 .oj3-statgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,148px),1fr));gap:10px;margin:14px 0;min-width:0}
.oj3 .oj3-stat{container-type:inline-size;border:1px solid var(--oj-border);border-radius:9px;padding:12px;min-width:0;max-width:100%}
.oj3 .oj3-value{font-size:22px;font-size:clamp(12px,calc(150cqi / var(--oj-value-length,9)),22px);font-weight:600;font-variant-numeric:tabular-nums;line-height:1.35;margin-top:4px;white-space:nowrap;min-width:0}
.oj3 .oj3-badge{display:inline-block;border-radius:100px;padding:1px 8px;background:rgba(110,130,160,.12);font-size:11px;max-width:100%;overflow-wrap:anywhere}
.oj3 .oj3-inline{display:flex;gap:9px;align-items:center;flex-wrap:wrap;min-width:0}.oj3 label.oj3-inline{display:inline-flex;align-items:flex-start;flex-wrap:nowrap;max-width:100%;gap:8px;line-height:1.6}
.oj3 .oj3-stack{display:grid;gap:10px;min-width:0}.oj3 .oj3-divider{height:1px;background:var(--oj-border);margin:16px 0}
.oj3 details{border-top:1px solid var(--oj-border);margin-top:15px;padding-top:12px;min-width:0}.oj3 summary{cursor:pointer;color:var(--oj-muted);padding:3px 0;overflow-wrap:anywhere}
.oj3 .oj3-pre{white-space:pre-wrap;overflow-wrap:anywhere;margin:8px 0;font:inherit;max-height:340px;max-width:100%;overflow:auto;min-width:0}.oj3 code{font-size:11px;overflow-wrap:anywhere}
.oj3 .oj3-progress{height:5px;border-radius:4px;background:rgba(100,130,180,.13);overflow:hidden;margin:10px 0}.oj3-progress>span{display:block;height:100%;background:var(--oj-brand)}
.oj3 .oj3-execution-progress{margin:12px 0;min-width:0}.oj3 .oj3-progress-label{display:flex;justify-content:space-between;gap:10px;font-size:12px;color:var(--oj-muted)}.oj3 .oj3-progress-indeterminate>span{animation:oj3-pulse-progress 1.4s ease-in-out infinite}@keyframes oj3-pulse-progress{from{transform:translateX(-110%)}to{transform:translateX(390%)}}@media(prefers-reduced-motion:reduce){.oj3 .oj3-progress-indeterminate>span{animation:none;opacity:.6}}
.oj3 .oj3-platform-row>strong{flex:none}.oj3 .oj3-platform-state{flex:1;min-width:0;text-align:right}
.oj3 .oj3-qr{width:180px;max-width:100%;display:block;margin:12px 0}.oj3 ul{padding-left:20px}.oj3 .oj3-empty{padding:18px 0;color:var(--oj-muted)}
.oj3 .oj3-task-card{white-space:normal}.oj3 .oj3-task-summary{margin:8px 0;font-weight:500;overflow-wrap:anywhere}.oj3 .oj3-task-result{border:1px solid var(--oj-border);border-radius:8px;padding:11px;margin-top:10px;min-width:0}.oj3 .oj3-reply-text{margin:8px 0 0;padding:8px 10px;border-left:2px solid var(--oj-brand);white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;min-width:0}.oj3 .oj3-result-link{color:var(--oj-brand);text-decoration:underline;overflow-wrap:anywhere}.oj3 .oj3-task-observations{margin-top:9px}
.oj3 .oj3-quick-links,.oj3 .oj3-activity-toolbar,.oj3 .oj3-activity-filters{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.oj3 .oj3-setting-fold{margin:0;padding:8px 12px;border:1px solid var(--oj-border);border-radius:9px}
.oj3 .oj3-setting-fold>summary{font-weight:500;color:inherit}
.oj3 .oj3-setting-fold[open]>summary{margin-bottom:8px}
.oj3 .oj3-activity-toolbar .oj3-activity-search{flex:1 1 220px;width:auto}
.oj3 .oj3-activity-toolbar select{flex:0 1 auto;width:auto}
.oj3 .oj3-activity-filters{gap:6px;margin:10px 0 14px}
.oj3 .oj3-activity-filters .oj3-btn{display:flex;align-items:center;gap:6px;min-height:32px;padding:4px 10px}
.oj3 .oj3-activity-filters .oj3-btn span{color:var(--oj-muted);font-size:11px;font-variant-numeric:tabular-nums}
.oj3 .oj3-activity-filters .oj3-btn[aria-pressed=true]{border-color:var(--oj-brand);background:rgba(110,130,160,.12)}
.oj3 .oj3-activity-day h4{margin:18px 0 5px;color:var(--oj-muted);font-size:12px;font-variant-numeric:tabular-nums}
.oj3 .oj3-activity-day .oj3-task-card{border:0;border-top:1px solid var(--oj-border);border-radius:0;background:none;margin:0;padding:12px 2px;min-width:0}
.oj3 .oj3-activity-row-header,.oj3 .oj3-activity-row-footer{display:flex;justify-content:space-between;align-items:center;gap:7px;flex-wrap:wrap}
.oj3 .oj3-reply-like{min-height:32px;padding:4px 9px}
.oj3 .oj3-reply-like[aria-pressed=true]{border-color:var(--oj-brand);color:var(--oj-brand);background:rgba(110,130,160,.12)}
.oj3 .oj3-activity-platform{color:var(--oj-muted);font-size:12px}
.oj3 .oj3-activity-preview{margin:6px 0;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;overflow-wrap:anywhere;line-height:1.6}
.oj3 .oj3-task-card>details{margin-top:5px;padding-top:0;border:0}
.oj3 .oj3-activity-state[data-tone=success]{color:var(--dsw-alias-state-success-primary,#27815b);background:rgba(55,150,101,.12)}
.oj3 .oj3-activity-state[data-tone=warning]{color:var(--dsw-alias-state-warning-primary,#ad742a);background:rgba(199,147,69,.14)}
.oj3 .oj3-recent-source{padding:8px 10px;margin:8px 0;border-radius:7px;background:rgba(110,130,160,.07)}
.oj3 .oj3-recent-source p{margin:4px 0 0;font-size:12px;line-height:1.6;white-space:pre-wrap}
@container companion-panel (max-width:760px){.oj3 .oj3-layout{grid-template-columns:1fr;gap:12px}.oj3 .oj3-subnav{position:static;flex-direction:row;flex-wrap:wrap;border-right:0;border-bottom:1px solid var(--oj-border);padding:0 0 10px}.oj3 .oj3-subtab{text-align:center}}
@container companion-panel (max-width:680px){.oj3 .oj3-nav{grid-template-columns:repeat(3,minmax(0,1fr))}}
@container companion-panel (max-width:500px){.oj3 .oj3-card{padding:14px}.oj3 .oj3-statgrid{grid-template-columns:repeat(2,minmax(0,1fr))}.oj3 .oj3-statgrid>.oj3-stat:last-child:nth-child(odd){grid-column:1/-1}}
@container companion-panel (max-width:440px){.oj3 .oj3-form-row:not(.oj3-row-toggle){grid-template-columns:minmax(0,1fr);gap:7px}.oj3 .oj3-head{align-items:flex-start}.oj3 .oj3-control{flex-basis:100%}}
@container companion-panel (max-width:350px){.oj3 .oj3-statgrid{grid-template-columns:minmax(0,1fr)}.oj3 .oj3-nav{grid-template-columns:repeat(2,minmax(0,1fr))}}
.oj3 .oj3-head{margin-bottom:18px}.oj3 .oj3-head h2{font-size:22px;letter-spacing:.02em}.oj3 .oj3-nav{border:0;border-bottom:1px solid var(--oj-border);border-radius:0;padding:0 0 8px;gap:4px;margin-bottom:14px}.oj3 .oj3-tab{font-weight:500}.oj3 .oj3-layout{display:grid;grid-template-columns:minmax(0,1fr);gap:14px}.oj3 .oj3-subnav{display:flex;position:static;flex-direction:row;flex-wrap:wrap;gap:7px;border:0;padding:0;margin:0}.oj3 .oj3-subtab{flex:0 1 auto;min-height:32px;border:1px solid var(--oj-border);border-radius:18px;padding:5px 13px;text-align:center;white-space:normal}.oj3 .oj3-subtab[aria-selected=true]{font-weight:600}.oj3 .oj3-card{padding:18px;margin-bottom:14px;border-radius:12px}.oj3 .oj3-card>h3{font-size:16px;margin:0 0 12px}.oj3 .oj3-field-group{margin-top:20px}.oj3 .oj3-field-group>h4{font-size:12px;color:var(--oj-muted);font-weight:600;margin:0;padding:0 0 6px}.oj3 .oj3-field-group:first-child{margin-top:0}.oj3 .oj3-form-row{grid-template-columns:minmax(0,1fr) minmax(160px,.85fr);gap:16px;padding:12px 0}.oj3 .oj3-form-row:last-child{border-bottom:0}.oj3 .oj3-row-toggle{grid-template-columns:minmax(0,1fr) auto}.oj3 .oj3-field-title{font-size:13px}.oj3 .oj3-field{min-height:37px;border-radius:8px}.oj3 textarea.oj3-field{min-height:76px}.oj3 .oj3-manuscript{min-height:220px}.oj3 .oj3-btn{border-radius:8px}.oj3 .oj3-account-top{display:flex;justify-content:space-between;align-items:center;gap:12px}.oj3 .oj3-account-status{display:flex;align-items:center;gap:7px;font-weight:500}.oj3 .oj3-dot{height:7px;width:7px;border-radius:50%;background:var(--oj-muted);flex:none}.oj3 .oj3-dot-ready{background:#54ad80}.oj3 .oj3-dot-attention{background:#c79345}.oj3 .oj3-account-name{font-size:12px;color:var(--oj-muted);font-weight:400}.oj3 .oj3-account-tools{margin-top:12px}.oj3 .oj3-details{margin-top:10px;padding-top:8px}.oj3 .oj3-task-card>.oj3-inline{justify-content:space-between}.oj3 .oj3-task-summary{font-weight:400;font-size:13px}.oj3 .oj3-task-result{padding:10px;border-radius:8px}.oj3 .oj3-task-meta{font-size:11px;color:var(--oj-muted);margin-top:9px}.oj3 .oj3-statgrid{margin:10px 0;gap:9px}.oj3 .oj3-stat{border:0;background:rgba(115,130,150,.06);padding:12px;border-radius:9px}.oj3 .oj3-stat .oj3-value{font-size:clamp(12px,calc(150cqi / var(--oj-value-length,9)),23px)}.oj3 .oj3-status-list .oj3-platform-row{padding:12px 0}.oj3 .oj3-platform-row>.oj3-btn{min-height:30px;padding:4px 10px}.oj3 .oj3-platform-state{text-align:left}.oj3 .oj3-note{border-radius:8px}.oj3 details>summary{font-size:12px}.oj3 .oj3-primary{font-weight:500}
@container companion-panel (max-width:680px){.oj3 .oj3-nav{grid-template-columns:repeat(3,minmax(0,1fr))}}
@container companion-panel (max-width:440px){.oj3 .oj3-form-row:not(.oj3-row-toggle){grid-template-columns:minmax(0,1fr);gap:7px}.oj3 .oj3-card{padding:14px}.oj3 .oj3-account-top{align-items:flex-start}.oj3 .oj3-statgrid{grid-template-columns:minmax(0,1fr)}.oj3 .oj3-subtab{padding:5px 10px}.oj3 .oj3-platform-row{flex-wrap:wrap}}
`
    const get = (value,path) => path.split('.').reduce((row,key)=>row?.[key],value)
    const set = (value,path,child) => {const keys=path.split('.');let row=value;for(const key of keys.slice(0,-1))row=row[key]??=(Object.create(null));row[keys.at(-1)]=child}
    const split = value => String(value).split(/[\n,，]+/).map(row=>row.trim()).filter(Boolean)
    function tiebaBarChoiceName(value){
      if(typeof value!=='string'||value.isWellFormed?.()===false||value.length>1440||/[\0\r\n]/.test(value))return ''
      let name=value.trim()
      if(/%[0-9a-f]{2}/i.test(name)){try{name=decodeURIComponent(name)}catch{return ''}}
      return name.length<=160&&!/[\0\r\n]/.test(name)?name.trim():''
    }
    function tiebaBarOptions(value){
      const options=new Map()
      for(const raw of Array.isArray(value)?value:split(value??'')){
        const name=tiebaBarChoiceName(raw)
        if(name&&!options.has(name))options.set(name,raw.trim())
      }
      return [...options].map(([name,stored])=>[stored,name])
    }
    const printable = value => value===undefined||value===null?'—':typeof value==='number'?value.toLocaleString('zh-CN'):String(value)
    const dateText = value => {if(value===null||value===undefined||value==='')return '';const date=new Date(value);return Number.isNaN(date.getTime())?'':date.toLocaleString('zh-CN',{hour12:false})}
    const hint = text => text?h('div',{className:'oj3-hint'},text):null
    const note = (text,error=false) => text?h('div',{className:'oj3-note'+(error?' oj3-error':''),role:error?'alert':'status'},text):null
    const button = (label,onClick,disabled=false,primary=false,extra={}) => h('button',{type:'button',className:'oj3-btn'+(primary?' oj3-primary':''),onClick,disabled,...extra},label)
    const card = (title,subtitle,...children) => h('section',{className:'oj3-card'},h('h3',null,title),hint(subtitle),...children)
    const foldSettings=(label,...children)=>h('details',{className:'oj3-setting-fold'},h('summary',null,label),h('div',{className:'oj3-stack'},...children))
    const stat=(label,value)=>{const text=printable(value);return h('div',{className:'oj3-stat'},hint(label),h('div',{className:'oj3-value',style:{'--oj-value-length':Math.max(8,String(text).length)}},text))}
    const busyTask = task => ['queued','leased','running','pending','submitted'].includes(task?.status)
    const taskState = task => ({queued:'排队中',pending:'排队中',leased:'执行中',running:'执行中',submitted:'已提交',completed:'已完成',done:'已完成',failed:'执行失败',blocked:'受限',cancelled:'已取消',draft:'待确认',unknown:'结果待核对'}[task?.display_status??task?.status]??(task?.status?'状态待确认':'尚无任务'))
    const taskReason = reason => ({ready:'等待执行',reply_wait:'等待平台回复额度恢复',valley:'等待谷时',peak:'等待谷时',outside_valley:'等待谷时',valley_ending:'本次谷时快结束了，等待下一次机会',budget:'今日自主预算不足',money_budget:'共享费用预算不足，暂停新的模型调用',disabled:'主动活动已关闭',platform_blocked:'平台暂时受限，等待处理',owner_bar_ignored:'已永久忽略此吧来信',quiet_hours:'当前处于安静时段',approval_required:'等待确认发表',completed:'已完成',running:'正在执行',leased:'已领取任务',no_runner:'暂时无法执行'}[reason]??reason??'')
    const platformLabel = state => {
      const status=state?.status||state?.login_state
      const labels={inbox_partial:'部分收件通道受限',inbox_error:'收件检查失败，等待重试',quota_exhausted:'读取额度已用完，收件暂停',ready:'已就绪',verification_stale:'上次登录核验成功，等待刷新核验',unavailable:'暂时不可用',error:'平台状态暂时无法读取',connected:'已连接',connecting:'连接中',disconnected:'未连接',paused:'已暂停',verification_required:'需要手动验证',account_mismatch:'账号与当前绑定不一致',signed_out:state?.credential_configured?'登录待确认':'未登录'}
      return labels[status]||state?.message||state?.reason||status||(state?.connected===true?'已连接':state?.connected===false?'未连接':'状态尚未确认')
    }
    function createOperationGate(){const active=new Map();return {busy:key=>active.has(key),run(key,fn){if(active.has(key))return active.get(key);const promise=Promise.resolve().then(fn).finally(()=>active.delete(key));active.set(key,promise);return promise}}}
    function decodeField(field,value){
      if(field.type==='boolean')return !!value
      if(field.type==='choices'){if(!Array.isArray(value)||value.some(key=>!field.options.some(option=>option[0]===key)))throw new Error(field.label+'选项无效');return field.options.filter(([key])=>value.includes(key)).map(([key])=>key)}
      if(field.type==='qq_owner'){const id=String(value??'').trim().replace(/^private:/,'');if(id&&!/^[1-9][0-9]{3,19}$/.test(id))throw new Error('请填写完整QQ号');return id?'private:'+id:''}
      if(['qq_groups','qq_contacts'].includes(field.type)){const group=field.type==='qq_groups',ids=(Array.isArray(value)?value:split(value)).map(id=>String(id).trim().replace(group?/^group:/:/^private:/,''));if(ids.some(id=>!/^[1-9][0-9]{3,19}$/.test(id)))throw new Error(group?'请填写完整群号':'请填写完整好友QQ号');return [...new Set(ids)].map(id=>(group?'group:':'private:')+id)}
      if(field.type==='list')return Array.isArray(value)?value:split(value)
      if(field.type==='lines')return Array.isArray(value)?value:String(value).split(/\r?\n/).map(row=>row.trim()).filter(Boolean)
      if(field.type==='number'){
        if(String(value).trim()==='')throw new Error(field.label+'不能为空')
        const result=Number(value);if(!Number.isFinite(result)||!field.decimal&&!Number.isSafeInteger(result)||result<(field.min??0)||field.max!==undefined&&result>field.max)throw new Error(field.label+'超出允许范围')
        let output=result*(field.scale??1);if(field.precision!==undefined){const rounded=Math.round(output);if(Math.abs(output-rounded)>0.000001)throw new Error(field.label+'最多保留'+field.precision+'位小数');output=rounded}if((!field.decimal||field.precision!==undefined)&&!Number.isSafeInteger(output))throw new Error(field.label+'数值过大');return output
      }
      if(field.type==='select'&&!field.options.some(([key])=>key===value))throw new Error(field.label+'选项无效')
      return String(value)
    }
    function buildPatch(edits,fields){const patch=Object.create(null);for(const field of fields)if(Object.hasOwn(edits,field.path))set(patch,field.path,decodeField(field,edits[field.path]));return patch}
    async function apiRequest(path,body,{fetcher=window.fetch.bind(window),signal}={}){
      const response=await fetcher(API+path,{method:body===undefined?'GET':'POST',credentials:'same-origin',signal,headers:{accept:'application/json',...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})})
      let data;try{data=await response.json()}catch{throw new Error('接口尚未就绪或未返回有效结果')}
      if(!response.ok||data?.ok!==true){const unavailable=[404,501,503].includes(response.status);throw Object.assign(new Error(unavailable?'此功能接口尚未就绪'+(data?.error?'：'+data.error:''):data?.error||data?.message||'操作未完成，未确认保存成功'),{conflict:response.status===409||data?.conflict===true,unavailable})}
      return data
    }
    async function readSettingsSnapshot(fetcher){
      const controller=typeof AbortController==='function'?new AbortController():undefined
      let timer
      try{
        const deadline=new Promise((_,reject)=>{timer=window.setTimeout(()=>{reject(new Error('读取设置超时，请点刷新重试'));controller?.abort()},12000)})
        return await Promise.race([apiRequest('/snapshot',undefined,{fetcher,signal:controller?.signal}),deadline])
      }finally{window.clearTimeout(timer)}
    }
    const useAlive = () => {const ref=React.useRef(true);React.useEffect(()=>{ref.current=true;return()=>{ref.current=false}},[]);return ref}
    function settingValue(value,path){const saved=get(value,path);if(saved!==undefined)return saved;if(value.platform!=='qq'||!path.startsWith('qq.participation.'))return saved;return ({mode:value.qq?.access?.require_mention===false?'all':'mentions',window_ms:600000,max_topics:3,mention_exempt:true,address_names:[],interest_terms:[],learned_interests:true})[path.slice('qq.participation.'.length)]}
    function FieldHelp({id,label,text}){
      const [state,setState]=React.useState('closed'),shown=state!=='closed'
      const preview=()=>setState(current=>current==='closed'?'preview':current)
      const leave=()=>setState(current=>current==='preview'?'closed':current)
      const close=()=>setState('closed')
      return h('span',{className:'oj3-setting-help',onMouseEnter:preview,onMouseLeave:leave},
        h('button',{type:'button',className:'oj3-setting-help-button','aria-label':'查看功能说明：'+label,'aria-expanded':shown,'aria-controls':id,
          'aria-describedby':shown?id:undefined,onFocus:preview,onBlur:close,onClick:()=>setState(current=>current==='pinned'?'closed':'pinned'),
          onKeyDown:event=>{if(event.key==='Escape'&&shown){event.stopPropagation();close()}}},'?'),
        h('span',{id,className:'oj3-setting-help-text',role:'tooltip',hidden:!shown},text))
    }
    function Field({field,value,onChange,disabled=false}){
      const id=React.useId?React.useId():'oj3-'+field.path
      const shown=field.type==='qq_owner'?String(value??'').replace(/^private:/,''):['qq_groups','qq_contacts'].includes(field.type)?(Array.isArray(value)?value.map(id=>id.replace(field.type==='qq_groups'?/^group:/:/^private:/,'')).join('\n'):value??''):
        ['list','lines'].includes(field.type)?Array.isArray(value)?value.join('\n'):value??'':field.scale&&typeof value==='number'?value/field.scale:value??''
      const props={id,className:'oj3-field',disabled,value:shown,onChange:event=>onChange(field.type==='boolean'?event.target.checked:event.target.value),'aria-label':field.label}
      let control
      if(field.type==='boolean')control=h('input',{id,type:'checkbox',disabled,checked:!!value,onChange:props.onChange,'aria-label':field.label})
      else if(field.type==='choices')control=h('div',{id,className:'oj3-inline',role:'group','aria-label':field.label},field.options.length?field.options.map(([key,label])=>h('label',{key,className:'oj3-inline'},
        h('input',{type:'checkbox',disabled,checked:Array.isArray(value)&&value.includes(key),'aria-label':field.label+'：'+label,onChange:event=>onChange(event.target.checked?[...new Set([...(Array.isArray(value)?value:[]),key])]:(Array.isArray(value)?value:[]).filter(item=>item!==key))}),label)):hint(field.emptyHint))
      else if(field.type==='select')control=h('select',props,field.options.some(([key])=>key==='')?null:h('option',{value:'',disabled:true},'请选择'),field.options.map(([key,label])=>h('option',{key,value:key},label)))
      else if(['list','lines','textarea','qq_groups','qq_contacts'].includes(field.type))control=h('textarea',{...props,rows:field.type==='textarea'?5:3})
      else control=h('input',{...props,type:field.type==='number'?'number':'text',...(field.type==='number'?{min:field.min??0,max:field.max,step:field.decimal?'any':1}:{}),autoComplete:'off'})
      const labelType=field.type==='choices'?'span':'label'
      return h('div',{'data-setting':field.path,className:'oj3-row oj3-form-row'+(field.type==='boolean'?' oj3-row-toggle':'')},
        h('div',{className:'oj3-field-label'},
          field.hint?h(FieldHelp,{id:id+'-help',label:field.label,text:field.hint}):null,
          h(labelType,{className:'oj3-label',...(labelType==='label'?{htmlFor:id}:{})},h('span',{className:'oj3-field-title'},field.label))),
        h('div',{className:'oj3-control'+(field.type==='boolean'?' oj3-control-toggle':'')},control))
    }
    function DocumentForm({document:doc,spec,title,subtitle,onSaved,fetcher}){
      const [edits,setEdits]=React.useState({}),[notice,setNotice]=React.useState(null),[busy,setBusy]=React.useState(false)
      const gate=React.useRef(createOperationGate()),alive=useAlive(),base=React.useRef(doc?.revision),latest=React.useRef(doc)
      latest.current=doc
      if(!doc)return card(title,subtitle,note('配置尚未就绪。'))
      const changed=Object.keys(edits).length>0
      const valueAt=path=>Object.hasOwn(edits,path)?edits[path]:settingValue(doc.value,path)
      const fields=[...spec.common,...spec.advanced].map(field=>field.path===PROACTIVE_POST_BARS?{...field,options:tiebaBarOptions(valueAt(TIEBA_BARS)),emptyHint:'先填写常逛的吧。'}:field)
      const proactiveField=fields.find(field=>field.path===PROACTIVE_POST_BARS)
      const rawSelection=valueAt(PROACTIVE_POST_BARS)
      const selectedNames=new Set(Array.isArray(rawSelection)?rawSelection.map(tiebaBarChoiceName):[])
      const selectedBars=proactiveField?.options.filter(([,name])=>selectedNames.has(name)).map(([stored])=>stored)
      if(!changed)base.current=doc.revision
      async function save(){
        if(gate.current.busy('operation'))return
        setBusy(true);setNotice(null)
        try{await gate.current.run('operation',async()=>{if(!Number.isSafeInteger(base.current))throw new Error('缺少配置版本，请重新读取');const postingBarsChanged=proactiveField&&(Object.hasOwn(edits,TIEBA_BARS)||Object.hasOwn(edits,PROACTIVE_POST_BARS));const patch=buildPatch(postingBarsChanged?{...edits,[PROACTIVE_POST_BARS]:selectedBars}:edits,fields);const result=await apiRequest('/documents/'+encodeURIComponent(doc.id),{expected_revision:base.current,patch},{fetcher});if(alive.current){setEdits({});setNotice({text:result.restart_required?'已保存，重新载入后生效':result.message??'已保存'});try{await onSaved?.()}catch(error){if(alive.current)setNotice({text:'已保存，刷新未完成：'+error.message,error:true})}}})}
        catch(error){if(alive.current)setNotice({text:error.message+(error.conflict?'；你的草稿仍保留，请读取最新设置后核对。':''),error:true})}finally{if(alive.current)setBusy(false)}
      }
      const rows=items=>items.map(field=>h(Field,{key:field.path,field:field.path===PROACTIVE_POST_BARS?proactiveField:field,value:field.path===PROACTIVE_POST_BARS?selectedBars:valueAt(field.path)??field.defaultValue,disabled:busy,onChange:value=>{if(!Object.keys(edits).length)base.current=latest.current.revision;setEdits(old=>({...old,[field.path]:value}))}}))
      const grouped=(items,sections=[])=>{const byPath=new Map(items.map(field=>[field.path,field])),used=new Set(sections.flatMap(([,paths])=>paths)),rest=items.filter(field=>!used.has(field.path));return h(React.Fragment,null,rows(rest),sections.map(([label,paths])=>{const selected=paths.map(path=>byPath.get(path)).filter(Boolean);return selected.length?h('section',{key:label,className:'oj3-field-group'},h('h4',null,label),rows(selected)):null}))}
      return card(title,subtitle,notice?note(notice.text,notice.error):null,grouped(spec.common,spec.sections),spec.advanced.length?h('details',{className:'oj3-details'},h('summary',null,'更多设置'),grouped(spec.advanced,spec.more_sections)):null,
        h('div',{className:'oj3-actions'},button(busy?'保存中…':'保存设置',save,busy||!changed,true),changed?button('刷新设置',async()=>{if(gate.current.busy('operation'))return;setBusy(true);try{await gate.current.run('operation',async()=>{await onSaved?.();if(alive.current){setEdits({});setNotice({text:'已重新读取，原草稿已清除'})}})}catch(error){if(alive.current)setNotice({text:error.message,error:true})}finally{if(alive.current)setBusy(false)}},busy):null,changed?hint('未保存'):null))
    }
    function OwnerInsights({platform='tieba',report=false,fetcher}){
      const [busy,setBusy]=React.useState(false),[error,setError]=React.useState(''),[result,setResult]=React.useState(null),[kind,setKind]=React.useState('voice'),[bar,setBar]=React.useState(''),[date,setDate]=React.useState(new Date(Date.now()+8*3600000).toISOString().slice(0,10)),gate=React.useRef(createOperationGate()),alive=useAlive()
      async function run(operation){if(gate.current.busy('insight'))return;setBusy(true);setError('');try{await gate.current.run('insight',async()=>{const value=await apiRequest(operation==='export'?'/persona/export':operation==='report'?'/activity/report':'/tieba/diagnostics',operation==='export'?{kind,platform,format:'text',...(kind==='bar_style'?{bar}:{})}:operation==='report'?{date}: {},{fetcher});if(!alive.current)return;setResult(value);if(operation==='export'){const blob=new Blob([value.text],{type:value.mime_type}),url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=value.filename;link.click();URL.revokeObjectURL(url)}})}catch(error){if(alive.current)setError(error.message)}finally{if(alive.current)setBusy(false)}}
      return card(report?'按日查看活动':'导出与检查',null,error?note(error,true):null,
        report?h('div',{className:'oj3-row'},h('label',null,'报告日期',h('input',{type:'date',value:date,onChange:event=>setDate(event.target.value)})),button('读取当日报告',()=>run('report'),busy)):h(React.Fragment,null,h('label',null,'导出内容',h('select',{'aria-label':'导出内容',value:kind,onChange:event=>setKind(event.target.value)},[['voice','当前语气'],['persona','当前人设'],...(platform==='tieba'?[['bar_style','吧内公开语料']]:[])].map(([value,label])=>h('option',{key:value,value},label)))),kind==='bar_style'?h('label',null,'吧名',h('input',{'aria-label':'导出语料吧名',value:bar,onChange:event=>setBar(event.target.value)})):null,button('下载文本',()=>run('export'),busy||kind==='bar_style'&&!bar.trim()),platform==='tieba'?button('只读自检',()=>run('diagnostics'),busy):null),
        result?.checks?h('ul',null,result.checks.map(row=>h('li',{key:row.id},row.label+'：'+({ok:'正常',warning:'请留意',blocked:'受限',unavailable:'暂不可读',unknown:'待核验',disabled:'未开启',not_applicable:'无需单独配置'})[row.status]))):null,
        result?.counts?h(React.Fragment,null,hint('已确认 '+result.counts.confirmed+'，未确认 '+result.counts.unknown+'，受限 '+result.counts.blocked+(result.truncated?'；仅显示限定范围。':'')),h('ul',null,result.items.map(row=>h('li',{key:row.id},row.platform+' · '+row.kind+' · '+row.status+'：'+row.text)))):null)
    }
    function PersonaForm({platform,record,onSaved,fetcher,enabled=true,showFollow=true}){
      const own=record?.own,effective=record?.effective,[draft,setDraft]=React.useState(()=>own?structuredClone(own):null),[busy,setBusy]=React.useState(false),[notice,setNotice]=React.useState(null)
      const dirty=React.useRef(false),gate=React.useRef(createOperationGate()),alive=useAlive()
      React.useEffect(()=>{if(!dirty.current&&own)setDraft(structuredClone(own))},[own?.id,own?.revision])
      if(!own||!draft)return card(NAMES[platform],null,note('人设尚未就绪，请先完成原生资料迁移。'))
      const update=(path,value)=>{dirty.current=true;setDraft(old=>{const next=structuredClone(old);set(next,path,value);return next})}
      const follow=platform!=='main'&&!!draft.follow_main,disabled=busy||follow
      async function save(){
        if(gate.current.busy('operation'))return;setBusy(true);setNotice(null)
        try{await gate.current.run('operation',async()=>{
          if(!Number.isSafeInteger(draft.revision))throw new Error('缺少人设版本，请重新读取')
          if(!draft.name?.trim())throw new Error('人格名称不能为空')
          const voice=structuredClone(draft.voice??{}),traits=structuredClone(draft.traits??{})
          for(const key of ['samples','quirks','particles','patterns'])if(voice[key]!==undefined)voice[key]=decodeField(f(key,key,'lines'),voice[key])
          for(const key of ['abstract','sharp','gentle','talkative','image_bias'])if(traits[key]!==undefined)traits[key]=decodeField(num(key,key,'',{min:0,max:10}),traits[key])
          const payload={expected_revision:draft.revision,reason:'在原生设置中修改人设',name:draft.name,self_ref:draft.self_ref??'我',owner_address:draft.owner_address??'主人',body_md:draft.body_md??'',traits,voice,follow_main:follow,...(platform!=='main'?{main_profile_id:draft.main_profile_id??'persona-main'}:{})}
          const result=await apiRequest('/profiles/'+platform,payload,{fetcher});if(alive.current){dirty.current=false;setNotice({text:result.message??'人设已保存'});try{await onSaved?.()}catch(error){if(alive.current)setNotice({text:'人设已保存，刷新未完成：'+error.message,error:true})}}
        })}catch(error){if(alive.current)setNotice({text:error.message+(error.conflict?'；你的独立稿仍保留，请读取最新人设后核对。':''),error:true})}finally{if(alive.current)setBusy(false)}
      }
      const row=(path,label,type='text',extra={})=>h(Field,{key:path,field:f(path,label,type,'',extra),value:get(draft,path),disabled,onChange:value=>update(path,value)})
      return card(NAMES[platform],platform==='main'?'用于「欧鲸鲸的家」的普通对话。':null,
        notice?note(notice.text,notice.error):null,
        platform!=='main'?hint(!enabled?'此平台人设已关闭':follow?'正在使用主人设':'独立人设'):null,
        platform!=='main'&&showFollow?h(Field,{field:bool('follow_main','使用主人设','关闭后单独设置。'),value:follow,disabled:busy,onChange:value=>update('follow_main',value)}):null,
        row('name','名字'),
        h('div',{style:{marginTop:14}},h('label',null,'人设正文',h('textarea',{className:'oj3-field oj3-manuscript','aria-label':'人设正文',value:draft.body_md??'',disabled,onChange:event=>update('body_md',event.target.value)}))),
        row('voice.samples','说话参考句','lines',{hint:'每行一句。'}),
        h('details',null,h('summary',null,'称呼与说话习惯'),row('self_ref','如何自称'),row('owner_address','怎么称呼主人'),['abstract','sharp','gentle','talkative','image_bias'].map((key,index)=>row('traits.'+key,['抽象程度','锋利程度','温和程度','话量','图片偏好'][index],'number',{min:0,max:10})),row('voice.quirks','说话小习惯','lines'),row('voice.particles','常用语气词','lines'),row('voice.patterns','参考句式','lines')),

        h('div',{className:'oj3-actions'},button(busy?'保存中…':'保存人设',save,busy||!dirty.current,true),button('刷新人设',async()=>{if(gate.current.busy('operation'))return;setBusy(true);try{await gate.current.run('operation',async()=>{const result=await onSaved?.();if(alive.current){const fresh=result?.profiles?.[platform]?.own??own;dirty.current=false;setDraft(structuredClone(fresh));setNotice({text:'已重新读取，原草稿已清除'})}})}catch(error){if(alive.current)setNotice({text:error.message,error:true})}finally{if(alive.current)setBusy(false)}},busy)),
        effective?h('details',null,h('summary',null,enabled?'查看正在使用的人设':'查看已保存的人设'),h('div',{className:'oj3-pre'},effective.name+'\n'+(effective.body_md??''))):null)
    }
    function QQMainPersona({record,document,canManage,onSaved,fetcher}){
      const [draft,setDraft]=React.useState(null),[busy,setBusy]=React.useState(false),[notice,setNotice]=React.useState(null)
      const gate=React.useRef(createOperationGate()),alive=useAlive()
      const own=record?.own,effective=record?.effective,ready=!!own&&!!effective&&!!document
      if(!ready)return card('QQ 人设',null,note('QQ 人设设置尚未就绪。'))
      const saved=own.follow_main===true
      const checked=draft?.follow_main??saved
      function change(followMain){
        setNotice(null)
        if(followMain===saved){setDraft(null);return}
        setDraft({follow_main:followMain,expected_revision:own.revision,expected_qq_revision:document.revision})
      }
      async function save(){
        if(!draft||!canManage||gate.current.busy('operation'))return
        setBusy(true);setNotice(null)
        try{await gate.current.run('operation',async()=>{
          const result=await apiRequest('/profiles/qq/follow-main',draft,{fetcher})
          if(!alive.current)return
          setDraft(null);setNotice({text:result.message??'QQ 人设来源已保存'})
          try{await onSaved?.()}catch(error){if(alive.current)setNotice({text:'已保存，刷新未完成：'+error.message,error:true})}
        })}catch(error){
          if(alive.current)setNotice({text:error.message,error:true})
        }finally{if(alive.current)setBusy(false)}
      }
      return card('QQ 人设',null,
        hint(saved?'正在使用主人设':'正在使用 QQ 独立人设'),
        h(Field,{field:bool('follow_main','使用主人设','开启后直接使用主人设，关闭后使用 QQ 独立人设。'),value:checked,disabled:busy||!canManage,onChange:change}),
        h('div',{className:'oj3-actions'},button(busy?'保存中…':'保存人设来源',save,busy||!draft||!canManage,true)),
        notice?note(notice.text,notice.error):null)
    }
    const tasksOf = activity => Array.isArray(activity?.tasks)?[...activity.tasks].sort((a,b)=>(b.updated_at??b.created_at??0)-(a.updated_at??a.created_at??0)):[]
    const resultUrl=value=>typeof value==='string'&&/^https:\/\/(?:tieba\.baidu\.com\/p\/[1-9]\d*(?:\?pid=[1-9]\d*)?|t\.bilibili\.com\/[1-9]\d*|www\.bilibili\.com\/video\/av[1-9]\d*)$/.test(value)?value:''
    function ReplyLearningButton({actionId,liked,fetcher,onChanged,removeOnly=false}){
      const [saved,setSaved]=React.useState(liked),[busy,setBusy]=React.useState(false),[error,setError]=React.useState('')
      const gate=React.useRef(createOperationGate()),alive=useAlive()
      React.useEffect(()=>{setSaved(liked);setError('')},[liked])
      async function toggle(){
        if(gate.current.busy('reply-like'))return
        const next=!saved
        setBusy(true);setError('')
        try{
          await gate.current.run('reply-like',async()=>{
            const result=await apiRequest('/learning/reply-likes',{action_id:actionId,liked:next},{fetcher})
            if(result.action_id!==actionId||result.liked!==next)throw Error('点赞状态尚未确认，请重试')
            if(alive.current){setSaved(result.liked);onChanged?.(actionId,result.liked)}
          })
        }catch(error){if(alive.current)setError(error.message)}finally{if(alive.current)setBusy(false)}
      }
      return h('div',{className:'oj3-reply-learning'},button(
        removeOnly?'撤回点赞':saved?'👍 已点赞':'👍 学这条',toggle,busy,false,{
          className:'oj3-btn oj3-reply-like','aria-label':removeOnly?'撤回这条回复的点赞':'学这条回复',
          ...(!removeOnly?{'aria-pressed':saved}:{}),title:saved?'撤回这条回复的点赞':'保存为大肥鱼的学习参考',
        }),error?note(error,true):null)
    }
    function replyLearningControl(action,options){
      if(!options||action?.status!=='confirmed'||typeof action.learned_by_owner!=='boolean'||typeof action.id!=='string'||!action.id)return null
      return h(ReplyLearningButton,{key:action.id,actionId:action.id,liked:action.learned_by_owner,...options})
    }
    function TaskAction({action,replyLearning}){
      const url=resultUrl(action.url)
      return h('article',{className:'oj3-task-result'},h('div',{className:'oj3-inline'},h('strong',null,action.label??'操作结果'),h('span',{className:'oj3-badge'},({confirmed:'已发送',queued:'等待发送',draft:'待确认',leased:'准备发送',submitting:'正在发送',submitted:'已提交',unknown:'结果待确认',blocked:'发送受限',cancelled:'已取消',failed:'发送失败'})[action.status]??action.status_label??taskState(action))),
        action.destination?hint(action.destination):null,action.text_preview?h('blockquote',{className:'oj3-reply-text'},action.text_preview):null,
        action.text_truncated?h('details',null,h('summary',null,action.text_complete===false?'展开原文片段':'展开完整原文'),h('div',{className:'oj3-pre'},action.text)):null,
        h('div',{className:'oj3-actions'},url?h('a',{className:'oj3-result-link',href:url,target:'_blank',rel:'noopener noreferrer'},'查看原帖'):null,replyLearningControl(action,replyLearning)),
        action.status!=='confirmed'&&action.detail?hint(action.detail):null)
    }
    function ProgressBar({label,current,total,active=false,complete=false}){
      const known=Number.isSafeInteger(total)&&total>0&&Number.isSafeInteger(current)&&current>=0,percent=known?Math.min(100,current/total*100):null
      return h('div',{className:'oj3-execution-progress'},h('div',{className:'oj3-progress-label'},h('span',null,label),known?h('span',null,current+' / '+total):null),h('div',{className:'oj3-progress'+(!known&&active?' oj3-progress-indeterminate':''),role:'progressbar','aria-label':label,...(known?{'aria-valuemin':0,'aria-valuemax':total,'aria-valuenow':Math.min(current,total)}:{'aria-valuetext':label})},h('span',{style:{width:known?percent+'%':complete?'100%':active?'35%':'0%'}})))
    }
    function TaskProgress({task}){
      if(!task)return null
      const p=task.report?.progress,stage=p?.stage??(task.status==='completed'?'已完成':task.reason==='peak'?'等待谷时':busyTask(task)?task.status==='queued'?'等待执行':'正在处理':taskState(task))
      if(stage==='已完成'&&!Number.isSafeInteger(p?.read_target))return null
      return h(ProgressBar,{label:stage==='已完成'?'浏览进度':stage,current:p?.read_current,total:p?.read_target,complete:stage==='已完成',active:['leased','running'].includes(task.status)||task.report?.pending_actions>0})
    }
    function listedTasks(activity, platform){
      const ordered=tasksOf(activity)
      const parentActions=new Set(ordered.filter(task=>task.execution==='model').flatMap(task=>task.report?.actions?.map(action=>action.id)??[]))
      const seenBatches=new Set()
      return ordered.filter(task=>{
        if(platform&&task.platform!==platform)return false
        if(task.execution==='publication'&&task.report?.actions?.some(action=>parentActions.has(action.id)))return false
        if(task.execution==='model'&&task.batch_id){
          if(seenBatches.has(task.batch_id))return false
          seenBatches.add(task.batch_id)
        }
        return true
      })
    }
    const taskTitle=task=>task.report?.title??(task.execution==='publication'?'发表':task.kind==='activity.explore'?'浏览':task.kind==='activity.chat'?'主动聊天':task.kind==='activity.maintenance'?'整理':'回应消息')
    const taskTrigger=task=>({manual:'手动',incoming:'新消息',autonomous:'自动'})[task.trigger]??''
    const ACTIVITY_VIEWS=[['all','全部'],['sent','已发送'],['pending','待处理'],['issues','需关注']]
    const ACTION_PENDING=new Set(['draft','queued','leased','submitting','submitted','pending'])
    const ACTIVITY_ISSUES=new Set(['unknown','blocked','failed'])
    const activityActions=task=>task.report?.actions??[]
    const foldActivityText=value=>String(value??'').normalize('NFKC').toLowerCase()
    const activityDay=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'})
    const activityTime=new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',hour:'2-digit',minute:'2-digit',hourCycle:'h23'})

    function activityOutcome(task){
      const actions=activityActions(task),report=task.report,state=task.display_status??task.status
      const sent=actions.some(action=>action.status==='confirmed')||(report?.confirmed_actions??0)>0
      const waiting=actions.some(action=>ACTION_PENDING.has(action.status))||(report?.pending_actions??0)>0
      const issue=actions.find(action=>ACTIVITY_ISSUES.has(action.status))
      const hasUnknown=(report?.unknown_actions??0)>0
      const issues=!!issue||hasUnknown||ACTIVITY_ISSUES.has(state)||Boolean(report?.finish_note&&busyTask(task)===false)
      const pending=waiting||ACTION_PENDING.has(state)||state==='running'
      const label=issues&&sent?'部分完成':issue?({unknown:'结果待核对',blocked:'发送受限',failed:'发送失败'})[issue.status]:
        hasUnknown?'结果待核对':
        issues&&report?.finish_note&&!ACTIVITY_ISSUES.has(state)?'处理未完成':
        waiting?(actions.some(action=>action.status==='submitting')?'正在发送':actions.every(action=>action.status==='draft')&&actions.length?'待确认':'待发送'):
        sent?'已发送':taskState(task)
      return {sent,pending,issues,label,tone:issues?'warning':pending?'pending':sent||['completed','done'].includes(state)?'success':'neutral'}
    }

    function activityTypeMatches(task,type){
      if(!type)return true
      if(type==='reply')return activityActions(task).some(action=>/^(?:tieba\.(?:reply|message)|bilibili\.(?:comment|reply)|qq\.send)$/u.test(action.kind??''))||
        task.execution!=='publication'&&['activity.incoming','activity.chat'].includes(task.kind)
      if(type==='post')return activityActions(task).some(action=>['tieba.post','bilibili.dynamic'].includes(action.kind))
      return task.kind===type
    }

    function activitySearchText(task){
      const report=task.report
      return foldActivityText([NAMES[task.platform]??task.platform,taskTitle(task),report?.summary,report?.reason_detail,
        ...activityActions(task).flatMap(action=>[action.label,action.destination,action.text??action.text_preview,action.url,action.detail]),
        ...(report?.sources??[]).flatMap(source=>[source.destination,source.text,source.url])].filter(Boolean).join(' '))
    }

    function RecentEvent({task,outcome=activityOutcome(task),view='all',terms=[],replyLearning}){
      const report=task.report,actions=activityActions(task),sources=report?.sources??[]
      const matchesView=action=>view==='sent'?action.status==='confirmed':view==='pending'?ACTION_PENDING.has(action.status):view==='issues'?ACTIVITY_ISSUES.has(action.status):true
      const primary=actions.find(action=>matchesView(action)&&terms.length&&terms.every(term=>foldActivityText([action.text,action.text_preview,action.destination,action.url].join(' ')).includes(term)))??
        actions.find(matchesView)??actions[0]
      const link=resultUrl(primary?.url??sources[0]?.url)
      const at=task.updated_at??task.created_at,time=Number.isFinite(at)?activityTime.format(at):''
      const detail=report?.reason_detail||report?.finish_note||(task.reason&&!['completed','ready','running','leased','peak','valley'].includes(task.reason)?taskReason(task.reason):'')
      const preview=primary?.text_preview||sources[0]?.text||report?.summary
      const destination=primary?.destination??sources[0]?.destination??''
      const stamps=[report?.started_at?['开始',report.started_at]:null,report?.finished_at?['结束',report.finished_at]:null].filter(Boolean)
      const seconds=stamps.length===2&&report.finished_at>=report.started_at?Math.round((report.finished_at-report.started_at)/1000):null
      const elapsed=seconds===null?'':seconds<60?'耗时 '+seconds+' 秒':'耗时 '+Math.floor(seconds/60)+' 分 '+seconds%60+' 秒'
      return h('article',{className:'oj3-note oj3-task-card'},
        h('header',{className:'oj3-activity-row-header'},
          h('div',{className:'oj3-inline'},h('span',{className:'oj3-activity-platform'},NAMES[task.platform]??task.platform??'系统'),h('strong',null,primary?.label??taskTitle(task))),
          h('div',{className:'oj3-inline'},h('time',{className:'oj3-task-meta'},time),h('span',{className:'oj3-badge oj3-activity-state','data-tone':outcome.tone},outcome.label))),
        preview?h('p',{className:'oj3-activity-preview'},preview):null,
        h('div',{className:'oj3-activity-row-footer'},
          h('span',{className:'oj3-task-meta'},[destination,taskTrigger(task)].filter(Boolean).join(' · ')),
          h('div',{className:'oj3-inline'},replyLearningControl(primary,replyLearning),
            link?h('a',{className:'oj3-result-link',href:link,target:'_blank',rel:'noopener noreferrer'},primary?'查看原帖':'打开来源'):null)),
        h('details',{className:'oj3-details'},h('summary',null,'查看详情'),
          report?.summary?hint(report.summary):null,
          detail?hint(detail):null,
          task.kind==='activity.explore'||busyTask(task)?h(TaskProgress,{task}):null,
          actions.map(action=>h(TaskAction,{key:action.id,action,replyLearning:action===primary?undefined:replyLearning})),
          report?.actions_total>actions.length?hint('共 '+report.actions_total+' 项操作，已显示 '+actions.length+' 项。'):null,
          sources.length?h('details',null,h('summary',null,'来信与来源'),sources.map(source=>h('div',{key:source.id,className:'oj3-recent-source'},
            h('div',{className:'oj3-inline'},h('strong',null,source.destination),resultUrl(source.url)?h('a',{href:source.url,target:'_blank',rel:'noopener noreferrer',className:'oj3-result-link'},'打开来源'):null),
            source.text?h('p',null,source.text+(source.truncated?'…':'')):null))):null,
          ...stamps.map(([label,timestamp])=>h('div',{key:label},hint(label+' '+dateText(timestamp)))),
          elapsed?hint(elapsed):null,
          report?.model_usage_known&&task.execution==='model'?hint('用量 '+printable(report.model_tokens)+' Token'):null,
          task.next_eligible_at?hint('预计开始 '+dateText(task.next_eligible_at)):null,
          (report?.notes??[]).map((text,index)=>h('div',{key:index},hint(text)))))
    }

    function TaskList({activity,platform,onRefresh,replyLearning}){
      const [filter,setFilter]=React.useState(platform??''),[view,setView]=React.useState('all')
      const [type,setType]=React.useState(''),[query,setQuery]=React.useState(''),[shown,setShown]=React.useState(12)
      const terms=foldActivityText(query).trim().split(/\s+/).filter(Boolean)
      const events=listedTasks(activity,platform||filter).filter(task=>{
        if(!activityTypeMatches(task,type))return false
        if(!terms.length)return true
        const searchable=activitySearchText(task)
        return terms.every(term=>searchable.includes(term))
      }).map(task=>({task,outcome:activityOutcome(task)}))
      const visible=events.filter(event=>view==='all'||event.outcome[view]),groups=new Map()
      for(const entry of visible.slice(0,shown)){
        const at=entry.task.updated_at??entry.task.created_at,day=Number.isFinite(at)?activityDay.format(at):'时间未知'
        if(!groups.has(day))groups.set(day,[])
        groups.get(day).push(entry)
      }
      const set=(setter,value)=>{setter(value);setShown(12)}
      const options=items=>items.map(([value,label])=>h('option',{key:value,value},label))
      return h(React.Fragment,null,
        h('div',{className:'oj3-activity-toolbar'},
          h('input',{className:'oj3-field oj3-activity-search',type:'search','aria-label':'搜索活动',placeholder:'搜回复内容、吧名或帖子链接',value:query,maxLength:160,onChange:event=>set(setQuery,event.target.value)}),
          !platform?h('select',{className:'oj3-field','aria-label':'任务平台',value:filter,onChange:event=>set(setFilter,event.target.value)},options([['','全部平台'],['tieba','贴吧'],['bilibili','B站'],['qq','QQ'],['system','系统']])):null,
          h('select',{className:'oj3-field','aria-label':'活动类型',value:type,onChange:event=>set(setType,event.target.value)},options([['','全部类型'],['reply','回复和聊天'],['post','发帖和动态'],['activity.explore','浏览'],['activity.maintenance','整理']])),
          onRefresh?button('刷新',onRefresh):null),
        h('div',{className:'oj3-activity-filters','aria-label':'按处理结果筛选'},
          ACTIVITY_VIEWS.map(([value,label])=>h('button',{key:value,type:'button',className:'oj3-btn','aria-pressed':view===value,onClick:()=>set(setView,value)},label,h('span',null,events.filter(event=>value==='all'||event.outcome[value]).length))),
          query||filter||type||view!=='all'?button('清除筛选',()=>{setQuery('');setFilter(platform??'');setType('');setView('all');setShown(12)}):null),
        groups.size?[...groups].map(([day,entries])=>h('section',{key:day,className:'oj3-activity-day'},h('h4',null,day),
          entries.map(({task,outcome})=>h(RecentEvent,{key:task.id,task,outcome,view,terms,replyLearning})))):h('div',{className:'oj3-empty'},query||filter||type||view!=='all'?'没有符合筛选条件的活动。':'暂时没有活动记录。'),
        visible.length>shown?button('显示更多（还有 '+(visible.length-shown)+' 条）',()=>setShown(old=>old+12)):null,
        activity?.total_tasks>tasksOf(activity).length?hint('搜索范围为已加载的最近活动，旧记录可按日查看。'):null)
    }
    function ManualRound({platform,activity,capabilities,onActivity,fetcher}){
      const [readLimit,setReadLimit]=React.useState(''),[replyLimit,setReplyLimit]=React.useState(''),[bar,setBar]=React.useState('')
      const [busy,setBusy]=React.useState(false),[notice,setNotice]=React.useState(null),[localTask,setLocalTask]=React.useState(null),gate=React.useRef(createOperationGate()),alive=useAlive()
      const rounds=tasksOf(activity).filter(task=>task.platform===platform&&task.kind==='activity.explore'&&task.execution==='model'),local=localTask?(rounds.find(task=>task.id===localTask.id)??localTask):null,running=rounds.find(task=>['leased','running'].includes(task.status)),manualQueued=rounds.find(task=>task.status==='queued'&&task.trigger==='manual'),autonomous=rounds.find(task=>task.status==='queued'&&task.trigger==='autonomous'),active=running??manualQueued??(busyTask(local)?local:null)??autonomous,current=running??manualQueued??local??rounds.find(task=>task.trigger==='manual')??autonomous
      const promotable=active?.status==='queued'&&(active.trigger??active.metadata?.trigger)==='autonomous',occupied=busyTask(active)&&!promotable
      const blocked=(activity?.blocks??[]).find(row=>row.platform===platform),available=capabilities?.rounds?.[platform]!==false
      async function run(){if(gate.current.busy('round')||occupied)return;setBusy(true);setNotice(null)
        try{await gate.current.run('round',async()=>{const limits={};if(String(readLimit).trim())limits.read_per_round=decodeField(num('read_per_round','仅本轮浏览数量','',{min:1,max:30}),readLimit);if(String(replyLimit).trim())limits.reply_per_round=decodeField(num('reply_per_round','仅本轮最多评论数','',{min:0,max:30}),replyLimit);const result=await apiRequest('/rounds',{platform,...limits,...(platform==='tieba'&&bar.trim()?{bar:bar.trim()}: {})},{fetcher});if(!result.task?.id||!result.task.status)throw new Error('接口未返回有效任务，尚未确认排队');if(alive.current){setLocalTask(result.task);await onActivity?.()}})}catch(error){if(alive.current)setNotice({text:error.message,error:true})}finally{if(alive.current)setBusy(false)}}
      const roundLimits=current?.round_limits??current?.target?.round_limits
      return card('手动刷一轮',null,
        h('details',null,h('summary',null,'只调整这一次'),hint('留空使用默认数量。'),platform==='tieba'?h(Field,{field:f('bar','指定贴吧','text','留空时从常逛的吧选择。指定的吧需要在允许名单里才能开新帖。'),value:bar,onChange:setBar,disabled:busy||occupied}):null,h(Field,{field:num('read_per_round','仅本轮浏览数量','1—30',{min:1,max:30}),value:readLimit,onChange:setReadLimit,disabled:busy||occupied}),h(Field,{field:num('reply_per_round','仅本轮最多评论数',platform==='tieba'?'0 表示不回帖。发新帖按吧名和发帖权限判断。':'0 表示只浏览。',{min:0,max:30}),value:replyLimit,onChange:setReplyLimit,disabled:busy||occupied})),
        h('div',{className:'oj3-actions'},button(busy?'正在排队…':occupied?taskState(current):promotable?'现在刷一轮':'刷一轮'+NAMES[platform],run,busy||occupied||!available,true)),
        current?h(TaskProgress,{task:current}):null,roundLimits?hint('本轮：浏览 '+roundLimits.read_per_round+' 条，最多评论 '+roundLimits.reply_per_round+' 条。'):null,!available?note('手动执行接口尚未就绪。'):null,blocked?note('当前限制：'+taskReason(blocked.reason)):null,current?.status==='blocked'?hint(taskReason(current.reason)):null,notice?note(notice.text,notice.error):null)
    }
    function InboxActions({snapshot,onActivity,onSaved,fetcher,platform='bilibili'}){
      const [busy,setBusy]=React.useState({}),[notices,setNotices]=React.useState({}),gate=React.useRef(createOperationGate()),alive=useAlive(),available=snapshot?.capabilities?.platform_actions?.[platform]??{}
      async function run(operation){if(gate.current.busy(operation))return;setBusy(old=>({...old,[operation]:true}));setNotices(old=>({...old,[operation]:null}));try{await gate.current.run(operation,async()=>{const result=await apiRequest('/platforms/'+platform+'/'+operation,{}, {fetcher});if(alive.current){setNotices(old=>({...old,[operation]:{text:operation==='check-private'?'待回复 '+(result.observed??0)+' 个对话，新消息 '+(result.queued??0)+' 条。':operation==='reconcile-today'?'今天核对 '+result.today+' 条，新增 '+result.queued+' 条，已回复 '+result.already_replied+' 条，待处理 '+result.pending+' 条，发送待确认 '+result.unknown_write+' 条，未找到 '+result.unresolved+' 条。'+(result.scan_complete?'':'还有内容未查完。'):(result.seeded?'已跳过旧回复。':'新回复：')+(result.queued??0)+' 条，待确认 '+(result.unresolved??0)+' 条。'}}));await onActivity?.();await onSaved?.()}})}catch(error){if(alive.current)setNotices(old=>({...old,[operation]:{text:error.message,error:true}}))}finally{if(alive.current)setBusy(old=>({...old,[operation]:false}))}}
      return card(platform==='tieba'?'消息回复':'消息回复',null,h('div',{className:'oj3-actions'},button(busy['check-inbox']?'正在检查评论…':'检查新回复',()=>run('check-inbox'),busy['check-inbox']||!available.check_inbox),platform==='tieba'?button(busy['check-private']?'正在检查私信…':'检查并回复私信',()=>run('check-private'),busy['check-private']||!available.check_private):button(busy['reconcile-today']?'正在补查…':'补回今天的评论',()=>run('reconcile-today'),busy['reconcile-today']||!available.reconcile_today,true)),Object.entries(busy).filter(([,value])=>value).map(([key])=>h(ProgressBar,{key,label:key==='check-inbox'?'检查新评论':key==='check-private'?'检查私信':'核对今日回复',active:true})),Object.entries(notices).filter(([,value])=>value).map(([key,value])=>h('div',{key},note(value.text,value.error))))
    }
    function AccountBinding({platform,snapshot,onSaved,fetcher}){
      const state=Array.isArray(snapshot.overview?.platforms)?snapshot.overview.platforms.find(row=>row.platform===platform):snapshot.overview?.platforms?.[platform]
      const [login,setLogin]=React.useState(null),[busy,setBusy]=React.useState(false),[notice,setNotice]=React.useState(null),gate=React.useRef(createOperationGate()),cookie=React.useRef(null),alive=useAlive()
      React.useEffect(()=>()=>{if(cookie.current)cookie.current.value=''},[])
      const available=snapshot.capabilities?.authentication?.[platform]!==false
      async function operation(type){if(gate.current.busy('login'))return;setBusy(true);setNotice(null);try{await gate.current.run('login',async()=>{const result=await apiRequest('/platforms/'+platform+'/login',{operation:type,...(login?.login_id?{login_id:login.login_id}:{})},{fetcher});if(!['waiting','confirmed','expired','cancelled'].includes(result.status))throw new Error('登录接口未返回有效状态');if(alive.current){setLogin(result);if(result.status==='confirmed')await onSaved?.()}})}catch(error){if(alive.current)setNotice({text:error.message,error:true})}finally{if(alive.current)setBusy(false)}}
      const image=typeof login?.qr_url==='string'&&(/^(?:data:image\/(?:png|jpeg|webp);base64,|\/api\/)/.test(login.qr_url))?login.qr_url:''
      const link=typeof login?.qr_url==='string'&&/^https:\/\//.test(login.qr_url)?login.qr_url:''
      async function importCookie(){
        if(gate.current.busy('login')||!available)return
        const value=cookie.current?.value??'';if(cookie.current)cookie.current.value=''
        if(!value.trim()){setNotice({text:'请粘贴登录信息（Cookie）',error:true});return}
        setBusy(true);setNotice(null)
        try{await gate.current.run('login',async()=>{const result=await apiRequest('/platforms/tieba/credentials',{cookie_header:value},{fetcher});if(result.status!=='confirmed'||!result.account?.uid)throw new Error('官方尚未确认绑定，原账号保持不变');if(alive.current){setLogin(result);setNotice({text:'登录信息已更新'+(result.account.name?'：'+result.account.name:'')});await onSaved?.()}})}catch(error){if(alive.current)setNotice({text:error.message,error:true})}finally{if(cookie.current)cookie.current.value='';if(alive.current)setBusy(false)}
      }
      async function resumeTieba(){if(gate.current.busy('login')||!available)return;setBusy(true);setNotice(null);try{await gate.current.run('login',async()=>{const result=await apiRequest('/platforms/tieba/resume',{official_check_completed:true},{fetcher});if(result.resumed!==true||result.old_actions_replayed!==false)throw new Error('官方状态尚未确认恢复');if(alive.current){setNotice({text:'已恢复使用'});await onSaved?.()}})}catch(error){if(alive.current)setNotice({text:error.message,error:true})}finally{if(alive.current)setBusy(false)}}
      async function inspectTieba(){if(gate.current.busy('login'))return;setBusy(true);setNotice(null);try{await gate.current.run('login',async()=>{const result=await apiRequest('/platforms/tieba/inspect-page',{}, {fetcher});if(alive.current){setNotice({text:result.readable?'贴吧网页正常':'贴吧网页暂时打不开',details:'HTTP '+result.http_status+' · 读取到 '+result.thread_count+' 条帖子。'+(result.detail??result.title??''),error:!result.readable});await onSaved?.()}})}catch(error){if(alive.current)setNotice({text:error.message,error:true})}finally{if(alive.current)setBusy(false)}}
      const connected=state?.authenticated===true||state?.connected===true,attention=['verification_required','account_mismatch','quota_exhausted','paused','inbox_error','inbox_partial'].includes(state?.status??state?.login_state),name=login?.account?.name??state?.account?.name??state?.account?.nickname??'',status=attention?platformLabel(state):connected?(platform==='qq'?'已连接':'已登录'):platformLabel(state)
      const heading=h('div',{className:'oj3-account-top'},h('div',{className:'oj3-account-status'},h('span',{className:'oj3-dot'+(attention?' oj3-dot-attention':connected?' oj3-dot-ready':''),'aria-hidden':true}),status),name?h('span',{className:'oj3-account-name'},name):null)
      const message=notice?h(React.Fragment,null,note(notice.text,notice.error),notice.details?h('details',{className:'oj3-details'},h('summary',null,'查看详细结果'),h('div',{className:'oj3-pre'},notice.details)):null):null
      if(platform==='tieba')return card('贴吧账号',null,heading,
        !available?note('登录操作暂不可用。'):null,
        h('details',{className:'oj3-account-tools',open:state?.credential_configured===false},h('summary',null,'更新登录'),
          h('label',{className:'oj3-label'},'登录信息（Cookie）',h('input',{className:'oj3-field',type:'password',ref:cookie,'aria-label':'登录信息（Cookie）',autoComplete:'new-password',spellCheck:false,maxLength:65536,placeholder:'粘贴Cookie',disabled:busy||!available})),
          h('div',{className:'oj3-actions'},button(busy?'登录中…':'登录贴吧',importCookie,busy||!available,true))),
        h('details',{className:'oj3-details'},h('summary',null,'登录遇到问题'),state?.reason?hint(state.reason):null,h('div',{className:'oj3-actions'},button('完成验证后恢复',resumeTieba,busy||!available),button('检查贴吧网页',inspectTieba,busy||!snapshot?.capabilities?.platform_actions?.tieba?.inspect_page))),message)
      return card(NAMES[platform]+'账号',null,heading,
        state?.reason?note(state.reason,true):null,
        platform==='bilibili'&&state?.inbox_health?.unresolved?hint('还有 '+state.inbox_health.unresolved+' 条回复待确认。'):null,
        platform==='bilibili'&&state?.read_budget?h('details',{className:'oj3-details'},h('summary',null,'查看状态'),hint('今日读取 '+state.read_budget.daily_used+' / '+state.read_budget.daily_limit),hint('上次检查 '+dateText(state.last_successful_poll_at))):null,
        !available?note('登录操作暂不可用。'):null,
        h('div',{className:'oj3-actions'},button(connected?'重新登录':'登录'+NAMES[platform],()=>operation('start'),busy||!available),login?.status==='waiting'?button('我已扫码',()=>operation('poll'),busy||!login.login_id):null,login?.status==='waiting'?button('取消',()=>operation('cancel'),busy||!login.login_id):null),
        image?h('img',{src:image,alt:NAMES[platform]+'登录二维码',className:'oj3-qr',referrerPolicy:'no-referrer'}):null,link?h('a',{href:link,target:'_blank',rel:'noreferrer noopener'},'打开登录页面'):null,
        login&&login.status!=='confirmed'?note({waiting:'请扫码确认',expired:'二维码过期了，请重新登录',cancelled:'已取消'}[login.status]):null,message)
    }

    function MemorySearch({fetcher}){
      const [query,setQuery]=React.useState(''),[items,setItems]=React.useState([]),[detail,setDetail]=React.useState(null),[busy,setBusy]=React.useState(false),[notice,setNotice]=React.useState(null),seq=React.useRef(0),alive=useAlive()
      async function search(){if(!query.trim())return;const request=++seq.current;setBusy(true);setDetail(null);setNotice(null);try{const result=await apiRequest('/memory/search?query='+encodeURIComponent(query.trim()),undefined,{fetcher});if(!Array.isArray(result.items))throw new Error('检索接口尚未返回有效列表');if(alive.current&&request===seq.current)setItems(result.items)}catch(error){if(alive.current&&request===seq.current)setNotice(error.message)}finally{if(alive.current&&request===seq.current)setBusy(false)}}
      async function read(id,offset=0){const request=++seq.current;setBusy(true);setNotice(null);try{const result=await apiRequest('/memory/read?id='+encodeURIComponent(id)+'&offset='+offset,undefined,{fetcher});if(!result.detail||result.detail.found===false)throw new Error(result.detail?.text??'读取接口尚未返回记忆详情');if(alive.current&&request===seq.current)setDetail({...result.detail,id:result.detail.id??id})}catch(error){if(alive.current&&request===seq.current)setNotice(error.message)}finally{if(alive.current&&request===seq.current)setBusy(false)}}
      return card('找记忆',null,
        h('form',{onSubmit:event=>{event.preventDefault();search()}},h('div',{className:'oj3-inline'},h('input',{className:'oj3-field','aria-label':'记忆关键词',placeholder:'一件事、一个话题或一段经历',value:query,onChange:event=>setQuery(event.target.value),style:{flex:1}}),button(busy?'检索中…':'查找',search,busy||!query.trim(),true))),notice?note(notice,true):null,
        !items.length?hint('输入关键词，查找记住的事。'):h('div',{className:'oj3-stack',style:{marginTop:14}},items.map(item=>h('article',{key:item.id,className:'oj3-note'},h('strong',null,item.title||String(item.summary??item.snippet??item.text??item.content??'一条记忆').slice(0,24)),h('div',{className:'oj3-pre'},item.summary??item.snippet??item.text??item.content??''),button('展开',()=>read(item.id),busy)))),
        detail?h('div',{className:'oj3-note'},h('h4',null,detail.title??'记忆详情'),h('pre',{className:'oj3-pre'},detail.content??detail.text??detail.body??''),hint(({active:'已记住',pending_confirmation:'待确认',archived:'已归档',forgotten:'已忘记'})[detail.status]??''),Number.isSafeInteger(detail.next_offset)&&detail.next_offset>0?button('继续看',()=>read(detail.id,detail.next_offset),busy):null):null)
    }
    function Diary({fetcher}){
      const [kind,setKind]=React.useState('public'),[platform,setPlatform]=React.useState(''),[items,setItems]=React.useState([]),[cursor,setCursor]=React.useState(null),[detail,setDetail]=React.useState(null),[status,setStatus]=React.useState(null),[busy,setBusy]=React.useState(false),[error,setError]=React.useState('')
      const seq=React.useRef(0),view=React.useRef('public:'),alive=useAlive();view.current=kind+':'+platform
      async function load(before){
        const request=++seq.current,current=kind+':'+platform;setBusy(true);setError('')
        try{const result=await apiRequest('/diary?kind='+kind+(platform?'&platform='+encodeURIComponent(platform):'')+(before?'&before='+encodeURIComponent(before):''),undefined,{fetcher});if(!Array.isArray(result.items))throw new Error('日记接口尚未返回有效列表');if(alive.current&&request===seq.current&&view.current===current){setItems(old=>before?[...new Map([...old,...result.items].map(item=>[item.id,item])).values()]:result.items);setCursor(result.next_cursor??null)}}catch(error){if(alive.current&&request===seq.current&&view.current===current)setError(error.message)}finally{if(alive.current&&request===seq.current&&view.current===current)setBusy(false)}
      }
      React.useEffect(()=>{load();apiRequest('/diary/status',undefined,{fetcher}).then(result=>{if(alive.current)setStatus(result)}).catch(error=>{if(alive.current)setError(error.message)})},[kind,platform])
      function change(type,value){seq.current++;setItems([]);setDetail(null);setCursor(null);setError('');if(type==='kind')setKind(value);else setPlatform(value)}
      async function read(id,offset=0){const request=++seq.current,current=kind+':'+platform;setBusy(true);setError('');try{const result=await apiRequest('/memory/read?id='+encodeURIComponent(id)+'&offset='+offset,undefined,{fetcher});if(!result.detail||result.detail.found===false)throw new Error('这条日记暂时无法读取');if(alive.current&&request===seq.current&&view.current===current)setDetail({...result.detail,id:result.detail.id??id})}catch(error){if(alive.current&&request===seq.current&&view.current===current)setError(error.message)}finally{if(alive.current&&request===seq.current&&view.current===current)setBusy(false)}}
      return card('日记',null,
        h('div',{className:'oj3-inline',role:'tablist','aria-label':'日记类型'},['public','private'].map(value=>h('button',{key:value,type:'button',role:'tab','aria-selected':kind===value,className:'oj3-btn'+(kind===value?' oj3-primary':''),onClick:()=>change('kind',value)},value==='public'?'公开日记':'私密日记'))),
        h('div',{className:'oj3-row oj3-form-row'},h('label',{className:'oj3-label',htmlFor:'oj3-diary-platform'},'筛选平台'),h('select',{id:'oj3-diary-platform',className:'oj3-field oj3-control',value:platform,onChange:event=>change('platform',event.target.value)},[['','全部平台'],['bilibili','B站'],['tieba','贴吧'],['qq','QQ'],['harness','主对话']].map(([value,label])=>h('option',{key:value,value},label)))),
        status?.counts?hint('公开 '+printable(status.counts.public)+' 条 · 私密 '+printable(status.counts.private)+' 条'):null,
        status?.enabled===false?note('日记记录当前关闭；已有日记仍可查看。'):null,error?note(error,true):null,
        items.length?h('div',{className:'oj3-stack'},items.map(item=>h('article',{key:item.id,className:'oj3-note'},h('div',{className:'oj3-inline'},h('strong',null,item.title??(NAMES[item.platform]??'日记')),h('span',{className:'oj3-badge'},kind==='public'?'公开':'私密'),hint(item.source_at!==null&&item.source_at!==undefined?dateText(item.source_at):item.diary_date||'时间未记录')),h('div',{className:'oj3-pre'},String(item.text??item.summary??'').slice(0,240)),button('打开日记',()=>read(item.id),busy)))):hint(busy?'正在读取日记…':'还没有日记。'),
        h('div',{className:'oj3-actions'},button('刷新日记',()=>load(),busy),cursor?button('更早的日记',()=>load(cursor),busy):null),
        detail?h('div',{className:'oj3-note'},h('h4',null,'日记原文'),h('pre',{className:'oj3-pre'},detail.text??detail.content??''),Number.isSafeInteger(detail.next_offset)&&detail.next_offset>0?button('继续读',()=>read(detail.id,detail.next_offset),busy):null):null,
        null)
    }
    function LearningItem({item,canManage=false,busy=false,onManage,onRead,onHistory}){
      const value=item.value,content=value.content,versions=[...(value.versions??[])].filter(row=>row.revision<value.revision).sort((a,b)=>b.revision-a.revision)
      const [version,setVersion]=React.useState(()=>String(versions[0]?.revision??'')),status={trial:'试用中，尚未验证',active:'已采用',paused:'已暂停',retired:'已停用'}[value.status]??'状态待核对',privacy={public:'公开来源',owner:'仅主人可用',conversation:'仅原会话可用'}[value.visibility]??'可见范围待核对'
      const texts=(label,rows)=>rows?.length?h('div',null,h('strong',null,label+'：'),rows.join('；')):null
      return h('article',{className:'oj3-note'},h('div',{className:'oj3-inline'},h('strong',null,content.label),h('span',{className:'oj3-badge'},{meme:'梗',phrase:'表达',habit:'习惯'}[value.kind]??'学习项'),h('span',{className:'oj3-badge'},status),hint('版本 '+value.revision)),
        h('div',{className:'oj3-pre'},content.meaning),h('details',{className:'oj3-details'},h('summary',null,'用法与注意'),texts('适用',content.applies_to),texts('不适用',content.avoid_in),texts('相关话题',content.cues),
          content.example_good?h('div',null,h('strong',null,'合适的例子：'),content.example_good):null,content.example_bad?h('div',null,h('strong',null,'避免这样用：'),content.example_bad):null),
        hint('实际用过 '+printable(value.used)+' 次 · 积极反馈 '+printable(value.positive)+' 次 · 纠正反馈 '+printable(value.negative)+' 次'),hint(privacy),value.last_offered_at?hint('最近提供给对话：'+dateText(value.last_offered_at)):null,
        h('details',{className:'oj3-details'},h('summary',null,'来源与版本'),hint(value.source_kind==='public_read'?'来自实际阅读':'来自主人教授'),
          content.source_quotes?.length?content.source_quotes.map((source,index)=>h('div',{key:source.evidence_id+':'+index,className:'oj3-note'},h('div',{className:'oj3-pre'},source.quote),onRead?button('查看来源',()=>onRead(source.evidence_id),busy):null)):hint('没有可展示的来源摘录。'),
          versions.length?versions.map(row=>h('div',{key:row.revision,className:'oj3-row'},h('div',null,h('strong',null,'版本 '+row.revision+' · '+row.content.label),hint(dateText(row.at))),h('div',{className:'oj3-pre'},row.content.meaning))):hint('还没有更早的版本。')),
        h('div',{className:'oj3-actions'},onHistory?button('查看应用记录',()=>onHistory(item.id),busy):null,['trial','active'].includes(value.status)?button('暂停这项',()=>onManage(item,'pause'),busy||!canManage):button('恢复试用',()=>onManage(item,'resume'),busy||!canManage),value.status!=='retired'?button('停用这项',()=>onManage(item,'retire'),busy||!canManage):null,versions.length?h(React.Fragment,null,h('select',{className:'oj3-field oj3-control','aria-label':'回滚版本：'+content.label,value:version,disabled:busy||!canManage,onChange:event=>setVersion(event.target.value)},versions.map(row=>h('option',{key:row.revision,value:String(row.revision)},'版本 '+row.revision))),button('回滚这项',()=>onManage(item,'rollback',Number(version)),busy||!canManage||!version)):null))
    }
    function LearningItems({snapshot,activity,onSaved,onActivity,fetcher}){
      const [items,setItems]=React.useState(null),[summary,setSummary]=React.useState(null),[query,setQuery]=React.useState(''),[status,setStatus]=React.useState(''),[busy,setBusy]=React.useState(false),[working,setWorking]=React.useState({}),[notice,setNotice]=React.useState(null),[detail,setDetail]=React.useState(null),[history,setHistory]=React.useState(null),[taskId,setTaskId]=React.useState('')
      const alive=useAlive(),seq=React.useRef(0),sourceSeq=React.useRef(0),gate=React.useRef(createOperationGate()),capabilities=snapshot.capabilities?.learning??{},pending=taskId&&tasksOf(activity).some(task=>task.id===taskId&&busyTask(task)),globalEnabled=snapshot.documents?.learning?.value.enabled!==false,enabled=globalEnabled&&snapshot.documents?.['learning-loop']?.value.enabled!==false&&summary?.enabled!==false
      async function load(){
        const current=++seq.current;setBusy(true)
        try{const result=await apiRequest('/learning/items?limit=100'+(query.trim()?'&query='+encodeURIComponent(query.trim()):'')+(status?'&status='+status:''),undefined,{fetcher});if(!Array.isArray(result.items))throw new Error('学习接口尚未返回有效列表');if(alive.current&&current===seq.current){setItems(result.items);setSummary(result.summary??null)}}catch(error){if(alive.current&&current===seq.current)setNotice({text:error.message,error:true})}finally{if(alive.current&&current===seq.current)setBusy(false)}
      }
      React.useEffect(()=>{load()},[status,snapshot])
      async function manage(item,operation,version){
        const key='manage:'+item.id;if(gate.current.busy(key))return;setWorking(old=>({...old,[key]:true}));setNotice(null)
        try{await gate.current.run(key,async()=>{await apiRequest('/learning/manage',{id:item.id,operation,expected_revision:item.revision,...(version===undefined?{}:{version})},{fetcher});if(alive.current){setNotice({text:operation==='pause'?'已暂停这项。':operation==='resume'?'已恢复试用。':operation==='retire'?'已停用，来源与记录保留。':'已回滚内容，真实使用与反馈记录保留。'});await load()}})}catch(error){if(alive.current)setNotice({text:error.message+(error.conflict?'；请刷新后核对最新记录。':''),error:true})}finally{if(alive.current)setWorking(old=>({...old,[key]:false}))}
      }
      async function consolidate(){
        if(gate.current.busy('consolidate'))return;setWorking(old=>({...old,consolidate:true}));setNotice(null)
        try{await gate.current.run('consolidate',async()=>{const result=await apiRequest('/learning/consolidate',{}, {fetcher});if(alive.current){setTaskId(result.task?.id??'');setNotice({text:result.queued===false&&result.status==='no_new_sources'?'暂时没有新的可整理来源。':result.task?'已发起整理，完成后刷新这里查看。':result.message??'暂时没有启动整理，请查看最近活动。'});try{await onActivity?.()}catch(error){if(alive.current)setNotice({text:(result.task?'已发起整理，':'')+'任务刷新未完成：'+error.message,error:true})}await load()}})}catch(error){if(alive.current)setNotice({text:error.message,error:true})}finally{if(alive.current)setWorking(old=>({...old,consolidate:false}))}
      }
      async function read(id,offset=0){const current=++sourceSeq.current;try{const result=await apiRequest('/memory/read?id='+encodeURIComponent(id)+'&offset='+offset,undefined,{fetcher});if(!result.detail||result.detail.found===false)throw new Error('这条来源暂时无法读取');if(alive.current&&current===sourceSeq.current)setDetail({...result.detail,id})}catch(error){if(alive.current&&current===sourceSeq.current)setNotice({text:error.message,error:true})}}
      async function readHistory(id){const current=++sourceSeq.current;try{const result=await apiRequest('/learning/detail?id='+encodeURIComponent(id)+'&limit=10',undefined,{fetcher});if(!result.item||!Array.isArray(result.usages)||!Array.isArray(result.feedback))throw new Error('应用记录暂时无法读取');if(alive.current&&current===sourceSeq.current)setHistory(result)}catch(error){if(alive.current&&current===sourceSeq.current)setNotice({text:error.message,error:true})}}
      return card('学到的表达与习惯','试用只是候选；会根据实际使用和真实反馈继续调整。',hint('按当前话题取少量相关内容，历史原文按需查。'),!enabled?note(globalEnabled?'表达学习当前关闭，已有记录仍可查看。':'学习总开关当前关闭，已有记录仍可查看。'):null,
        h('div',{className:'oj3-actions'},button(working.consolidate||pending?'正在整理…':'整理学过的内容',consolidate,working.consolidate||pending||!enabled||capabilities.consolidate!==true,true),button(busy?'读取中…':'刷新学习',load,busy)),
        h('div',{className:'oj3-row oj3-form-row'},h('label',{className:'oj3-label',htmlFor:'oj3-learning-query'},'找学过的表达'),h('input',{id:'oj3-learning-query',className:'oj3-field oj3-control',value:query,onChange:event=>setQuery(event.target.value),'aria-label':'找学过的表达'})),
        h('div',{className:'oj3-row oj3-form-row'},h('label',{className:'oj3-label',htmlFor:'oj3-learning-status'},'筛选状态'),h('select',{id:'oj3-learning-status',className:'oj3-field oj3-control',value:status,onChange:event=>{seq.current++;setStatus(event.target.value)},'aria-label':'筛选学习状态'},[['','全部状态'],['trial','试用中'],['active','已采用'],['paused','已暂停'],['retired','已停用']].map(([value,label])=>h('option',{key:value,value},label)))),
        button('查找表达',load,busy),summary?.counts?hint('试用 '+printable(summary.counts.trial)+' · 已采用 '+printable(summary.counts.active)+' · 暂停 '+printable(summary.counts.paused)+' · 停用 '+printable(summary.counts.retired)):null,
        Number.isSafeInteger(summary?.pending_sources)?hint('待整理来源 '+summary.pending_sources+' 条'):null,
        notice?note(notice.text,notice.error):null,items===null?hint(busy?'正在读取学过的内容…':'学习记录暂时无法读取。'):items.length?h('div',{className:'oj3-stack'},items.map(item=>h(LearningItem,{key:item.id+':'+item.revision,item,canManage:capabilities.manage===true&&enabled,busy:working['manage:'+item.id]===true,onManage:manage,onRead:read,onHistory:readHistory}))):hint('还没有符合条件的学习项。'),
        items?.length===100?hint('当前显示100项，可按关键词筛选。'):null,history?h('div',{className:'oj3-note'},h('h4',null,'应用记录 · '+history.item.value.content.label),history.usages.length?history.usages.map(use=>h('div',{key:use.id,className:'oj3-note'},hint((NAMES[use.platform]??'本机对话')+' · '+dateText(use.at)),h('div',{className:'oj3-pre'},use.excerpt??'原记录仅保留校验值'),hint('来源：'+use.source_ref))):hint('还没有实际应用记录。'),history.feedback.length?history.feedback.map((row,index)=>h('div',{key:'feedback:'+index},hint(dateText(row.at)+' · '+({positive:'积极反馈',negative:'负向反馈',correction:'纠正'}[row.polarity]??'反馈')))):hint('还没有明确反馈。'),hint('只展示最近10条；提供给模型与真正用出来分开记录。')):null,detail?h('div',{className:'oj3-note'},h('h4',null,'学习来源'),h('pre',{className:'oj3-pre'},detail.text??detail.content??''),resultUrl(detail.ref)?h('a',{href:resultUrl(detail.ref),target:'_blank',rel:'noreferrer'},'查看原文'):null,Number.isSafeInteger(detail.next_offset)&&detail.next_offset>0?button('继续读取来源',()=>read(detail.id,detail.next_offset)):null):null)
    }
    function ReplyLearningList({fetcher,onActivity}){
      const [open,setOpen]=React.useState(false),[items,setItems]=React.useState(null),[busy,setBusy]=React.useState(false),[error,setError]=React.useState('')
      const alive=useAlive(),seq=React.useRef(0)
      async function load(){
        const current=++seq.current
        setBusy(true);setError('')
        try{
          const result=await apiRequest('/learning/reply-likes?limit=30',undefined,{fetcher})
          if(!Array.isArray(result.items)||result.items.some(item=>!item||typeof item.action_id!=='string'||!item.action_id||typeof item.text!=='string'))throw Error('点赞列表暂时无法读取')
          if(alive.current&&current===seq.current)setItems(result.items)
        }catch(error){if(alive.current&&current===seq.current)setError(error.message)}
        finally{if(alive.current&&current===seq.current)setBusy(false)}
      }
      React.useEffect(()=>{if(open)load()},[open])
      function changed(actionId,liked){
        if(liked)return
        setItems(rows=>rows?.filter(item=>item.action_id!==actionId)??[])
        load()
        onActivity?.()
      }
      return h('details',{className:'oj3-setting-fold',onToggle:event=>setOpen(event.currentTarget.open)},
        h('summary',null,'已点赞的回复'),
        open?h('div',{className:'oj3-stack'},
          hint('在「最近活动」给回复点赞，大肥鱼聊到相关话题时可以参考。'),
          error?note(error,true):null,error?button('刷新点赞列表',load,busy):null,
          items?.length?items.map(item=>h('article',{key:item.action_id,className:'oj3-task-result'},
            hint([NAMES[item.platform],dateText(item.liked_at)].filter(Boolean).join(' · ')),
            h('p',{className:'oj3-activity-preview'},item.text),
            h(ReplyLearningButton,{actionId:item.action_id,liked:true,fetcher,onChanged:changed,removeOnly:true}))):
            busy?hint('正在读取点赞列表…'):!error?hint('还没有点赞的回复。'):null):null)
    }
    function TiebaAtmosphere({snapshot,fetcher}){
      const [items,setItems]=React.useState(null),[detail,setDetail]=React.useState(null),[busy,setBusy]=React.useState(false),[error,setError]=React.useState(''),alive=useAlive(),seq=React.useRef(0),available=snapshot.capabilities?.platform_actions?.tieba?.atmosphere===true
      async function load(bar){const current=++seq.current;setBusy(true);setError('');try{const value=await apiRequest('/tieba/atmosphere'+(bar?'?bar='+encodeURIComponent(bar):''),undefined,{fetcher});if(alive.current&&current===seq.current){if(bar)setDetail(value);else{if(!Array.isArray(value.items))throw Error('吧内参考尚未返回有效列表');setItems(value.items);setDetail(null)}}}catch(error){if(alive.current&&current===seq.current)setError(error.message)}finally{if(alive.current&&current===seq.current)setBusy(false)}}
      return card('各吧的参考','来自实际读到的公开内容，当前帖子和场景优先，样本少时不猜全吧口气。',
        button(busy?'读取吧内参考…':items?'刷新各吧样本':'查看各吧样本',()=>load(),busy||!available),!available?hint('当前实例暂时无法读取吧内参考。'):null,error?note(error,true):null,
        items?items.length?h('div',{className:'oj3-stack'},items.map(row=>h('article',{key:row.bar,className:'oj3-note'},h('div',{className:'oj3-inline'},h('strong',null,row.bar.replace(/吧$/,'')+'吧'),h('span',{className:'oj3-badge'},row.qualified?'有跨帖样本':'样本不足')),hint(row.thread_count+' 帖 · '+row.author_count+' 位作者 · '+row.sample_count+' 条参考'),hint('最近观察：'+dateText(row.updated_at)),button('看这吧的样本',()=>load(row.bar),busy)))):hint('还没有合格的阅读样本，正常读帖时会逐步积累。'):null,
        detail?h('div',{className:'oj3-note'},h('h4',null,detail.bar+' · 少量公开样本'),hint(detail.qualified?'仅作语气和接话方式参考，不代表全吧所有人。':'尚不足以形成跨帖参考，先按当前帖子正常回应。'),detail.samples?.map((row,index)=>h('div',{key:row.evidence_id+':'+index,className:'oj3-note'},hint(({help:'求助或解答',discussion:'讨论',banter:'轻松接话',other:'其他语境'})[row.scene]),h('div',{className:'oj3-pre'},row.text),resultUrl(row.ref)?h('a',{href:row.ref,target:'_blank',rel:'noreferrer'},'查看原帖'):null))):null)
    }
    function QQAffinity({fetcher}){
      const [items,setItems]=React.useState(null),[error,setError]=React.useState(''),alive=useAlive()
      React.useEffect(()=>{apiRequest('/qq-affinities',undefined,{fetcher}).then(result=>{if(result.decider!=='companion'||result.editable!==false||!Array.isArray(result.items))throw new Error('自主相处判断尚未就绪');if(alive.current)setItems(result.items)}).catch(error=>{if(alive.current)setError(error.message)})},[])
      return card('喜欢和讨厌的人','由它自己决定。',error?note(error,true):null,items===null&&!error?hint('正在读取自主判断…'):null,
        items?h('div',{className:'oj3-stack'},['liked','disliked'].map(attitude=>{const rows=items.filter(item=>item.attitude===attitude);return h('section',{key:attitude},h('h4',null,({liked:'喜欢的人',disliked:'讨厌的人'})[attitude]),rows.map(item=>h('article',{key:item.qq_uid,className:'oj3-note'},h('strong',null,item.display_name||item.qq_uid),hint('QQ '+item.qq_uid+' · '+dateText(item.decided_at)),h('div',null,item.reason),hint('依据 '+item.evidence_count+' 条真实互动'))),rows.length?null:hint('暂未形成该类判断'))})):null)
    }
    function peopleSummaryStatus(summary,{busy=false,available=true}={}){
      if(busy||summary?.status==='running')return '后台正在更新，已有结果仍可查看。'
      if(summary?.status==='queued')return '正在等待后台整理，已有结果仍可查看。'
      if(summary?.status==='ready')return dateText(summary.generated_at)?'大肥鱼整理于 '+dateText(summary.generated_at):'由大肥鱼根据现有互动整理。'
      if(summary?.status==='stale')return summary.generated_at?'显示上次保存的结果；可以点“重新总结”让大肥鱼更新。':'有新互动，等待后台整理。'
      if(summary?.status==='missing')return available?'后台尚未完成这位熟人的整理，也可以点“重新总结”。':'还没有大肥鱼写的总结，当前暂时无法启动整理。'
      if(summary?.status==='blocked'){const reason=typeof summary.reason==='string'?summary.reason:'';if(/格式不完整|已超时/.test(reason))return reason;const code=/费用|money/i.test(reason)?'money_budget':/预算|额度|token/i.test(reason)?'budget':/时段|谷时|峰时|peak|valley/i.test(reason)?'valley':/关闭|停用/.test(reason)?'disabled':/(?:没有|不足|不够).*(?:互动|来源|材料|证据)|(?:互动|来源|材料|证据).*(?:不足|不够)/.test(reason)?'no_sources':/资料.*变|来源.*变/.test(reason)?'source_changed':reason;return ({budget:'额度暂时不足，稍后再让大肥鱼整理。',token_budget:'额度暂时不足，稍后再让大肥鱼整理。',money_budget:'费用额度暂时不足，稍后再整理。',peak:'正在等待可整理的时段。',valley:'正在等待可整理的时段。',outside_valley:'正在等待可整理的时段。',disabled:'整理功能当前已关闭。',no_sources:'暂时还没有足够的互动可供总结。',source_changed:'资料有变化，需要重新整理。',failed:'这次暂时没能整理好，可以稍后再试。'})[code]??'这次暂时没法整理，可以稍后再试。'}
      return '暂时无法让大肥鱼整理总结。'
    }
    function PeopleDetail({detail,onRead,source,sourceBusy=false,sourceError='',summaryBusy=false,summaryAvailable=true}){
      const verification=row=>({companion_summary:'大肥鱼根据互动写的总结',companion_judgment:'大肥鱼的主观判断',source_record:'有来源的记忆',historical_unverified:'历史印象，未重新核验',confirmed_receipt:'已确认发表'})[row.verification]??'依据尚待核验'
      const sources=row=>{const valid=(Array.isArray(row.sources)?row.sources:[]).filter(value=>value&&['memory','evidence','journal'].includes(value.kind)&&typeof value.id==='string'&&value.id),refs=[...new Map(valid.map(value=>[value.kind+':'+value.id,value])).values()],url=resultUrl(row.source_ref);return h('details',{className:'oj3-details'},h('summary',null,'查看依据'),hint(verification(row)),refs.map((ref,index)=>h('div',{key:ref.kind+':'+ref.id},hint(({memory:'已保存的记忆',evidence:'原始互动记录',journal:'历史记录'})[ref.kind]),button(ref.kind==='journal'?'读取历史记录':'读取依据 '+(index+1),()=>onRead?.(ref.id,ref.kind),sourceBusy||!onRead))),url?h('a',{href:url,target:'_blank',rel:'noreferrer noopener'},'查看原帖'):null,!refs.length&&!url?hint(row.verification==='historical_unverified'?'来自历史记录，暂时没有可读取的原文。':'暂时没有可读取的原文。'):null)}
      if(detail?.found===false)return hint('还没有这个人的可核对资料。')
      if(!detail)return null
      if(!detail.cached&&detail.summary?.status!=='ready')return hint(peopleSummaryStatus(detail.summary,{busy:summaryBusy,available:summaryAvailable}))
      return h('div',{className:'oj3-stack'},hint(peopleSummaryStatus(detail.summary)),
        h('section',null,h('h4',null,'我的印象'),detail.impressions.length?detail.impressions.slice(0,3).map(row=>h('article',{key:row.id,className:'oj3-note'},h('div',{className:'oj3-inline'},row.label?h('strong',null,row.label):null,hint([NAMES[row.platform]??'',dateText(row.at)].filter(Boolean).join(' · '))),h('div',{className:'oj3-pre'},row.text),sources(row))):hint('暂时还没有形成对这个人的印象。')),
        h('section',null,h('h4',null,'我记得的近期互动'),detail.recent_events.length?detail.recent_events.slice(0,3).map(row=>h('article',{key:row.id,className:'oj3-note'},h('div',{className:'oj3-inline'},h('strong',null,row.label??({counterpart:'对方说',companion:'大肥鱼回复',memory:'记着的事'})[row.author]??'互动记录'),hint((NAMES[row.platform]??'')+(dateText(row.occurred_at)?' · '+dateText(row.occurred_at):' · 时间未记录'))),h('div',{className:'oj3-pre'},row.text),sources(row))):hint('还没有可核对的近期互动记录。')),
        sourceError?note(sourceError,true):null,sourceBusy?hint('正在读取依据…'):null,source?h('section',{className:'oj3-note'},h('h4',null,({memory:'记忆依据原文',evidence:'互动依据原文',journal:'历史记录原文'})[source.kind]??'依据原文'),h('pre',{className:'oj3-pre'},source.text??source.content??''),Number.isSafeInteger(source.next_offset)&&source.next_offset>source.offset?button('继续看依据',()=>onRead?.(source.id,source.kind,source.next_offset),sourceBusy||!onRead):null):null)
    }
    function People({fetcher,sharing,detailsAvailable=true,summaryAvailable=true}){
      const [items,setItems]=React.useState(null),[error,setError]=React.useState(''),[query,setQuery]=React.useState(''),[platform,setPlatform]=React.useState(''),[listBusy,setListBusy]=React.useState(false),[selected,setSelected]=React.useState(''),[detail,setDetail]=React.useState(null),[detailError,setDetailError]=React.useState(''),[detailBusy,setDetailBusy]=React.useState(false),[summaryBusy,setSummaryBusy]=React.useState(false),[summaryError,setSummaryError]=React.useState(''),[source,setSource]=React.useState(null),[sourceError,setSourceError]=React.useState(''),[sourceBusy,setSourceBusy]=React.useState(false),alive=useAlive(),listSeq=React.useRef(0),detailSeq=React.useRef(0),sourceSeq=React.useRef(0),selectedRef=React.useRef(''),view=React.useRef(0),summaryVersion=React.useRef(''),summaryFlights=React.useRef(new Map()),pollFlight=React.useRef(null),summaryAccess=React.useRef(summaryAvailable)
      summaryAccess.current=summaryAvailable
      const sameView=(id,version)=>alive.current&&selectedRef.current===id&&view.current===version
      const clearSource=()=>{sourceSeq.current++;setSource(null);setSourceError('');setSourceBusy(false)}
      const clearDetail=()=>{detailSeq.current++;view.current++;selectedRef.current='';summaryVersion.current='';setSelected('');setDetail(null);setDetailError('');setDetailBusy(false);setSummaryBusy(false);setSummaryError('');clearSource()}
      async function load(){const request=++listSeq.current;setListBusy(true);setError('');clearDetail();try{const params=new URLSearchParams();if(query.trim())params.set('query',query.trim());if(platform)params.set('platform',platform);const encoded=params.toString(),result=await apiRequest('/people'+(encoded?'?'+encoded:''),undefined,{fetcher});if(!Array.isArray(result.items))throw new Error('熟人接口尚未返回有效列表');if(alive.current&&request===listSeq.current)setItems(result.items)}catch(error){if(alive.current&&request===listSeq.current)setError(error.message)}finally{if(alive.current&&request===listSeq.current)setListBusy(false)}}
      React.useEffect(()=>{load()},[])
      React.useEffect(()=>{if(!detailsAvailable)clearDetail()},[detailsAvailable])
      async function readDetailWithTimeout(id){let timer;try{return await Promise.race([apiRequest('/people/detail?entity_id='+encodeURIComponent(id)+'&event_limit=3',undefined,{fetcher}),new Promise((_,reject)=>{timer=window.setTimeout(()=>reject(new Error('读取超时，请稍后重试。')),15000)})])}finally{window.clearTimeout(timer)}}
      async function fetchDetail(id,{version=view.current,loading=false}={}){if(!sameView(id,version))return;const request=++detailSeq.current;if(loading)setDetailBusy(true);try{const result=await readDetailWithTimeout(id);if(result.found!==false&&(result.person?.id!==id||!Array.isArray(result.impressions)||!Array.isArray(result.recent_events)||[...result.impressions,...result.recent_events].some(row=>!row||typeof row.id!=='string'||typeof row.text!=='string')))throw new Error('熟人详情与当前人物不一致，请重试');if(sameView(id,version)&&request===detailSeq.current){const fingerprint=JSON.stringify([id,result.summary?.status,result.summary?.generated_at,result.summary?.task_id]);if(result.summary?.status!=='ready'||summaryVersion.current!==fingerprint)clearSource();summaryVersion.current=fingerprint;setDetail(result);setDetailError('')}}catch(error){if(sameView(id,version)&&request===detailSeq.current)setDetailError(error.message)}finally{if(sameView(id,version)&&request===detailSeq.current)setDetailBusy(false)}}
      async function readPerson(id){if(!detailsAvailable)return;if(selectedRef.current===id){clearDetail();return}clearDetail();selectedRef.current=id;setSelected(id);await fetchDetail(id,{version:view.current,loading:true})}
      async function summarize(id,force=false,version=view.current){if(!summaryAccess.current||!sameView(id,version))return;setSummaryBusy(true);setSummaryError('');clearSource();const active=summaryFlights.current.get(id),work=active??Promise.resolve().then(()=>summaryAccess.current&&sameView(id,version)?apiRequest('/people/summarize',{entity_id:id,force},{fetcher}):{entity_id:id,status:'unavailable'});if(!active)summaryFlights.current.set(id,work);try{const result=await work;if(result.entity_id!==undefined&&result.entity_id!==id)throw new Error('总结任务与当前人物不一致，请重试');if(sameView(id,version)){await fetchDetail(id,{version});const state=result.summary??result;if(['blocked','unavailable'].includes(state.status))setSummaryError(peopleSummaryStatus(state))}}catch(error){if(sameView(id,version))setSummaryError(/[\u3400-\u9fff]/.test(error.message??'')?error.message:'这次暂时无法让大肥鱼整理，请稍后再试。')}finally{if(summaryFlights.current.get(id)===work)summaryFlights.current.delete(id);if(sameView(id,version))setSummaryBusy(false)}}
      React.useEffect(()=>{if(!detailsAvailable||!summaryAvailable||!selected||!['missing','stale','queued','running'].includes(detail?.summary?.status))return;const id=selected,version=view.current;let stopped=false;const timer=window.setInterval(()=>{if(stopped||!sameView(id,version)||pollFlight.current)return;const work=fetchDetail(id,{version});pollFlight.current=work;Promise.resolve(work).finally(()=>{if(pollFlight.current===work)pollFlight.current=null})},['queued','running'].includes(detail.summary.status)?4000:15000);return()=>{stopped=true;window.clearInterval(timer)}},[selected,detail,detailsAvailable,summaryAvailable])
      async function readSource(id,kind,offset=0){const person=selectedRef.current,version=view.current,fingerprint=summaryVersion.current,request=++sourceSeq.current;if(!person||(!detail?.cached&&detail?.summary?.status!=='ready')||summaryBusy||!['memory','evidence','journal'].includes(kind)||typeof id!=='string'||!id)return;setSource(null);setSourceBusy(true);setSourceError('');try{const params=new URLSearchParams({entity_id:person,kind,id,offset:String(offset),max_chars:'1200'}),result=await apiRequest('/people/source?'+params,undefined,{fetcher});if(result.found!==true){if(sameView(person,version)&&request===sourceSeq.current){setDetail(null);summaryVersion.current='';await fetchDetail(person,{version})}throw new Error('这条依据暂时无法读取')}if(result.entity_id!==person||result.id!==id||result.kind!==kind||!Number.isSafeInteger(result.offset)||result.offset<0||result.offset>offset||offset-result.offset>1||result.redacted!==true||typeof result.text!=='string')throw new Error('依据与当前人物不一致，请重试');if(sameView(person,version)&&request===sourceSeq.current&&summaryVersion.current===fingerprint)setSource(result)}catch(error){if(sameView(person,version)&&request===sourceSeq.current)setSourceError(error.message)}finally{if(sameView(person,version)&&request===sourceSeq.current)setSourceBusy(false)}}
      const inProgress=summaryBusy||['queued','running'].includes(detail?.summary?.status)
      return card('熟人',null,
        h('div',{className:'oj3-row oj3-form-row'},h('label',{className:'oj3-label',htmlFor:'oj3-people-query'},'名字或账号'),h('input',{id:'oj3-people-query',className:'oj3-field oj3-control',value:query,maxLength:120,onChange:event=>setQuery(event.target.value),onKeyDown:event=>{if(event.key==='Enter'){event.preventDefault();load()}}})),
        h('div',{className:'oj3-row oj3-form-row'},h('label',{className:'oj3-label',htmlFor:'oj3-people-platform'},'平台'),h('select',{id:'oj3-people-platform',className:'oj3-field oj3-control',value:platform,onChange:event=>setPlatform(event.target.value)},[['','全部平台'],['tieba','贴吧'],['bilibili','B站'],['qq','QQ']].map(([value,label])=>h('option',{key:value,value},label)))),
        button(listBusy?'正在查找…':'查找熟人',load),error?note(error,true):null,items===null&&!error?hint('正在读取熟人…'):null,!detailsAvailable?hint('熟人的印象与近况暂时不可读取。'):null,
        items?.length?h('div',{className:'oj3-stack'},items.map(item=>h('article',{key:item.id,className:'oj3-note'},h('div',{className:'oj3-inline'},h('strong',null,item.display_name||'未命名'),item.familiarity_score!==undefined?h('span',{className:'oj3-badge'},'熟悉度 '+item.familiarity_score):null,item.owner_confirmed?h('span',{className:'oj3-badge'},'主人'):null),
          h('details',{className:'oj3-details'},h('summary',null,'查看账号'),(item.identities??[]).map(identity=>h('div',{key:identity.namespace+':'+identity.platform_uid},hint((NAMES[identity.namespace]??identity.namespace)+' · '+identity.platform_uid)))),
          item.public_summary?.confirmed===true?h('p',null,item.public_summary.text):null,detailsAvailable?button(selected===item.id?'收起印象与近况':'查看印象与近况',()=>readPerson(item.id),false,false,{'aria-expanded':selected===item.id,'aria-label':(selected===item.id?'收起':'查看')+(item.display_name||'未命名')+'的印象与近况'}):null,
          selected===item.id?h('div',{className:'oj3-note'},detailBusy?hint('正在读取印象与近况…'):null,detailError?note(detailError,true):null,summaryError?note(summaryError,true):null,PeopleDetail({detail,onRead:readSource,source,sourceBusy,sourceError,summaryBusy,summaryAvailable}),detail?.found===true?button(inProgress?'正在整理…':'重新总结',()=>summarize(item.id,true),inProgress||detailBusy||!summaryAvailable):null,detail?.found===true&&!summaryAvailable?hint('当前不能启动新的整理，已有有效总结仍可查看。'):null):null))):items?hint('还没有符合条件的熟人记录。'):null)
    }
    function Portability({page,fetcher,onSaved,capabilities}){
      const [include,setInclude]=React.useState(false),[bundle,setBundle]=React.useState(''),[confirmed,setConfirmed]=React.useState(false),[busy,setBusy]=React.useState(false),[notice,setNotice]=React.useState(null),gate=React.useRef(createOperationGate()),alive=useAlive()
      const available=capabilities?.portability!==false
      async function transfer(){if(gate.current.busy('transfer')||!available||page==='import'&&(!confirmed||!bundle.trim()))return;setBusy(true);setNotice(null);try{await gate.current.run('transfer',async()=>{const result=await apiRequest('/portability/'+page,page==='export'?{include_credentials:include}:{bundle_path:bundle.trim(),confirmed:true},{fetcher});if(page==='export'&&(typeof result.bundle_path!=='string'||!result.bundle_path.trim())||page==='import'&&result.applied!==true&&!(result.accepted===true&&result.pending_restart===true))throw new Error('接口尚未确认'+(page==='export'?'导出文件':'恢复完成'));if(alive.current){setNotice({text:page==='export'?'备份已保存：'+result.bundle_path:result.pending_restart?'请重启Harness完成恢复。':'资料已恢复'});if(page==='import'){setConfirmed(false);await onSaved?.()}}})}catch(error){if(alive.current)setNotice({text:error.message,error:true})}finally{if(alive.current)setBusy(false)}}
      return card(page==='export'?'备份资料':'恢复备份',null,
        !available?note('搬家接口尚未就绪。'):null,page==='export'?h(Field,{field:bool('include','同时备份登录信息','含登录信息的备份只给自己用。'),value:include,disabled:busy,onChange:setInclude}):h(React.Fragment,null,
          h(Field,{field:f('bundle','备份文件路径'),value:bundle,disabled:busy,onChange:setBundle}),h(Field,{field:bool('confirm','确认使用这份备份'),value:confirmed,disabled:busy,onChange:setConfirmed})),
        h('div',{className:'oj3-actions'},button(busy?'处理中…':page==='export'?'生成备份':'恢复备份',transfer,busy||!available||page==='import'&&(!confirmed||!bundle.trim()),true)),notice?note(notice.text,notice.error):null)
    }
    function tokenStats(budget){
      const limit=budget.daily_token_limit??budget.limit,known=budget.known_tokens??budget.tokens??budget.used??budget.used_tokens,uncertain=budget.uncertain_tokens??0,reserved=budget.reserved_tokens??budget.reserved??0,remaining=typeof limit==='number'&&typeof known==='number'?Math.max(0,limit-known-uncertain-reserved):undefined
      return h(React.Fragment,null,h('div',{className:'oj3-statgrid'},stat('每日Token上限',limit),stat('已消耗Token',known),stat('剩余Token',remaining)),uncertain||reserved?h('details',{className:'oj3-details'},h('summary',null,'未结算用量'),uncertain?hint('待确认 '+uncertain+' Token'):null,reserved?hint('正在使用 '+reserved+' Token'):null):null)
    }
    const stateNumber=value=>typeof value==='number'&&Number.isFinite(value)?Math.round(value):undefined
    function HormoneState({state,showPrimary=true}){
      if(!state||state.available===false)return card('当前状态',null,note('精力和压力暂时无法读取，请刷新。'))
      const value=stateNumber,values=state.values??{},history=Array.isArray(state.history)?state.history.slice(-12).reverse():[]
      const reasons={human:'有人来互动',praised:'收到肯定',blamed:'收到批评或纠正',tool_error:'活动遇到错误',repeated_errors:'连续遇到错误',work_done:'完成一轮活动',work_failed:'活动未完成',work_cancelled:'活动已停止'}
      const platforms={qq:'QQ',bilibili:'B站',tieba:'贴吧',harness:'本机',system:'系统',web:'网页'}
      const entries=history.map((row,index)=>h('div',{key:row.at+':'+index,className:'oj3-row'},
        h('div',null,h('strong',null,reasons[row.reason]??'活动状态变化'),hint([dateText(row.at),platforms[row.platform]??''].filter(Boolean).join(' · '))),
        hint('压力 '+printable(value(row.values?.stress))+' · 精力 '+printable(value(row.values?.energy))+' · 愉悦 '+printable(value(row.values?.reward))+' · 无聊 '+printable(value(row.values?.boredom)))))
      return card('当前状态','各平台共用，随真实互动、活动和休息变化。',h('div',{className:'oj3-inline'},h('span',{className:'oj3-badge'},state.enabled?state.mode==='observe'?'只观察':'影响表达':'已关闭'),hint('状态范围 0—100')),
        h('div',{className:'oj3-statgrid'},showPrimary?stat('压力',value(values.stress)):null,showPrimary?stat('精力',value(values.energy)):null,stat('愉悦',value(values.reward)),stat('无聊',value(values.boredom)),stat('熬夜疲劳',value(state.sleep_debt)),stat('当前精力上限',value(state.energy_ceiling))),
        history.length?h('details',{className:'oj3-details'},h('summary',null,'最近变化'),entries):hint('还没有活动变化记录。'))
    }
    function UpdateCheck({snapshot,fetcher}){
      const status=snapshot.updates,[result,setResult]=React.useState(status?.last_result??null),[busy,setBusy]=React.useState(false),[error,setError]=React.useState(''),alive=useAlive()
      async function check(){if(busy)return;setBusy(true);setError('');try{const value=await apiRequest('/updates/check',{}, {fetcher});if(alive.current)setResult(value)}catch(error){if(alive.current){setError(error.message);setResult(null)}}finally{if(alive.current)setBusy(false)}}
      const labels={available:'发现新版本',current:'已是最新版本',local_ahead:'本机版本较新',unreleased:'GitHub 暂无正式发布版本'}
      return card('插件更新',null,h('div',{className:'oj3-inline'},hint('当前版本 '+(status?.current_version??'—')),button(busy?'检查中…':'检查更新',check,busy||snapshot.capabilities?.update_check!==true)),error?note(error,true):null,result?h('div',null,note((labels[result.status]??'检查完成')+(result.latest_version?' · GitHub '+result.latest_version:'')),hint('检查时间：'+dateText(result.checked_at)),h('div',{className:'oj3-actions'},result.status==='available'&&result.download_url?h('a',{href:result.download_url,target:'_blank',rel:'noreferrer'},'下载安装包'):null,h('a',{href:result.release_url,target:'_blank',rel:'noreferrer'},'查看 GitHub 发布'))):null)
    }
    function SchoolPanel({fetcher}){
      const [school,setSchool]=React.useState(null),[draft,setDraft]=React.useState({}),[busy,setBusy]=React.useState(''),[error,setError]=React.useState(''),alive=useAlive()
      const statusSequence=React.useRef(0)
      async function load(){
        const sequence=++statusSequence.current
        const result=await apiRequest('/school',undefined,{fetcher})
        if(alive.current&&sequence===statusSequence.current){setSchool(result);setDraft({})}
      }
      React.useEffect(()=>{load().catch(error=>{if(alive.current)setError(error.message)})},[])
      async function apply(operation,settings={}){
        if(busy)return
        ++statusSequence.current
        setBusy(operation);setError('')
        try{
          const result=await apiRequest('/school',{operation,...settings},{fetcher})
          if(operation==='run')await load()
          else if(alive.current){setSchool(result);setDraft({})}
        }
        catch(error){if(alive.current)setError(error.message)}
        finally{if(alive.current)setBusy('')}
      }
      const time=school?.next_at?new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',dateStyle:'short',timeStyle:'short'}).format(new Date(school.next_at)):''
      const schedule=school?.has_card===true?(school.active?'回园每 '+school.interval_seconds/60+' 分钟'+(time?' · 下次 '+time:''):'托儿所定时回园未启用'):''
      const minutes=draft.minutes??(school?.interval_seconds??1800)/60
      const enabled=draft.enabled??!!school?.active
      const intervalSeconds=Math.round(Number(minutes)*60)
      const settingsDisabled=!!busy||!school?.available
      return card('托儿所',null,
        h('div',{className:'oj3-inline'},
          h('a',{className:'oj3-btn oj3-school-link',href:'https://dafeiyutuo.com/',target:'_blank',rel:'noopener noreferrer'},'打开托儿所'),
          school?.has_card===false?button(busy==='enroll'?'入学中…':'一键入学',()=>apply('enroll'),!!busy||school.can_enroll===false,true):null,
          school?.has_card===true&&school.active?button('现在回园',()=>apply('run'),!!busy):null,
          button('刷新回园状态',()=>{setError('');load().catch(error=>{if(alive.current)setError(error.message)})},!!busy)),
        school?.has_card===false?h('div',{className:'oj3-hint'},'入学即同意',h('a',{href:'https://dafeiyutuo.com/terms',target:'_blank',rel:'noopener noreferrer'},'用户服务协议')):null,
        school?.has_card===true?h(React.Fragment,null,
          h(Field,{field:{path:'school.enabled',label:'定时回园总开关',type:'boolean'},value:enabled,disabled:settingsDisabled,onChange:value=>setDraft(previous=>({...previous,enabled:value}))}),
          h(Field,{field:{path:'school.minutes',label:'回园间隔（分钟）',type:'number',min:1,decimal:true},value:minutes,disabled:settingsDisabled,onChange:value=>setDraft(previous=>({...previous,minutes:value}))}),
          h('div',{className:'oj3-inline'},button('保存回园设置',()=>apply('configure',{enabled,interval_seconds:intervalSeconds}),
            settingsDisabled||!Number.isSafeInteger(intervalSeconds)||intervalSeconds<60||
            (enabled===school.active&&intervalSeconds===school.interval_seconds),true),hint(schedule))):null,
        school?.last?note(school.last.text,school.last.status==='failed'):null,
        school?.card_error?note(school.card_error,true):null,
        error?note(error,true):null)
    }
    function moodSnapshot(snapshot){
      const setting=snapshot.documents?.[snapshot.documents?.settings?.value?.mood_document_id??'mood']?.value
      return {...(snapshot.overview?.mood??setting?.state??{}),enabled:setting?.enabled!==false}
    }
    function CompanionState({snapshot,moodForm,hormoneForm}){
      const mood=moodSnapshot(snapshot),hormone=snapshot.overview?.hormone,active=hormone?.enabled===true
      const reason=typeof mood.reason==='string'?mood.reason.slice(0,240):''
      return h(React.Fragment,null,
        card('心情与状态','心情来自近期互动，精力和压力也会随活动、休息变化。',
          h('div',{className:'oj3-statgrid'},
            stat('心情',mood.enabled?stateNumber(mood.value??mood.mood):'已关闭'),
            stat('精力',active?stateNumber(hormone.values?.energy):hormone?.enabled===false?'已关闭':undefined),
            stat('压力',active?stateNumber(hormone.values?.stress):hormone?.enabled===false?'已关闭':undefined)),
          active&&hormone.mode==='observe'?hint('精力和压力当前只记录，不带入聊天。'):null),
        foldSettings('状态详情',reason?h('div',null,h('strong',null,'心情原因'),hint(reason)):null,h(HormoneState,{state:hormone,showPrimary:false})),
        foldSettings('详细设置',moodForm,hormoneForm))
    }
    function Overview({snapshot,activity,onOpenPlatform,onNavigate}){
      const budget=snapshot.overview?.budget??{},mood=moodSnapshot(snapshot),used=budget.known_tokens??budget.tokens??budget.used??budget.used_tokens
      return h(React.Fragment,null,
        card('常用入口',null,h('div',{className:'oj3-quick-links'},
          button('查看最近活动',()=>onNavigate('activity','queue')),button('设置平台',()=>onNavigate('platforms','tieba')),
          button('找记忆',()=>onNavigate('memory','search')),button('打开托儿所',()=>onNavigate('activity','school')))),
        card('今天',null,h('div',{className:'oj3-statgrid'},
          stat('已用 Token',used),stat('主动活动次数',budget.autonomous_wakes),stat('心情',mood.enabled?stateNumber(mood.value??mood.mood):'已关闭')),
          h('div',{className:'oj3-quick-links'},button('查看用量',()=>onNavigate('activity','budget')),button('心情与状态',()=>onNavigate('persona','state')))),
        card('平台连接',null,h('div',{className:'oj3-status-list'},['bilibili','tieba','qq'].map(platform=>{
          const state=Array.isArray(snapshot.overview?.platforms)?snapshot.overview.platforms.find(row=>row.platform===platform):snapshot.overview?.platforms?.[platform]
          return h('div',{key:platform,className:'oj3-row oj3-platform-row'},h('strong',null,NAMES[platform]),
            h('div',{className:'oj3-platform-state'},platformLabel(state)),button('设置',()=>onOpenPlatform(platform)))
        })),h('details',{className:'oj3-details'},h('summary',null,'运行详情'),['bilibili','tieba','qq'].map(platform=>{
          const lane=activity?.concurrency?.platforms?.[platform]
          return lane?hint(NAMES[platform]+'：处理 '+lane.models+' / '+activity.concurrency.model_limit_per_platform+'，发送 '+lane.publications+' / '+activity.concurrency.publication_limit_per_platform):null
        }))))
    }
    function Panel({initialSnapshot=null,fetcher,initialSection='overview',initialPage}={}){
      const first=NAV.find(row=>row[0]===initialSection)??NAV[0]
      const requestedPage=first[0]==='persona'&&['mood','hormone'].includes(initialPage)?'state':initialPage
      const firstPage=first[2].some(row=>row[0]===requestedPage)?requestedPage:first[2][0][0]
      const [section,setSection]=React.useState(first[0]),[page,setPage]=React.useState(firstPage),[snapshot,setSnapshot]=React.useState(initialSnapshot),[activity,setActivity]=React.useState(initialSnapshot?.activity??null),[error,setError]=React.useState(''),[loading,setLoading]=React.useState(!initialSnapshot)
      const alive=useAlive(),snapshotSeq=React.useRef(0),activitySeq=React.useRef(0)
      async function reload(){const seq=++snapshotSeq.current,activityVersion=++activitySeq.current;setLoading(true);try{const result=await readSettingsSnapshot(fetcher);if(!result.documents||!result.profiles)throw new Error('设置还没读到，请刷新');if(alive.current&&seq===snapshotSeq.current){setSnapshot(result);if(result.activity&&activityVersion===activitySeq.current)setActivity(result.activity);setError('')}return result}catch(error){if(alive.current&&seq===snapshotSeq.current)setError(error.message);throw error}finally{if(alive.current&&seq===snapshotSeq.current)setLoading(false)}}
      async function loadActivity(){const seq=++activitySeq.current;try{const result=await apiRequest('/activity',undefined,{fetcher});if(alive.current&&seq===activitySeq.current)setActivity(result.activity??result)}catch(error){if(alive.current&&seq===activitySeq.current)setError(error.message)}}
      React.useEffect(()=>{if(!initialSnapshot)reload().catch(()=>{})},[])
      const hasBusy=tasksOf(activity).some(busyTask)
      const showsActivity=section==='activity'&&['queue','budget'].includes(page)
      React.useEffect(()=>{if(!hasBusy&&!showsActivity)return;const timer=window.setInterval(loadActivity,8000);return()=>window.clearInterval(timer)},[hasBusy,showsActivity])
      const navigation=NAV.find(row=>row[0]===section),docs=snapshot?.documents??{},document=id=>docs[id],settings=docs.settings?.value??{}
      const form=(id,spec,title,subtitle)=>h(DocumentForm,{key:id+':'+title,document:document(id),spec:FIELDS[spec],title,subtitle,onSaved:reload,fetcher})
      let content=null
      if(snapshot){
        if(section==='overview')content=h(Overview,{snapshot,activity,onNavigate:(section,page)=>{setSection(section);setPage(page)},onOpenPlatform:platform=>{setSection('platforms');setPage(platform)}})
        if(section==='persona'){
          const separateQQFollow=page==='qq'&&snapshot.capabilities?.qq_main_persona===true&&!!document('qq')
          if(page==='speech')content=form(settings.speech_document_id??'speech','speech','表达提醒','生成回复前提醒大肥鱼少用套话、留意最近的重复句式。')
          else if(page==='media')content=form('settings','shared_media','共享表情与图库','QQ、B站和贴吧共用。')
          else if(page==='state')content=h(CompanionState,{snapshot,
            moodForm:form(settings.mood_document_id??'mood','mood','心情设置'),
            hormoneForm:form('hormone','hormone','精力与压力设置')})
          else content=h(React.Fragment,null,
            page==='main'?null:form(settings.platform_document_ids?.[page]??page,'persona_platform',NAMES[page]+'人设开关'),
            separateQQFollow?h(QQMainPersona,{record:snapshot.profiles.qq,document:document('qq'),canManage:true,onSaved:reload,fetcher}):null,
            h(PersonaForm,{key:page,platform:page,record:snapshot.profiles[page],enabled:document(settings.platform_document_ids?.[page]??page)?.value.persona_enabled!==false,showFollow:!separateQQFollow,onSaved:reload,fetcher}),
            snapshot.capabilities?.persona_export?h('details',{className:'oj3-details'},h('summary',null,'人设导出与检查'),h(OwnerInsights,{key:'export-'+page,platform:page,fetcher})):null)
        }
        if(section==='memory')content=page==='search'?h(MemorySearch,{fetcher}):page==='diary'?h(Diary,{fetcher}):page==='people'?h(People,{fetcher,sharing:settings.familiarity?.sharing,detailsAvailable:snapshot.capabilities?.people_detail===true,summaryAvailable:snapshot.capabilities?.people_summary===true}):page==='learning'?h(React.Fragment,null,snapshot.capabilities?.reply_learning===true?h(ReplyLearningList,{fetcher,onActivity:loadActivity}):null,h(LearningItems,{snapshot,activity,onSaved:reload,onActivity:loadActivity,fetcher}),foldSettings('学习设置',form(settings.learning_document_id??'learning','learning','学习来源'),form('learning-loop','learning_loop','整理、试用与反馈','自动整理遵守活动时段和额度。'))):form('settings','memory','记忆设置')
        if(section==='activity'){
          const replyLearning=snapshot.capabilities?.reply_learning===true?{fetcher,onChanged:loadActivity}:null
          content=page==='queue'?h(React.Fragment,null,card('最近活动',null,h(TaskList,{activity,onRefresh:loadActivity,replyLearning})),snapshot.capabilities?.daily_report?h('details',{className:'oj3-details'},h('summary',null,'按日查看旧记录'),h(OwnerInsights,{report:true,fetcher})):null):page==='school'?h(SchoolPanel,{fetcher}):form(settings.activity_document_id??'activity',page,page==='budget'?'额度设置':'日常安排')
          if(page==='budget'){
            const budget=activity?.budget??snapshot.overview?.budget??{},used=budget.autonomous_wakes,limit=document(settings.activity_document_id??'activity')?.value.budget?.daily_wake_limit??budget.daily_wake_limit
            content=h(React.Fragment,null,card('自动用量',null,tokenStats(budget),h('details',{className:'oj3-details'},h('summary',null,'手动与待确认用量'),hint('手动执行 '+printable(budget.manual_known_tokens)+' Token'),hint('手动待确认 '+printable(budget.manual_uncertain_tokens??0)+' Token'))),card('活动次数',null,h('div',{className:'oj3-statgrid'},stat('主动活动',Number.isSafeInteger(used)&&Number.isSafeInteger(limit)?used+' / '+limit:'—'),stat('手动执行',budget.manual_wakes),stat('回应消息',budget.incoming_wakes)),Number.isSafeInteger(used)&&Number.isSafeInteger(limit)?hint('还可主动 '+Math.max(0,limit-used)+' 次'):null),content)
          }
        }
        if(section==='platforms')content=h(React.Fragment,null,
          h(AccountBinding,{key:page+'-binding',platform:page,snapshot,onSaved:reload,fetcher}),
          form(settings.platform_document_ids?.[page]??page,page,NAMES[page]+'设置'),
          page==='qq'?foldSettings('查看 QQ 亲疏',h(QQAffinity,{key:'qq-affinity',fetcher})):
            foldSettings('手动操作：浏览、检查新消息',
              h(ManualRound,{key:page+'-round',platform:page,activity,capabilities:snapshot.capabilities,onActivity:loadActivity,fetcher}),
              h(InboxActions,{platform:page,snapshot,fetcher,onActivity:loadActivity,onSaved:reload})),
          page==='tieba'?foldSettings('查看各吧说话方式',h(TiebaAtmosphere,{snapshot,fetcher})):null,
          page==='bilibili'?foldSettings('B 站自动收件设置',form(docs.bilibili?.value?.bilibili?.inbox_document_id??'bilibili-inbox','inbox','自动看回复')):null)
        if(section==='portability')content=page==='update'?h(UpdateCheck,{snapshot,fetcher}):h(Portability,{key:page,page,capabilities:snapshot.capabilities,fetcher,onSaved:reload})
      }
      return h('div',{className:'oj3'},h('header',{className:'oj3-head'},h('div',null,h('h2',null,'欧鲸鲸')),button(loading?'读取中…':'刷新',()=>reload().catch(()=>{}),loading)),
        error?note(error,true):null,!snapshot?note(loading?'正在加载…':'设置暂时无法打开，请刷新。'):h(React.Fragment,null,
          h('nav',{className:'oj3-nav',role:'tablist','aria-label':'设置主导航'},NAV.map(([id,label,pages])=>h('button',{key:id,type:'button',role:'tab','aria-selected':section===id,className:'oj3-tab',onClick:()=>{setSection(id);setPage(pages[0][0])}},label))),
          h('div',{className:'oj3-layout'},navigation[2].length>1?h('nav',{className:'oj3-subnav',role:'tablist','aria-label':navigation[1]+'分区'},navigation[2].map(([id,label])=>h('button',{key:id,type:'button',role:'tab','aria-selected':page===id,className:'oj3-subtab',onClick:()=>setPage(id)},label))):null,h('main',{className:'oj3-content',key:section+':'+page},content))))
    }
    return {inject:['slots'],Panel,NAV,FIELDS,CSS,OwnerInsights,apiRequest,decodeField,buildPatch,createOperationGate,taskState,busyTask,DocumentForm,PersonaForm,QQMainPersona,ManualRound,InboxActions,ProgressBar,TaskProgress,AccountBinding,MemorySearch,Diary,People,PeopleDetail,peopleSummaryStatus,QQAffinity,Portability,TaskList,TaskAction,RecentEvent,HormoneState,LearningItem,LearningItems,ReplyLearningButton,ReplyLearningList,TiebaAtmosphere,UpdateCheck,SchoolPanel,resultUrl,
      apply(ctx){
        const style=document.createElement('style');style.setAttribute('data-plugin-css','companion-native-v3');style.textContent=CSS;document.head.appendChild(style)
        const slots=(typeof ctx.get==='function'?ctx.get('slots'):null)||ctx.slots,off=[()=>style.remove()]
        if(slots){off.push(slots.inject('settings.section',()=>slots.register({name:'settings.section',id:'companion-unified',order:6,label:'欧鲸鲸'},()=>h(Panel))));off.push(slots.inject('plugins.bundle.config',()=>slots.register({name:'plugins.bundle.config',key:'dsh-companion-unified'},()=>h(Panel))))}
        let disposed=false;const dispose=()=>{if(disposed)return;disposed=true;for(const fn of off.reverse())try{fn?.()}catch{}}
        ctx.effect?.(()=>dispose,'companion-native-v3:client');return dispose
      },
    }
  },
})
