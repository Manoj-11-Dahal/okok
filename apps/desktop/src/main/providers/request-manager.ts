import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { Readable } from 'node:stream'
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib'
import type { RequestPolicy } from '../../shared/request-policy'
import { requestPolicy } from '../../shared/request-policy'
import { classifyProviderHttpError, type ProviderErrorCategory } from '../../shared/provider-errors'
import type { ProviderRuntimeConnection, ProviderMessage } from './model-provider'
import { budgetContext, estimateTokens } from './context-manager'

export type FailureKind = 'authentication' | 'too-large' | 'rate-limit' | 'quota-exhausted' | 'timeout' | 'unavailable' | 'model-unavailable' | 'tools-unsupported' | 'invalid-request' | 'network' | 'cancelled'
const legacyCategory: Record<FailureKind, ProviderErrorCategory> = {
  authentication: 'AUTH_ERROR', 'too-large': 'CONTEXT_TOO_LARGE', 'rate-limit': 'RATE_LIMITED', 'quota-exhausted': 'QUOTA_EXHAUSTED', timeout: 'TIMEOUT', unavailable: 'PROVIDER_SERVER_ERROR', 'model-unavailable': 'MODEL_UNAVAILABLE', 'tools-unsupported': 'TOOLS_UNSUPPORTED', 'invalid-request': 'BAD_REQUEST', network: 'CONNECTION_ERROR', cancelled: 'CANCELLED',
}
function legacyKind(category: ProviderErrorCategory): FailureKind {
  if (category === 'AUTH_ERROR' || category === 'INVALID_API_KEY') return 'authentication'
  if (category === 'CONTEXT_TOO_LARGE') return 'too-large'
  if (category === 'RATE_LIMITED') return 'rate-limit'
  if (category === 'QUOTA_EXHAUSTED') return 'quota-exhausted'
  if (category === 'TIMEOUT') return 'timeout'
  if (category === 'PROVIDER_SERVER_ERROR') return 'unavailable'
  if (category === 'MODEL_NOT_FOUND' || category === 'MODEL_UNAVAILABLE') return 'model-unavailable'
  if (category === 'TOOLS_UNSUPPORTED') return 'tools-unsupported'
  if (category === 'CONNECTION_ERROR') return 'network'
  if (category === 'CANCELLED') return 'cancelled'
  return 'invalid-request'
}

export class ProviderFailure extends Error {
  readonly category: ProviderErrorCategory
  readonly technicalDetails: string
  readonly provider: string | undefined
  readonly model: string | undefined
  constructor(message: string, readonly kind: FailureKind, readonly retryable: boolean, readonly status = 0, readonly retryAfterMs = 0, readonly tokenLimit?: number, category = legacyCategory[kind], technicalDetails = '', context?: { provider?: string; model?: string }) {
    super(message); this.category = category; this.technicalDetails = technicalDetails; this.provider = context?.provider; this.model = context?.model
  }
}
export function classifyFailure(status: number, body: string, retryAfter: string | null, context?: { provider?: string; model?: string; apiKey?: string }): ProviderFailure {
  const result = classifyProviderHttpError(status, body, retryAfter)
  const technicalDetails = context?.apiKey ? result.technicalDetails.replaceAll(context.apiKey, '[REDACTED]') : result.technicalDetails
  return new ProviderFailure(result.message, legacyKind(result.category), result.retryable, status, result.retryAfterMs, result.tokenLimit, result.category, technicalDetails, context)
}
export function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason ?? new DOMException('Cancelled', 'AbortError')); return }
    const cancel = () => { clearTimeout(timer); reject(signal.reason ?? new DOMException('Cancelled', 'AbortError')) }
    const timer = setTimeout(() => { signal.removeEventListener('abort', cancel); resolve() }, ms)
    signal.addEventListener('abort', cancel, { once: true })
  })
}

