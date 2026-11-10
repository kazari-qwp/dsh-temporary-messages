import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ToolCallId, createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { TemporaryMessages } from '../src/messages.ts'
import { compressors } from '../src/compressors.ts'
import type { Message } from '@deepseek-ai/dsh-llm'

function answer(session: Session, tokens: number) {
  session.append('assistant/message', {
    turn: 1, step: 1, stream: [],
    message: createAssistantMessage({ content: [{ type: 'text', text: 'answer' }], source: { provider: 'test', model: 'test' } }),
    usage: { inputTokens: 90000, outputTokens: tokens },
  }, { surfaceOp: 'append' })
}
function deliver(queue: TemporaryMessages, session: Session) {
  for (const message of queue.pending(session)) session.append('user/message', message, { surfaceOp: 'append' })
}
function texts(session: Session) {
  return session.deriveMessages().flatMap(message => message.content.flatMap(block => block.type === 'text' ? [block.text] : []))
}

test('一次性消息撤出模型输入，但普通消息、回答和原始日志保留', async () => {
  const session = Session.create(SessionId('once'))
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'normal' }], source: { kind: 'temporary-message-cleared' } }), { surfaceOp: 'append' })
  const queue = new TemporaryMessages()
  queue.push(session, { text: 'temporary' })
  deliver(queue, session)
  answer(session, 100)
  const answerMessage = session.deriveMessages().at(-1)
  const answerSeq = session.surface.nodes.at(-1)
  await queue.clean(session, { turn: 2, step: 1 })
  assert.deepEqual(texts(session), ['normal', 'answer'])
  assert.ok(session.snapshotEvents().some(event => event.type === 'user/message' && event.data.content.some(block => block.type === 'text' && block.text === 'temporary')))
  assert.equal(queue.pending(session).length, 0)
  assert.equal(session.deriveMessages().at(-1), answerMessage)
  assert.ok(session.surface.nodes.includes(answerSeq!))
})

test('token 寿命累计输出计数，不把 90000 输入重复累加；达到阈值才移除', async () => {
  const session = Session.create(SessionId('ttl'))
  const queue = new TemporaryMessages()
  queue.push(session, { text: 'lasts 200', ttlTokens: 200 })
  deliver(queue, session)
  answer(session, 100)
  await queue.clean(session, { turn: 2, step: 1 })
  assert.ok(!texts(session).includes('lasts 200'))
  deliver(queue, session)
  assert.ok(texts(session).includes('lasts 200'))
  answer(session, 100)
  await queue.clean(session, { turn: 3, step: 1 })
  assert.ok(!texts(session).includes('lasts 200'))
})

test('队列与寿命可从日志恢复，取消和 key 更新只影响相应消息', async () => {
  const session = Session.create(SessionId('restore'))
  const first = new TemporaryMessages()
  first.push(session, { text: 'old balance', key: 'balance', ttlTokens: 1000 })
  deliver(first, session)
  answer(session, 100)
  first.push(session, { text: 'new balance', key: 'balance', ttlTokens: 200 })
  const canceled = first.push(session, { text: 'canceled' })
  first.remove(session, canceled)

  const restored = Session.create(SessionId('restore'), session.snapshotEvents())
  const second = new TemporaryMessages()
  await second.clean(restored, { turn: 2, step: 1 })
  deliver(second, restored)
  assert.deepEqual(texts(restored), ['answer', 'new balance'])
  answer(restored, 200)
  await new TemporaryMessages().clean(restored, { turn: 3, step: 1 })
  assert.ok(!texts(restored).includes('new balance'))
})

test('队列不跨会话，未消费消息能恢复，非法寿命立即拒绝', () => {
  const a = Session.create(SessionId('a'))
  const b = Session.create(SessionId('b'))
  const queue = new TemporaryMessages()
  queue.push(a, { text: 'a only' })
  assert.equal(queue.pending(b).length, 0)
  const restored = Session.create(SessionId('a'), a.snapshotEvents())
  assert.equal(new TemporaryMessages().pending(restored).length, 1)
  assert.throws(() => queue.push(a, { text: 'invalid', ttlTokens: -1 }), /ttlTokens/)
})

