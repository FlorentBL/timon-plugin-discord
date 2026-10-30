// Minimal Discord REST client. `fetchImpl` is injected (ctx.fetch in production, a fake in tests).
// The bot token is never logged and never put in an error message.
const API = 'https://discord.com/api/v10'
const MAX_RETRIES = 3
const MAX_WAIT_MS = 60_000
const sleepDefault = (ms) => new Promise((r) => setTimeout(r, ms))
const byId = (a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1)

export class DiscordError extends Error {
  constructor(status, path) {
    super(`Discord ${status} on ${path}`)
    this.name = 'DiscordError'
    this.status = status
  }
}

export function createDiscord({ fetchImpl, getToken, guildId, ownerId: fixedOwner, sleep = sleepDefault }) {
  async function call(method, path, body) {
    const token = await getToken()
    if (!token) throw new Error('Discord bot token missing from the vault (entry not created or not granted)')
    for (let attempt = 0; ; attempt++) {
      const res = await fetchImpl(`${API}${path}`, {
        method,
        headers: {
          authorization: `Bot ${token}`,
          'user-agent': 'DiscordBot (timon-discord-plugin, 0.2.0)',
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      })
      if (res.status === 429 && attempt < MAX_RETRIES) {
        // Rate limited: wait for Retry-After (header, else body), then try again.
        let seconds = Number(res.headers?.get?.('retry-after'))
        if (!Number.isFinite(seconds)) seconds = Number((await res.json?.().catch(() => null))?.retry_after)
        await sleep(Math.min(MAX_WAIT_MS, Math.max(1000, Math.ceil((Number.isFinite(seconds) ? seconds : 1) * 1000))))
        continue
      }
      if (!res.ok) throw new DiscordError(res.status, path.replace(/\d{6,}/g, ':id').replace(/\?.*$/, ''))
      return res.status === 204 ? undefined : res.json()
    }
  }

  // `guildId` and `ownerId` may be values or getters (settings are read live).
  const val = (v) => (typeof v === 'function' ? v() : v)
  let owner
  const api = {
    // The configured owner, else the owner of the configured server.
    async ownerId() {
      owner ||= val(fixedOwner) || undefined
      if (owner) return owner
      const guild = val(guildId)
      if (!guild) throw new Error('no owner configured and no server id to read it from')
      owner = (await call('GET', `/guilds/${guild}`)).owner_id
      return owner
    },
    // `replyTo`: id of the message to quote (Discord reply), optional.
    sendMessage(channelId, content, replyTo) {
      return call('POST', `/channels/${channelId}/messages`, {
        content: String(content).slice(0, 2000),
        allowed_mentions: { parse: [], replied_user: false },
        ...(replyTo ? { message_reference: { message_id: String(replyTo), fail_if_not_exists: false } } : {}),
      })
    },
    async openDm() {
      return (await call('POST', '/users/@me/channels', { recipient_id: await api.ownerId() })).id
    },
    // Messages of a channel after `after` (or the latest ones), oldest first, whoever wrote them.
    async readMessages(channelId, { after, limit = 50 } = {}) {
      const q = new URLSearchParams({ limit: String(limit), ...(after ? { after } : {}) })
      const sorted = [...(await call('GET', `/channels/${channelId}/messages?${q}`))].sort(byId)
      return { lastId: sorted.at(-1)?.id ?? after, messages: sorted }
    },
    // Same, restricted to the owner's own (non-bot) messages.
    async readOwnerMessages(channelId, afterId) {
      const owner = await api.ownerId()
      const { lastId, messages } = await api.readMessages(channelId, { after: afterId })
      return { lastId, messages: messages.filter((m) => m.author?.id === owner && !m.author.bot) }
    },
    getMessage: (channelId, messageId) => call('GET', `/channels/${channelId}/messages/${messageId}`),
    async channelName(channelId) {
      return (await call('GET', `/channels/${channelId}`)).name
    },
  }
  return api
}
