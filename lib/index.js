import { createDiscord } from './discord.js'
import { createConversation } from './conversation.js'

export const inject = ['storage', 'settings', 'events', 'missions', 'http']

const DEFAULTS = { tokenSecret: 'DISCORD_BOT_TOKEN', pollSeconds: 10, rolloverTime: '04:00', timezone: 'Europe/Paris' }
const MIN_POLL_S = 5
const MAX_BACKOFF_MS = 5 * 60_000
const str = (v) => String(v ?? '').trim()

export function readSettings(settings) {
  const get = (k) => settings.get(k)
  return {
    enabled: get('pollEnabled') === true,
    tokenSecret: str(get('tokenSecret')) || DEFAULTS.tokenSecret,
    guildId: str(get('guildId')),
    ownerId: str(get('ownerId')),
    agent: str(get('agent')),
    channels: str(get('channels')).split(/[\s,;]+/).filter((id) => /^\d{5,}$/.test(id)),
    pollMs: Math.max(MIN_POLL_S, Number(get('pollSeconds')) || DEFAULTS.pollSeconds) * 1000,
    rollover: str(get('rolloverTime')) || DEFAULTS.rolloverTime,
    timezone: str(get('timezone')) || DEFAULTS.timezone,
  }
}

// Bot token: the sealed "botToken" setting first, else the vault entry named by "tokenSecret".
// Never logged, never returned by a route.
export async function tokenOf(ctx) {
  const own = str(ctx.settings.get('botToken'))
  if (own) return own
  return ctx.secrets.get(readSettings(ctx.settings).tokenSecret)
}

// Target agent: the "agent" setting, else the main orchestrator when the plugin can see it.
async function resolveAgent(ctx, configured) {
  if (configured) return configured
  try {
    return (await ctx.agents?.list?.())?.find((a) => String(a.role).toLowerCase() === 'main')?.name ?? ''
  } catch { return '' }
}

export function apply(ctx) {
  // Network goes through ctx.fetch only (plugin network rules); settings are read at each use, so changes apply live.
  const discord = createDiscord({
    fetchImpl: (url, init) => ctx.fetch(url, init),
    getToken: () => tokenOf(ctx),
    guildId: () => readSettings(ctx.settings).guildId,
    ownerId: () => readSettings(ctx.settings).ownerId,
  })
  const conversation = createConversation({
    discord, missions: ctx.missions, questions: ctx.questions, kv: ctx.storage.kv, log: ctx.log,
    getConfig: async () => {
      const s = readSettings(ctx.settings)
      return { channels: s.channels, rollover: s.rollover, timezone: s.timezone, agent: await resolveAgent(ctx, s.agent) }
    },
  })

  // Errors are logged by kind only: never a message, a token or a mission text.
  const guard = (label, fn) => async (...a) => {
    if (!readSettings(ctx.settings).enabled) return
    try { await fn(...a) } catch (e) { ctx.log.warn(`${label}: ${e?.code ?? e?.status ?? e?.name ?? 'error'}`) }
  }

  const router = ctx.router()
  router.get('/status', async (_req, res) => {
    if (!ctx.user()) { res.status(401).json({ error: 'sign-in required' }); return }
    res.json({ enabled: readSettings(ctx.settings).enabled, ...(await conversation.status()) })
  })

  let stopped = false
  let timer
  let failures = 0
  const loop = async () => {
    if (stopped) return
    const s = readSettings(ctx.settings)
    if (s.enabled) {
      try { await conversation.poll(); failures = 0 } catch (e) {
        failures++
        ctx.log.warn(`poll failed: ${e?.code ?? e?.status ?? e?.name ?? 'error'} (attempt ${failures})`)
      }
    }
    if (!stopped) timer = setTimeout(loop, Math.min(MAX_BACKOFF_MS, s.pollMs * 2 ** Math.min(failures, 5)))
  }
  timer = setTimeout(loop, 1000)

  const off = [
    ctx.events.on('event', guard('reply', conversation.onEvent)),
    ctx.events.on('turn_complete', guard('turn', conversation.onTurnComplete)),
    ctx.events.on('question_pending', guard('question', conversation.onQuestionPending)),
    ctx.events.on('question_resolved', guard('question', conversation.onQuestionResolved)),
  ]
  return () => { stopped = true; clearTimeout(timer); off.forEach((f) => f?.()) }
}
