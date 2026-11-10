import type { Context, Volatile } from '@deepseek-ai/cordis'
import { createHash } from 'node:crypto'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-typert-registry'
import { isAgentLoopRequest, markAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import z from '@deepseek-ai/schemastery'
import { TemporaryMessages, type StepPosition } from './messages.ts'
import { CompressorRegistry } from './compressors.ts'
import { renderTemplate } from './tools.ts'
import { TemporaryMessagesUi } from './controller.ts'
import { remoteContribution } from './remote-contract.ts'
import { defaults } from './shared.ts'

export { TemporaryMessages } from './messages.ts'
export type { TemporaryMessageInput } from './messages.ts'
export { compressors, CompressorRegistry } from './compressors.ts'
export type { Compressor, CompressorDefinition, CompressionResult, InlineCompressor } from './compressors.ts'
export type { CompressorInfo } from './shared.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    temporaryMessages: TemporaryMessages
    temporaryMessageCompressors: CompressorRegistry
  }
}

export interface Config {
  enabled: Volatile<boolean>
  template: Volatile<string>
  defaultTtlTokens: Volatile<number | false>
  defaultK: Volatile<number | false>
  compressor: Volatile<string>
}

export const Config = z.object({
  enabled: z.boolean().default(defaults.enabled).volatile(),
  template: z.string().default(defaults.template).volatile(),
  defaultTtlTokens: z.union([z.number().min(0).step(1), false]).default(defaults.defaultTtlTokens).volatile(),
  defaultK: z.union([z.number().min(0).step(1), false]).default(defaults.defaultK).volatile(),
  compressor: z.string().default(defaults.compressor).volatile(),
})

export const inject = ['tools', 'agents', 'llm']

interface StepState extends StepPosition {
  signal: AbortSignal
  modelSelection: Readonly<ModelSelection>
  template: string | null
  templateKey: string
  cleanup?: Promise<void>
}

export function apply(ctx: Context, config: Config): void {
  const registry = new CompressorRegistry()
  ctx.provide('temporaryMessageCompressors', registry)
  const messages = new TemporaryMessages(
    () => config.defaultTtlTokens.get(),
    (suffix, signal) => registry.compress(config.compressor.get(), suffix, signal),
    () => config.defaultK.get(),
  )
  const positions = new WeakMap<Session, StepState>()
  const forwarded = new WeakSet<GenerateOptions>()
  ctx.provide('temporaryMessages', messages)

  ctx.on('agent/pre-step', async ({ agent, turn, step, signal, modelSelection }, next) => {
    const previous = positions.get(agent.session)
    if (previous?.cleanup) await previous.cleanup
    const templateKey = createHash('sha256').update(JSON.stringify([config.template.get(), config.defaultTtlTokens.get(), config.defaultK.get()])).digest('hex')
    messages.updateTemplate(agent.session, templateKey)
    const pendingExpired = messages.beginStep(agent.session, { turn, step })
    if (!previous?.cleanup || pendingExpired) await messages.clean(agent.session, { turn, step }, !config.enabled.get(), signal)
    const state: StepState = { turn, step, signal, modelSelection, template: null, templateKey }
    positions.set(agent.session, state)
    const decision = await next()
    if (decision.kind === 'reject' || !config.enabled.get()) return decision
    // 被别的插件清空的首步不应被状态模板重新唤醒。
    if (step === 1 && decision.messages.length === 0) return decision

    if (!messages.hasTemplate(agent.session, templateKey)) state.template = config.template.get()
    return {
      ...decision,
      messages: [...decision.messages, ...messages.pending(agent.session)],
    }
  }, { prepend: true })

  ctx.on('tools/pre-execute', async (exec, next) => {
    const session = exec.agent?.session
    const state = session && positions.get(session)
    if (!session || !state || exec.parent) return next()
    // 只认本步模型输出中的调用，模板和预览里的 tool() 不触发清理。
    const output = session.snapshotEvents().findLast(event => event.type === 'assistant/message')
    if (!output || output.data.turn !== state.turn || output.data.step !== state.step
      || !output.data.message.content.some(block => block.type === 'tool-call' && block.id === exec.callId)) return next()

    // 同一步的多个工具共用一次清理；下一次 pre-step 也复用这个结果。
    state.cleanup ??= messages.clean(session, state, !config.enabled.get(), exec.signal).catch(error => {
      state.cleanup = undefined
      throw error
    })
    await state.cleanup
    return next()
  }, { prepend: true })

  ctx.on('llm/stream', async function* (request, next) {
    if (forwarded.has(request) || !isAgentLoopRequest(request) || !request.sessionId) {
      yield* next()
      return
    }
    const agent = ctx.agents.get(request.sessionId)
    const session = agent?.session
    const position = session && positions.get(session)
    request.signal?.throwIfAborted()
    if (!agent || !session || !position) {
      yield* next()
      return
    }

    let changed = false
    if (position.template !== null) {
      // 等本轮输入、模型和工具都已入日志，再查询状态；网络重试复用这份快照。
      const text = await renderTemplate(ctx, position.template, position.signal, agent, position.modelSelection)
      position.template = null
      if (text.trim()) {
        session.append('user/message', messages.snapshot(session, text, position.templateKey), { surfaceOp: 'append' })
        changed = true
      }
    }
    if (messages.moveToTail(session, position)) changed = true
    const cleared = (message: GenerateOptions['messages'][number]) =>
      message.source?.kind === 'temporary-message-cleared' && message.content.length === 0
    if (!changed && !request.messages.some(cleared)) {
      yield* next()
      return
    }

    // 从已记录的 surface 操作重建，保留 DSH 当前的工具声明序列。
    const ordered = session.deriveMessages().filter(message => !cleared(message))
    Object.freeze(ordered)
    const replacement = markAgentLoopRequest(Object.freeze({
      ...request, messages: ordered, toolHistory: session.toolHistory(),
    }))
    forwarded.add(replacement)
    // 原请求尚未发出；只发送替代请求，并用对象标记避免再次拦截自己。
    yield* ctx.llm.stream(replacement)
  }, { prepend: true })

  ctx.inject(['settings'], child => {
    child.effect(() => child.settings.configure({ auto: false }, ctx.fiber))
  })
  ctx.inject(['typert'], child => {
    child.plugin(TemporaryMessagesUi)
    child.effect(() => child.typert.register({
      package: remoteContribution.package, face: 'host', schemas: [],
      model: { services: [], events: [], objects: [] },
      invocations: remoteContribution.descriptors,
    }))
  })
}
