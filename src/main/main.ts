import { app, BrowserWindow, globalShortcut, ipcMain, net, protocol, screen, session } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CH } from '../shared/api';
import type {
  CameraInfo,
  Command,
  HandFrame,
  InitConfig,
  ProfileSelection,
  RenderStats,
  TrackerStats,
} from '../shared/types';
import { parseCli } from './cli';
import { loadSettings, saveSettings, writeReport } from './settings';

const SCHEME = 'app';
const HOST = 'hologram';
const cli = parseCli(process.argv.slice(1));
const debug = process.env['HOLOGRAM_DEBUG'] === '1';
const log = (...args: unknown[]): void => {
  if (debug) console.log('[hologram]', ...args);
};

protocol.registerSchemesAsPrivileged([
  { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
]);

let overlay: BrowserWindow | null = null;
let tracker: BrowserWindow | null = null;
let settings = loadSettings();
let cameras: CameraInfo[] = [];
let lastSelection: ProfileSelection | null = null;
let lastTrackerStats: TrackerStats | null = null;
let lastRenderStats: RenderStats | null = null;

const root = (): string => app.getAppPath();
const dist = (): string => path.join(root(), 'dist');

function resolveInside(base: string, rel: string): string | null {
  const abs = path.resolve(base, rel);
  return abs === base || abs.startsWith(base + path.sep) ? abs : null;
}

function registerProtocol(): void {
  protocol.handle(SCHEME, (request) => {
    const url = new URL(request.url);
    if (url.host !== HOST) return new Response('forbidden', { status: 403 });
    if (url.pathname === '/video') {
      if (!cli.videoPath) return new Response('no video', { status: 404 });
      return net.fetch(pathToFileURL(path.resolve(cli.videoPath)).toString(), { headers: request.headers });
    }
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'overlay.html';
    const abs = resolveInside(dist(), rel);
    if (!abs) return new Response('forbidden', { status: 403 });
    return net.fetch(pathToFileURL(abs).toString());
  });
}

function hardenSession(): void {
  const allowMedia = (wc: Electron.WebContents | null, permission: string): boolean =>
    permission === 'media' && wc !== null && tracker !== null && wc === tracker.webContents;
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback) => callback(allowMedia(wc, permission)));
  session.defaultSession.setPermissionCheckHandler((wc, permission) => allowMedia(wc, permission));

  app.on('web-contents-created', (_e, contents) => {
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-navigate', (event) => event.preventDefault());
  });
}

const webPreferences = (): Electron.WebPreferences => ({
  preload: path.join(dist(), 'preload.js'),
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
  backgroundThrottling: false,
});

function createOverlay(): void {
  const { bounds } = screen.getPrimaryDisplay();
  overlay = new BrowserWindow({
    ...bounds,
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    show: false,
    webPreferences: webPreferences(),
  });
  overlay.setAlwaysOnTop(true, 'screen-saver');
  overlay.setIgnoreMouseEvents(true);
  overlay.once('ready-to-show', () => overlay?.showInactive());
  if (debug) overlay.webContents.on('console-message', (e) => log('overlay console:', e.message));
  const bg = process.env['HOLOGRAM_DEBUG_BG'];
  void overlay.loadURL(`${SCHEME}://${HOST}/overlay.html${bg ? `?bg=${encodeURIComponent(bg)}` : ''}`);
}

function createTracker(): void {
  tracker = new BrowserWindow({ show: false, width: 640, height: 480, webPreferences: webPreferences() });
  if (debug) tracker.webContents.on('console-message', (e) => log('tracker console:', e.message));
  void tracker.loadURL(`${SCHEME}://${HOST}/tracker.html`);
}

function send(win: BrowserWindow | null, channel: string, payload: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function broadcast(command: Command): void {
  send(overlay, CH.command, command);
  send(tracker, CH.command, command);
}

function registerIpc(): void {
  ipcMain.handle(CH.init, (): InitConfig => ({
    mode: cli.videoPath ? 'video' : 'camera',
    deviceId: settings.deviceId,
    profileOverride: cli.profile,
    forceHands: cli.hands,
    hud: cli.hud,
  }));
  let framesRelayed = 0;
  ipcMain.on(CH.frame, (_e, frame: HandFrame) => {
    if (++framesRelayed % 30 === 1) log(`frames relayed: ${framesRelayed}, hands in last: ${frame.hands.length}`);
    send(overlay, CH.frame, frame);
  });
  ipcMain.on(CH.stats, (_e, stats: TrackerStats) => {
    lastTrackerStats = stats;
    log('tracker:', JSON.stringify(stats));
    send(overlay, CH.stats, stats);
  });
  ipcMain.on(CH.status, (_e, message: string) => {
    log('status:', message);
    send(overlay, CH.status, message);
  });
  ipcMain.on(CH.profile, (_e, selection: ProfileSelection) => {
    lastSelection = selection;
    log('profile:', JSON.stringify(selection));
    writeReport('benchmark.json', { at: new Date().toISOString(), ...selection });
    send(overlay, CH.profile, selection);
  });
  ipcMain.on(CH.cameras, (_e, list: CameraInfo[]) => {
    cameras = list;
  });
  ipcMain.on(CH.renderStats, (_e, stats: RenderStats) => {
    lastRenderStats = stats;
    log('render:', JSON.stringify(stats));
  });
}

function cycleCamera(): void {
  if (cameras.length < 2) return;
  const i = cameras.findIndex((c) => c.deviceId === settings.deviceId);
  const next = cameras[(i + 1) % cameras.length];
  if (!next) return;
  settings = { ...settings, deviceId: next.deviceId };
  saveSettings(settings);
  broadcast({ type: 'set-camera', deviceId: next.deviceId });
}

function registerShortcuts(): void {
  const bind = (accelerator: string, fn: () => void): void => {
    if (!globalShortcut.register(accelerator, fn)) console.warn(`shortcut ${accelerator} could not be registered`);
  };
  bind('CommandOrControl+Alt+O', () => {
    if (!overlay) return;
    if (overlay.isVisible()) overlay.hide();
    else overlay.showInactive();
  });
  bind('CommandOrControl+Alt+H', () => broadcast({ type: 'toggle-hud' }));
  bind('CommandOrControl+Alt+C', cycleCamera);
  bind('CommandOrControl+Alt+B', () => broadcast({ type: 'rerun-benchmark' }));
  bind('CommandOrControl+Alt+Q', () => app.quit());
}

/** Dev aid: HOLOGRAM_SHOT=<file.png> saves the overlay after HOLOGRAM_SHOT_DELAY ms (default 25 s) and quits. */
function scheduleDebugScreenshot(): void {
  const target = process.env['HOLOGRAM_SHOT'];
  if (!target) return;
  setTimeout(() => {
    void overlay?.webContents.capturePage().then((image) => {
      fs.writeFileSync(target, image.toPNG());
      app.quit();
    });
  }, Number(process.env['HOLOGRAM_SHOT_DELAY'] ?? 25000));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  void app.whenReady().then(() => {
    registerProtocol();
    registerIpc();
    createTracker();
    hardenSession();
    createOverlay();
    registerShortcuts();
    scheduleDebugScreenshot();
  });
  app.on('window-all-closed', () => app.quit());
  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    writeReport('last-session.json', {
      at: new Date().toISOString(),
      profile: lastSelection,
      tracker: lastTrackerStats,
      render: lastRenderStats,
    });
  });
}
