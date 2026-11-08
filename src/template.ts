import { parseExpressionAt } from 'acorn'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, ModelSelection } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'

export interface TemplateContext {
  tool: (name: string, args?: Record<string, unknown>) => Promise<unknown>
  ctx: Context
  agent: Agent | null
  session: Session | null
  signal: AbortSignal
  modelSelection: Readonly<ModelSelection> | undefined
}

type Expression = (context: TemplateContext) => Promise<unknown>
type Part = string | { expression: string }

// 用 JS 解析器找表达式边界，避免对象、字符串中的 }} 被误当作结束符。
function parseTemplate(template: string): Part[] {
  const pieces: Part[] = []
  let cursor = 0
  while (cursor < template.length) {
    const start = template.indexOf('{{', cursor)
    if (start === -1) {
      pieces.push(template.slice(cursor))
      break
    }
    pieces.push(template.slice(cursor, start))
    try {
      const node = parseExpressionAt(template, start + 2, {
        ecmaVersion: 'latest', sourceType: 'module', allowAwaitOutsideFunction: true, preserveParens: true,
      })
      const ending = /^\s*}}/.exec(template.slice(node.end))
      if (!ending) throw new SyntaxError('表达式后缺少 }}')
      pieces.push({ expression: template.slice(start + 2, node.end) })
      cursor = node.end + ending[0].length
    } catch (error) {
      throw new SyntaxError(`模板第 ${start + 1} 个字符附近：${(error as Error).message}`)
    }
  }
  return pieces
}

// 设置页只检查语法，不在浏览器执行表达式。
export function validateTemplate(template: string): void {
  parseTemplate(template)
}

export function compileTemplate(template: string): (context: TemplateContext) => Promise<string> {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as
    new (...args: string[]) => Expression
  const pieces = parseTemplate(template).map(part => typeof part === 'string' ? part :
    new AsyncFunction('bindings', `"use strict";
      const { tool, ctx, agent, session, signal, modelSelection } = bindings;
      return (${part.expression});`))
  return async (context) => {
    const rendered: string[] = []
    for (const piece of pieces) {
      const value = typeof piece === 'string' ? piece : await piece(context)
      rendered.push(value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value))
    }
    return rendered.join('')
  }
}
