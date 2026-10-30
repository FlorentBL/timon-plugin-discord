import test from 'node:test'
import assert from 'node:assert/strict'
import { createConversation } from '../lib/conversation.js'
import { chunks, parseAnswer, conversationDay, assistantText } from '../lib/text.js'
import { world, err, Q, row, OWNER, DM, SALON, TOKEN } from './fakes.js'

async function boot(w) {
  const c = createConversation({ discord: w.discord, missions: w.missions, questions: w.questions, kv: w.kv, getConfig: async () => w.config, log: w.log, now: () => w.clock.t })
  await c.poll() // first pass: baseline on the existing history
  return c
}
const calls = (w, kind) => w.calls.filter((c) => c[0] === kind)

test('owner only: other authors, bots and webhooks are ignored', async () => {
  const w = world()
  const c = await boot(w)
  w.say(DM, 'from a stranger', { author: { id: '999' } })
  w.say(DM, 'from a bot', { author: { id: OWNER, bot: true } })
  w.say(SALON, 'from a webhook', { webhook_id: '5' })
  w.say(DM, 'system notice', { type: 7 })
  await c.poll()
  assert.equal(w.calls.length, 0)
  w.say(DM, 'hello')
  await c.poll()
  assert.deepEqual(w.calls, [['spawn', { agent: 'helper', mission: 'hello', title: 'Discord 2026-10-30' }]])
})

