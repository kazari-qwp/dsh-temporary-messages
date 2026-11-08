import type { RemoteResult, TypertCodec, TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import type { Catalog } from './shared.ts'

export interface UiRemote {
  catalog(sessionId: string | null): Promise<RemoteResult<Catalog>>
  preview(sessionId: string | null, template: string): Promise<RemoteResult<string>>
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteNamespaceMap {
    temporaryMessagesUi: UiRemote
  }
}

const stringCodec: TypertCodec = {
  mode: 'strict', typeSymbol: 'string',
  create: () => ({ parse(value: unknown) {
    if (typeof value !== 'string') throw new TypeError('应为字符串')
    return value
  } }),
}
const sessionCodec: TypertCodec = {
  mode: 'strict', typeSymbol: 'string | null',
  create: () => ({ parse(value: unknown) {
    return value === null ? null : stringCodec.create().parse(value)
  } }),
}

// 两个接口共用这份声明；Host 校验参数，Client 据此生成调用方法。
export const remoteContribution: TypertRemoteContribution = {
  package: 'dsh-temporary-messages',
  descriptors: [
    { method: 'catalog', names: ['sessionId'] },
    { method: 'preview', names: ['sessionId', 'template'] },
  ].map(({ method, names }) => ({
    id: `temporaryMessagesUi/${method}`,
    service: 'temporaryMessagesUi', namespace: 'temporaryMessagesUi', method,
    invocation: { kind: 'direct' },
    parameters: names.map(name => ({ name, wire: name, source: 'json', codec: name === 'sessionId' ? sessionCodec : stringCodec })),
    cancellation: { parameter: 'signal' },
    result: { mode: 'src-json' },
  })),
}