test('同批删除把最早位置之后的剩余消息交给压缩器一次，并等待结果再写回', async () => {
  const session = Session.create(SessionId('compress-batch'))
  const prefix = createUserMessage({ content: [{ type: 'text', text: 'prefix' }], source: { kind: 'temporary-message-cleared' } })
  session.append('user/message', prefix, { surfaceOp: 'append' })
  let finish!: (messages: readonly Message[]) => void
  const gate = new Promise<readonly Message[]>(resolve => { finish = resolve })
  const calls: (readonly Message[])[] = []
  const queue = new TemporaryMessages(() => 0, async messages => {
    calls.push(messages)
    return gate
  })
  queue.push(session, { text: 'first temporary' })
  deliver(queue, session)
  answer(session, 100)
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'suffix user' }], source: { kind: 'temporary-message-cleared' } }), { surfaceOp: 'append' })
  queue.push(session, { text: 'second temporary' })
  deliver(queue, session)
  answer(session, 100)
  const before = session.deriveMessages()
  const cleaning = queue.clean(session, { turn: 3, step: 1 })
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0], before.filter(message => message.id !== prefix.id && message.source.kind !== 'temporary-message'))
  assert.deepEqual(session.deriveMessages(), before)
  finish([])
  await cleaning
  assert.deepEqual(session.deriveMessages().filter(message => message.content.length), [prefix])
  assert.deepEqual(Session.create(session.id, session.snapshotEvents()).deriveMessages().filter(message => message.content.length), [prefix])
  assert.equal(session.snapshotEvents().filter(event => event.type === 'assistant/message').length, 2)
  await queue.clean(session, { turn: 4, step: 1 })
  assert.equal(calls.length, 1, '没有临时消息被删除时，不调用压缩器')
})

test('正数寿命保留原始压缩起点；到期后覆盖期间的输出、工具结果和用户输入', async () => {
  const session = Session.create(SessionId('compress-ttl'))
  let calls = 0
  const queue = new TemporaryMessages(() => 200, async () => {
    calls++
    return compressors.clear()
  })
  queue.push(session, { text: 'lasting', ttlTokens: 200 })
  deliver(queue, session)
  answer(session, 100)
  await queue.clean(session, { turn: 2, step: 1 })
  assert.equal(calls, 0)
  session.append('tool/result', {
    turn: 1, step: 1,
    message: createToolResultMessage({ callId: ToolCallId('lasting-result'), content: [{ type: 'text', text: 'tool result' }], isError: false }),
  }, { surfaceOp: 'append' })
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'new input' }], source: { kind: 'temporary-message-cleared' } }), { surfaceOp: 'append' })
  deliver(queue, session)
  const restored = Session.create(session.id, session.snapshotEvents())
  const afterRestore = new TemporaryMessages(() => 200, async messages => {
    calls++
    assert.deepEqual(messages.map(message => message.role), ['assistant', 'tool', 'user', 'assistant'])
    return compressors.clear()
  })
  answer(restored, 100)
  await afterRestore.clean(restored, { turn: 3, step: 1 })
  assert.equal(calls, 1)
  assert.deepEqual(texts(restored), [], '期间的输出、工具结果和用户输入均交给压缩器清空')
  afterRestore.push(restored, { text: 'next' })
  const source = afterRestore.pending(restored)[0].source
  assert.equal(source.kind === 'temporary-message' && source.bornAt, 200)
})

test('清理统一止于最近一次模型输出，晚到的工具结果与用户输入不会被吞掉', async () => {
  const session = Session.create(SessionId('late-inputs'))
  const queue = new TemporaryMessages(() => 0, compressors.clear)
  queue.push(session, { text: 'temporary' })
  deliver(queue, session)
  answer(session, 100)
  session.append('tool/result', {
    turn: 1, step: 1,
    message: createToolResultMessage({ callId: ToolCallId('late-result'), content: [{ type: 'text', text: 'fresh result' }], isError: false }),
  }, { surfaceOp: 'append' })
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'fresh input' }], source: { kind: 'temporary-message-cleared' } }), { surfaceOp: 'append' })
  await queue.clean(session, { turn: 2, step: 1 })
  assert.deepEqual(texts(session), ['fresh result', 'fresh input'])
})

