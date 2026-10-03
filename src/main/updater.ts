import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { Transform } from 'node:stream';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/** Pure(ish) update logic: no Electron imports so it can be unit-tested anywhere. */
export const REPO = 'podselxd/Hologram-';
export const EXE_ASSET = 'Hologram.exe';
export const SHA_ASSET = 'Hologram.exe.sha256';

export type Semver = readonly [number, number, number];

export function parseVersion(v: string): Semver | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** True when `candidate` is strictly newer than `current`; unparsable versions never count as newer. */
export function isNewer(candidate: string, current: string): boolean {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if ((a[i] as number) !== (b[i] as number)) return (a[i] as number) > (b[i] as number);
  }
  return false;
}

export interface ReleaseInfo {
  tag: string;
  version: string;
  exeUrl: string;
  exeSize: number;
  shaUrl: string;
}

const DOWNLOAD_PREFIX = `https://github.com/${REPO}/releases/download/`;

/** Extracts the update info from a GitHub `releases/latest` payload, or null if it is unusable. */
export function pickRelease(json: unknown): ReleaseInfo | null {
  if (!json || typeof json !== 'object') return null;
  const r = json as Record<string, unknown>;
  if (r['draft'] === true || r['prerelease'] === true) return null;
  const tag = r['tag_name'];
  if (typeof tag !== 'string' || !parseVersion(tag)) return null;
  const assets = Array.isArray(r['assets']) ? (r['assets'] as unknown[]) : [];
  const find = (name: string): { url: string; size: number } | null => {
    for (const a of assets) {
      if (!a || typeof a !== 'object') continue;
      const o = a as Record<string, unknown>;
      const url = o['browser_download_url'];
      if (o['name'] === name && typeof url === 'string' && url.startsWith(DOWNLOAD_PREFIX)) {
        return { url, size: typeof o['size'] === 'number' ? o['size'] : 0 };
      }
    }
    return null;
  };
  const exe = find(EXE_ASSET);
  const sha = find(SHA_ASSET);
  if (!exe || !sha) return null;
  return { tag, version: tag.replace(/^v/, ''), exeUrl: exe.url, exeSize: exe.size, shaUrl: sha.url };
}

type FetchLike = (url: string, init?: { headers?: Record<string, string> }) => Promise<Response>;

const HEADERS = { 'User-Agent': 'Hologram-updater', Accept: 'application/vnd.github+json' };

/** Returns the latest stable release, or null when there is none / it is malformed. Throws on network errors. */
export async function fetchLatest(fetchImpl: FetchLike): Promise<ReleaseInfo | null> {
  const res = await fetchImpl(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: HEADERS });
  if (res.status === 404) return null; // no stable release published yet
  if (!res.ok) throw new Error(`GitHub API answered HTTP ${res.status}`);
  return pickRelease(await res.json());
}

/** First token of a `sha256sum` style line, validated as 64 hex chars. */
export function parseSha256(text: string): string | null {
  const token = text.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  return /^[0-9a-f]{64}$/.test(token) ? token : null;
}

/**
 * Downloads the new exe next to `destPath`, verifies SHA-256 (and size when known) and only then renames it
 * into place. This detects corruption; it does NOT prove authenticity (the exe is unsigned).
 */
export async function downloadAndVerify(info: ReleaseInfo, destPath: string, fetchImpl: FetchLike): Promise<void> {
  const shaRes = await fetchImpl(info.shaUrl, { headers: HEADERS });
  if (!shaRes.ok) throw new Error(`checksum download failed: HTTP ${shaRes.status}`);
  const expected = parseSha256(await shaRes.text());
  if (!expected) throw new Error('checksum file is not a valid SHA-256');

  const res = await fetchImpl(info.exeUrl, { headers: { 'User-Agent': HEADERS['User-Agent'] } });
  if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`);

  const part = `${destPath}.part`;
  const hash = createHash('sha256');
  let size = 0;
  try {
    await pipeline(
      Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]),
      new Transform({
        transform(chunk: Buffer, _enc, cb) {
          hash.update(chunk);
          size += chunk.length;
          cb(null, chunk);
        },
      }),
      fs.createWriteStream(part),
    );
    if (info.exeSize > 0 && size !== info.exeSize) throw new Error(`size mismatch: got ${size}, expected ${info.exeSize}`);
    const actual = hash.digest('hex');
    if (actual !== expected) throw new Error('SHA-256 mismatch: the download is corrupted');
    fs.renameSync(part, destPath);
  } catch (err) {
    fs.rmSync(part, { force: true });
    throw err;
  }
}

export interface SwapParams {
  /** The exe that is currently installed (the one the user double-clicks). */
  target: string;
  /** The file that must become the new `target`. */
  source: string;
  /** Where the current `target` is kept (so the user can go back). */
  backup: string;
  /** Processes that must be gone before swapping (the app and its portable launcher). */
  pids: number[];
  relaunch: boolean;
}

/** cmd.exe treats % as a variable marker even inside quotes. */
export function cmdEscape(value: string): string {
  return value.replace(/%/g, '%%');
}

/**
 * Batch script run by a detached cmd.exe after the app quits: waits for the app to exit, keeps the old exe as
 * a backup, puts the new one in place and relaunches. Restores the old exe if anything goes wrong.
 */
export function buildSwapScript(p: SwapParams): string {
  const pids = p.pids.filter((n) => Number.isInteger(n) && n > 0);
  if (pids.length === 0) throw new Error('at least one pid is required');
  const lines = [
    '@echo off',
    'setlocal EnableExtensions',
    `set "TARGET=${cmdEscape(p.target)}"`,
    `set "SOURCE=${cmdEscape(p.source)}"`,
    `set "BACKUP=${cmdEscape(p.backup)}"`,
    'set /a N=0',
    ':waitpids',
    'set "ALIVE=0"',
    `for %%P in (${pids.join(' ')}) do (`,
    '  tasklist /FI "PID eq %%P" /NH 2>nul | find /I ".exe" >nul && set "ALIVE=1"',
    ')',
    // No parenthesised block here: %N% would be expanded once, before the loop runs.
    'if not "%ALIVE%"=="1" goto swapinit',
    'set /a N+=1',
    'if %N% GEQ 90 goto fail',
    'ping -n 2 127.0.0.1 >nul',
    'goto waitpids',
    ':swapinit',
    'set /a N=0',
    ':swap',
    'set /a N+=1',
    'if %N% GEQ 30 goto fail',
    'if exist "%BACKUP%" del /F /Q "%BACKUP%" >nul 2>&1',
    'move /Y "%TARGET%" "%BACKUP%" >nul 2>&1',
    'if errorlevel 1 (',
    '  ping -n 2 127.0.0.1 >nul',
    '  goto swap',
    ')',
    'move /Y "%SOURCE%" "%TARGET%" >nul 2>&1',
    'if errorlevel 1 (',
    '  move /Y "%BACKUP%" "%TARGET%" >nul 2>&1',
    '  goto fail',
    ')',
    ...(p.relaunch ? ['start "" "%TARGET%"'] : []),
    'goto done',
    ':fail',
    'echo swap failed>"%TEMP%\\hologram-update-failed.txt"',
    'exit /b 1',
    ':done',
    '(goto) 2>nul & del "%~f0"',
  ];
  return lines.join('\r\n') + '\r\n';
}
