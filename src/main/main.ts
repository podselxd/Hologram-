import {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  net,
  Notification,
  protocol,
  screen,
  session,
  Tray,
} from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CH } from '../shared/api';
import { applyPatch, sanitizePatch } from '../shared/settings';
import type {
  CameraInfo,
  Command,
  HandFrame,
  InitConfig,
  ProfileSelection,
  RenderStats,
  TrackerStats,
} from '../shared/types';
import { isPreviewImage, isSettingsCommand, isUpdateAction } from '../shared/validate';
import { parseCli } from './cli';
import { trayIconPixels } from './iconPixels';
import { loadSettings, saveSettings, writeReport } from './settings';
import { UpdateController } from './updateController';

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

let tray: Tray | null = null;
let updater: UpdateController | null = null;
let overlay: BrowserWindow | null = null;
let tracker: BrowserWindow | null = null;
let settingsWin: BrowserWindow | null = null;
let settings = loadSettings();
let cameras: CameraInfo[] = [];
let lastSelection: ProfileSelection | null = null;
let lastTrackerStats: TrackerStats | null = null;
let lastRenderStats: RenderStats | null = null;
let lastStatus = '';
let previewWanted = false;

// Must happen before the app is ready. Workaround if the transparent overlay flickers on some GPUs/drivers.
const safeRenderActive = cli.safeRender || settings.safeRender;
if (safeRenderActive) app.disableHardwareAcceleration();

// The tracker lives in a hidden window. Windows/Chromium throttle hidden and occluded windows (timers, painting,
// video), which can starve the camera pipeline; this tool needs them running at full rate.
// Camera frames are decoded in software: on some webcams Chromium's GPU capture/MJPEG path on Windows delivers
// half the frames (15 instead of 30). The GPU stays available for the hand model. Unknown feature names are ignored.
app.commandLine.appendSwitch(
  'disable-features',
  'CalculateNativeWinOcclusion,MediaFoundationD3D11VideoCapture,MediaFoundationD3D11VideoCaptureZeroCopy',
);
app.commandLine.appendSwitch('disable-accelerated-mjpeg-decode');
// Fallback chosen in the settings window: capture through DirectShow instead of Media Foundation.
if (settings.cameraBackend === 'directshow') app.commandLine.appendSwitch('force-directshow');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');

const dist = (): string => path.join(app.getAppPath(), 'dist');

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

function openSettings(): void {
  if (settingsWin && !settingsWin.isDestroyed()) {
    if (settingsWin.isMinimized()) settingsWin.restore();
    settingsWin.show();
    settingsWin.focus();
    return;
  }
  settingsWin = new BrowserWindow({
    width: 1000,
    height: 740,
    minWidth: 780,
    minHeight: 560,
    title: 'Hologram',
    backgroundColor: '#0b1220',
    autoHideMenuBar: true,
    show: false,
    webPreferences: webPreferences(),
  });
  const win = settingsWin;
  win.once('ready-to-show', () => win.show());
  win.webContents.on('did-finish-load', pushSnapshotToSettings);
  win.on('closed', () => {
    settingsWin = null;
    previewWanted = false;
    send(tracker, CH.command, { type: 'set-preview', enabled: false } satisfies Command);
  });
  if (debug) win.webContents.on('console-message', (e) => log('settings console:', e.message));
  void win.loadURL(`${SCHEME}://${HOST}/settings.html`);
}

