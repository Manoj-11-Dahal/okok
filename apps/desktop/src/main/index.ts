import { app, BrowserWindow, dialog, ipcMain, nativeImage, session, type IpcMainInvokeEvent } from 'electron'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import appIconIcoPath from '../../assets/branding/altrex-app-icon.ico?asset'
import appIconPngPath from '../../assets/branding/altrex-app-icon.png?asset'
import {
  desktopChannels,
  type ChatStreamEvent,
  type ChatRequest,
  type ChatAttachment,
  type ProjectSummary,
  type ProviderConnectionInput,
  type ProviderId,
  type ProviderLinkKind,
  type RuntimeInfo,
} from '../shared/desktop-api'
import { providerDefinitions } from '../shared/provider-registry'
import { recommendedLocalCodingModel } from '../shared/local-ai'
import { openOfficialProviderLink } from './provider-link-service'
import { ProviderService } from './provider-service'
import { buildRepositoryContext } from './repository-context'
import { AttachmentService } from './attachment-service'
import { configureInstalledLocalAiHome, ensureLocalAiServer } from './local-ai-service'

const isDevelopment = !app.isPackaged
const requestedScale = process.env.ALTREX_DEVICE_SCALE_FACTOR
const trustedProjects = new Set<string>()
const attachmentService = new AttachmentService()

if (process.env.ALTREX_SMOKE_TEST === '1') {
  app.disableHardwareAcceleration()
  app.commandLine.appendSwitch('disable-gpu')
  app.commandLine.appendSwitch('disable-gpu-compositing')
  app.setPath('userData', join(app.getPath('temp'), `altrex-code-smoke-${process.pid}`))
}

if (requestedScale === '1.25' || requestedScale === '1.5') {
  app.commandLine.appendSwitch('force-device-scale-factor', requestedScale)
}

if (process.platform === 'win32') app.setAppUserModelId('com.altrex.code')

function readGitBranch(projectPath: string): string | null {
  const gitEntry = join(projectPath, '.git')
  if (!existsSync(gitEntry)) return null

  try {
    const headPath = existsSync(join(gitEntry, 'HEAD'))
      ? join(gitEntry, 'HEAD')
      : join(projectPath, readFileSync(gitEntry, 'utf8').trim().replace(/^gitdir:\s*/, ''), 'HEAD')
    const head = readFileSync(headPath, 'utf8').trim()
    return head.startsWith('ref: refs/heads/') ? head.slice('ref: refs/heads/'.length) : head.slice(0, 8)
  } catch {
    return null
  }
}

function detectMarkers(projectPath: string): string[] {
  const candidates = ['package.json', 'pnpm-lock.yaml', 'Cargo.toml', 'pyproject.toml', 'go.mod', 'ALTREX.md']
  return candidates.filter((entry) => existsSync(join(projectPath, entry)))
}

function summarizeProject(projectPath: string): ProjectSummary {
  return {
    name: basename(projectPath),
    path: projectPath,
    branch: readGitBranch(projectPath),
    markers: detectMarkers(projectPath),
  }
}

function isTrustedSender(window: BrowserWindow, event: IpcMainInvokeEvent): boolean {
  const frame = event.senderFrame
  if (frame === null || frame.parent !== null || event.sender.id !== window.webContents.id) return false
  const frameUrl = frame.url
  if (frameUrl.startsWith('file:')) return true
  if (isDevelopment) return frameUrl.startsWith('http://127.0.0.1:') || frameUrl.startsWith('http://localhost:')
  return false
}

