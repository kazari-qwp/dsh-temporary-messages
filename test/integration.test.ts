import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, ToolCallId, createUserMessage, isAgentLoopRequest, projectToolUpdates } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, Message, StreamChunk } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as plugin from '../src/index.ts'
import { renderTemplate } from '../src/tools.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap { 'test-user': { kind: 'test-user' } }
}

class TestAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  beforeStream?: (request: GenerateOptions) => void
  constructor(private readonly failFirst = false) { super() }
  override async resolveModel(provider: string, model: string) {
    return { provider, id: model, name: model, toolUpdate: 'in-history' as const, systemPromptUpdate: 'in-history' as const }
  }
  async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    this.beforeStream?.(request)
    this.requests.push(request)
    if (this.failFirst && this.requests.length === 1) {
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT', message: 'test retry' } } }
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'answer' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'answer' } }
    yield { type: 'usage', usage: { inputTokens: 1000, outputTokens: 100 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

function balanceTool(counter: { value: number }): ToolDefinition {
  return {
    name: 'get_balance', description: '查询余额', parameters: { type: 'object', properties: {} },
    output: {
      schema: { type: 'object', properties: { balance: { type: 'number' } }, required: ['balance'] },
      render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }],
    },
    execute: async () => ({ balance: ++counter.value }),
  }
}

test('真实 Agent 循环：逐步模板求值、尾部注入、清理旧消息、保留输出', { timeout: 15000 }, async () => {
  const ctx = new Context()
  try {
    await mountAgentLoopTestDependencies(ctx)
    const adapter = new TestAdapter()
    ctx.llm.registerAdapter(['test'], adapter)
    const counter = { value: 0 }
    ctx.tools.register(balanceTool(counter))
    // 模拟已先加载的上下文整理插件：它不应读到上一步的临时快照。
    ctx.on('agent/pre-step', async ({ agent }, next) => {
      assert.ok(agent.session.deriveMessages().every(message => message.source.kind !== 'temporary-message'))
      return next()
    })
    await ctx.plugin(plugin, { template: '余额 {{ (await tool("get_balance")).balance }}' })
    const harness = await mountAgentLoopTestHarness(ctx)
    const agent = await harness.create(SessionId('integration'), { provider: 'test', model: 'test' })
    ctx.temporaryMessages.push(agent.session, { text: '来自 Alice 的消息' })
    for (const text of ['first', 'second']) {
      agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'test-user' } }))
      await agent.whenIdle()
    }
    assert.equal(adapter.requests.length, 2)
    assert.equal(counter.value, 2)
    const all = adapter.requests.map(request => request.messages.flatMap(message => message.content.flatMap(block => block.type === 'text' ? [block.text] : [])))
    assert.deepEqual(all[0].slice(-3), ['first', '来自 Alice 的消息', '余额 1'])
    assert.deepEqual(all[1].slice(-4), ['first', 'answer', 'second', '余额 2'])
  } finally { await ctx.fiber.dispose() }
})

