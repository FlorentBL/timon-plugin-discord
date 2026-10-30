// Conversation engine: Discord messages of the owner <-> one Timon mission per day.
// Everything is injected (discord client, ctx.missions, ctx.questions, kv): testable without network.
// Persisted state holds identifiers, cursors and hashes only — never message text.
import { createHash } from 'node:crypto'
import { chunks, assistantText, renderQuestion, renderPlan, parseAnswer, isBareAnswer, AnswerError, conversationDay } from './text.js'

const STALE_TURN_MS = 30 * 60_000 // a turn flag older than this is ignored (a turn_complete was missed)
const MAX_PAGES = 5
const hash = (s) => createHash('sha1').update(String(s)).digest('hex').slice(0, 16)
const remember = (list, id, max = 300) => { if (!list.includes(id)) list.push(id); if (list.length > max) list.splice(0, list.length - max) }
const safe = (e) => `${e?.code ?? e?.status ?? e?.name ?? 'error'}`

export const EMPTY = () => ({
  mission: null, // today's mission
  day: null,
  prev: null, // yesterday's mission (its questions are still relayed)
  turn: null, // ms when a turn was handed to the mission, until turn_complete
  origin: null, // { channel, message, replied } of the message being answered
  queue: [], // [{ c: channel id, id: message id }] waiting for a free turn, in order
  cursors: {}, // channel id -> last handled message id
  cards: {}, // Discord message id of a question card -> question id
  asked: [], // question ids already posted
  sent: [], // hashes of transcript rows already relayed
  last: null, // hash of the last relayed text
  dm: null, // DM channel id with the owner
  notices: {}, // error code -> true while a failure notice is outstanding
})

