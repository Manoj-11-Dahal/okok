import { nativeImage, safeStorage } from 'electron'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { requestPolicy } from '../shared/request-policy'
import type { RequestPolicy } from '../shared/request-policy'
import { Director } from './multi-ai/director'
import { RunStore } from './multi-ai/state-store'
import { ModelRegistry, RoleRouter } from './providers/model-registry'
import { runProjectCommand } from './project-command-runner'
import { buildRepositoryContext as buildRepositoryContextForCheck } from './repository-context'
import {
  providerPresets,
  type ChatMessage,
  type ChatRequest,
  type ChatStreamEvent,
  type ProviderConnectionInput,
  type ProviderId,
  type ProviderProfileStatus,
  type ProviderStatus,
  type ProviderTestResult,
} from '../shared/desktop-api'
import { normalizeProviderBaseUrl } from '../shared/provider-protocol'
import { selectCodingModelCandidates } from '../shared/model-router'
import type { ProviderMessage, ProviderRuntimeConnection } from './providers/model-provider'
import { OpenAiCompatibleProvider } from './providers/openai-compatible'
import { CodexCliAgent } from './codex-cli-agent'
import { runCodingAgent } from './agent-runner'
import type { ResolvedAttachment } from './attachment-service'
import type { ProviderContentPart } from './providers/model-provider'
import { pullLocalModel, unloadLocalModel } from './local-ai-service'
import { ProviderFailure } from './providers/request-manager'
import type { ProviderErrorCategory } from '../shared/provider-errors'
import { providerDefinition } from '../shared/provider-registry'
import { isApprovedLocalModel, isApprovedLocalVisionModel, recommendedLocalVisionModel } from '../shared/local-ai'

type StoredProvider = {
  version: 1 | 2
  providerId: ProviderId
  baseUrl: string
  model: string
  encryptedApiKey: string
  additionalFields?: Record<string, string>
  verification?: {
    ok: boolean
    category: ProviderErrorCategory | null
    message: string
    testedAt: string
  }
  requestPolicy?: Partial<RequestPolicy>
}

type CachedCatalog = { providerId: ProviderId; baseUrl: string; models: string[]; fetchedAt: string; errorCategory: ProviderErrorCategory | null }

function providerName(providerId: ProviderId): string {
  return providerPresets.find((provider) => provider.id === providerId)?.displayName ?? 'OpenAI-compatible'
}

function validateConnection(input: ProviderConnectionInput): ProviderConnectionInput {
  const apiKey = input.apiKey.trim()
  const model = input.model.trim()
  if (!providerPresets.some((provider) => provider.id === input.providerId)) throw new Error('Unsupported provider.')
  const definition = providerDefinition(input.providerId)
  if (definition.requiresApiKey && (apiKey.length < 8 || apiKey.length > 4096)) throw new Error(`Enter a valid ${input.providerId === 'cloudflare' ? 'API token' : 'API key'}.`)
  if (!definition.requiresApiKey && apiKey.length > 4096) throw new Error('The optional API key is too long.')
  if (model.length > 200) throw new Error('Enter a valid model ID.')
  const additionalFields = Object.fromEntries(Object.entries(input.additionalFields ?? {}).map(([key, value]) => [key, value.trim()]))
  if (input.providerId === 'cloudflare') {
    const accountId = additionalFields.accountId ?? ''
    if (accountId.length < 4 || accountId.length > 128 || !/^[a-zA-Z0-9_-]+$/.test(accountId)) throw new Error('Enter your Cloudflare Account ID.')
  }
  const configuredBaseUrl = input.providerId === 'custom'
    ? normalizeProviderBaseUrl(input.baseUrl)
    : normalizeProviderBaseUrl(definition.baseUrl.replace('{accountId}', encodeURIComponent(additionalFields.accountId ?? '')))
  return { ...input, apiKey, model, additionalFields, baseUrl: configuredBaseUrl, requestPolicy: requestPolicy(input.providerId, input.requestPolicy) }
}

function emptyStatus(): ProviderStatus {
  return { connected: false, providerId: null, displayName: null, baseUrl: null, model: null }
}

function secureStorageAvailable(): boolean {
  if (!safeStorage.isEncryptionAvailable()) return false
  return process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text'
}

export class ProviderService {
  private readonly activeRequests = new Map<string, AbortController>()
  private readonly provider = new OpenAiCompatibleProvider()
  private readonly codexAgent = new CodexCliAgent()
  private readonly directors = new Map<string, Director>()
  readonly runs: RunStore
  readonly models: ModelRegistry
  private readonly catalogPath: string

