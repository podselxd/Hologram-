import { describe, expect, it } from 'vitest';
import { chooseProfile, profileForP95, THRESHOLDS } from '../src/shared/profiles';
import type { DelegateMeasurement } from '../src/shared/types';

const m = (delegate: 'GPU' | 'CPU', p95Ms: number, numHands: 1 | 2 = 2, samples = 45): DelegateMeasurement => ({
  delegate,
  numHands,
  samples,
  p50Ms: p95Ms * 0.8,
  p95Ms,
});

describe('profileForP95', () => {
  it('maps inference time to a profile', () => {
    expect(profileForP95(THRESHOLDS.high)).toBe('high');
    expect(profileForP95(THRESHOLDS.high + 0.1)).toBe('medium');
    expect(profileForP95(THRESHOLDS.medium + 0.1)).toBe('low');
  });
});

describe('chooseProfile', () => {
  it('picks the faster delegate', () => {
    const sel = chooseProfile({ twoHands: [m('GPU', 9), m('CPU', 18)], reliable: true });
    expect(sel.delegate).toBe('GPU');
    expect(sel.profile).toBe('high');
    expect(sel.meetsMinimum).toBe(true);
    expect(sel.numHands).toBe(2);
  });

  it('does not trust a benchmark taken without hands', () => {
    const sel = chooseProfile({ twoHands: [m('GPU', 2)], reliable: false });
    expect(sel.profile).toBe('low');
    expect(sel.reliable).toBe(false);
    expect(sel.meetsMinimum).toBe(false);
  });

  it('falls back to one hand when two are too slow', () => {
    const sel = chooseProfile({ twoHands: [m('CPU', 55)], oneHand: m('CPU', 30, 1), reliable: true });
    expect(sel.numHands).toBe(1);
    expect(sel.profile).toBe('low');
    expect(sel.meetsMinimum).toBe(true);
  });

  it('reports a machine that misses the minimum', () => {
    const sel = chooseProfile({ twoHands: [m('CPU', 80)], oneHand: m('CPU', 60, 1), reliable: true });
    expect(sel.meetsMinimum).toBe(false);
    expect(sel.reason).toMatch(/no cumple el mínimo/);
  });

  it('survives having no measurements', () => {
    const sel = chooseProfile({ twoHands: [], reliable: true });
    expect(sel.profile).toBe('low');
    expect(sel.meetsMinimum).toBe(false);
  });
});
