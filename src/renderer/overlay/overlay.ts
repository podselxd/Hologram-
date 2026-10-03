import { paletteFor, type Palette } from '../../shared/appearance';
import { FrameStats } from '../../shared/frameStats';
import { FINGERTIPS, HAND_CONNECTIONS, toScreen } from '../../shared/mapping';
import { HandPredictor } from '../../shared/predictor';
import { PROFILES } from '../../shared/profiles';
import { DEFAULT_SETTINGS, type Settings } from '../../shared/settings';
import { LANDMARK_COUNT, MAX_HANDS, type HandFrame, type Profile, type RenderStats } from '../../shared/types';

const api = window.hologram;
const canvas = document.getElementById('scene') as HTMLCanvasElement;
const ctx = canvas.getContext('2d', { alpha: true }) as CanvasRenderingContext2D;

const FLOATS = LANDMARK_COUNT * 2;
const TRAIL = 10;

let profile: Profile = PROFILES.medium;
let degradeLevel = 0; // 0 none, 1 no trails, 2 no glow, 3 render scale 0.75
let scale = 1;
let width = 0;
let height = 0;
let latencyMs = 0;

const predictors = Array.from({ length: MAX_HANDS }, () => new HandPredictor());
const scratch = Array.from({ length: MAX_HANDS }, () => new Float32Array(FLOATS));
const incoming = new Float32Array(FLOATS);
const trails = Array.from({ length: MAX_HANDS }, () => new Float32Array(FINGERTIPS.length * TRAIL * 2));
const trailHead = new Int32Array(MAX_HANDS);
const trailFill = new Int32Array(MAX_HANDS);
const frameStats = new FrameStats(600);
const drawStats = new FrameStats(120);

// ---- sprites -------------------------------------------------------------
function makeSprite(size: number, stops: Array<[number, string]>): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d') as CanvasRenderingContext2D;
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  for (const [o, color] of stops) grad.addColorStop(o, color);
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  return c;
}
let settings: Settings = DEFAULT_SETTINGS;
let palette: Palette = paletteFor(settings.color);
let glowSprite = makeSprite(64, palette.glowStops);
let coreSprite = makeSprite(32, palette.coreStops);

function applySettings(next: Settings): void {
  const colorChanged = next.color !== settings.color;
  settings = next;
  if (colorChanged) {
    palette = paletteFor(settings.color);
    glowSprite = makeSprite(64, palette.glowStops);
    coreSprite = makeSprite(32, palette.coreStops);
  }
}

// ---- sizing --------------------------------------------------------------
function resize(): void {
  scale = degradeLevel >= 3 ? 0.75 : profile.renderScale;
  width = window.innerWidth;
  height = window.innerHeight;
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
}
window.addEventListener('resize', resize);

// ---- incoming data -------------------------------------------------------
api.onFrame((frame: HandFrame) => {
  latencyMs = Math.max(0, Date.now() - frame.t);
  for (const hand of frame.hands) {
    const slot = hand.slot;
    const predictor = predictors[slot];
    if (!predictor) continue;
    for (let i = 0; i < LANDMARK_COUNT; i++) {
      const lm = hand.landmarks[i];
      if (!lm) continue;
      const [x, y] = toScreen(lm.x, lm.y, width, height, settings.mirror);
      incoming[i * 2] = x;
      incoming[i * 2 + 1] = y;
    }
    predictor.push(performance.now(), incoming);
  }
});
api.onProfile((sel) => {
  profile = PROFILES[sel.profile];
  degradeLevel = 0;
  resize();
});
api.onSettings(applySettings);

// ---- drawing -------------------------------------------------------------
function pointRadius(i: number): number {
  if ((FINGERTIPS as readonly number[]).includes(i)) return 7;
  return i === 0 ? 6 : 4.5;
}

