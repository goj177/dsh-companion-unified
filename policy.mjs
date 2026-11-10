// DeepSeek 峰谷按北京时间计算，与进程/系统时区无关。
const zone = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
})

export function shanghaiTime(now = Date.now()) {
  const value = now instanceof Date ? now.getTime() : Number(now)
  if (!Number.isFinite(value)) throw new Error('时间无效')
  const p = Object.fromEntries(zone.formatToParts(value).map(x => [x.type, x.value]))
  const date = `${p.year}-${p.month}-${p.day}`
  const midnight = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day)) - 8 * 3600000
  return { value, date, midnight, weekday: new Date(midnight + 8 * 3600000).getUTCDay(),
    minute: Number(p.hour) * 60 + Number(p.minute), hour: Number(p.hour) }
}

export function valleyDecision(now = Date.now(), config = {}) {
  const t = shanghaiTime(now)
  const holidays = new Set(config.holidays || [])
  const holiday = holidays.has(t.date)
  const weekend = t.weekday === 0 || t.weekday === 6
  const windows = [[540, 720], [840, 1080]]
  const peak = !holiday && !weekend && windows.some(([a, b]) => t.minute >= a && t.minute < b)
  const current = windows.find(([a, b]) => t.minute >= a && t.minute < b)
  let nextPeakAt = null
  for (let offset = 0; offset < 370 && nextPeakAt === null; offset++) {
    const day = shanghaiTime(t.midnight + offset * 86400000)
    if (day.weekday === 0 || day.weekday === 6 || holidays.has(day.date)) continue
    nextPeakAt = windows.map(([start]) => day.midnight + start * 60000).find(value => value > t.value) ?? null
  }
  return { valley: !peak, peak, date: t.date, timeZone: 'Asia/Shanghai', holiday, weekend,
    reason: holiday ? '法定节假日配置' : weekend ? '周末' : peak ? '工作日高峰' : '工作日谷时',
    nextValleyAt: peak ? t.midnight + current[1] * 60000 : t.value, nextPeakAt }
}

export function isValley(now = Date.now(), config = {}) { return valleyDecision(now, config).valley }
export function nextValley(now = Date.now(), config = {}) { return valleyDecision(now, config).nextValleyAt }

export function usageTokens(usage = {}) {
  const clean = n => Number.isFinite(Number(n)) ? Math.max(0, Number(n)) : 0
  if (usage.totalTokens !== undefined || usage.total_tokens !== undefined) return Math.ceil(clean(usage.totalTokens ?? usage.total_tokens))
  if (usage.prompt_tokens !== undefined || usage.completion_tokens !== undefined) return Math.ceil(clean(usage.prompt_tokens) + clean(usage.completion_tokens))
  return Math.ceil(clean(usage.inputTokens) + clean(usage.outputTokens) + clean(usage.cacheReadTokens) + clean(usage.cacheWriteTokens))
}
