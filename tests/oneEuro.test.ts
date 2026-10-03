import { describe, expect, it } from 'vitest';
import { OneEuroFilter } from '../src/shared/oneEuro';

function noise(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296 - 0.5;
  };
}

describe('OneEuroFilter', () => {
  it('returns the first sample unchanged', () => {
    expect(new OneEuroFilter().filter(0.42, 0)).toBe(0.42);
  });

  it('reduces jitter on a still signal', () => {
    const rnd = noise(1);
    const f = new OneEuroFilter(1.2, 0.05, 1);
    let rawVar = 0;
    let filtVar = 0;
    const n = 300;
    for (let i = 0; i < n; i++) {
      const x = 0.5 + rnd() * 0.02;
      const y = f.filter(x, i * 16.7);
      if (i > 30) {
        rawVar += (x - 0.5) ** 2;
        filtVar += (y - 0.5) ** 2;
      }
    }
    expect(filtVar).toBeLessThan(rawVar * 0.5);
  });

  it('follows a fast step quickly', () => {
    const f = new OneEuroFilter(1.2, 0.05, 1);
    for (let i = 0; i < 30; i++) f.filter(0, i * 16.7);
    let y = 0;
    for (let i = 30; i < 36; i++) y = f.filter(1, i * 16.7);
    expect(y).toBeGreaterThan(0.6);
  });

  it('restarts cleanly after reset', () => {
    const f = new OneEuroFilter();
    f.filter(1, 0);
    f.reset();
    expect(f.filter(5, 100)).toBe(5);
  });
});
