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
export async function downloadAndVerify(
  info: ReleaseInfo,
  destPath: string,
  fetchImpl: FetchLike,
): Promise<{ sha256: string; size: number }> {
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
    return { sha256: actual, size };
  } catch (err) {
    fs.rmSync(part, { force: true });
    throw err;
  }
}

export interface SwapVerify {
  /** The new version must create this file (the app writes it a few seconds after starting). */
  markerPath: string;
  /** If the marker does not appear in time, the old exe is restored. */
  timeoutSeconds: number;
  /** Image name killed before restoring (the failed new version), e.g. "Hologram.exe". */
  killImage: string;
  /** Written when a rollback happened, so the restored app can tell the user. */
  failureNotePath: string;
  /** Version being installed (digits and dots), only used in the failure note. */
  label: string;
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
  /** Health check with automatic rollback. Omit for a plain swap (manual rollback). */
  verify?: SwapVerify;
}

/** PowerShell single-quoted literal: only the quote itself needs escaping. */
export function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

const SAFE_IMAGE = /^[A-Za-z0-9._-]+\.exe$/;
const SAFE_LABEL = /^[0-9.]{1,32}$/;

/**
 * PowerShell script run detached after the app quits: waits for the app to exit, keeps the old exe as a backup,
 * puts the new one in place and relaunches. With `verify`, waits for the new version to prove it started and
 * otherwise restores the old exe. Only built-in cmdlets are used: a detached process has no console, and every
 * external console program (tasklist, find, ping…) would pop up its own window — that was the flashing window.
 */
export function buildSwapScript(p: SwapParams): string {
  const pids = p.pids.filter((n) => Number.isInteger(n) && n > 0);
  if (pids.length === 0) throw new Error('at least one pid is required');
  const v = p.verify;
  if (v) {
    if (!SAFE_IMAGE.test(v.killImage)) throw new Error('unsafe image name');
    if (!SAFE_LABEL.test(v.label)) throw new Error('unsafe version label');
    if (!Number.isInteger(v.timeoutSeconds) || v.timeoutSeconds < 1 || v.timeoutSeconds > 600) {
      throw new Error('invalid verify timeout');
    }
  }
  const relaunch = p.relaunch ? ['Start-Process -FilePath $target'] : [];
  const lines = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `$target = ${psQuote(p.target)}`,
    `$source = ${psQuote(p.source)}`,
    `$backup = ${psQuote(p.backup)}`,
    `$failNote = Join-Path $env:TEMP 'hologram-update-failed.txt'`,
    ...(v ? [`$marker = ${psQuote(v.markerPath)}`, `$note = ${psQuote(v.failureNotePath)}`] : []),
    `$waitFor = @(${pids.join(', ')})`,
    '# 1. wait for the app to exit (max 90 s)',
    '$alive = $true',
    'for ($i = 0; $i -lt 90; $i++) {',
    '  $alive = $false',
    '  foreach ($id in $waitFor) { if (Get-Process -Id $id -ErrorAction SilentlyContinue) { $alive = $true } }',
    '  if (-not $alive) { break }',
    '  Start-Sleep -Seconds 1',
    '}',
    "if ($alive) { Set-Content -LiteralPath $failNote -Value 'swap failed: app still running'; exit 1 }",
    '# 2. keep the current exe as backup (retry: the portable launcher may hold it a moment longer)',
    '$moved = $false',
    'for ($i = 0; $i -lt 30; $i++) {',
    '  if (Test-Path -LiteralPath $backup) { Remove-Item -LiteralPath $backup -Force }',
    '  try { Move-Item -LiteralPath $target -Destination $backup -Force -ErrorAction Stop; $moved = $true; break } catch { Start-Sleep -Seconds 1 }',
    '}',
    "if (-not $moved) { Set-Content -LiteralPath $failNote -Value 'swap failed: exe locked'; exit 1 }",
    '# 3. put the new exe in place, or restore the old one',
    'try { Move-Item -LiteralPath $source -Destination $target -Force -ErrorAction Stop } catch {',
    '  Move-Item -LiteralPath $backup -Destination $target -Force',
    "  Set-Content -LiteralPath $failNote -Value 'swap failed: new exe missing'",
    '  exit 1',
    '}',
    ...(v ? ['Remove-Item -LiteralPath $marker -Force'] : []),
    ...relaunch,
    ...(v
      ? [
          '# 4. the new version must write its marker in time, else roll back',
          '$ok = $false',
          `for ($i = 0; $i -lt ${v.timeoutSeconds}; $i++) {`,
          '  if (Test-Path -LiteralPath $marker) { $ok = $true; break }',
          '  Start-Sleep -Seconds 1',
          '}',
          'if (-not $ok) {',
          `  Stop-Process -Name ${psQuote(v.killImage.replace(/\.exe$/, ''))} -Force`,
          '  Start-Sleep -Seconds 2',
          '  for ($i = 0; $i -lt 15; $i++) {',
          '    Remove-Item -LiteralPath $target -Force',
          '    if (-not (Test-Path -LiteralPath $target)) { break }',
          '    Start-Sleep -Seconds 1',
          '  }',
          `  if (Test-Path -LiteralPath $target) { Set-Content -LiteralPath $note -Value 'rollback-failed ${v.label}'; exit 2 }`,
          '  Move-Item -LiteralPath $backup -Destination $target -Force',
          `  Set-Content -LiteralPath $note -Value 'rolled-back ${v.label}'`,
          ...relaunch.map((l) => `  ${l}`),
          '  exit 1',
          '}',
        ]
      : []),
    'Remove-Item -LiteralPath $PSCommandPath -Force',
    'exit 0',
  ];
  return lines.join('\r\n') + '\r\n';
}

/** Auto-install is only allowed inside the same major version; anything bigger needs the user. */
export function isAutoUpdateAllowed(current: string, candidate: string): boolean {
  const a = parseVersion(current);
  const b = parseVersion(candidate);
  return !!a && !!b && a[0] === b[0] && isNewer(candidate, current);
}

export interface PendingUpdate {
  version: string;
  path: string;
  sha256: string;
  size: number;
  /** How many times applying it was already attempted (guards against restart loops). */
  attempts: number;
}

export function parsePending(raw: unknown): PendingUpdate | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (
    typeof r['version'] !== 'string' ||
    !parseVersion(r['version']) ||
    typeof r['path'] !== 'string' ||
    typeof r['sha256'] !== 'string' ||
    !/^[0-9a-f]{64}$/.test(r['sha256']) ||
    typeof r['size'] !== 'number' ||
    !Number.isFinite(r['size']) ||
    r['size'] <= 0
  ) {
    return null;
  }
  const attempts = typeof r['attempts'] === 'number' && Number.isInteger(r['attempts']) && r['attempts'] >= 0 ? r['attempts'] : 0;
  return { version: r['version'], path: r['path'], sha256: r['sha256'], size: r['size'], attempts };
}

/** SHA-256 of a file, streamed (the exe is ~100 MB). */
export async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}
