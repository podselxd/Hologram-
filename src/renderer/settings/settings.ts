import { paletteFor, type Palette } from '../../shared/appearance';
import { HAND_CONNECTIONS, toScreen } from '../../shared/mapping';
import { COLORS, DEFAULT_SETTINGS, type ColorPreset, type Settings } from '../../shared/settings';
import type {
  CameraInfo,
  HandFrame,
  PreviewImage,
  ProfileSelection,
  RenderStats,
  TrackerStats,
  UpdateSnapshot,
} from '../../shared/types';

const api = window.hologram;
const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const view = $<HTMLCanvasElement>('view');
const g = view.getContext('2d') as CanvasRenderingContext2D;

let settings: Settings = DEFAULT_SETTINGS;
let palette: Palette = paletteFor(settings.color);
let glowSprite = sprite(64, palette.glowStops);
let coreSprite = sprite(32, palette.coreStops);

let frame: HandFrame | null = null;
let frameAt = 0;
let image: ImageBitmap | null = null;
let imageAt = 0;
let cameras: CameraInfo[] = [];
let stats: TrackerStats | null = null;
let aspect = 4 / 3;
let lastAnnounced = -1;

function sprite(size: number, stops: Array<[number, string]>): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d') as CanvasRenderingContext2D;
  const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  for (const [o, color] of stops) grad.addColorStop(o, color);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  return c;
}

// ---- controls <-> settings ---------------------------------------------------------------------
function patch(p: Partial<Settings>): void {
  settings = { ...settings, ...p };
  api.patchSettings(p);
}

let rangeTimer: number | undefined;
function patchThrottled(p: Partial<Settings>): void {
  settings = { ...settings, ...p };
  window.clearTimeout(rangeTimer);
  rangeTimer = window.setTimeout(() => api.patchSettings(p), 120);
}

function renderSettings(): void {
  $<HTMLSelectElement>('profile').value = settings.profile;
  $<HTMLSelectElement>('hands').value = String(settings.hands);
  $<HTMLInputElement>('dotSize').value = String(settings.dotSize);
  $('dotSizeVal').textContent = `${Math.round(settings.dotSize * 100)} %`;
  $<HTMLInputElement>('smoothing').value = String(settings.smoothing);
  $('smoothingVal').textContent = settings.smoothing < 0.34 ? 'más rápido' : settings.smoothing > 0.66 ? 'más suave' : 'equilibrado';
  $<HTMLInputElement>('mirror').checked = settings.mirror;
  $<HTMLInputElement>('hud').checked = settings.hud;
  $<HTMLInputElement>('safeRender').checked = settings.safeRender;
  for (const c of COLORS) {
    const radio = document.querySelector<HTMLInputElement>(`input[name="color"][value="${c}"]`);
    if (radio) radio.checked = c === settings.color;
  }
  renderCameraList();
  palette = paletteFor(settings.color);
  glowSprite = sprite(64, palette.glowStops);
  coreSprite = sprite(32, palette.coreStops);
}

function renderCameraList(): void {
  const select = $<HTMLSelectElement>('camera');
  select.replaceChildren();
  const def = new Option('Predeterminada del sistema', '');
  select.append(def);
  cameras.forEach((c, i) => select.append(new Option(c.label || `Cámara ${i + 1}`, c.deviceId)));
  select.value = settings.deviceId ?? '';
  if (select.value !== (settings.deviceId ?? '')) select.value = '';
}

function wireControls(): void {
  $<HTMLSelectElement>('camera').addEventListener('change', (e) => patch({ deviceId: (e.target as HTMLSelectElement).value }));
  $<HTMLSelectElement>('profile').addEventListener('change', (e) =>
    patch({ profile: (e.target as HTMLSelectElement).value as Settings['profile'] }),
  );
  $<HTMLSelectElement>('hands').addEventListener('change', (e) => {
    const v = (e.target as HTMLSelectElement).value;
    patch({ hands: v === '1' ? 1 : v === '2' ? 2 : 'auto' });
  });
  $<HTMLInputElement>('dotSize').addEventListener('input', (e) => {
    patchThrottled({ dotSize: Number((e.target as HTMLInputElement).value) });
    $('dotSizeVal').textContent = `${Math.round(settings.dotSize * 100)} %`;
  });
  $<HTMLInputElement>('smoothing').addEventListener('input', (e) => {
    patchThrottled({ smoothing: Number((e.target as HTMLInputElement).value) });
    renderSettings();
  });
  $<HTMLInputElement>('mirror').addEventListener('change', (e) => patch({ mirror: (e.target as HTMLInputElement).checked }));
  $<HTMLInputElement>('hud').addEventListener('change', (e) => patch({ hud: (e.target as HTMLInputElement).checked }));
  $<HTMLInputElement>('safeRender').addEventListener('change', (e) => patch({ safeRender: (e.target as HTMLInputElement).checked }));
  document.querySelectorAll<HTMLInputElement>('input[name="color"]').forEach((r) =>
    r.addEventListener('change', () => r.checked && patch({ color: r.value as ColorPreset })),
  );
  $<HTMLInputElement>('previewOn').addEventListener('change', (e) => {
    const on = (e.target as HTMLInputElement).checked;
    api.setPreview(on);
    if (!on) image = null;
  });
  $('btnBench').addEventListener('click', () => api.settingsCommand('rerun-benchmark'));
  $('btnOverlay').addEventListener('click', () => api.settingsCommand('toggle-overlay'));
  $('btnQuit').addEventListener('click', () => api.settingsCommand('quit'));
}

