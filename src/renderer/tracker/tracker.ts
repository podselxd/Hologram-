import { FilesetResolver, HandLandmarker, type HandLandmarkerResult } from '@mediapipe/tasks-vision';
import { FrameStats, percentile } from '../../shared/frameStats';
import { smoothingParams } from '../../shared/appearance';
import { OneEuroFilter } from '../../shared/oneEuro';
import { chooseProfile, PROFILES } from '../../shared/profiles';
import { pickBestCameraMode, type CameraModeResult } from '../../shared/cameraModes';
import { DEFAULT_SETTINGS, type Settings } from '../../shared/settings';
import {
  LANDMARK_COUNT,
  MAX_HANDS,
  type DelegateMeasurement,
  type DelegateName,
  type HandFrame,
  type HandSample,
  type InitConfig,
  type Profile,
  type ProfileSelection,
} from '../../shared/types';

const BASE = 'app://hologram';
const api = window.hologram;
const video = document.getElementById('video') as HTMLVideoElement;

/**
 * MediaStreamTrackProcessor reads frames straight from the camera track. Unlike a <video> element it does not
 * depend on the page being painted, which Windows throttles for hidden/occluded windows (the tracker window is
 * hidden). Not in TypeScript's DOM lib yet, hence the local types.
 */
interface TrackProcessorCtor {
  new (init: { track: MediaStreamTrack; maxBufferSize?: number }): { readable: ReadableStream<VideoFrame> };
}
const TrackProcessor = (globalThis as unknown as { MediaStreamTrackProcessor?: TrackProcessorCtor }).MediaStreamTrackProcessor;
/** Chromium's MediaStreamTrack.stats: frames the camera produced, independent of what we managed to process. */
const trackStats = (t: MediaStreamTrack | undefined): { totalFrames: number } | undefined =>
  (t as unknown as { stats?: { totalFrames?: number } } | undefined)?.stats?.totalFrames !== undefined
    ? (t as unknown as { stats: { totalFrames: number } }).stats
    : undefined;

type FrameHandler = (src: TexImageSource, width: number, height: number, now: number, captureEpoch: number) => void;

let init: InitConfig;
let settings: Settings = DEFAULT_SETTINGS;
let previewOn = false;
let previewBusy = false;
let lastPreviewAt = 0;
let previewErrorLogged = false;
let profile: Profile = PROFILES.medium;
let delegate: DelegateName = 'GPU';
let numHands: 1 | 2 = 2;
let landmarker: HandLandmarker | null = null;
let stream: MediaStream | null = null;
let sourceLabel = '';
let frameHandler: FrameHandler | null = null;
let loopRunning = false;
let benchmarking = false;
let paused = false;
let pipeline: 'processor' | 'video' = 'video';
let readerGen = 0;
let reader: ReadableStreamDefaultReader<VideoFrame> | null = null;
let lastW = 0;
let lastH = 0;
let probeTimer: number | undefined;
let probedDevice: string | null = null;
let probeSummary: string | undefined;

// Frame counters (cumulative) for the FPS figures.
let readFrames = 0;
let presentedFrames = 0;
let processedFrames = 0;

const inferenceStats = new FrameStats(300);
const filters: OneEuroFilter[][] = Array.from({ length: MAX_HANDS }, () =>
  Array.from({ length: LANDMARK_COUNT * 3 }, () => new OneEuroFilter(1.2, 0.05, 1.0)),
);
let activeSlots = new Set<number>();

const status = (message: string): void => api.sendStatus(message);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const videoTrack = (): MediaStreamTrack | undefined => stream?.getVideoTracks()[0];

/** Cumulative frames the camera delivered: track stats if available, else what reached us. */
function deliveredFrames(): number {
  const st = trackStats(videoTrack());
  if (st) return st.totalFrames;
  return pipeline === 'processor' ? readFrames : presentedFrames;
}

/** CLI flags win over the saved settings. */
function effectiveProfile(): Profile['name'] | undefined {
  return init.profileOverride ?? (settings.profile !== 'auto' ? settings.profile : undefined);
}
function effectiveHands(): 1 | 2 | undefined {
  return init.forceHands ?? (settings.hands !== 'auto' ? settings.hands : undefined);
}

