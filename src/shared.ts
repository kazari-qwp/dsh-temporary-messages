export const ENTRY_ID = 'temporary-messages'

export interface Settings {
  enabled: boolean
  template: string
  defaultTtlTokens: number | false
  defaultK: number | false
  compressor: string
}

export const defaults: Settings = {
  enabled: true,
  template: '当前时间：{{ new Date().toLocaleString("zh-CN", { hour12: false }) }}',
  defaultTtlTokens: 0,
  defaultK: false,
  compressor: 'identity',
}

export interface ToolInfo {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface CompressorInfo {
  id: string
  name: string
  description: string
}

export interface Catalog {
  sessions: string[]
  tools: ToolInfo[]
  compressors: CompressorInfo[]
}