function send(win: BrowserWindow | null, channel: string, payload: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

/** The settings window is only fed while it is actually on screen. */
function sendToSettings(channel: string, payload: unknown): void {
  if (settingsWin && !settingsWin.isDestroyed() && settingsWin.isVisible() && !settingsWin.isMinimized()) {
    settingsWin.webContents.send(channel, payload);
  }
}

function pushSnapshotToSettings(): void {
  send(settingsWin, CH.cameras, cameras);
  if (lastTrackerStats) send(settingsWin, CH.stats, lastTrackerStats);
  if (lastSelection) send(settingsWin, CH.profile, lastSelection);
  if (lastRenderStats) send(settingsWin, CH.renderStats, lastRenderStats);
  if (lastStatus) send(settingsWin, CH.status, lastStatus);
  if (updater) send(settingsWin, CH.update, updater.snapshot());
}

function broadcast(command: Command): void {
  send(overlay, CH.command, command);
  send(tracker, CH.command, command);
}

function broadcastSettings(): void {
  send(overlay, CH.settings, settings);
  send(tracker, CH.settings, settings);
  send(settingsWin, CH.settings, settings);
}

function patchSettings(raw: unknown): void {
  const patch = sanitizePatch(raw);
  if (Object.keys(patch).length === 0) return;
  const before = settings;
  settings = applyPatch(settings, patch);
  saveSettings(settings);
  broadcastSettings();
  if (settings.autoUpdate !== before.autoUpdate) updater?.onModeChanged();
  if (settings.cameraBackend !== before.cameraBackend) {
    new Notification({ title: 'Hologram', body: 'Método de captura cambiado. Cierra y vuelve a abrir Hologram para aplicarlo.' }).show();
  }
  if (settings.safeRender !== before.safeRender) {
    new Notification({
      title: 'Hologram',
      body: `Modo seguro ${settings.safeRender ? 'activado' : 'desactivado'}. Cierra y vuelve a abrir Hologram para aplicarlo.`,
    }).show();
  }
  refreshTray();
}

const isFrom = (win: BrowserWindow | null, sender: Electron.WebContents): boolean =>
  win !== null && !win.isDestroyed() && win.webContents === sender;

function registerIpc(): void {
  ipcMain.handle(CH.init, (): InitConfig => ({
    mode: cli.videoPath ? 'video' : 'camera',
    settings,
    safeRenderActive,
    profileOverride: cli.profile,
    forceHands: cli.hands,
  }));
  ipcMain.handle(CH.getSettings, () => settings);

  // ---- settings window -> main (sender-checked; payloads sanitised) -------------------------
  ipcMain.on(CH.patchSettings, (e, raw: unknown) => {
    if (isFrom(settingsWin, e.sender)) patchSettings(raw);
  });
  ipcMain.on(CH.settingsCommand, (e, cmd: unknown) => {
    if (!isFrom(settingsWin, e.sender) || !isSettingsCommand(cmd)) return;
    if (cmd === 'rerun-benchmark') broadcast({ type: 'rerun-benchmark' });
    else if (cmd === 'toggle-overlay') toggleOverlay();
    else app.quit();
  });
  ipcMain.on(CH.setPreview, (e, enabled: unknown) => {
    if (!isFrom(settingsWin, e.sender) || typeof enabled !== 'boolean') return;
    previewWanted = enabled;
    send(tracker, CH.command, { type: 'set-preview', enabled } satisfies Command);
  });
  ipcMain.on(CH.updateAction, (e, action: unknown) => {
    if (isFrom(settingsWin, e.sender) && isUpdateAction(action)) updater?.run(action);
  });

  // ---- tracker -> main -> overlay / settings -------------------------------------------------
  let framesRelayed = 0;
  ipcMain.on(CH.frame, (e, frame: HandFrame) => {
    if (!isFrom(tracker, e.sender)) return;
    if (++framesRelayed % 30 === 1) log(`frames relayed: ${framesRelayed}, hands in last: ${frame.hands.length}`);
    send(overlay, CH.frame, frame);
    sendToSettings(CH.frame, frame);
  });
  ipcMain.on(CH.preview, (e, image: unknown) => {
    if (!isFrom(tracker, e.sender) || !previewWanted || !isPreviewImage(image)) return;
    sendToSettings(CH.preview, image);
  });
  ipcMain.on(CH.stats, (e, stats: TrackerStats) => {
    if (!isFrom(tracker, e.sender)) return;
    lastTrackerStats = stats;
    log('tracker:', JSON.stringify(stats));
    send(overlay, CH.stats, stats);
    sendToSettings(CH.stats, stats);
  });
  ipcMain.on(CH.status, (e, message: string) => {
    if (!isFrom(tracker, e.sender)) return;
    lastStatus = String(message);
    log('status:', lastStatus);
    send(overlay, CH.status, lastStatus);
    sendToSettings(CH.status, lastStatus);
  });
  ipcMain.on(CH.profile, (e, selection: ProfileSelection) => {
    if (!isFrom(tracker, e.sender)) return;
    lastSelection = selection;
    log('profile:', JSON.stringify(selection));
    writeReport('benchmark.json', { at: new Date().toISOString(), ...selection });
    send(overlay, CH.profile, selection);
    sendToSettings(CH.profile, selection);
  });
  ipcMain.on(CH.cameras, (e, list: CameraInfo[]) => {
    if (!isFrom(tracker, e.sender) || !Array.isArray(list)) return;
    cameras = list.filter((c) => typeof c?.deviceId === 'string' && typeof c?.label === 'string');
    send(settingsWin, CH.cameras, cameras);
  });
  ipcMain.on(CH.renderStats, (e, stats: RenderStats) => {
    if (!isFrom(overlay, e.sender)) return;
    lastRenderStats = stats;
    log('render:', JSON.stringify(stats));
    sendToSettings(CH.renderStats, stats);
  });
}

function setOverlayVisible(visible: boolean): void {
  if (!overlay || overlay.isDestroyed()) return;
  if (visible) overlay.showInactive();
  else overlay.hide();
  // Hidden overlay = camera off: nothing is captured while the tool is in the background.
  broadcast({ type: 'set-paused', paused: !visible });
  refreshTray();
}

function toggleOverlay(): void {
  setOverlayVisible(!(overlay?.isVisible() ?? false));
}

function cycleCamera(): void {
  if (cameras.length < 2) return;
  const i = cameras.findIndex((c) => c.deviceId === settings.deviceId);
  const next = cameras[(i + 1) % cameras.length];
  if (next) patchSettings({ deviceId: next.deviceId });
}

function refreshTray(): void {
  if (!tray) return;
  const visible = overlay?.isVisible() ?? false;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Abrir ajustes', click: openSettings },
      { type: 'separator' },
      ...(updater ? [...updater.menuItems(), { type: 'separator' as const }] : []),
      { label: visible ? 'Ocultar overlay (apaga la cámara)' : 'Mostrar overlay', click: toggleOverlay },
      { label: 'Cambiar de cámara', click: cycleCamera },
      { label: 'Repetir benchmark', click: () => broadcast({ type: 'rerun-benchmark' }) },
      { type: 'separator' },
      {
        label: 'Modo seguro (sin aceleración por hardware, reinicia la app)',
        type: 'checkbox',
        checked: settings.safeRender,
        click: () => patchSettings({ safeRender: !settings.safeRender }),
      },
      { type: 'separator' },
      { label: 'Salir de Hologram', click: () => app.quit() },
    ]),
  );
}

