import test from 'node:test'
import assert from 'node:assert/strict'
import { apply, readSettings } from '../lib/index.js'
import pkg from '../package.json' with { type: 'json' }

function fakeCtx(settings, { user } = {}) {
  const routes = {}
  const handlers = {}
  const router = { get: (p, h) => (routes[`GET ${p}`] = h), post: (p, h) => (routes[`POST ${p}`] = h) }
  const fetched = []
  const ctx = {
    fetch: async (url) => { fetched.push(url); return { ok: true, status: 200, json: async () => ({}) } },
    secrets: { get: async () => 'FAKE' },
    settings: { get: (k) => settings[k] },
    storage: { kv: { get: async () => undefined, set: async () => {} } },
    missions: {}, questions: { list: async () => [] }, log: { info() {}, warn() {} },
    events: { on: (k, h) => { handlers[k] = h; return () => delete handlers[k] } },
    router: () => router,
    user: () => user,
  }
  return { ctx, routes, handlers, fetched }
}
const call = async (h) => { const out = {}; await h({}, { status(s) { out.status = s; return this }, json(b) { out.body = b } }); return out }

test('manifest: id discord, apiVersion 10, only used permissions, polling off by default, no personal data', () => {
  assert.equal(pkg.timon.id, 'discord')
  assert.equal(pkg.timon.apiVersion, 10)
  assert.equal(pkg.timon.settings.find((s) => s.key === 'pollEnabled').default, false)
  assert.ok(!pkg.timon.permissions.includes('notifications:read'))
  const { author, repository, timon: { author: _a, ...manifest }, ...rest } = pkg
  assert.ok(!JSON.stringify({ ...rest, manifest }).match(/fbl|sauron|florent/i))
})

test('settings: defaults, channel list parsing, minimum interval', () => {
  const s = readSettings({ get: (k) => ({ channels: '123456, abc 789012;345678', pollSeconds: 1, pollEnabled: true }[k]) })
  assert.deepEqual(s.channels, ['123456', '789012', '345678'])
  assert.equal(s.pollMs, 5000)
  assert.equal(s.rollover, '04:00')
  assert.equal(s.tokenSecret, 'DISCORD_BOT_TOKEN')
  assert.equal(s.enabled, true)
  assert.equal(readSettings({ get: () => undefined }).enabled, false)
})

test('only route is /status, it needs a signed-in account, no probe route', async () => {
  const anon = fakeCtx({})
  apply(anon.ctx)()
  assert.deepEqual(Object.keys(anon.routes), ['GET /status'])
  assert.equal((await call(anon.routes['GET /status'])).status, 401)
  const signed = fakeCtx({}, { user: { id: 'u1' } })
  apply(signed.ctx)()
  const out = await call(signed.routes['GET /status'])
  assert.deepEqual(out.body, { enabled: false, mission: false, turnActive: false, queued: 0, cards: 0 })
})

test('polling off: no network call, events do nothing; teardown unsubscribes', async () => {
  const f = fakeCtx({ pollEnabled: false })
  const off = apply(f.ctx)
  assert.deepEqual(Object.keys(f.handlers).sort(), ['event', 'question_pending', 'question_resolved', 'turn_complete'])
  await f.handlers.event({ missionId: 'M1', type: 'assistant', payload: {} })
  assert.equal(f.fetched.length, 0)
  off()
  assert.deepEqual(Object.keys(f.handlers), [])
})

test('token: sealed botToken setting first, vault entry otherwise', async () => {
  const { tokenOf } = await import('../lib/index.js')
  const vault = { DISCORD_BOT_TOKEN: 'from-vault', OTHER: 'other-vault' }
  const mk = (settings) => ({ settings: { get: (k) => settings[k] }, secrets: { get: async (n) => vault[n] } })
  assert.equal(await tokenOf(mk({ botToken: ' from-setting ' })), 'from-setting')
  assert.equal(await tokenOf(mk({})), 'from-vault')
  assert.equal(await tokenOf(mk({ botToken: '', tokenSecret: 'OTHER' })), 'other-vault')
})
