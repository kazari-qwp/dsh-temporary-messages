import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { chromium } from 'playwright'
import { Context } from '@deepseek-ai/cordis'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import Gateway from '@deepseek-ai/dsh-api-gateway'
import RemoteAccess from '@deepseek-ai/dsh-api-remote-access'
import { Peer } from '@deepseek-ai/dsh-client-connection'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as plugin from '../../dist/index.js'

await build({ entryPoints: ['test/browser/entry.tsx'], outfile: 'work/ui-harness.js', bundle: true, platform: 'browser' })
const ctx = new Context()
await mountAgentLoopTestDependencies(ctx)
await ctx.plugin(TypertRegistry)
await ctx.plugin(RemoteAccess)
await ctx.plugin(Gateway)
await ctx.plugin(plugin)
ctx.tools.register({
  name: 'get_balance', description: '测试余额查询（不访问真实账户）',
  parameters: { type: 'object', properties: {} },
  output: { schema: { type: 'object', properties: { balance: { type: 'number' } }, required: ['balance'] }, render: () => [] },
  execute: async () => ({ balance: 88.5 }),
})
const peer = new Peer(ctx, { principal: { kind: 'owner' }, interactions: 'none' })
const server = createServer(async (req, res) => {
  if (req.url === '/rpc') {
    try {
      let body = ''
      for await (const chunk of req) body += chunk
      const { method, args } = JSON.parse(body)
      const value = await ctx.typertGateway.invoke({ namespace: 'temporaryMessagesUi', method, args, peer })
      res.end(JSON.stringify({ ok: true, value }))
    } catch (error) { res.end(JSON.stringify({ ok: false, error: { message: (error as Error).message } })) }
  } else if (req.url === '/harness.js' || req.url === '/plugin.js') {
    res.setHeader('Content-Type', 'text/javascript')
    res.end(await readFile(req.url === '/harness.js' ? 'work/ui-harness.js' : 'dist/client/index.js'))
  } else {
    res.setHeader('Content-Security-Policy', "script-src 'self'; style-src 'unsafe-inline'")
    res.setHeader('Content-Type', 'text/html;charset=utf-8')
    res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="font-family:system-ui;margin:28px;background:#fafafa;color:#222"><div id="root"></div><script src="/harness.js"></script><script src="/plugin.js"></script></body></html>')
  }
})
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const port = (server.address() as { port: number }).port
const browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1050, height: 1050 } })
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(`http://127.0.0.1:${port}`)
  await page.getByLabel('已注册工具').selectOption('get_balance')
  await page.getByRole('button', { name: '插入到模板' }).click()
  assert.match(await page.getByLabel('消息模板').inputValue(), /await tool\("get_balance", \{\}\)/)
  await page.getByLabel('消息模板').fill('余额：{{ (await tool("get_balance", {})).balance.toFixed(2) }}')
  await page.getByRole('button', { name: '运行预览' }).click()
  await page.getByText('余额：88.50', { exact: true }).waitFor()
  await page.getByLabel('模板寿命').fill('128')
  await page.getByRole('button', { name: '保存设置' }).click()
  await page.getByText('已保存，从下一步开始生效。').waitFor()
  assert.equal(await page.evaluate(() => (window as any).savedSettings.defaultTtlTokens), 128)
  await page.screenshot({ path: 'work/settings-desktop.png', fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
  await page.screenshot({ path: 'work/settings-mobile.png', fullPage: true })
  await page.getByLabel('消息模板').fill('{{ 1 + }}')
  await page.getByRole('button', { name: '保存设置' }).click()
  await page.getByRole('status').filter({ hasText: '模板第' }).waitFor()
  assert.equal(errors.length, 0, errors.join('\n'))
  console.log('Browser checks passed: package loader, tool insertion, real Host preview, save, syntax errors, narrow layout.')
} finally {
  await browser.close()
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  await ctx.fiber.dispose()
}
