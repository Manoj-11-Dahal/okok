import { providerPresets } from '../../shared/desktop-api'
import { parseOpenAiStreamBlock } from '../../shared/provider-protocol'
import { RequestManager, nativeTransport, estimateTokens, classifyFailure, ProviderFailure, type Transport } from './request-manager'
import type { CapabilityRequirement, ModelCapabilities, ModelProvider, ProviderCompletion, ProviderCompletionInput, ProviderRuntimeConnection, ProviderStreamInput, ProviderMessage } from './model-provider'
import { providerAdapter } from './provider-adapters'
import { randomUUID } from 'node:crypto'

function contentEncodedToolCalls(content: string, tools: ReadonlyArray<unknown>) {
  const offered = new Set(tools.flatMap(tool => {
    if (typeof tool !== 'object' || tool === null) return []
    const definition = (tool as { function?: unknown }).function
    return typeof definition === 'object' && definition !== null && typeof (definition as { name?: unknown }).name === 'string'
      ? [(definition as { name: string }).name]
      : []
  }))
  if (!offered.size) return []

  const trimmed = content.trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .replace(/^<tool_call>\s*/i, '')
    .replace(/\s*<\/tool_call>$/i, '')
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return []
  try {
    const parsed = JSON.parse(trimmed) as unknown
    const candidates = Array.isArray(parsed) ? parsed : [parsed]
    return candidates.flatMap(candidate => {
      if (typeof candidate !== 'object' || candidate === null) return []
      const value = candidate as { name?: unknown; arguments?: unknown; parameters?: unknown; function?: { name?: unknown; arguments?: unknown } }
      const name = typeof value.name === 'string' ? value.name : typeof value.function?.name === 'string' ? value.function.name : ''
      if (!offered.has(name)) return []
      const supplied = value.arguments ?? value.parameters ?? value.function?.arguments ?? {}
      let args: string
      if (typeof supplied === 'string') {
        const checked = JSON.parse(supplied) as unknown
        if (typeof checked !== 'object' || checked === null || Array.isArray(checked)) return []
        args = supplied
      } else {
        if (typeof supplied !== 'object' || supplied === null || Array.isArray(supplied)) return []
        args = JSON.stringify(supplied)
      }
      return [{ id: `ollama-tool-${randomUUID()}`, name, arguments: args }]
    })
  } catch {
    return []
  }
}

export class OpenAiCompatibleProvider implements ModelProvider {
  readonly protocol = 'openai-chat-completions'
  constructor(private readonly timeoutMs?: number, readonly requests = new RequestManager(), private readonly transport: Transport = nativeTransport) {}
  providerHealth(connection: ProviderRuntimeConnection) { const health = this.requests.health(connection); return { state: health.state, active: health.active, queued: health.queued } }
  resetProviderHealth(connection: ProviderRuntimeConnection): void { this.requests.resetProvider(connection) }
  recordFallback(from: ProviderRuntimeConnection, to: ProviderRuntimeConnection): void { this.requests.recordFallback(from, to) }