function registerIpc(window: BrowserWindow, providerService: ProviderService, stateDirectory: string): void {
  const recentProjectPath = join(stateDirectory, 'recent-project.json')
  for (const channel of Object.values(desktopChannels)) {
    if (channel !== desktopChannels.chatEvent) ipcMain.removeHandler(channel)
  }

  ipcMain.handle(desktopChannels.openProject, async (event): Promise<ProjectSummary | null> => {
    if (!isTrustedSender(window, event)) throw new Error('Rejected IPC sender')
    const result = await dialog.showOpenDialog(window, {
      title: 'Open a project in ALTREX CODE',
      buttonLabel: 'Open project',
      properties: ['openDirectory', 'createDirectory'],
    })
    if (result.canceled) return null
    const selectedPath = result.filePaths[0]
    if (selectedPath === undefined) return null
    trustedProjects.add(selectedPath)
    mkdirSync(stateDirectory, { recursive: true })
    writeFileSync(recentProjectPath, JSON.stringify({ path: selectedPath }), 'utf8')
    return summarizeProject(selectedPath)
  })

  ipcMain.handle(desktopChannels.recentProject, (event): ProjectSummary | null => {
    if (!isTrustedSender(window, event)) throw new Error('Rejected IPC sender')
    try {
      const parsed = JSON.parse(readFileSync(recentProjectPath, 'utf8')) as { path?: unknown }
      if (typeof parsed.path !== 'string' || !existsSync(parsed.path)) return null
      trustedProjects.add(parsed.path)
      return summarizeProject(parsed.path)
    } catch {
      return null
    }
  })

  ipcMain.handle(desktopChannels.runtimeInfo, (event): RuntimeInfo => {
    if (!isTrustedSender(window, event)) throw new Error('Rejected IPC sender')
    return {
      platform: process.platform,
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      bridge: 'connected',
      codex: providerService.getCodexRuntimeInfo(),
    }
  })

  ipcMain.handle(desktopChannels.providerStatus, (event) => {
    if (!isTrustedSender(window, event)) throw new Error('Rejected IPC sender')
    return providerService.getStatus()
  })

  ipcMain.handle(desktopChannels.providerModels, (event, providerId?: ProviderId) => {
    if (!isTrustedSender(window, event)) throw new Error('Rejected IPC sender')
    return providerService.getModels(providerId)
  })

  ipcMain.handle(desktopChannels.providerRefreshModels, (event) => {
    if (!isTrustedSender(window, event)) throw new Error('Rejected IPC sender')
    return providerService.refreshModels()
  })

  ipcMain.handle(desktopChannels.providerInstallLocalModel, (event, modelId: string) => {
    if (!isTrustedSender(window, event)) throw new Error('Rejected IPC sender')
    if (typeof modelId !== 'string' || modelId.length > 100) throw new Error('Invalid local model.')
    return providerService.installLocalModel(modelId)
  })

  ipcMain.handle(desktopChannels.providerDiagnostics, (event) => {
    if (!isTrustedSender(window, event)) throw new Error('Rejected IPC sender')
    return providerService.diagnostics()
  })

  ipcMain.handle(desktopChannels.attachmentPick, (event): Promise<ChatAttachment[]> => {
    if (!isTrustedSender(window, event)) throw new Error('Rejected IPC sender')
    return attachmentService.pick(window)
  })

  ipcMain.handle(desktopChannels.providerTest, (event, input: ProviderConnectionInput) => {
    if (!isTrustedSender(window, event)) throw new Error('Rejected IPC sender')
    return providerService.test(input)
  })

  ipcMain.handle(desktopChannels.providerConnect, (event, input: ProviderConnectionInput) => {
    if (!isTrustedSender(window, event)) throw new Error('Rejected IPC sender')
    return providerService.connect(input)
  })

  ipcMain.handle(desktopChannels.providerDisconnect, (event, providerId?: ProviderId) => {
    if (!isTrustedSender(window, event)) throw new Error('Rejected IPC sender')
    if (providerId !== undefined && !providerDefinitions.some(provider => provider.id === providerId)) throw new Error('Unsupported provider.')
    return providerService.disconnect(providerId)
  })

  ipcMain.handle(desktopChannels.providerOpenExternal, async (event, providerId: ProviderId, kind: ProviderLinkKind): Promise<void> => {
    if (!isTrustedSender(window, event)) throw new Error('Rejected IPC sender')
    if (!providerDefinitions.some(provider => provider.id === providerId)) throw new Error('Could not open official provider page.')
    if (!['apiKey', 'accountId', 'install', 'docs'].includes(kind)) throw new Error('Could not open official provider page.')
    await openOfficialProviderLink(providerId, kind)
  })

  ipcMain.handle(desktopChannels.chatStart, (event, request: ChatRequest): void => {
    if (!isTrustedSender(window, event)) throw new Error('Rejected IPC sender')
    if (
      typeof request?.requestId !== 'string'
      || !/^[a-zA-Z0-9-]{8,80}$/.test(request.requestId)
      || !Array.isArray(request.messages)
      || !Array.isArray(request.attachments)
      || request.attachments.length > 8
      || (request.mode !== 'ASK' && request.mode !== 'AGENT' && request.mode !== 'LOCAL' && request.mode !== 'MULTI')
      || (request.resumeRunId !== undefined && !/^[a-zA-Z0-9-]{8,80}$/.test(request.resumeRunId))
      || typeof request.modelSelection !== 'string'
      || request.modelSelection.length === 0
      || request.modelSelection.length > 200
      || request.messages.some((message) => (
        (message.role !== 'user' && message.role !== 'assistant')
        || typeof message.content !== 'string'
      ))
      || request.attachments.some((attachment) => (
        typeof attachment?.id !== 'string'
        || !/^[a-f0-9-]{36}$/.test(attachment.id)
        || typeof attachment.name !== 'string'
        || attachment.name.length === 0
        || attachment.name.length > 260
        || typeof attachment.mimeType !== 'string'
        || typeof attachment.size !== 'number'
        || attachment.size < 0
        || (attachment.kind !== 'image' && attachment.kind !== 'text' && attachment.kind !== 'file')
      ))
    ) throw new Error('Invalid chat request.')
    if (request.projectPath !== null && !trustedProjects.has(request.projectPath)) throw new Error('Project access was not granted.')

    const repositoryContext = request.projectPath === null ? '' : buildRepositoryContext(request.projectPath, request.messages.filter(message => message.role === 'user').at(-1)?.content ?? '')
    const attachments = attachmentService.resolve(request.attachments, request.projectPath)
    const emit = (payload: ChatStreamEvent): void => {
      if (!window.isDestroyed()) window.webContents.send(desktopChannels.chatEvent, payload)
    }
    void providerService.streamChat(request, repositoryContext, attachments, emit).catch((error: unknown) => {
      emit({
        requestId: request.requestId,
        type: 'error',
        message: error instanceof Error ? error.message : 'Could not start the provider request.',
      })
    })
  })

  ipcMain.handle(desktopChannels.chatCancel, (event, requestId: string): void => {
    if (!isTrustedSender(window, event)) throw new Error('Rejected IPC sender')
    if (typeof requestId !== 'string') throw new Error('Invalid request ID.')
    providerService.cancel(requestId)
  })
  ipcMain.handle(desktopChannels.runRevise, (event, id: string, text: string): void => {
    if (!isTrustedSender(window, event)) throw new Error('Rejected IPC sender')
    if (typeof id !== 'string' || typeof text !== 'string') throw new Error('Invalid revision.')
    providerService.revise(id, text)
  })
  ipcMain.handle(desktopChannels.projectRuns, (event, projectPath: string) => {
    if (!isTrustedSender(window, event) || !trustedProjects.has(projectPath)) throw new Error('Open the project before inspecting its runs.')
    return providerService.runs.list(projectPath)
  })
}

