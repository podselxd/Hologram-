import { app, Notification, type MenuItemConstructorOptions } from 'electron';
import { autoUpdater, type UpdateInfo } from 'electron-updater';
import fs from 'node:fs';
import path from 'node:path';
import type { AutoUpdate } from '../shared/settings';
import type { UpdateAction, UpdateSnapshot } from '../shared/types';
import { isAutoUpdateAllowed } from './updater';

type State =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'available'; version: string; reason?: string }
  | { kind: 'downloading'; version: string; percent: number }
  | { kind: 'ready'; version: string }
  | { kind: 'error'; message: string };

const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
const FIRST_CHECK_MS = 20 * 1000;

/**
 * Updates for the installed (NSIS) app through electron-updater and the GitHub releases (latest.yml).
 * auto: download in the background and install when the app quits; ask: nothing happens without a click.
 */
export class InstalledUpdater {
  private state: State = { kind: 'idle' };
  private readonly userData = app.getPath('userData');

  constructor(
    private readonly onChange: () => void,
    private readonly logFile: string,
    private readonly getMode: () => AutoUpdate,
  ) {}

  get enabled(): boolean {
    return app.isPackaged && process.platform === 'win32';
  }

  private log(message: string): void {
    try {
      fs.appendFileSync(this.logFile, `${new Date().toISOString()} ${message}\n`);
    } catch {
      // logging must never break the app
    }
  }

  private set(state: State): void {
    this.state = state;
    this.onChange();
  }

  private notify(body: string): void {
    new Notification({ title: 'Hologram', body }).show();
  }

  private applyMode(): void {
    const auto = this.getMode() === 'auto';
    autoUpdater.autoDownload = auto;
    autoUpdater.autoInstallOnAppQuit = auto;
  }