function drawHand(slot: number, pts: Float32Array, alpha: number): void {
  const glow = profile.effects.glow && degradeLevel < 2;
  const showTrails = profile.effects.trails && degradeLevel < 1;

  ctx.globalAlpha = alpha;

  ctx.beginPath();
  for (const [a, b] of HAND_CONNECTIONS) {
    ctx.moveTo(pts[a * 2] as number, pts[a * 2 + 1] as number);
    ctx.lineTo(pts[b * 2] as number, pts[b * 2 + 1] as number);
  }
  ctx.lineCap = 'round';
  if (glow) {
    ctx.strokeStyle = palette.halo;
    ctx.lineWidth = 8;
    ctx.stroke();
  }
  ctx.strokeStyle = palette.rim;
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.strokeStyle = palette.line;
  ctx.lineWidth = 1.6;
  ctx.stroke();

  for (let i = 0; i < LANDMARK_COUNT; i++) {
    const x = pts[i * 2] as number;
    const y = pts[i * 2 + 1] as number;
    const r = pointRadius(i) * settings.dotSize;
    if (glow) ctx.drawImage(glowSprite, x - r * 3, y - r * 3, r * 6, r * 6);
    ctx.drawImage(coreSprite, x - r, y - r, r * 2, r * 2);
  }

  if (showTrails) {
    const buf = trails[slot] as Float32Array;
    const head = trailHead[slot] as number;
    const fill = trailFill[slot] as number;
    FINGERTIPS.forEach((tip, k) => {
      buf[(k * TRAIL + head) * 2] = pts[tip * 2] as number;
      buf[(k * TRAIL + head) * 2 + 1] = pts[tip * 2 + 1] as number;
    });
    trailHead[slot] = (head + 1) % TRAIL;
    trailFill[slot] = Math.min(fill + 1, TRAIL);
    ctx.lineWidth = 2;
    for (let k = 0; k < FINGERTIPS.length; k++) {
      for (let j = 1; j < fill; j++) {
        const i0 = (k * TRAIL + ((head - j + TRAIL) % TRAIL)) * 2;
        const i1 = (k * TRAIL + ((head - j + 1 + TRAIL) % TRAIL)) * 2;
        ctx.strokeStyle = palette.trail(0.55 * (1 - j / fill));
        ctx.beginPath();
        ctx.moveTo(buf[i0] as number, buf[i0 + 1] as number);
        ctx.lineTo(buf[i1] as number, buf[i1 + 1] as number);
        ctx.stroke();
      }
    }
  } else {
    trailFill[slot] = 0;
  }
  ctx.globalAlpha = 1;
}

const wasVisible = new Array<boolean>(MAX_HANDS).fill(false);
const lostAt: number[] = [];
let drewLastFrame = false;

function draw(now: number): void {
  // Full clear every frame that has (or had) content: partial clears can leave
  // stale pixels when the compositor swaps buffers. Idle frames cost nothing.
  if (drewLastFrame) ctx.clearRect(0, 0, width, height);

  let drew = false;
  for (let slot = 0; slot < MAX_HANDS; slot++) {
    const predictor = predictors[slot] as HandPredictor;
    const out = scratch[slot] as Float32Array;
    const alpha = predictor.sample(now, out);
    if (alpha <= 0) {
      if (wasVisible[slot]) lostAt.push(now);
      wasVisible[slot] = false;
      trailFill[slot] = 0;
      continue;
    }
    wasVisible[slot] = true;
    drawHand(slot, out, alpha);
    drew = true;
  }
  drewLastFrame = drew;
}

/** Times a hand vanished in the last 5 s: a high number means unstable tracking, not a drawing bug. */
function handsLostRecently(now: number): number {
  while (lostAt.length > 0 && now - (lostAt[0] as number) > 5000) lostAt.shift();
  return lostAt.length;
}

// ---- main loop -----------------------------------------------------------
let lastTs = 0;
function frame(ts: number): void {
  requestAnimationFrame(frame);
  if (lastTs > 0) frameStats.record(ts - lastTs);
  lastTs = ts;
  const t0 = performance.now();
  draw(performance.now());
  drawStats.record(performance.now() - t0);
}

// ---- adaptive quality, reporting (the numbers are shown in the settings window) ----
function renderStats(): RenderStats {
  const s = frameStats.summary();
  return {
    fps: s.avg > 0 ? 1000 / s.avg : 0,
    p50Ms: s.p50,
    p95Ms: s.p95,
    p99Ms: s.p99,
    maxMs: s.max,
    over33Ms: s.over33,
    frames: s.count,
    drawAvgMs: drawStats.summary().avg,
    degradeLevel,
    handsLost: handsLostRecently(performance.now()),
    latencyMs,
  };
}

let slowEvaluations = 0;
let healthyEvaluations = 0;
function adaptQuality(): void {
  const s = frameStats.summary();
  if (s.count < 120) return;
  slowEvaluations = s.p95 > 22 ? slowEvaluations + 1 : 0;
  healthyEvaluations = s.p95 <= 18 && s.over33 === 0 ? healthyEvaluations + 1 : 0;
  if (slowEvaluations >= 2 && degradeLevel < 3) {
    degradeLevel++;
    slowEvaluations = 0;
    frameStats.clear();
    if (degradeLevel === 3) resize();
  } else if (healthyEvaluations >= 5 && degradeLevel > 0) {
    // Ten clean seconds: give one effect level back.
    const wasScaled = degradeLevel === 3;
    degradeLevel--;
    healthyEvaluations = 0;
    frameStats.clear();
    if (wasScaled) resize();
  }
}

setInterval(adaptQuality, 2000);
setInterval(() => api.sendRenderStats(renderStats()), 1000);

// Dev aid: ?bg=<css colour> paints a backdrop so screenshots can check contrast.
const devBg = new URLSearchParams(location.search).get('bg');
if (devBg) document.body.style.background = devBg;

void api.getInit().then((init) => applySettings(init.settings));
resize();
requestAnimationFrame(frame);
