import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildSwapScript,
  psQuote,
  downloadAndVerify,
  fetchLatest,
  isAutoUpdateAllowed,
  isNewer,
  parsePending,
  parseSha256,
  parseVersion,
  pickRelease,
  sha256File,
  type ReleaseInfo,
} from '../src/main/updater';

const BASE = 'https://github.com/podselxd/Hologram-/releases/download/v0.3.0';
const release = (over: Record<string, unknown> = {}) => ({
  tag_name: 'v0.3.0',
  draft: false,
  prerelease: false,
  assets: [
    { name: 'Hologram.exe', size: 5, browser_download_url: `${BASE}/Hologram.exe` },
    { name: 'Hologram.exe.sha256', size: 90, browser_download_url: `${BASE}/Hologram.exe.sha256` },
  ],
  ...over,
});

describe('versions', () => {
  it('parses plain and v-prefixed versions', () => {
    expect(parseVersion('0.2.0')).toEqual([0, 2, 0]);
    expect(parseVersion('v10.20.30')).toEqual([10, 20, 30]);
    expect(parseVersion('v1.0.0-beta')).toBeNull();
    expect(parseVersion('latest')).toBeNull();
  });
  it('compares numerically, not as strings', () => {
    expect(isNewer('0.10.0', '0.9.0')).toBe(true);
    expect(isNewer('v1.0.0', '0.99.99')).toBe(true);
    expect(isNewer('0.2.0', '0.2.0')).toBe(false);
    expect(isNewer('0.1.9', '0.2.0')).toBe(false);
    expect(isNewer('garbage', '0.2.0')).toBe(false);
  });
});

describe('pickRelease', () => {
  it('accepts a stable release with both assets', () => {
    const r = pickRelease(release());
    expect(r).toMatchObject({ version: '0.3.0', tag: 'v0.3.0', exeSize: 5 });
  });
  it('rejects prereleases, drafts and bad tags', () => {
    expect(pickRelease(release({ prerelease: true }))).toBeNull();
    expect(pickRelease(release({ draft: true }))).toBeNull();
    expect(pickRelease(release({ tag_name: 'hologram-latest' }))).toBeNull();
  });
  it('requires the checksum asset', () => {
    const r = release();
    r.assets = r.assets.slice(0, 1);
    expect(pickRelease(r)).toBeNull();
  });
  it('refuses download URLs outside this repository', () => {
    const r = release();
    (r.assets[0] as { browser_download_url: string }).browser_download_url = 'https://evil.example/Hologram.exe';
    expect(pickRelease(r)).toBeNull();
  });
  it('survives garbage', () => {
    expect(pickRelease(null)).toBeNull();
    expect(pickRelease('x')).toBeNull();
    expect(pickRelease({ tag_name: 'v1.0.0', assets: 'nope' })).toBeNull();
  });
});

describe('fetchLatest', () => {
  it('returns null on 404 and throws on other errors', async () => {
    expect(await fetchLatest(async () => new Response('', { status: 404 }))).toBeNull();
    await expect(fetchLatest(async () => new Response('', { status: 500 }))).rejects.toThrow(/500/);
  });
  it('parses a good payload', async () => {
    const r = await fetchLatest(async () => new Response(JSON.stringify(release())));
    expect(r?.version).toBe('0.3.0');
  });
});

describe('parseSha256', () => {
  const hex = 'a'.repeat(64);
  it('reads sha256sum output', () => {
    expect(parseSha256(`${hex}  Hologram.exe\n`)).toBe(hex);
    expect(parseSha256(hex.toUpperCase())).toBe(hex);
  });
  it('rejects anything else', () => {
    expect(parseSha256('')).toBeNull();
    expect(parseSha256('abc')).toBeNull();
    expect(parseSha256('z'.repeat(64))).toBeNull();
  });
});

describe('downloadAndVerify', () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
  const tmp = (): string => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'holo-upd-'));
    dirs.push(d);
    return d;
  };
  const payload = Buffer.from('hello');
  const sha = createHash('sha256').update(payload).digest('hex');
  const info: ReleaseInfo = { tag: 'v0.3.0', version: '0.3.0', exeUrl: 'exe', exeSize: payload.length, shaUrl: 'sha' };
  const fakeFetch = (exe: Buffer, shaText: string) => async (url: string) =>
    url === 'sha' ? new Response(shaText) : new Response(new Uint8Array(exe));

  it('writes the file when checksum and size match, and returns the hash', async () => {
    const dest = path.join(tmp(), 'Hologram.update.exe');
    const result = await downloadAndVerify(info, dest, fakeFetch(payload, `${sha}  Hologram.exe`));
    expect(result).toEqual({ sha256: sha, size: payload.length });
    expect(fs.readFileSync(dest)).toEqual(payload);
    expect(fs.existsSync(`${dest}.part`)).toBe(false);
    expect(await sha256File(dest)).toBe(sha);
  });
  it('rejects a corrupted download and leaves nothing behind', async () => {
    const dest = path.join(tmp(), 'Hologram.update.exe');
    await expect(downloadAndVerify(info, dest, fakeFetch(Buffer.from('HELLO'), sha))).rejects.toThrow(/SHA-256 mismatch/);
    expect(fs.existsSync(dest)).toBe(false);
    expect(fs.existsSync(`${dest}.part`)).toBe(false);
  });
  it('rejects a wrong size', async () => {
    const dest = path.join(tmp(), 'Hologram.update.exe');
    await expect(downloadAndVerify({ ...info, exeSize: 99 }, dest, fakeFetch(payload, sha))).rejects.toThrow(/size mismatch/);
  });
  it('rejects an invalid checksum file', async () => {
    const dest = path.join(tmp(), 'Hologram.update.exe');
    await expect(downloadAndVerify(info, dest, fakeFetch(payload, 'nope'))).rejects.toThrow(/not a valid SHA-256/);
  });
});

