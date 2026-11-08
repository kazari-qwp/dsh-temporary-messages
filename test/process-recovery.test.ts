import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { TemporaryMessages } from '../src/messages.ts'

test('独立子进程在四种写入中途被强杀后，可从落盘日志完整恢复', { timeout: 20000 }, async () => {
  await mkdir(new URL('../work/', import.meta.url), { recursive: true })
  const directory = await mkdtemp(fileURLToPath(new URL('../work/process-recovery-', import.meta.url)))
  for (const scenario of ['requeue', 'move', 'summary', 'tools']) {
    const filename = `${directory}/${scenario}.jsonl`
    const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./fixtures/crash-worker.ts', import.meta.url)), scenario, filename], {
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true,
    })
    let errorOutput = ''
    child.stderr!.on('data', chunk => { errorOutput += String(chunk) })
    const exited = once(child, 'exit')
    try {
      const [message] = await once(child, 'message', { signal: AbortSignal.timeout(5000) })
      assert.equal(message.ready, true, errorOutput)
      assert.equal(child.kill('SIGKILL'), true)
      await exited
      const events = (await readFile(filename, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
      const session = Session.create(SessionId(`kill-${scenario}`), events)
      const queue = new TemporaryMessages(() => 0, async () => { throw new Error('恢复已写入结果时不应再次运行压缩器') })
      queue.recover(session)
      for (const temporary of queue.pending(session)) session.append('user/message', temporary, { surfaceOp: 'append' })
      const texts = session.deriveMessages().flatMap(item => item.content.flatMap(block => block.type === 'text' ? [block.text] : []))
      const expected = scenario === 'requeue' ? ['system', 'original input', 'answer', 'temporary']
        : scenario === 'move' ? ['system', 'original input', 'late context', 'temporary']
          : scenario === 'summary' ? ['system', 'original input', 'SUMMARY_ONLY'] : ['system', 'original input']
      assert.deepEqual(texts, expected, scenario)
      assert.deepEqual(Session.create(session.id, session.snapshotEvents()).deriveMessages(), session.deriveMessages())
    } finally { child.kill('SIGKILL'); await exited }
  }
})
