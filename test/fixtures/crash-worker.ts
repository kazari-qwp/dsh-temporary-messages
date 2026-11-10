import { openSync, writeSync, fsyncSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, createAssistantMessage, createSystemMessage, createToolResultMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { TemporaryMessages } from '../../src/messages.ts'

const [scenario, filename] = process.argv.slice(2)
const fd = openSync(filename, 'w')
const ctx = new Context()
let armed = false
let replacements = 0
await mountAgentLoopTestDependencies(ctx)
ctx.llm.registerAdapter(['test'], new class extends LlmAdapter {
  async resolveModel(provider: string, model: string) { return { provider, id: model, name: model } }
  async *stream(_request: GenerateOptions): AsyncIterable<StreamChunk> { yield { type: 'finish', reason: { kind: 'stop' } } }
}())
ctx.on('session/event', (_session, event) => {
  writeSync(fd, JSON.stringify(event) + '\n')
  fsyncSync(fd)
  if (!armed || event.type !== 'user/message' || event.data.content.length || event.surfaceOp === 'append') return
  replacements++
  if (replacements !== (scenario === 'tools' ? 2 : 1)) return
  process.send!({ ready: true, scenario, lastSeq: event.seq })
  // 固定在已落盘、操作尚未完成的位置，由父进程直接强杀。
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
})
const harness = await mountAgentLoopTestHarness(ctx)
const agent = await harness.create(SessionId(`kill-${scenario}`), { provider: 'test', model: 'test' })
const session = agent.session
const queue = new TemporaryMessages(() => 0, async messages => scenario === 'summary' ? 'SUMMARY_ONLY' : scenario === 'tools' ? [] : messages)
session.append('system/message', { turn: 1, step: 1, message: createSystemMessage('system') }, { surfaceOp: 'append' })
session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'original input' }], source: { kind: 'temporary-message-cleared' } }), { surfaceOp: 'append' })
queue.push(session, { text: 'temporary', ttlTokens: scenario === 'requeue' || scenario === 'move' ? 1000 : 0 })
for (const message of queue.pending(session)) session.append('user/message', message, { surfaceOp: 'append' })
if (scenario === 'move') {
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'late context' }], source: { kind: 'temporary-message-cleared' } }), { surfaceOp: 'append' })
} else {
  if (scenario === 'tools') {
    session.append('assistant/message', { turn: 1, step: 1, stream: [], usage: { inputTokens: 100, outputTokens: 10 },
      message: createAssistantMessage({ source: { provider: 'test', model: 'test' }, content: [{ type: 'tool-call', id: ToolCallId('completed-call'), name: 'probe', arguments: '{}' }] }),
    }, { surfaceOp: 'append' })
    session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId: ToolCallId('completed-call'), isError: false, content: [{ type: 'text', text: 'completed-result' }] }) }, { surfaceOp: 'append' })
  }
  session.append('assistant/message', { turn: 1, step: 1, stream: [], usage: { inputTokens: 100, outputTokens: 10 },
    message: createAssistantMessage({ source: { provider: 'test', model: 'test' }, content: [{ type: 'text', text: 'answer' }] }),
  }, { surfaceOp: 'append' })
}
armed = true
if (scenario === 'move') queue.moveToTail(session, { turn: 2, step: 1 })
else await queue.clean(session, { turn: 2, step: 1 })
throw new Error('未在预定截断点停住')
