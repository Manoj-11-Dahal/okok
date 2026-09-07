import type { ProviderConnectionInput, ProviderTestResult } from '../../shared/desktop-api'
import type { ProviderToolCall } from '../project-tool-broker'
import type { ProviderHealthState } from './request-manager'

export type ProviderRuntimeConnection = ProviderConnectionInput

export type ProviderContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail: 'auto' } }

export type ProviderStreamInput = {
  connection: ProviderRuntimeConnection
  messages: ProviderMessage[]
  signal: AbortSignal
  onDelta: (delta: string) => void
  onStatus?: (message: string) => void
}

export type ProviderMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | ProviderContentPart[] | null
  tool_call_id?: string
  tool_calls?: Array<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }>
}

export type ProviderCompletionInput = {
  connection: ProviderRuntimeConnection
  messages: ProviderMessage[]
  tools: ReadonlyArray<unknown>
  signal: AbortSignal
  onStatus?: (message: string) => void
}

export type ProviderCompletion = {
  content: string
  toolCalls: ProviderToolCall[]
}

export type ModelCapabilities = {
  supportsChat: boolean | null
  supportsStreaming: boolean | null
  supportsTools: boolean | null
  supportsParallelTools: boolean | null
  supportsVision: boolean | null
  supportsJSON: boolean | null
  supportsReasoning: boolean | null
  contextWindow: number | null
  maxOutput: number | null
}

export type CapabilityRequirement = { chat?: boolean; streaming?: boolean; tools?: boolean; vision?: boolean; json?: boolean; adequateContext?: number }

export interface ModelProvider {
  readonly protocol: string
  healthCheck(connection: ProviderRuntimeConnection): Promise<ProviderTestResult>
  listModels(connection: ProviderRuntimeConnection): Promise<string[]>
  stream(input: ProviderStreamInput): Promise<void>
  complete(input: ProviderCompletionInput): Promise<ProviderCompletion>
  probeCapabilities?(connection: ProviderRuntimeConnection, requirement: CapabilityRequirement, signal: AbortSignal): Promise<Partial<ModelCapabilities>>
  providerHealth?(connection: ProviderRuntimeConnection): { state: ProviderHealthState; active: number; queued: number }
  resetProviderHealth?(connection: ProviderRuntimeConnection): void
  recordFallback?(from: ProviderRuntimeConnection, to: ProviderRuntimeConnection): void
}