  start(): void {
    this.reportVersionChange();
    if (!this.enabled) return;
    autoUpdater.allowPrerelease = false;
    autoUpdater.allowDowngrade = false;
    autoUpdater.logger = { info: (m: unknown) => this.log(String(m)), warn: (m: unknown) => this.log(`WARN ${String(m)}`), error: (m: unknown) => this.log(`ERROR ${String(m)}`), debug: () => undefined };
    this.applyMode();

    autoUpdater.on('checking-for-update', () => this.set({ kind: 'checking' }));
    autoUpdater.on('update-not-available', () => {
      const manual = this.manualCheck;
      this.manualCheck = false;
      this.set({ kind: 'idle' });
      if (manual) this.notify('Ya tienes la última versión.');
    });
    autoUpdater.on('update-available', (info: UpdateInfo) => {
      this.manualCheck = false;
      const allowed = isAutoUpdateAllowed(app.getVersion(), info.version);
      if (this.getMode() === 'auto' && !allowed) {
        // Never auto-install a major jump: stop the automatic download and ask.
        autoUpdater.autoDownload = false;
      }
      const reason = allowed ? undefined : 'Es un salto de versión mayor: necesita tu confirmación.';
      this.set({ kind: 'available', version: info.version, ...(reason ? { reason } : {}) });
      if (this.getMode() !== 'auto' || !allowed) {
        this.notify(`Hay una versión nueva (${info.version}). ${reason ?? 'Descárgala desde los ajustes o la bandeja.'}`);
      }
    });
    autoUpdater.on('download-progress', (p) => {
      const version = 'version' in this.state ? this.state.version : '?';
      this.set({ kind: 'downloading', version, percent: Math.round(p.percent) });
    });
    autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
      this.set({ kind: 'ready', version: info.version });
      this.notify(
        this.getMode() === 'auto'
          ? `Actualización v${info.version} lista: se instalará al salir de Hologram, o ahora con "Reiniciar ahora".`
          : `Versión ${info.version} descargada. Elige "Reiniciar para actualizar".`,
      );
    });
    autoUpdater.on('error', (err: Error) => {
      const manual = this.manualCheck;
      this.manualCheck = false;
      this.log(`update error: ${String(err)}`);
      this.set({ kind: 'error', message: err.message });
      if (manual) this.notify('No pude buscar actualizaciones. Revisa tu conexión.');
    });

    setTimeout(() => void this.check(false), FIRST_CHECK_MS).unref();
    setInterval(() => void this.check(false), CHECK_EVERY_MS).unref();
  }

  private manualCheck = false;

  async check(manual: boolean): Promise<void> {
    if (!this.enabled || ['checking', 'downloading', 'ready'].includes(this.state.kind)) return;
    this.manualCheck = manual;
    this.applyMode();
    try {
      await autoUpdater.checkForUpdates();
    } catch (err) {
      this.log(`check failed: ${String(err)}`);
    }
  }

  private download(): void {
    if (this.state.kind !== 'available') return;
    void autoUpdater.downloadUpdate().catch((err: unknown) => this.log(`download failed: ${String(err)}`));
  }

  private restartNow(): void {
    if (this.state.kind !== 'ready') return;
    this.notify('Actualizando Hologram: se cerrará y se volverá a abrir sola en unos segundos.');
    // Silent install, then start the app again.
    setTimeout(() => autoUpdater.quitAndInstall(true, true), 400);
  }

  onModeChanged(): void {
    this.applyMode();
    if (this.getMode() === 'auto' && this.state.kind === 'available' && isAutoUpdateAllowed(app.getVersion(), this.state.version)) {
      this.download();
    }
    this.onChange();
  }

  run(action: UpdateAction): void {
    if (action === 'check') void this.check(true);
    else if (action === 'download') this.download();
    else if (action === 'apply') this.restartNow();
    // 'rollback' is not offered for the installed app (reinstall an older Setup instead)
  }

  /** "Hologram se actualizó de X a Y", once. */
  private reportVersionChange(): void {
    try {
      const file = path.join(this.userData, 'last-version.txt');
      const previous = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : '';
      fs.mkdirSync(this.userData, { recursive: true });
      fs.writeFileSync(file, app.getVersion());
      if (previous && previous !== app.getVersion()) this.notify(`Hologram se actualizó de v${previous} a v${app.getVersion()}.`);
    } catch (err) {
      this.log(`version note failed: ${String(err)}`);
    }
  }

  snapshot(): UpdateSnapshot {
    const s = this.state;
    return {
      enabled: this.enabled,
      version: app.getVersion(),
      state: s.kind,
      ...('version' in s ? { latest: s.version } : {}),
      canRollback: false,
      auto: this.getMode() === 'auto',
      ...(s.kind === 'error' ? { message: s.message } : {}),
      ...(s.kind === 'available' && s.reason ? { message: s.reason } : {}),
      ...(s.kind === 'downloading' ? { message: `${s.percent} %` } : {}),
    };
  }

  menuItems(): MenuItemConstructorOptions[] {
    const items: MenuItemConstructorOptions[] = [{ label: `Hologram v${app.getVersion()}`, enabled: false }];
    if (!this.enabled) return items;
    const s = this.state;
    if (s.kind === 'available') items.push({ label: `Descargar actualización v${s.version}`, click: () => this.download() });
    else if (s.kind === 'downloading') items.push({ label: `Descargando v${s.version}… ${s.percent} %`, enabled: false });
    else if (s.kind === 'ready') items.push({ label: `Reiniciar para actualizar a v${s.version}`, click: () => this.restartNow() });
    else
      items.push({
        label: s.kind === 'checking' ? 'Buscando actualizaciones…' : 'Buscar actualizaciones',
        enabled: s.kind !== 'checking',
        click: () => void this.check(true),
      });
    return items;
  }

  // The portable updater's extras do not apply to the installed app.
  reportPreviousUpdate(): void {}
  swapInProgress(): boolean {
    return false;
  }
  installOnQuit(): boolean {
    return false; // electron-updater's autoInstallOnAppQuit does it
  }
}