test('发送前将临时消息移到原生运行上下文、工具更新之后；日志重建与适配器收到的一致', { timeout: 15000 }, async () => {
  const ctx = new Context()
  try {
    await mountAgentLoopTestDependencies(ctx)
    const errors: unknown[] = []
    ctx.on('agent/error', ({ error }) => { errors.push(error) })
    const adapter = new TestAdapter()
    ctx.llm.registerAdapter(['test'], adapter)
    const counter = { value: 0 }
    ctx.tools.register(balanceTool(counter))
    let contextReads = 0
    ctx.systemPrompt.context({
      name: 'late-context', order: 100,
      text: () => ++contextReads === 1 ? '' : `late context ${contextReads}`,
    })
    let middlewareCalls = 0
    ctx.on('llm/stream', async function* (request, next) {
      middlewareCalls++
      assert.ok(isAgentLoopRequest(request))
      assert.ok(Object.isFrozen(request) && Object.isFrozen(request.messages))
      yield* next()
    })
    await ctx.plugin(plugin, { template: '余额 {{ (await tool("get_balance")).balance }}' })
    const harness = await mountAgentLoopTestHarness(ctx)
    const agent = await harness.create(SessionId('tail'), { provider: 'test', model: 'test' })
    ctx.temporaryMessages.push(agent.session, { text: '保留 500 token', ttlTokens: 500 })
    ctx.temporaryMessages.push(agent.session, { text: '只出现一次' })
    const replayed: Session[] = []
    const delivered: GenerateOptions[] = []
    adapter.beforeStream = request => {
      const restored = Session.create(agent.id, agent.session.snapshotEvents())
      replayed.push(restored)
      delivered.push(request)
    }
    for (const text of ['first', 'second']) {
      if (text === 'second') ctx.tools.register({ ...balanceTool(counter), name: 'new_lookup' })
      agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'test-user' } }))
      await agent.whenIdle()
    }
    assert.deepEqual(errors, [])
    assert.equal(adapter.requests.length, 2)
    for (let index = 0; index < delivered.length; index++) {
      const restored = replayed[index]
      const projected = projectToolUpdates(restored.deriveMessages(), restored.requestHeader()?.tools, 'in-history', restored.toolHistory())
      assert.deepEqual(delivered[index].messages, projected.messages)
      assert.deepEqual(delivered[index].tools, projected.tools)
      assert.equal(delivered[index].messages.at(-1)?.source?.kind, 'temporary-message')
    }
    assert.equal(middlewareCalls, 2)
    assert.equal(counter.value, 2)
    const textOf = (request: GenerateOptions) => request.messages.flatMap(m => m.content.flatMap(b => b.type === 'text' ? [b.text] : []))
    assert.deepEqual(textOf(adapter.requests[0]).slice(-3), ['保留 500 token', '只出现一次', '余额 1'])
    assert.deepEqual(textOf(adapter.requests[1]).slice(-2), ['保留 500 token', '余额 2'])
    assert.ok(!textOf(adapter.requests[1]).includes('只出现一次'))
    const second = adapter.requests[1].messages
    const history = replayed[1].deriveMessages()
    const toolChange = history.findIndex(m => m.content.some(b => b.type === 'tool-addition' && b.toolName === 'new_lookup'))
    assert.ok(toolChange >= 0 && toolChange < history.length - 2)
    assert.ok(adapter.requests[1].tools?.some(tool => tool.name === 'new_lookup'))
    const lasting = second.find(m => m.content.some(b => b.type === 'text' && b.text === '保留 500 token'))!
    assert.equal(lasting.source?.kind === 'temporary-message' && lasting.source.bornAt, 0)
    assert.ok(replayed.every(s => s.snapshotEvents().some(e => e.type === 'system/message' && e.data.message.content.length === 0 && e.surfaceOp !== 'append')))
  } finally { await ctx.fiber.dispose() }
})

test('重试新增运行上下文后仍在末尾，模板只求值一次，每次尝试只调用一次适配器', { timeout: 15000 }, async () => {
  const ctx = new Context()
  try {
    await mountAgentLoopTestDependencies(ctx)
    const errors: unknown[] = []
    ctx.on('agent/error', ({ error }) => { errors.push(error) })
    const adapter = new TestAdapter(true)
    ctx.llm.registerAdapter(['test'], adapter)
    const counter = { value: 0 }
    ctx.tools.register(balanceTool(counter))
    let samples = 0
    ctx.systemPrompt.context({ name: 'late', order: 1, text: () => ++samples === 1 ? '' : `sample ${samples}` })
    await ctx.plugin(plugin, { template: '{{ (await tool("get_balance")).balance }}' })
    ctx.on('agent/request-error', async () => ({ kind: 'retry' }))
    let calls = 0
    ctx.on('llm/stream', async function* (_request, next) { calls++; yield* next() })
    const harness = await mountAgentLoopTestHarness(ctx)
    const agent = await harness.create(SessionId('tail-retry'), { provider: 'test', model: 'test' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'test-user' } }))
    await agent.whenIdle()
    assert.deepEqual(errors, [])
    assert.equal(counter.value, 1)
    assert.equal(adapter.requests.length, 2)
    assert.equal(calls, 2)
    const tails = adapter.requests.map(r => r.messages.at(-1)!)
    assert.deepEqual(tails.map(m => m.content), [[{ type: 'text', text: '1' }], [{ type: 'text', text: '1' }]])
    assert.deepEqual(tails[0].source, tails[1].source)
    assert.ok(adapter.requests.every(r => r.messages.filter(m => m.source?.kind === 'temporary-message').length === 1))
    assert.equal(adapter.requests[0].signal, adapter.requests[1].signal)
  } finally { await ctx.fiber.dispose() }
})

