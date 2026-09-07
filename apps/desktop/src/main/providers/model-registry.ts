import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { CapabilityRequirement, ModelCapabilities, ProviderRuntimeConnection, ModelProvider, ProviderMessage, ProviderCompletion } from './model-provider'
import { ProviderFailure } from './request-manager'
import type { ProviderErrorCategory } from '../../shared/provider-errors'

export type ModelHealthState = 'UNKNOWN' | 'HEALTHY' | 'DEGRADED' | 'UNAVAILABLE' | 'INCOMPATIBLE'
export type ModelRecord = ModelCapabilities & {
  id: string
  provider: string
  baseUrl: string
  displayName: string
  available: boolean | null
  health: ModelHealthState
  lastErrorCategory: ProviderErrorCategory | null
  lastCheckedAt: string | null
  roleHistory: Record<string, { accepted: number; failed: number; durationMs: number }>
  recommendedFirstTokenMs: number
  concurrency: number
}
const unknownCapabilities = (): ModelCapabilities => ({ supportsChat: null, supportsStreaming: null, supportsTools: null, supportsParallelTools: null, supportsVision: null, supportsJSON: null, supportsReasoning: null, contextWindow: null, maxOutput: null })

export class ModelRegistry {
  private records: Record<string, ModelRecord> = {}
  constructor(private readonly path: string) { try { if (existsSync(path)) this.records = JSON.parse(readFileSync(path, 'utf8')) as Record<string, ModelRecord> } catch { this.records = {} } }
  key(connection: ProviderRuntimeConnection): string { return `${connection.providerId}:${connection.baseUrl}:${connection.model}` }
  private save(): void { mkdirSync(dirname(this.path), { recursive: true }); writeFileSync(this.path, JSON.stringify(this.records), { mode: 0o600 }) }
  record(connection: ProviderRuntimeConnection): ModelRecord {
    const key = this.key(connection), old = this.records[key] as (Partial<ModelRecord> & { streaming?: boolean | null; tools?: boolean | null; vision?: boolean | null; structuredOutput?: boolean | null; reasoning?: boolean | null }) | undefined
    if (old) {
      const migrated: ModelRecord = { ...unknownCapabilities(), id: connection.model, provider: connection.providerId, displayName: connection.model, available: null, health: 'UNKNOWN', lastErrorCategory: null, lastCheckedAt: null, roleHistory: {}, recommendedFirstTokenMs: connection.requestPolicy?.firstTokenMs ?? 180000, concurrency: connection.requestPolicy?.concurrency ?? 1, ...old, baseUrl: connection.baseUrl,
        supportsStreaming: old.supportsStreaming ?? old.streaming ?? null, supportsTools: old.supportsTools ?? old.tools ?? null, supportsVision: old.supportsVision ?? old.vision ?? null, supportsJSON: old.supportsJSON ?? old.structuredOutput ?? null, supportsReasoning: old.supportsReasoning ?? old.reasoning ?? null }
      this.records[key] = migrated; return migrated
    }
    return this.records[key] = { ...unknownCapabilities(), id: connection.model, provider: connection.providerId, baseUrl: connection.baseUrl, displayName: connection.model, available: null, health: 'UNKNOWN', lastErrorCategory: null, lastCheckedAt: null, roleHistory: {}, recommendedFirstTokenMs: connection.requestPolicy?.firstTokenMs ?? 180000, concurrency: connection.requestPolicy?.concurrency ?? 1 }
  }
  observeCapabilities(connection: ProviderRuntimeConnection, capabilities: Partial<ModelCapabilities>): void { const record = this.record(connection); Object.assign(record, capabilities); record.lastCheckedAt = new Date().toISOString(); if (capabilities.supportsChat) { record.available = true; record.health = 'HEALTHY'; record.lastErrorCategory = null } this.save() }
  observe(connection: ProviderRuntimeConnection, role: string, accepted: boolean, durationMs: number, usedTools = false): void {
    const record = this.record(connection), history = record.roleHistory[role] ??= { accepted: 0, failed: 0, durationMs: 0 }; history[accepted ? 'accepted' : 'failed']++; history.durationMs += durationMs; record.lastCheckedAt = new Date().toISOString()
    if (accepted) { record.available = true; record.supportsChat = true; if (usedTools) record.supportsTools = true; record.health = 'HEALTHY'; record.lastErrorCategory = null }
    else if (record.health === 'HEALTHY') record.health = 'DEGRADED'
    this.save()
  }
  observeFailure(connection: ProviderRuntimeConnection, category: ProviderErrorCategory): void {
    const record = this.record(connection); record.lastCheckedAt = new Date().toISOString(); record.lastErrorCategory = category
    if (category === 'MODEL_NOT_FOUND' || category === 'MODEL_UNAVAILABLE') { record.available = false; record.health = 'UNAVAILABLE' }
    else if (category === 'TOOLS_UNSUPPORTED') { record.supportsTools = false; record.health = 'INCOMPATIBLE' }
    else if (category === 'BAD_REQUEST') record.health = 'DEGRADED'
    this.save()
  }
  markDiscovered(connection: ProviderRuntimeConnection): void { const record = this.record(connection); if (record.available === false && ['MODEL_NOT_FOUND', 'MODEL_UNAVAILABLE'].includes(record.lastErrorCategory ?? '')) { record.available = null; record.health = 'UNKNOWN' } this.save() }
  meets(record: ModelRecord, requirement: CapabilityRequirement, unknownAllowed = false): boolean {
    const check = (required: boolean | undefined, actual: boolean | null) => !required || actual === true || (unknownAllowed && actual === null)
    return record.available !== false && check(requirement.chat, record.supportsChat) && check(requirement.streaming, record.supportsStreaming) && check(requirement.tools, record.supportsTools) && check(requirement.vision, record.supportsVision) && check(requirement.json, record.supportsJSON) && (!requirement.adequateContext || record.contextWindow === null || record.contextWindow >= requirement.adequateContext)
  }
  rank(connections: ProviderRuntimeConnection[], role: string, requirement: CapabilityRequirement, provider: ModelProvider): ProviderRuntimeConnection[] {
    return connections.filter(connection => this.meets(this.record(connection), requirement, true) && (provider.providerHealth?.(connection).state ?? 'HEALTHY') !== 'QUOTA_EXHAUSTED' && !['RATE_LIMITED', 'OFFLINE'].includes(provider.providerHealth?.(connection).state ?? 'HEALTHY')).map((connection, index) => {
      const record = this.record(connection), history = record.roleHistory[role], providerState = provider.providerHealth?.(connection), success = history ? (history.accepted + 1) / (history.accepted + history.failed + 2) : .5, load = (providerState?.active ?? 0) + (providerState?.queued ?? 0)
      return { connection, index, score: success * 100 - load * 25 - (record.health === 'DEGRADED' ? 20 : 0) }
    }).sort((a, b) => b.score - a.score || a.index - b.index).map(item => item.connection)
  }
  list(): ModelRecord[] { return Object.values(this.records) }
}

