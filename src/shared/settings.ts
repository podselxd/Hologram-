export type ProfileChoice = 'auto' | 'low' | 'medium' | 'high';
export type HandsChoice = 'auto' | 1 | 2;
export type ColorPreset = 'azul' | 'cian' | 'violeta' | 'verde';
export type AutoUpdate = 'auto' | 'ask';
export type CameraBackend = 'auto' | 'directshow';
export type ControlMode = 'off' | 'test' | 'on';
export type DominantHand = 'right' | 'left';
export type ClickMode = 'pinch' | 'dwell';

export interface Settings {
  /** Chosen camera; undefined = system default. */
  deviceId?: string;
  /** Start with hardware acceleration disabled (needs an app restart). */
  safeRender: boolean;
  profile: ProfileChoice;
  hands: HandsChoice;
  /** 0 = most responsive, 1 = smoothest. */
  smoothing: number;
  /** Multiplier for the dot radius. */
  dotSize: number;
  color: ColorPreset;
  /** Mirror horizontally, like looking in a mirror. */
  mirror: boolean;
  /** auto: download and install on the next start; ask: only when the user says so. */
  autoUpdate: AutoUpdate;
  /** Windows capture API; 'directshow' is a compatibility fallback (needs a restart). */
  cameraBackend: CameraBackend;
  /** off: only draw the hands; test: draw a virtual cursor; on: move the real mouse (when armed). */
  control: ControlMode;
  dominantHand: DominantHand;
  /** Size of the camera area mapped to the screen (smaller = less arm movement). */
  zoneSize: number;
  /** Vertical shift of that area (negative = higher in the image). */
  zoneOffsetY: number;
  /** Higher = the pinch triggers with the fingers further apart. */
  pinchSensitivity: number;
  /** pinch: thumb+index; dwell: hold the cursor still to click. */
  clickMode: ClickMode;
}

export const DEFAULT_SETTINGS: Settings = {
  safeRender: false,
  profile: 'auto',
  hands: 'auto',
  smoothing: 0.5,
  dotSize: 1,
  color: 'azul',
  mirror: true,
  autoUpdate: 'auto',
  cameraBackend: 'auto',
  control: 'test',
  dominantHand: 'right',
  zoneSize: 0.6,
  zoneOffsetY: -0.05,
  pinchSensitivity: 0.5,
  clickMode: 'pinch',
};

export const LIMITS = {
  smoothing: [0, 1],
  dotSize: [0.6, 1.8],
  zoneSize: [0.3, 1],
  zoneOffsetY: [-0.3, 0.3],
  pinchSensitivity: [0, 1],
} as const;
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
  if (typeof r['smoothing'] === 'number' && Number.isFinite(r['smoothing'])) out.smoothing = clamp(r['smoothing'], LIMITS.smoothing);
  if (typeof r['dotSize'] === 'number' && Number.isFinite(r['dotSize'])) out.dotSize = clamp(r['dotSize'], LIMITS.dotSize);
  if (typeof r['color'] === 'string' && (COLORS as readonly string[]).includes(r['color'])) out.color = r['color'] as ColorPreset;
  if (typeof r['mirror'] === 'boolean') out.mirror = r['mirror'];
  if (r['autoUpdate'] === 'auto' || r['autoUpdate'] === 'ask') out.autoUpdate = r['autoUpdate'];
  if (r['cameraBackend'] === 'auto' || r['cameraBackend'] === 'directshow') out.cameraBackend = r['cameraBackend'];
  if (r['control'] === 'off' || r['control'] === 'test' || r['control'] === 'on') out.control = r['control'];
  if (r['dominantHand'] === 'right' || r['dominantHand'] === 'left') out.dominantHand = r['dominantHand'];
  if (r['clickMode'] === 'pinch' || r['clickMode'] === 'dwell') out.clickMode = r['clickMode'];
  for (const key of ['zoneSize', 'zoneOffsetY', 'pinchSensitivity'] as const) {
    const v = r[key];
    if (typeof v === 'number' && Number.isFinite(v)) out[key] = clamp(v, LIMITS[key]);
  }
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