test('并发会话各自移动，手工 LLM 调用不修改会话历史', { timeout: 15000 }, async () => {
  const ctx = new Context()
  try {
    await mountAgentLoopTestDependencies(ctx)
    const adapter = new TestAdapter()
    ctx.llm.registerAdapter(['test'], adapter)
    await ctx.plugin(plugin, { template: '{{ session.id }}' })
    // 模拟另一插件在我们的 pre-step 返回之后继续追加。
    ctx.on('agent/pre-step', async (_payload, next) => {
      const decision = await next()
      return decision.kind === 'reject' ? decision : { ...decision, messages: [...decision.messages,
        createUserMessage({ content: [{ type: 'text', text: 'late notice' }], source: { kind: 'test-user' } }),
      ] }
    }, { prepend: true })
    const harness = await mountAgentLoopTestHarness(ctx)
    const agents = await Promise.all(['parallel-a', 'parallel-b'].map(id => harness.create(SessionId(id), { provider: 'test', model: 'test' })))
    for (const agent of agents) agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'test-user' } }))
    await Promise.all(agents.map(agent => agent.whenIdle()))
    assert.equal(adapter.requests.length, 2)
    for (const request of adapter.requests) assert.deepEqual(request.messages.at(-1)?.content, [{ type: 'text', text: request.sessionId }])

    const agent = agents[0]
    const before = agent.session.snapshotEvents()
    const auxiliary = { provider: 'test', model: 'test', sessionId: agent.id, messages: agent.session.deriveMessages() }
    for await (const _chunk of ctx.llm.stream(auxiliary)) { /* 直接调用服务，不进入 Agent 循环。 */ }
    assert.equal(adapter.requests.length, 3)
    assert.equal(agent.session.snapshotEvents(), before)
    assert.deepEqual(adapter.requests[2].messages, auxiliary.messages)
  } finally { await ctx.fiber.dispose() }
})

test('模板调用经过工具策略；PTC 模式下也能直接调用注册工具', { timeout: 15000 }, async () => {
  const ctx = new Context()
  try {
    await mountAgentLoopTestDependencies(ctx, { tools: { mode: 'ptc' } })
    const counter = { value: 0 }
    ctx.tools.register(balanceTool(counter))
    const signal = new AbortController().signal
    const template = '{{ (await tool("get_balance", {})).balance }}'
    assert.equal(await renderTemplate(ctx, template, signal), '1')
    const off = ctx.on('tools/pre-execute', async () => ({ kind: 'deny', reason: 'test denied' }))
    await assert.rejects(renderTemplate(ctx, template, signal), /test denied/)
    assert.equal(counter.value, 1)
    off()
    await assert.rejects(renderTemplate(ctx, '{{ await tool("missing") }}', signal), /missing/)
  } finally { await ctx.fiber.dispose() }
})

test('模板获得 Agent 作用域和完整会话，读取本轮已入日志的新消息与工具', { timeout: 15000 }, async () => {
  const ctx = new Context()
  try {
    await mountAgentLoopTestDependencies(ctx)
    const adapter = new TestAdapter(true)
    ctx.llm.registerAdapter(['test'], adapter)
    ctx.tools.register(balanceTool({ value: 0 }))
    let reads = 0
    ctx.provide('templateProbe', {
      read: (agent: import('@deepseek-ai/dsh-agent').Agent, session: Session, signal: AbortSignal) => {
        reads++
        assert.equal(agent.session, session)
        assert.equal(signal.aborted, false)
        assert.ok(session.deriveMessages().some(message => message.content.some(block => block.type === 'text' && block.text === '本轮新输入')))
        assert.ok(session.requestHeader()?.tools?.some(tool => tool.name === 'get_balance'))
        return session.id
      },
    })
    await ctx.plugin(plugin, { template: `{{ await (async () => {
      if (ctx !== agent.ctx) throw new Error('wrong scope');
      const id = await ctx.get('templateProbe').read(agent, session, signal);
      return id + '/' + modelSelection.model;
    })() }}` })
    ctx.on('agent/request-error', async () => ({ kind: 'retry' }))
    const harness = await mountAgentLoopTestHarness(ctx)
    const agent = await harness.create(SessionId('bindings'), { provider: 'test', model: 'test' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: '本轮新输入' }], source: { kind: 'test-user' } }))
    await agent.whenIdle()
    assert.equal(adapter.requests.length, 2)
    assert.equal(reads, 1)
    assert.ok(adapter.requests.every(request => request.messages.at(-1)?.content.some(block => block.type === 'text' && block.text === 'bindings/test')))
    assert.equal(await renderTemplate(ctx, '{{ agent === null && session === null && !!ctx.get("templateProbe") }}', new AbortController().signal), 'true')
  } finally { await ctx.fiber.dispose() }
})

