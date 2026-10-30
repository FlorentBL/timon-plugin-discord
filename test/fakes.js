// Fakes for the conversation engine: Discord, ctx.missions, ctx.questions, kv and logs. No network, no secret.
export const OWNER = '111111111111111111'
export const DM = 'DM1'
export const SALON = '222222222222222222'
export const TOKEN = 'FAKE-TOKEN-NEVER-LOGGED'

export function world({ channels = [SALON], clock = { t: Date.UTC(2026, 9, 30, 12, 0, 0) } } = {}) {
  const w = { sent: [], calls: [], logs: [], pending: [], store: new Map(), clock, seq: 1000, boxes: { [DM]: [], [SALON]: [] }, spawnError: null, sendError: null, forbidden: new Set() }
  w.say = (channel, content, extra = {}) => {
    const m = { id: String(++w.seq), channel_id: channel, content, type: 0, author: { id: OWNER }, ...extra }
    w.boxes[channel].push(m)
    return m
  }
  w.discord = {
    ownerId: async () => OWNER,
    openDm: async () => DM,
    readMessages: async (ch, { after, limit = 50 } = {}) => {
      if (w.forbidden.has(ch)) throw Object.assign(new Error('Discord 403'), { status: 403 })
      const all = w.boxes[ch].filter((m) => !after || BigInt(m.id) > BigInt(after))
      const list = after ? all.slice(0, limit) : all.slice(-limit)
      return { lastId: list.at(-1)?.id ?? after, messages: list }
    },
    getMessage: async (ch, id) => { const m = w.boxes[ch].find((x) => x.id === id); if (!m) throw Object.assign(new Error('404'), { status: 404 }); return m },
    channelName: async () => 'general',
    sendMessage: async (ch, content, replyTo) => {
      if (w.forbidden.has(ch)) throw Object.assign(new Error('Discord 403'), { status: 403 })
      const m = { id: String(++w.seq), channel_id: ch, content, replyTo, author: { id: 'bot', bot: true }, type: 0 }
      w.sent.push(m)
      w.boxes[ch].push(m)
      return m
    },
  }
  w.missions = {
    spawn: async (i) => { w.calls.push(['spawn', i]); if (w.spawnError) throw w.spawnError; return `M${w.calls.filter((c) => c[0] === 'spawn').length}` },
    send: async (id, t) => { w.calls.push(['send', id, t]); if (w.sendError) { const e = w.sendError; throw e } return { resumed: false } },
  }
  w.questions = {
    list: async () => w.pending,
    resolve: async (id, body) => { w.calls.push(['resolve', id, body]); w.pending = w.pending.filter((q) => q.id !== id) },
  }
  w.kv = { get: async (k) => structuredClone(w.store.get(k)), set: async (k, v) => void w.store.set(k, structuredClone(v)) }
  w.log = { info: (...a) => w.logs.push(a.join(' ')), warn: (...a) => w.logs.push(a.join(' ')) }
  w.config = { channels, rollover: '04:00', timezone: 'Europe/Paris', agent: 'helper' }
  return w
}

export const err = (code) => Object.assign(new Error(`failure ${code}`), { code })
export const Q = (id, extra = {}) => ({
  id, agent: 'helper', kind: 'question', missionId: 'M1', plan: null,
  questions: [{ question: 'Which database?', header: null, multiSelect: false, placeholder: null, options: [{ label: 'Postgres', description: null, actor: null }, { label: 'SQLite', description: null, actor: null }, { label: 'MySQL', description: null, actor: null }] }],
  ...extra,
})
export const row = (missionId, text, timestamp, type = 'assistant') => ({ missionId, timestamp, type, payload: { message: { role: type === 'assistant' ? 'assistant' : 'user', content: [{ type: 'text', text }] } } })
