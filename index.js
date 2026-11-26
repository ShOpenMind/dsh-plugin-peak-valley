/**
 * 波峰波谷 (peak-valley) — a peak-hour gate for DeepSeek API turns.
 *
 * When a human prompt is submitted while DeepSeek's API is peak priced, the
 * Host asks one three-way question before the turn consumes tokens:
 *
 *   1. 暂不进行，到最近的空闲时段进行 — queue the prompt as a one-shot
 *      schedule aimed at the next off-peak minute, then reject the turn.
 *   2. 路由到本地模型进行 — switch this Session's model to the configured
 *      local route, re-drive the same message, and restore the previous
 *      route once that turn is idle.
 *   3. 继续进行 — run the turn now, at the peak price.
 *
 * The card itself is the generic user-questions composer card, so this bundle
 * needs no Client code: the Host registers one `agent/pre-step` waterfall and
 * awaits `ctx.userQuestions.ask()`.
 *
 * Mechanics worth knowing before editing:
 * - `agent/pre-step` fires after the inbox claimed the messages for the step,
 *   and the step's model route is frozen *before* the waterfall runs, so a
 *   pre-step listener can only change the route of the NEXT step
 *   (`agent.model.select()`), never the current one.
 * - Returning `{ kind: 'reject' }` closes the turn without a step. The claimed
 *   prompt is neither logged as `user/message` nor re-emitted, so a re-drive
 *   has to re-queue the message object itself (`agent.followup`).
 * - The rejected turn closes the driver, so the re-drive waits for the real
 *   idle boundary (`agent.whenIdle()`) before calling `agent.followup(...)`.
 *   A timer that fires while the Host is still `running` would only queue the
 *   message without waking the driver.
 * - The question is asked *without* a `wait.callId`, which is exactly the
 *   shape of a blocking composer question: the Client renders a fresh card
 *   and the answer returns through the waterfall.
 */

import { isPeak, nextOffPeak, formatBeijing } from './lib/peak.js'
import {
  buildQuestion,
  choiceFromAnswer,
  deferTitle,
  messageText,
  pickPromptMessage,
  CHOICE_CONTINUE,
  CHOICE_DEFER,
  CHOICE_LOCAL,
} from './lib/gate.js'

export const name = 'peak-valley'

/** Services this bundle needs; the plugin does not load without them. */
export const inject = ['userQuestions', 'schedule']

/** Built-in defaults; a `config:` block in cordis.patch.yml overrides fields. */
export const DEFAULTS = Object.freeze({
  enabled: true,
  providers: Object.freeze(['deepseek-official', 'deepseek-account']),
  local: Object.freeze({ provider: 'freetoken-local', model: 'Qwen3.6-35B-A3B-NVFP4' }),
  deferTitle: '波峰波谷：低谷重新提交',
})

/**
 * Register the peak-hour gate on one Host context.
 * @param {object} ctx - Cordis plugin context.
 * @param {object} [config] - optional overrides from the bundle patch.
 * @param {boolean} [config.enabled] - false disables the gate entirely.
 * @param {string[]} [config.providers] - model providers billed with peak pricing.
 * @param {{ provider: string, model: string, reasoningEffort?: string }} [config.local] - local route used by choice 2.
 * @param {string} [config.deferTitle] - schedule title prefix for choice 1.
 * @param {() => number} [config.now] - clock override for tests.
 * @returns {void}
 */
export function apply(ctx, config = {}) {
  const cfg = resolveConfig(config)
  if (!cfg.enabled) return

  const log = loggerOf(ctx)
  const pendingLocal = new Map()
  const state = { disposed: false }

  ctx.effect(() => () => {
    state.disposed = true
    pendingLocal.clear()
  }, 'peak-valley: pending re-drives')

  ctx.on('agent/pre-step', (payload, next) => gate({ ctx, cfg, log, pendingLocal, state }, payload, next))
}

/**
 * One `agent/pre-step` waterfall body: gate, defer, or route local.
 * @param {object} env - plugin state.
 * @param {object} payload - pre-step payload.
 * @param {() => Promise<object>} next - downstream step decision.
 * @returns {Promise<object>} the decision for this step.
 */
async function gate(env, payload, next) {
  const { agent, messages, step, modelSelection, signal } = payload ?? {}
  if (!agent || step !== 1) return next()

  const prompt = pickPromptMessage(messages)
  if (!prompt) return next()

  const restore = env.pendingLocal.get(prompt.id)
  if (restore) {
    // This is the re-driven turn: the route was already switched to local.
    // Put the Session back on its previous route once THIS turn is idle, so
    // only the one chosen turn runs locally.
    env.pendingLocal.delete(prompt.id)
    agent.whenIdle()
      .then(() => selectRoute(env, agent, restore.previous))
      .catch(() => {})
    return next()
  }

  if (!modelSelection || !env.cfg.providers.includes(modelSelection.provider)) return next()

  const now = env.cfg.now()
  if (!isPeak(now)) return next()
  const at = Math.max(nextOffPeak(now), now + 5_000)
  const localLabel = `${env.cfg.local.provider}/${env.cfg.local.model}`

  let answer
  try {
    answer = await env.ctx.userQuestions.ask({
      agent,
      questions: [buildQuestion({ deferAtLabel: formatBeijing(at), localLabel })],
      ...(signal ? { signal } : {}),
    })
  } catch (error) {
    // No answerer (headless/API session, delegated child) or a service
    // failure: fail open, the prompt already reached the turn.
    env.log?.debug?.(`peak-valley: question unavailable; continuing the turn (${describe(error)})`)
    return next()
  }

  switch (choiceFromAnswer(answer)) {
    case CHOICE_DEFER: return defer(env, agent, prompt, at, signal, next)
    case CHOICE_LOCAL: return routeLocal(env, agent, prompt, modelSelection, next)
    case CHOICE_CONTINUE:
    default: return next()
  }
}

