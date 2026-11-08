import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { compileTemplate, type TemplateContext } from '../src/template.ts'

const ctx = new Context()
after(() => ctx.fiber.dispose())
const bindings: TemplateContext = {
  ctx, agent: null, session: null, signal: new AbortController().signal,
  modelSelection: undefined, tool: async () => null,
}

test('文本、嵌套对象、字符串里的 }}、格式化和 await', async () => {
  const calls: unknown[] = []
  const render = compileTemplate('状态 {{ ({ nested: { text: "}}" } }).nested.text }}；余额 {{ (await tool("balance", { account: "a" })).value.toFixed(2) }}；{{ session.id }}')
  assert.equal(await render({
    ...bindings, session: Session.create(SessionId('s1')),
    tool: async (...args) => { calls.push(args); return { value: 12.5 } },
  }), '状态 }}；余额 12.50；s1')
  assert.deepEqual(calls, [['balance', { account: 'a' }]])
})

test('对象转 JSON，null 为空，JS 模板字符串可以嵌套', async () => {
  const render = compileTemplate('{{ {a: {b: 2}} }}{{ null }} / {{ `hi ${1 + 2}` }}')
  assert.equal(await render(bindings), '{"a":{"b":2}} / hi 3')
})

test('错误语法和运行失败会报告，空模板不产生文字', async () => {
  assert.throws(() => compileTemplate('a {{ 1 + }}'), /模板第/)
  assert.throws(() => compileTemplate('{{ 123 }'), /缺少/)
  await assert.rejects(compileTemplate('{{ await tool("missing") }}')({
    ...bindings, tool: async () => { throw new Error('missing tool') },
  }), /missing tool/)
  assert.equal(await compileTemplate('')(bindings), '')
})
