import type { Settings } from './settings';

export interface Landmark {
  x: number;
  y: number;
  z: number;
}

export type Handedness = 'Left' | 'Right';

export const LANDMARK_COUNT = 21;
export const MAX_HANDS = 2;

export interface HandSample {
  /** Stable slot (0 = leftmost on the camera image, 1 = the other one). */
  slot: number;
  handedness: Handedness;
  score: number;
  /** 21 MediaPipe landmarks, normalised to the camera image (0..1). */
  landmarks: Landmark[];
}

export interface HandFrame {
  /** Estimated capture time, epoch milliseconds. */
  t: number;
  inferenceMs: number;
  hands: HandSample[];
}

export type ProfileName = 'low' | 'medium' | 'high';
export type DelegateName = 'GPU' | 'CPU';

export interface Profile {
  name: ProfileName;
  camera: { width: number; height: number; frameRate: number };
  /** Multiplier applied to the overlay canvas resolution. */
  renderScale: number;
  effects: { glow: boolean; trails: boolean };
}

export interface ProfileSelection {
  profile: ProfileName;
  delegate: DelegateName;
  numHands: 1 | 2;
  /** True when the measured inference time meets the minimum requirement. */
  meetsMinimum: boolean;
  /** False when the benchmark ran without hands in view (numbers not trusted). */
  reliable: boolean;
  /** True when the profile was fixed by hand: performance was NOT measured. */
  forced?: boolean;
  reason: string;
  measurements: DelegateMeasurement[];
}

export interface DelegateMeasurement {
  delegate: DelegateName;
  numHands: 1 | 2;
  samples: number;
  p50Ms: number;
  p95Ms: number;
}

export interface TrackerStats {
  cameraFps: number;
  inferenceAvgMs: number;
  inferenceP95Ms: number;
  delegate: DelegateName;
  numHands: 1 | 2;
  source: string;
  resolution: string;
  /** True while the overlay is hidden and the camera is released. */
  paused: boolean;
}

export interface RenderStats {
  fps: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  over33Ms: number;
  frames: number;
  drawAvgMs: number;
  degradeLevel: number;
  /** Times a hand vanished in the last 5 s (high = unstable tracking). */
  handsLost: number;
  /** Capture-to-draw latency of the last frame, ms. */
  latencyMs: number;
}

export interface CameraInfo {
  deviceId: string;
  label: string;
}

export interface InitConfig {
  mode: 'camera' | 'video';
  settings: Settings;
  /** From the command line only; they take precedence over the saved settings. */
  profileOverride?: ProfileName;
  forceHands?: 1 | 2;
}

export type Command =
  | { type: 'rerun-benchmark' }
  | { type: 'set-paused'; paused: boolean }
  | { type: 'set-preview'; enabled: boolean };

/** Actions the settings window may ask the main process to run. */
export type SettingsCommand = 'rerun-benchmark' | 'toggle-overlay' | 'quit';
export type UpdateAction = 'check' | 'download' | 'apply' | 'rollback';

export interface UpdateSnapshot {
  enabled: boolean;
  version: string;
  state: 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'error';
  latest?: string;
  canRollback: boolean;
  message?: string;
}

/** Downscaled JPEG of the camera image, sent only while the settings preview is on. */
export interface PreviewImage {
  width: number;
  height: number;
  data: Uint8Array;
}
