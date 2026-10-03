import { app, net, Notification, type MenuItemConstructorOptions } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import type { AutoUpdate } from '../shared/settings';
import type { UpdateAction, UpdateSnapshot } from '../shared/types';
import {
  buildSwapScript,
  downloadAndVerify,
  fetchLatest,
  isAutoUpdateAllowed,
  isNewer,
  legacyCleanupScript,
  parsePending,
  sha256File,
  type PendingUpdate,
  type ReleaseInfo,
} from './updater';

type State =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'available'; info: ReleaseInfo; reason?: string }
  | { kind: 'downloading'; info: ReleaseInfo }
  | { kind: 'ready'; info: ReleaseInfo }
  | { kind: 'error'; message: string };

const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
const FIRST_CHECK_MS = 20 * 1000;
/** The new version must prove it started within this time or the old exe comes back. */
const VERIFY_TIMEOUT_S = 90;
/** The app writes the "started fine" marker this long after launch. */
const MARKER_DELAY_MS = 20 * 1000;
const MAX_APPLY_ATTEMPTS = 2;

/**
 * Self-updater for the portable exe. Disabled unless running as the electron-builder portable exe
 * (PORTABLE_EXECUTABLE_FILE is set). In `auto` mode it downloads in the background and installs on the next
 * start (inside the same major version); in `ask` mode nothing happens without a click.
 */
export class UpdateController {
  private state: State = { kind: 'idle' };
  private swapping = false;
  private readonly target = process.env['PORTABLE_EXECUTABLE_FILE'];
  private readonly userData = app.getPath('userData');

  constructor(
    private readonly onChange: () => void,
    private readonly logFile: string,
    private readonly getMode: () => AutoUpdate,
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
  private get pendingPath(): string {
    return path.join(this.userData, 'update-pending.json');
  }
  private get markerPath(): string {
    return path.join(this.userData, 'started-ok');
  }
  private get notePath(): string {
    return path.join(this.userData, 'update-note.txt');
  }
  private get swapLogPath(): string {
    return path.join(this.userData, 'update-swap.log');
  }
  private get lockPath(): string {
    return path.join(this.userData, 'update-in-progress');
  }
  private get lastVersionPath(): string {
    return path.join(this.userData, 'last-version.txt');
  }

  /** Removes leftovers of the old cmd-based updater (and stops one that is still flashing windows). */
  cleanupLegacy(): void {
    if (process.platform !== 'win32') return;
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', legacyCleanupScript()],
      { windowsHide: true, timeout: 20000 },
      (err) => {
        if (err) this.log(`legacy cleanup failed: ${String(err)}`);
      },
    );
  }

