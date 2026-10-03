import { describe, expect, it } from 'vitest';
import { HandPredictor } from '../src/shared/predictor';
import { toScreen } from '../src/shared/mapping';

const pts = (x: number): Float32Array => new Float32Array(42).fill(x);

describe('HandPredictor', () => {
  it('draws nothing before any sample', () => {
    expect(new HandPredictor().sample(0, new Float32Array(42))).toBe(0);
  });

  it('extrapolates along the last velocity, clamped', () => {
    const p = new HandPredictor({ maxLeadMs: 20, holdMs: 100, dropMs: 200 });
    p.push(0, pts(0));
    p.push(33, pts(33)); // 1 px/ms
    const out = new Float32Array(42);
    expect(p.sample(43, out)).toBe(1);
    expect(out[0]).toBeCloseTo(43); // 33 + 10 ms
    p.sample(90, out);
    expect(out[0]).toBeCloseTo(53); // lead clamped at 20 ms
  });

  it('does not extrapolate from a single sample', () => {
    const p = new HandPredictor();
    p.push(0, pts(7));
    const out = new Float32Array(42);
    p.sample(30, out);
    expect(out[0]).toBe(7);
  });

  it('fades out and then drops', () => {
    const p = new HandPredictor({ maxLeadMs: 0, holdMs: 100, dropMs: 200 });
    p.push(0, pts(1));
    const out = new Float32Array(42);
    expect(p.sample(150, out)).toBeCloseTo(0.5);
    expect(p.sample(200, out)).toBe(0);
  });

  it('does not extrapolate from stale velocity', () => {
    const p = new HandPredictor();
    p.push(0, pts(0));
    p.push(500, pts(100));
    const out = new Float32Array(42);
    p.sample(520, out);
    expect(out[0]).toBe(100);
  });
});

describe('toScreen', () => {
  it('mirrors horizontally', () => {
    expect(toScreen(0, 0, 1920, 1080)).toEqual([1920, 0]);
    expect(toScreen(1, 1, 1920, 1080)).toEqual([0, 1080]);
    expect(toScreen(0.25, 0.5, 100, 100)).toEqual([75, 50]);
  });
});