test('first start does not replay history; later messages are handled once', async () => {
  const w = world()
  w.say(DM, 'old DM')
  w.say(SALON, 'old salon message')
  const c = await boot(w)
  assert.equal(w.calls.length, 0)
  w.say(SALON, 'new one')
  await c.poll()
  await c.poll()
  assert.equal(w.calls.length, 1)
  assert.match(w.calls[0][1].mission, /^\[Discord #general\]\nnew one$/)
})

test('first message spawns, next ones send to the same mission', async () => {
  const w = world()
  const c = await boot(w)
  w.say(DM, 'one')
  await c.poll()
  await c.onTurnComplete({ missionId: 'M1', outcome: 'completed' })
  w.say(DM, 'two')
  await c.poll()
  assert.deepEqual(w.calls, [['spawn', { agent: 'helper', mission: 'one', title: 'Discord 2026-10-30' }], ['send', 'M1', 'two']])
})

test('messages during a turn wait in order, one per turn, none lost or duplicated', async () => {
  const w = world()
  const c = await boot(w)
  w.say(DM, 'a')
  await c.poll()
  w.say(DM, 'b')
  w.say(SALON, 'c')
  w.say(DM, 'd')
  await c.poll()
  await c.poll()
  assert.equal(w.calls.length, 1)
  assert.equal((await c.status()).queued, 3)
  await c.onTurnComplete({ missionId: 'M1', outcome: 'completed' })
  assert.deepEqual(calls(w, 'send').map((x) => x[2]), ['b'])
  await c.onTurnComplete({ missionId: 'M1', outcome: 'completed' })
  await c.onTurnComplete({ missionId: 'M1', outcome: 'completed' })
  await c.poll()
  assert.deepEqual(calls(w, 'send').map((x) => x[2].replace(/^\[Discord #general\]\n/, '')), ['b', 'c', 'd'])
  assert.equal((await c.status()).queued, 0)
})

test('turn_in_progress from the mission holds the message, which is sent later', async () => {
  const w = world()
  const c = await boot(w)
  w.say(DM, 'a')
  await c.poll()
  await c.onTurnComplete({ missionId: 'M1', outcome: 'completed' })
  w.sendError = err('turn_in_progress')
  w.say(DM, 'b')
  await c.poll()
  assert.equal((await c.status()).queued, 1)
  w.sendError = null
  await c.onTurnComplete({ missionId: 'M1', outcome: 'completed' })
  assert.equal(calls(w, 'send').filter((x) => x[2] === 'b').length, 2) // refused once, then accepted
  assert.equal((await c.status()).queued, 0)
})

test('mission gone (not_found): a new one is started', async () => {
  const w = world()
  const c = await boot(w)
  w.say(DM, 'a')
  await c.poll()
  await c.onTurnComplete({ missionId: 'M1', outcome: 'completed' })
  w.sendError = err('not_found')
  w.say(DM, 'b')
  await c.poll()
  assert.equal(calls(w, 'spawn').length, 2)
  assert.match(calls(w, 'spawn')[1][1].mission, /Previous conversation: mission M1/)
})

test('a new conversation starts on the first message after the rollover time', async () => {
  const w = world()
  const c = await boot(w)
  w.clock.t = Date.UTC(2026, 9, 30, 21, 0, 0) // 22:00 Paris
  w.say(DM, 'evening')
  await c.poll()
  await c.onTurnComplete({ missionId: 'M1', outcome: 'completed' })
  w.clock.t = Date.UTC(2026, 9, 31, 1, 30, 0) // 02:30 Paris next day: still the same day
  w.say(DM, 'night')
  await c.poll()
  assert.equal(calls(w, 'spawn').length, 1)
  await c.onTurnComplete({ missionId: 'M1', outcome: 'completed' })
  w.clock.t = Date.UTC(2026, 9, 31, 4, 0, 0) // 05:00 Paris
  w.say(DM, 'morning')
  await c.poll()
  assert.equal(calls(w, 'spawn').length, 2)
  assert.equal(calls(w, 'spawn')[1][1].title, 'Discord 2026-10-31')
  // Paris is UTC+1 after 25/10/2026: 04:00 local = 03:00 UTC
  assert.equal(conversationDay(Date.UTC(2026, 9, 31, 2, 59), 'Europe/Paris', '04:00'), '2026-10-30')
  assert.equal(conversationDay(Date.UTC(2026, 9, 31, 3, 0), 'Europe/Paris', '04:00'), '2026-10-31')
  assert.equal(conversationDay(Date.UTC(2026, 9, 31, 2, 0), 'Europe/Paris', '03:00'), '2026-10-31')
  assert.equal(conversationDay(Date.UTC(2026, 9, 31, 2, 0), 'Nowhere/Invalid', '00:00'), '2026-10-31')
})

test('reply goes to the channel the owner wrote in, quoting the message once; else DM', async () => {
  const w = world()
  const c = await boot(w)
  const m = w.say(SALON, 'from the salon')
  await c.poll()
  await c.onEvent(row('M1', 'first answer', 1))
  await c.onEvent(row('M1', 'second answer', 2))
  assert.deepEqual(w.sent.map((s) => [s.channel_id, s.replyTo]), [[SALON, m.id], [SALON, undefined]])
  await c.onTurnComplete({ missionId: 'M1', outcome: 'completed' })
  await c.onEvent(row('M1', 'unprompted', 3))
  assert.deepEqual([w.sent.at(-1).channel_id, w.sent.at(-1).replyTo], [DM, undefined])
})

test('reply in a salon that became unwritable falls back to the DM', async () => {
  const w = world()
  const c = await boot(w)
  w.say(SALON, 'hi')
  await c.poll()
  w.forbidden.add(SALON)
  await c.onEvent(row('M1', 'answer', 1))
  assert.equal(w.sent.at(-1).channel_id, DM)
})

test('replies: long text split at 2000, same row never relayed twice, result row not repeated, other missions and tools ignored', async () => {
  const w = world()
  const c = await boot(w)
  w.say(DM, 'go')
  await c.poll()
  const long = `${'word '.repeat(900)}\n${'x'.repeat(2500)}`
  await c.onEvent(row('M1', long, 1))
  await c.onEvent(row('M1', long, 1))
  assert.ok(w.sent.length >= 3 && w.sent.every((s) => s.content.length <= 2000))
  assert.equal(w.sent.map((s) => s.content).join('').replace(/\s/g, ''), long.replace(/\s/g, ''))
  const n = w.sent.length
  await c.onEvent({ missionId: 'M1', timestamp: 2, type: 'result', payload: { result: long } })
  await c.onEvent(row('OTHER', 'not ours', 3))
  await c.onEvent({ missionId: 'M1', timestamp: 4, type: 'tool_result', payload: {} })
  await c.onEvent(row('M1', 'user echo', 5, 'user'))
  assert.equal(w.sent.length, n)
})

test('failed turn: owner is told', async () => {
  const w = world()
  const c = await boot(w)
  w.say(DM, 'go')
  await c.poll()
  await c.onTurnComplete({ missionId: 'M1', outcome: 'failed' })
  assert.match(w.sent.at(-1).content, /failed/)
})

test('spawn refused: messages kept, owner told once, retried and sent when allowed', async () => {
  const w = world()
  const c = await boot(w)
  w.spawnError = err('forbidden')
  w.say(DM, 'hello')
  await assert.rejects(c.poll(), (e) => e.code === 'forbidden')
  await assert.rejects(c.poll(), (e) => e.code === 'forbidden')
  assert.equal(w.sent.filter((s) => /Could not start/.test(s.content)).length, 1)
  assert.equal((await c.status()).queued, 1)
  w.spawnError = null
  await c.poll()
  assert.equal((await c.status()).queued, 0)
  assert.equal(calls(w, 'spawn').at(-1)[1].mission, 'hello')
})

test('no agent configured: messages kept, owner told', async () => {
  const w = world()
  w.config.agent = ''
  const c = await boot(w)
  w.say(DM, 'hello')
  await c.poll()
  assert.match(w.sent.at(-1).content, /No target agent/)
  assert.equal(w.calls.length, 0)
  assert.equal((await c.status()).queued, 1)
})

test('a deleted message waiting in the queue is dropped without blocking the next', async () => {
  const w = world()
  const c = await boot(w)
  w.say(DM, 'a')
  await c.poll()
  const gone = w.say(DM, 'to delete')
  w.say(DM, 'kept')
  await c.poll()
  w.boxes[DM] = w.boxes[DM].filter((m) => m.id !== gone.id)
  await c.onTurnComplete({ missionId: 'M1', outcome: 'completed' })
  assert.deepEqual(calls(w, 'send').map((x) => x[2]), ['kept'])
})

test('an unreadable salon does not block the DM', async () => {
  const w = world()
  const c = await boot(w)
  w.forbidden.add(SALON)
  w.say(DM, 'still works')
  await c.poll()
  assert.equal(calls(w, 'spawn').length, 1)
})

test('card: posted once in DM with numbered options, numbers the cards in order', async () => {
  const w = world()
  const c = await boot(w)
  w.say(DM, 'go')
  await c.poll()
  w.pending = [Q('Q1')]
  await c.onQuestionPending({ question: Q('Q1'), origin: { kind: 'agent' } })
  await c.onQuestionPending({ question: Q('Q1'), origin: { kind: 'agent' } })
  await c.poll()
  assert.equal(w.sent.length, 1)
  assert.equal(w.sent[0].channel_id, DM)
  assert.match(w.sent[0].content, /1\. Postgres\n2\. SQLite\n3\. MySQL/)
})

test('card answers: number, free text, multi-choice, invalid number, quoted card among several', async () => {
  const w = world()
  const c = await boot(w)
  w.say(DM, 'go')
  await c.poll()
  const answers = () => calls(w, 'resolve').map((x) => ({ id: x[1], a: { ...x[2].answers } }))

  w.pending = [Q('Q1')]
  await c.onQuestionPending({ question: Q('Q1') })
  w.say(DM, '2')
  await c.poll()
  assert.deepEqual(answers(), [{ id: 'Q1', a: { 'Which database?': 'SQLite' } }])
  assert.equal(calls(w, 'send').length, 0) // the answer is not forwarded to the agent

  w.pending = [Q('Q2')]
  await c.onQuestionPending({ question: Q('Q2') })
  w.say(DM, 'something else entirely')
  await c.poll()
  assert.deepEqual(answers().at(-1), { id: 'Q2', a: { 'Which database?': 'something else entirely' } })

  const multi = Q('Q3', { questions: [{ ...Q('x').questions[0], multiSelect: true }] })
  w.pending = [multi]
  await c.onQuestionPending({ question: multi })
  w.say(DM, '1, 3')
  await c.poll()
  assert.deepEqual(answers().at(-1), { id: 'Q3', a: { 'Which database?': ['Postgres', 'MySQL'] } })

  w.pending = [Q('Q4')]
  await c.onQuestionPending({ question: Q('Q4') })
  const before = answers().length
  w.say(DM, '9')
  await c.poll()
  assert.equal(answers().length, before)
  assert.match(w.sent.at(-1).content, /out of range/)

  w.pending = [Q('Q4'), Q('Q5')]
  await c.onQuestionPending({ question: Q('Q5') })
  w.say(DM, '1')
  await c.poll()
  assert.match(w.sent.at(-1).content, /quote the card/)
  assert.equal(answers().length, before)
  const card5 = w.sent.filter((s) => /Which database/.test(s.content)).at(-1)
  w.say(DM, '3', { message_reference: { message_id: card5.id } })
  await c.poll()
  assert.deepEqual(answers().at(-1), { id: 'Q5', a: { 'Which database?': 'MySQL' } })
})

test('"//" talks to the agent even with a question waiting', async () => {
  const w = world()
  const c = await boot(w)
  w.say(DM, 'go')
  await c.poll()
  await c.onTurnComplete({ missionId: 'M1', outcome: 'completed' })
  w.pending = [Q('Q1')]
  await c.onQuestionPending({ question: Q('Q1') })
  w.say(DM, '// wait, what is this about?')
  await c.poll()
  assert.equal(calls(w, 'resolve').length, 0)
  assert.deepEqual(calls(w, 'send'), [['send', 'M1', 'wait, what is this about?']])
})

test('own answer echo is ignored; an answer given in Timon is announced; cards are forgotten', async () => {
  const w = world()
  const c = await boot(w)
  w.say(DM, 'go')
  await c.poll()
  await c.onQuestionPending({ question: Q('Q1') })
  const n = w.sent.length
  await c.onQuestionResolved({ questionId: 'Q1', question: Q('Q1'), status: 'answered', origin: { kind: 'plugin', id: 'discord' } })
  assert.equal(w.sent.length, n)
  await c.onQuestionPending({ question: Q('Q2') })
  await c.onQuestionResolved({ questionId: 'Q2', question: Q('Q2'), status: 'answered', origin: { kind: 'user' } })
  assert.match(w.sent.at(-1).content, /answered in Timon/)
  w.pending = []
  await c.poll()
  assert.deepEqual(Object.keys((await w.kv.get('state')).cards), [])
})

test('answer refused as already closed: owner is told, nothing forwarded', async () => {
  const w = world()
  const c = await boot(w)
  w.say(DM, 'go')
  await c.poll()
  w.pending = [Q('Q1')]
  await c.onQuestionPending({ question: Q('Q1') })
  w.questions.resolve = async () => { throw err('not_found') }
  w.say(DM, '1')
  await c.poll()
  assert.match(w.sent.at(-1).content, /already answered or has expired/)
})

test('Kanban plan: announced, never resolved; questions of other missions get no card', async () => {
  const w = world()
  const c = await boot(w)
  w.say(DM, 'go')
  await c.poll()
  await c.onQuestionPending({ question: Q('P1', { kind: 'series_plan', plan: { title: 'Batch A' } }) })
  assert.match(w.sent.at(-1).content, /Kanban plan: Batch A/)
  const n = w.sent.length
  await c.onQuestionPending({ question: Q('Q9', { missionId: 'SOMEONE-ELSE' }) })
  assert.equal(w.sent.length, n)
  w.say(DM, '1')
  await c.poll()
  assert.equal(calls(w, 'resolve').length, 0)
})

test('storage and logs hold no message text, no token', async () => {
  const w = world()
  const c = await boot(w)
  const secretText = 'SECRET-CONTENT-PLEASE-DO-NOT-STORE'
  w.say(DM, secretText)
  w.say(SALON, `${secretText} salon`)
  await c.poll()
  await c.onEvent(row('M1', `${secretText} reply`, 1))
  w.spawnError = err('forbidden')
  await c.onQuestionPending({ question: Q('Q1', { questions: [{ ...Q('x').questions[0], question: `${secretText}?` }] }) })
  const dump = JSON.stringify([...w.store.entries()]) + w.logs.join('\n')
  assert.ok(!dump.includes('SECRET-CONTENT'), dump)
  assert.ok(!dump.includes(TOKEN))
})

test('utilities: chunks, parseAnswer for several questions, assistantText', () => {
  assert.ok(chunks('a\n'.repeat(3000)).every((x) => x.length <= 2000))
  assert.deepEqual(chunks('short'), ['short'])
  assert.ok(chunks('y'.repeat(4500)).every((x) => x.length <= 2000))
  const q = Q('Q', { questions: [Q('x').questions[0], { ...Q('x').questions[0], question: 'What?', multiSelect: true }] })
  assert.deepEqual({ ...parseAnswer(q, '1\nQ2: 1, 2').answers }, { 'Which database?': 'Postgres', 'What?': ['Postgres', 'SQLite'] })
  assert.throws(() => parseAnswer(q, '1'), /2 line/)
  assert.equal(assistantText({ type: 'result', payload: { result: ' done ' } }), 'done')
  assert.equal(assistantText({ type: 'tool_use', payload: {} }), '')
})
