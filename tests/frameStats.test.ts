import { describe, expect, it } from 'vitest';
import { FrameStats, percentile } from '../src/shared/frameStats';

describe('percentile', () => {
  it('uses nearest rank', () => {
    const sorted = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(sorted, 0.5)).toBe(50);
    expect(percentile(sorted, 0.95)).toBe(95);
    expect(percentile(sorted, 0.99)).toBe(99);
    expect(percentile(sorted, 1)).toBe(100);
  });
  it('handles empty input', () => {
    expect(percentile([], 0.5)).toBe(0);
  });
});

describe('FrameStats', () => {
  it('summarises and counts slow frames', () => {
    const s = new FrameStats(10);
    for (let i = 0; i < 9; i++) s.record(16.7);
    s.record(40);
    const sum = s.summary();
    expect(sum.count).toBe(10);
    expect(sum.max).toBe(40);
    expect(sum.over33).toBe(1);
    expect(sum.p50).toBeCloseTo(16.7);
  });

  it('keeps only the newest samples', () => {
    const s = new FrameStats(3);
    [1, 2, 3, 4, 5].forEach((v) => s.record(v));
    expect(s.recent(10)).toEqual([3, 4, 5]);
    expect(s.summary().count).toBe(3);
  });

  it('clears', () => {
    const s = new FrameStats(3);
    s.record(5);
    s.clear();
    expect(s.summary().count).toBe(0);
  });
});
