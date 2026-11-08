import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createAssistantMessage, createSystemMessage, createToolResultMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { Message } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { TemporaryMessages } from '../src/messages.ts'
import type { Compressor } from '../src/compressors.ts'

function initial(name: string) {
  const session = Session.create(SessionId(name))
  session.append('system/message', { turn: 1, step: 1, message: createSystemMessage('system') }, { surfaceOp: 'append' })
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'original input' }], source: { kind: 'temporary-message-cleared' } }), { surfaceOp: 'append' })
  return session
}
function deliver(queue: TemporaryMessages, session: Session) {
  for (const message of queue.pending(session)) session.append('user/message', message, { surfaceOp: 'append' })
}
function answer(session: Session, text = 'answer') {
  session.append('assistant/message', { turn: 1, step: 1, stream: [], usage: { inputTokens: 100, outputTokens: 10 },
    message: createAssistantMessage({ source: { provider: 'test', model: 'test' }, content: [{ type: 'text', text }] }),
  }, { surfaceOp: 'append' })
}
function contents(session: Session) {
  return session.deriveMessages().map(message => ({ role: message.role, content: message.content }))
}

const scenarios: { name: string; prepare: (session: Session, queue: TemporaryMessages) => void; move?: true; compressor?: Compressor }[] = [
  { name: '长寿命消息重新排队', prepare(session, queue) {
    queue.push(session, { text: 'must survive', ttlTokens: 1000 })
    deliver(queue, session)
    answer(session)
  } },
  { name: '移动到尾部', move: true, prepare(session, queue) {
    queue.push(session, { text: 'must survive', ttlTokens: 1000 })
    deliver(queue, session)
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'late context' }], source: { kind: 'temporary-message-cleared' } }), { surfaceOp: 'append' })
  } },
  { name: '摘要替换多条历史', compressor: async () => 'SUMMARY_ONLY', prepare(session, queue) {
    queue.push(session, { text: 'temporary' })
    deliver(queue, session)
    answer(session, 'first output')
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'middle input' }], source: { kind: 'temporary-message-cleared' } }), { surfaceOp: 'append' })
    answer(session, 'second output')
  } },
  { name: '清除已完成的工具调用与结果', compressor: async () => [], prepare(session, queue) {
    queue.push(session, { text: 'temporary' })
    deliver(queue, session)
    session.append('assistant/message', { turn: 1, step: 1, stream: [], usage: { inputTokens: 100, outputTokens: 10 },
      message: createAssistantMessage({ source: { provider: 'test', model: 'test' }, content: [{ type: 'tool-call', id: ToolCallId('completed-call'), name: 'probe', arguments: '{}' }] }),
    }, { surfaceOp: 'append' })
    session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId: ToolCallId('completed-call'), isError: false, content: [{ type: 'text', text: 'completed-result' }] }) }, { surfaceOp: 'append' })
    answer(session, 'second output')
  } },
]

for (const scenario of scenarios) test(`${scenario.name}：逐个日志截断点及恢复中再次中断均能补完`, async () => {
  const session = initial(scenario.name)
  const queue = new TemporaryMessages(() => 0, scenario.compressor)
  scenario.prepare(session, queue)
  const before = session.snapshotEvents()
  if (scenario.move) queue.moveToTail(session, { turn: 2, step: 1 })
  else await queue.clean(session, { turn: 2, step: 1 })
  const after = session.snapshotEvents()
  deliver(queue, session)
  const expected = contents(session)
  for (let cut = before.length; cut <= after.length; cut++) {
    const restored = Session.create(session.id, after.slice(0, cut))
    const resumed = new TemporaryMessages(() => 0, scenario.compressor)
    if (scenario.move) resumed.moveToTail(restored, { turn: 2, step: 1 })
    else await resumed.clean(restored, { turn: 2, step: 1 })
    const recovered = restored.snapshotEvents()
    deliver(resumed, restored)
    assert.deepEqual(contents(restored), expected, `第一次截断在 ${cut - before.length}`)
    for (let second = cut; second <= recovered.length; second++) {
      const twice = Session.create(session.id, recovered.slice(0, second))
      const restarted = new TemporaryMessages(() => 0, scenario.compressor)
      if (scenario.move) restarted.moveToTail(twice, { turn: 2, step: 1 })
      else await restarted.clean(twice, { turn: 2, step: 1 })
      deliver(restarted, twice)
      assert.deepEqual(contents(twice), expected, `再次截断在 ${second}`)
      assert.deepEqual(Session.create(twice.id, twice.snapshotEvents()).deriveMessages(), twice.deriveMessages())
    }
  }
})

test('已记录的单次函数结果在重启后直接补写，不重复调用也不依赖原函数', async () => {
  const session = initial('saved-inline-result')
  const queue = new TemporaryMessages()
  let calls = 0
  queue.push(session, { text: 'temporary', compressor: async () => { calls++; return 'saved summary' } })
  deliver(queue, session)
  answer(session)
  const before = session.seq
  await queue.clean(session, { turn: 2, step: 1 })
  const events = session.snapshotEvents()
  for (let cut = before + 1; cut <= events.length; cut++) {
    const restored = Session.create(session.id, events.slice(0, cut))
    const resumed = new TemporaryMessages(() => 0, async () => { throw new Error('不应重新压缩') })
    await resumed.clean(restored, { turn: 2, step: 1 })
    assert.deepEqual(contents(restored), contents(session))
  }
  assert.equal(calls, 1)
})

for (const change of ['replace', 'remove']) test(`压缩等待期间的 ${change} 操作不会被旧消息回队覆盖`, async () => {
  const session = initial(`during-compression-${change}`)
  let release!: (value: readonly Message[]) => void
  const gate = new Promise<readonly Message[]>(resolve => { release = resolve })
  const queue = new TemporaryMessages(() => 0, async () => gate)
  queue.push(session, { text: 'expiring' })
  const id = queue.push(session, { text: 'old status', key: 'status', ttlTokens: 1000 })
  deliver(queue, session)
  answer(session)
  const cleaning = queue.clean(session, { turn: 2, step: 1 })
  if (change === 'replace') queue.push(session, { text: 'new status', key: 'status', ttlTokens: 1000 })
  else queue.remove(session, id)
  release([])
  await cleaning
  deliver(queue, session)
  const texts = session.deriveMessages().flatMap(message => message.content.flatMap(block => block.type === 'text' ? [block.text] : []))
  assert.deepEqual(texts, change === 'replace' ? ['system', 'original input', 'new status'] : ['system', 'original input'])
})