test('余额与占比来自可编辑模板，汇总人民币钱包；查询失败显示未知', { timeout: 15000 }, async () => {
  const ctx = new Context()
  try {
    await mountAgentLoopTestDependencies(ctx)
    ctx.llm.registerAdapter(['test'], new TestAdapter())
    let available = true
    ctx.provide('deepseekAccount', {
      getBalance: async (client: { version: string; locale: string }) => {
        assert.ok(client.version)
        assert.equal(client.locale, 'zh-CN')
        return available ? { status: 'ready', value: [{ currency: 'CNY', balance: '12.50' }, { currency: 'USD', balance: '100' }], bonusWallets: [{ currency: 'CNY', balance: '0.25' }] } : { status: 'failed' }
      },
    })
    ctx.provide('tokenMeter', {
      contextPressure: () => ({ contextWindow: 100000 }),
      measure: () => ({ totalTokens: 12500 }),
    })
    const harness = await mountAgentLoopTestHarness(ctx)
    const agent = await harness.create(SessionId('status'), { provider: 'test', model: 'test' })
    const template = readFileSync(new URL('../examples/balance-context.txt', import.meta.url), 'utf8').trimEnd()
    const signal = new AbortController().signal
    assert.equal(await renderTemplate(ctx, template, signal, agent), '目前余额:12.75¥\n上下文已用12.50%')
    available = false
    assert.equal(await renderTemplate(ctx, template, signal), '目前余额:未知¥\n上下文已用未知%')
  } finally { await ctx.fiber.dispose() }
})

test('同一步的请求重试复用快照，下一步才重新执行模板', { timeout: 15000 }, async () => {
  const ctx = new Context()
  try {
    await mountAgentLoopTestDependencies(ctx)
    const adapter = new TestAdapter(true)
    ctx.llm.registerAdapter(['test'], adapter)
    const counter = { value: 0 }
    ctx.tools.register(balanceTool(counter))
    await ctx.plugin(plugin, { template: '{{ (await tool("get_balance")).balance }}' })
    ctx.on('agent/request-error', async () => ({ kind: 'retry' }))
    const harness = await mountAgentLoopTestHarness(ctx)
    const agent = await harness.create(SessionId('retry'), { provider: 'test', model: 'test' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'test-user' } }))
    await agent.whenIdle()
    assert.equal(adapter.requests.length, 2)
    assert.equal(counter.value, 1)
    assert.deepEqual(adapter.requests[0].messages, adapter.requests[1].messages)
  } finally { await ctx.fiber.dispose() }
})

test('清空模式不带旧输出，配置改为保留后下一步立即生效', { timeout: 15000 }, async () => {
  const ctx = new Context()
  try {
    await mountAgentLoopTestDependencies(ctx)
    const adapter = new TestAdapter()
    ctx.llm.registerAdapter(['test'], adapter)
    const errors: unknown[] = []
    ctx.on('agent/error', ({ error }) => { errors.push(error) })
    const stopChecking = ctx.on('agent/pre-step', async ({ agent }, next) => {
      assert.ok(!agent.session.deriveMessages().some(message => message.role === 'assistant'))
      return next()
    })
    let selected: 'identity' | 'clear' = 'clear'
    const config = { ...plugin.Config({ template: 'snapshot' }), compressor: { get: () => selected } }
    await ctx.plugin({ inject: plugin.inject, apply: (child: Context) => plugin.apply(child, config) })
    const harness = await mountAgentLoopTestHarness(ctx)
    const agent = await harness.create(SessionId('clear-output'), { provider: 'test', model: 'test' })
    const beforeSend: Session[] = []
    adapter.beforeStream = () => { beforeSend.push(Session.create(agent.id, agent.session.snapshotEvents())) }
    for (const text of ['first', 'second']) {
      agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'test-user' } }))
      await agent.whenIdle()
    }
    assert.deepEqual(errors, [])
    assert.equal(adapter.requests.length, 2)
    assert.ok(adapter.requests.every(request => request.messages.every(message => message.role !== 'assistant')))
    const second = adapter.requests[1]
    assert.deepEqual(second.messages.flatMap(message => message.content.flatMap(block => block.type === 'text' ? [block.text] : [])).slice(-3), ['first', 'second', 'snapshot'])
    assert.deepEqual(beforeSend[1].deriveMessages(), second.messages)
    assert.equal(agent.session.snapshotEvents().filter(event => event.type === 'assistant/message').length, 2)

    stopChecking()
    selected = 'identity'
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'third' }], source: { kind: 'test-user' } }))
    await agent.whenIdle()
    assert.deepEqual(errors, [])
    assert.equal(adapter.requests.length, 3)
    assert.equal(adapter.requests[2].messages.filter(message => message.role === 'assistant').length, 1)
  } finally { await ctx.fiber.dispose() }
})

