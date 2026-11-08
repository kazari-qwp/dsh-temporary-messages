import type { Context } from '@deepseek-ai/cordis'
import { RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { SessionId } from '@deepseek-ai/dsh-session'
import { renderTemplate } from './tools.ts'

export class TemporaryMessagesUi extends TypertRemoteService {
  static inject = ['agents', 'tools', 'temporaryMessageCompressors']
  constructor(ctx: Context) { super(ctx, 'temporaryMessagesUi') }

  private agent(sessionId: string | null) {
    if (sessionId === null) return undefined
    const agent = this.ctx.agents.get(SessionId(sessionId))
    if (!agent) throw new RemoteError('gateway/bad-request', '这个会话已关闭，请重新选择', {})
    return agent
  }

  async catalog(sessionId: string | null, signal: AbortSignal) {
    const agent = this.agent(sessionId)
    const modelSelection = agent?.model.current()
    const toolSet = agent && modelSelection
      ? await this.ctx.tools.resolve({ agent, modelSelection, signal }) : undefined
    try {
      return {
        sessions: this.ctx.agents.list().map(agent => String(agent.id)),
        tools: this.ctx.tools.schemas(agent, toolSet),
        compressors: this.ctx.temporaryMessageCompressors.list(),
      }
    } finally { toolSet?.dispose() }
  }

  async preview(sessionId: string | null, template: string, signal: AbortSignal) {
    try {
      return await renderTemplate(this.ctx, template, signal, this.agent(sessionId))
    } catch (error) {
      // 使用 RemoteError，具体错误文字才能通过 DSH 通信层显示在设置页。
      throw new RemoteError('gateway/bad-request', error instanceof Error ? error.message : String(error), {})
    }
  }
}
