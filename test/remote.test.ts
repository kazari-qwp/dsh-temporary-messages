import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import Gateway from '@deepseek-ai/dsh-api-gateway'
import RemoteAccess from '@deepseek-ai/dsh-api-remote-access'
import * as ClientGateway from '@deepseek-ai/dsh-api-gateway/client'
import { installConnection } from '@deepseek-ai/dsh-client-connection/client'
import { Peer } from '@deepseek-ai/dsh-client-connection'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as plugin from '../src/index.ts'
import { remoteContribution } from '../src/remote-contract.ts'

test('设置页通过官方 Client Remote → Host Gateway 获取目录并执行预览', { timeout: 15000 }, async () => {
  const host = new Context()
  const client = new Context()
  try {
    await mountAgentLoopTestDependencies(host)
    await host.plugin(TypertRegistry)
    await host.plugin(RemoteAccess)
    await host.plugin(Gateway)
    await host.plugin(plugin)
    const peer = new Peer(host, { principal: { kind: 'owner' }, interactions: 'none' })

    await client.plugin(TypertRegistry)
    installConnection(client, { interactions: 'none', transport: { rpc: {
      async call(_channel, endpoint, payload, signal) {
        const [namespace, method] = endpoint.split('/')
        const value = await host.typertGateway.invoke({
          namespace, method, args: (payload as { args: Record<string, unknown> }).args, peer, signal,
        })
        return { ok: true, value }
      },
      async *open() { /* 本测试不使用流式通知 */ },
    } } })
    await client.plugin(ClientGateway)
    await client.remote.$mount(remoteContribution)

    const catalog = await client.remote.temporaryMessagesUi.catalog(null)
    assert.ok(catalog.ok)
    assert.deepEqual(catalog.value.sessions, [])
    assert.deepEqual(catalog.value.compressors.map(compressor => compressor.id), ['identity', 'clear'])
    const extension = await host.plugin({
      inject: ['temporaryMessageCompressors'],
      apply(ctx: Context) {
        ctx.effect(() => ctx.temporaryMessageCompressors.register({
          id: 'extension', name: '外部压缩器', description: '由另一插件注册',
          compress: async messages => messages,
        }))
      },
    })
    const extended = await client.remote.temporaryMessagesUi.catalog(null)
    assert.ok(extended.ok)
    assert.deepEqual(extended.value.compressors.at(-1), { id: 'extension', name: '外部压缩器', description: '由另一插件注册' })
    await extension.dispose()
    const removed = await client.remote.temporaryMessagesUi.catalog(null)
    assert.ok(removed.ok)
    assert.deepEqual(removed.value.compressors, catalog.value.compressors)
    const result = await client.remote.temporaryMessagesUi.preview(null, '结果 {{ 6 * 7 }}')
    assert.deepEqual(result, { ok: true, value: '结果 42' })
    await assert.rejects(host.typertGateway.invoke({
      namespace: 'temporaryMessagesUi', method: 'preview', peer,
      args: { sessionId: null, template: 123 },
    }), /validation/i)
  } finally {
    await client.fiber.dispose()
    await host.fiber.dispose()
  }
})
