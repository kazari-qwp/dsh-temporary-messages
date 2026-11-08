import * as React from 'react'
import * as jsx from 'react/jsx-runtime'
import { createRoot } from 'react-dom/client'

const root = createRoot(document.getElementById('root')!)
let snapshot = {
  status: 'ready', writable: true, revision: 1,
  value: { enabled: true, template: '当前时间：{{ new Date().toLocaleString("zh-CN") }}', defaultTtlTokens: 0 },
}
const listeners = new Set<() => void>()
const form = {
  getSnapshot: () => snapshot,
  subscribe: (fn: () => void) => { listeners.add(fn); return () => listeners.delete(fn) },
  async mutate(ops: { path: string[]; value: unknown }[]) {
    const value = { ...snapshot.value }
    for (const op of ops) (value as Record<string, unknown>)[op.path[0]] = op.value
    snapshot = { ...snapshot, value, revision: snapshot.revision + 1 }
    ;(window as any).savedSettings = value
    for (const fn of listeners) fn()
    return true
  },
}
async function call(method: string, args: Record<string, unknown>) {
  return (await fetch('/rpc', { method: 'POST', body: JSON.stringify({ method, args }) })).json()
}
const remote = {
  $mount: async () => () => {},
  temporaryMessagesUi: {
    catalog: (sessionId: string | null) => call('catalog', { sessionId }),
    preview: (sessionId: string | null, template: string) => call('preview', { sessionId, template }),
  },
}
;(window as any).__ModuleLoader__ = {
  load({ id, factory }: any) {
    if (id !== 'dsh-temporary-messages') throw new Error(id)
    const plugin = factory((name: string) => {
      if (name === 'react') return React
      if (name === 'react/jsx-runtime') return jsx
      throw new Error(`Unexpected browser dependency: ${name}`)
    })
    plugin.apply({
      get: () => remote,
      inject(_names: string[], fn: (ctx: unknown) => unknown) { return fn(this) },
      effect: (fn: () => unknown) => fn(),
      configForms: { get: () => form, whileServed: (_ns: string[], fn: () => unknown) => fn() },
      slots: {
        inject: (_name: string, fn: () => unknown) => fn(),
        register(options: any, Component: React.ComponentType<any>) {
          root.render(<Component {...options.inject()} />)
          return () => root.unmount()
        },
      },
    })
  },
}