test('核心不把未闭合调用交给压缩器；已完成调用及结果一起交入并删除', async () => {
  const session = Session.create(SessionId('pending-call-boundary'))
  const inputs: (readonly Message[])[] = []
  const queue = new TemporaryMessages(() => 200, async messages => {
    inputs.push(messages)
    return []
  })
  queue.push(session, { text: 'long-lived marker', ttlTokens: 200 })
  deliver(queue, session)
  const appendCall = (id: string) => session.append('assistant/message', {
    turn: 1, step: 1, stream: [], usage: { inputTokens: 1000, outputTokens: 100 },
    message: createAssistantMessage({ source: { provider: 'test', model: 'test' },
      content: [{ type: 'tool-call', id: ToolCallId(id), name: 'lookup', arguments: '{}' }] }),
  }, { surfaceOp: 'append' })
  appendCall('completed')
  await queue.clean(session, { turn: 1, step: 1 })
  assert.equal(inputs.length, 0)
  session.append('tool/result', { turn: 1, step: 1,
    message: createToolResultMessage({ callId: ToolCallId('completed'), content: [{ type: 'text', text: 'done' }], isError: false }),
  }, { surfaceOp: 'append' })
  deliver(queue, session)
  const pending = appendCall('pending').data.message
  await queue.clean(session, { turn: 1, step: 2 })
  assert.equal(inputs.length, 1)
  assert.deepEqual(inputs[0].map(message => message.role), ['assistant', 'tool'])
  assert.ok(inputs[0].every(message => message.id !== pending.id))
  assert.deepEqual(session.deriveMessages().filter(message => message.content.length), [pending])
  assert.deepEqual(Session.create(session.id, session.snapshotEvents()).deriveMessages().filter(message => message.content.length), [pending])
})

test('只传 k 不继承 token 上限；双限制先到先删，新消息两个计数一起重置', async () => {
  const session = Session.create(SessionId('mixed-limits'))
  const queue = new TemporaryMessages(() => 9999)
  queue.push(session, { text: 'one-shot' })
  queue.push(session, { text: 'steps-only', k: 3 })
  queue.push(session, { text: 'tokens-first', ttlTokens: 50, k: 9, key: 'status' })
  queue.push(session, { text: 'steps-first', ttlTokens: 10000, k: 2 })
  queue.beginStep(session, { turn: 1, step: 1 })
  deliver(queue, session)
  answer(session, 60)
  queue.beginStep(session, { turn: 2, step: 1 })
  await queue.clean(session, { turn: 2, step: 1 })
  deliver(queue, session)
  assert.deepEqual(texts(session), ['answer', 'steps-only', 'steps-first'])

  queue.push(session, { text: 'new-cycle', ttlTokens: 100, k: 2, key: 'status' })
  deliver(queue, session)
  answer(session, 10)
  queue.beginStep(session, { turn: 3, step: 1 })
  await queue.clean(session, { turn: 3, step: 1 })
  deliver(queue, session)
  assert.ok(!texts(session).includes('steps-first'))
  assert.ok(texts(session).includes('steps-only') && texts(session).includes('new-cycle'))
  const source = session.deriveMessages().find(message => message.content.some(block => block.type === 'text' && block.text === 'new-cycle'))!.source
  assert.equal(source.kind === 'temporary-message' && source.bornAt, 60)
  assert.equal(source.kind === 'temporary-message' && source.bornStep, 2)
  answer(session, 1)
  queue.beginStep(session, { turn: 4, step: 1 })
  await queue.clean(session, { turn: 4, step: 1 })
  assert.ok(texts(session).every(text => text === 'answer'))
})

test('pre-step 次数随日志恢复；工具执行前撤到队列的消息仍能按 k 到期', async () => {
  const session = Session.create(SessionId('steps-restore'))
  const queue = new TemporaryMessages()
  queue.push(session, { text: 'two-steps', k: 2 })
  queue.beginStep(session, { turn: 1, step: 1 })
  deliver(queue, session)
  answer(session, 1000)
  await queue.clean(session, { turn: 1, step: 1 })
  const restored = Session.create(session.id, session.snapshotEvents())
  const resumed = new TemporaryMessages()
  assert.equal(resumed.beginStep(restored, { turn: 1, step: 2 }), false)
  deliver(resumed, restored)
  assert.ok(texts(restored).includes('two-steps'))
  answer(restored, 1000)
  await resumed.clean(restored, { turn: 1, step: 2 })
  assert.equal(resumed.beginStep(restored, { turn: 1, step: 3 }), true)
  await resumed.clean(restored, { turn: 1, step: 3 })
  deliver(resumed, restored)
  assert.deepEqual(texts(restored), ['answer', 'answer'])
})

