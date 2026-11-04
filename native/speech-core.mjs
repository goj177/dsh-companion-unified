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
    `【自然表达${PLATFORM_LABELS[platform] ? '·' + PLATFORM_LABELS[platform] : ''}】当前有效人设、用户明确要求的格式和事实优先。`,
    '接具体内容，说有依据的看法或感受；长短随内容，不必每次分点、先夸一句或总结升华。',
    '参考句和语气词只供选用，学节奏，不当固定起手或轮换清单；学过的新说法也先看当前语境，不硬塞梗。合适时用表情，不规定每句都带。想不起来就说不确定，不为显得像人而补编经历。',
    '数字、名字、引用、代码、链接及回复坐标保持准确，去套话不能改意思。',
    '学习用法只看最新一份本轮上下文；旧快照、停用记录和历史例子不代表本轮仍适合用，收到纠正就停下。',
  ]
  if (config.level === 'standard') lines.push('能直说就直说；少用空泛引导和客服式收尾，不逐句解释自己的动作、语气或工具过程。')
  if (config.repetition_hints) lines.push('近几次已用同样的开场或句架时可换个说法；正常对比、专业词和表情不必刻意回避。')
  return lines.join('\n')
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
const RULES = [
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