  constructor(private readonly credentialPath: string, stateRoot = join(dirname(dirname(credentialPath)), 'multi-ai'), modelStateRoot = stateRoot) {
    this.runs = new RunStore(stateRoot)
    this.runs.recover()
    this.models = new ModelRegistry(join(modelStateRoot, 'models.json'))
    this.catalogPath = join(modelStateRoot, 'provider-models.json')
  }
  revise(requestId: string, text: string): void { const director = this.directors.get(requestId); if (!director) throw new Error('No active Multi-AI run.'); director.revise(text) }
  private profiles(): StoredProvider[] { try { const profiles = JSON.parse(readFileSync(`${this.credentialPath}.profiles`, 'utf8')) as StoredProvider[]; return profiles.filter(p => (p.version === 1 || p.version === 2) && typeof p.encryptedApiKey === 'string' && providerPresets.some(preset => preset.id === p.providerId)) } catch { const active = this.readStoredProvider(); return active ? [active] : [] } }
  private profileVerified(profile: StoredProvider): boolean {
    if (profile.verification?.ok === true) return true
    return this.models.list().some(record => record.provider === profile.providerId && record.baseUrl === profile.baseUrl && record.supportsChat === true && record.available === true)
  }
  private usableProfiles(): StoredProvider[] { return this.profiles().filter(profile => this.profileVerified(profile) && this.provider.requests.isProviderAvailable(profile)) }
  private profileFor(providerId: ProviderId): StoredProvider | undefined { return this.profiles().find(profile => profile.providerId === providerId) }
  private writeProfiles(profiles: StoredProvider[], active = profiles[0] ?? null): void {
    mkdirSync(dirname(this.credentialPath), { recursive: true })
    if (!active) {
      if (existsSync(this.credentialPath)) unlinkSync(this.credentialPath)
      if (existsSync(`${this.credentialPath}.profiles`)) unlinkSync(`${this.credentialPath}.profiles`)
      return
    }
    writeFileSync(`${this.credentialPath}.tmp`, JSON.stringify(active), { encoding: 'utf8', mode: 0o600 })
    renameSync(`${this.credentialPath}.tmp`, this.credentialPath)
    writeFileSync(`${this.credentialPath}.profiles.tmp`, JSON.stringify(profiles), { encoding: 'utf8', mode: 0o600 })
    renameSync(`${this.credentialPath}.profiles.tmp`, `${this.credentialPath}.profiles`)
  }
  private persistVerification(target: StoredProvider, result: ProviderTestResult): void {
    const verification = { ok: result.ok, category: result.errorCategory ?? null, message: result.message, testedAt: new Date().toISOString() }
    const updated = this.profiles().map(profile => profile.providerId === target.providerId && profile.baseUrl === target.baseUrl ? { ...profile, verification, ...(result.resolvedModel ? { model: result.resolvedModel } : {}) } : profile)
    const active = this.readStoredProvider()
    this.writeProfiles(updated, updated.find(profile => profile.providerId === active?.providerId && profile.baseUrl === active.baseUrl) ?? updated[0])
  }
  private inputWithSavedCredential(input: ProviderConnectionInput): ProviderConnectionInput {
    if (input.apiKey.trim() || !providerDefinition(input.providerId).requiresApiKey) return input
    const saved = this.profileFor(input.providerId)
    if (!saved) return input
    return { ...input, apiKey: this.decryptApiKey(saved), additionalFields: { ...saved.additionalFields, ...input.additionalFields } }
  }
  private catalogKey(provider: Pick<StoredProvider, 'providerId' | 'baseUrl'>): string { return `${provider.providerId}:${provider.baseUrl}` }
  private catalogs(): Record<string, CachedCatalog> { try { return JSON.parse(readFileSync(this.catalogPath, 'utf8')) as Record<string, CachedCatalog> } catch { return {} } }
  private writeCatalogs(catalogs: Record<string, CachedCatalog>): void { mkdirSync(dirname(this.catalogPath), { recursive: true }); writeFileSync(this.catalogPath, JSON.stringify(catalogs), { mode: 0o600 }) }
  private async discoverModels(profile: StoredProvider, force = false): Promise<string[]> {
    const catalogs = this.catalogs(), key = this.catalogKey(profile), cached = catalogs[key]
    if (!force && cached && Date.now() - Date.parse(cached.fetchedAt) < 10 * 60_000 && cached.models.length) return cached.models
    const connection = this.runtimeConnection(profile, profile.model)
    try {
      const models = await this.provider.listModels(connection)
      const catalog: CachedCatalog = { providerId: profile.providerId, baseUrl: profile.baseUrl, models, fetchedAt: new Date().toISOString(), errorCategory: null }
      catalogs[key] = catalog; this.writeCatalogs(catalogs)
      for (const model of models) this.models.markDiscovered({ ...connection, model })
      return models
    } catch (error) {
      catalogs[key] = { providerId: profile.providerId, baseUrl: profile.baseUrl, models: cached?.models ?? [], fetchedAt: new Date().toISOString(), errorCategory: error instanceof ProviderFailure ? error.category : 'CONNECTION_ERROR' }
      this.writeCatalogs(catalogs); throw error
    }
  }
  async testConfigured() {
    const results: Array<{ provider: ProviderId; model: string; ok: boolean; message: string; latencyMs: number; modelsDiscovered: number; chat: boolean; streaming: boolean; tools: boolean; errorCategory?: ProviderErrorCategory }> = []
    for (const profile of this.profiles()) {
      const connection = this.runtimeConnection(profile, profile.model)
      this.provider.resetProviderHealth(connection)
      let listed: string[]
      try { listed = await this.discoverModels(profile, true) }
      catch (error) {
        const failure = error instanceof ProviderFailure ? error : new ProviderFailure('ALTREX could not connect to the provider.', 'network', true, 0, 0, undefined, 'CONNECTION_ERROR')
        results.push({ provider: profile.providerId, model: profile.model, ok: false, message: failure.message, latencyMs: 0, modelsDiscovered: 0, chat: false, streaming: false, tools: false, errorCategory: failure.category })
        continue
      }
      const candidates = [...new Set([profile.model, ...selectCodingModelCandidates(profile.providerId, 'small coding task with tools', listed, profile.model, 3).models])].slice(0, 3)
      for (const model of candidates) {
        const candidate = { ...connection, model, requestPolicy: { ...connection.requestPolicy, inputTokens: 1024, outputTokens: 64, maxAttempts: 1 } }
        if (listed.length && !listed.includes(model)) {
          this.models.observeFailure(candidate, 'MODEL_NOT_FOUND')
          results.push({ provider: profile.providerId, model, ok: false, message: 'The configured model was not returned by the provider model catalog.', latencyMs: 0, modelsDiscovered: listed.length, chat: false, streaming: false, tools: false, errorCategory: 'MODEL_NOT_FOUND' })
          continue
        }
        const started = Date.now()
        try {
          const capabilities = await this.provider.probeCapabilities(candidate, { chat: true, streaming: true, tools: true }, AbortSignal.timeout(180000))
          this.models.observeCapabilities(candidate, capabilities)
          const chat = capabilities.supportsChat === true, streaming = capabilities.supportsStreaming === true, tools = capabilities.supportsTools === true
          results.push({ provider: profile.providerId, model, ok: chat && streaming && tools, message: chat && streaming && tools ? 'CONNECTED: basic chat, streaming, and tool calling passed.' : `Connected with limited capabilities: chat=${chat ? 'PASS' : 'FAIL'}, streaming=${streaming ? 'PASS' : 'FAIL'}, tools=${tools ? 'PASS' : 'FAIL'}.`, latencyMs: Date.now() - started, modelsDiscovered: listed.length, chat, streaming, tools, ...(!tools ? { errorCategory: 'TOOLS_UNSUPPORTED' as const } : {}) })
        } catch (error) {
          const failure = error instanceof ProviderFailure ? error : new ProviderFailure('ALTREX could not connect to the provider.', 'network', true, 0, 0, undefined, 'CONNECTION_ERROR')
          if (failure.category === 'BAD_REQUEST') this.models.observeCapabilities(candidate, { supportsChat: false, supportsStreaming: false, supportsTools: false })
          else if (failure.category === 'TOOLS_UNSUPPORTED') this.models.observeCapabilities(candidate, { supportsTools: false })
          this.models.observeFailure(candidate, failure.category)
          results.push({ provider: profile.providerId, model, ok: false, message: failure.message, latencyMs: Date.now() - started, modelsDiscovered: listed.length, chat: false, streaming: false, tools: false, errorCategory: failure.category })
          if (['QUOTA_EXHAUSTED', 'RATE_LIMITED', 'AUTH_ERROR', 'INVALID_API_KEY'].includes(failure.category)) break
        }
      }
    }
    return results
  }
  async testWorkflows() {
    const stored = this.readStoredProvider(); if (!stored) throw new Error('No saved provider to test.')
    const requestedMode = process.env.ALTREX_WORKFLOW_MODE
    if (requestedMode === 'LOCAL' && stored.providerId === 'ollama' && isApprovedLocalModel(stored.model)) {
      this.models.observeCapabilities(this.runtimeConnection(stored, stored.model), { supportsChat: true, supportsTools: true, contextWindow: 32_768 })
    } else if (!this.models.list().some(record => record.available === true && record.supportsChat === true && record.supportsTools === true)) await this.testConfigured()
    const results: Array<{ mode: string; task: string; ok: boolean; status: string; testsExitCode: number | null; message: string; fixture: string; files: string[]; providerModels: string[]; fallbacks: string[] }> = []
    const modes = requestedMode === 'AGENT' || requestedMode === 'LOCAL' || requestedMode === 'MULTI' ? [requestedMode] as const : ['AGENT', 'MULTI'] as const
    for (const mode of modes) {
      const fixture = mkdtempSync(join(tmpdir(), `altrex-live-${mode.toLowerCase()}-`)), id = randomUUID()
      const agent = mode === 'AGENT' || mode === 'LOCAL', task = agent ? 'Create a very small interactive webpage.' : 'Build a small todo web app.'
      const test = agent
        ? "const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');test('webpage',()=>{const h=fs.readFileSync('index.html','utf8');assert.match(h,/<h1[^>]*>[^<]+<\\/h1>/i);assert.match(h,/<button/i);assert.match(h,/addEventListener/);});\n"
        : "const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');test('todo app',()=>{const h=fs.readFileSync('index.html','utf8'),j=fs.readFileSync('app.js','utf8');assert.match(h,/<input/i);assert.match(h,/<button/i);assert.match(j,/addEventListener/);assert.match(j,/(todo|task)/i);});\n"
      writeFileSync(join(fixture, 'package.json'), JSON.stringify({ name: `altrex-${mode.toLowerCase()}-fixture`, private: true, scripts: { test: 'node --test acceptance.test.cjs' } }))
      writeFileSync(join(fixture, 'acceptance.test.cjs'), test)
      let status = 'not started', message = ''
      const metricStart = this.provider.requests.metrics.length, timeout = setTimeout(() => this.cancel(id), 600000)
      try {
        const prompt = agent
          ? 'Create one minimal self-contained index.html under 700 characters total. Include a visible h1, a button, and a short inline script using addEventListener to change the heading when clicked. Use at most one tiny inline style rule. Preserve package.json and acceptance.test.cjs. Run npm test. Do not add dependencies or create other files.'
          : 'Build a small todo web app using index.html, style.css, and app.js. Include an input, add button, todo list, add/delete interactions, and localStorage persistence. Use separate UI and feature work where appropriate. Preserve package.json and acceptance.test.cjs. Run npm test. Do not add dependencies.'
        await this.streamChat({ requestId: id, projectPath: fixture, mode, modelSelection: 'AUTO', attachments: [], messages: [{ role: 'user', content: prompt }] }, buildRepositoryContextForCheck(fixture), [], event => { if (['completed', 'cancelled', 'error'].includes(event.type)) { status = event.type; message = event.message ?? '' } })
        const check = await runProjectCommand({ projectRoot: fixture, command: 'node', args: ['--test', 'acceptance.test.cjs'], timeoutMs: 15000, signal: new AbortController().signal })
        const files = ['index.html', 'style.css', 'app.js'].filter(file => existsSync(join(fixture, file))), metrics = this.provider.requests.metrics.slice(metricStart)
        const requiredFilesExist = agent ? files.includes('index.html') : files.includes('index.html') && files.includes('app.js')
        results.push({ mode, task, ok: status === 'completed' && check.exitCode === 0 && requiredFilesExist, status, testsExitCode: check.exitCode, message, fixture, files, providerModels: [...new Set(metrics.map(metric => `${metric.provider}/${metric.model}`))], fallbacks: metrics.flatMap(metric => metric.fallbackDestination ? [`${metric.provider}/${metric.model} -> ${metric.fallbackDestination}`] : []) })
      } finally { clearTimeout(timeout) }
    }
    return results
  }

