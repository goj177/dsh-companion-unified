// Pure native style diagnostics. No storage, provider, network or configuration imports.
// Positive style/fact-preservation principles and pattern taxonomy informed by
// liuwenji007/dsh-humanizer (MIT). Attribution/reference: vendor/dsh-humanizer/.
// The upstream classifier is intentionally not imported or executed.
export const SPEECH_DEFAULTS = Object.freeze({ enabled: true, level: 'standard', repetition_hints: true })
const MAX_ANALYSIS_CHARS = 32000
const PLATFORM_LABELS = Object.freeze({ qq: 'QQ', tieba: '贴吧', bilibili: 'B站' })

function settingsOf(value) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  return {
    enabled: typeof input.enabled === 'boolean' ? input.enabled : SPEECH_DEFAULTS.enabled,
    level: ['light', 'standard'].includes(input.level) ? input.level : SPEECH_DEFAULTS.level,
    repetition_hints: typeof input.repetition_hints === 'boolean' ? input.repetition_hints : SPEECH_DEFAULTS.repetition_hints,
  }
}

/** Stable, small generation guidance; no duplicate persona/voice samples. */
export function buildSpeechSection({ platform = '', settings } = {}) {
  const config = settingsOf(settings ?? SPEECH_DEFAULTS)
  if (!config.enabled) return ''
  const lines = [
    `【表达辅助${PLATFORM_LABELS[platform] ? '·' + PLATFORM_LABELS[platform] : ''}】具体说法由当前有效人设、用户明确格式和实际对话决定。`,
    '原话、作者、数字、名字、代码、链接和回复坐标保持准确；表达样例不作自己的身份或经历。',
    '参考句与句架统计是资料，不是每条回复必须采用的开头、结尾或口吻。',
  ]
  if (config.level === 'standard') lines.push('表达检查只核对资料与表面结构，不替换当前人设或改变原文事实。')
  if (config.repetition_hints) lines.push('近期统计只说明实际重复，不指定新的句式或对话立场。')
  return lines.join('\n')
}

// Chat cadence signals, not verdicts or bans. Only actual self-generated chat
// contributes; quotations/code, structured tasks and scope boundaries survive.
const CHAT_CADENCE = [
  ['chat-analogy-taunt','比较式补刀',/你[^。！？\n]{0,35}比[^。！？\n]{1,24}(?:还|都)|比[^。！？\n]{1,20}还[^。！？\n]{1,15}/gu],
  ['chat-rhetorical-ending','反问式收尾',/(?:你这|你是|是来|到底是)[^。！？\n]{0,45}(?:还是|是不是|图啥|想干嘛)[^。！？\n]{0,25}[？?]|[^。！？\n]{2,45}(?:吗|吧)[？?]\s*$/gu],
  ['chat-ack-boundary','先认后拒的起手',/(?:^|[。！？\n])\s*(?:这[句点事]|这个|你这句)?[^。！？\n]{0,8}(?:我认|我不接|我接了|先认)|(?:^|[。！？\n])\s*(?:行|对|好)[，,]你/gu],
  // A cadence signal only: genuine agreement/plans are valid. Repetition can
  // warrant a small generation hint, never a diagnosis, edit or send veto.
  ['chat-concession-tail','另接承接词的两拍句式',/[^\0\s。！？!?；;\n][^\0。！？!?；;\n]*[。！？!?；;\n]\s*(?:行(?:吧|了|行行)?|好吧|好好好)[，,]\s*[^\0\s。！？!?；;\n]/gu],
  ['chat-imperative-rebuttal','先后指令式回怼',/你[^。！？\n]{0,15}先[^。！？\n]{1,30}再|先[^。！？\n]{1,25}(?:再来|再开口|再说话|再来聊)/gu],
  ['chat-meta-ai','拿机器身份接话',/(?:人机感|省电模式|CPU|词库|复读机|人机鉴定)/giu],
]
export function chatCadencePatterns(input) {
  const text=maskSpeechText(input).text
  return CHAT_CADENCE.filter(([, ,regex])=>{regex.lastIndex=0;return regex.test(text)}).map(([id])=>id)
}
export function chatCadenceHint(counts) {
  const repeated=[...FISH_TEMPLATES.map(rule=>[rule.id,rule.name]),...CHAT_CADENCE].filter(([id])=>(counts.get(id)??0)>=2).map(([,name])=>name).slice(0,3)
  return repeated.length?'【近期表达统计】重复句架：'+repeated.join('、')+'。这是表面结构记录，不代表当前话题或对话立场。':''
}