  start(): void {
    this.cleanupLegacy();
    void this.restorePending();
    // Tell a future update that this version starts fine (every run, harmless).
    setTimeout(() => {
      try {
        fs.mkdirSync(this.userData, { recursive: true });
        fs.writeFileSync(this.markerPath, `${app.getVersion()} ${new Date().toISOString()}\n`);
      } catch (err) {
        this.log(`could not write started-ok: ${String(err)}`);
      }
    }, MARKER_DELAY_MS).unref();
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

  // ---- messages left by a previous run ----------------------------------------------------------------------

  /** Tells the user what happened to the last update, once. Call after the app is ready. */
  reportPreviousUpdate(): void {
    try {
      if (fs.existsSync(this.notePath)) {
        const note = fs.readFileSync(this.notePath, 'utf8').trim();
        fs.rmSync(this.notePath, { force: true });
        this.log(`update note: ${note}`);
        const version = /(\d+\.\d+\.\d+)/.exec(note)?.[1] ?? '?';
        this.notify(
          note.startsWith('swap-failed')
            ? `No se pudo instalar la actualización: ${note.slice('swap-failed '.length)}. Sigues en v${app.getVersion()}; se reintentará al salir.`
            : note.startsWith('rollback-failed')
              ? `La actualización a v${version} falló y no pude restaurar la versión anterior. Descarga Hologram de nuevo desde GitHub.`
              : `La actualización a v${version} no arrancó bien; se restauró la versión anterior (v${app.getVersion()}).`,
        );
        return;
      }
      const previous = fs.existsSync(this.lastVersionPath) ? fs.readFileSync(this.lastVersionPath, 'utf8').trim() : '';
      fs.mkdirSync(this.userData, { recursive: true });
      fs.writeFileSync(this.lastVersionPath, app.getVersion());
      if (previous && previous !== app.getVersion()) {
        this.log(`updated ${previous} -> ${app.getVersion()}`);
        this.notify(`Hologram se actualizó de v${previous} a v${app.getVersion()}.`);
      }
    } catch (err) {
      this.log(`reportPreviousUpdate failed: ${String(err)}`);
    }
  }

  // ---- install on next start -----------------------------------------------------------------------------------

  private readPending(): PendingUpdate | null {
    try {
      return parsePending(JSON.parse(fs.readFileSync(this.pendingPath, 'utf8')));
    } catch {
      return null;
    }
  }

  private writePending(p: PendingUpdate): void {
    fs.mkdirSync(this.userData, { recursive: true });
    fs.writeFileSync(this.pendingPath, JSON.stringify(p, null, 2));
  }

  private dropPending(removeFile: boolean): void {
    fs.rmSync(this.pendingPath, { force: true });
    if (removeFile) fs.rmSync(this.updatePath, { force: true });
  }

  /** True while a swap script from a previous run is still working (a second copy must not start). */
  swapInProgress(): boolean {
    try {
      const age = Date.now() - fs.statSync(this.lockPath).mtimeMs;
      if (age < 3 * 60 * 1000) return true;
      fs.rmSync(this.lockPath, { force: true }); // stale: the script died
    } catch {
      // no lock
    }
    return false;
  }

  /** At startup: a verified download from a previous run becomes "ready" again (installed on quit). */
  private async restorePending(): Promise<void> {
    if (!this.enabled) return;
    const pending = this.readPending();
    if (!pending) {
      fs.rmSync(this.updatePath, { force: true });
      return;
    }
    if (!isNewer(pending.version, app.getVersion())) {
      this.dropPending(true); // already installed, or older than what runs now
      return;
    }
    if (pending.attempts >= MAX_APPLY_ATTEMPTS) {
      this.log(`giving up on ${pending.version} after ${pending.attempts} attempts`);
      this.dropPending(true);
      this.notify(`No pude instalar la actualización v${pending.version} tras varios intentos. Sigues en v${app.getVersion()}. Puedes bajarla a mano desde GitHub.`);
      return;
    }
    try {
      const stat = fs.statSync(pending.path);
      if (stat.size !== pending.size || (await sha256File(pending.path)) !== pending.sha256) {
        this.log('pending update failed the integrity check; discarding');
        this.dropPending(true);
        return;
      }
    } catch {
      this.dropPending(false);
      return;
    }
    this.set({ kind: 'ready', info: { tag: `v${pending.version}`, version: pending.version, exeUrl: '', exeSize: pending.size, shaUrl: '' } });
  }

  /**
   * Called when the app is quitting: in auto mode a ready update is installed now (no relaunch), so the next
   * time the user opens Hologram it is the new version. Returns true if the swap was started.
   */
  installOnQuit(): boolean {
    if (this.swapping || this.state.kind !== 'ready' || this.getMode() !== 'auto') return false;
    if (!isAutoUpdateAllowed(app.getVersion(), this.state.info.version)) return false;
    this.bumpAttempts();
    this.swapAndQuit(this.updatePath, this.backupPath, this.state.info.version, true, false, false);
    return true;
  }

  private bumpAttempts(): void {
    const p = this.readPending();
    if (p) this.writePending({ ...p, attempts: p.attempts + 1 });
  }

  // ---- check / download -------------------------------------------------------------------------------------------

  async check(manual: boolean): Promise<void> {
    if (!this.enabled) return;
    if (['checking', 'downloading', 'ready'].includes(this.state.kind)) return;
    this.set({ kind: 'checking' });
    try {
      const info = await fetchLatest((url, init) => net.fetch(url, init));
      if (info && isNewer(info.version, app.getVersion())) {
        this.log(`update available: ${info.version}`);
        const allowed = isAutoUpdateAllowed(app.getVersion(), info.version);
        if (this.getMode() === 'auto' && allowed) {
          this.set({ kind: 'available', info });
          await this.download();
        } else {
          const reason = allowed ? undefined : 'Es un salto de versión mayor: necesita tu confirmación.';
          this.set({ kind: 'available', info, ...(reason ? { reason } : {}) });
          this.notify(`Hay una versión nueva (${info.version}). ${reason ?? 'Descárgala desde el icono de la bandeja.'}`);
        }
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
      const { sha256, size } = await downloadAndVerify(info, this.updatePath, (url, init) => net.fetch(url, init));
      this.writePending({ version: info.version, path: this.updatePath, sha256, size, attempts: 0 });
      this.log(`downloaded and verified ${info.version}`);
      this.set({ kind: 'ready', info });
      const auto = this.getMode() === 'auto' && isAutoUpdateAllowed(app.getVersion(), info.version);
      this.notify(
        auto
          ? `Actualización v${info.version} lista: se instalará al salir de Hologram (icono de la bandeja → Salir), o ahora con "Reiniciar ahora".`
          : `Versión ${info.version} descargada y verificada. Elige "Reiniciar para actualizar".`,
      );
    } catch (err) {
      this.log(`download failed: ${String(err)}`);
      this.set({ kind: 'available', info });
      this.notify(`La descarga falló: ${String(err)}`);
    }
  }

  /** The user switched to `auto`: pick up an update that was only waiting for permission. */
  onModeChanged(): void {
    if (this.getMode() === 'auto' && this.state.kind === 'available' && isAutoUpdateAllowed(app.getVersion(), this.state.info.version)) {
      void this.download();
    }
    this.onChange();
  }

  // ---- swap ------------------------------------------------------------------------------------------------------------

  /** Spawns the swap script; it waits for this process to exit, so the caller must quit (or already be quitting). */
  private swapAndQuit(source: string, backup: string, version: string | null, verify: boolean, relaunch = true, quit = true): void {
    this.swapping = true;
    const script = path.join(os.tmpdir(), `hologram-update-${Date.now()}.ps1`);
    fs.mkdirSync(this.userData, { recursive: true });
    fs.writeFileSync(this.lockPath, new Date().toISOString());
    fs.writeFileSync(
      script,
      buildSwapScript({
        target: this.target as string,
        source,
        backup,
        // Only this process: the portable launcher's lock on the exe is handled by the move retries.
        pids: [process.pid],
        relaunch,
        logPath: this.swapLogPath,
        lockPath: this.lockPath,
        notePath: this.notePath,
        ...(verify && version
          ? {
              verify: {
                markerPath: this.markerPath,
                timeoutSeconds: VERIFY_TIMEOUT_S,
                killImage: 'Hologram.exe',
                failureNotePath: this.notePath,
                label: version,
              },
            }
          : {}),
      }),
    );
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.startsWith('PORTABLE_EXECUTABLE')) delete env[key];
    // Detached = no console at all; the script only uses built-in cmdlets, so no window ever appears.
    spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', script],
      { detached: true, stdio: 'ignore', windowsHide: true, env },
    ).unref();
    this.log(`swap script started: ${script} (relaunch=${relaunch})`);
    this.notify(
      relaunch
        ? 'Actualizando Hologram: se cerrará y se volverá a abrir sola en unos 30 segundos. No la abras mientras tanto.'
        : `Instalando v${version ?? ''} al salir. La próxima vez que abras Hologram será la versión nueva (espera unos segundos).`,
    );
    if (quit) app.quit();
  }

