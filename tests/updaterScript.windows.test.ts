import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildSwapScript } from '../src/main/updater';

/** Runs the real swap script with fake files. Only meaningful (and only run) on Windows. */
describe.skipIf(process.platform !== 'win32')('swap script on Windows', () => {
  const run = (script: string): Promise<number> =>
    new Promise((resolve, reject) => {
      const child = spawn('cmd.exe', ['/c', script], { stdio: 'ignore', windowsHide: true });
      child.on('error', reject);
      child.on('exit', (code) => resolve(code ?? -1));
    });

  it('waits for the pid to exit, keeps a backup and puts the new file in place', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'holo swap % test '));
    const target = path.join(dir, 'Hologram.exe');
    const source = path.join(dir, 'Hologram.update.exe');
    const backup = path.join(dir, 'Hologram.old.exe');
    fs.writeFileSync(target, 'OLD');
    fs.writeFileSync(source, 'NEW');
    fs.writeFileSync(backup, 'ANCIENT');

    // A real, short-lived process the script must wait for (ping.exe lives ~3 s).
    const waiter = spawn('ping.exe', ['-n', '4', '127.0.0.1'], { stdio: 'ignore', windowsHide: true });
    const waiterPid = waiter.pid as number;
    const started = Date.now();

    const script = path.join(dir, 'swap.cmd');
    fs.writeFileSync(script, buildSwapScript({ target, source, backup, pids: [waiterPid], relaunch: false }));
    const code = await run(script);
    const elapsed = Date.now() - started;

    expect(code).toBe(0);
    expect(elapsed).toBeGreaterThan(1500); // it really waited for the process
    expect(fs.readFileSync(target, 'utf8')).toBe('NEW');
    expect(fs.readFileSync(backup, 'utf8')).toBe('OLD');
    expect(fs.existsSync(source)).toBe(false);
    expect(fs.existsSync(script)).toBe(false); // self-deleted
    fs.rmSync(dir, { recursive: true, force: true });
  }, 60_000);

  it('restores the old exe and fails when the new one is missing', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'holo swap fail '));
    const target = path.join(dir, 'Hologram.exe');
    fs.writeFileSync(target, 'OLD');
    const script = path.join(dir, 'swap.cmd');
    fs.writeFileSync(
      script,
      buildSwapScript({
        target,
        source: path.join(dir, 'does-not-exist.exe'),
        backup: path.join(dir, 'Hologram.old.exe'),
        pids: [999999],
        relaunch: false,
      }),
    );
    const code = await run(script);
    expect(code).not.toBe(0);
    expect(fs.readFileSync(target, 'utf8')).toBe('OLD');
    fs.rmSync(dir, { recursive: true, force: true });
  }, 60_000);

  const verifyOpts = (dir: string, timeoutSeconds: number) => ({
    markerPath: path.join(dir, 'started-ok'),
    timeoutSeconds,
    killImage: 'hologram-test-never-running.exe',
    failureNotePath: path.join(dir, 'update-note.txt'),
    label: '9.9.9',
  });
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  it('with verification: keeps the new exe once the new version writes its marker', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'holo verify ok '));
    const target = path.join(dir, 'Hologram.exe');
    const source = path.join(dir, 'Hologram.update.exe');
    const backup = path.join(dir, 'Hologram.old.exe');
    fs.writeFileSync(target, 'OLD');
    fs.writeFileSync(source, 'NEW');
    const v = verifyOpts(dir, 40);
    const script = path.join(dir, 'swap.cmd');
    fs.writeFileSync(script, buildSwapScript({ target, source, backup, pids: [999999], relaunch: false, verify: v }));
    const done = run(script);
    // Play the part of the new version: write the marker once the swap happened (after the script cleared it).
    for (let i = 0; i < 100 && fs.readFileSync(target, 'utf8') !== 'NEW'; i++) await sleep(100);
    await sleep(1500);
    fs.writeFileSync(v.markerPath, 'ok');
    const code = await done;
    expect(code).toBe(0);
    expect(fs.readFileSync(target, 'utf8')).toBe('NEW');
    expect(fs.readFileSync(backup, 'utf8')).toBe('OLD');
    expect(fs.existsSync(v.failureNotePath)).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  }, 90_000);

  it('with verification: restores the old exe and leaves a note when the new one never starts', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'holo verify bad '));
    const target = path.join(dir, 'Hologram.exe');
    const source = path.join(dir, 'Hologram.update.exe');
    const backup = path.join(dir, 'Hologram.old.exe');
    fs.writeFileSync(target, 'OLD');
    fs.writeFileSync(source, 'NEW');
    const v = verifyOpts(dir, 4);
    const script = path.join(dir, 'swap.cmd');
    fs.writeFileSync(script, buildSwapScript({ target, source, backup, pids: [999999], relaunch: false, verify: v }));
    const code = await run(script);
    expect(code).toBe(1);
    expect(fs.readFileSync(target, 'utf8')).toBe('OLD'); // rolled back
    expect(fs.readFileSync(v.failureNotePath, 'utf8')).toContain('rolled-back 9.9.9');
    fs.rmSync(dir, { recursive: true, force: true });
  }, 90_000);
});
