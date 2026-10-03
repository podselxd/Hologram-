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
}

export interface CameraInfo {
  deviceId: string;
  label: string;
}

export interface InitConfig {
  mode: 'camera' | 'video';
  deviceId?: string;
  /** Skip the benchmark and force a profile. */
  profileOverride?: ProfileName;
  forceHands?: 1 | 2;
  hud: boolean;
}

export type Command =
  | { type: 'toggle-hud' }
  | { type: 'set-camera'; deviceId: string }
  | { type: 'rerun-benchmark' };