function createTray(): void {
  const size = 32;
  const icon = nativeImage.createFromBitmap(trayIconPixels(size), { width: size, height: size });
  tray = new Tray(icon);
  tray.setToolTip(`Hologram v${app.getVersion()}`);
  tray.on('click', openSettings);
  refreshTray();
}

function registerShortcuts(): void {
  const bind = (accelerator: string, fn: () => void): void => {
    if (!globalShortcut.register(accelerator, fn)) console.warn(`shortcut ${accelerator} could not be registered`);
  };
  bind('CommandOrControl+Alt+O', toggleOverlay);
  bind('CommandOrControl+Alt+C', cycleCamera);
  bind('CommandOrControl+Alt+B', () => broadcast({ type: 'rerun-benchmark' }));
  bind('CommandOrControl+Alt+S', openSettings);
  bind('CommandOrControl+Alt+Q', () => app.quit());
}

/** Dev aid: HOLOGRAM_SHOT=<file.png> saves the overlay (HOLOGRAM_SHOT_SETTINGS=<file.png> the settings window). */
function scheduleDebugScreenshots(): void {
  const overlayTarget = process.env['HOLOGRAM_SHOT'];
  const settingsTarget = process.env['HOLOGRAM_SHOT_SETTINGS'];
  if (!overlayTarget && !settingsTarget) return;
  const delay = Number(process.env['HOLOGRAM_SHOT_DELAY'] ?? 25000);
  // Dev only: switch the camera-image preview on a few seconds before the capture.
  if (settingsTarget) {
    setTimeout(() => {
      void settingsWin?.webContents.executeJavaScript("document.getElementById('previewOn').click()");
    }, Math.max(0, delay - 6000));
  }
  setTimeout(() => {
    void (async () => {
      if (overlayTarget && overlay) fs.writeFileSync(overlayTarget, (await overlay.webContents.capturePage()).toPNG());
      if (settingsTarget && settingsWin) {
        const full = Number(await settingsWin.webContents.executeJavaScript('document.documentElement.scrollHeight'));
        settingsWin.setContentSize(1000, Math.min(full, 3000));
        await new Promise((r) => setTimeout(r, 800));
        fs.writeFileSync(settingsTarget, (await settingsWin.webContents.capturePage()).toPNG());
      }
      app.quit();
    })();
  }, delay);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // Launching the exe again just brings the settings window up.
  app.on('second-instance', openSettings);
  void app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    updater = new UpdateController(
      () => {
        refreshTray();
        send(settingsWin, CH.update, updater?.snapshot());
      },
      path.join(app.getPath('userData'), 'update.log'),
      () => settings.autoUpdate,
    );
    // A verified update that was waiting for the next start: install it before showing anything.
    if (await updater.applyPendingOnStart()) return;

    registerProtocol();
    registerIpc();
    createTracker();
    hardenSession();
    createOverlay();
    registerShortcuts();
    createTray();
    updater.start();
    updater.reportPreviousUpdate();
    refreshTray();
    openSettings();
    scheduleDebugScreenshots();
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