  async listModels(connection: ProviderRuntimeConnection): Promise<string[]> {
    const adapter = providerAdapter(connection.providerId)
    const response = await this.transport(`${connection.baseUrl}/models`, { headers: adapter.headers(connection.apiKey), signal: AbortSignal.timeout(20000) }, 15000)
    if (!response.ok) throw classifyFailure(response.status, '', response.headers.get('retry-after'), { provider: connection.providerId, model: connection.model, apiKey: connection.apiKey })
    const body = await response.json() as { data?: Array<{ id?: unknown }> }
    return [...new Set((body.data ?? []).flatMap(model => {
      if (typeof model.id !== 'string') return []
      // Gemini's catalog currently returns resource names such as
      // "models/gemini-3.8-flash", while its OpenAI-compatible chat endpoint
      // expects the plain model ID.
      return [connection.providerId === 'google' ? model.id.replace(/^models\//, '') : model.id]
    }))].sort().slice(0, 500)
  }

  async healthCheck(connection: ProviderRuntimeConnection) {
    const started = Date.now()
    try {
      await this.requests.execute({ connection, messages: [{ role: 'user', content: 'Reply only with: OK' }], tools: [], signal: new AbortController().signal, stream: false, requestHeaders: providerAdapter(connection.providerId).headers(connection.apiKey),
        overrides: { inputTokens: 1024, outputTokens: 64, maxAttempts: 1, overallMs: 120000, firstTokenMs: 90000 },
        consume: async response => { const data = await response.json() as { choices?: unknown[] }; if (!data.choices?.length) throw new Error('Invalid provider response') },
      })
      return { ok: true, message: `Connected to ${providerPresets.find(p => p.id === connection.providerId)?.displayName ?? 'provider'}.`, latencyMs: Date.now() - started }
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : 'Provider connection failed.',
        latencyMs: Date.now() - started,
        ...(error instanceof ProviderFailure ? { failureKind: error.kind, errorCategory: error.category } : { failureKind: 'network' as const, errorCategory: 'CONNECTION_ERROR' as const }),
      }
    }
  }

  async probeCapabilities(connection: ProviderRuntimeConnection, requirement: CapabilityRequirement, signal: AbortSignal): Promise<Partial<ModelCapabilities>> {
    const capabilities: Partial<ModelCapabilities> = {}
    if (requirement.chat || requirement.tools) {
      await this.complete({ connection: { ...connection, requestPolicy: { ...connection.requestPolicy, inputTokens: 1024, outputTokens: 64, maxAttempts: 1 } }, messages: [{ role: 'user', content: 'Reply only with: OK' }], tools: [], signal })
      capabilities.supportsChat = true
    }
    if (requirement.streaming) {
      let received = false
      await this.stream({ connection: { ...connection, requestPolicy: { ...connection.requestPolicy, inputTokens: 1024, outputTokens: 64, maxAttempts: 1 } }, messages: [{ role: 'user', content: 'Reply only with: OK' }], signal, onDelta: () => { received = true } })
      capabilities.supportsStreaming = received
    }
    if (requirement.tools) {
      try {
        const result = await this.complete({ connection: { ...connection, requestPolicy: { ...connection.requestPolicy, inputTokens: 1024, outputTokens: 64, maxAttempts: 1 } }, messages: [{ role: 'user', content: 'Call the echo tool exactly once with value "OK".' }], tools: [{ type: 'function', function: { name: 'echo', description: 'Echo a value.', parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false } } }], signal })
        capabilities.supportsTools = result.toolCalls.some(call => call.name === 'echo')
        capabilities.supportsParallelTools = null
      } catch (error) {
        if (error instanceof ProviderFailure && ['TOOLS_UNSUPPORTED', 'BAD_REQUEST'].includes(error.category)) capabilities.supportsTools = false
        else throw error
      }
    }
    return capabilities
  }

