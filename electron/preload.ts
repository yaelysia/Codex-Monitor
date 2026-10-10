import { contextBridge, ipcRenderer } from 'electron';
import type { MonitorApi } from '../src/shared/types';

const api: MonitorApi = {
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (settings) => ipcRenderer.invoke('config:set', settings),
  refresh: () => ipcRenderer.invoke('monitor:refresh'),
  copyWorkspace: (text) => ipcRenderer.invoke('workspace:copy', text),
};
contextBridge.exposeInMainWorld('monitorApi', api);
