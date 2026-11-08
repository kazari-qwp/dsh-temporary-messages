import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-tools'
import type { Agent, ModelSelection } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { executeToolBatch, ToolExecutionPipeline } from '@deepseek-ai/dsh-tools/pipeline'
import { compileTemplate } from './template.ts'
import { withCancellation } from './cancellation.ts'

export async function renderTemplate(
  ctx: Context, template: string, signal: AbortSignal,
  agent?: Agent, selection?: Readonly<ModelSelection>,
): Promise<string> {
  const render = compileTemplate(template)
  const modelSelection = selection ?? agent?.model.current()
  const toolSet = agent && modelSelection
    ? await ctx.tools.resolve({ agent, modelSelection, signal }) : undefined
  const pipeline = new ToolExecutionPipeline(ctx)
  try {
    const text = await withCancellation(() => render({
      ctx: agent?.ctx ?? ctx,
      agent: agent ?? null,
      session: agent?.session ?? null,
      signal,
      modelSelection,
      tool: async (name, args = {}) => {
        signal.throwIfAborted()
        const batch = await executeToolBatch({
          calls: [{ type: 'tool-call', id: ToolCallId(randomUUID()), name, arguments: JSON.stringify(args) }],
          signal, agent, toolSet,
        }, pipeline, () => 1)
        const result = batch.results[0].result
        if (result.isError) throw new Error(`${name}: ${result.error.message}`)
        // 模板只使用返回值；工具附带的上下文不会额外塞入历史。
        return result.value
      },
    }), signal)
    signal.throwIfAborted()
    return text
  } finally {
    toolSet?.dispose()
  }
}
