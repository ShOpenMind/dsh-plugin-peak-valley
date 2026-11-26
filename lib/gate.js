/**
 * Pure helpers for the peak-hour gate: the three-way question, answer
 * mapping, and the bits of a user message the plugin needs. No I/O here, so
 * every rule below is covered by plain `node --test` unit tests.
 */

/** Option label: queue the prompt and re-submit it in the next off-peak window. */
export const OPTION_DEFER = '暂不进行，到最近的空闲时段进行'

/** Option label: run this turn on the configured local model. */
export const OPTION_LOCAL = '路由到本地模型进行'

/** Option label: run this turn now, at the peak price. */
export const OPTION_CONTINUE = '继续进行'

/** Machine choices derived from an answer. */
export const CHOICE_DEFER = 'defer'
export const CHOICE_LOCAL = 'local'
export const CHOICE_CONTINUE = 'continue'

/**
 * Build the single question shown in the composer at a peak submission.
 * No `intent` and no `wait`: a plain question renders as an interactive card
 * and its answer travels back through the `user-questions/request` waterfall.
 * @param {{ deferAtLabel: string, localLabel: string }} labels - dynamic copy.
 * @returns {object} one `AskUserQuestionItem`-shaped question.
 */
export function buildQuestion({ deferAtLabel, localLabel }) {
  return {
    id: 'peak-valley-gate',
    header: '高峰时段',
    question: '当前处于高峰时段，是否继续进行？',
    detail: 'DeepSeek API 现在按高峰价计费：工作日北京时间 09:00–12:00、14:00–18:00，价格是低谷的两倍。',
    options: [
      {
        label: OPTION_DEFER,
        description: `排队到最近的低谷时段（${deferAtLabel}，北京时间）自动重新提交这条消息`,
      },
      {
        label: OPTION_LOCAL,
        description: `本回合改用本地模型 ${localLabel} 运行，不产生 DeepSeek API 费用`,
      },
      {
        label: OPTION_CONTINUE,
        description: '按高峰价立即执行（本回合照常走 DeepSeek API）',
      },
    ],
  }
}

/**
 * Map one user-questions answer onto a gate choice.
 *
 * Unknown shapes fail open to `continue`: the prompt was already submitted,
 * so silently dropping it is worse than paying the peak price. A skipped
 * question, an empty selection, and a free-form custom answer all continue.
 * @param {unknown} answer - `AskUserQuestionAnswer` or anything unexpected.
 * @returns {'defer' | 'local' | 'continue'} the choice to act on.
 */
export function choiceFromAnswer(answer) {
  const answers = answer && typeof answer === 'object' && Array.isArray(answer.answers)
    ? answer.answers
    : []
  const first = answers.find(item => item && item.id === 'peak-valley-gate') ?? answers[0]
  const selected = first && Array.isArray(first.selected) ? first.selected : []
  if (selected.includes(OPTION_DEFER)) return CHOICE_DEFER
  if (selected.includes(OPTION_LOCAL)) return CHOICE_LOCAL
  if (selected.includes(OPTION_CONTINUE)) return CHOICE_CONTINUE
  return CHOICE_CONTINUE
}

/**
 * Find the freshly submitted human prompt among the messages entering a step.
 *
 * Only `source.kind === 'user'` counts. Scheduled re-deliveries (`schedule`),
 * question replies, model-selection notices, goal rounds, and injected
 * context must never trigger the gate.
 * @param {readonly object[]} messages - messages claimed for this step.
 * @returns {object | undefined} the first human prompt, if any.
 */
export function pickPromptMessage(messages) {
  if (!Array.isArray(messages)) return undefined
  return messages.find(message => message
    && message.role === 'user'
    && message.source
    && message.source.kind === 'user')
}

/**
 * Join the text blocks of one message.
 * @param {object} message - a `UserMessage`.
 * @returns {string} the message text, trimmed; empty when it has no text.
 */
export function messageText(message) {
  const content = Array.isArray(message?.content) ? message.content : []
  return content
    .filter(block => block && block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
    .trim()
}

/**
 * Build one schedule title, clipped to the 120-character limit.
 * @param {string} base - configured title prefix.
 * @param {string} text - the queued prompt text.
 * @returns {string} a non-empty title within the limit.
 */
export function deferTitle(base, text) {
  const snippet = text.replace(/\s+/g, ' ').slice(0, 40)
  const title = snippet.length > 0 ? `${base}：${snippet}` : base
  return title.slice(0, 120)
}
