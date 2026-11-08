import type { Message } from '@deepseek-ai/dsh-llm'
import type { CompressorInfo } from './shared.ts'

export type CompressionResult = readonly Message[] | string
export type Compressor = (messages: readonly Message[], signal?: AbortSignal) => CompressionResult | Promise<CompressionResult>
export type InlineCompressor = (history: string, signal?: AbortSignal) => CompressionResult | Promise<CompressionResult>

export const compressors = {
  identity: async messages => messages,
  clear: async () => [],
} satisfies Record<string, Compressor>

export interface CompressorDefinition extends CompressorInfo {
  compress: Compressor
}

export class CompressorRegistry {
  private readonly entries = new Map<string, CompressorDefinition>()

  constructor() {
    this.register({
      id: 'identity', name: '保留原文',
      description: '原样保留传入的消息。',
      compress: compressors.identity,
    })
    this.register({
      id: 'clear', name: '清空全部',
      description: '测试用：清空传入的消息。尚未收到结果的调用消息由核心保留。',
      compress: compressors.clear,
    })
  }

  register(definition: CompressorDefinition): () => void {
    if (this.entries.has(definition.id)) throw new Error(`压缩器已注册：${definition.id}`)
    this.entries.set(definition.id, definition)
    return () => { this.entries.delete(definition.id) }
  }

  list(): CompressorInfo[] {
    return [...this.entries.values()].map(({ id, name, description }) => ({ id, name, description }))
  }

  async compress(id: string, messages: readonly Message[], signal?: AbortSignal): Promise<CompressionResult> {
    const definition = this.entries.get(id)
    if (!definition) throw new Error(`压缩器未注册：${id}`)
    return definition.compress(messages, signal)
  }
}
