import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createElement, Fragment } from 'react'
import { create, act, type ReactTestRenderer } from 'react-test-renderer'
import { Context } from '@deepseek-ai/cordis'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import * as ClientGateway from '@deepseek-ai/dsh-api-gateway/client'
import { installConnection } from '@deepseek-ai/dsh-client-connection/client'
import type * as Renderer from '@deepseek-ai/dsh-client-ui-renderer/client'
import * as plugin from '../src/client/index.ts'
import { defaults } from '../src/shared.ts'
import { CompressorRegistry } from '../src/compressors.ts'

test('设置页在真实 DSH 插槽与 Remote 服务中显示，接口依赖受 Cordis 检查', async () => {
  // 执行官方浏览器模块工厂；React 测试器直接渲染，不启动浏览器。
  const require = createRequire(import.meta.url)
  const source = await readFile(require.resolve('@deepseek-ai/dsh-client-ui-renderer/client'), 'utf8')
  let renderer!: typeof Renderer
  new Function('window', source)({ __ModuleLoader__: {
    load: ({ factory }: { factory: (require: NodeJS.Require) => typeof Renderer }) => {
      renderer = factory(require)
    },
  } })

  const ctx = new Context()
  let tree: ReactTestRenderer | undefined
  const calls: string[] = []
  const mutations: unknown[] = []
  const registry = new CompressorRegistry()
  const snapshot = { status: 'ready', writable: true, revision: 1, value: defaults }
  try {
    ctx.provide('configForms', {
      get: () => ({ getSnapshot: () => snapshot, subscribe: () => () => {}, mutate: async (ops: unknown) => { mutations.push(ops); return true } }),
      whileServed: (_names: string[], register: () => () => void) => register(),
    })
    await ctx.plugin(TypertRegistry)
    installConnection(ctx, { interactions: 'none', transport: { rpc: {
      async call(_channel, endpoint) {
        calls.push(endpoint)
        return { ok: true, value: endpoint.endsWith('/catalog') ? { sessions: [], tools: [], compressors: registry.list() } : '预览成功' }
      },
      async *open() {},
    } } })
    await ctx.plugin(ClientGateway)
    await ctx.plugin(renderer)
    const binding = { hooks: {}, keyedHooks: {}, props: {} }
    const current = { getSnapshot: () => binding, subscribe: () => () => {} }
    ctx.slots.installScope('session', { current, bindingSource: () => current })
    ctx.slots.register({
      name: 'root', children: { 'settings.section': { kind: 'list', scope: 'root' } },
    }, ({ renderSlot }) => renderSlot('settings.section', { close() {} }, { only: 'temporary-messages' }))
    await ctx.plugin(plugin)

    await act(async () => { tree = create(createElement(Fragment, null, ctx.slots.renderSlot('root', {}))) })
    assert.deepEqual(tree!.root.findByType('h2').children, ['临时消息'])
    assert.equal(tree!.root.findAll(node => node.props['data-slot-error']).length, 0)
    assert.equal(tree!.root.findByProps({ id: 'temporary-template' }).props.value, defaults.template)
    await act(async () => {
      tree!.root.findByProps({ id: 'temporary-ttl' }).props.onChange({ target: { value: '' } })
      tree!.root.findByProps({ id: 'temporary-k' }).props.onChange({ target: { value: '2' } })
    })
    assert.ok(calls.includes('temporaryMessagesUi/catalog'))
    const preview = tree!.root.findAllByType('button').find(node => node.children.includes('运行预览'))!
    await act(async () => { await preview.props.onClick() })
    assert.ok(calls.includes('temporaryMessagesUi/preview'))
    assert.ok(tree!.root.findAllByType('pre').some(node => node.children.includes('预览成功')))

    await act(async () => { tree!.root.findByProps({ id: 'temporary-compressor-tab' }).props.onClick() })
    assert.equal(tree!.root.findByProps({ id: 'temporary-compressor-panel' }).props.hidden, false)
    assert.equal(tree!.root.findByProps({ id: 'temporary-template-panel' }).props.hidden, true)
    const select = () => tree!.root.findByProps({ id: 'temporary-compressor' })
    assert.equal(select().props.value, 'identity')
    assert.deepEqual(select().findAllByType('option').map(option => option.children.join('')), ['保留原文', '清空全部'])

    registry.register({ id: 'custom', name: '自定义压缩器', description: '来自注册接口的说明', compress: async messages => messages })
    await act(async () => { tree!.root.findByProps({ id: 'temporary-template-tab' }).props.onClick() })
    await act(async () => { tree!.root.findByProps({ id: 'temporary-compressor-tab' }).props.onClick() })
    assert.deepEqual(select().findAllByType('option').map(option => option.props.value), ['identity', 'clear', 'custom'])
    await act(async () => { select().props.onChange({ target: { value: 'custom' } }) })
    assert.ok(tree!.root.findAllByType('p').some(node => node.children.includes('来自注册接口的说明')))
    const save = tree!.root.findAllByType('button').find(node => node.children.includes('保存设置'))!
    await act(async () => { await save.props.onClick() })
    assert.deepEqual(mutations, [[
      { op: 'set', path: ['enabled'], value: defaults.enabled },
      { op: 'set', path: ['template'], value: defaults.template },
      { op: 'set', path: ['defaultTtlTokens'], value: false },
      { op: 'set', path: ['defaultK'], value: 2 },
      { op: 'set', path: ['compressor'], value: 'custom' },
    ]])
    assert.match(tree!.root.findByProps({ role: 'status' }).children.join(''), /从下一步开始生效/)
  } finally {
    await act(async () => { tree?.unmount() })
    await ctx.fiber.dispose()
  }
})
