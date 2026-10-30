// Pure helpers: message splitting, transcript text, question cards and answers. No I/O.
const clip = (s, n) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s))
export const BARE = /^\d+(\s*,\s*\d+)*$/
export const isBareAnswer = (t) => BARE.test(String(t).trim())

// Splits at newlines, then spaces, then hard; every part is at most `size` characters (Discord limit: 2000).
export function chunks(text, size = 2000) {
  const out = []
  let rest = String(text).trim()
  while (rest.length > size) {
    let cut = rest.lastIndexOf('\n', size)
    if (cut < size / 2) cut = rest.lastIndexOf(' ', size)
    if (cut < size / 2) cut = size
    out.push(rest.slice(0, cut).trimEnd())
    rest = rest.slice(cut).trimStart()
  }
  if (rest) out.push(rest)
  return out
}

const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.filter((x) => x?.type === 'text').map((x) => x.text || '').join('\n') : '')

// Text of a transcript row (`event`) when it is an answer of the assistant; '' otherwise (tools, reasoning, user rows).
export function assistantText(ev) {
  const p = ev?.payload || {}
  const role = p.message?.role || ev?.type
  if (role === 'assistant') return textOf(p.message?.content ?? p.content).trim()
  if (ev?.type === 'result' && typeof p.result === 'string') return p.result.trim()
  return ''
}

export class AnswerError extends Error {}

export function renderQuestion(q) {
  const qs = q.questions ?? []
  const lines = [`❓ **${q.agent ?? 'Agent'}** is waiting for your answer${qs.length > 1 ? ` (${qs.length} questions)` : ''}`]
  qs.forEach((it, i) => {
    lines.push('', `${qs.length > 1 ? `**Q${i + 1}.** ` : ''}${it.header ? `*${it.header}* — ` : ''}${it.question}`)
    ;(it.options ?? []).forEach((o, j) => lines.push(`${j + 1}. ${o.label}${o.description ? ` — ${clip(o.description, 120)}` : ''}`))
    if (it.multiSelect) lines.push('(several choices allowed: `1, 3`)')
  })
  lines.push('', qs.length > 1 ? 'Answer by quoting this message, one line per question (number or free text).' : 'Answer with a number or free text (quote this message if several questions are waiting). Start a message with `//` to talk to the agent instead.')
  return lines.join('\n')
}

export function renderPlan(q) {
  return `🗂️ **${q.agent ?? 'Agent'}** proposes a Kanban plan${q.plan?.title ? `: ${clip(q.plan.title, 200)}` : ''}.\nValidate it in Timon (it cannot be answered from Discord).`
}

// The owner's text -> body for ctx.questions.resolve. Throws AnswerError with a readable message when invalid.
export function parseAnswer(q, text) {
  const qs = q.questions ?? []
  let lines = String(text).split('\n').map((l) => l.trim()).filter(Boolean)
  if (lines.length !== qs.length) {
    if (qs.length === 1 && lines.length > 1) lines = [lines.join(' ')]
    else throw new AnswerError(`${qs.length} line(s) expected, one per question.`)
  }
  const answers = Object.create(null)
  qs.forEach((it, i) => {
    const opts = it.options ?? []
    const line = qs.length > 1 ? lines[i].replace(/^Q?\d+\s*[:.)]\s+(?=.)/i, '') : lines[i]
    if (opts.length && BARE.test(line)) {
      const picks = line.split(',').map((n) => Number(n.trim()))
      if (picks.some((n) => n < 1 || n > opts.length)) throw new AnswerError(`Number out of range (1 to ${opts.length}).`)
      if (picks.length > 1 && !it.multiSelect) throw new AnswerError('Only one choice is possible for this question.')
      answers[it.question] = it.multiSelect ? picks.map((n) => opts[n - 1].label) : opts[picks[0] - 1].label
    } else answers[it.question] = line
  })
  return { answers }
}

// Conversation day (YYYY-MM-DD in `tz`): the day starts at `rollover` ("HH:MM") instead of midnight.
export function parseRollover(value, fallback = '04:00') {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(value ?? '').trim()) ?? /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(fallback)
  return Number(m[1]) * 60 + Number(m[2])
}
export function conversationDay(ms, tz = 'Europe/Paris', rollover = '04:00') {
  let zone = tz
  try { new Intl.DateTimeFormat('en-CA', { timeZone: zone }) } catch { zone = 'UTC' }
  // Local wall-clock time in the zone, minus the rollover offset, read as a calendar date.
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]))
  const local = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute))
  return new Date(local - parseRollover(rollover) * 60000).toISOString().slice(0, 10)
}
