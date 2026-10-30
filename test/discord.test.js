import test from 'node:test'
import assert from 'node:assert/strict'
import { createDiscord, DiscordError } from '../lib/discord.js'

const OWNER = '111111111111111111'
const TOKEN = 'FAKE-TOKEN-FOR-TESTS'
const json = (b, status = 200, headers = {}) => ({ ok: status < 300, status, headers: { get: (k) => headers[k.toLowerCase()] }, json: async () => b })
const msg = (id, uid, content, bot = false) => ({ id, content, author: { id: uid, bot } })

function fake(routes) {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    const path = url.replace('https://discord.com/api/v10', '')
    calls.push({ method: init.method, path, auth: init.headers.authorization, body: init.body && JSON.parse(init.body) })
    return routes(path, init, calls.length)
  }
  return { fetchImpl, calls }
}
const make = (f, extra = {}) => createDiscord({ fetchImpl: f.fetchImpl, getToken: async () => TOKEN, guildId: 'G1', sleep: async () => {}, ...extra })

test('send: Bot header, JSON body, mentions disabled, content cut at 2000, optional quote', async () => {
  const f = fake(() => json({ id: '9' }))
  await make(f).sendMessage('CH', 'x'.repeat(2500), '77')
  const c = f.calls[0]
  assert.equal(c.auth, `Bot ${TOKEN}`)
  assert.equal(c.body.content.length, 2000)
  assert.deepEqual(c.body.allowed_mentions, { parse: [], replied_user: false })
  assert.deepEqual(c.body.message_reference, { message_id: '77', fail_if_not_exists: false })
})

test('missing token: clear error, no network call', async () => {
  const f = fake(() => json({}))
  await assert.rejects(make(f, { getToken: async () => undefined }).sendMessage('CH', 'x'), /token missing/)
  assert.equal(f.calls.length, 0)
})

test('HTTP error: neither token nor ids nor query in the message', async () => {
  const f = fake(() => json({}, 403))
  await assert.rejects(make(f).sendMessage('123456789012', 'x'),
    (e) => e instanceof DiscordError && e.status === 403 && !e.message.includes(TOKEN) && !e.message.includes('123456789012'))
})

test('owner: configured id wins, otherwise the server owner (read once)', async () => {
  const f = fake((p) => (p === '/guilds/G1' ? json({ owner_id: OWNER }) : json({}, 404)))
  const d = make(f)
  assert.equal(await d.ownerId(), OWNER)
  await d.ownerId()
  assert.equal(f.calls.length, 1)
  assert.equal(await make(fake(() => json({}, 500)), { ownerId: () => '5' }).ownerId(), '5')
  await assert.rejects(createDiscord({ fetchImpl: f.fetchImpl, getToken: async () => TOKEN }).ownerId(), /no owner/)
})

test('read: ascending order, owner filter keeps only non-bot owner messages', async () => {
  const list = [msg('103', OWNER, 'bot', true), msg('100', OWNER, 'a'), msg('102', OWNER, 'b'), msg('101', '222', 'intruder')]
  const f = fake((p) => (p.startsWith('/guilds') ? json({ owner_id: OWNER }) : json(list)))
  const d = make(f)
  const all = await d.readMessages('CH', { after: '99' })
  assert.deepEqual(all.messages.map((m) => m.id), ['100', '101', '102', '103'])
  assert.equal(all.lastId, '103')
  assert.deepEqual((await d.readOwnerMessages('CH')).messages.map((m) => m.content), ['a', 'b'])
  assert.match(f.calls.find((c) => c.path.includes('after=99')).path, /limit=50/)
})

test('rate limit: waits for Retry-After then retries; gives up after 3 retries', async () => {
  const waits = []
  let n = 0
  const f = fake(() => (++n < 3 ? json({}, 429, { 'retry-after': '2' }) : json({ id: '1' })))
  const d = make(f, { sleep: async (ms) => void waits.push(ms) })
  assert.equal((await d.sendMessage('CH', 'x')).id, '1')
  assert.deepEqual(waits, [2000, 2000])
  const g = fake(() => json({}, 429))
  await assert.rejects(make(g).sendMessage('CH', 'x'), (e) => e.status === 429)
  assert.equal(g.calls.length, 4)
})
