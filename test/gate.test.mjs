import test from 'node:test'
import assert from 'node:assert/strict'

import {
  OPTION_CONTINUE,
  OPTION_DEFER,
  OPTION_LOCAL,
  buildQuestion,
  choiceFromAnswer,
  deferTitle,
  messageText,
  pickPromptMessage,
} from '../lib/gate.js'

const answer = (...selected) => ({
  answers: [{ id: 'peak-valley-gate', selected }],
})

test('buildQuestion offers exactly the three documented choices', () => {
  const question = buildQuestion({ deferAtLabel: '11-26 12:00', localLabel: 'freetoken-local/Qwen' })
  assert.equal(question.id, 'peak-valley-gate')
  assert.equal(question.header, '高峰时段')
  assert.match(question.question, /高峰时段/)
  assert.deepEqual(question.options.map(option => option.label), [OPTION_DEFER, OPTION_LOCAL, OPTION_CONTINUE])
  assert.match(question.options[0].description, /11-26 12:00/)
  assert.match(question.options[1].description, /freetoken-local\/Qwen/)
  assert.equal(question.intent, undefined)
})

test('choiceFromAnswer maps the three labels', () => {
  assert.equal(choiceFromAnswer(answer(OPTION_DEFER)), 'defer')
  assert.equal(choiceFromAnswer(answer(OPTION_LOCAL)), 'local')
  assert.equal(choiceFromAnswer(answer(OPTION_CONTINUE)), 'continue')
})

test('skipped, empty, custom, and unknown answers fail open to continue', () => {
  assert.equal(choiceFromAnswer(answer()), 'continue')
  assert.equal(choiceFromAnswer(undefined), 'continue')
  assert.equal(choiceFromAnswer({ answers: [] }), 'continue')
  assert.equal(choiceFromAnswer({ answers: [{ id: 'peak-valley-gate', selected: [], custom: '先别跑' }] }), 'continue')
  assert.equal(choiceFromAnswer({ answers: [{ id: 'other', selected: ['x'] }] }), 'continue')
})

test('pickPromptMessage only accepts a human user prompt', () => {
  const user = { role: 'user', source: { kind: 'user' }, content: [] }
  const scheduled = { role: 'user', source: { kind: 'schedule' }, content: [] }
  const reply = { role: 'user', source: { kind: 'user-question-reply' }, content: [] }
  const assistant = { role: 'assistant', source: { kind: 'model' }, content: [] }

  assert.equal(pickPromptMessage([assistant, scheduled, reply, user]), user)
  assert.equal(pickPromptMessage([scheduled, reply]), undefined)
  assert.equal(pickPromptMessage(undefined), undefined)
})

test('messageText joins text blocks and ignores non-text blocks', () => {
  assert.equal(messageText({ content: [{ type: 'text', text: '第一行' }, { type: 'image' }, { type: 'text', text: '第二行' }] }), '第一行\n第二行')
  assert.equal(messageText({ content: [{ type: 'image' }] }), '')
  assert.equal(messageText({}), '')
})

test('deferTitle clips to the schedule title limit', () => {
  const long = '重构'.repeat(200)
  const title = deferTitle('波峰波谷：低谷重新提交', long)
  assert.ok(title.length <= 120)
  assert.ok(title.startsWith('波峰波谷：低谷重新提交：'))
  assert.equal(deferTitle('波峰波谷：低谷重新提交', ''), '波峰波谷：低谷重新提交')
})