  applyAndRestart(): void {
    if (this.state.kind !== 'ready' || this.swapping) return;
    this.bumpAttempts();
    this.swapAndQuit(this.updatePath, this.backupPath, this.state.info.version, true);
  }

  get canRollback(): boolean {
    return this.enabled && fs.existsSync(this.backupPath);
  }

  rollback(): void {
    if (!this.canRollback) return;
    // The current exe becomes the "undone" copy so the swap can be reversed again.
    this.dropPending(false); // do not auto-install the version the user just left
    this.swapAndQuit(this.backupPath, path.join(this.dir, 'Hologram.undone.exe'), null, false);
  }

  // ---- UI ---------------------------------------------------------------------------------------------------------------

  snapshot(): UpdateSnapshot {
    const s = this.state;
    return {
      enabled: this.enabled,
      version: app.getVersion(),
      state: s.kind,
      ...('info' in s ? { latest: s.info.version } : {}),
      canRollback: this.canRollback,
      auto: this.getMode() === 'auto',
      ...(s.kind === 'error' ? { message: s.message } : {}),
      ...(s.kind === 'available' && s.reason ? { message: s.reason } : {}),
    };
  }

  run(action: UpdateAction): void {
    if (action === 'check') void this.check(true);
    else if (action === 'download') void this.download();
    else if (action === 'apply') this.applyAndRestart();
    else this.rollback();
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
