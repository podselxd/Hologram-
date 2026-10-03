import { describe, expect, it } from 'vitest';
import { analyse, GestureEngine, pinchThresholds, zoneFrom, zoneMap, type GestureConfig } from '../src/shared/gestures';
import type { Landmark } from '../src/shared/types';

/**
 * Synthetic right hand (image coords, y down), wrist at (cx, cy). Each finger is either extended (pointing up) or
 * folded (tip back near the palm). `pinch` moves the index tip onto the thumb tip, `pinchMid` the middle tip.
 */
function hand(
  opts: { cx?: number; cy?: number; ext?: Partial<Record<'thumb' | 'index' | 'middle' | 'ring' | 'pinky', boolean>>; pinch?: number; pinchMid?: number } = {},
): Landmark[] {
  const cx = opts.cx ?? 0.5;
  const cy = opts.cy ?? 0.7;
  const s = 0.1; // wrist -> middle MCP
  const ext = { thumb: true, index: true, middle: true, ring: true, pinky: true, ...opts.ext };
  const p = (x: number, y: number): Landmark => ({ x: cx + x * s, y: cy + y * s, z: 0 });
  const lm: Landmark[] = new Array(21);
  lm[0] = p(0, 0);
  // thumb 1..4 goes out to the side
  lm[1] = p(-0.4, -0.2);
  lm[2] = p(-0.7, -0.4);
  lm[3] = p(-0.9, -0.6);
  lm[4] = ext.thumb ? p(-1.1, -0.8) : p(-0.5, -0.7);
  const finger = (base: number, x: number, isExt: boolean): void => {
    lm[base] = p(x, -1); // MCP
    lm[base + 1] = p(x, -1.4); // PIP
    lm[base + 2] = isExt ? p(x, -1.7) : p(x, -1.2);
    lm[base + 3] = isExt ? p(x, -2.0) : p(x, -0.9);
  };
  finger(5, -0.3, ext.index);
  finger(9, 0, ext.middle);
  finger(13, 0.3, ext.ring);
  finger(17, 0.55, ext.pinky);
  if (opts.pinch !== undefined) {
    const t = lm[4] as Landmark;
    lm[8] = { x: t.x + opts.pinch * s, y: t.y, z: 0 };
  }
  if (opts.pinchMid !== undefined) {
    const t = lm[4] as Landmark;
    lm[12] = { x: t.x + opts.pinchMid * s, y: t.y, z: 0 };
  }
  return lm;
}

const config = (): GestureConfig => {
  const { down, up } = pinchThresholds(0.5);
  return { zone: zoneFrom(0.6, 0), mirror: true, pinchDown: down, pinchUp: up, clickMode: 'pinch' };
};
const pointing = (o: { cx?: number; cy?: number; pinch?: number } = {}) =>
  hand({ ...o, ext: { thumb: true, index: true, middle: false, ring: false, pinky: false } });

function armed(): GestureEngine {
  const g = new GestureEngine(config());
  g.setArmed(true);
  g.takeEvents();
  return g;
}

describe('pose analysis', () => {
  it('recognises extended and folded fingers', () => {
    const p = analyse(hand({ ext: { ring: false, pinky: false } }));
    expect(p?.extended).toEqual({ thumb: true, index: true, middle: true, ring: false, pinky: false });
  });
  it('measures the pinch relative to hand size', () => {
    expect(analyse(hand({ pinch: 0.05 }))!.pinchIndex).toBeLessThan(0.1);
    expect(analyse(hand())!.pinchIndex).toBeGreaterThan(0.5);
  });
  it('rejects incomplete hands', () => {
    expect(analyse([])).toBeNull();
  });
});

describe('zones and thresholds', () => {
  it('keeps the zone inside the image', () => {
    const z = zoneFrom(0.6, 0.5);
    expect(z.y1).toBeLessThanOrEqual(1);
    expect(z.x1 - z.x0).toBeCloseTo(0.6);
  });
  it('higher sensitivity triggers earlier, with hysteresis', () => {
    const lo = pinchThresholds(0);
    const hi = pinchThresholds(1);
    expect(hi.down).toBeGreaterThan(lo.down);
    expect(lo.up).toBeGreaterThan(lo.down);
  });
});