test('外部插件注册的压缩器可直接配置使用，返回的消息决定下一次模型输入', { timeout: 15000 }, async () => {
  const ctx = new Context()
  try {
    await mountAgentLoopTestDependencies(ctx)
    const adapter = new TestAdapter()
    ctx.llm.registerAdapter(['test'], adapter)
    const errors: unknown[] = []
    ctx.on('agent/error', ({ error }) => { errors.push(error) })
    const batches: (readonly Message[])[] = []
    await ctx.plugin(plugin, { template: '', compressor: 'keep-last' })
    await ctx.plugin({
      inject: ['temporaryMessageCompressors'],
      apply(child: Context) {
        child.effect(() => child.temporaryMessageCompressors.register({
          id: 'keep-last', name: '保留最后一条', description: '外部插件测试',
          compress: async messages => { batches.push(messages); return messages.slice(-1) },
        }))
      },
    })
    const harness = await mountAgentLoopTestHarness(ctx)
    const agent = await harness.create(SessionId('registered-compressor'), { provider: 'test', model: 'test' })
    ctx.temporaryMessages.push(agent.session, { text: 'lasting', ttlTokens: 200 })
    for (const text of ['first', 'second', 'third']) {
      agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'test-user' } }))
      await agent.whenIdle()
    }
    assert.deepEqual(errors, [])
    assert.equal(adapter.requests.length, 3)
    assert.equal(batches.length, 1)
    assert.deepEqual(batches[0].map(message => message.role), ['assistant', 'user', 'assistant'])
    const third = adapter.requests[2].messages
    assert.deepEqual(third.filter(message => message.role === 'assistant'), batches[0].slice(-1))
    assert.deepEqual(third.filter(message => message.role === 'user').flatMap(message =>
      message.content.flatMap(block => block.type === 'text' ? [block.text] : [])), ['first', 'third'])
    assert.deepEqual(Session.create(agent.id, agent.session.snapshotEvents()).deriveMessages(), agent.session.deriveMessages())
  } finally { await ctx.fiber.dispose() }
})

test('模板按 token 或 k 先到的上限刷新，每次刷新重置两个起点', { timeout: 15000 }, async () => {
  for (const limits of [
    { defaultTtlTokens: false as const, defaultK: 2 },
    { defaultTtlTokens: 150, defaultK: 9 },
    { defaultTtlTokens: 10000, defaultK: 2 },
  ]) {
    const ctx = new Context()
    try {
      await mountAgentLoopTestDependencies(ctx)
      const adapter = new TestAdapter()
      ctx.llm.registerAdapter(['test'], adapter)
      const counter = { value: 0 }
      ctx.tools.register(balanceTool(counter))
      await ctx.plugin(plugin, { ...limits, template: 'snapshot {{ (await tool("get_balance")).balance }}' })
      const harness = await mountAgentLoopTestHarness(ctx)
      const agent = await harness.create(SessionId(`template-limits-${limits.defaultTtlTokens}`), { provider: 'test', model: 'test' })
      const errors: unknown[] = []
      ctx.on('agent/error', ({ error }) => { errors.push(error) })
      for (const text of ['first', 'second', 'third']) {
        agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'test-user' } }))
        await agent.whenIdle()
      }
      assert.deepEqual(errors, [])
      assert.equal(counter.value, 2)
      const snapshots = adapter.requests.map(request => request.messages.at(-1)!)
      assert.deepEqual(snapshots.map(message => message.content), [
        [{ type: 'text', text: 'snapshot 1' }], [{ type: 'text', text: 'snapshot 1' }], [{ type: 'text', text: 'snapshot 2' }],
      ])
      const source = snapshots[2].source
      assert.ok(source?.kind === 'temporary-message')
      assert.equal(source.bornAt, 200)
      assert.equal(source.bornStep, 3)
      assert.deepEqual(Session.create(agent.id, agent.session.snapshotEvents()).deriveMessages(), agent.session.deriveMessages())
    } finally { await ctx.fiber.dispose() }
  }
})