/** Protect spans without deleting them or joining unrelated sentences. */
export function maskSpeechText(input) {
  const text = typeof input === 'string' ? input : String(input ?? '')
  const marks = new Uint8Array(text.length)
  const mark = (start, end) => { for (let index = start; index < Math.min(text.length, end); index++) marks[index] = 1 }
  const view = () => text.split('').map((ch, index) => marks[index] && ch !== '\r' && ch !== '\n' ? '\0' : ch).join('')
  const markMatches = regex => { for (const match of view().matchAll(regex)) mark(match.index, match.index + match[0].length) }

  // An unclosed fence is data too. Match closing fences of equal or greater length.
  let offset = 0, fence
  for (const line of text.split(/(?<=\n)/)) {
    const match = /^[ \t]{0,3}(`{3,}|~{3,})([^\r\n]*)/.exec(line)
    if (!fence && match) fence = { start: offset, ch: match[1][0], length: match[1].length }
    else if (fence && match && match[1][0] === fence.ch && match[1].length >= fence.length && !match[2].trim()) {
      mark(fence.start, offset + line.length); fence = null
    }
    offset += line.length
  }
  if (fence) mark(fence.start, text.length)
  markMatches(/^[ \t]{0,3}>[^\r\n]*(?:\r?\n|$)/gm)
  markMatches(/<(?<tag>pre|code)\b[^>]*>[\s\S]*?<\/\k<tag>\s*>/gi)
  markMatches(/(`+)(?:(?!\1)[^\0\r\n])*?\1/g)
  markMatches(/"(?:\\.|[^"\\])*"/g)
  const unfinishedDouble = /(?<!\\)"/.exec(view())
  if (unfinishedDouble) mark(unfinishedDouble.index, text.length)

  const singleQuoted = view()
  let singleStart = null
  const word = ch => !!ch && /[\p{Script=Latin}\p{N}]/u.test(ch)
  for (let index = 0; index < singleQuoted.length; index++) {
    if (singleQuoted[index] === '\\') { index++; continue }
    if (singleQuoted[index] !== "'" || word(singleQuoted[index - 1]) && word(singleQuoted[index + 1])) continue
    if (singleStart !== null) { mark(singleStart, index + 1); singleStart = null }
    else if (!word(singleQuoted[index - 1])) singleStart = index
  }
  if (singleStart !== null) mark(singleStart, text.length)
  const pairs = { '“': '”', '「': '」', '『': '』', '‘': '’' }, stack = []
  const quoted = view()
  for (let index = 0; index < quoted.length; index++) {
    const ch = quoted[index]
    if (ch === '’' && word(quoted[index - 1]) && word(quoted[index + 1])) continue
    if (pairs[ch]) stack.push({ start: index, end: pairs[ch] })
    else if (stack.at(-1)?.end === ch) {
      const item = stack.pop()
      if (!stack.length) mark(item.start, index + 1)
    }
  }
  if (stack.length) mark(stack[0].start, text.length)

  // Pair delimiters in linear time; keep Markdown link labels as quoted data.
  const linked = view(), square = [], round = [], squareEnds = new Map(), roundEnds = new Map()
  for (let index = 0; index < linked.length; index++) {
    const ch = linked[index]
    if (ch === '\\') { index++; continue }
    if (ch === '[') square.push(index)
    else if (ch === ']' && square.length) squareEnds.set(square.pop(), index)
    else if (ch === '(') round.push(index)
    else if (ch === ')' && round.length) roundEnds.set(round.pop(), index)
  }
  for (const [start, end] of squareEnds) {
    let next = end + 1
    while (next < end + 4 && linked[next] === ' ') next++
    const close = linked[next] === '(' ? roundEnds.get(next) : linked[next] === '[' ? squareEnds.get(next) : undefined
    if (close !== undefined) mark(linked[start - 1] === '!' ? start - 1 : start, close + 1)
  }
  markMatches(/^[ \t]{0,3}\[[^\]\r\n]+\]:[^\r\n]*/gm)
  markMatches(/\b(?:https?|ftp):\/\/[^\s\0<>"'“”「」『』，。；！？、）】)]+/giu)
  markMatches(/\[CQ:[^\]\r\n]*(?:\]|$)|\[[^\[\]\r\n]{1,80}\]/g)
  markMatches(/[-+]?\d+(?:[.,:/-]\d+)*(?:[%％])?/g)
  let protected_chars = 0
  for (const value of marks) protected_chars += value
  return { text: view(), protected_chars }
}