export function createConversation({ discord, missions, questions, kv, getConfig, log = { info() {}, warn() {} }, now = Date.now }) {
  const load = async () => ({ ...EMPTY(), ...((await kv.get('state')) ?? {}) })
  const save = (st) => kv.set('state', st)
  // Poll, events and routes run concurrently: every state access goes through this chain.
  let chain = Promise.resolve()
  const locked = (fn) => { const r = chain.then(fn, fn); chain = r.catch(() => {}); return r }

  const dmChannel = async (st) => { if (!st.dm) { st.dm = await discord.openDm(); await save(st) } return st.dm }

  // Where an answer goes: the channel the owner wrote in (quoting the message once), else the DM.
  async function say(st, text, origin = null) {
    const dm = await dmChannel(st)
    const target = origin && origin.channel !== dm ? origin : null
    const ids = []
    for (const part of chunks(text)) {
      const replyTo = target && !target.replied && !ids.length ? target.message : undefined
      try {
        ids.push((await discord.sendMessage(target ? target.channel : dm, part, replyTo)).id)
      } catch (e) {
        // A channel that became unwritable must not swallow the answer: fall back to the DM.
        if (!target || !(e?.status >= 400 && e.status < 500) || e.status === 429) throw e
        log.warn(`channel write failed (${safe(e)}), answering in DM`)
        ids.push((await discord.sendMessage(dm, part)).id)
      }
    }
    if (target) target.replied = true
    return ids
  }

  async function notifyOnce(st, code, text) {
    if (st.notices[code]) return
    st.notices[code] = true
    await save(st)
    await say(st, text)
  }

  // ---- questions -----------------------------------------------------------------------------
  const ours = (st, q) => q?.missionId && (q.missionId === st.mission || q.missionId === st.prev)

  async function postCard(st, q) {
    if (!ours(st, q) || st.asked.includes(q.id)) return false
    remember(st.asked, q.id)
    if (q.kind === 'series_plan') await say(st, renderPlan(q))
    else for (const id of await say(st, renderQuestion(q))) st.cards[id] = q.id
    await save(st)
    return true
  }

  async function syncQuestions(st) {
    const pending = await questions.list({ kinds: ['question', 'series_plan'] })
    for (const q of pending) await postCard(st, q)
    const live = new Set(pending.map((q) => q.id))
    for (const [mid, qid] of Object.entries(st.cards)) if (!live.has(qid)) delete st.cards[mid]
    await save(st)
  }

  // Which waiting question does this message answer? -> { q } | { handled: true } | null (it is for the agent)
  async function answerTarget(st, m, text) {
    const waiting = (await questions.list({ kinds: ['question'] })).filter((q) => ours(st, q) && st.asked.includes(q.id))
    const cited = m.message_reference?.message_id
    const byCard = cited && st.cards[cited] ? waiting.find((q) => q.id === st.cards[cited]) : null
    if (byCard) return { q: byCard }
    if (!waiting.length) return null
    if (waiting.length === 1) return { q: waiting[0] }
    if (isBareAnswer(text)) {
      await say(st, 'Several questions are waiting: quote the card you are answering.', originOf(st, m))
      return { handled: true }
    }
    return null
  }
  const originOf = (st, m) => ({ channel: m.channel_id, message: m.id, replied: false })

  async function answer(st, q, m, text) {
    try {
      await questions.resolve(q.id, parseAnswer(q, text))
      log.info('question answered from Discord')
    } catch (e) {
      if (e instanceof AnswerError || e?.code === 'invalid') await say(st, `⚠️ ${e.message}`, originOf(st, m))
      else if (e?.code === 'not_found') await say(st, 'ℹ️ That question was already answered or has expired.', originOf(st, m))
      else throw e
    }
  }

  // ---- incoming messages ---------------------------------------------------------------------
  async function handle(st, src, m) {
    const text = (m.content ?? '').trim()
    if (!text) return
    m.channel_id ??= src.id
    if (!text.startsWith('//')) {
      const t = await answerTarget(st, m, text)
      if (t?.q) return answer(st, t.q, m, text)
      if (t?.handled) return
    }
    st.queue.push({ c: src.id, id: m.id })
  }

  // Reads what is new in one channel without moving its cursor (first start: only positions the cursor).
  async function fetchNew(st, src) {
    if (st.cursors[src.id] == null) {
      // First start: position on the existing history without replaying it.
      st.cursors[src.id] = (await discord.readMessages(src.id, { limit: 1 })).lastId ?? '0'
      await save(st)
      return []
    }
    const found = []
    let after = st.cursors[src.id]
    for (let page = 0; page < MAX_PAGES; page++) {
      const { messages } = await discord.readMessages(src.id, { after, limit: 100 })
      found.push(...messages.map((m) => ({ src, m })))
      if (messages.length < 100) break
      after = messages.at(-1).id
    }
    return found
  }

  // Handles messages of all channels in arrival order (Discord ids are chronological). A cursor moves only
  // after its message is fully handled: a failure retries that message, it never skips it.
  async function ingest(st, batch, owner) {
    batch.sort((a, b) => (BigInt(a.m.id) < BigInt(b.m.id) ? -1 : 1))
    for (const { src, m } of batch) {
      const own = m.author?.id === owner && !m.author.bot && !m.webhook_id && (m.type === undefined || m.type === 0 || m.type === 19)
      if (own) await handle(st, src, m)
      st.cursors[src.id] = m.id
      await save(st)
    }
  }

  // ---- sending to the mission ----------------------------------------------------------------
  async function describe(st, item, msg) {
    let text = (msg.content ?? '').trim()
    const forced = text.startsWith('//')
    if (forced) text = text.slice(2).trim()
    if (!text) return ''
    if (item.c === (await dmChannel(st))) return text
    const lines = [`[Discord #${await channelLabel(item.c)}]`]
    const quoted = (msg.referenced_message?.content ?? '').trim().replace(/\s+/g, ' ')
    if (quoted) lines.push(`> ${quoted.length > 300 ? `${quoted.slice(0, 299)}…` : quoted}`)
    lines.push(text)
    return lines.join('\n')
  }
  const names = new Map()
  const channelLabel = async (id) => {
    if (!names.has(id)) names.set(id, await discord.channelName(id).catch(() => id))
    return names.get(id)
  }

  async function drain(st) {
    while (st.queue.length) {
      if (st.turn && now() - st.turn < STALE_TURN_MS) return // a turn is running: hold, in order
      const item = st.queue[0]
      let msg
      try { msg = await discord.getMessage(item.c, item.id) } catch (e) {
        if (e?.status === 404 || e?.status === 403) { st.queue.shift(); await save(st); continue } // deleted meanwhile
        throw e
      }
      const body = await describe(st, item, msg)
      if (!body) { st.queue.shift(); await save(st); continue }
      const today = conversationDay(now(), (await getConfig()).timezone, (await getConfig()).rollover)
      if (st.mission && st.day !== today) { st.prev = st.mission; st.mission = null; log.info('conversation rotated') }
      let started = false
      if (st.mission) {
        try {
          await missions.send(st.mission, body)
          started = true
        } catch (e) {
          if (e?.code === 'turn_in_progress') { st.turn ??= now(); await save(st); return }
          if (e?.code === 'backend_exhausted') { await notifyOnce(st, 'backend_exhausted', '⚠️ The agent is out of quota. Your messages are kept and will be sent when it is available.'); return }
          if (!['not_found', 'not_running'].includes(e?.code)) throw e
          st.prev = st.mission
          st.mission = null
        }
      }
      if (!started) {
        const agent = (await getConfig()).agent
        if (!agent) { await notifyOnce(st, 'no_agent', '⚠️ No target agent: set the "agent" setting of the plugin. Your messages are kept.'); return }
        const intro = st.prev ? `[Discord — new conversation of ${today}. Previous conversation: mission ${st.prev}; read it only if the user refers to it.]\n\n` : ''
        try {
          st.mission = await missions.spawn({ agent, mission: intro + body, title: `Discord ${today}` })
        } catch (e) {
          await notifyOnce(st, `spawn_${safe(e)}`, `⚠️ Could not start the agent (${safe(e)}). Your messages are kept and will be retried.`)
          throw e
        }
        st.day = today
      }
      st.notices = {}
      st.turn = now()
      st.origin = { channel: item.c, message: item.id, replied: false }
      st.queue.shift()
      await save(st)
    }
  }

  // ---- public API ----------------------------------------------------------------------------
  // One pass: read Discord, answer cards, hand queued messages to the mission, catch up on missed card events.
  const poll = () => locked(async () => {
    const st = await load()
    const cfg = await getConfig()
    const owner = await discord.ownerId()
    const dm = await dmChannel(st)
    const sources = [{ id: dm, dm: true }, ...cfg.channels.filter((id) => id !== dm).map((id) => ({ id }))]
    let failure
    const batch = []
    for (const src of sources) {
      try { batch.push(...(await fetchNew(st, src))) } catch (e) {
        // An unreadable salon (permission removed) must not block the DM or the other salons.
        if (src.dm || !(e?.status >= 400 && e.status < 500) || e.status === 429) { failure ??= e; break }
        log.warn(`channel read failed (${safe(e)})`)
      }
    }
    if (!failure) { try { await ingest(st, batch, owner) } catch (e) { failure = e } }
    if (!failure) {
      try { await syncQuestions(st) } catch (e) { log.warn(`questions sync failed (${safe(e)})`) }
      try { await drain(st) } catch (e) { failure ??= e }
    }
    await save(st)
    if (failure) throw failure
  })

  const onEvent = (ev) => locked(async () => {
    const st = await load()
    if (!st.mission || ev?.missionId !== st.mission) return false
    const text = assistantText(ev)
    if (!text) return false
    const key = hash(`${ev.missionId}:${ev.timestamp}:${text}`)
    const textHash = hash(text)
    // A final `result` row repeats the last assistant message: relay it once.
    if (st.sent.includes(key) || (ev.type === 'result' && st.last === textHash)) return false
    await say(st, text, st.origin)
    remember(st.sent, key)
    st.last = textHash
    await save(st)
    return true
  })

  const onTurnComplete = (ev) => locked(async () => {
    const st = await load()
    if (!st.mission || ev?.missionId !== st.mission) return
    st.turn = null
    if (ev.outcome === 'failed') await say(st, '⚠️ The agent’s turn failed.', st.origin)
    st.origin = null
    await save(st)
    await drain(st)
  })

  const onQuestionPending = (ev) => locked(async () => {
    const st = await load()
    if (ev?.question) await postCard(st, ev.question)
  })

  const onQuestionResolved = (ev) => locked(async () => {
    const st = await load()
    const id = ev?.questionId ?? ev?.question?.id
    if (!id) return
    const known = st.asked.includes(id)
    for (const [mid, qid] of Object.entries(st.cards)) if (qid === id) delete st.cards[mid]
    await save(st)
    // Our own answer comes back as an echo (origin plugin): ignore it. Closed elsewhere: say so.
    if (known && ev.origin?.kind !== 'plugin') await say(st, `ℹ️ A question was ${ev.status === 'answered' ? 'answered in Timon' : ev.status === 'expired' ? 'closed (expired)' : 'cancelled'}.`)
  })

  // Counts only, never content.
  const status = async () => { const st = await load(); return { mission: Boolean(st.mission), turnActive: Boolean(st.turn), queued: st.queue.length, cards: Object.keys(st.cards).length } }

  return { poll, onEvent, onTurnComplete, onQuestionPending, onQuestionResolved, status }
}
