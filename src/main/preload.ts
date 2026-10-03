import { contextBridge, ipcRenderer } from 'electron';
import { CH, type HologramApi } from '../shared/api';

function on<T>(channel: string, cb: (value: T) => void): void {
  ipcRenderer.on(channel, (_event, value: T) => cb(value));
}

const api: HologramApi = {
  getInit: () => ipcRenderer.invoke(CH.init),
  getSettings: () => ipcRenderer.invoke(CH.getSettings),
  patchSettings: (p) => ipcRenderer.send(CH.patchSettings, p),
  settingsCommand: (c) => ipcRenderer.send(CH.settingsCommand, c),
  setPreview: (e) => ipcRenderer.send(CH.setPreview, e),
  updateAction: (a) => ipcRenderer.send(CH.updateAction, a),
  sendFrame: (f) => ipcRenderer.send(CH.frame, f),
  sendStats: (s) => ipcRenderer.send(CH.stats, s),
  sendStatus: (m) => ipcRenderer.send(CH.status, m),
  sendProfile: (p) => ipcRenderer.send(CH.profile, p),
  sendCameras: (c) => ipcRenderer.send(CH.cameras, c),
  sendPreview: (i) => ipcRenderer.send(CH.preview, i),
  sendRenderStats: (s) => ipcRenderer.send(CH.renderStats, s),
  onFrame: (cb) => on(CH.frame, cb),
  onStats: (cb) => on(CH.stats, cb),
  onStatus: (cb) => on(CH.status, cb),
  onProfile: (cb) => on(CH.profile, cb),
  onCommand: (cb) => on(CH.command, cb),
  onSettings: (cb) => on(CH.settings, cb),
  onCameras: (cb) => on(CH.cameras, cb),
  onRenderStats: (cb) => on(CH.renderStats, cb),
  onUpdate: (cb) => on(CH.update, cb),
  onPreview: (cb) => on(CH.preview, cb),
  onGesture: (cb) => on(CH.gesture, cb),
};

contextBridge.exposeInMainWorld('hologram', api);