function createSplashWindow(): BrowserWindow {
  const splash = new BrowserWindow({
    width: 360,
    height: 260,
    frame: false,
    resizable: false,
    movable: true,
    show: true,
    center: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    backgroundColor: '#161616',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  const logoDataUrl = nativeImage.createFromPath(appIconPngPath).toDataURL()
  const splashMarkup = `<!doctype html>
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'" />
        <style>
          * { box-sizing: border-box; }
          html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; }
          body { display: grid; place-items: center; background: #161616; color: #f2f2f2; font-family: Inter, Segoe UI, sans-serif; }
          main { display: flex; flex-direction: column; align-items: center; }
          img { width: 82px; height: 82px; object-fit: cover; mix-blend-mode: screen; }
          h1 { margin: 18px 0 0; font-size: 15px; font-weight: 560; letter-spacing: .28em; text-indent: .28em; }
          .progress { width: 70px; height: 1px; margin-top: 30px; overflow: hidden; background: #24272b; }
          .progress::after { content: ''; display: block; width: 28px; height: 1px; background: #c7c9cc; animation: move 1.25s ease-in-out infinite alternate; }
          @keyframes move { from { transform: translateX(-28px); opacity: .35; } to { transform: translateX(70px); opacity: .9; } }
          @media (prefers-reduced-motion: reduce) { .progress::after { animation: none; transform: translateX(21px); } }
        </style>
      </head>
      <body><main><img src="${logoDataUrl}" alt="" /><h1>ALTREX CODE</h1><div class="progress"></div></main></body>
    </html>`

  void splash.loadURL(`data:text/html;charset=UTF-8,${encodeURIComponent(splashMarkup)}`)
  return splash
}

function launchWindowFlow(providerService: ProviderService, stateDirectory: string): void {
  const splash = createSplashWindow()
  splash.webContents.once('did-finish-load', () => {
    if (process.env.ALTREX_SMOKE_TEST === '1') console.log('[ALTREX_SPLASH_READY] logo=A')
    createWindow(splash, providerService, stateDirectory)
  })
  splash.webContents.once('did-fail-load', (_event, errorCode, errorDescription) => {
    console.error('[ALTREX_SPLASH_FAILED]', errorCode, errorDescription)
    if (process.env.ALTREX_SMOKE_TEST === '1') app.exit(1)
  })
}

function createWindow(splash: BrowserWindow, providerService: ProviderService, stateDirectory: string): BrowserWindow {
  const windowIcon = nativeImage.createFromPath(process.platform === 'win32' ? appIconIcoPath : appIconPngPath)
  if (windowIcon.isEmpty()) throw new Error('ALTREX application icon could not be loaded')
  const window = new BrowserWindow({
    title: 'ALTREX CODE',
    width: 1540,
    height: 960,
    minWidth: 820,
    minHeight: 620,
    show: false,
    backgroundColor: '#161616',
    icon: windowIcon,
    autoHideMenuBar: true,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
    },
  })

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  registerIpc(window, providerService, stateDirectory)

  if (isDevelopment && process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }

  let revealed = false
  const reveal = () => {
    if (revealed || window.isDestroyed()) return
    revealed = true
    if (!splash.isDestroyed()) splash.destroy()
    window.show()
    if (process.env.ALTREX_SMOKE_TEST === '1') {
      void window.webContents
        .executeJavaScript("window.altrex?.getRuntimeInfo().then((info) => info.bridge)")
        .then((bridge: unknown) => {
          if (bridge !== 'connected') throw new Error('Secure preload bridge did not respond')
          console.log(`[ALTREX_SMOKE_READY] bridge=connected splash=closed icon=logo-a scale=${requestedScale ?? '1'}`)
          if (process.env.ALTREX_SMOKE_REPORT) writeFileSync(process.env.ALTREX_SMOKE_REPORT, JSON.stringify({ ready: true, packaged: app.isPackaged, bridge: 'connected', executable: process.execPath }))
          setTimeout(() => app.quit(), 700)
        })
        .catch((error: unknown) => {
          console.error('[ALTREX_SMOKE_FAILED]', error)
          app.exit(1)
        })
    }
  }
  window.once('ready-to-show', reveal)
  window.webContents.once('did-finish-load', reveal)

  return window
}

app.whenReady().then(async () => {
  if (app.isPackaged) configureInstalledLocalAiHome(app.getPath('userData'))
  await ensureLocalAiServer().catch(() => undefined)
  const stateDirectory = join(app.getPath('userData'), 'state')
  const savedProviderRetest = process.env.ALTREX_PROVIDER_RETEST
  const localSetup = process.env.ALTREX_LOCAL_SETUP === '1'
  const diagnostic = process.env.ALTREX_PROVIDER_CHECK === '1' || process.env.ALTREX_WORKFLOW_CHECK === '1' || localSetup || Boolean(savedProviderRetest)
  const providerStateRoot = join(app.getPath('userData'), 'multi-ai')
  const providerService = new ProviderService(join(app.getPath('userData'), 'credentials', 'provider.json'), diagnostic ? mkdtempSync(join(app.getPath('temp'), 'altrex-diagnostics-')) : providerStateRoot, providerStateRoot)
  let shutdownReady = false
  app.on('before-quit', event => { if (shutdownReady) return; event.preventDefault(); void providerService.stopAll().finally(() => { shutdownReady = true; app.quit() }) })
  if (localSetup) {
    void providerService.installLocalModel(recommendedLocalCodingModel.id)
      .then(status => {
        const local = status.profiles?.find(profile => profile.providerId === 'ollama')
        console.log('[ALTREX_LOCAL_SETUP]', JSON.stringify({ connected: local?.connectionState === 'CONNECTED', model: local?.model ?? null, message: local?.statusMessage ?? null }))
        app.exit(local?.connectionState === 'CONNECTED' ? 0 : 1)
      })
      .catch(error => { console.error('[ALTREX_LOCAL_SETUP]', error instanceof Error ? error.message : 'Local AI setup failed.'); app.exit(1) })
    return
  }
  if (savedProviderRetest) {
    const providerId = providerDefinitions.some(provider => provider.id === savedProviderRetest) ? savedProviderRetest as ProviderId : null
    const profile = providerId ? providerService.getStatus().profiles?.find(item => item.providerId === providerId) : undefined
    if (!providerId || !profile) { console.error('[ALTREX_PROVIDER_RETEST] Saved provider was not found.'); app.exit(1); return }
    void providerService.test({ providerId, apiKey: '', baseUrl: profile.baseUrl ?? '', model: profile.model ?? '', additionalFields: profile.additionalFields ?? {} })
      .then(result => { console.log('[ALTREX_PROVIDER_RETEST]', JSON.stringify({ providerId, ...result })); app.exit(result.ok ? 0 : 1) })
      .catch(() => { console.error('[ALTREX_PROVIDER_RETEST] Could not unlock or test the saved connection.'); app.exit(1) })
    return
  }
  if (process.env.ALTREX_PROVIDER_CHECK === '1') {
    void providerService.testConfigured().then(results => { console.log('[ALTREX_PROVIDER_CHECK]', JSON.stringify(results)); app.exit(results.length > 0 && results.every(result => result.ok) ? 0 : 1) }).catch(() => { console.error('[ALTREX_PROVIDER_CHECK] Could not unlock or test saved connections.'); app.exit(1) })
    return
  }
  if (process.env.ALTREX_WORKFLOW_CHECK === '1') {
    void providerService.testWorkflows().then(results => { console.log('[ALTREX_WORKFLOW_CHECK]', JSON.stringify(results)); app.exit(results.every(result => result.ok) ? 0 : 1) }).catch(error => { console.error('[ALTREX_WORKFLOW_CHECK]', error instanceof Error ? error.message : 'Workflow check failed.'); app.exit(1) })
    return
  }
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
  launchWindowFlow(providerService, stateDirectory)
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) launchWindowFlow(providerService, stateDirectory)
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