test('保存模板寿命的新设置后，旧快照下一步即替换并开始新周期', { timeout: 15000 }, async () => {
  const ctx = new Context()
  try {
    await mountAgentLoopTestDependencies(ctx)
    const adapter = new TestAdapter()
    ctx.llm.registerAdapter(['test'], adapter)
    const counter = { value: 0 }
    ctx.tools.register(balanceTool(counter))
    let k = 8
    const config = { ...plugin.Config({ template: '{{ (await tool("get_balance")).balance }}', defaultTtlTokens: false }), defaultK: { get: () => k } }
    await ctx.plugin({ inject: plugin.inject, apply: (child: Context) => plugin.apply(child, config) })
    const harness = await mountAgentLoopTestHarness(ctx)
    const agent = await harness.create(SessionId('saved-limits'), { provider: 'test', model: 'test' })
    for (const text of ['first', 'second', 'third']) {
      if (text === 'second') k = 2
      agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'test-user' } }))
      await agent.whenIdle()
    }
    assert.equal(counter.value, 2)
    assert.deepEqual(adapter.requests.map(request => request.messages.at(-1)!.content), [
      [{ type: 'text', text: '1' }], [{ type: 'text', text: '2' }], [{ type: 'text', text: '2' }],
    ])
  } finally { await ctx.fiber.dispose() }
})

test('工具循环也按 pre-step 计数；k 到期后私有压缩器摘要旧调用，保留未读的新结果', { timeout: 15000 }, async () => {
  class TwoToolSteps extends TestAdapter {
    override async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
      if (this.requests.length >= 2) { yield* super.stream(request); return }
      const number = this.requests.length + 1
      this.requests.push(request)
      const call = { type: 'tool-call' as const, id: ToolCallId(`k-call-${number}`), name: 'get_balance', arguments: '{}' }
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id: call.id, name: call.name, argumentsDelta: call.arguments }
      yield { type: 'block-end', index: 0, block: call }
      yield { type: 'usage', usage: { inputTokens: 1000, outputTokens: 100 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    }
  }
  const ctx = new Context()
  try {
    await mountAgentLoopTestDependencies(ctx)
    const adapter = new TwoToolSteps()
    ctx.llm.registerAdapter(['test'], adapter)
    ctx.tools.register(balanceTool({ value: 0 }))
    await ctx.plugin(plugin, { compressor: 'clear', template: '' })
    const errors: unknown[] = []
    ctx.on('agent/error', ({ error }) => { errors.push(error) })
    const harness = await mountAgentLoopTestHarness(ctx)
    const agent = await harness.create(SessionId('k-tools'), { provider: 'test', model: 'test' })
    const calls: Message[][] = []
    ctx.temporaryMessages.push(agent.session, { text: 'two-step marker', k: 2, compressor: history => {
      calls.push(JSON.parse(history))
      return '历史摘要：已完成第一轮余额查询。'
    } })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'lookup twice' }], source: { kind: 'test-user' } }))
    await agent.whenIdle()
    assert.deepEqual(errors, [])
    assert.equal(adapter.requests.length, 3)
    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0].map(message => message.role), ['assistant', 'tool'])
    assert.ok(!JSON.stringify(calls).includes('k-call-2'))
    const third = adapter.requests[2].messages
    assert.deepEqual(third.flatMap(message => message.content.flatMap(block => block.type === 'tool-call' ? [block.id] : [])), ['k-call-2'])
    assert.deepEqual(third.filter(message => message.role === 'tool').map(message => message.toolCallId), ['k-call-2'])
    assert.ok(third.some(message => message.content.some(block => block.type === 'text' && block.text === '历史摘要：已完成第一轮余额查询。')))
    assert.ok(!JSON.stringify(third).includes('two-step marker'))
    assert.deepEqual(ctx.temporaryMessageCompressors.list().map(item => item.id), ['identity', 'clear'])
    assert.deepEqual(Session.create(agent.id, agent.session.snapshotEvents()).deriveMessages(), agent.session.deriveMessages())
  } finally { await ctx.fiber.dispose() }
})