function applySmoothing(): void {
  const { minCutoff, beta } = smoothingParams(settings.smoothing);
  for (const slot of filters) for (const f of slot) f.configure(minCutoff, beta);
}

/** Sends a small JPEG of the camera image, at most ~15 fps, only while the settings preview asks for it. */
function maybeSendPreview(src: TexImageSource, w: number, h: number, now: number): void {
  if (!previewOn || previewBusy || now - lastPreviewAt < 66 || w === 0 || h === 0) return;
  previewBusy = true;
  lastPreviewAt = now;
  const width = 320;
  const height = Math.max(16, Math.round((h / w) * width));
  const canvas = new OffscreenCanvas(width, height);
  const g = canvas.getContext('2d');
  if (!g) {
    previewBusy = false;
    return;
  }
  try {
    g.drawImage(src as CanvasImageSource, 0, 0, width, height); // synchronous copy: the VideoFrame may close after
  } catch (err) {
    if (!previewErrorLogged) console.warn('preview draw failed:', err);
    previewErrorLogged = true;
    previewBusy = false;
    return;
  }
  canvas
    .convertToBlob({ type: 'image/jpeg', quality: 0.6 })
    .then((blob) => blob.arrayBuffer())
    .then((buf) => api.sendPreview({ width, height, data: new Uint8Array(buf) }))
    .catch((err: unknown) => {
      if (!previewErrorLogged) console.warn('preview failed:', err);
      previewErrorLogged = true;
    })
    .finally(() => {
      previewBusy = false;
    });
}

function applySettings(next: Settings): void {
  const prev = settings;
  settings = next;
  if (next.smoothing !== prev.smoothing) applySmoothing();
  if (next.deviceId !== prev.deviceId && !paused && !benchmarking) void startSource(profile);
  if ((next.profile !== prev.profile || next.hands !== prev.hands) && !paused && !benchmarking) void reselect();
}

/** Re-applies the manual profile/hands choice, or benchmarks again when everything is "auto". */
async function reselect(): Promise<void> {
  try {
    const forced = effectiveProfile();
    if (forced) await applySelection(await forcedSelection(forced));
    else await runAndApplyBenchmark();
  } catch (err) {
    status(`No pude aplicar el perfil: ${String(err)}`);
  }
}

async function createLandmarker(d: DelegateName, hands: 1 | 2): Promise<HandLandmarker> {
  const vision = await FilesetResolver.forVisionTasks(`${BASE}/wasm`);
  return HandLandmarker.createFromOptions(vision, {
    baseOptions: { modelAssetPath: `${BASE}/model/hand_landmarker.task`, delegate: d },
    runningMode: 'VIDEO',
    numHands: hands,
    minHandDetectionConfidence: 0.5,
    minHandPresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });
}

// ---- frame sources ----------------------------------------------------------------------------------------------

function stopCamera(): void {
  readerGen++;
  void reader?.cancel().catch(() => undefined);
  reader = null;
  window.clearTimeout(probeTimer);
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  if (init.mode !== 'video') {
    video.pause();
    video.srcObject = null;
  }
}

/** Opens the camera asking firmly for the profile's frame rate first, then softly if the camera refuses. */
async function openCamera(p: Profile): Promise<MediaStream> {
  const constraints = (deviceId: string | undefined, frameRate: ConstrainDouble): MediaStreamConstraints => ({
    audio: false,
    video: {
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      width: { ideal: p.camera.width },
      height: { ideal: p.camera.height },
      frameRate,
    },
  });
  const rates: ConstrainDouble[] = [{ ideal: p.camera.frameRate, min: 24 }, { ideal: p.camera.frameRate }];
  const devices = settings.deviceId ? [settings.deviceId, undefined] : [undefined];
  let lastError: unknown = new Error('no camera');
  for (const deviceId of devices) {
    for (const frameRate of rates) {
      try {
        return await navigator.mediaDevices.getUserMedia(constraints(deviceId, frameRate));
      } catch (err) {
        lastError = err;
      }
    }
  }
  throw lastError;
}

