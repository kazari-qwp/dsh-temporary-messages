import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { createSystemMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { appendPluginRecord, pluginRecordOf, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { Message, SystemMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionSeq, SurfaceIntent, UserMessage } from '@deepseek-ai/dsh-session'
import { compressors, type Compressor, type InlineCompressor } from './compressors.ts'
import { withCancellation } from './cancellation.ts'

export interface StepPosition { turn: number; step: number }

export interface TemporaryMessageInput {
  text: string
  /** 0：只进入一个推理步骤；正数：模型之后累计生成多少 token 时过期。 */
  ttlTokens?: number | false
  /** 首次送达后经过多少次 pre-step 时过期；false 表示不限制。 */
  k?: number | false
  /** 只用于本条消息；输入为整段可压缩历史的 JSON，返回原消息数组或摘要文字。 */
  compressor?: InlineCompressor
  /** 同一 session 中相同 key 的新消息替换旧消息。 */
  key?: string
}

interface QueuedMessage extends Omit<TemporaryMessageInput, 'compressor'> {
  id: string
  ttlTokens: number | false
  bornAt?: number
  bornStep?: number
  anchor?: SessionSeq
  inlineCompressor?: true
  templateKey?: string
}

interface TemporarySource {
  kind: 'temporary-message'
  id: string
  ttlTokens: number | false
  k?: number | false
  bornAt: number
  bornStep?: number
  anchor?: SessionSeq
  key?: string
  inlineCompressor?: true
  templateKey?: string
}

type SurfaceWrite =
  | { type: 'system/message'; data: StepPosition & { message: SystemMessage }; intent: SurfaceIntent<'system/message'> }
  | { type: 'user/message'; data: UserMessage; intent: SurfaceIntent<'user/message'> }

interface WritePlan {
  id: string
  writes: SurfaceWrite[]
  queued: { item: QueuedMessage; anchorWrite?: number }[]
  settled: string[]
}

interface PlanProgress {
  plan: WritePlan
  applied: Map<string, SessionSeq>
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'temporary-message': TemporarySource
    'temporary-message-cleared': { kind: 'temporary-message-cleared' }
    'temporary-message-summary': { kind: 'temporary-message-summary' }
  }
}

declare module '@deepseek-ai/dsh-session' {
  interface PluginRecordMap {
    'plugin:temporary-messages/queue': QueuedMessage
    'plugin:temporary-messages/remove': { id: string }
    'plugin:temporary-messages/pre-step': StepPosition
    'plugin:temporary-messages/settled': { ids: string[] }
    'plugin:temporary-messages/write-plan': WritePlan
    'plugin:temporary-messages/write-commit': { id: string; queued: QueuedMessage[]; settled: string[] }
  }
}

interface State {
  offset: number
  tokens: number
  steps: number
  pending: Map<string, QueuedMessage>
  removed: Set<string>
  callbacks: Map<string, InlineCompressor>
  retired: Map<string, QueuedMessage>
  plans: Map<string, PlanProgress>
}

export class TemporaryMessages {
  private readonly states = new WeakMap<Session, State>()

  constructor(
    private readonly defaultTtlTokens: () => number | false = () => 0,
    private readonly compressor: Compressor = compressors.identity,
    private readonly defaultK: () => number | false = () => false,
  ) {}

  push(session: Session, input: TemporaryMessageInput): string {
    this.recover(session)
    const explicitLimits = input.ttlTokens !== undefined || input.k !== undefined
    const ttlTokens = explicitLimits ? input.ttlTokens ?? false : 0
    const k = explicitLimits ? input.k ?? false : false
    if (ttlTokens !== false && (!Number.isSafeInteger(ttlTokens) || ttlTokens < 0)) {
      throw new RangeError('ttlTokens 必须是大于等于 0 的整数，或 false')
    }
    if (k !== false && (!Number.isSafeInteger(k) || k < 0)) {
      throw new RangeError('k 必须是大于等于 0 的整数，或 false')
    }
    const id = randomUUID()
    appendPluginRecord(session, 'plugin:temporary-messages/queue', {
      id, text: input.text, ttlTokens, k, ...(input.key === undefined ? {} : { key: input.key }),
      ...(input.compressor ? { inlineCompressor: true as const } : {}),
    })
    if (input.compressor) this.read(session).callbacks.set(id, input.compressor)
    return id
  }

  remove(session: Session, id: string): void {
    this.recover(session)
    appendPluginRecord(session, 'plugin:temporary-messages/remove', { id })
  }

  beginStep(session: Session, position: StepPosition): boolean {
    this.recover(session)
    appendPluginRecord(session, 'plugin:temporary-messages/pre-step', position)
    const state = this.read(session)
    // 工具执行前已撤到队列中的消息，可能在这次 pre-step 达到 k。
    return state.retired.size > 0 || [...state.pending.values()].some(item => item.bornAt !== undefined && this.expired(state, item))
  }

  updateTemplate(session: Session, templateKey: string): void {
    this.recover(session)
    const queued = [...this.read(session).pending.values()]
    const visible = session.deriveMessages().flatMap(message => message.source.kind === 'temporary-message' ? [message.source] : [])
    for (const item of [...queued, ...visible]) {
      if (item.templateKey !== undefined && item.templateKey !== templateKey) this.remove(session, item.id)
    }
  }

  hasTemplate(session: Session, templateKey: string): boolean {
    this.recover(session)
    return [...this.read(session).pending.values()].some(item => item.templateKey === templateKey)
      || session.deriveMessages().some(message => message.source.kind === 'temporary-message' && message.source.templateKey === templateKey)
  }

  private expired(state: State, item: Pick<QueuedMessage, 'ttlTokens' | 'k' | 'bornAt' | 'bornStep'>): boolean {
    return (item.ttlTokens !== false && state.tokens - item.bornAt! >= item.ttlTokens)
      || (item.k !== undefined && item.k !== false && state.steps - item.bornStep! >= item.k)
  }

  private queue(state: State, item: QueuedMessage): void {
    // 回队的旧消息不能覆盖等待期间的新消息，也不能复活已撤回的消息。
    const newer = item.key !== undefined && [...state.pending.values()].some(pending => pending.id !== item.id && pending.key === item.key)
    if (item.bornAt !== undefined && (state.removed.has(item.id) || newer)) {
      state.retired.set(item.id, item)
      return
    }
    if (item.key !== undefined) {
      for (const [id, pending] of state.pending) {
        if (id === item.id || pending.key !== item.key) continue
        if (pending.bornAt !== undefined) state.retired.set(id, pending)
        else state.callbacks.delete(id)
        state.pending.delete(id)
      }
    }
    state.pending.set(item.id, item)
  }

  private settle(state: State, ids: readonly string[]): void {
    for (const id of ids) {
      state.pending.delete(id)
      state.retired.delete(id)
      state.removed.delete(id)
      state.callbacks.delete(id)
    }
  }

  // 从日志增量恢复队列和计数：重启、分叉后也不需要单独维护一份数据库。
  private read(session: Session): State {
    let state = this.states.get(session)
    if (!state) {
      state = { offset: 0, tokens: 0, steps: 0, pending: new Map(), removed: new Set(), callbacks: new Map(), retired: new Map(), plans: new Map() }
      this.states.set(session, state)
    }
    for (const event of session.snapshotEvents(SessionLogOffset(state.offset))) {
      state.offset = event.seq + 1
      const record = pluginRecordOf(event)
      if (record?.type === 'plugin:temporary-messages/queue') {
        this.queue(state, record.data as unknown as QueuedMessage)
      } else if (record?.type === 'plugin:temporary-messages/remove') {
        const { id } = record.data as { id: string }
        const pending = state.pending.get(id)
        if (pending?.bornAt !== undefined) state.retired.set(id, pending)
        else if (pending) state.callbacks.delete(id)
        state.pending.delete(id)
        state.removed.add(id)
      } else if (record?.type === 'plugin:temporary-messages/settled') {
        this.settle(state, (record.data as { ids: string[] }).ids)
      } else if (record?.type === 'plugin:temporary-messages/write-plan') {
        const plan = record.data as unknown as WritePlan
        state.plans.set(plan.id, { plan, applied: new Map() })
      } else if (record?.type === 'plugin:temporary-messages/write-commit') {
        const commit = record.data as unknown as { id: string; queued: QueuedMessage[]; settled: string[] }
        for (const item of commit.queued) this.queue(state, item)
        this.settle(state, commit.settled)
        state.plans.delete(commit.id)
      } else if (record?.type === 'plugin:temporary-messages/pre-step') {
        state.steps++
      } else if (event.type === 'user/message' && event.data.source.kind === 'temporary-message') {
        state.pending.delete(event.data.source.id)
      } else if (event.type === 'assistant/message') {
        // 优先用服务商报告的输出计数；缺少 usage 时才按内容长度粗估。
        state.tokens += event.data.usage?.outputTokens
          ?? Math.ceil(JSON.stringify(event.data.message.content).length / 3)
      }
      const message = event.type === 'user/message' ? event.data : event.type === 'system/message' ? event.data.message : null
      if (message) for (const progress of state.plans.values()) progress.applied.set(message.id, event.seq)
    }
    return state
  }

  // 先记录完整结果，再逐条写回。强杀后按消息 ID 补完剩余写入，不重跑压缩器。
  recover(session: Session): boolean {
    const state = this.read(session)
    const changed = state.plans.size > 0
    for (const progress of [...state.plans.values()]) {
      for (const write of progress.plan.writes) {
        const id = write.type === 'user/message' ? write.data.id : write.data.message.id
        if (progress.applied.has(id)) continue
        const event = session.append(write.type, write.data, write.intent)
        progress.applied.set(id, event.seq)
      }
      const queued = progress.plan.queued.map(({ item, anchorWrite }) => {
        if (anchorWrite === undefined) return item
        const write = progress.plan.writes[anchorWrite]
        const id = write.type === 'user/message' ? write.data.id : write.data.message.id
        return { ...item, anchor: progress.applied.get(id)! }
      })
      appendPluginRecord(session, 'plugin:temporary-messages/write-commit', { id: progress.plan.id, queued, settled: progress.plan.settled })
      this.read(session)
    }
    return changed
  }

  private commit(session: Session, plan: WritePlan): void {
    if (!plan.writes.length && !plan.queued.length && !plan.settled.length) return
    appendPluginRecord(session, 'plugin:temporary-messages/write-plan', plan)
    this.recover(session)
  }

  async clean(session: Session, position: StepPosition, clearAll = false, signal?: AbortSignal): Promise<void> {
    this.recover(session)
    signal?.throwIfAborted()
    const state = this.read(session)
    const replacedKeys = new Set([...state.pending.values()].map(item => item.key).filter(key => key !== undefined))
    const nodes = session.surface.nodes.map(seq => ({
      seq, message: session.deriveEventMessage(session.eventAt(seq)!),
    }))
    const settled = new Set<string>()
    const jobs = new Map<Compressor | InlineCompressor, { start: number; inline: boolean }>()
    const addJob = (source: Pick<TemporarySource, 'id' | 'anchor' | 'inlineCompressor'>, fallback: SessionSeq) => {
      const anchor = source.anchor !== undefined && session.surface.nodes.includes(source.anchor) ? source.anchor : fallback
      const start = nodes.findIndex(node => node.seq === anchor)
      const callback = source.inlineCompressor ? state.callbacks.get(source.id) : undefined
      // 函数不会序列化；恢复后没有原回调时，仅保留原文。
      const processor = source.inlineCompressor ? callback ?? compressors.identity : this.compressor
      const existing = jobs.get(processor)
      if (!existing || start < existing.start) jobs.set(processor, { start, inline: callback !== undefined })
    }
    const requeued = new Map<SessionSeq, QueuedMessage>()
    for (const { seq, message } of nodes) {
      if (message?.role !== 'user' || message.source.kind !== 'temporary-message') continue
      const source = message.source
      const expired = this.expired(state, source)
      const replaced = source.key !== undefined && replacedKeys.has(source.key)
      if (!clearAll && !expired && !state.removed.has(source.id) && !replaced) {
        // 未到期的消息也先撤下，再放到本步尾部；保留最初的 token 起点。
        requeued.set(seq, {
          id: source.id, ttlTokens: source.ttlTokens, bornAt: source.bornAt,
          ...(source.k === undefined ? {} : { k: source.k }),
          ...(source.bornStep === undefined ? {} : { bornStep: source.bornStep }),
          ...(source.inlineCompressor ? { inlineCompressor: true as const } : {}),
          ...(source.templateKey === undefined ? {} : { templateKey: source.templateKey }),
          text: message.content.map(block => block.type === 'text' ? block.text : '').join(''),
          ...(source.anchor === undefined ? {} : { anchor: source.anchor }),
          ...(source.key === undefined ? {} : { key: source.key }),
        })
      } else {
        settled.add(source.id)
        // 移到尾部不会缩短压缩范围；原起点已被其他整理替换时使用当前位置。
        addJob(source, seq)
      }
    }

    const expiredPending = [...state.retired.values(), ...[...state.pending.values()].filter(item => item.bornAt !== undefined && (clearAll || this.expired(state, item)))]
    for (const item of expiredPending) {
      if (item.anchor !== undefined && session.surface.nodes.includes(item.anchor)) addJob(item, item.anchor)
      settled.add(item.id)
    }

    // 终点是最近一次模型输出；尚未给模型看的工具结果和其他新输入留在范围外。
    const lastOutput = nodes.findLastIndex(node => node.message?.role === 'assistant')
    const working = nodes.map(node => ({ ...node }))
    // 先处理后面的范围，再把结果交给较早范围的压缩器；全部成功后才写日志。
    for (const [processor, job] of [...jobs].sort((a, b) => b[1].start - a[1].start)) {
      const suffix = working.slice(job.start + 1, lastOutput + 1).filter(node => node.message && node.message.source.kind !== 'temporary-message')
      const results = new Set(suffix.flatMap(({ message }) => message?.role === 'tool' ? [message.toolCallId] : []))
      const inputNodes = suffix.filter(({ message }) => !(message?.role === 'assistant'
        && message.content.some(block => block.type === 'tool-call' && !results.has(block.id))))
      if (!inputNodes.length) continue
      const input = inputNodes.map(node => node.message!)
      const serialized = JSON.stringify(input)
      const result = await withCancellation(() => job.inline
        ? (processor as InlineCompressor)(serialized, signal) : (processor as Compressor)(input, signal), signal)
      // 字符串恒等函数仍保留原结构；其余字符串作为一条历史摘要。
      const output = result === serialized ? input : result
      if (typeof output === 'string') {
        for (const node of inputNodes) node.message = null
        if (output) inputNodes[0].message = createUserMessage({
          content: [{ type: 'text', text: output }], source: { kind: 'temporary-message-summary' },
        })
      } else {
        const keep = new Set<Message>()
        let previous = -1
        for (const message of output) {
          const index = input.findIndex(original => original.id === message.id)
          if (index <= previous || !isDeepStrictEqual(input[index], message)) {
            throw new Error('结构化结果应按原顺序返回需要保留的原消息；改写内容请返回摘要字符串。')
          }
          previous = index
          keep.add(input[index])
        }
        for (const node of inputNodes) if (!keep.has(node.message!)) node.message = null
      }
    }

    const plan: WritePlan = { id: randomUUID(), writes: [], queued: [], settled: [...settled] }
    for (const [index, { seq, message }] of nodes.entries()) {
      if (message?.source.kind !== 'temporary-message') {
        const replacement = working[index].message
        if (replacement === message) continue
        if (replacement) {
          plan.writes.push({ type: 'user/message', data: replacement as UserMessage, intent: {
            surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq],
          } })
        } else plan.writes.push(this.clearWrite(seq, position))
        continue
      }
      const anchorWrite = plan.writes.length
      plan.writes.push(this.clearWrite(seq, position))
      const item = requeued.get(seq)
      if (item) {
        // 第一次移尾留下的空节点就是压缩起点，随日志保存，恢复后仍有效。
        plan.queued.push({ item, ...(item.anchor === undefined ? { anchorWrite } : {}) })
      }
    }
    signal?.throwIfAborted()
    this.commit(session, plan)
  }

  // 发送前再整理一次：DSH 可能在 pre-step 之后追加时间或工具变更。
  moveToTail(session: Session, position: StepPosition): boolean {
    const recovered = this.recover(session)
    const visible = session.deriveMessages()
    const first = visible.findIndex(message => message.source.kind === 'temporary-message')
    if (first < 0 || visible.slice(first).every(message => message.source.kind === 'temporary-message')) return recovered

    const plan: WritePlan = { id: randomUUID(), writes: [], queued: [], settled: [] }
    for (const seq of [...session.surface.nodes]) {
      const event = session.eventAt(seq)!
      const message = session.deriveEventMessage(event)
      if (message?.role !== 'user' || message.source.kind !== 'temporary-message') continue
      plan.writes.push(this.clearWrite(seq, position))
      plan.writes.push({ type: 'user/message', data: createUserMessage({
        content: message.content, source: message.source,
      }), intent: { surfaceOp: 'append', sourceEventSeqs: [seq] } })
    }
    this.commit(session, plan)
    return true
  }

  private clearWrite(seq: SessionSeq, position: StepPosition): SurfaceWrite {
    // 空 system 节点不产生模型输入，也不干扰 DSH 的工具变更历史。
    return { type: 'system/message', data: {
      turn: position.turn, step: position.step,
      message: createSystemMessage(''),
    }, intent: { surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq] } }
  }

  pending(session: Session): UserMessage[] {
    this.recover(session)
    const state = this.read(session)
    const ready: UserMessage[] = []
    for (const item of state.pending.values()) {
      if (item.bornAt !== undefined && this.expired(state, item)) {
        this.remove(session, item.id)
      } else {
        ready.push(this.message(item, item.bornAt ?? state.tokens, item.bornStep ?? state.steps))
      }
    }
    return ready
  }

  snapshot(session: Session, text: string, templateKey?: string): UserMessage {
    this.recover(session)
    const state = this.read(session)
    const tokens = this.defaultTtlTokens()
    const k = this.defaultK()
    return this.message({ id: randomUUID(), text, ttlTokens: tokens === false && k === false ? 0 : tokens, k,
      ...(templateKey === undefined ? {} : { templateKey }),
    }, state.tokens, state.steps)
  }

  private message(item: QueuedMessage, bornAt: number, bornStep: number): UserMessage {
    return createUserMessage({
      content: [{ type: 'text', text: item.text }],
      source: {
        kind: 'temporary-message', id: item.id, ttlTokens: item.ttlTokens, bornAt,
        bornStep,
        ...(item.k === undefined ? {} : { k: item.k }),
        ...(item.inlineCompressor ? { inlineCompressor: true as const } : {}),
        ...(item.templateKey === undefined ? {} : { templateKey: item.templateKey }),
        ...(item.anchor === undefined ? {} : { anchor: item.anchor }),
        ...(item.key === undefined ? {} : { key: item.key }),
      },
    })
  }
}