  getStatus(): ProviderStatus {
    const stored = this.readStoredProvider()
    if (stored === null || !secureStorageAvailable()) return emptyStatus()
    const catalogs = this.catalogs()
    const storedProfiles = this.profiles()
    const profiles: ProviderProfileStatus[] = storedProfiles.map((profile) => {
      const { providerId, model, baseUrl } = profile
      const catalog = catalogs[this.catalogKey(profile)], health = this.provider.requests.health(profile)
      const records = this.models.list().filter(record => record.provider === providerId && record.baseUrl === baseUrl && catalog?.models.includes(record.id))
      const category = health.lastCategory ?? profile.verification?.category ?? catalog?.errorCategory ?? null
      const verified = this.profileVerified(profile)
      const connectionState = health.state === 'RATE_LIMITED' ? 'RATE_LIMITED'
        : health.state === 'QUOTA_EXHAUSTED' ? 'QUOTA_EXHAUSTED'
          : category === 'RATE_LIMITED' ? 'RATE_LIMITED'
            : category === 'QUOTA_EXHAUSTED' ? 'QUOTA_EXHAUSTED'
              : category === 'INVALID_API_KEY' || category === 'AUTH_ERROR' ? 'AUTHENTICATION_FAILED'
                : category === 'MODEL_NOT_FOUND' || category === 'MODEL_UNAVAILABLE' ? 'MODEL_UNAVAILABLE'
                  : health.state === 'OFFLINE' || category === 'TIMEOUT' || category === 'CONNECTION_ERROR' || category === 'PROVIDER_SERVER_ERROR' ? 'TEMPORARILY_UNAVAILABLE'
                    : verified ? 'CONNECTED' : 'ERROR'
      let keySuffix: string | null = null
      if (providerDefinition(providerId).requiresApiKey) {
        try { keySuffix = this.decryptApiKey(profile).slice(-4) || null } catch { keySuffix = null }
      }
      return {
        providerId, displayName: providerName(providerId), model, baseUrl, health: health.state,
        modelsDiscovered: catalog?.models.length ?? 0,
        toolCompatibleModels: records.filter(record => record.supportsTools === true && record.available !== false).length,
        lastErrorCategory: category,
        lastCheckedAt: profile.verification?.testedAt ?? catalog?.fetchedAt ?? null,
        connectionState,
        keySuffix,
        statusMessage: profile.verification?.message ?? null,
        additionalFields: profile.additionalFields ?? {},
      }
    })
    const connected = profiles.some(profile => profile.connectionState === 'CONNECTED')
    const primaryStatus = profiles.find(profile => profile.providerId === stored.providerId && profile.baseUrl === stored.baseUrl && profile.connectionState === 'CONNECTED')
      ?? profiles.find(profile => profile.connectionState === 'CONNECTED')
      ?? profiles.find(profile => profile.providerId === stored.providerId && profile.baseUrl === stored.baseUrl)
    const primary = primaryStatus ? storedProfiles.find(profile => profile.providerId === primaryStatus.providerId && profile.baseUrl === primaryStatus.baseUrl) ?? stored : stored
    return {
      connected,
      providerId: primary.providerId,
      displayName: providerName(primary.providerId),
      baseUrl: primary.baseUrl,
      model: primary.model,
      profiles,
    }
  }