test('单次压缩函数接收整段 JSON，摘要写回原范围并可独立恢复', async () => {
  const session = Session.create(SessionId('inline-summary'))
  const queue = new TemporaryMessages(() => 0, compressors.clear)
  const calls: Message[][] = []
  queue.push(session, { text: 'temporary', compressor: async history => {
    calls.push(JSON.parse(history))
    return '历史摘要：已完成分析'
  } })
  deliver(queue, session)
  answer(session, 100)
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'fresh input' }], source: { kind: 'temporary-message-cleared' } }), { surfaceOp: 'append' })
  await queue.clean(session, { turn: 2, step: 1 })
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].map(message => message.role), ['assistant'])
  assert.deepEqual(texts(session), ['历史摘要：已完成分析', 'fresh input'])
  assert.deepEqual(Session.create(session.id, JSON.parse(JSON.stringify(session.snapshotEvents()))).deriveMessages(), session.deriveMessages())
  assert.equal(session.snapshotEvents().filter(event => event.type === 'assistant/message').length, 1)
})

test('字符串恒等和结构化筛选保留原消息结构；恢复后失去回调时保留原文', async () => {
  for (const compressor of [((history: string) => history), ((history: string) => JSON.parse(history) as Message[])]) {
    const session = Session.create(SessionId(`inline-identity-${Math.random()}`))
    const queue = new TemporaryMessages(() => 0, compressors.clear)
    queue.push(session, { text: 'temporary', compressor })
    deliver(queue, session)
    answer(session, 100)
    const original = session.deriveMessages().at(-1)
    await queue.clean(session, { turn: 2, step: 1 })
    assert.deepEqual(session.deriveMessages().filter(message => message.content.length), [original])
  }
  const session = Session.create(SessionId('missing-callback'))
  const queue = new TemporaryMessages()
  queue.push(session, { text: 'temporary', compressor: () => '' })
  deliver(queue, session)
  answer(session, 100)
  const restored = Session.create(session.id, session.snapshotEvents())
  await new TemporaryMessages(() => 0, compressors.clear).clean(restored, { turn: 2, step: 1 })
  assert.deepEqual(texts(restored), ['answer'])
})

test('不同压缩器从后向前处理重叠范围，未到期临时消息仍保留', async () => {
  const session = Session.create(SessionId('overlapping-compressors'))
  const queue = new TemporaryMessages()
  const inputs: string[][] = []
  const compress = (label: string) => (history: string) => {
    const messages = JSON.parse(history) as Message[]
    inputs.push(messages.flatMap(message => message.content.flatMap(block => block.type === 'text' ? [block.text] : [])))
    return label
  }
  queue.push(session, { text: 'early', compressor: compress('early summary') })
  deliver(queue, session)
  answer(session, 10)
  queue.push(session, { text: 'late', compressor: compress('late summary') })
  queue.push(session, { text: 'still alive', ttlTokens: 1000 })
  deliver(queue, session)
  answer(session, 10)
  await queue.clean(session, { turn: 2, step: 1 })
  deliver(queue, session)
  assert.deepEqual(inputs, [['answer'], ['answer', 'late summary']])
  assert.deepEqual(texts(session), ['early summary', 'still alive'])
  assert.deepEqual(Session.create(session.id, session.snapshotEvents()).deriveMessages(), session.deriveMessages())
})

test('队列中已送达消息被同 key 替换时，仍按原起点调用它自己的压缩器', async () => {
  const session = Session.create(SessionId('replace-queued-compressor'))
  const queue = new TemporaryMessages()
  let calls = 0
  queue.push(session, { text: 'old', key: 'status', ttlTokens: 1000, compressor: () => { calls++; return 'old summary' } })
  deliver(queue, session)
  answer(session, 10)
  await queue.clean(session, { turn: 1, step: 1 })
  queue.push(session, { text: 'new', key: 'status', k: 2 })
  assert.equal(queue.beginStep(session, { turn: 2, step: 1 }), true)
  await queue.clean(session, { turn: 2, step: 1 })
  deliver(queue, session)
  assert.equal(calls, 1)
  assert.deepEqual(texts(session), ['old summary', 'new'])
  assert.deepEqual(Session.create(session.id, session.snapshotEvents()).deriveMessages(), session.deriveMessages())
})
