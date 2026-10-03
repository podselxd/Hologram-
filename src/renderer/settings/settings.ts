import { paletteFor, type Palette } from '../../shared/appearance';
import { EDGE_OVERSHOOT, zoneFrom } from '../../shared/gestures';
import { HAND_CONNECTIONS, toScreen } from '../../shared/mapping';
import { COLORS, DEFAULT_SETTINGS, type ColorPreset, type Settings } from '../../shared/settings';
import type {
  CameraInfo,
  GestureView,
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
let safeRenderActive = false;
let lastRender: RenderStats | null = null;
let lastSelection: ProfileSelection | null = null;

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
  $<HTMLSelectElement>('autoUpdate').value = settings.autoUpdate;
  $<HTMLSelectElement>('cameraBackend').value = settings.cameraBackend;
  $<HTMLSelectElement>('control').value = settings.control;
  $<HTMLSelectElement>('dominantHand').value = settings.dominantHand;
  $<HTMLSelectElement>('clickMode').value = settings.clickMode;
  $<HTMLInputElement>('requireArming').checked = settings.requireArming;
  $<HTMLInputElement>('zoneSize').value = String(settings.zoneSize);
  $('zoneSizeVal').textContent = `${Math.round(settings.zoneSize * 100)} %`;
  $<HTMLInputElement>('zoneOffsetY').value = String(settings.zoneOffsetY);
  $<HTMLInputElement>('pinchSensitivity').value = String(settings.pinchSensitivity);
  $('pinchVal').textContent = `${Math.round(settings.pinchSensitivity * 100)} %`;
  $<HTMLInputElement>('dotSize').value = String(settings.dotSize);
  $('dotSizeVal').textContent = `${Math.round(settings.dotSize * 100)} %`;
  $<HTMLInputElement>('smoothing').value = String(settings.smoothing);
  $('smoothingVal').textContent = settings.smoothing < 0.34 ? 'más rápido' : settings.smoothing > 0.66 ? 'más suave' : 'equilibrado';
  $<HTMLInputElement>('mirror').checked = settings.mirror;
  $<HTMLInputElement>('safeRender').checked = settings.safeRender;
  $<HTMLInputElement>('openAtLogin').checked = settings.openAtLogin;
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
  $<HTMLSelectElement>('control').addEventListener('change', (e) => {
    const v = (e.target as HTMLSelectElement).value;
    patch({ control: v === 'on' ? 'on' : v === 'off' ? 'off' : 'test' });
  });
  $<HTMLSelectElement>('dominantHand').addEventListener('change', (e) =>
    patch({ dominantHand: (e.target as HTMLSelectElement).value === 'left' ? 'left' : 'right' }),
  );
  for (const id of ['zoneSize', 'zoneOffsetY', 'pinchSensitivity'] as const) {
    $<HTMLInputElement>(id).addEventListener('input', (e) => {
      patchThrottled({ [id]: Number((e.target as HTMLInputElement).value) });
      renderSettings();
    });
  }
  $<HTMLSelectElement>('clickMode').addEventListener('change', (e) =>
    patch({ clickMode: (e.target as HTMLSelectElement).value === 'dwell' ? 'dwell' : 'pinch' }),
  );
  $<HTMLInputElement>('requireArming').addEventListener('change', (e) => patch({ requireArming: (e.target as HTMLInputElement).checked }));
  $('btnArm').addEventListener('click', () => api.settingsCommand('toggle-armed'));
  $<HTMLSelectElement>('cameraBackend').addEventListener('change', (e) =>
    patch({ cameraBackend: (e.target as HTMLSelectElement).value === 'directshow' ? 'directshow' : 'auto' }),
  );
  $<HTMLSelectElement>('autoUpdate').addEventListener('change', (e) =>
    patch({ autoUpdate: (e.target as HTMLSelectElement).value === 'ask' ? 'ask' : 'auto' }),
  );
  $<HTMLInputElement>('dotSize').addEventListener('input', (e) => {
    patchThrottled({ dotSize: Number((e.target as HTMLInputElement).value) });
    $('dotSizeVal').textContent = `${Math.round(settings.dotSize * 100)} %`;
  });
  $<HTMLInputElement>('smoothing').addEventListener('input', (e) => {
    patchThrottled({ smoothing: Number((e.target as HTMLInputElement).value) });
    renderSettings();
  });
  $<HTMLInputElement>('mirror').addEventListener('change', (e) => patch({ mirror: (e.target as HTMLInputElement).checked }));
  $<HTMLInputElement>('openAtLogin').addEventListener('change', (e) => patch({ openAtLogin: (e.target as HTMLInputElement).checked }));
  $('btnInstaller').addEventListener('click', () => api.settingsCommand('open-installer-page'));
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

  // Keep the last camera image for a while: on a loaded machine encoding a preview can take seconds.
  if (image && now - imageAt < 5000) {
    g.save();
    g.globalAlpha = 0.9;
    if (settings.mirror) {
      g.translate(W, 0);
      g.scale(-1, 1);
    }
    g.drawImage(image, 0, 0, W, H);
    g.restore();
  }

  if (settings.control !== 'off') {
    // The area whose edges reach the screen edges (zone shrunk by the edge gain).
    const zz = zoneFrom(settings.zoneSize, settings.zoneOffsetY);
    const cx = (zz.x0 + zz.x1) / 2;
    const cy = (zz.y0 + zz.y1) / 2;
    const hw = (zz.x1 - zz.x0) / 2 / EDGE_OVERSHOOT;
    const hh = (zz.y1 - zz.y0) / 2 / EDGE_OVERSHOOT;
    const z = { x0: cx - hw, x1: cx + hw, y0: cy - hh, y1: cy + hh };
    const x0 = (settings.mirror ? 1 - z.x1 : z.x0) * W;
    g.save();
    g.setLineDash([6, 6]);
    g.strokeStyle = 'rgba(255,200,90,0.8)';
    g.lineWidth = 2;
    g.strokeRect(x0, z.y0 * H, (z.x1 - z.x0) * W, (z.y1 - z.y0) * H);
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
  $('sCamera').textContent = s
    ? `${s.cameraFps.toFixed(1)} FPS entregados · pide ${s.negotiated}${s.maxFps ? ` (máx. ${s.maxFps.toFixed(0)})` : ''} · ${s.source || '—'}`
    : '—';
  $('sProcessed').textContent = s
    ? `${s.processedFps.toFixed(1)} FPS · ${s.pipeline === 'processor' ? 'lectura directa de la cámara' : 'vía <video>'}`
    : '—';
  $('sInfer').textContent = s ? `${s.inferenceAvgMs.toFixed(1)} ms (p95 ${s.inferenceP95Ms.toFixed(1)}) · ${s.delegate}` : '—';
  const pill = $('camPill');
  const paused = s?.paused === true;
  pill.textContent = s ? (paused ? 'Cámara apagada (en segundo plano)' : 'Cámara activa') : 'Cámara: iniciando…';
  pill.className = `pill ${s ? (paused ? 'off' : 'ok') : ''}`;
  $('btnOverlay').textContent = paused ? 'Mostrar overlay y encender la cámara' : 'Ocultar overlay y apagar la cámara';
  renderDiagnosis();
}

/** Suggestions derived only from measured numbers (no guessing about the room or the camera). */
function renderDiagnosis(): void {
  const items: string[] = [];
  const s = stats;
  const r = lastRender;
  if (safeRenderActive) {
    items.push('Modo seguro activo: sin GPU, el modelo corre en la CPU y va más lento. Desmárcalo en "Sistema y atajos" y vuelve a abrir Hologram.');
  }
  if (s && !s.paused && s.cameraFps > 0) {
    const asked = Number(/@ (\d+)/.exec(s.negotiated)?.[1] ?? '0');
    if (s.cameraFps < 24) {
      items.push(
        asked >= 29
          ? `La cámara acepta ${asked} FPS pero entrega ${s.cameraFps.toFixed(0)}. Prueba "Método de captura: Compatible" en Cámara y rendimiento y reinicia la app.`
          : `La cámara entrega ${s.cameraFps.toFixed(0)} FPS en el modo ${s.negotiated}.`,
      );
      if (s.probe) items.push(`Modos probados: ${s.probe}.`);
    }
    if (s.processedFps < s.cameraFps * 0.8) {
      items.push(
        `El modelo procesa ${s.processedFps.toFixed(0)} de ${s.cameraFps.toFixed(0)} FPS: la inferencia no alcanza (p95 ${s.inferenceP95Ms.toFixed(0)} ms). Prueba 1 mano o el perfil bajo.`,
      );
    }
    if (s.inferenceP95Ms > 100 && s.inferenceAvgMs < s.inferenceP95Ms / 2) {
      items.push(`Hay tirones: la inferencia media es ${s.inferenceAvgMs.toFixed(0)} ms pero el p95 llega a ${s.inferenceP95Ms.toFixed(0)} ms.`);
    }
  }
  if (r && r.handsLost > 3) {
    items.push('Tracking inestable (la mano aparece y desaparece): mantén la mano completa dentro del cuadro y a 40–80 cm de la cámara.');
  }
  if (lastSelection?.forced) items.push('El perfil está fijado a mano: elige "Automático" para medir tu equipo.');
  const list = $('diag');
  list.replaceChildren(...(items.length ? items : ['Sin problemas detectados con los números actuales.']).map((t) => Object.assign(document.createElement('li'), { textContent: t })));
}

function renderProfile(sel: ProfileSelection): void {
  lastSelection = sel;
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
  lastRender = r;
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
    text.textContent = `Versión ${u.version}. Las actualizaciones automáticas funcionan en la app instalada.`;
    btn.hidden = true;
    return;
  }
  btn.hidden = false;
  switch (u.state) {
    case 'available':
      text.textContent = `Hay una versión nueva: v${u.latest ?? '?'} (tienes v${u.version}).${u.message ? ` ${u.message}` : ''}`;
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
      text.textContent = u.auto
        ? `v${u.latest ?? '?'} descargada y verificada. Se instala al salir de Hologram (bandeja → Salir de Hologram), o ahora con «Reiniciar ahora» (se cierra y se abre sola en ~30 s).`
        : `v${u.latest ?? '?'} descargada y verificada. Se reemplazará el .exe al reiniciar.`;
      text.className = 'msg ok';
      btn.textContent = u.auto ? 'Reiniciar ahora' : 'Reiniciar para actualizar';
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
  api.onGesture((v: GestureView) => {
    const el = $('ctlState');
    if (v.control === 'off') el.textContent = 'Desactivado: Hologram solo dibuja tus manos.';
    else if (v.inputError) el.textContent = v.inputError;
    else {
      const mode = { none: 'sin mano', point: 'apuntando', pinch: 'pinza', drag: 'arrastrando', scroll: 'scroll' }[v.mode];
      const head = v.paused ? 'En pausa (Ctrl+Alt+D para reanudar)' : v.armed ? 'Activo' : 'Desarmado (palma abierta 1 s)';
      el.textContent = `${head} · ${mode}${v.control === 'test' ? ' · modo prueba (no mueve el mouse)' : v.armed ? ' · mueve el mouse real' : ''}`;
    }
    el.className = `msg ${v.armed && v.control === 'on' ? 'ok' : ''}`;
  });

  settings = await api.getSettings();
  const initCfg = await api.getInit();
  safeRenderActive = initCfg.safeRenderActive;
  $('portableBox').hidden = !initCfg.portable;
  $('safePill').hidden = !safeRenderActive;
  renderSettings();
  renderStats();
  requestAnimationFrame(drawView);
}

void main();