  async test(input: ProviderConnectionInput): Promise<ProviderTestResult> {
    const savedProfile = this.profileFor(input.providerId)
    const usingSavedCredential = providerDefinition(input.providerId).requiresApiKey && !input.apiKey.trim() && savedProfile !== undefined
    const finish = (result: ProviderTestResult): ProviderTestResult => {
      if (usingSavedCredential && savedProfile) this.persistVerification(savedProfile, result)
      return result
    }
    let connection: ProviderConnectionInput
    try {
      connection = validateConnection(this.inputWithSavedCredential(input))
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'Invalid provider settings.', latencyMs: 0, failureKind: 'invalid-request' }
    }

    this.provider.resetProviderHealth(connection)
    let discovered: string[] = []
    try {
      discovered = await this.provider.listModels(connection)
      if (discovered.length) {
        const catalogs = this.catalogs()
        catalogs[this.catalogKey(connection)] = { providerId: connection.providerId, baseUrl: connection.baseUrl, models: discovered, fetchedAt: new Date().toISOString(), errorCategory: null }
        this.writeCatalogs(catalogs)
        for (const model of discovered) this.models.markDiscovered({ ...connection, model })
      }
    } catch (error) {
      if (error instanceof ProviderFailure && ['INVALID_API_KEY', 'AUTH_ERROR', 'QUOTA_EXHAUSTED', 'RATE_LIMITED'].includes(error.category)) return finish({ ok: false, message: error.message, latencyMs: 0, failureKind: error.kind, errorCategory: error.category, modelsDiscovered: 0 })
      // Some OpenAI-compatible servers omit /models; the tiny generation below remains authoritative.
    }
    if (discovered.length && (!connection.model || !discovered.includes(connection.model))) {
      connection = { ...connection, model: selectCodingModelCandidates(connection.providerId, 'small coding task', discovered, discovered[0]!, 1).models[0] ?? discovered[0]! }
    }
    if (!connection.model || (connection.providerId === 'ollama' && discovered.length === 0)) return finish({ ok: false, message: connection.providerId === 'ollama' ? 'Ollama is running, but no local models are installed.' : 'No usable model was discovered.', latencyMs: 0, failureKind: 'model-unavailable', errorCategory: 'MODEL_UNAVAILABLE', modelsDiscovered: discovered.length })
    const result = await this.provider.healthCheck(connection)
    if (result.ok) this.models.observeCapabilities(connection, { supportsChat: true })
    else if ('errorCategory' in result && result.errorCategory) {
      if (result.errorCategory === 'BAD_REQUEST') this.models.observeCapabilities(connection, { supportsChat: false })
      this.models.observeFailure(connection, result.errorCategory)
    }
    return finish({ ...result, message: result.ok ? `${providerName(connection.providerId)} is ready for ALTREX.` : result.message, resolvedModel: connection.model, modelsDiscovered: discovered.length, capabilities: { chat: result.ok, streaming: this.models.record(connection).supportsStreaming, tools: this.models.record(connection).supportsTools } })
  }

  async connect(input: ProviderConnectionInput): Promise<ProviderStatus> {
    const connection = validateConnection(this.inputWithSavedCredential(input))
    if (!secureStorageAvailable()) throw new Error('Secure credential storage is unavailable on this system.')
    const result = await this.test(connection)
    if (!result.ok && (result.failureKind === 'authentication' || result.errorCategory === 'INVALID_API_KEY' || result.errorCategory === 'AUTH_ERROR')) throw new Error(result.message)

    const stored: StoredProvider = {
      version: 2,
      providerId: connection.providerId,
      baseUrl: connection.baseUrl,
      model: result.resolvedModel ?? connection.model,
      encryptedApiKey: safeStorage.encryptString(connection.apiKey).toString('base64'),
      ...(connection.additionalFields ? { additionalFields: connection.additionalFields } : {}),
      verification: { ok: result.ok, category: result.errorCategory ?? null, message: result.message, testedAt: new Date().toISOString() },
      requestPolicy: requestPolicy(connection.providerId, connection.requestPolicy),
    }
    const profiles = [stored, ...this.profiles().filter(p => p.providerId !== stored.providerId || p.baseUrl !== stored.baseUrl)]
    this.writeProfiles(profiles, stored)
    const status = this.getStatus()
    return {
      ...status,
      warning: result.ok
        ? null
        : `Connection saved, but the selected model could not be verified: ${result.message} ALTREX AUTO will try available models when you start a task.`,
    }
  }

  disconnect(providerId?: ProviderId): ProviderStatus {
    if (providerId) {
      const remaining = this.profiles().filter(profile => profile.providerId !== providerId)
      if (remaining.length) {
        this.writeProfiles(remaining)
      } else this.writeProfiles([])
    } else {
      if (existsSync(this.credentialPath)) unlinkSync(this.credentialPath)
      if (existsSync(`${this.credentialPath}.profiles`)) unlinkSync(`${this.credentialPath}.profiles`)
    }
    for (const controller of this.activeRequests.values()) controller.abort()
    this.activeRequests.clear()
    return providerId ? this.getStatus() : emptyStatus()
  }

  async installLocalModel(modelId: string): Promise<ProviderStatus> {
    await pullLocalModel(modelId)
    if (isApprovedLocalVisionModel(modelId)) {
      const profile = this.profileFor('ollama')
      if (!profile) throw new Error('Install and connect the recommended local coding model first.')
      const discovered = await this.discoverModels(profile, true)
      if (!discovered.includes(modelId)) throw new Error('Ollama finished downloading the vision model, but did not list it as installed.')
      const connection = this.runtimeConnection(profile, modelId)
      const result = await this.provider.healthCheck(connection)
      if (!result.ok) throw new Error(result.message)
      this.models.observeCapabilities(connection, { supportsChat: true, supportsVision: true, supportsTools: false, contextWindow: 125_000 })
      await unloadLocalModel(modelId).catch(() => undefined)
      return this.getStatus()
    }
    return this.connect({
      providerId: 'ollama',
      apiKey: '',
      baseUrl: providerDefinition('ollama').baseUrl,
      model: modelId,
      requestPolicy: requestPolicy('ollama'),
    })
  }

  private async describeLocalImages(profile: StoredProvider, attachments: ResolvedAttachment[], userPrompt: string, signal: AbortSignal, emit: (event: ChatStreamEvent) => void): Promise<ResolvedAttachment[]> {
    const images = attachments.filter(attachment => attachment.kind === 'image' && attachment.imageDataUrl)
    if (!images.length) return attachments
    const available = await this.discoverModels(profile)
    if (!available.includes(recommendedLocalVisionModel.id)) {
      throw new Error(`Local image understanding is not installed. Open Provider settings and install ${recommendedLocalVisionModel.name}.`)
    }

    const baseConnection = this.runtimeConnection(profile, recommendedLocalVisionModel.id)
    const connection = {
      ...baseConnection,
      requestPolicy: { ...baseConnection.requestPolicy, outputTokens: 768, maxAttempts: 1 },
    }
    this.models.observeCapabilities(connection, { supportsChat: true, supportsVision: true, supportsTools: false, contextWindow: 125_000 })
    const descriptions = new Map<string, string>()
    try {
      for (const image of images) {
        signal.throwIfAborted()
        emit({ requestId: '', type: 'activity', model: recommendedLocalVisionModel.id, message: `Reading ${image.name} with Local Vision` })
        const completion = await this.provider.complete({
          connection,
          messages: [
            { role: 'system', content: 'You are the visual inspection stage for a software coding agent. Describe the supplied image accurately and concretely. Transcribe visible text and errors, identify interface layout, colors, controls, spacing, and state. Focus on evidence the coding agent can act on. Do not invent hidden behavior.' },
            { role: 'user', content: [
              { type: 'text', text: `User request: ${userPrompt}\nAnalyze ${image.name} in detail for the coding agent.` },
              { type: 'image_url', image_url: { url: this.prepareLocalVisionImage(image.imageDataUrl!), detail: 'auto' } },
            ] },
          ],
          tools: [],
          signal,
        })
        if (!completion.content.trim()) throw new Error(`${recommendedLocalVisionModel.name} returned no image description.`)
        descriptions.set(image.id, completion.content.trim())
      }
    } finally {
      await unloadLocalModel(recommendedLocalVisionModel.id).catch(() => undefined)
    }

    return attachments.map(attachment => {
      const description = descriptions.get(attachment.id)
      if (!description) return attachment
      const { imageDataUrl: _imageDataUrl, ...withoutImage } = attachment
      return { ...withoutImage, textContent: `<local_vision_analysis>\n${description}\n</local_vision_analysis>` }
    })
  }

  private prepareLocalVisionImage(dataUrl: string): string {
    const source = nativeImage.createFromDataURL(dataUrl)
    if (source.isEmpty()) return dataUrl
    const { width, height } = source.getSize()
    const longestEdge = Math.max(width, height)
    if (longestEdge <= 1536) return dataUrl
    const scale = 1536 / longestEdge
    return source.resize({
      width: Math.max(1, Math.round(width * scale)),
      height: Math.max(1, Math.round(height * scale)),
      quality: 'best',
    }).toDataURL()
  }

  cancel(requestId: string): void {
    this.activeRequests.get(requestId)?.abort()
  }
  async stopAll(): Promise<void> { for (const controller of this.activeRequests.values()) controller.abort(); const deadline = Date.now() + 5000; while (this.activeRequests.size && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25)) }

  getCodexRuntimeInfo() {
    return this.codexAgent.getRuntimeInfo()
  }

  async getModels(providerId?: ProviderId): Promise<string[]> {
    const active = this.readStoredProvider()
    const stored = providerId ? this.profileFor(providerId) ?? null : active && this.profileVerified(active) ? active : this.usableProfiles()[0] ?? active
    if (stored === null) return []
    try {
      return await this.discoverModels(stored)
    } catch {
      const cached = this.catalogs()[this.catalogKey(stored)]?.models ?? []
      return cached.length ? cached : [stored.model]
    }
  }

  private async routedConnections(prompt: string, selection: string, providerFilter?: ProviderId): Promise<ProviderRuntimeConnection[]> {
    const usable = this.usableProfiles().filter(profile => providerFilter === undefined || profile.providerId === providerFilter), activeStored = this.readStoredProvider(), active = activeStored && usable.find(profile => profile.providerId === activeStored.providerId && profile.baseUrl === activeStored.baseUrl) || usable[0] || null
    const profiles = selection === 'AUTO' ? usable : active ? [active] : []
    const connections: ProviderRuntimeConnection[] = []
    for (const profile of profiles) {
      const base = this.runtimeConnection(profile, profile.model)
      if (profile.providerId === 'ollama' && isApprovedLocalModel(profile.model)) {
        this.models.observeCapabilities(base, { supportsChat: true, supportsTools: true, contextWindow: 32_768 })
      }
      if (!this.provider.requests.isProviderAvailable(base)) continue
      let available: string[] = []
      try { available = await this.discoverModels(profile) } catch { available = this.catalogs()[this.catalogKey(profile)]?.models ?? [] }
      const verified = this.models.list().filter(record => record.provider === profile.providerId && record.baseUrl === profile.baseUrl && record.available === true && record.supportsChat === true && record.health !== 'UNAVAILABLE').sort((a, b) => Number(b.supportsTools === true) - Number(a.supportsTools === true)).map(record => record.id)
      const selected = selection === 'AUTO'
        ? [...new Set([...verified, ...selectCodingModelCandidates(profile.providerId, prompt, available, profile.model, 4).models])].filter(model => !available.length || available.includes(model)).slice(0, 4)
        : [selection]
      for (const model of [...new Set(selected.length ? selected : [profile.model])]) {
        const candidate = { ...base, model, ...(!base.requestPolicy && /:free\b/.test(model) ? { requestPolicy: { outputTokens: 4096 } } : {}) }; this.models.record(candidate); connections.push(candidate)
      }
    }
    return [...new Map(connections.map(connection => [this.models.key(connection), connection])).values()]
  }

  async refreshModels(): Promise<ProviderStatus> {
    for (const profile of this.profiles()) {
      try { await this.discoverModels(profile, true); this.provider.resetProviderHealth(this.runtimeConnection(profile, profile.model)) } catch { /* Status retains the real refresh error. */ }
    }
    return this.getStatus()
  }

  diagnostics() { return this.provider.requests.metrics.slice(-200).reverse() }

  async streamChat(
    request: ChatRequest,
    repositoryContext: string,
    attachments: ResolvedAttachment[],
    emit: (event: ChatStreamEvent) => void,
  ): Promise<void> {
    if (this.activeRequests.has(request.requestId)) throw new Error('A request with this ID is already active.')
    const controller = new AbortController()
    this.activeRequests.set(request.requestId, controller)

    try {
      const activeStored = this.readStoredProvider()
      const usableForMode = this.usableProfiles().filter(profile => request.mode !== 'LOCAL' || profile.providerId === 'ollama')
      const stored = activeStored && usableForMode.some(profile => profile.providerId === activeStored.providerId && profile.baseUrl === activeStored.baseUrl) && this.profileVerified(activeStored) && this.provider.requests.isProviderAvailable(activeStored)
        ? activeStored
        : usableForMode[0] ?? null
      const selection = request.modelSelection.trim() || 'AUTO'
      const useCodex = request.mode !== 'LOCAL' && (selection === 'CODEX'
        || (selection === 'AUTO' && stored === null && this.codexAgent.getRuntimeInfo().available)
      )

      if (request.mode === 'MULTI') {
        if (!request.projectPath) throw new Error('Open a project folder for Multi-AI.')
        if (attachments.some(attachment => attachment.kind === 'image')) throw new Error('Multi-AI currently accepts text and source attachments. Use Agent mode to work from images.')
        if (!stored || selection === 'CODEX') throw new Error('Multi-AI requires a connected OpenAI-compatible provider with tool calling. Codex remains available in Agent mode.')
        const connections = await this.routedConnections(request.messages.at(-1)?.content ?? '', selection)
        if (!connections.length) throw new Error('No configured provider is currently healthy. Test or refresh a provider to reset its session state.')
        controller.signal.throwIfAborted()
        const userRequest = request.messages.filter(m => m.role === 'user').map(m => m.content).join('\n\n')
        const attachmentContext = attachments.map(a => `<attachment name="${a.name}">${a.textContent?.slice(0, 12000) ?? (a.kind === 'image' ? '[Image attachment: use Agent mode for visual input.]' : '[No extractable text]')}</attachment>`).join('\n')
        const director = new Director(this.runs, new RoleRouter(this.provider, connections, this.models), controller.signal, run => emit({ requestId: request.requestId, type: 'run-state', run }), { id: request.requestId, projectPath: request.projectPath, request: `${userRequest}${attachmentContext ? `\n${attachmentContext}` : ''}` })
        this.directors.set(request.requestId, director)
        emit({ requestId: request.requestId, type: 'started', provider: 'ALTREX Director', model: selection === 'AUTO' ? 'AUTO · per task' : selection })
        const run = await director.execute(request.resumeRunId)
        this.directors.delete(request.requestId)
        if (run.status === 'COMPLETED') {
          emit({ requestId: request.requestId, type: 'files-changed', files: run.filesChanged })
          emit({ requestId: request.requestId, type: 'delta', delta: `Completed ${run.tasks.length} verified tasks and integrated ${run.filesChanged.length} files.\n\n${run.finalVerification?.summary ?? ''}` })
          emit({ requestId: request.requestId, type: 'completed' })
        } else emit({ requestId: request.requestId, type: controller.signal.aborted ? 'cancelled' : 'error', message: run.error ?? 'Run did not complete. Inspect the retained task results.' })
        return
      }

      if (request.mode === 'AGENT' && useCodex) {
        emit({ requestId: request.requestId, type: 'started', provider: 'OpenAI Codex', model: this.codexAgent.getRuntimeInfo().version ?? 'Codex CLI' })
        await this.codexAgent.run({ request, attachments, signal: controller.signal, emit })
        emit({ requestId: request.requestId, type: 'completed' })
        return
      }

      if (stored === null) {
        throw new Error(request.mode === 'LOCAL'
          ? 'Install Ollama and the recommended local coding model, then detect it in AI Providers.'
          : request.mode === 'AGENT'
          ? 'Connect NVIDIA NIM or another tool-capable provider, or select Codex.'
          : 'Connect AI to continue in Ask mode.')
      }
      const userPrompt = request.messages.filter((message) => message.role === 'user').at(-1)?.content ?? ''
      const routingPrompt = attachments.length === 0 ? userPrompt : `${userPrompt}\nAttached inputs: ${attachments.map(attachment => `${attachment.name} (${attachment.mimeType})`).join(', ')}`
      const connections = await this.routedConnections(routingPrompt, selection === 'CODEX' ? 'AUTO' : selection, request.mode === 'LOCAL' ? 'ollama' : undefined)
      if (!connections.length) throw new Error('No configured provider is currently healthy and compatible. Test or refresh provider status.')
      const router = new RoleRouter(this.provider, connections, this.models), first = connections[0]!
      emit({ requestId: request.requestId, type: 'activity', model: first.model, message: `AUTO filtered configured providers by health, model availability, and required capabilities. ${connections.length} candidate${connections.length === 1 ? '' : 's'} remain.` })
      emit({ requestId: request.requestId, type: 'started', provider: providerName(first.providerId), model: first.model })
      if (request.mode === 'AGENT' || request.mode === 'LOCAL') {
        const agentAttachments = request.mode === 'LOCAL'
          ? await this.describeLocalImages(stored, attachments, userPrompt, controller.signal, event => emit({ ...event, requestId: request.requestId }))
          : attachments
        await runCodingAgent({ provider: this.provider, connection: first, router, request, repositoryContext, attachments: agentAttachments, signal: controller.signal, emit })
        emit({ requestId: request.requestId, type: 'completed' })
        return
      }
      await router.stream('Ask', this.buildMessages(request.messages, repositoryContext, attachments), controller.signal, message => emit({ requestId: request.requestId, type: 'activity', message }), delta => emit({ requestId: request.requestId, type: 'delta', delta }), { vision: attachments.some(attachment => attachment.kind === 'image') })
      emit({ requestId: request.requestId, type: 'completed' })
    } catch (error) {
      if (controller.signal.aborted) emit({ requestId: request.requestId, type: 'cancelled' })
      else emit({ requestId: request.requestId, type: 'error', message: error instanceof Error ? error.message : 'Provider request failed.' })
    } finally {
      this.activeRequests.delete(request.requestId)
      this.directors.delete(request.requestId)
      writeFileSync(join(this.runs.root, 'request-metrics.json'), JSON.stringify(this.provider.requests.metrics), { mode: 0o600 })
    }
  }

  private buildMessages(messages: ChatMessage[], repositoryContext: string, attachments: ResolvedAttachment[]): ProviderMessage[] {
    const system = [
      'You are ALTREX, a precise software engineering assistant.',
      'Answer from the supplied repository context. Do not claim to have edited files, executed tools, or run tests.',
      'If context is insufficient, say exactly what additional file or action is needed.',
      repositoryContext.length > 0 ? `Repository context:\n${repositoryContext}` : 'No project is open. Answer without repository context.',
    ].join('\n\n')
    const boundedMessages: ProviderMessage[] = messages.map((message) => ({
      role: message.role,
      content: message.content,
    }))
    if (attachments.length > 0 && boundedMessages.length > 0) {
      let latestUserIndex = -1
      for (let index = boundedMessages.length - 1; index >= 0; index -= 1) {
        if (boundedMessages[index]?.role === 'user') {
          latestUserIndex = index
          break
        }
      }
      if (latestUserIndex >= 0) {
        const latest = boundedMessages[latestUserIndex]!
        const fileContext = attachments.map((attachment) => {
          const location = attachment.projectRelativePath === undefined ? '' : ` path="${attachment.projectRelativePath}"`
          const content = attachment.textContent === undefined ? '' : `\n<file_content>\n${attachment.textContent.slice(0, 750_000)}\n</file_content>`
          return `<attachment name="${attachment.name}" type="${attachment.mimeType}"${location}>${content}</attachment>`
        }).join('\n\n')
        const parts: ProviderContentPart[] = [{ type: 'text', text: `${latest.content}\n\n${fileContext}` }]
        for (const attachment of attachments) {
          if (attachment.imageDataUrl !== undefined) parts.push({ type: 'image_url', image_url: { url: attachment.imageDataUrl, detail: 'auto' } })
        }
        boundedMessages[latestUserIndex] = { ...latest, content: parts }
      }
    }
    return [{ role: 'system', content: system }, ...boundedMessages]
  }

  private runtimeConnection(stored: StoredProvider, model: string, apiKey = this.decryptApiKey(stored)): ProviderRuntimeConnection {
    return {
      providerId: stored.providerId,
      baseUrl: stored.baseUrl,
      model,
      apiKey,
      ...(stored.requestPolicy ? { requestPolicy: stored.requestPolicy } : {}),
    }
  }

  private readStoredProvider(): StoredProvider | null {
    if (!existsSync(this.credentialPath)) return null
    try {
      const parsed = JSON.parse(readFileSync(this.credentialPath, 'utf8')) as Partial<StoredProvider>
      if (
        (parsed.version !== 1 && parsed.version !== 2)
        || typeof parsed.providerId !== 'string'
        || typeof parsed.baseUrl !== 'string'
        || typeof parsed.model !== 'string'
        || typeof parsed.encryptedApiKey !== 'string'
      ) return null
      return parsed as StoredProvider
    } catch {
      return null
    }
  }

  private decryptApiKey(stored: StoredProvider): string {
    if (!secureStorageAvailable()) throw new Error('Secure credential storage is unavailable on this system.')
    try {
      return safeStorage.decryptString(Buffer.from(stored.encryptedApiKey, 'base64'))
    } catch {
      throw new Error('The saved API key could not be unlocked. Reconnect the provider.')
    }
  }
}


