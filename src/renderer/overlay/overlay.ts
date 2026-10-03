import { FrameStats } from '../../shared/frameStats';
import { FINGERTIPS, HAND_CONNECTIONS, toScreen } from '../../shared/mapping';
import { HandPredictor } from '../../shared/predictor';
import { PROFILES } from '../../shared/profiles';
import { LANDMARK_COUNT, MAX_HANDS, type HandFrame, type Profile, type RenderStats, type TrackerStats } from '../../shared/types';

const api = window.hologram;
const canvas = document.getElementById('scene') as HTMLCanvasElement;
const ctx = canvas.getContext('2d', { alpha: true, desynchronized: true }) as CanvasRenderingContext2D;
const hud = document.getElementById('hud') as HTMLElement;
const hudText = document.getElementById('hudText') as HTMLElement;
const graph = document.getElementById('graph') as HTMLCanvasElement;
const graphCtx = graph.getContext('2d') as CanvasRenderingContext2D;

const FLOATS = LANDMARK_COUNT * 2;
const TRAIL = 10;

let profile: Profile = PROFILES.medium;
let profileLabel = 'medium (pendiente de benchmark)';
let degradeLevel = 0; // 0 none, 1 no trails, 2 no glow, 3 render scale 0.75
let scale = 1;
let width = 0;
let height = 0;
let status = 'Iniciando…';
let trackerStats: TrackerStats | null = null;
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
// Saturated blue with a darker rim: stays readable on white windows as well as dark ones.
const glowSprite = makeSprite(64, [[0, 'rgba(60,160,255,0.35)'], [0.5, 'rgba(40,130,255,0.12)'], [1, 'rgba(40,130,255,0)']]);
const coreSprite = makeSprite(32, [
  [0, 'rgba(245,252,255,1)'],
  [0.3, 'rgba(110,205,255,0.98)'],
  [0.62, 'rgba(40,140,255,0.95)'],
  [0.85, 'rgba(15,70,170,0.85)'],
  [1, 'rgba(15,70,170,0)'],
]);

// ---- sizing --------------------------------------------------------------
function resize(): void {
  scale = degradeLevel >= 3 ? 0.75 : profile.renderScale;
  width = window.innerWidth;
  height = window.innerHeight;
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  prevBox.valid = false;
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
      const [x, y] = toScreen(lm.x, lm.y, width, height);
      incoming[i * 2] = x;
      incoming[i * 2 + 1] = y;
    }
    predictor.push(performance.now(), incoming);
  }
});
api.onStats((s) => (trackerStats = s));
api.onStatus((m) => (status = m));
api.onProfile((sel) => {
  profile = PROFILES[sel.profile];
  profileLabel = `${sel.profile} (${sel.delegate}, ${sel.numHands} mano${sel.numHands > 1 ? 's' : ''})${sel.meetsMinimum ? '' : ' [bajo mínimo]'}`;
  degradeLevel = 0;
  resize();
});
api.onCommand((c) => {
  if (c.type === 'toggle-hud') hud.classList.toggle('hidden');
});

// ---- drawing -------------------------------------------------------------
const prevBox = { valid: false, x0: 0, y0: 0, x1: 0, y1: 0 };
const curBox = { x0: 0, y0: 0, x1: 0, y1: 0 };

function includePoint(x: number, y: number): void {
  if (x < curBox.x0) curBox.x0 = x;
  if (y < curBox.y0) curBox.y0 = y;
  if (x > curBox.x1) curBox.x1 = x;
  if (y > curBox.y1) curBox.y1 = y;
}

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
    ctx.strokeStyle = 'rgba(40,130,255,0.22)';
    ctx.lineWidth = 8;
    ctx.stroke();
  }
  ctx.strokeStyle = 'rgba(10,50,120,0.55)';
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.strokeStyle = 'rgba(130,215,255,0.95)';
  ctx.lineWidth = 1.6;
  ctx.stroke();

  for (let i = 0; i < LANDMARK_COUNT; i++) {
    const x = pts[i * 2] as number;
    const y = pts[i * 2 + 1] as number;
    includePoint(x, y);
    const r = pointRadius(i);
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
        ctx.strokeStyle = `rgba(70,170,255,${(0.55 * (1 - j / fill)).toFixed(3)})`;
        ctx.beginPath();
        ctx.moveTo(buf[i0] as number, buf[i0 + 1] as number);
        ctx.lineTo(buf[i1] as number, buf[i1 + 1] as number);
        ctx.stroke();
        includePoint(buf[i0] as number, buf[i0 + 1] as number);
      }
    }
  } else {
    trailFill[slot] = 0;
  }
  ctx.globalAlpha = 1;
}

