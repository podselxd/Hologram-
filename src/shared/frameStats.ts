export interface FrameSummary {
  count: number;
  avg: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  /** Samples above 33.4 ms (i.e. slower than 30 fps). */
  over33: number;
}

/** Fixed-size ring buffer of timings with percentile summaries. */
export class FrameStats {
  private readonly buf: Float64Array;
  private next = 0;
  private size = 0;

  constructor(capacity = 600) {
    this.buf = new Float64Array(capacity);
  }

  record(ms: number): void {
    this.buf[this.next] = ms;
    this.next = (this.next + 1) % this.buf.length;
    if (this.size < this.buf.length) this.size++;
  }

  clear(): void {
    this.next = 0;
    this.size = 0;
  }

  summary(): FrameSummary {
    const n = this.size;
    if (n === 0) return { count: 0, avg: 0, p50: 0, p95: 0, p99: 0, max: 0, over33: 0 };
    const sorted = Array.from(this.buf.subarray(0, n)).sort((a, b) => a - b);
    let sum = 0;
    let over33 = 0;
    for (const v of sorted) {
      sum += v;
      if (v > 33.4) over33++;
    }
    return {
      count: n,
      avg: sum / n,
      p50: percentile(sorted, 0.5),
      p95: percentile(sorted, 0.95),
      p99: percentile(sorted, 0.99),
      max: sorted[n - 1] ?? 0,
      over33,
    };
  }

  /** Most recent samples, oldest first (for the HUD graph). */
  recent(count: number): number[] {
    const n = Math.min(count, this.size);
    const out: number[] = [];
    for (let i = n; i >= 1; i--) {
      out.push(this.buf[(this.next - i + this.buf.length) % this.buf.length] ?? 0);
    }
    return out;
  }
}

/** Nearest-rank percentile on an ascending-sorted array. */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil(p * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1] ?? 0;
}