// ---- live view -----------------------------------------------------------------------------------
function drawHand(pts: Float32Array, alpha: number, w: number): void {
  const k = w / 640;
  g.globalAlpha = alpha;
  g.beginPath();
  for (const [a, b] of HAND_CONNECTIONS) {
    g.moveTo(pts[a * 2] as number, pts[a * 2 + 1] as number);
    g.lineTo(pts[b * 2] as number, pts[b * 2 + 1] as number);
  }
  g.lineCap = 'round';
  g.strokeStyle = palette.halo;
  g.lineWidth = 7 * k;
  g.stroke();
  g.strokeStyle = palette.rim;
  g.lineWidth = 3 * k;
  g.stroke();
  g.strokeStyle = palette.line;
  g.lineWidth = 1.6 * k;
  g.stroke();
  const tips = new Set([4, 8, 12, 16, 20]);
  for (let i = 0; i < 21; i++) {
    const x = pts[i * 2] as number;
    const y = pts[i * 2 + 1] as number;
    const r = (tips.has(i) ? 7 : i === 0 ? 6 : 4.5) * settings.dotSize * k * 1.4;
    g.drawImage(glowSprite, x - r * 3, y - r * 3, r * 6, r * 6);
    g.drawImage(coreSprite, x - r, y - r, r * 2, r * 2);
  }
  g.globalAlpha = 1;
}

function drawView(now: number): void {
  requestAnimationFrame(drawView);
  const W = view.width;
  const H = Math.round(W / aspect);
  if (view.height !== H) view.height = H;
  g.fillStyle = '#050a14';
  g.fillRect(0, 0, W, H);

  g.strokeStyle = 'rgba(127,212,255,0.07)';
  g.lineWidth = 1;
  g.beginPath();
  for (let x = 0; x <= W; x += W / 8) {
    g.moveTo(x, 0);
    g.lineTo(x, H);
  }
  for (let y = 0; y <= H; y += H / 6) {
    g.moveTo(0, y);
    g.lineTo(W, y);
  }
  g.stroke();

  if (image && now - imageAt < 1500) {
    g.save();
    g.globalAlpha = 0.9;
    if (settings.mirror) {
      g.translate(W, 0);
      g.scale(-1, 1);
    }
    g.drawImage(image, 0, 0, W, H);
    g.restore();
  }

  let count = 0;
  let confidence = 0;
  if (frame && now - frameAt < 400) {
    const age = now - frameAt;
    const alpha = age < 200 ? 1 : 1 - (age - 200) / 200;
    for (const hand of frame.hands) {
      const pts = new Float32Array(42);
      hand.landmarks.forEach((lm, i) => {
        const [x, y] = toScreen(lm.x, lm.y, W, H, settings.mirror);
        pts[i * 2] = x;
        pts[i * 2 + 1] = y;
      });
      drawHand(pts, alpha, W);
      count++;
      confidence += hand.score;
    }
  }
  $('handsInfo').textContent = count === 0 ? 'ninguna detectada' : `${count} detectada${count > 1 ? 's' : ''}`;
  $('confInfo').textContent = count === 0 ? '—' : `${Math.round((confidence / count) * 100)} %`;
  if (count !== lastAnnounced) {
    lastAnnounced = count;
    const text = count === 0 ? 'sin manos detectadas' : `${count} mano${count > 1 ? 's' : ''} detectada${count > 1 ? 's' : ''}`;
    view.setAttribute('aria-label', `Vista en vivo: ${text}`);
    $('live-region').textContent = text;
  }
}

// ---- stats, benchmark, updates ---------------------------------------------------------------------
function renderStats(): void {
  const s = stats;
  $('sCamera').textContent = s ? `${s.cameraFps.toFixed(1)} FPS · ${s.resolution} · ${s.source || '—'}` : '—';
  $('sInfer').textContent = s ? `${s.inferenceAvgMs.toFixed(1)} ms (p95 ${s.inferenceP95Ms.toFixed(1)}) · ${s.delegate}` : '—';
  const pill = $('camPill');
  const paused = s?.paused === true;
  pill.textContent = s ? (paused ? 'Cámara apagada (en segundo plano)' : 'Cámara activa') : 'Cámara: iniciando…';
  pill.className = `pill ${s ? (paused ? 'off' : 'ok') : ''}`;
  $('btnOverlay').textContent = paused ? 'Mostrar overlay y encender la cámara' : 'Ocultar overlay y apagar la cámara';
}

