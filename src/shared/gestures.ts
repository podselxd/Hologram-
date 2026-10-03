import type { Landmark } from './types';

/** Rectangle of the camera image (normalised 0..1) that maps to the whole screen. */
export interface Zone {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface GestureConfig {
  zone: Zone;
  mirror: boolean;
  /** Pinch closes below this (distance thumb–finger / hand size)… */
  pinchDown: number;
  /** …and opens above this (hysteresis). */
  pinchUp: number;
  /** 'dwell': holding the cursor still clicks (no pinch needed). */
  clickMode: 'pinch' | 'dwell';
  /** Whether holding an open palm toggles arming (off = arming only from the app/shortcut). */
  palmArming?: boolean;
}

export type GestureMode = 'none' | 'point' | 'pinch' | 'drag' | 'scroll';

export type GestureEvent =
  | { type: 'down' }
  | { type: 'up' }
  | { type: 'rightclick' }
  | { type: 'armed'; armed: boolean }
  /** Vertical scroll in normalised camera units; negative = hand moved up (content follows the hand). */
  | { type: 'scroll'; dy: number };

export interface GestureState {
  armed: boolean;
  mode: GestureMode;
  /** Where the cursor should be, 0..1 of the screen; null when no hand. */
  cursor: { x: number; y: number } | null;
  /** 0..1 while the open palm is being held to toggle arming. */
  armProgress: number;
  /** 0..1: how close thumb and index are to a pinch (for the on-screen meter). */
  pinchProgress: number;
  /** 0..1 while the cursor is held still in dwell mode. */
  dwellProgress: number;
}

/**
 * Extra gain at the edges: the screen border is reached a little before the zone border, so corners do not need
 * the hand at the very edge of the camera image (where tracking gets lost).
 */
export const EDGE_OVERSHOOT = 1.3;

/**
 * The single mapping from camera coordinates to screen (0..1) used by the cursor AND by the drawn hand, so the
 * mouse sits exactly between the drawn thumb and index. `clamp` keeps the cursor on screen.
 */
export function zoneMap(p: { x: number; y: number }, zone: Zone, mirror: boolean, clamp = true): { x: number; y: number } {
  let u = (p.x - zone.x0) / (zone.x1 - zone.x0);
  let v = (p.y - zone.y0) / (zone.y1 - zone.y0);
  if (mirror) u = 1 - u;
  u = (u - 0.5) * EDGE_OVERSHOOT + 0.5;
  v = (v - 0.5) * EDGE_OVERSHOOT + 0.5;
  if (!clamp) return { x: u, y: v };
  return { x: Math.min(1, Math.max(0, u)), y: Math.min(1, Math.max(0, v)) };
}

export function zoneFrom(size: number, offsetY: number): Zone {
  const s = Math.min(1, Math.max(0.3, size));
  const cy = Math.min(1 - s / 2, Math.max(s / 2, 0.5 + offsetY));
  return { x0: 0.5 - s / 2, y0: cy - s / 2, x1: 0.5 + s / 2, y1: cy + s / 2 };
}

/** Sensitivity 0..1: higher = the pinch triggers with fingers further apart. */
export function pinchThresholds(sensitivity: number): { down: number; up: number } {
  const s = Math.min(1, Math.max(0, sensitivity));
  const down = 0.25 + 0.45 * s;
  return { down, up: down + 0.15 };
}

const dist = (a: Landmark | undefined, b: Landmark | undefined): number =>
  a && b ? Math.hypot(a.x - b.x, a.y - b.y) : Infinity;

export interface HandPose {
  size: number;
  pinchIndex: number;
  pinchMiddle: number;
  extended: { thumb: boolean; index: boolean; middle: boolean; ring: boolean; pinky: boolean };
}

export function analyse(lm: Landmark[]): HandPose | null {
  if (lm.length < 21) return null;
  const size = dist(lm[0], lm[9]);
  if (!Number.isFinite(size) || size < 1e-3) return null;
  const ext = (tip: number, pip: number): boolean => dist(lm[0], lm[tip]) > dist(lm[0], lm[pip]) * 1.15;
  return {
    size,
    pinchIndex: dist(lm[4], lm[8]) / size,
    pinchMiddle: dist(lm[4], lm[12]) / size,
    extended: {
      thumb: dist(lm[4], lm[17]) > dist(lm[3], lm[17]) * 1.1,
      index: ext(8, 6),
      middle: ext(12, 10),
      ring: ext(16, 14),
      pinky: ext(20, 18),
    },
  };
}

const ARM_HOLD_MS = 1000;
const ARM_STILL = 0.035;
const LOST_MS = 300;
const DRAG_START = 0.01;
const INERTIA_TAU_S = 0.35;
const INERTIA_STOP = 0.02;
const DWELL_MS = 800;
const DWELL_STILL = 0.012;
const DWELL_REARM = 0.03;

/**
 * Turns a stream of hand landmarks into cursor positions and mouse events. Pure: time is passed in, so it can be
 * tested with recorded sequences. Input events (down/up/right click/scroll) are only emitted while armed.
 */
export class GestureEngine {
  private armed = false;
  private mode: GestureMode = 'none';
  private cursor: { x: number; y: number } | null = null;
  private lastHandAt = -Infinity;
  private pinching = false;
  private dragging = false;
  private downPos: { x: number; y: number } | null = null;
  private rightLatch = false;
  private armStart: number | null = null;
  private armAnchor: { x: number; y: number } | null = null;
  private armLatch = false;
  private armProgress = 0;
  private scrollY: number | null = null;
  private scrollV = 0;
  private lastScrollAt = 0;
  private inertiaV = 0;
  private lastTick = 0;
  private events: GestureEvent[] = [];
  private pinchProgress = 0;
  private dwellStart: number | null = null;
  private dwellAnchor: { x: number; y: number } | null = null;
  private dwellDone = false;
  private dwellProgress = 0;

