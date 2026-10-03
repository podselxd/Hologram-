import { LANDMARK_COUNT } from './types';

const FLOATS = LANDMARK_COUNT * 2;

export interface PredictorOptions {
  /** Never extrapolate further than this past the newest sample. */
  maxLeadMs: number;
  /** Fully opaque until this age; then fades out. */
  holdMs: number;
  /** Gone after this age. */
  dropMs: number;
}

export const DEFAULT_PREDICTOR: PredictorOptions = { maxLeadMs: 45, holdMs: 120, dropMs: 280 };

/**
 * Lets the renderer draw at display rate even though the camera/inference
 * delivers fewer samples: linear extrapolation from the last two samples,
 * clamped, with a fade-out when tracking is lost. No allocation per frame.
 */
export class HandPredictor {
  private readonly p0 = new Float32Array(FLOATS);
  private readonly p1 = new Float32Array(FLOATS);
  private t0 = 0;
  private t1 = 0;
  private count = 0;

  constructor(private readonly opts: PredictorOptions = DEFAULT_PREDICTOR) {}

  /** `points` is x,y interleaved in screen/canvas space. */
  push(t: number, points: Float32Array): void {
    this.p0.set(this.p1);
    this.t0 = this.t1;
    this.p1.set(points.subarray(0, FLOATS));
    this.t1 = t;
    this.count = Math.min(this.count + 1, 2);
  }

  clear(): void {
    this.count = 0;
  }

  /** Writes predicted points into `out`; returns opacity 0..1 (0 = nothing to draw). */
  sample(now: number, out: Float32Array): number {
    if (this.count === 0) return 0;
    const age = now - this.t1;
    if (age >= this.opts.dropMs) return 0;

    let lead = Math.min(Math.max(age, 0), this.opts.maxLeadMs);
    if (this.count < 2) lead = 0;
    const span = Math.max(this.t1 - this.t0, 1);
    // Samples arriving far apart mean the velocity is stale: do not extrapolate.
    if (span > 120) lead = 0;
    const k = lead / span;
    for (let i = 0; i < FLOATS; i++) {
      const a = this.p1[i] as number;
      out[i] = a + (a - (this.p0[i] as number)) * k;
    }
    if (age <= this.opts.holdMs) return 1;
    return 1 - (age - this.opts.holdMs) / (this.opts.dropMs - this.opts.holdMs);
  }
}