/** Reads frames straight from the track; maxBufferSize 1 keeps only the newest frame (lowest latency). */
function startProcessor(track: MediaStreamTrack): void {
  if (!TrackProcessor) return;
  const gen = ++readerGen;
  const r = new TrackProcessor({ track, maxBufferSize: 1 }).readable.getReader();
  reader = r;
  void (async () => {
    for (;;) {
      let res: ReadableStreamReadResult<VideoFrame>;
      try {
        res = await r.read();
      } catch {
        return;
      }
      if (res.done) return;
      const frame = res.value;
      if (gen !== readerGen) {
        frame.close();
        return;
      }
      readFrames++;
      try {
        lastW = frame.displayWidth;
        lastH = frame.displayHeight;
        const now = performance.now();
        frameHandler?.(frame, lastW, lastH, now, performance.timeOrigin + now);
      } catch (err) {
        console.warn('frame handler failed:', err);
      } finally {
        frame.close();
      }
    }
  })();
}

async function startSource(p: Profile): Promise<void> {
  stopCamera();
  if (init.mode === 'video') {
    pipeline = 'video';
    video.src = `${BASE}/video`;
    video.loop = true;
    await video.play();
    sourceLabel = 'video file';
    return;
  }
  stream = await openCamera(p);
  const track = videoTrack();
  sourceLabel = track?.label ?? 'camera';
  if (TrackProcessor && track) {
    pipeline = 'processor';
    startProcessor(track);
  } else {
    pipeline = 'video';
    video.srcObject = stream;
    await video.play();
  }
  const devices = await navigator.mediaDevices.enumerateDevices();
  api.sendCameras(devices.filter((d) => d.kind === 'videoinput').map((d) => ({ deviceId: d.deviceId, label: d.label })));
  scheduleProbe();
}

/** <video> fallback (video files, or Chromium without MediaStreamTrackProcessor). */
function ensureVideoLoop(): void {
  if (loopRunning) return;
  loopRunning = true;
  let lastPresented = 0;
  const tick = (now: number, meta: VideoFrameCallbackMetadata): void => {
    video.requestVideoFrameCallback(tick);
    if (meta.presentedFrames !== undefined) {
      presentedFrames += Math.max(0, meta.presentedFrames - lastPresented);
      lastPresented = meta.presentedFrames;
    }
    if (pipeline !== 'video') return;
    lastW = video.videoWidth;
    lastH = video.videoHeight;
    frameHandler?.(video, lastW, lastH, now, performance.timeOrigin + (meta.captureTime ?? now));
  };
  video.requestVideoFrameCallback(tick);
}

// ---- automatic camera-mode probe ----------------------------------------------------------------------------

async function measureDeliveredFps(ms: number): Promise<number> {
  const f0 = deliveredFrames();
  const t0 = performance.now();
  await sleep(ms);
  return ((deliveredFrames() - f0) * 1000) / (performance.now() - t0);
}

function scheduleProbe(): void {
  window.clearTimeout(probeTimer);
  probeTimer = window.setTimeout(() => void maybeProbe(), 3000);
}

/**
 * If the camera delivers fewer than 24 fps, try other resolutions on the same track (asking for 30 fps) and keep
 * the fastest. Runs once per camera per session.
 */