export type Transport = (url: string, init: RequestInit, connectionMs: number) => Promise<Response>
export const nativeTransport: Transport = (url, init, connectionMs) => new Promise((resolve, reject) => {
  const parsed = new URL(url)
  const request = (parsed.protocol === 'https:' ? httpsRequest : httpRequest)(parsed, { method: init.method ?? 'GET', headers: init.headers as Record<string, string>, signal: init.signal ?? undefined }, response => {
    clearTimeout(connectTimer); const headers = new Headers()
    for (const [key, value] of Object.entries(response.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value)
    const encoding = String(response.headers['content-encoding'] ?? '').toLowerCase()
    const decoded: Readable = encoding === 'gzip' ? response.pipe(createGunzip()) : encoding === 'deflate' ? response.pipe(createInflate()) : encoding === 'br' ? response.pipe(createBrotliDecompress()) : response
    if (encoding) { headers.delete('content-encoding'); headers.delete('content-length') }
    resolve(new Response(Readable.toWeb(decoded) as ReadableStream<Uint8Array>, { status: response.statusCode ?? 500, headers }))
  })
  const connectTimer = setTimeout(() => request.destroy(new ProviderFailure('Provider connection timed out.', 'timeout', true, 0, 0, undefined, 'TIMEOUT', 'Connection deadline exceeded.')), connectionMs)
  request.on('socket', socket => { if (!socket.connecting) clearTimeout(connectTimer); else socket.once(parsed.protocol === 'https:' ? 'secureConnect' : 'connect', () => clearTimeout(connectTimer)) })
  request.on('error', error => { clearTimeout(connectTimer); reject(error) })
  request.end(typeof init.body === 'string' ? init.body : undefined)
})

export type ProviderHealthState = 'HEALTHY' | 'DEGRADED' | 'RATE_LIMITED' | 'QUOTA_EXHAUSTED' | 'OFFLINE'
export type RequestMetric = { id: string; startedAt: string; provider: string; model: string; durationMs: number; inputTokens: number; outputTokens: number; retries: number; status: 'complete' | 'failed' | 'cancelled'; httpStatus?: number; errorCategory?: ProviderErrorCategory; retryable?: boolean; retryAfterMs?: number; technicalDetails?: string; fallbackDestination?: string }
type ProviderQueue = { active: number; queued: number; cooldownUntil: number; offlineUntil: number; quotaExhausted: boolean; failures: number; completed: number; latencyMs: number; lastCategory: ProviderErrorCategory | undefined }
const freshQueue = (): ProviderQueue => ({ active: 0, queued: 0, cooldownUntil: 0, offlineUntil: 0, quotaExhausted: false, failures: 0, completed: 0, latencyMs: 0, lastCategory: undefined })

export class RequestManager {
  private queues = new Map<string, ProviderQueue>()
  readonly metrics: RequestMetric[] = []
  constructor(private readonly transport: Transport = nativeTransport, private readonly metricSink?: (metric: RequestMetric) => void) {}
  providerKey(connection: Pick<ProviderRuntimeConnection, 'providerId' | 'baseUrl'>): string { return `${connection.providerId}:${connection.baseUrl}` }
  health(keyOrConnection: string | Pick<ProviderRuntimeConnection, 'providerId' | 'baseUrl'>) {
    const key = typeof keyOrConnection === 'string' ? keyOrConnection : this.providerKey(keyOrConnection), q = this.queues.get(key) ?? freshQueue(), now = Date.now()
    const state: ProviderHealthState = q.quotaExhausted ? 'QUOTA_EXHAUSTED' : q.cooldownUntil > now ? 'RATE_LIMITED' : q.offlineUntil > now ? 'OFFLINE' : q.failures ? 'DEGRADED' : 'HEALTHY'
    return { ...q, state }
  }
  resetProvider(connection: Pick<ProviderRuntimeConnection, 'providerId' | 'baseUrl'>): void { this.queues.set(this.providerKey(connection), freshQueue()) }
  isProviderAvailable(connection: Pick<ProviderRuntimeConnection, 'providerId' | 'baseUrl'>): boolean { return ['HEALTHY', 'DEGRADED'].includes(this.health(connection).state) }
  recordFallback(from: ProviderRuntimeConnection, to: ProviderRuntimeConnection): void { const metric = [...this.metrics].reverse().find(item => item.provider === from.providerId && item.model === from.model && item.status === 'failed' && !item.fallbackDestination); if (metric) metric.fallbackDestination = `${to.providerId}/${to.model}` }
  private queue(connection: ProviderRuntimeConnection): ProviderQueue { const key = this.providerKey(connection), queue = this.queues.get(key) ?? freshQueue(); this.queues.set(key, queue); return queue }
  private circuitFailure(connection: ProviderRuntimeConnection): ProviderFailure | null {
    const health = this.health(connection)
    if (health.state === 'QUOTA_EXHAUSTED') return new ProviderFailure('The provider account quota or credits are exhausted.', 'quota-exhausted', false, 429, 0, undefined, 'QUOTA_EXHAUSTED', 'Circuit breaker excluded this provider for the current session.', connection)
    if (health.state === 'RATE_LIMITED') return new ProviderFailure('The provider is temporarily rate limited.', 'rate-limit', false, 429, Math.max(0, health.cooldownUntil - Date.now()), undefined, 'RATE_LIMITED', 'Circuit breaker cooldown is active.', connection)
    if (health.state === 'OFFLINE') return new ProviderFailure('The provider is temporarily offline.', 'network', false, 0, Math.max(0, health.offlineUntil - Date.now()), undefined, 'CONNECTION_ERROR', 'Circuit breaker marked this provider offline.', connection)
    return null
  }
  private updateCircuit(connection: ProviderRuntimeConnection, failure?: ProviderFailure): void {
    const queue = this.queue(connection)
    if (!failure) { queue.completed++; queue.failures = 0; queue.cooldownUntil = 0; queue.offlineUntil = 0; queue.lastCategory = undefined; return }
    queue.failures++; queue.lastCategory = failure.category
    if (failure.category === 'QUOTA_EXHAUSTED') queue.quotaExhausted = true
    else if (failure.category === 'RATE_LIMITED') queue.cooldownUntil = Date.now() + Math.max(1000, failure.retryAfterMs || 30_000)
    else if (failure.category === 'INVALID_API_KEY' || failure.category === 'AUTH_ERROR') queue.offlineUntil = Number.MAX_SAFE_INTEGER
    else if ((failure.category === 'CONNECTION_ERROR' || failure.category === 'PROVIDER_SERVER_ERROR') && queue.failures >= 2) queue.offlineUntil = Date.now() + 30_000
  }
  private async acquire(connection: ProviderRuntimeConnection, policy: RequestPolicy, signal: AbortSignal): Promise<() => void> {
    const blocked = this.circuitFailure(connection); if (blocked) throw blocked
    const queue = this.queue(connection); queue.queued++
    try { while (queue.active >= (queue.failures ? 1 : policy.concurrency)) await abortableDelay(50, signal); signal.throwIfAborted(); const afterWait = this.circuitFailure(connection); if (afterWait) throw afterWait; queue.active++; return () => { queue.active-- } }
    finally { queue.queued-- }
  }
  async execute<T>({ connection, messages, tools = [], signal, stream, consume, onStatus, overrides = {}, bodyExtras = {}, requestHeaders = {}, buildBody }: { connection: ProviderRuntimeConnection; messages: ProviderMessage[]; tools?: readonly unknown[]; signal: AbortSignal; stream: boolean; consume: (response: Response, touch: () => void, progress: (tokens: number) => void) => Promise<T>; onStatus?: (message: string) => void; overrides?: Partial<RequestPolicy>; bodyExtras?: Record<string, unknown>; requestHeaders?: Record<string, string>; buildBody?: (input: { messages: ProviderMessage[]; tools: readonly unknown[]; stream: boolean; maxOutput: number }) => Record<string, unknown> }): Promise<T> {
    const policy = requestPolicy(connection.providerId, { ...connection.requestPolicy, ...overrides }), root = new AbortController(), parentAbort = () => root.abort(signal.reason)
    signal.addEventListener('abort', parentAbort, { once: true }); if (signal.aborted) parentAbort()
    const overall = setTimeout(() => root.abort(new ProviderFailure('Provider overall request deadline exceeded.', 'timeout', true, 0, 0, undefined, 'TIMEOUT', 'Overall deadline exceeded.', connection)), policy.overallMs)
    const started = Date.now(), startedAt = new Date(started).toISOString(), requestId = crypto.randomUUID()
    let attempts = 0, recovery = 0, budget = policy.inputTokens, outputBudget = policy.outputTokens, outputTokens = 0, inputTokens = 0, delivered = false, finalFailure: ProviderFailure | undefined
    const metric = (status: RequestMetric['status'], failure?: ProviderFailure) => { const entry: RequestMetric = { id: requestId, startedAt, provider: connection.providerId, model: connection.model, durationMs: Date.now() - started, inputTokens, outputTokens, retries: Math.max(0, attempts - 1), status, ...(failure?.status ? { httpStatus: failure.status } : {}), ...(failure ? { errorCategory: failure.category, retryable: failure.retryable, retryAfterMs: failure.retryAfterMs, technicalDetails: failure.technicalDetails } : {}) }; this.metrics.push(entry); if (this.metrics.length > 500) this.metrics.shift(); this.metricSink?.(entry) }
    try {
      for (attempts = 1; attempts <= policy.maxAttempts; attempts++) {
        root.signal.throwIfAborted()
        const safeMessages = connection.apiKey ? JSON.parse(JSON.stringify(messages).replaceAll(JSON.stringify(connection.apiKey).slice(1, -1), '[REDACTED]')) as ProviderMessage[] : messages
        const context = budgetContext(safeMessages, tools, budget, recovery); inputTokens = context.estimatedTokens
        const release = await this.acquire(connection, policy, root.signal), attempt = new AbortController(), abort = () => attempt.abort(root.signal.reason)
        root.signal.addEventListener('abort', abort, { once: true }); if (root.signal.aborted) abort()
        let timer = setTimeout(() => attempt.abort(new ProviderFailure('Provider first-token deadline exceeded.', 'timeout', true, 0, 0, undefined, 'TIMEOUT', 'First-token deadline exceeded.', connection)), policy.firstTokenMs)
        const touch = () => { clearTimeout(timer); timer = setTimeout(() => attempt.abort(new ProviderFailure('Provider stream became idle.', 'timeout', true, 0, 0, undefined, 'TIMEOUT', 'Stream idle deadline exceeded.', connection)), policy.idleMs) }
        let failure: ProviderFailure | undefined
        try {
          const maxOutput = Math.min(outputBudget, Math.max(64, Math.floor(budget / 2)))
          const payload = buildBody ? buildBody({ messages: context.messages, tools, stream, maxOutput }) : { model: connection.model, stream, messages: context.messages, max_tokens: maxOutput, ...(tools.length ? { tools, tool_choice: 'auto' } : {}) }
          const response = await this.transport(`${connection.baseUrl}/chat/completions`, { method: 'POST', signal: attempt.signal, headers: { ...requestHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ ...payload, ...bodyExtras }) }, policy.connectionMs)
          if (!response.ok) { const body = (await response.text()).slice(0, 8000); throw classifyFailure(response.status, body, response.headers.get('retry-after'), { provider: connection.providerId, model: connection.model, apiKey: connection.apiKey }) }
          const result = await consume(response, touch, tokens => { delivered = true; outputTokens += tokens })
          const queue = this.queue(connection); queue.latencyMs = Date.now() - started; this.updateCircuit(connection); metric('complete'); return result
        } catch (error) {
          if (root.signal.aborted) throw root.signal.reason
          failure = attempt.signal.reason instanceof ProviderFailure ? attempt.signal.reason : error instanceof ProviderFailure ? error : new ProviderFailure('ALTREX could not connect to the provider.', 'network', true, 0, 0, undefined, 'CONNECTION_ERROR', error instanceof Error ? error.message.slice(0, 1200) : 'Network transport failed.', connection)
          finalFailure = failure; this.updateCircuit(connection, failure)
        } finally { clearTimeout(timer); root.signal.removeEventListener('abort', abort); release() }
        if (!failure || delivered || attempts === policy.maxAttempts) throw failure ?? new Error('Request failed')
        const retryRateLimit = failure.category === 'RATE_LIMITED' && failure.retryAfterMs <= 30_000, retryTransient = failure.category === 'TIMEOUT' || failure.category === 'CONNECTION_ERROR' || failure.category === 'PROVIDER_SERVER_ERROR'
        if (failure.category === 'CONTEXT_TOO_LARGE') {
          recovery++; outputBudget = Math.max(64, Math.floor(outputBudget * .65)); const limitBudget = failure.tokenLimit ? Math.floor(failure.tokenLimit * .7) - outputBudget : budget; budget = Math.floor(Math.min(budget * .65, limitBudget))
          if (budget < 1024) throw new ProviderFailure('Provider token limit is too small for the required task and tools.', 'too-large', false, failure.status, 0, failure.tokenLimit, 'CONTEXT_TOO_LARGE', failure.technicalDetails, connection)
          onStatus?.(`Request was too large; retrying once with ${budget} estimated input tokens.`); continue
        }
        if (!retryRateLimit && !retryTransient) { onStatus?.(`${failure.message} Falling back without another identical request.`); throw failure }
        const wait = failure.category === 'RATE_LIMITED' ? Math.max(1000, failure.retryAfterMs) : Math.max(failure.retryAfterMs, 1000 + Math.floor(Math.random() * 250))
        onStatus?.(`${failure.message} Waiting once before fallback.`); await abortableDelay(wait, root.signal)
        if (failure.category === 'RATE_LIMITED') this.queue(connection).cooldownUntil = 0
        else if (!this.isProviderAvailable(connection)) throw failure
      }
      throw finalFailure ?? new Error('Provider attempt limit reached.')
    } catch (error) {
      const cancelled = signal.aborted || (error instanceof ProviderFailure && error.category === 'CANCELLED'), failure = error instanceof ProviderFailure ? error : cancelled ? new ProviderFailure('Provider request was cancelled.', 'cancelled', false, 0, 0, undefined, 'CANCELLED') : finalFailure
      metric(cancelled ? 'cancelled' : 'failed', failure); throw error
    } finally { clearTimeout(overall); signal.removeEventListener('abort', parentAbort) }
  }
}
export { estimateTokens }