  async stream({ connection, messages, signal, onDelta, onStatus }: ProviderStreamInput): Promise<void> {
    let pendingText = ''
    const safeDelta = (delta: string, final = false) => { pendingText += delta; if (connection.apiKey) pendingText = pendingText.replaceAll(connection.apiKey, '[REDACTED]'); const length = final ? pendingText.length : Math.max(0, pendingText.length - connection.apiKey.length + 1); if (length) { onDelta(pendingText.slice(0, length)); pendingText = pendingText.slice(length) } }
    await this.requests.execute({ connection, messages: messages as ProviderMessage[], signal, stream: true, requestHeaders: providerAdapter(connection.providerId).headers(connection.apiKey),
      ...(onStatus ? { onStatus } : {}), ...(this.timeoutMs ? { overrides: { firstTokenMs: this.timeoutMs, overallMs: this.timeoutMs, maxAttempts: 1 } } : {}),
      buildBody: ({ messages: safeMessages, tools, stream, maxOutput }) => providerAdapter(connection.providerId).build({ model: connection.model, messages: safeMessages, tools, stream, maxOutput }),
      consume: async (response, touch, progress) => {
        if (!response.body) throw new Error('Provider returned no stream.')
        const reader = response.body.getReader(), decoder = new TextDecoder()
        let buffer = '', received = false
        try {
          while (true) {
            const { done, value } = await reader.read()
            if (value?.length) touch()
            buffer += decoder.decode(value, { stream: !done })
            if (buffer.length > 1000000) throw new Error('Provider stream frame exceeded the limit.')
            const blocks = buffer.split(/\r?\n\r?\n/); buffer = blocks.pop() ?? ''
            for (const block of blocks) {
              const delta = parseOpenAiStreamBlock(block)
              if (delta) { received = true; progress(estimateTokens(delta)); safeDelta(delta) }
              if (block.includes('data: [DONE]')) { await reader.cancel(); if (!received) throw new ProviderFailure('Provider returned no usable text.', 'invalid-request', false); safeDelta('', true); return }
            }
            if (done) break
          }
          const delta = parseOpenAiStreamBlock(buffer)
          if (delta) { received = true; progress(estimateTokens(delta)); safeDelta(delta) }
          if (!received) throw new Error('Provider returned no usable response.')
          safeDelta('', true)
        } finally { reader.releaseLock() }
      },
    })
  }

  async complete({ connection, messages, tools, signal, onStatus }: ProviderCompletionInput): Promise<ProviderCompletion> {
    return this.requests.execute({ connection, messages, tools, signal, stream: false, requestHeaders: providerAdapter(connection.providerId).headers(connection.apiKey),
      ...(onStatus ? { onStatus } : {}), ...(this.timeoutMs ? { overrides: { firstTokenMs: this.timeoutMs, overallMs: this.timeoutMs, maxAttempts: 1 } } : {}),
      buildBody: ({ messages: safeMessages, tools: safeTools, stream, maxOutput }) => providerAdapter(connection.providerId).build({ model: connection.model, messages: safeMessages, tools: safeTools, stream, maxOutput }),
      consume: async (response, touch, progress) => {
        if (!response.body) throw new Error('Provider returned no response.')
        const reader = response.body.getReader(), decoder = new TextDecoder(); let text = ''
        try { while (true) { const { done, value } = await reader.read(); if (done) break; touch(); text += decoder.decode(value, { stream: true }); if (text.length > 2000000) throw new Error('Completion exceeded the response limit.') } text += decoder.decode() }
        finally { reader.releaseLock() }
        const body = JSON.parse(connection.apiKey ? text.replaceAll(JSON.stringify(connection.apiKey).slice(1, -1), '[REDACTED]') : text) as { choices?: Array<{ finish_reason?: string; message?: { content?: string | null; tool_calls?: Array<{ id?: string; type?: string; function?: { name?: string; arguments?: string } }> } }> }
        const choice = body.choices?.[0], message = choice?.message
        if (!message) throw new Error('Provider returned an invalid completion.')
        if (choice?.finish_reason === 'length') throw new ProviderFailure('Model output reached its limit. Increase output budget or request a smaller edit.', 'invalid-request', false)
        let toolCalls = (message.tool_calls ?? []).flatMap(call => typeof call.id === 'string' && call.type === 'function' && typeof call.function?.name === 'string' && typeof call.function.arguments === 'string' ? [{ id: call.id, name: call.function.name, arguments: call.function.arguments }] : [])
        if (toolCalls.length === 0 && connection.providerId === 'ollama' && typeof message.content === 'string') toolCalls = contentEncodedToolCalls(message.content, tools)
        progress(estimateTokens(message))
        return { content: toolCalls.length > 0 && connection.providerId === 'ollama' ? '' : typeof message.content === 'string' ? message.content : '', toolCalls }
      },
    })
  }
}