async function maybeProbe(): Promise<void> {
  const track = videoTrack();
  const key = settings.deviceId ?? 'default';
  if (!track || paused || probedDevice === key) return;
  const fps = await measureDeliveredFps(1500);
  if (fps >= 24) return;
  probedDevice = key;
  status(`La cámara entrega ${fps.toFixed(1)} FPS: probando otros modos de cámara…`);
  const before = track.getSettings();
  const results: CameraModeResult[] = [
    { width: before.width ?? 0, height: before.height ?? 0, fps, negotiatedFps: before.frameRate ?? 0 },
  ];
  const modes: Array<[number, number]> = [
    [1280, 720],
    [640, 480],
    [848, 480],
    [640, 360],
    [320, 240],
  ];
  for (const [w, h] of modes) {
    if (videoTrack() !== track) return; // camera changed meanwhile
    try {
      await track.applyConstraints({ width: { ideal: w }, height: { ideal: h }, frameRate: { ideal: 30, min: 24 } });
    } catch {
      try {
        await track.applyConstraints({ width: { ideal: w }, height: { ideal: h }, frameRate: { ideal: 30 } });
      } catch {
        continue;
      }
    }
    await sleep(1200); // let the camera settle on the new mode
    const s = track.getSettings();
    results.push({ width: s.width ?? w, height: s.height ?? h, fps: await measureDeliveredFps(1500), negotiatedFps: s.frameRate ?? 0 });
  }
  const best = pickBestCameraMode(results, profile.camera.width);
  if (best) {
    try {
      await track.applyConstraints({ width: { ideal: best.width }, height: { ideal: best.height }, frameRate: { ideal: 30 } });
    } catch {
      // keep whatever mode is active
    }
  }
  probeSummary = results.map((r) => `${r.width}x${r.height}: ${r.fps.toFixed(0)} FPS (pide ${r.negotiatedFps.toFixed(0)})`).join(' · ');
  status(
    best && best.fps >= 24
      ? `Modo de cámara elegido: ${best.width}x${best.height} a ${best.fps.toFixed(0)} FPS.`
      : `Ningún modo pasa de ${Math.max(...results.map((r) => r.fps)).toFixed(0)} FPS: es el límite de la cámara o su driver con esta configuración.`,
  );
}

// ---- live tracking ---------------------------------------------------------------------------------------------

function liveHandler(src: TexImageSource, w: number, h: number, now: number, captureEpoch: number): void {
  if (!landmarker) return;
  processedFrames++;
  const t0 = performance.now();
  const result = landmarker.detectForVideo(src, t0);
  const inferenceMs = performance.now() - t0;
  inferenceStats.record(inferenceMs);
  if (result.landmarks.length === 0) {
    activeSlots = new Set();
    maybeSendPreview(src, w, h, now);
    return;
  }
  const hands = toSamples(result, captureEpoch);
  api.sendFrame({ t: captureEpoch, inferenceMs, hands } satisfies HandFrame);
  maybeSendPreview(src, w, h, now);
}

function toSamples(result: HandLandmarkerResult, t: number): HandSample[] {
  const raw = result.landmarks
    .map((lms, i) => ({
      lms,
      handedness: result.handedness[i]?.[0],
    }))
    .sort((a, b) => (a.lms[0]?.x ?? 0) - (b.lms[0]?.x ?? 0))
    .slice(0, MAX_HANDS);

  const seen = new Set<number>();
  const samples = raw.map(({ lms, handedness }, slot) => {
    seen.add(slot);
    const f = filters[slot] as OneEuroFilter[];
    if (!activeSlots.has(slot)) f.forEach((flt) => flt.reset());
    return {
      slot,
      handedness: handedness?.categoryName === 'Left' ? ('Left' as const) : ('Right' as const),
      score: handedness?.score ?? 0,
      landmarks: lms.map((p, i) => ({
        x: (f[i * 3] as OneEuroFilter).filter(p.x, t),
        y: (f[i * 3 + 1] as OneEuroFilter).filter(p.y, t),
        z: (f[i * 3 + 2] as OneEuroFilter).filter(p.z, t),
      })),
    } satisfies HandSample;
  });
  activeSlots = seen;
  return samples;
}

// ---- benchmark -------------------------------------------------------------------------------------------------

interface Pass {
  measurements: DelegateMeasurement[];
  handFrames: number;
}

/**
 * Runs the given landmarkers on the same frames (inside the frame handler, so it works with VideoFrames that are
 * closed right after); only frames with hands count unless none ever appear. A delegate that is clearly much
 * slower than the best one is dropped early so the benchmark does not waste seconds on it.
 */
