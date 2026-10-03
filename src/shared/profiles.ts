import type { DelegateMeasurement, DelegateName, Profile, ProfileName, ProfileSelection } from './types';

export const PROFILES: Record<ProfileName, Profile> = {
  low: {
    name: 'low',
    camera: { width: 640, height: 480, frameRate: 30 },
    renderScale: 0.75,
    effects: { glow: false, trails: false },
  },
  medium: {
    name: 'medium',
    camera: { width: 640, height: 480, frameRate: 60 },
    renderScale: 1,
    effects: { glow: true, trails: false },
  },
  high: {
    name: 'high',
    camera: { width: 1280, height: 720, frameRate: 60 },
    renderScale: 1,
    effects: { glow: true, trails: true },
  },
};

/**
 * p95 inference time (ms, hands in view) required for each profile.
 * 60 fps tracking needs the frame to finish well inside 16.7 ms.
 */
export const THRESHOLDS = {
  high: 12,
  medium: 22,
  low: 33,
  /** Below this the tool is considered unusable: ~25 fps of tracking. */
  minimum: 40,
} as const;

export function profileForP95(p95Ms: number): ProfileName {
  if (p95Ms <= THRESHOLDS.high) return 'high';
  if (p95Ms <= THRESHOLDS.medium) return 'medium';
  return 'low';
}

export interface BenchmarkInput {
  /** Measurements taken with 2 hands enabled, one entry per delegate. */
  twoHands: DelegateMeasurement[];
  /** Optional re-measure with 1 hand on the best delegate (only taken when 2 hands miss the minimum). */
  oneHand?: DelegateMeasurement;
  /** False when no hand was in view while measuring. */
  reliable: boolean;
}

export function chooseProfile(input: BenchmarkInput): ProfileSelection {
  const measurements = [...input.twoHands, ...(input.oneHand ? [input.oneHand] : [])];
  const best = pickFastest(input.twoHands);
  if (!best) {
    return {
      profile: 'low',
      delegate: 'CPU',
      numHands: 2,
      meetsMinimum: false,
      reliable: false,
      reason: 'No measurements available; using the safest profile.',
      measurements,
    };
  }

  if (!input.reliable) {
    return {
      profile: 'low',
      delegate: best.delegate,
      numHands: 2,
      meetsMinimum: false,
      reliable: false,
      reason:
        'Benchmark ran without hands in view, so inference time is under-estimated. ' +
        'Using the low profile; re-run the benchmark with your hands in front of the camera.',
      measurements,
    };
  }

  if (best.p95Ms <= THRESHOLDS.minimum) {
    const profile = profileForP95(best.p95Ms);
    return {
      profile,
      delegate: best.delegate,
      numHands: 2,
      meetsMinimum: true,
      reliable: true,
      reason: `${best.delegate} p95 ${best.p95Ms.toFixed(1)} ms with 2 hands -> ${profile}.`,
      measurements,
    };
  }

  const one = input.oneHand;
  const oneOk = one !== undefined && one.p95Ms <= THRESHOLDS.minimum;
  return {
    profile: 'low',
    delegate: (one ?? best).delegate,
    numHands: oneOk ? 1 : 2,
    meetsMinimum: oneOk,
    reliable: true,
    reason: oneOk
      ? `2 hands too slow (p95 ${best.p95Ms.toFixed(1)} ms); 1 hand p95 ${one.p95Ms.toFixed(1)} ms -> low, 1 hand.`
      : `Too slow even in the low profile (best p95 ${(one ?? best).p95Ms.toFixed(1)} ms): this machine does not meet the minimum.`,
    measurements,
  };
}

function pickFastest(list: DelegateMeasurement[]): DelegateMeasurement | undefined {
  let best: DelegateMeasurement | undefined;
  for (const m of list) {
    if (m.samples > 0 && (!best || m.p95Ms < best.p95Ms)) best = m;
  }
  return best;
}

export function isDelegate(v: unknown): v is DelegateName {
  return v === 'GPU' || v === 'CPU';
}
