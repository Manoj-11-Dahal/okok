import { contextBridge, ipcRenderer } from 'electron'
import { desktopChannels, type ChatStreamEvent, type DesktopApi } from '../shared/desktop-api'

const desktopApi: DesktopApi = Object.freeze({
  openProject: () => ipcRenderer.invoke(desktopChannels.openProject) as ReturnType<DesktopApi['openProject']>,
  getRecentProject: () => ipcRenderer.invoke(desktopChannels.recentProject) as ReturnType<DesktopApi['getRecentProject']>,
  getRuntimeInfo: () => ipcRenderer.invoke(desktopChannels.runtimeInfo) as ReturnType<DesktopApi['getRuntimeInfo']>,
  getProviderStatus: () => ipcRenderer.invoke(desktopChannels.providerStatus) as ReturnType<DesktopApi['getProviderStatus']>,
  getProviderModels: (providerId) => ipcRenderer.invoke(desktopChannels.providerModels, providerId) as ReturnType<DesktopApi['getProviderModels']>,
  refreshProviderModels: () => ipcRenderer.invoke(desktopChannels.providerRefreshModels) as ReturnType<DesktopApi['refreshProviderModels']>,
  installLocalModel: (modelId) => ipcRenderer.invoke(desktopChannels.providerInstallLocalModel, modelId) as ReturnType<DesktopApi['installLocalModel']>,
  getProviderDiagnostics: () => ipcRenderer.invoke(desktopChannels.providerDiagnostics) as ReturnType<DesktopApi['getProviderDiagnostics']>,
  pickAttachments: () => ipcRenderer.invoke(desktopChannels.attachmentPick) as ReturnType<DesktopApi['pickAttachments']>,
  testProvider: (input) => ipcRenderer.invoke(desktopChannels.providerTest, input) as ReturnType<DesktopApi['testProvider']>,
  connectProvider: (input) => ipcRenderer.invoke(desktopChannels.providerConnect, input) as ReturnType<DesktopApi['connectProvider']>,
  disconnectProvider: (providerId) => ipcRenderer.invoke(desktopChannels.providerDisconnect, providerId) as ReturnType<DesktopApi['disconnectProvider']>,
  openExternalProviderLink: (providerId, kind) => ipcRenderer.invoke(desktopChannels.providerOpenExternal, providerId, kind) as ReturnType<DesktopApi['openExternalProviderLink']>,
  startChat: (request) => ipcRenderer.invoke(desktopChannels.chatStart, request) as ReturnType<DesktopApi['startChat']>,
  cancelChat: (requestId) => ipcRenderer.invoke(desktopChannels.chatCancel, requestId) as ReturnType<DesktopApi['cancelChat']>,
  reviseRun: (requestId, text) => ipcRenderer.invoke(desktopChannels.runRevise, requestId, text) as ReturnType<DesktopApi['reviseRun']>,
  getProjectRuns: (projectPath) => ipcRenderer.invoke(desktopChannels.projectRuns, projectPath) as ReturnType<DesktopApi['getProjectRuns']>,
  onChatEvent: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: ChatStreamEvent): void => listener(payload)
    ipcRenderer.on(desktopChannels.chatEvent, wrapped)
    return () => ipcRenderer.removeListener(desktopChannels.chatEvent, wrapped)
  },
})

contextBridge.exposeInMainWorld('altrex', desktopApi)