function measure(
  list: Array<{ delegate: DelegateName; hands: 1 | 2; lm: HandLandmarker }>,
  wantFrames: number,
  timeoutMs: number,
): Promise<Pass> {
  return new Promise((resolve) => {
    const withHands = list.map(() => [] as number[]);
    const withoutHands = list.map(() => [] as number[]);
    const active = list.map(() => true);
    let warmup = 10;
    let handFrames = 0;
    let finished = false;

    const finish = (): void => {
      if (finished) return;
      finished = true;
      window.clearTimeout(timer);
      frameHandler = null;
      const enough = handFrames >= Math.min(wantFrames, 30);
      const measurements = list.map(({ delegate: d, hands }, i) => {
        const samples = (enough ? withHands[i] : [...(withHands[i] ?? []), ...(withoutHands[i] ?? [])]) ?? [];
        const sorted = [...samples].sort((a, b) => a - b);
        return {
          delegate: d,
          numHands: hands,
          samples: sorted.length,
          p50Ms: percentile(sorted, 0.5),
          p95Ms: percentile(sorted, 0.95),
        } satisfies DelegateMeasurement;
      });
      resolve({ measurements, handFrames });
    };
    const timer = window.setTimeout(finish, timeoutMs);

    frameHandler = (src) => {
      const ts = performance.now();
      let anyHand = false;
      const times = list.map(({ lm }, i) => {
        if (!active[i]) return null;
        const t0 = performance.now();
        const r = lm.detectForVideo(src, ts);
        if (r.landmarks.length > 0) anyHand = true;
        return performance.now() - t0;
      });
      if (warmup > 0) {
        warmup--;
        return;
      }
      times.forEach((ms, i) => {
        if (ms !== null) (anyHand ? withHands : withoutHands)[i]?.push(ms);
      });
      if (anyHand) handFrames++;
      dropClearlySlower(list.length, active, [...withHands.keys()].map((i) => [...(withHands[i] ?? []), ...(withoutHands[i] ?? [])]));
      if (handFrames >= wantFrames) finish();
    };
  });
}

function dropClearlySlower(n: number, active: boolean[], all: number[][]): void {
  if (n < 2) return;
  const medians = all.map((a) => (a.length >= 6 ? percentile([...a].sort((x, y) => x - y), 0.5) : Infinity));
  let best = Infinity;
  medians.forEach((m, i) => {
    if (active[i] && m < best) best = m;
  });
  if (!Number.isFinite(best)) return;
  medians.forEach((m, i) => {
    if (active[i] && m > best * 4 && m > 60) active[i] = false;
  });
}

async function tryCreate(d: DelegateName, hands: 1 | 2): Promise<HandLandmarker | null> {
  try {
    return await createLandmarker(d, hands);
  } catch (err) {
    console.warn(`${d} delegate unavailable:`, err);
    return null;
  }
}

async function runBenchmark(): Promise<ProfileSelection> {
  status('Benchmark: pon una o dos manos frente a la cámara y muévelas unos segundos…');
  const [gpu, cpu] = await Promise.all([tryCreate('GPU', 2), tryCreate('CPU', 2)]);
  const list = [
    ...(gpu ? [{ delegate: 'GPU' as const, hands: 2 as const, lm: gpu }] : []),
    ...(cpu ? [{ delegate: 'CPU' as const, hands: 2 as const, lm: cpu }] : []),
  ];
  if (list.length === 0) throw new Error('No MediaPipe delegate could be created');

  const pass = await measure(list, 45, 25000);
  const reliable = pass.handFrames >= 30;
  let oneHand: DelegateMeasurement | undefined;
  const best = [...pass.measurements].sort((a, b) => a.p95Ms - b.p95Ms)[0];
  if (reliable && best && best.p95Ms > 40) {
    status('Con 2 manos va justo: midiendo con 1 mano…');
    const one = best.delegate === 'GPU' ? await tryCreate('GPU', 1) : await tryCreate('CPU', 1);
    if (one) {
      const p = await measure([{ delegate: best.delegate, hands: 1, lm: one }], 30, 12000);
      oneHand = p.measurements[0];
      one.close();
    }
  }
  gpu?.close();
  cpu?.close();
  return chooseProfile({ twoHands: pass.measurements, oneHand, reliable });
}

