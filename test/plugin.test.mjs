import test from 'node:test'
import assert from 'node:assert/strict'

import { apply, resolveConfig, DEFAULTS } from '../index.js'
import { OPTION_CONTINUE, OPTION_DEFER, OPTION_LOCAL } from '../lib/gate.js'

const PEAK = Date.parse('2026-11-26T02:00:00Z') // Thursday 10:00 Beijing
const OFF_PEAK = Date.parse('2026-11-26T04:00:00Z') // Thursday 12:00 Beijing
const DEEPSEEK = { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max' }
const LOCAL_ROUTE = { provider: 'freetoken-local', model: 'Qwen3.6-35B-A3B-NVFP4' }
const NEXT = async () => 'NEXT'
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

const answer = (...selected) => ({
  answers: [{ id: 'peak-valley-gate', selected }],
})

function userMessage(text = '帮我把这个脚本重构成零依赖的') {
  return { id: 'message-1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] }
}

function makeAgent({ selectError } = {}) {
  const calls = { select: [], followup: [] }
  const agent = {
    session: { id: 'session-1' },
    model: {
      select: selection => {
        if (selectError) throw selectError
        calls.select.push(selection)
      },
    },
    whenIdle: async () => {},
    followup: message => calls.followup.push(message),
  }
  return { agent, calls }
}

function setup(options = {}) {
  const calls = { ask: [], schedule: [], select: [], followup: [] }
  let handler
  const ctx = {
    effect(fn) {
      const dispose = fn()
      return () => dispose?.()
    },
    on(event, fn) {
      assert.equal(event, 'agent/pre-step')
      handler = fn
      return () => {}
    },
    userQuestions: {
      async ask(request) {
        calls.ask.push(request)
        if (options.askHang) return new Promise(() => {})
        if (options.askError) throw options.askError
        return options.answer
      },
    },
    schedule: {
      async create(request) {
        calls.schedule.push(request)
        if (options.scheduleError) throw options.scheduleError
        return { id: 'schedule-1' }
      },
    },
    logger: () => ({ info() {}, warn() {}, debug() {} }),
  }
  apply(ctx, {
    now: () => options.now ?? PEAK,
    ...(options.config ?? {}),
  })
  return { calls, gate: (payload, next = NEXT) => handler(payload, next), registered: handler !== undefined }
}

function payload(agent, message = userMessage(), selection = DEEPSEEK, step = 1) {
  return { agent, messages: [message], turn: 1, step, signal: undefined, modelSelection: selection }
}

test('continue runs the step normally', async () => {
  const s = setup({ answer: answer(OPTION_CONTINUE) })
  const { agent } = makeAgent()
  assert.equal(await s.gate(payload(agent)), 'NEXT')
  assert.equal(s.calls.ask.length, 1)
  assert.equal(s.calls.schedule.length, 0)
})

test('defer queues the prompt for the next off-peak minute and rejects the turn', async () => {
  const s = setup({ answer: answer(OPTION_DEFER) })
  const { agent } = makeAgent()
  const message = userMessage('把这段代码重构一下')
  assert.deepEqual(await s.gate(payload(agent, message)), { kind: 'reject' })

  assert.equal(s.calls.schedule.length, 1)
  const request = s.calls.schedule[0]
  assert.equal(request.target.kind, 'session')
  assert.equal(request.target.sessionId, 'session-1')
  assert.equal(request.timing.kind, 'at')
  assert.equal(request.timing.at, '2026-11-26T04:00:00.000Z')
  assert.equal(request.prompt, '把这段代码重构一下')
  assert.ok(request.title.startsWith(DEFAULTS.deferTitle))
  assert.ok(request.title.length <= 120)
})

test('defer keeps the turn when the prompt has no text', async () => {
  const s = setup({ answer: answer(OPTION_DEFER) })
  const { agent } = makeAgent()
  const message = { id: 'message-2', role: 'user', source: { kind: 'user' }, content: [{ type: 'image' }] }
  assert.equal(await s.gate(payload(agent, message)), 'NEXT')
  assert.equal(s.calls.schedule.length, 0)
})

test('local switches the route, rejects, and re-drives the same message once', async () => {
  const s = setup({ answer: answer(OPTION_LOCAL) })
  const { agent, calls } = makeAgent()
  const message = userMessage()

  assert.deepEqual(await s.gate(payload(agent, message)), { kind: 'reject' })
  assert.deepEqual(calls.select, [LOCAL_ROUTE])

  await delay(10)
  assert.equal(calls.followup.length, 1)
  assert.equal(calls.followup[0], message)

  // The re-driven turn starts on the local route: no question, step proceeds.
  assert.equal(await s.gate(payload(agent, message, LOCAL_ROUTE)), 'NEXT')
  assert.equal(s.calls.ask.length, 1)

  // Once that turn is idle the session goes back to its previous route.
  await delay(10)
  assert.deepEqual(calls.select, [LOCAL_ROUTE, DEEPSEEK])
})

test('a failed route switch fails open instead of dropping the prompt', async () => {
  const s = setup({ answer: answer(OPTION_LOCAL) })
  const { agent, calls } = makeAgent({ selectError: new Error('unknown provider') })
  const message = userMessage()
  assert.equal(await s.gate(payload(agent, message)), 'NEXT')
  await delay(10)
  assert.equal(calls.followup.length, 0)
  assert.equal(s.calls.ask.length, 1)
})

test('a question that is never answered times out and continues', async () => {
  const s = setup({ askHang: true, config: { askTimeoutMs: 25 } })
  const { agent } = makeAgent()
  assert.equal(await s.gate(payload(agent)), 'NEXT')
  assert.equal(s.calls.ask.length, 1)
})

test('an unavailable question answerer fails open', async () => {
  const s = setup({ askError: new Error('no answerer') })
  const { agent } = makeAgent()
  assert.equal(await s.gate(payload(agent)), 'NEXT')
  assert.equal(s.calls.schedule.length, 0)
})

test('a scheduling failure fails open instead of dropping the prompt', async () => {
  const s = setup({ answer: answer(OPTION_DEFER), scheduleError: new Error('no schedule service') })
  const { agent } = makeAgent()
  assert.equal(await s.gate(payload(agent)), 'NEXT')
})

test('off-peak turns are never gated', async () => {
  const s = setup({ now: OFF_PEAK, answer: answer(OPTION_CONTINUE) })
  const { agent } = makeAgent()
  assert.equal(await s.gate(payload(agent)), 'NEXT')
  assert.equal(s.calls.ask.length, 0)
})

test('only human prompts are gated', async () => {
  const s = setup({ answer: answer(OPTION_CONTINUE) })
  const { agent } = makeAgent()
  const scheduled = { id: 'message-3', role: 'user', source: { kind: 'schedule' }, content: [{ type: 'text', text: '定时任务' }] }
  assert.equal(await s.gate(payload(agent, scheduled)), 'NEXT')
  assert.equal(s.calls.ask.length, 0)
})

test('only configured providers are gated', async () => {
  const s = setup({ answer: answer(OPTION_CONTINUE) })
  const { agent } = makeAgent()
  assert.equal(await s.gate(payload(agent, userMessage(), LOCAL_ROUTE)), 'NEXT')
  assert.equal(s.calls.ask.length, 0)
})

test('only the first step of a turn is gated', async () => {
  const s = setup({ answer: answer(OPTION_CONTINUE) })
  const { agent } = makeAgent()
  assert.equal(await s.gate(payload(agent, userMessage(), DEEPSEEK, 2)), 'NEXT')
  assert.equal(s.calls.ask.length, 0)
})

test('disabled config registers nothing', () => {
  const s = setup({ answer: answer(OPTION_CONTINUE), config: { enabled: false } })
  assert.equal(s.registered, false)
})

test('resolveConfig merges partial overrides over the defaults', () => {
  const defaults = resolveConfig()
  assert.equal(defaults.enabled, true)
  assert.ok(defaults.providers.includes('deepseek-official'))
  assert.equal(defaults.local.model, DEFAULTS.local.model)
  assert.deepEqual(defaults.local, { ...DEFAULTS.local })

  const custom = resolveConfig({
    providers: ['deepseek-official'],
    local: { provider: 'freetoken-qwen', model: 'Download', reasoningEffort: 'low' },
    deferTitle: ' 夜间再跑 ',
  })
  assert.deepEqual(custom.providers, ['deepseek-official'])
  assert.deepEqual(custom.local, { provider: 'freetoken-qwen', model: 'Download', reasoningEffort: 'low' })
  assert.equal(custom.deferTitle, '夜间再跑')
  assert.equal(custom.enabled, true)
})
