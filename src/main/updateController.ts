import { app, net, Notification, type MenuItemConstructorOptions } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { buildSwapScript, downloadAndVerify, fetchLatest, isNewer, type ReleaseInfo } from './updater';

type State =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'available'; info: ReleaseInfo }
  | { kind: 'downloading'; info: ReleaseInfo }
  | { kind: 'ready'; info: ReleaseInfo }
  | { kind: 'error'; message: string };

const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
const FIRST_CHECK_MS = 20 * 1000;

/**
 * Self-updater for the portable exe. Never installs by itself: the user picks "download" and then "restart".
 * Disabled unless running as the electron-builder portable exe (PORTABLE_EXECUTABLE_FILE is set).
 */
export class UpdateController {
  private state: State = { kind: 'idle' };
  private readonly target = process.env['PORTABLE_EXECUTABLE_FILE'];

  constructor(
    private readonly onChange: () => void,
    private readonly logFile: string,
  ) {}

  get enabled(): boolean {
    return process.platform === 'win32' && !!this.target && fs.existsSync(this.target);
  }

  private get dir(): string {
    return path.dirname(this.target as string);
  }
  private get updatePath(): string {
    return path.join(this.dir, 'Hologram.update.exe');
  }
  private get backupPath(): string {
    return path.join(this.dir, 'Hologram.old.exe');
  }

  start(): void {
    if (!this.enabled) return;
    setTimeout(() => void this.check(false), FIRST_CHECK_MS).unref();
    setInterval(() => void this.check(false), CHECK_EVERY_MS).unref();
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

  async check(manual: boolean): Promise<void> {
    if (!this.enabled || this.state.kind === 'checking' || this.state.kind === 'downloading') return;
    if (this.state.kind === 'ready') return;
    this.set({ kind: 'checking' });
    try {
      const info = await fetchLatest((url, init) => net.fetch(url, init));
      if (info && isNewer(info.version, app.getVersion())) {
        this.log(`update available: ${info.version}`);
        this.set({ kind: 'available', info });
        this.notify(`Hay una versión nueva (${info.version}). Descárgala desde el icono de la bandeja.`);
      } else {
        this.set({ kind: 'idle' });
        if (manual) this.notify('Ya tienes la última versión.');
      }
    } catch (err) {
      this.log(`check failed: ${String(err)}`);
      this.set({ kind: 'error', message: String(err) });
      if (manual) this.notify('No pude buscar actualizaciones. Revisa tu conexión.');
    }
  }

  async download(): Promise<void> {
    if (this.state.kind !== 'available') return;
    const info = this.state.info;
    this.set({ kind: 'downloading', info });
    try {
      await downloadAndVerify(info, this.updatePath, (url, init) => net.fetch(url, init));
      this.log(`downloaded and verified ${info.version}`);
      this.set({ kind: 'ready', info });
      this.notify(`Versión ${info.version} descargada y verificada. Elige "Reiniciar para actualizar".`);
    } catch (err) {
      this.log(`download failed: ${String(err)}`);
      this.set({ kind: 'available', info });
      this.notify(`La descarga falló: ${String(err)}`);
    }
  }

  /** Spawns the swap script and quits so the exe can be replaced. */
  private swapAndQuit(source: string, backup: string): void {
    const script = path.join(os.tmpdir(), `hologram-update-${Date.now()}.cmd`);
    fs.writeFileSync(
      script,
      buildSwapScript({
        target: this.target as string,
        source,
        backup,
        pids: [process.pid, process.ppid],
        relaunch: true,
      }),
    );
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.startsWith('PORTABLE_EXECUTABLE')) delete env[key];
    spawn('cmd.exe', ['/c', script], { detached: true, stdio: 'ignore', windowsHide: true, env }).unref();
    this.log(`swap script started: ${script}`);
    app.quit();
  }

  applyAndRestart(): void {
    if (this.state.kind !== 'ready') return;
    this.swapAndQuit(this.updatePath, this.backupPath);
  }

  get canRollback(): boolean {
    return this.enabled && fs.existsSync(this.backupPath);
  }

  rollback(): void {
    if (!this.canRollback) return;
    // The current exe becomes the "undone" copy so the swap can be reversed again.
    this.swapAndQuit(this.backupPath, path.join(this.dir, 'Hologram.undone.exe'));
  }

  menuItems(): MenuItemConstructorOptions[] {
    const items: MenuItemConstructorOptions[] = [{ label: `Hologram v${app.getVersion()}`, enabled: false }];
    if (!this.enabled) {
      items.push({ label: 'Actualizaciones: solo en el .exe portable', enabled: false });
      return items;
    }
    const s = this.state;
    if (s.kind === 'available') {
      items.push({ label: `Descargar actualización v${s.info.version}`, click: () => void this.download() });
    } else if (s.kind === 'downloading') {
      items.push({ label: `Descargando v${s.info.version}…`, enabled: false });
    } else if (s.kind === 'ready') {
      items.push({ label: `Reiniciar para actualizar a v${s.info.version}`, click: () => this.applyAndRestart() });
    } else {
      items.push({
        label: s.kind === 'checking' ? 'Buscando actualizaciones…' : 'Buscar actualizaciones',
        enabled: s.kind !== 'checking',
        click: () => void this.check(true),
      });
    }
    if (this.canRollback) items.push({ label: 'Volver a la versión anterior', click: () => this.rollback() });
    return items;
  }
}
