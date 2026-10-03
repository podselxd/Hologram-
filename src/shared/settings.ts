export type ProfileChoice = 'auto' | 'low' | 'medium' | 'high';
export type HandsChoice = 'auto' | 1 | 2;
export type ColorPreset = 'azul' | 'cian' | 'violeta' | 'verde';
export type AutoUpdate = 'auto' | 'ask';

export interface Settings {
  /** Chosen camera; undefined = system default. */
  deviceId?: string;
  /** Start with hardware acceleration disabled (needs an app restart). */
  safeRender: boolean;
  profile: ProfileChoice;
  hands: HandsChoice;
  hud: boolean;
  /** 0 = most responsive, 1 = smoothest. */
  smoothing: number;
  /** Multiplier for the dot radius. */
  dotSize: number;
  color: ColorPreset;
  /** Mirror horizontally, like looking in a mirror. */
  mirror: boolean;
  /** auto: download and install on the next start; ask: only when the user says so. */
  autoUpdate: AutoUpdate;
}

export const DEFAULT_SETTINGS: Settings = {
  safeRender: false,
  profile: 'auto',
  hands: 'auto',
  hud: true,
  smoothing: 0.5,
  dotSize: 1,
  color: 'azul',
  mirror: true,
  autoUpdate: 'auto',
};

export const LIMITS = { smoothing: [0, 1], dotSize: [0.6, 1.8] } as const;
export const COLORS: readonly ColorPreset[] = ['azul', 'cian', 'violeta', 'verde'];

const clamp = (v: number, [lo, hi]: readonly [number, number]): number => Math.min(hi, Math.max(lo, v));

/** Keeps only the known, valid fields of `raw`. Never throws. */
export function sanitizePatch(raw: unknown): Partial<Settings> {
  const out: Partial<Settings> = {};
  if (!raw || typeof raw !== 'object') return out;
  const r = raw as Record<string, unknown>;
  if (typeof r['deviceId'] === 'string' && r['deviceId'].length <= 512) out.deviceId = r['deviceId'];
  if (typeof r['safeRender'] === 'boolean') out.safeRender = r['safeRender'];
  if (r['profile'] === 'auto' || r['profile'] === 'low' || r['profile'] === 'medium' || r['profile'] === 'high') {
    out.profile = r['profile'];
  }
  if (r['hands'] === 'auto' || r['hands'] === 1 || r['hands'] === 2) out.hands = r['hands'];
  if (typeof r['hud'] === 'boolean') out.hud = r['hud'];
  if (typeof r['smoothing'] === 'number' && Number.isFinite(r['smoothing'])) out.smoothing = clamp(r['smoothing'], LIMITS.smoothing);
  if (typeof r['dotSize'] === 'number' && Number.isFinite(r['dotSize'])) out.dotSize = clamp(r['dotSize'], LIMITS.dotSize);
  if (typeof r['color'] === 'string' && (COLORS as readonly string[]).includes(r['color'])) out.color = r['color'] as ColorPreset;
  if (typeof r['mirror'] === 'boolean') out.mirror = r['mirror'];
  if (r['autoUpdate'] === 'auto' || r['autoUpdate'] === 'ask') out.autoUpdate = r['autoUpdate'];
  return out;
}

export function applyPatch(base: Settings, patch: Partial<Settings>): Settings {
  const next = { ...base, ...patch };
  if (next.deviceId === '') delete next.deviceId;
  return next;
}

/** Settings from disk: defaults + whatever valid fields the file has. */
export function sanitizeSettings(raw: unknown): Settings {
  return applyPatch(DEFAULT_SETTINGS, sanitizePatch(raw));
}