/**
 * Choice 1: store the prompt as a one-shot schedule at the next off-peak
 * minute and close this turn. The schedule target is this Session, so the
 * queued prompt continues the same conversation.
 * @param {object} env - plugin state.
 * @param {object} agent - the acting Agent.
 * @param {object} prompt - the claimed user message.
 * @param {number} at - off-peak epoch ms to deliver at.
 * @param {AbortSignal | undefined} signal - turn signal.
 * @param {() => Promise<object>} next - downstream step decision.
 * @returns {Promise<object>} reject, or the normal step when queuing failed.
 */
async function defer(env, agent, prompt, at, signal, next) {
  const text = messageText(prompt)
  if (text.length === 0) {
    // The schedule API carries text only; attachments cannot be replayed.
    env.log?.warn?.('peak-valley: only text prompts can be queued; continuing the turn')
    return next()
  }

  try {
    await env.ctx.schedule.create({
      title: deferTitle(env.cfg.deferTitle, text),
      prompt: text,
      timing: { kind: 'at', at: new Date(at).toISOString() },
      target: { kind: 'session', sessionId: agent.session.id },
    }, agent.session.id, signal)
  } catch (error) {
    env.log?.warn?.(`peak-valley: could not queue the prompt; continuing the turn (${describe(error)})`)
    return next()
  }

  env.log?.info?.(`peak-valley: queued the prompt for the ${formatBeijing(at)} off-peak window`)
  return { kind: 'reject' }
}

/**
 * Choice 2: switch the next step's route to the local model, then close this
 * turn and re-queue the same message so it runs as a fresh local turn.
 * @param {object} env - plugin state.
 * @param {object} agent - the acting Agent.
 * @param {object} prompt - the claimed user message.
 * @param {{ provider: string, model: string, reasoningEffort?: string }} modelSelection - current route.
 * @param {() => Promise<object>} next - downstream step decision.
 * @returns {Promise<object>} reject, or the normal step when the switch failed.
 */
async function routeLocal(env, agent, prompt, modelSelection, next) {
  const previous = { provider: modelSelection.provider, model: modelSelection.model }
  if (modelSelection.reasoningEffort) previous.reasoningEffort = modelSelection.reasoningEffort

  const switched = selectRoute(env, agent, {
    provider: env.cfg.local.provider,
    model: env.cfg.local.model,
    ...(env.cfg.local.reasoningEffort ? { reasoningEffort: env.cfg.local.reasoningEffort } : {}),
  })
  if (!switched) return next()

  env.pendingLocal.set(prompt.id, { previous })

  // `setTimeout(…, 0)` could fire before the Host leaves `running`, and a
  // followup queued while running does not wake the driver. Waiting for the
  // real idle boundary is deterministic: the rejected turn has closed, so the
  // followup starts a fresh turn on the route selected above.
  Promise.resolve()
    .then(() => agent.whenIdle?.())
    .then(() => {
      if (env.state.disposed) return
      // The rejected turn leaves the driver idle, so followup wakes a new turn.
      agent.followup(prompt)
    })
    .catch(error => {
      env.pendingLocal.delete(prompt.id)
      env.log?.warn?.(`peak-valley: could not re-drive the prompt on the local route (${describe(error)})`)
    })

  return { kind: 'reject' }
}

/**
 * Record one durable model selection, tolerating test doubles and old hosts.
 * @param {object} env - plugin state.
 * @param {object} agent - the acting Agent.
 * @param {object} selection - provider/model/reasoningEffort.
 * @returns {boolean} true when the durable selection was recorded.
 */
function selectRoute(env, agent, selection) {
  try {
    agent.model.select(selection)
    return true
  } catch (error) {
    env.log?.warn?.(`peak-valley: could not switch the model route (${describe(error)})`)
    return false
  }
}

/**
 * Merge caller config over the built-in defaults.
 * @param {unknown} config - raw plugin config.
 * @returns {{ enabled: boolean, providers: string[], local: object, deferTitle: string, now: () => number }} normalized config.
 */
export function resolveConfig(config) {
  const source = config && typeof config === 'object' ? config : {}
  const local = source.local && typeof source.local === 'object' ? source.local : {}
  return {
    enabled: source.enabled !== false,
    providers: Array.isArray(source.providers) && source.providers.length > 0
      ? source.providers.map(String)
      : [...DEFAULTS.providers],
    local: {
      provider: typeof local.provider === 'string' && local.provider.length > 0
        ? local.provider
        : DEFAULTS.local.provider,
      model: typeof local.model === 'string' && local.model.length > 0
        ? local.model
        : DEFAULTS.local.model,
      ...(typeof local.reasoningEffort === 'string' && local.reasoningEffort.length > 0
        ? { reasoningEffort: local.reasoningEffort }
        : {}),
    },
    deferTitle: typeof source.deferTitle === 'string' && source.deferTitle.trim().length > 0
      ? source.deferTitle.trim()
      : DEFAULTS.deferTitle,
    now: typeof source.now === 'function' ? source.now : () => Date.now(),
  }
}

/**
 * Resolve the scoped Host logger without making logging a hard dependency.
 * @param {object} ctx - plugin context.
 * @returns {object | undefined} a logger when the Host provides one.
 */
function loggerOf(ctx) {
  try {
    return typeof ctx?.logger === 'function' ? ctx.logger('peak-valley') : undefined
  } catch {
    return undefined
  }
}

/**
 * Render an unknown thrown value for a log line.
 * @param {unknown} error - caught value.
 * @returns {string} a short message.
 */
function describe(error) {
  return error instanceof Error ? error.message : String(error)
}