function renderProfile(sel: ProfileSelection): void {
  const verdict = sel.forced
    ? 'fijado a mano, sin verificar'
    : !sel.reliable
      ? 'sin manos a la vista: resultado no fiable'
      : sel.meetsMinimum
        ? 'cumple el mínimo'
        : 'NO cumple el mínimo';
  $('sProfile').textContent = `${sel.profile} · ${sel.delegate} · ${sel.numHands} mano${sel.numHands > 1 ? 's' : ''} · ${verdict}`;
  const lines = sel.measurements.map(
    (m) => `${m.delegate} · ${m.numHands} mano${m.numHands > 1 ? 's' : ''} · ${m.samples} muestras · p50 ${m.p50Ms.toFixed(1)} ms · p95 ${m.p95Ms.toFixed(1)} ms`,
  );
  $('bench').textContent = [sel.reason, ...lines].join('\n');
}

function renderRender(r: RenderStats): void {
  $('sRender').textContent = `${r.fps.toFixed(1)} FPS · p99 ${r.p99Ms.toFixed(1)} ms · >33 ms: ${r.over33Ms}/${r.frames}${r.degradeLevel > 0 ? ` · degradado ${r.degradeLevel}` : ''}`;
  $('sLatency').textContent = `${r.latencyMs.toFixed(0)} ms (captura → dibujo)`;
  $('sLost').textContent = `${r.handsLost} en 5 s${r.handsLost > 3 ? ' (tracking inestable)' : ''}`;
}

function renderUpdate(u: UpdateSnapshot): void {
  $('ver').textContent = `v${u.version}`;
  const text = $('updText');
  const btn = $<HTMLButtonElement>('btnUpd');
  const rollback = $<HTMLButtonElement>('btnRollback');
  rollback.hidden = !u.canRollback;
  btn.className = '';
  text.className = 'msg';
  btn.disabled = false;
  if (!u.enabled) {
    text.textContent = `Versión ${u.version}. Las actualizaciones solo funcionan con el .exe portable.`;
    btn.hidden = true;
    return;
  }
  btn.hidden = false;
  switch (u.state) {
    case 'available':
      text.textContent = `Hay una versión nueva: v${u.latest ?? '?'} (tienes v${u.version}).`;
      btn.textContent = 'Descargar actualización';
      btn.className = 'primary';
      btn.onclick = () => api.updateAction('download');
      break;
    case 'downloading':
      text.textContent = `Descargando v${u.latest ?? '?'}…`;
      btn.textContent = 'Descargando…';
      btn.disabled = true;
      break;
    case 'ready':
      text.textContent = `v${u.latest ?? '?'} descargada y verificada. Se reemplazará el .exe al reiniciar.`;
      text.className = 'msg ok';
      btn.textContent = 'Reiniciar para actualizar';
      btn.className = 'primary';
      btn.onclick = () => api.updateAction('apply');
      break;
    case 'checking':
      text.textContent = 'Buscando actualizaciones…';
      btn.textContent = 'Buscando…';
      btn.disabled = true;
      break;
    case 'error':
      text.textContent = `No pude buscar actualizaciones: ${u.message ?? 'error desconocido'}`;
      text.className = 'msg bad';
      btn.textContent = 'Reintentar';
      btn.onclick = () => api.updateAction('check');
      break;
    default:
      text.textContent = `Estás en v${u.version}.`;
      btn.textContent = 'Buscar actualizaciones';
      btn.onclick = () => api.updateAction('check');
  }
  rollback.onclick = () => api.updateAction('rollback');
}

// ---- start ---------------------------------------------------------------------------------------------
async function main(): Promise<void> {
  wireControls();
  api.onSettings((s) => {
    settings = s;
    renderSettings();
  });
  api.onFrame((f) => {
    frame = f;
    frameAt = performance.now();
  });
  api.onPreview((p: PreviewImage) => {
    const blob = new Blob([new Uint8Array(p.data)], { type: 'image/jpeg' });
    void createImageBitmap(blob).then((bmp) => {
      image?.close();
      image = bmp;
      imageAt = performance.now();
      aspect = p.width / p.height;
    });
  });
  api.onStats((s) => {
    stats = s;
    const m = /^(\d+)x(\d+)$/.exec(s.resolution);
    if (m && !image) aspect = Number(m[1]) / Number(m[2]);
    renderStats();
  });
  api.onProfile(renderProfile);
  api.onStatus((m) => ($('sStatus').textContent = m));
  api.onRenderStats(renderRender);
  api.onCameras((c) => {
    cameras = c;
    renderCameraList();
  });
  api.onUpdate(renderUpdate);

  settings = await api.getSettings();
  renderSettings();
  renderStats();
  requestAnimationFrame(drawView);
}

void main();