async function applySelection(selection: ProfileSelection): Promise<void> {
  const nextProfile = PROFILES[selection.profile];
  const cameraChanged =
    nextProfile.camera.width !== profile.camera.width ||
    nextProfile.camera.height !== profile.camera.height ||
    nextProfile.camera.frameRate !== profile.camera.frameRate;
  profile = nextProfile;
  delegate = selection.delegate;
  numHands = effectiveHands() ?? selection.numHands;
  if (cameraChanged) await startSource(profile);
  landmarker?.close();
  landmarker = await tryCreate(delegate, numHands);
  if (!landmarker) {
    delegate = 'CPU';
    landmarker = await createLandmarker('CPU', numHands);
  }
  inferenceStats.clear();
  frameHandler = liveHandler;
  api.sendProfile({ ...selection, delegate, numHands });
  status(selection.reason);
}

async function forcedSelection(name: Profile['name']): Promise<ProfileSelection> {
  const probe = await tryCreate('GPU', 2);
  probe?.close();
  return {
    profile: name,
    delegate: probe ? 'GPU' : 'CPU',
    numHands: effectiveHands() ?? 2,
    meetsMinimum: false,
    reliable: false,
    forced: true,
    reason: `Perfil "${name}" fijado a mano: no se hizo benchmark, el rendimiento no está verificado.`,
    measurements: [],
  };
}

async function runAndApplyBenchmark(): Promise<void> {
  if (benchmarking) return;
  benchmarking = true;
  try {
    frameHandler = null;
    await applySelection(await runBenchmark());
  } catch (err) {
    status(`El benchmark falló: ${String(err)}`);
  } finally {
    benchmarking = false;
  }
}

// ---- reporting -------------------------------------------------------------------------------------------------

function startStatsReporting(): void {
  let lastDelivered = deliveredFrames();
  let lastProcessed = processedFrames;
  let lastAt = performance.now();
  setInterval(() => {
    const now = performance.now();
    const dt = Math.max(1, now - lastAt);
    const delivered = deliveredFrames();
    const cameraFps = Math.max(0, ((delivered - lastDelivered) * 1000) / dt);
    const processedFps = ((processedFrames - lastProcessed) * 1000) / dt;
    lastDelivered = delivered;
    lastProcessed = processedFrames;
    lastAt = now;
    const track = videoTrack();
    const s = track?.getSettings();
    const caps = track && typeof track.getCapabilities === 'function' ? track.getCapabilities() : undefined;
    const summary = inferenceStats.summary();
    api.sendStats({
      cameraFps: paused ? 0 : cameraFps,
      processedFps: paused ? 0 : processedFps,
      negotiated: s ? `${s.width ?? '?'}x${s.height ?? '?'} @ ${s.frameRate ? s.frameRate.toFixed(0) : '?'}` : '—',
      maxFps: caps?.frameRate?.max ?? 0,
      pipeline,
      ...(probeSummary ? { probe: probeSummary } : {}),
      inferenceAvgMs: summary.avg,
      inferenceP95Ms: summary.p95,
      delegate,
      numHands,
      source: sourceLabel,
      resolution: `${lastW}x${lastH}`,
      paused,
    });
  }, 1000);
}

/** Paused = camera released and no inference, so nothing is captured while the overlay is hidden. */
function setPaused(next: boolean): void {
  if (next === paused || benchmarking) return;
  paused = next;
  if (paused) {
    frameHandler = null;
    stopCamera();
    activeSlots = new Set();
    status('En segundo plano: cámara apagada.');
  } else {
    void startSource(profile).then(() => {
      if (!paused && landmarker) frameHandler = liveHandler;
      status('Cámara reactivada.');
    });
  }
}

async function main(): Promise<void> {
  init = await api.getInit();
  settings = init.settings;
  applySmoothing();
  api.onSettings(applySettings);
  api.onCommand((cmd) => {
    if (cmd.type === 'rerun-benchmark') {
      if (!paused) void runAndApplyBenchmark();
    } else if (cmd.type === 'set-paused') {
      setPaused(cmd.paused);
    } else if (cmd.type === 'set-preview') {
      previewOn = cmd.enabled;
    }
  });
  try {
    ensureVideoLoop();
    await startSource(profile);
    startStatsReporting();
    const forced = effectiveProfile();
    if (forced) await applySelection(await forcedSelection(forced));
    else await runAndApplyBenchmark();
  } catch (err) {
    status(`Error del tracker: ${String(err)}`);
  }
}

void main();
