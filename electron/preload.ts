import { contextBridge, ipcRenderer } from 'electron';
import type { FloatingWindowState, MonitorApi, MonitorState } from '../src/shared/types';

const api: MonitorApi = {
  windowChrome: process.platform === 'win32' ? 'overlay' : 'native',
  getConfig: () => ipcRenderer.invoke('config:get'),
  getResidentOptions: () => ipcRenderer.invoke('resident:get'),
  setResidentOptions: options => ipcRenderer.invoke('resident:set', options),
  setConfig: settings => ipcRenderer.invoke('config:set', settings),
  refresh: () => ipcRenderer.invoke('monitor:refresh'),
  getRecentReply: key => ipcRenderer.invoke('monitor:recent-reply', key),
  getOriginalWindowStatus: key => ipcRenderer.invoke('monitor:original-window-status', key),
  focusOriginalWindow: key => ipcRenderer.invoke('monitor:focus-original-window', key),
  copyWorkspace: text => ipcRenderer.invoke('workspace:copy', text),
  getMonitorState: () => ipcRenderer.invoke('monitor:get-state'),
  onMonitorState: (listener: (state: MonitorState) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: MonitorState) => listener(state);
    ipcRenderer.on('monitor:state', handler);
    return () => ipcRenderer.removeListener('monitor:state', handler);
  },
  acknowledgeAlert: id => ipcRenderer.invoke('monitor:ack-alert', id),
  setNotificationsMuted: muted => ipcRenderer.invoke('monitor:set-muted', muted),
  getFloatingState: () => ipcRenderer.invoke('floating:get-state'),
  setFloatingVisible: visible => ipcRenderer.invoke('floating:set-visible', visible),
  setFloatingExpanded: expanded => ipcRenderer.invoke('floating:set-expanded', expanded),
  setFloatingOpacity: opacity => ipcRenderer.invoke('floating:set-opacity', opacity),
  resetFloatingPosition: () => ipcRenderer.invoke('floating:reset-position'),
  setFloatingAppearance: appearance => ipcRenderer.invoke('floating:set-appearance', appearance),
  setFloatingCompactSize: size => ipcRenderer.invoke('floating:set-compact-size', size),
  onFloatingState: (listener: (state: FloatingWindowState) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: FloatingWindowState) => listener(state);
    ipcRenderer.on('floating:state', handler);
    return () => ipcRenderer.removeListener('floating:state', handler);
  },
  showMainWindow: key => ipcRenderer.invoke('monitor:show-main', key),
  consumePendingFocusKey: () => ipcRenderer.invoke('monitor:consume-focus-key'),
  onFocusSession: listener => {
    const handler = (_event: Electron.IpcRendererEvent, key: string) => listener(key);
    ipcRenderer.on('monitor:focus-session', handler);
    return () => ipcRenderer.removeListener('monitor:focus-session', handler);
  },
};
contextBridge.exposeInMainWorld('monitorApi', api);