describe('GestureEngine', () => {
  it('maps the cursor through the zone and mirrors it', () => {
    const g = armed();
    g.onHand(pointing({ cx: 0.5, cy: 0.7 }), 0);
    const left = g.state().cursor!;
    g.onHand(pointing({ cx: 0.35, cy: 0.7 }), 33);
    const moved = g.state().cursor!;
    expect(moved.x).toBeGreaterThan(left.x); // hand moves left in the image -> cursor right (mirror)
    expect(g.state().mode).toBe('point');
  });

  it('emits nothing while disarmed', () => {
    const g = new GestureEngine(config());
    g.onHand(pointing({ pinch: 0.02 }), 0);
    g.onHand(pointing(), 50);
    expect(g.takeEvents()).toEqual([]);
    expect(g.state().cursor).not.toBeNull(); // still shows where it points
  });

  it('pinch gives down/up with hysteresis and a frozen cursor for clicks', () => {
    const g = armed();
    g.onHand(pointing(), 0);
    g.onHand(pointing({ pinch: 0.02 }), 33);
    expect(g.takeEvents()).toEqual([{ type: 'down' }]);
    expect(g.state().mode).toBe('pinch');
    const frozen = g.state().cursor!;
    g.onHand(pointing({ pinch: 0.02, cx: 0.501 }), 66); // tiny jitter: still a click
    expect(g.state().cursor).toEqual(frozen);
    g.onHand(pointing({ pinch: 0.4 }), 99); // between thresholds: still down
    expect(g.takeEvents()).toEqual([]);
    g.onHand(pointing(), 133);
    expect(g.takeEvents()).toEqual([{ type: 'up' }]);
  });

  it('becomes a drag when the hand moves while pinching', () => {
    const g = armed();
    g.onHand(pointing({ pinch: 0.02 }), 0);
    g.onHand(pointing({ pinch: 0.02, cx: 0.45 }), 33);
    expect(g.state().mode).toBe('drag');
  });

  it('releases the button when tracking is lost', () => {
    const g = armed();
    g.onHand(pointing({ pinch: 0.02 }), 0);
    g.takeEvents();
    g.tick(100);
    expect(g.takeEvents()).toEqual([]); // short gap tolerated
    g.tick(400);
    expect(g.takeEvents()).toEqual([{ type: 'up' }]);
    expect(g.state().cursor).toBeNull();
  });

  it('thumb + middle is a right click, once per pinch', () => {
    const g = armed();
    const rc = (pm: number) => hand({ pinchMid: pm, ext: { ring: false, pinky: false } });
    g.onHand(rc(0.02), 0);
    g.onHand(rc(0.02), 33);
    expect(g.takeEvents()).toEqual([{ type: 'rightclick' }]);
    g.onHand(rc(1), 66);
    g.onHand(rc(0.02), 99);
    expect(g.takeEvents()).toEqual([{ type: 'rightclick' }]);
  });

  it('two fingers scroll with the hand and keep some inertia', () => {
    const g = armed();
    const two = (cy: number) => hand({ cy, ext: { thumb: false, index: true, middle: true, ring: false, pinky: false } });
    g.onHand(two(0.7), 0);
    g.onHand(two(0.68), 33); // hand moves up
    const ev = g.takeEvents();
    expect(g.state().mode).toBe('scroll');
    expect(ev[0]).toMatchObject({ type: 'scroll' });
    expect((ev[0] as { dy: number }).dy).toBeLessThan(0);
    g.onHand(pointing(), 66); // leave the pose: inertia continues on ticks
    g.tick(70);
    g.tick(90);
    expect(g.takeEvents().some((e) => e.type === 'scroll')).toBe(true);
    for (let t = 100; t < 3000; t += 16) g.tick(t);
    g.takeEvents();
    g.tick(3016);
    expect(g.takeEvents()).toEqual([]); // inertia died out
  });

  it('open palm held still for 1 s toggles arming, once per hold', () => {
    const g = new GestureEngine(config());
    for (let t = 0; t <= 1000; t += 50) g.onHand(hand(), t);
    expect(g.isArmed).toBe(true);
    expect(g.takeEvents()).toEqual([{ type: 'armed', armed: true }]);
    for (let t = 1050; t <= 2500; t += 50) g.onHand(hand(), t); // still holding: no re-toggle
    expect(g.isArmed).toBe(true);
    g.onHand(pointing(), 2600); // close the hand
    for (let t = 2700; t <= 3800; t += 50) g.onHand(hand(), t);
    expect(g.isArmed).toBe(false);
  });

  it('moving the palm resets the arming countdown', () => {
    const g = new GestureEngine(config());
    for (let t = 0; t <= 1200; t += 50) g.onHand(hand({ cx: 0.3 + t / 3000 }), t);
    expect(g.isArmed).toBe(false);
  });

  it('disarming in the middle of a drag releases the button', () => {
    const g = armed();
    g.onHand(pointing({ pinch: 0.02 }), 0);
    g.takeEvents();
    g.setArmed(false);
    expect(g.takeEvents()).toEqual([{ type: 'up' }, { type: 'armed', armed: false }]);
  });

  it('shows how close the fingers are to a pinch', () => {
    const g = new GestureEngine(config());
    g.onHand(pointing(), 0);
    const wide = g.state().pinchProgress;
    g.onHand(pointing({ pinch: 0.6 }), 33);
    const closer = g.state().pinchProgress;
    expect(closer).toBeGreaterThan(wide);
    g.onHand(pointing({ pinch: 0.02 }), 66);
    expect(g.state().pinchProgress).toBe(1);
  });

  it('dwell mode clicks when the cursor is held still, once, and never on pinch', () => {
    const g = new GestureEngine({ ...config(), clickMode: 'dwell' });
    g.setArmed(true);
    g.takeEvents();
    g.onHand(pointing({ pinch: 0.02 }), 0); // a pinch does nothing in dwell mode
    g.onHand(pointing(), 30);
    g.takeEvents();
    for (let t = 60; t <= 900; t += 30) g.onHand(pointing(), t);
    expect(g.takeEvents()).toEqual([{ type: 'down' }, { type: 'up' }]);
    for (let t = 930; t <= 2500; t += 30) g.onHand(pointing(), t); // still: no repeat
    expect(g.takeEvents()).toEqual([]);
    g.onHand(pointing({ cx: 0.4 }), 2530); // move away, then hold again
    for (let t = 2560; t <= 3500; t += 30) g.onHand(pointing({ cx: 0.4 }), t);
    expect(g.takeEvents()).toEqual([{ type: 'down' }, { type: 'up' }]);
  });

  it('an open palm does nothing when palm arming is off', () => {
    const g = new GestureEngine({ ...config(), palmArming: false });
    for (let t = 0; t <= 1500; t += 50) g.onHand(hand(), t);
    expect(g.isArmed).toBe(false);
    expect(g.state().armProgress).toBe(0);
  });

  it('detects the pinch on raw landmarks even when the smoothed ones lag behind', () => {
    const g = new GestureEngine(config());
    g.setArmed(true);
    g.takeEvents();
    g.onHand(pointing(), 0, pointing({ pinch: 0.02 })); // smoothed still open, raw already pinched
    expect(g.takeEvents()).toEqual([{ type: 'down' }]);
  });

  it('the cursor is exactly the drawn point between thumb and index (same mapping)', () => {
    const cfg = config();
    const g = new GestureEngine(cfg);
    const lm = pointing({ cx: 0.45, cy: 0.65 });
    g.onHand(lm, 0);
    const mid = { x: (lm[4]!.x + lm[8]!.x) / 2, y: (lm[4]!.y + lm[8]!.y) / 2 };
    expect(g.state().cursor).toEqual(zoneMap(mid, cfg.zone, cfg.mirror));
  });

  it('reaches the screen corners before the zone border', () => {
    const z = zoneFrom(0.6, 0);
    const inset = 0.06; // 6 % of the image inside the zone border
    expect(zoneMap({ x: z.x1 - inset, y: z.y0 + inset }, z, true)).toEqual({ x: 0, y: 0 });
    expect(zoneMap({ x: z.x0 + inset, y: z.y1 - inset }, z, true)).toEqual({ x: 1, y: 1 });
    const c = zoneMap({ x: 0.5, y: z.y0 + (z.y1 - z.y0) / 2 }, z, true); // centred
    expect(c.x).toBeCloseTo(0.5);
    expect(c.y).toBeCloseTo(0.5);
  });
});