function draw(now: number): void {
  curBox.x0 = curBox.y0 = Infinity;
  curBox.x1 = curBox.y1 = -Infinity;

  // Clear only where something was drawn last frame.
  if (prevBox.valid) {
    const pad = 70;
    ctx.clearRect(prevBox.x0 - pad, prevBox.y0 - pad, prevBox.x1 - prevBox.x0 + pad * 2, prevBox.y1 - prevBox.y0 + pad * 2);
    prevBox.valid = false;
  }

  let drew = false;
  for (let slot = 0; slot < MAX_HANDS; slot++) {
    const predictor = predictors[slot] as HandPredictor;
    const out = scratch[slot] as Float32Array;
    const alpha = predictor.sample(now, out);
    if (alpha <= 0) {
      trailFill[slot] = 0;
      continue;
    }
    drawHand(slot, out, alpha);
    drew = true;
  }
  if (drew) {
    prevBox.valid = true;
    prevBox.x0 = curBox.x0;
    prevBox.y0 = curBox.y0;
    prevBox.x1 = curBox.x1;
    prevBox.y1 = curBox.y1;
  }
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

// ---- HUD, adaptive quality, reporting --------------------------------------
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
  };
}

function updateHud(): void {
  const r = renderStats();
  const t = trackerStats;
  hudText.textContent = [
    `Perfil:      ${profileLabel}${degradeLevel > 0 ? `  (degradado nivel ${degradeLevel})` : ''}`,
    `Cámara:      ${t ? `${t.cameraFps.toFixed(1)} fps  ${t.resolution}  ${t.source}` : '—'}`,
    `Inferencia:  ${t ? `${t.inferenceAvgMs.toFixed(1)} ms (p95 ${t.inferenceP95Ms.toFixed(1)})` : '—'}`,
    `Render:      ${r.fps.toFixed(1)} fps  p99 ${r.p99Ms.toFixed(1)} ms  >33ms: ${r.over33Ms}/${r.frames}`,
    `Latencia est: ${latencyMs.toFixed(0)} ms (captura -> dibujo)`,
    `Estado:      ${status}`,
    'Ctrl+Alt: O overlay  H HUD  C cámara  B benchmark  Q salir',
  ].join('\n');

  const w = graph.width;
  const h = graph.height;
  graphCtx.clearRect(0, 0, w, h);
  const samples = frameStats.recent(120);
  graphCtx.strokeStyle = 'rgba(255,255,255,0.25)';
  graphCtx.beginPath();
  const y16 = h - (16.7 / 50) * h;
  graphCtx.moveTo(0, y16);
  graphCtx.lineTo(w, y16);
  graphCtx.stroke();
  graphCtx.strokeStyle = '#7fd4ff';
  graphCtx.beginPath();
  samples.forEach((ms, i) => {
    const x = (i / 120) * w;
    const y = h - Math.min(ms / 50, 1) * h;
    if (i === 0) graphCtx.moveTo(x, y);
    else graphCtx.lineTo(x, y);
  });
  graphCtx.stroke();
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

setInterval(updateHud, 250);
setInterval(adaptQuality, 2000);
setInterval(() => api.sendRenderStats(renderStats()), 2000);

// Dev aid: ?bg=<css colour> paints a backdrop so screenshots can check contrast.
const devBg = new URLSearchParams(location.search).get('bg');
if (devBg) document.body.style.background = devBg;

void api.getInit().then((init) => {
  if (!init.hud) hud.classList.add('hidden');
});
resize();
requestAnimationFrame(frame);
