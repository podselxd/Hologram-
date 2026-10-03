/**
 * One-Euro filter (Casiez et al., CHI 2012): low latency when the signal moves
 * fast, strong smoothing when it is almost still.
 */
export class OneEuroFilter {
  private xPrev = 0;
  private dxPrev = 0;
  private tPrev = 0;
  private initialised = false;

  constructor(
    private readonly minCutoff = 1.2,
    private readonly beta = 0.05,
    private readonly dCutoff = 1.0,
  ) {}

  reset(): void {
    this.initialised = false;
  }

  /** `tMs` must be monotonically increasing; values are in signal units. */
  filter(x: number, tMs: number): number {
    if (!this.initialised) {
      this.initialised = true;
      this.xPrev = x;
      this.dxPrev = 0;
      this.tPrev = tMs;
      return x;
    }
    const dt = Math.max((tMs - this.tPrev) / 1000, 1e-3);
    this.tPrev = tMs;
    const dx = (x - this.xPrev) / dt;
    const aD = smoothingFactor(dt, this.dCutoff);
    const dxHat = aD * dx + (1 - aD) * this.dxPrev;
    const cutoff = this.minCutoff + this.beta * Math.abs(dxHat);
    const a = smoothingFactor(dt, cutoff);
    const xHat = a * x + (1 - a) * this.xPrev;
    this.xPrev = xHat;
    this.dxPrev = dxHat;
    return xHat;
  }
}

function smoothingFactor(dtSeconds: number, cutoff: number): number {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dtSeconds);
}