export class RoleRouter {
  constructor(readonly provider: ModelProvider, readonly connections: ProviderRuntimeConnection[], readonly registry: ModelRegistry) {}
  candidates(role: string, requirement: CapabilityRequirement = {}): ProviderRuntimeConnection[] { return this.registry.rank(this.connections, role, requirement, this.provider) }
  private boundedCandidates(role: string, requirement: CapabilityRequirement): ProviderRuntimeConnection[] {
    const perProvider = new Map<string, number>()
    return this.candidates(role, requirement).filter(connection => {
      const key = `${connection.providerId}:${connection.baseUrl}`, count = perProvider.get(key) ?? 0
      if (count >= 3) return false
      perProvider.set(key, count + 1); return true
    }).slice(0, 12)
  }
  async complete(role: string, messages: ProviderMessage[], tools: readonly unknown[], signal: AbortSignal, status: (text: string) => void, prefer?: string, extraRequirement: CapabilityRequirement = {}): Promise<{ completion: ProviderCompletion; connection: ProviderRuntimeConnection }> {
    const requirement: CapabilityRequirement = { chat: true, tools: tools.length > 0, ...extraRequirement }
    let candidates = this.boundedCandidates(role, requirement)
    if (prefer) candidates = [...candidates.filter(c => this.registry.key(c) === prefer), ...candidates.filter(c => this.registry.key(c) !== prefer)]
    let failure: unknown = new Error('No configured model meets the required capabilities.')
    let previous: ProviderRuntimeConnection | undefined
    for (const connection of candidates) {
      signal.throwIfAborted()
      if (!this.provider.providerHealth?.(connection) || ['HEALTHY', 'DEGRADED'].includes(this.provider.providerHealth(connection).state)) {
        const record = this.registry.record(connection)
        if (!this.registry.meets(record, requirement) && this.provider.probeCapabilities) {
          try { this.registry.observeCapabilities(connection, await this.provider.probeCapabilities(connection, requirement, signal)) }
          catch (error) { failure = error; if (error instanceof ProviderFailure) this.registry.observeFailure(connection, error.category); continue }
        } else if (requirement.tools && record.supportsTools === null && this.provider.probeCapabilities) {
          try { this.registry.observeCapabilities(connection, await this.provider.probeCapabilities(connection, requirement, signal)) }
          catch (error) { failure = error; if (error instanceof ProviderFailure) this.registry.observeFailure(connection, error.category); continue }
        }
        if (!this.registry.meets(this.registry.record(connection), requirement, !this.provider.probeCapabilities)) continue
        if (previous) this.provider.recordFallback?.(previous, connection)
        const started = Date.now()
        try {
          const continuation = previous ? [...messages, { role: 'system' as const, content: `TASK CONTINUATION: ${previous.providerId}/${previous.model} failed. Preserve completed tool results and file changes already recorded in this conversation. Continue the remaining objective; do not restart completed work.` }] : messages
          const completion = await this.provider.complete({ connection, messages: continuation, tools, signal, onStatus: status })
          this.registry.observe(connection, role, true, Date.now() - started, completion.toolCalls.length > 0); return { completion, connection }
        } catch (error) {
          failure = error; this.registry.observe(connection, role, false, Date.now() - started)
          if (error instanceof ProviderFailure) this.registry.observeFailure(connection, error.category)
          if (signal.aborted || (error instanceof ProviderFailure && error.category === 'CANCELLED')) throw error
          previous = connection
          const remaining = candidates.find(candidate => candidate !== connection && (!this.provider.providerHealth || ['HEALTHY', 'DEGRADED'].includes(this.provider.providerHealth(candidate).state)))
          if (remaining) status(`${connection.providerId} / ${connection.model} unavailable (${error instanceof ProviderFailure ? error.category : 'UNKNOWN'}). Switching to ${remaining.providerId} / ${remaining.model}.`)
        }
      }
    }
    throw failure
  }
  async stream(role: string, messages: ProviderMessage[], signal: AbortSignal, status: (text: string) => void, onDelta: (delta: string) => void, extraRequirement: CapabilityRequirement = {}): Promise<ProviderRuntimeConnection> {
    const requirement: CapabilityRequirement = { chat: true, streaming: true, ...extraRequirement }
    const candidates = this.boundedCandidates(role, requirement)
    let failure: unknown = new Error('No configured model supports streaming for this request.'), previous: ProviderRuntimeConnection | undefined
    for (const connection of candidates) {
      signal.throwIfAborted(); const record = this.registry.record(connection)
      if ((!this.registry.meets(record, requirement) || record.supportsStreaming === null) && this.provider.probeCapabilities) {
        try { this.registry.observeCapabilities(connection, await this.provider.probeCapabilities(connection, requirement, signal)) }
        catch (error) { failure = error; if (error instanceof ProviderFailure) this.registry.observeFailure(connection, error.category); continue }
      }
      if (!this.registry.meets(this.registry.record(connection), requirement, !this.provider.probeCapabilities)) continue
      if (previous) this.provider.recordFallback?.(previous, connection)
      let received = false; const started = Date.now()
      try {
        await this.provider.stream({ connection, messages: previous ? [...messages, { role: 'system', content: 'Continue the requested answer after the previous provider failed before returning any text.' }] : messages, signal, onStatus: status, onDelta: delta => { received = true; onDelta(delta) } })
        this.registry.observe(connection, role, true, Date.now() - started); this.registry.observeCapabilities(connection, { supportsChat: true, supportsStreaming: true }); return connection
      } catch (error) {
        failure = error; this.registry.observe(connection, role, false, Date.now() - started); if (error instanceof ProviderFailure) this.registry.observeFailure(connection, error.category)
        if (received || signal.aborted || (error instanceof ProviderFailure && error.category === 'CANCELLED')) throw error
        previous = connection
        const next = candidates.find(candidate => candidate !== connection && (!this.provider.providerHealth || ['HEALTHY', 'DEGRADED'].includes(this.provider.providerHealth(candidate).state)))
        if (next) status(`${connection.providerId} / ${connection.model} unavailable. Switching to ${next.providerId} / ${next.model}.`)
      }
    }
    throw failure
  }
}