test('工具执行前清理临时消息，原始调用与随后产生的工具结果保留到下一次请求', { timeout: 15000 }, async () => {
  class ToolAdapter extends TestAdapter {
    override async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
      if (this.requests.length > 0) { yield* super.stream(request); return }
      this.requests.push(request)
      const call = { type: 'tool-call' as const, id: ToolCallId('clear-tool-call'), name: 'get_balance', arguments: '{}' }
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id: call.id, name: call.name, argumentsDelta: call.arguments }
      yield { type: 'block-end', index: 0, block: call }
      yield { type: 'usage', usage: { inputTokens: 1000, outputTokens: 20 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    }
  }
  const ctx = new Context()
  try {
    await mountAgentLoopTestDependencies(ctx)
    const adapter = new ToolAdapter()
    ctx.llm.registerAdapter(['test'], adapter)
    const counter = { value: 0 }
    ctx.tools.register({ ...balanceTool(counter), execute: async (_args, exec) => {
      assert.ok(exec.agent!.session.deriveMessages().every(message => message.source.kind !== 'temporary-message'))
      assert.ok(exec.agent!.session.deriveMessages().some(message => message.content.some(block => block.type === 'tool-call')))
      return { balance: ++counter.value }
    } })
    const errors: unknown[] = []
    ctx.on('agent/error', ({ error }) => { errors.push(error) })
    await ctx.plugin(plugin, { template: 'snapshot', compressor: 'clear' })
    const harness = await mountAgentLoopTestHarness(ctx)
    const agent = await harness.create(SessionId('clear-tools'), { provider: 'test', model: 'test' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'lookup' }], source: { kind: 'test-user' } }))
    await agent.whenIdle()
    assert.deepEqual(errors, [])
    assert.equal(counter.value, 1)
    assert.equal(adapter.requests.length, 2)
    const second = adapter.requests[1]
    assert.equal(second.messages.filter(message => message.role === 'assistant').length, 1)
    const result = second.messages.find(message => message.role === 'tool')!
    assert.equal(result.toolCallId, 'clear-tool-call')
    assert.deepEqual(result.content, [{ type: 'text', text: '{"balance":1}' }])
    assert.ok(second.tools?.some(tool => tool.name === 'get_balance'))
    assert.equal(second.messages.at(-1)?.source?.kind, 'temporary-message')
    assert.equal(agent.session.snapshotEvents().filter(event => event.type === 'tool/result').length, 1)
    assert.deepEqual(Session.create(agent.id, agent.session.snapshotEvents()).deriveMessages(), agent.session.deriveMessages())
  } finally { await ctx.fiber.dispose() }
})