// These are surface wording signals, not authorship or quality judgments.
// Do not add technical nouns, ordinary emoji, numbering, or one-off contrast as errors.
// Owner-supplied negative examples: recognize sentence functions/variants, not
// forbidden words. These local hints never veto or rewrite approved messages.
const FISH_TEMPLATES = [
  { id:'fish-concession',name:'先认同再转折套式',chat_only:true,
    regex:/你说(?:得|的)对[，,、\s]*(?:但是|但|不过)/gu,
    suggestion:'认同或反对都落到具体事情；不固定用先认同再转折开场，真实让步仍可保留。' },
  { id:'fish-rating',name:'给话打分式点评',chat_only:true,
    regex:/(?:这(?:一)?句(?:话)?|这话)(?:接(?:得|的))?(?:倒是|确实|很|挺|真|更|比较|太|够|算|还|就|说(?:得|的))?(?:稳|平|直|轻|重|漂亮)|(?:比(?:之?前|刚才)(?:的)?(?:都|还|更)?(?:稳|轻|重|平))|(?:^|[。！？!?\n])\s*(?:声音没抖[，,]但比刚才稳|很平|很直|稳|他之前的都弱)(?=[，,。！？!?\n]|$)/gu,
    suggestion:'别用稳、轻重、漂亮给对方的话盖章或排名；回应话里的内容。确实在讨论声音、重量或句子修改时照常说明。' },
  { id:'fish-receipt',name:'收条记账式接话',chat_only:true,
    regex:/(?:这(?:一)?句(?:话)?|这话|这(?:个|笔)账|这件事)(?:我)?(?:记(?:下|住|着|得)(?:了)?|收下(?:了)?|留着)|(?:^|[。！？!?\n])\s*(?:我(?:记下了|记得了|记住了)|他记得这事|记得实)(?=[，,。！？!?\n]|$)/gu,
    suggestion:'没有实际记忆任务时别开收条、记账或重复认领原话；若确实完成了记忆保存，可以如实确认，不能假报已存。' },
  { id:'fish-boundary',name:'空摆姿态式收尾',chat_only:true,
    regex:/(?:这(?:一)?句(?:话)?|这话|你这句|你这话)(?:我)?(?:不接|不接你(?:的)?|不拦|不催|认(?=[，,。！？!?\n]|$)|认了|认下(?:来)?|认得实)|(?:^|[。！？!?\n])\s*(?:行[，,]\s*)?(?:我不接|我不拦|我不催(?:你)?|不催|我认|认你|认下来|认这个|认得实|收不回去|回去睡|睡吧[，,]我守着|你自己掂量|你掂量)(?=[，,。！？!?\n]|$)|没接你那句[^\0。！？!?\n]{1,20}/gu,
    suggestion:'别靠我认、不接、不拦、掂量等空姿态收尾；具体说同意什么、哪里有问题。真实拒绝、提醒或边界说明保留。' },
  { id:'fish-mirror',name:'换词镜像接话',chat_only:true,
    regex:/你去[，,]\s*我跟|什么心都骂着[^\0。！？!?\n]{1,16}上|[^\0。！？!?\n，,]{1,12}比[^\0。！？!?\n，,]{1,12}稳|(?:这(?:一)?句(?:话)?|这话)(?:比[^\0。！？!?\n]{1,16})(?:轻|重|平)|说(?:得|的)比谁都响|(?:^|[。！？!?\n])\s*我跟(?=[，,。！？!?\n]|$)/gu,
    suggestion:'不要照对方句架换名词或添加比较式尾巴；直接回应这次具体的事情，实际同行安排不受影响。' },
  { id:'fish-self-question',name:'假深刻反问',chat_only:true,
    regex:/问别人还是问自己|(?:这话|这句话)?是(?:ta|他|她)告诉你的[，,]?还是你自己想明白的/giu,
    suggestion:'需要什么信息就具体问什么，不把普通交流拔成问自己或想没想明白的审问；确实核对消息来源时正常提问。' },
]
const RULES = [
  ...FISH_TEMPLATES,
  { id: 'empty-preface', name: '空泛引导', regex: /值得注意的是|不难发现|毋庸置疑|众所周知/gu,
    suggestion: '看看引导语后是否已有具体信息；能直接接内容时就直说。' },
  { id: 'grand-conclusion', name: '空泛拔高', regex: /未来可期|前景广阔|大有可为|意义深远|具有里程碑(?:式)?意义/gu,
    suggestion: '结尾若只是拔高，可落回具体判断或感受；有依据的重要结论仍保留。' },
  { id: 'bureaucratic-padding', name: '公文式套话', regex: /建立健全|积极推动|稳步推进|全面落实|切实增强|着力打造|持续深化/gu,
    suggestion: '聊天时可检查这些措辞是否承载具体意思；正式公文等明确格式要求优先。' },
  { id: 'preface-flattery', name: '开头夸赞模板', regex: /^\s*(?:你说(?:得|的)(?:太对了|非常正确)|这(?:真)?是(?:个|一个)(?:非常|特别|很)?(?:棒|精彩|深刻)的(?:问题|想法)|问得(?:太|非常)好了|great question[!.]?|you(?:'re| are) absolutely right[!.]?)/giu,
    suggestion: '有认同就说具体认同了什么；开头不必固定夸奖。' },
  { id: 'english-filler', name: '空泛英文引导', regex: /\b(?:it is important to note|it'?s worth noting|in today's rapidly evolving|without further ado)\b/giu,
    suggestion: '若引导语没有增加信息，可以直接表达后面的内容。' },
  { id: 'contrast-frame', name: '对比句架重复', weak: true,
    regex: /(?:不是|并非|不只是)[^\0。！？!?；;\r\n]{2,40}而是|不仅(?:仅)?[^\0。！？!?；;\r\n]{2,40}(?:更是|还意味着)/gu,
    suggestion: '相同对比句架出现多次，可检查每处是否都需要；保留真实纠错和必要对比。' },
  { id: 'summary-frame', name: '总结句架重复', weak: true,
    regex: /总的来说|总而言之|综上所述|归根结底|说到底|一句话总结|先说结论/gu,
    suggestion: '近几次若总用同一种总结开场或收尾，可自然换个接法；必要总结仍可用。' },
  { id: 'service-opening', name: '服务式开场重复', weak: true,
    regex: /^\s*(?:当然可以|没问题)(?:[！!。。，,、～~ ]|$)|^\s*(?:我来|我会)(?:帮你|为你|给你)(?:详细|全面|深入|系统地?|一步步)[^\0。\r\n]{0,18}/gu,
    suggestion: '如果开场没有增加意思，可以直接接话或说实际结果；普通答应和礼貌不用刻意删。' },
  { id: 'service-ending', name: '客服式收尾重复', weak: true,
    regex: /如果(?:你|您)(?:还有|有)(?:其他|更多|任何)(?:问题|需要|需求)[^\0。\r\n]{0,24}(?:随时|告诉我)|希望(?:以上|这些)(?:内容|信息|建议|解释)?(?:能|能够)?(?:帮到你|对你有帮助)|\blet me know if you\b/giu,
    suggestion: '如果近几次都以泛泛邀约结尾，可在内容说完时自然停下；明确需要的下一步保留。' },
  { id: 'restate-frame', name: '换词复述重复', weak: true, regex: /换句话说|也就是说|换言之/gu,
    suggestion: '检查多次换词解释是否增加了新信息；必要的澄清和教学仍可保留。' },
]

function recentCounts(values) {
  const result = new Map()
  if (!Array.isArray(values)) return result
  for (const item of values.slice(-100)) {
    const id = typeof item === 'string' ? item : item?.id
    if (!RULES.some(rule => rule.id === id)) continue
    const count = typeof item === 'object' && Number.isFinite(item.count) ? Math.max(0, Math.min(20, Math.floor(item.count))) : 1
    result.set(id, (result.get(id) || 0) + count)
  }
  return result
}

/** Never edits text or gives an AI/human verdict; the caller decides what to do. */
export function analyzeSpeech(input, { purpose = 'chat', recent_patterns } = {}) {
  const original = typeof input === 'string' ? input : String(input ?? ''), text = original.slice(0, MAX_ANALYSIS_CHARS)
  const masked = maskSpeechText(text), previous = recentCounts(recent_patterns)
  const hits = [], suggestions = [], fingerprints = []
  for (const rule of RULES) {
    if (purpose !== 'chat' && rule.chat_only) continue
    if (purpose === 'structured' && rule.weak) continue
    rule.regex.lastIndex = 0
    const matches = [...masked.text.matchAll(rule.regex)]
    if (!matches.length) continue
    fingerprints.push({ id: rule.id, count: matches.length })
    if (rule.weak && matches.length < 2 && (previous.get(rule.id) || 0) < 2) continue
    const samples = [...new Set(matches.map(match => text.slice(match.index, match.index + match[0].length).trim()))].slice(0, 3)
    hits.push({ id: rule.id, name: rule.name, count: matches.length, samples })
    suggestions.push(rule.suggestion)
  }
  return { hits, suggestions, fingerprints, protected_chars: masked.protected_chars,
    analyzed_chars: text.length - masked.protected_chars, truncated: original.length > text.length,
    caveat: '这里只提示可讨论的表层措辞习惯，不判断作者身份，也不代表文本质量；请结合语境，保留意思、事实和有效人设。' }
}
