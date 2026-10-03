import { contextBridge, ipcRenderer } from 'electron';
import { CH, type HologramApi } from '../shared/api';

function on<T>(channel: string, cb: (value: T) => void): void {
  ipcRenderer.on(channel, (_event, value: T) => cb(value));
}

const api: HologramApi = {
  getInit: () => ipcRenderer.invoke(CH.init),
  sendFrame: (f) => ipcRenderer.send(CH.frame, f),
  sendStats: (s) => ipcRenderer.send(CH.stats, s),
  sendStatus: (m) => ipcRenderer.send(CH.status, m),
  sendProfile: (p) => ipcRenderer.send(CH.profile, p),
  sendCameras: (c) => ipcRenderer.send(CH.cameras, c),
  sendRenderStats: (s) => ipcRenderer.send(CH.renderStats, s),
  onFrame: (cb) => on(CH.frame, cb),
  onStats: (cb) => on(CH.stats, cb),
  onStatus: (cb) => on(CH.status, cb),
  onProfile: (cb) => on(CH.profile, cb),
  onCommand: (cb) => on(CH.command, cb),
};

contextBridge.exposeInMainWorld('hologram', api);
