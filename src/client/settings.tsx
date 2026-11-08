import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import { defaults, type Catalog, type Settings } from '../shared.ts'
import type { UiRemote } from '../remote-contract.ts'
import { validateTemplate } from '../template.ts'

export interface SettingsPageProps {
  form: ConfigForm<Settings>
  api: UiRemote
}

export function SettingsPage({ form, api }: SettingsPageProps) {
  const saved = useSyncExternalStore(listener => form.subscribe(listener), () => form.getSnapshot())
  const [draft, setDraft] = useState({ ...defaults, ...saved.value })
  const [tab, setTab] = useState<'template' | 'compressor'>('template')
  const [sessionId, setSessionId] = useState('')
  const [catalog, setCatalog] = useState<Catalog>({ sessions: [], tools: [], compressors: [] })
  const [toolName, setToolName] = useState('')
  const [argumentsText, setArgumentsText] = useState('{}')
  const [preview, setPreview] = useState<string | null>(null)
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const editor = useRef<HTMLTextAreaElement>(null)
  const selectedTool = catalog.tools.find(tool => tool.name === toolName)
  const selectedCompressor = catalog.compressors.find(compressor => compressor.id === draft.compressor)

  useEffect(() => { if (saved.value) setDraft({ ...defaults, ...saved.value }) }, [saved.value])
  useEffect(() => {
    let current = true
    api.catalog(sessionId || null).then(result => {
      if (!current) return
      if (result.ok) setCatalog(result.value)
      else setNotice(result.error.message)
    }).catch(error => { if (current) setNotice(String(error)) })
    return () => { current = false }
  }, [api, sessionId, tab])

  function insertTool() {
    try {
      const args = JSON.parse(argumentsText)
      if (args === null || Array.isArray(args) || typeof args !== 'object') throw new Error('工具参数应是 JSON 对象')
      const expression = `{{ await tool(${JSON.stringify(toolName)}, ${JSON.stringify(args)}) }}`
      const start = editor.current?.selectionStart ?? draft.template.length
      const end = editor.current?.selectionEnd ?? start
      setDraft({ ...draft, template: draft.template.slice(0, start) + expression + draft.template.slice(end) })
      setNotice('已插入。可在表达式中继续取字段、计算或格式化。')
      editor.current?.focus()
    } catch (error) { setNotice((error as Error).message) }
  }

  async function save() {
    setBusy(true)
    try {
      validateTemplate(draft.template)
      const accepted = await form.mutate([
        { op: 'set', path: ['enabled'], value: draft.enabled },
        { op: 'set', path: ['template'], value: draft.template },
        { op: 'set', path: ['defaultTtlTokens'], value: draft.defaultTtlTokens },
        { op: 'set', path: ['defaultK'], value: draft.defaultK },
        { op: 'set', path: ['compressor'], value: draft.compressor },
      ], saved.revision)
      setNotice(accepted ? '已保存，从下一步开始生效。' : '保存未成功，请检查设置页连接后重试。')
    } catch (error) { setNotice((error as Error).message) }
    finally { setBusy(false) }
  }

  async function runPreview() {
    setBusy(true)
    setNotice('')
    try {
      const result = await api.preview(sessionId || null, draft.template)
      if (!result.ok) throw new Error(result.error.message)
      setPreview(result.value)
    } catch (error) { setNotice((error as Error).message) }
    finally { setBusy(false) }
  }

  return <section className="dsh-temporary-settings">
    <style>{styles}</style>
    <h2>临时消息</h2>
    <p>推理前生成消息快照，到期后撤下旧快照并重新生成。</p>
    <label className="temporary-toggle">
      <input type="checkbox" checked={draft.enabled} onChange={event => setDraft({ ...draft, enabled: event.target.checked })} />
      启用临时消息
    </label>

    <div className="temporary-tabs" role="tablist" aria-label="临时消息设置">
      <button type="button" role="tab" id="temporary-template-tab" aria-controls="temporary-template-panel"
        aria-selected={tab === 'template'} onClick={() => setTab('template')}>消息模板</button>
      <button type="button" role="tab" id="temporary-compressor-tab" aria-controls="temporary-compressor-panel"
        aria-selected={tab === 'compressor'} onClick={() => setTab('compressor')}>压缩器</button>
    </div>

    <div role="tabpanel" id="temporary-template-panel" aria-labelledby="temporary-template-tab" hidden={tab !== 'template'}>
    <label htmlFor="temporary-template">消息模板</label>
    <textarea id="temporary-template" ref={editor} rows={9} spellCheck={false}
      value={draft.template} onChange={event => setDraft({ ...draft, template: event.target.value })} />
    <p className="temporary-hint">普通文字直接发送；<code>{'{{ JS 表达式 }}'}</code> 会替换成运行结果。留空可只使用插件接口。</p>
    <details>
      <summary>表达式示例</summary>
      <pre>{'时间：{{ new Date().toLocaleString("zh-CN") }}\n会话：{{ session?.id }}\n余额：{{ (await tool("你的余额查询工具", {})).balance }}'}</pre>
      <p className="temporary-hint">支持 await 和多行函数。ctx 是当前 Agent 的服务入口，agent 是当前 Agent，session 是完整会话；没有选择预览会话时后两者为空。</p>
      <p className="temporary-hint">用 ctx.get('服务名') 读取 DSH 服务。还可使用本步 modelSelection 和取消信号 signal；tool() 调用已注册工具。</p>
    </details>

    <div className="temporary-tools">
      <h3>插入工具调用</h3>
      <label htmlFor="temporary-session">预览会话</label>
      <select id="temporary-session" value={sessionId} onChange={event => { setSessionId(event.target.value); setToolName('') }}>
        <option value="">无会话（只列出全局工具）</option>
        {catalog.sessions.map(id => <option key={id} value={id}>{id}</option>)}
      </select>
      <label htmlFor="temporary-tool">已注册工具</label>
      <select id="temporary-tool" value={toolName} onChange={event => setToolName(event.target.value)}>
        <option value="">选择工具…</option>
        {catalog.tools.map(tool => <option key={tool.name} value={tool.name}>{tool.name}</option>)}
      </select>
      {selectedTool && <>
        <p className="temporary-hint">{selectedTool.description}</p>
        <details><summary>参数说明</summary><pre>{JSON.stringify(selectedTool.parameters, null, 2)}</pre></details>
      </>}
      <label htmlFor="temporary-args">参数（JSON）</label>
      <textarea id="temporary-args" rows={3} spellCheck={false} value={argumentsText} onChange={event => setArgumentsText(event.target.value)} />
      <button type="button" disabled={!selectedTool} onClick={insertTool}>插入到模板</button>
    </div>

    <div className="temporary-limits">
      <div>
        <label htmlFor="temporary-ttl">模板寿命（生成 token 数）</label>
        <input id="temporary-ttl" type="number" min={0} step={1} placeholder="不限制" value={draft.defaultTtlTokens === false ? '' : draft.defaultTtlTokens}
          onChange={event => { const value = event.target.value; setDraft(current => ({ ...current, defaultTtlTokens: value === '' ? false : Number(value) })) }} />
      </div>
      <div>
        <label htmlFor="temporary-k">模板步数限制 k（pre-step 次数）</label>
        <input id="temporary-k" type="number" min={0} step={1} placeholder="不限制" value={draft.defaultK === false ? '' : draft.defaultK}
          onChange={event => { const value = event.target.value; setDraft(current => ({ ...current, defaultK: value === '' ? false : Number(value) })) }} />
      </div>
    </div>
    <p className="temporary-hint">只填一项就只按该项控制；两项都填，任意一个先到就重新生成，两个计数一起重置。都留空或填 0 时只用一次。k 按 pre-step 计数，工具循环也算。</p>
    <p className="temporary-hint">模板执行你写的 JS。预览会实际调用其中的工具；通常选择查询类工具。</p>
    </div>

    <div role="tabpanel" id="temporary-compressor-panel" aria-labelledby="temporary-compressor-tab" hidden={tab !== 'compressor'}>
      <p>删除临时消息时，处理它的原始位置之后、截至最近一次模型输出的上下文。</p>
      <label htmlFor="temporary-compressor">使用的压缩器</label>
      <select id="temporary-compressor" value={draft.compressor} disabled={!catalog.compressors.length}
        onChange={event => setDraft({ ...draft, compressor: event.target.value })}>
        {!selectedCompressor && <option value={draft.compressor}>当前压缩器不可用（{draft.compressor}）</option>}
        {catalog.compressors.map(compressor => <option key={compressor.id} value={compressor.id}>{compressor.name}</option>)}
      </select>
      {selectedCompressor && <p className="temporary-hint">{selectedCompressor.description}</p>}
      <p className="temporary-hint">寿命为 0 时处理本次模型输出，更长寿命处理期间累积的上下文。本步新输入和原始日志仍保留。</p>
    </div>

    <div className="temporary-actions">
      <button type="button" disabled={busy || !saved.writable} onClick={save}>保存设置</button>
      {tab === 'template' && <button type="button" disabled={busy} onClick={runPreview}>{busy ? '处理中…' : '运行预览'}</button>}
    </div>
    {notice && <p role="status">{notice}</p>}
    {tab === 'template' && preview !== null && <div className="temporary-preview"><h3>本次生成的消息</h3><pre>{preview || '（空消息，不会注入）'}</pre></div>}
  </section>
}