describe('buildSwapScript', () => {
  const params = {
    target: 'C:\\Users\\Ana\\Downloads\\Hologram.exe',
    source: 'C:\\Users\\Ana\\Downloads\\Hologram.update.exe',
    backup: 'C:\\Users\\Ana\\Downloads\\Hologram.old.exe',
    pids: [1234, 5678],
    relaunch: true,
  };
  it('quotes paths for PowerShell', () => {
    expect(psQuote("C:\\O'Neil\\x")).toBe("'C:\\O''Neil\\x'");
  });
  it('contains the paths, the pids and the relaunch', () => {
    const s = buildSwapScript(params);
    expect(s).toContain(`$target = '${params.target}'`);
    expect(s).toContain('$waitFor = @(1234, 5678)');
    expect(s).toContain('Start-Process -FilePath $target');
    expect(s).toContain('\r\n');
  });
  it('can skip the relaunch', () => {
    expect(buildSwapScript({ ...params, relaunch: false })).not.toContain('Start-Process');
  });
  it('never starts external console programs (they flash a window each)', () => {
    const s = buildSwapScript({ ...params, verify: { markerPath: 'm', timeoutSeconds: 5, killImage: 'Hologram.exe', failureNotePath: 'n', label: '1.0.0' } });
    expect(s).not.toMatch(/tasklist|find |ping |taskkill|cmd\.exe/i);
  });
  it('requires at least one valid pid', () => {
    expect(() => buildSwapScript({ ...params, pids: [0, -1, NaN] })).toThrow();
  });
});

describe('auto-update rules', () => {
  it('allows only newer versions inside the same major', () => {
    expect(isAutoUpdateAllowed('0.2.0', '0.2.1')).toBe(true);
    expect(isAutoUpdateAllowed('0.2.0', '0.9.0')).toBe(true);
    expect(isAutoUpdateAllowed('0.9.0', '1.0.0')).toBe(false); // major jump needs the user
    expect(isAutoUpdateAllowed('1.2.0', '2.0.0')).toBe(false);
    expect(isAutoUpdateAllowed('0.2.0', '0.2.0')).toBe(false);
    expect(isAutoUpdateAllowed('0.3.0', '0.2.9')).toBe(false); // never downgrade
    expect(isAutoUpdateAllowed('x', '0.2.1')).toBe(false);
  });
});

describe('parsePending', () => {
  const ok = { version: '0.2.1', path: 'C:\\x\\Hologram.update.exe', sha256: 'a'.repeat(64), size: 100, attempts: 1 };
  it('accepts a good record', () => {
    expect(parsePending(ok)).toEqual(ok);
  });
  it('defaults attempts to 0', () => {
    expect(parsePending({ ...ok, attempts: undefined })?.attempts).toBe(0);
    expect(parsePending({ ...ok, attempts: -2 })?.attempts).toBe(0);
  });
  it('rejects tampered or incomplete records', () => {
    expect(parsePending({ ...ok, sha256: 'zz' })).toBeNull();
    expect(parsePending({ ...ok, version: 'latest' })).toBeNull();
    expect(parsePending({ ...ok, size: 0 })).toBeNull();
    expect(parsePending({ ...ok, path: 5 })).toBeNull();
    expect(parsePending(null)).toBeNull();
    expect(parsePending('x')).toBeNull();
  });
});

describe('buildSwapScript with verification', () => {
  const base = {
    target: 'C:\\Users\\Ana\\Hologram.exe',
    source: 'C:\\Users\\Ana\\Hologram.update.exe',
    backup: 'C:\\Users\\Ana\\Hologram.old.exe',
    pids: [10],
    relaunch: true,
    verify: {
      markerPath: 'C:\\Users\\Ana\\AppData\\started-ok',
      timeoutSeconds: 90,
      killImage: 'Hologram.exe',
      failureNotePath: 'C:\\Users\\Ana\\AppData\\update-note.txt',
      label: '0.2.1',
    },
  };
  it('waits for the marker and rolls back when it never appears', () => {
    const s = buildSwapScript(base);
    expect(s).toContain('if (Test-Path -LiteralPath $marker) { $ok = $true; break }');
    expect(s).toContain('for ($i = 0; $i -lt 90; $i++)');
    expect(s).toContain("Stop-Process -Name 'Hologram' -Force");
    expect(s).toContain('Move-Item -LiteralPath $backup -Destination $target -Force');
    expect(s).toContain('rolled-back 0.2.1');
  });
  it('deletes the stale marker before relaunching', () => {
    const s = buildSwapScript(base);
    expect(s.indexOf('Remove-Item -LiteralPath $marker')).toBeLessThan(s.indexOf('Start-Process -FilePath $target'));
  });
  it('has no verification section without verify', () => {
    const { verify: _verify, ...plain } = base;
    void _verify;
    expect(buildSwapScript(plain)).not.toContain('$marker');
  });
  it('rejects unsafe values that would reach cmd.exe', () => {
    expect(() => buildSwapScript({ ...base, verify: { ...base.verify, killImage: 'a.exe & calc' } })).toThrow();
    expect(() => buildSwapScript({ ...base, verify: { ...base.verify, label: '1.0 & del *' } })).toThrow();
    expect(() => buildSwapScript({ ...base, verify: { ...base.verify, timeoutSeconds: 0 } })).toThrow();
    expect(() => buildSwapScript({ ...base, verify: { ...base.verify, timeoutSeconds: 9999 } })).toThrow();
  });
});