test('同一步多个工具只清理一次，模板工具不触发清理，下一步跳过后再恢复正常清理', { timeout: 15000 }, async () => {
  class BatchAdapter extends TestAdapter {
    override async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
      if (this.requests.length > 0) { yield* super.stream(request); return }
      this.requests.push(request)
      for (let index = 0; index < 2; index++) {
        const call = { type: 'tool-call' as const, id: ToolCallId(`batch-${index}`), name: 'get_balance', arguments: '{}' }
        yield { type: 'block-start', index, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index, id: call.id, name: call.name, argumentsDelta: call.arguments }
        yield { type: 'block-end', index, block: call }
      }
      yield { type: 'usage', usage: { inputTokens: 1000, outputTokens: 40 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    }
  }
  const ctx = new Context()
  try {
    await mountAgentLoopTestDependencies(ctx)
    const adapter = new BatchAdapter()
    ctx.llm.registerAdapter(['test'], adapter)
    const counter = { value: 0 }
    ctx.tools.register(balanceTool(counter))
    let templateCalls = 0
    ctx.tools.register({ name: 'template_probe', description: '模板查询', parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
      execute: async () => `snapshot ${++templateCalls}`,
    })
    await ctx.plugin(plugin, { compressor: 'clear', template: '{{ await tool("template_probe") }}' })
    const clean = ctx.temporaryMessages.clean.bind(ctx.temporaryMessages)
    let cleanCalls = 0
    ctx.temporaryMessages.clean = async (...args) => { cleanCalls++; await clean(...args) }
    const errors: unknown[] = []
    ctx.on('agent/error', ({ error }) => { errors.push(error) })
    const harness = await mountAgentLoopTestHarness(ctx)
    const agent = await harness.create(SessionId('clear-tool-batch'), { provider: 'test', model: 'test' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'first' }], source: { kind: 'test-user' } }))
    await agent.whenIdle()
    assert.deepEqual(errors, [])
    assert.equal(counter.value, 2)
    assert.equal(cleanCalls, 2, '首次 pre-step 清理一次，工具执行前一次；第二个工具和紧接的 pre-step 不重复')
    assert.equal(templateCalls, 2)
    assert.equal(adapter.requests[1].messages.filter(message => message.role === 'tool').length, 2)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'second' }], source: { kind: 'test-user' } }))
    await agent.whenIdle()
    assert.deepEqual(errors, [])
    assert.equal(cleanCalls, 3, '跳过只适用于紧接着的一步')
    assert.equal(templateCalls, 3)
    assert.equal(adapter.requests[2].messages.filter(message => message.role === 'tool').length, 2)
    assert.equal(adapter.requests[2].messages.filter(message => message.role === 'assistant').length, 1)
    assert.ok(adapter.requests[2].messages.every(message => !message.content.some(block => block.type === 'text' && block.text === 'answer')))
    assert.deepEqual(adapter.requests[2].messages.at(-1)?.content, [{ type: 'text', text: 'snapshot 3' }])
  } finally { await ctx.fiber.dispose() }
})

test('长寿命到期时，删除上一批已完成调用和结果，保留当前未完成调用', { timeout: 15000 }, async () => {
  class TwoToolSteps extends TestAdapter {
    override async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
      if (this.requests.length >= 2) { yield* super.stream(request); return }
      const number = this.requests.length + 1
      this.requests.push(request)
      const call = { type: 'tool-call' as const, id: ToolCallId(`step-call-${number}`), name: 'get_balance', arguments: '{}' }
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id: call.id, name: call.name, argumentsDelta: call.arguments }
      yield { type: 'block-end', index: 0, block: call }
      yield { type: 'usage', usage: { inputTokens: 1000, outputTokens: 100 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    }
  }
  const ctx = new Context()
  try {
    await mountAgentLoopTestDependencies(ctx)
    const adapter = new TwoToolSteps()
    ctx.llm.registerAdapter(['test'], adapter)
    const counter = { value: 0 }
    ctx.tools.register(balanceTool(counter))
    await ctx.plugin(plugin, { compressor: 'clear', template: '' })
    const errors: unknown[] = []
    ctx.on('agent/error', ({ error }) => { errors.push(error) })
    const harness = await mountAgentLoopTestHarness(ctx)
    const agent = await harness.create(SessionId('completed-pair'), { provider: 'test', model: 'test' })
    ctx.temporaryMessages.push(agent.session, { text: '200 token marker', ttlTokens: 200 })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'lookup twice' }], source: { kind: 'test-user' } }))
    await agent.whenIdle()
    assert.deepEqual(errors, [])
    assert.equal(counter.value, 2)
    assert.equal(adapter.requests.length, 3)
    const callIds = (request: GenerateOptions) => request.messages.flatMap(message => message.content.flatMap(block => block.type === 'tool-call' ? [block.id] : []))
    assert.deepEqual(callIds(adapter.requests[1]), ['step-call-1'])
    assert.deepEqual(callIds(adapter.requests[2]), ['step-call-2'])
    const finalResults = adapter.requests[2].messages.filter(message => message.role === 'tool')
    assert.deepEqual(finalResults.map(message => message.toolCallId), ['step-call-2'])
    assert.ok(adapter.requests[2].messages.every(message => message.source?.kind !== 'temporary-message'))
    assert.deepEqual(Session.create(agent.id, agent.session.snapshotEvents()).deriveMessages(), agent.session.deriveMessages())
  } finally { await ctx.fiber.dispose() }
})
