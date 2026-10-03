import { screen } from 'electron';
import { GestureEngine, pinchThresholds, zoneFrom, type GestureConfig } from '../shared/gestures';
import type { Settings } from '../shared/settings';
import type { GestureView, HandFrame, HandSample } from '../shared/types';
import { createMouseInput, type MouseInput } from './input';

/** Wheel units per normalised camera unit of hand travel (0.1 of the image ≈ 3 notches). */
const SCROLL_GAIN = 3600;
const TICK_MS = 16;

/**
 * Turns hand frames into a cursor and mouse events. "test" only feeds the overlay's virtual cursor; "on" also
 * drives the real mouse, and only while armed.
 */
export class HandControl {
  private engine: GestureEngine;
  private input: MouseInput | null = null;
  private timer: NodeJS.Timeout | null = null;
  private cursorPx: { x: number; y: number } | null = null;
  private buttonDown = false;
  private wheelAcc = 0;
  private flash: GestureView['flash'];
  private flashUntil = 0;

  constructor(
    private settings: Settings,
    private readonly publish: (view: GestureView) => void,
  ) {
    this.engine = new GestureEngine(this.configFor(settings));
  }

  private configFor(s: Settings): GestureConfig {
    const { down, up } = pinchThresholds(s.pinchSensitivity);
    return { zone: zoneFrom(s.zoneSize, s.zoneOffsetY), mirror: s.mirror, pinchDown: down, pinchUp: up, clickMode: s.clickMode };
  }

  async start(): Promise<void> {
    this.input = await createMouseInput();
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  updateSettings(s: Settings): void {
    const wasOn = this.settings.control === 'on';
    this.settings = s;
    this.engine.configure(this.configFor(s));
    if (wasOn && s.control !== 'on') this.releaseButton();
    if (s.control === 'off') this.engine.setArmed(false);
  }

  toggleArmed(): void {
    if (this.settings.control !== 'off') this.engine.setArmed(!this.engine.isArmed);
  }

  /** MediaPipe labels handedness for a mirrored (selfie) image; the camera image is not mirrored. */
  private pickHand(hands: HandSample[]): HandSample | undefined {
    const label = this.settings.dominantHand === 'right' ? 'Left' : 'Right';
    return hands.find((h) => h.handedness === label) ?? (hands.length === 1 ? hands[0] : undefined) ?? hands[0];
  }

  onFrame(frame: HandFrame): void {
    if (this.settings.control === 'off') return;
    const hand = this.pickHand(frame.hands);
    if (hand) this.engine.onHand(hand.landmarks, Date.now());
  }

  private get live(): boolean {
    return this.settings.control === 'on' && this.engine.isArmed && !!this.input?.available;
  }

  private releaseButton(): void {
    if (this.buttonDown) this.input?.leftUp();
    this.buttonDown = false;
  }

  /** Always call on quit: never leave the left button pressed. */
  stop(): void {
    this.releaseButton();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private tick(): void {
    if (this.settings.control === 'off') {
      this.publish({ control: 'off', armed: false, mode: 'none', cursor: null, armProgress: 0, pinchProgress: 0, dwellProgress: 0 });
      return;
    }
    const now = Date.now();
    this.engine.tick(now);
    const state = this.engine.state();
    const { bounds, scaleFactor } = screen.getPrimaryDisplay();

    // Smooth the 30 fps tracking into ~60 Hz cursor motion (physical pixels for SetCursorPos).
    if (state.cursor) {
      const target = {
        x: (bounds.x + state.cursor.x * bounds.width) * scaleFactor,
        y: (bounds.y + state.cursor.y * bounds.height) * scaleFactor,
      };
      if (!this.cursorPx) this.cursorPx = target;
      const k = state.mode === 'pinch' ? 1 : 0.45; // frozen click position is exact
      this.cursorPx = { x: this.cursorPx.x + (target.x - this.cursorPx.x) * k, y: this.cursorPx.y + (target.y - this.cursorPx.y) * k };
      if (this.live && state.mode !== 'scroll') this.input?.moveTo(this.cursorPx.x, this.cursorPx.y);
    } else {
      this.cursorPx = null;
    }

    for (const e of this.engine.takeEvents()) {
      if (e.type === 'armed') {
        if (!e.armed) this.releaseButton();
        continue;
      }
      if (e.type === 'down') {
        this.setFlash('click', now);
        if (this.live) {
          this.input?.leftDown();
          this.buttonDown = true;
        }
      } else if (e.type === 'up') {
        if (this.buttonDown) this.input?.leftUp();
        this.buttonDown = false;
      } else if (e.type === 'rightclick') {
        this.setFlash('right', now);
        if (this.live) this.input?.rightClick();
      } else if (e.type === 'scroll') {
        this.setFlash('scroll', now);
        // Content follows the hand: hand up (dy < 0) -> content up -> wheel down (negative).
        this.wheelAcc += e.dy * SCROLL_GAIN;
      }
    }
    const whole = Math.trunc(this.wheelAcc);
    if (whole !== 0) {
      if (this.live) this.input?.wheel(whole);
      this.wheelAcc -= whole;
    }
    if (!this.engine.isArmed) this.releaseButton();

    this.publish({
      control: this.settings.control,
      armed: state.armed,
      mode: state.mode,
      cursor: state.cursor,
      armProgress: state.armProgress,
      pinchProgress: state.pinchProgress,
      dwellProgress: state.dwellProgress,
      ...(this.input && !this.input.available && this.settings.control === 'on' ? { inputError: this.input.error } : {}),
      ...(now < this.flashUntil && this.flash ? { flash: this.flash } : {}),
    });
  }

  private setFlash(kind: NonNullable<GestureView['flash']>, now: number): void {
    this.flash = kind;
    this.flashUntil = now + 180;
  }
}
