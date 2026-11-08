import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as plugin from '../src/index.ts'

class Adapter extends LlmAdapter {
  requests = 0
  constructor(private callAt = 0) { super() }
  async resolveModel(provider: string, model: string) { return { provider, id: model, name: model, toolUpdate: 'in-history' as const, systemPromptUpdate: 'in-history' as const } }
  async *stream(_request: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests++
    if (this.requests === this.callAt) {
      const call = { type: 'tool-call' as const, id: ToolCallId('probe-call'), name: 'probe', arguments: '{}' }
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id: call.id, name: call.name, argumentsDelta: '{}' }
      yield { type: 'block-end', index: 0, block: call }
      yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 10 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'answer' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'answer' } }
    yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 10 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
const prompt = (text: string) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'temporary-message-cleared' } })
const soon = (promise: Promise<unknown>) => Promise.race([promise.then(() => true), new Promise<boolean>(resolve => setTimeout(() => resolve(false), 150))])

test('压缩函数在工具前只失败一次，后续步骤与新对话不会重复等待失败的 Promise', { timeout: 5000 }, async () => {
  const ctx = new Context()
  try {
    await mountAgentLoopTestDependencies(ctx)
    const adapter = new Adapter(2)
    ctx.llm.registerAdapter(['test'], adapter)
    ctx.tools.register({ name: 'probe', description: 'probe', parameters: { type: 'object', properties: {} }, output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] }, execute: async () => 'result' })
    await ctx.plugin(plugin, { template: 'snapshot', compressor: 'probe', defaultTtlTokens: 15 })
    let calls = 0
    ctx.temporaryMessageCompressors.register({ id: 'probe', name: 'probe', description: 'probe', compress: async messages => {
      calls++
      if (calls === 1) throw new Error('intentional failure once')
      return messages
    } })
    const errors: string[] = []
    ctx.on('agent/error', ({ error }) => { errors.push(String(error)) })
    const harness = await mountAgentLoopTestHarness(ctx)
    const agent = await harness.create(SessionId('rejected-cleanup'), { provider: 'test', model: 'test' })
    for (const text of ['first', 'second', 'third']) { agent.followup(prompt(text)); await agent.whenIdle() }
    assert.equal(calls, 2)
    assert.equal(adapter.requests, 4)
    assert.deepEqual(errors, [])
  } finally { await ctx.fiber.dispose() }
})

test('压缩函数尚未返回时取消，立即结束等待，迟到结果不会删除历史', { timeout: 5000 }, async () => {
  const ctx = new Context()
  let release!: (value: []) => void
  try {
    await mountAgentLoopTestDependencies(ctx)
    ctx.llm.registerAdapter(['test'], new Adapter())
    await ctx.plugin(plugin, { template: 'snapshot', compressor: 'probe' })
    let entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const gate = new Promise<[]>(resolve => { release = resolve })
    ctx.temporaryMessageCompressors.register({ id: 'probe', name: 'probe', description: 'probe', compress: async () => { entered(); return gate } })
    const harness = await mountAgentLoopTestHarness(ctx)
    const agent = await harness.create(SessionId('cancel-compressor'), { provider: 'test', model: 'test' })
    agent.followup(prompt('first')); await agent.whenIdle()
    agent.followup(prompt('second')); await started
    const before = agent.session.deriveMessages().filter(message => message.role === 'assistant').length
    agent.cancel({ kind: 'hook', reason: 'probe cancellation' })
    const stoppedPromptly = await soon(agent.whenIdle())
    release([])
    await agent.whenIdle()
    assert.equal(stoppedPromptly, true)
    assert.equal(before, 1)
    assert.equal(agent.session.deriveMessages().filter(message => message.role === 'assistant').length, before)
  } finally { release?.([]); await ctx.fiber.dispose() }
})

test('模板函数尚未返回时取消，立即结束等待且不注入迟到快照', { timeout: 5000 }, async () => {
  const ctx = new Context()
  let release!: (value: string) => void
  try {
    await mountAgentLoopTestDependencies(ctx)
    ctx.llm.registerAdapter(['test'], new Adapter())
    let entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const gate = new Promise<string>(resolve => { release = resolve })
    ctx.provide('probeTemplate', { run: () => { entered(); return gate } })
    await ctx.plugin(plugin, { template: '{{ await ctx.get("probeTemplate").run() }}' })
    const harness = await mountAgentLoopTestHarness(ctx)
    const agent = await harness.create(SessionId('cancel-template'), { provider: 'test', model: 'test' })
    agent.followup(prompt('first')); await started
    agent.cancel({ kind: 'hook', reason: 'probe cancellation' })
    const stoppedPromptly = await soon(agent.whenIdle())
    release('late snapshot')
    await agent.whenIdle()
    assert.equal(stoppedPromptly, true)
    assert.equal(agent.session.deriveMessages().filter(message => message.source.kind === 'temporary-message').length, 0)
  } finally { release?.(''); await ctx.fiber.dispose() }
})