  constructor(private config: GestureConfig) {}

  configure(config: GestureConfig): void {
    this.config = config;
  }

  get isArmed(): boolean {
    return this.armed;
  }

  setArmed(armed: boolean): void {
    if (armed === this.armed) return;
    if (!armed) this.releaseAll();
    this.armed = armed;
    this.events.push({ type: 'armed', armed });
  }

  takeEvents(): GestureEvent[] {
    const e = this.events;
    this.events = [];
    return e;
  }

  state(): GestureState {
    return {
      armed: this.armed,
      mode: this.mode,
      cursor: this.cursor,
      armProgress: this.armProgress,
      pinchProgress: this.pinchProgress,
      dwellProgress: this.dwellProgress,
    };
  }

  private emit(e: GestureEvent): void {
    if (this.armed) this.events.push(e);
  }

  private releaseAll(): void {
    if (this.pinching && this.armed) this.events.push({ type: 'up' });
    this.pinching = false;
    this.dragging = false;
    this.downPos = null;
    this.scrollY = null;
    this.inertiaV = 0;
  }

  private mapCursor(p: { x: number; y: number }): { x: number; y: number } {
    return zoneMap(p, this.config.zone, this.config.mirror);
  }

  /**
   * `lm` = smoothed landmarks (cursor position); `raw` = unsmoothed ones (gestures), so a pinch is detected the
   * moment it happens instead of after the smoothing catches up.
   */
  onHand(lm: Landmark[], t: number, rawLm?: Landmark[]): void {
    const pose = analyse(rawLm ?? lm);
    if (!pose) return;
    this.lastHandAt = t;
    const { pinchDown, pinchUp } = this.config;
    const thumb = lm[4] as Landmark;
    const index = lm[8] as Landmark;
    // The point between thumb and index barely moves when they pinch together: stable clicks.
    const raw = this.mapCursor({ x: (thumb.x + index.x) / 2, y: (thumb.y + index.y) / 2 });

    // --- arming: open palm held still for 1 s toggles ------------------------------------------------
    const e = pose.extended;
    const openPalm = e.thumb && e.index && e.middle && e.ring && e.pinky && pose.pinchIndex > pinchUp;
    const palm = lm[9] as Landmark;
    if (openPalm && !this.armLatch && this.config.palmArming !== false) {
      if (this.armStart === null || !this.armAnchor || Math.hypot(palm.x - this.armAnchor.x, palm.y - this.armAnchor.y) > ARM_STILL) {
        this.armStart = t;
        this.armAnchor = { x: palm.x, y: palm.y };
      }
      this.armProgress = Math.min(1, (t - this.armStart) / ARM_HOLD_MS);
      if (this.armProgress >= 1) {
        this.setArmed(!this.armed);
        this.armLatch = true; // close the hand before the next toggle
        this.armStart = null;
        this.armProgress = 0;
      }
    } else {
      if (!openPalm) this.armLatch = false;
      this.armStart = null;
      this.armProgress = 0;
    }

    // How close to a pinch: 0 = fingers wide apart (2.5x the threshold), 1 = pinching.
    this.pinchProgress = this.pinching ? 1 : Math.min(1, Math.max(0, (pinchDown * 2.5 - pose.pinchIndex) / (pinchDown * 1.5)));
    const usePinch = this.config.clickMode === 'pinch';

    // --- pinch (left button) with hysteresis -------------------------------------------------------
    if (!usePinch) {
      // dwell mode: no pinch clicks
    } else if (!this.pinching && pose.pinchIndex < pinchDown) {
      this.pinching = true;
      this.dragging = false;
      this.downPos = raw;
      this.inertiaV = 0;
      this.emit({ type: 'down' });
    } else if (this.pinching && pose.pinchIndex > pinchUp) {
      this.pinching = false;
      this.dragging = false;
      this.downPos = null;
      this.emit({ type: 'up' });
    }

    // --- right click: thumb + middle ------------------------------------------------------------------
    if (!this.pinching && !this.rightLatch && pose.pinchMiddle < pinchDown && pose.pinchIndex > pinchUp) {
      this.rightLatch = true;
      this.emit({ type: 'rightclick' });
    } else if (this.rightLatch && pose.pinchMiddle > pinchUp) {
      this.rightLatch = false;
    }

    // --- scroll: index + middle out, ring + pinky folded --------------------------------------------
    const scrollPose = e.index && e.middle && !e.ring && !e.pinky && !this.pinching && pose.pinchMiddle > pinchUp;
    if (scrollPose) {
      if (this.scrollY !== null) {
        const dy = index.y - this.scrollY;
        const dt = Math.max(1e-3, (t - this.lastScrollAt) / 1000);
        this.scrollV = 0.6 * this.scrollV + 0.4 * (dy / dt);
        if (dy !== 0) this.emit({ type: 'scroll', dy });
      }
      this.scrollY = index.y;
      this.lastScrollAt = t;
      this.mode = 'scroll';
    } else {
      if (this.scrollY !== null && Math.abs(this.scrollV) > INERTIA_STOP) this.inertiaV = this.scrollV;
      this.scrollY = null;
      this.scrollV = 0;
    }

    // --- cursor ------------------------------------------------------------------------------------------
    if (this.pinching && this.downPos) {
      if (!this.dragging && Math.hypot(raw.x - this.downPos.x, raw.y - this.downPos.y) > DRAG_START) this.dragging = true;
      this.cursor = this.dragging ? raw : this.downPos; // frozen until it really is a drag
      this.mode = this.dragging ? 'drag' : 'pinch';
    } else if (!scrollPose) {
      this.cursor = raw;
      this.mode = 'point';
    }

    // --- dwell click: cursor held still for 0.8 s ----------------------------------------------------
    if (this.config.clickMode === 'dwell' && this.mode === 'point' && !openPalm) {
      if (!this.dwellAnchor || Math.hypot(raw.x - this.dwellAnchor.x, raw.y - this.dwellAnchor.y) > (this.dwellDone ? DWELL_REARM : DWELL_STILL)) {
        this.dwellAnchor = raw;
        this.dwellStart = t;
        this.dwellDone = false;
      }
      if (!this.dwellDone && this.dwellStart !== null) {
        this.dwellProgress = Math.min(1, (t - this.dwellStart) / DWELL_MS);
        if (this.dwellProgress >= 1) {
          this.emit({ type: 'down' });
          this.emit({ type: 'up' });
          this.dwellDone = true; // move away before the next click
          this.dwellProgress = 0;
        }
      } else {
        this.dwellProgress = 0;
      }
    } else {
      this.dwellAnchor = null;
      this.dwellStart = null;
      this.dwellProgress = 0;
    }
  }

  /** Call regularly (e.g. 60 Hz): handles lost tracking and scroll inertia. */
  tick(t: number): void {
    const dt = this.lastTick ? Math.min(0.1, (t - this.lastTick) / 1000) : 0;
    this.lastTick = t;
    if (t - this.lastHandAt > LOST_MS && this.mode !== 'none') {
      if (this.pinching) this.emit({ type: 'up' });
      this.pinching = false;
      this.dragging = false;
      this.downPos = null;
      this.scrollY = null;
      this.mode = 'none';
      this.cursor = null;
      this.armStart = null;
      this.armProgress = 0;
      this.pinchProgress = 0;
      this.dwellAnchor = null;
      this.dwellProgress = 0;
    }
    if (this.inertiaV !== 0 && dt > 0) {
      this.emit({ type: 'scroll', dy: this.inertiaV * dt });
      this.inertiaV *= Math.exp(-dt / INERTIA_TAU_S);
      if (Math.abs(this.inertiaV) < INERTIA_STOP) this.inertiaV = 0;
    }
  }
}