const styles = `
.dsh-temporary-settings { max-width: 800px; color: inherit; line-height: 1.6; padding: 8px 2px 24px; }
.dsh-temporary-settings h2 { margin: 0 0 8px; font-size: 22px; }
.dsh-temporary-settings h3 { margin: 0 0 12px; font-size: 16px; }
.dsh-temporary-settings label { display: block; margin: 14px 0 6px; font-weight: 500; }
.dsh-temporary-settings textarea, .dsh-temporary-settings select, .dsh-temporary-settings input[type=number] {
  box-sizing: border-box; width: 100%; padding: 9px 11px; border: 1px solid #8886; border-radius: 7px; color: inherit; background: transparent;
}
.dsh-temporary-settings textarea { resize: vertical; font: 13px/1.7 ui-monospace, Consolas, monospace; }
.dsh-temporary-settings select option { color: #222; background: #fff; }
.dsh-temporary-settings .temporary-toggle { display: flex; align-items: center; gap: 8px; }
.dsh-temporary-settings .temporary-limits { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 16px; }
.dsh-temporary-settings .temporary-tabs { display: flex; gap: 8px; margin: 20px 0 16px; border-bottom: 1px solid #8884; padding-bottom: 10px; }
.dsh-temporary-settings .temporary-tabs [aria-selected=true] { background: #8883; font-weight: 600; }
.dsh-temporary-settings .temporary-hint { font-size: 13px; opacity: .72; margin: 7px 0 12px; }
.dsh-temporary-settings details { margin: 10px 0; }
.dsh-temporary-settings summary { cursor: pointer; }
.dsh-temporary-settings pre { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 13px; }
.dsh-temporary-settings .temporary-tools, .dsh-temporary-settings .temporary-preview { border: 1px solid #8884; border-radius: 9px; padding: 16px; margin: 20px 0; }
.dsh-temporary-settings button { color: inherit; background: #8881; border: 1px solid #8886; border-radius: 6px; padding: 7px 14px; cursor: pointer; }
.dsh-temporary-settings button:disabled { opacity: .45; cursor: default; }
.dsh-temporary-settings .temporary-actions { display: flex; gap: 10px; margin-top: 20px; }
`
