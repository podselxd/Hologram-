import { FilesetResolver, HandLandmarker, type HandLandmarkerResult } from '@mediapipe/tasks-vision';
import { FrameStats, percentile } from '../../shared/frameStats';
import { OneEuroFilter } from '../../shared/oneEuro';
import { chooseProfile, PROFILES } from '../../shared/profiles';
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

let init: InitConfig;
let profile: Profile = PROFILES.medium;
let delegate: DelegateName = 'GPU';
let numHands: 1 | 2 = 2;
let landmarker: HandLandmarker | null = null;
let stream: MediaStream | null = null;
let sourceLabel = '';
let frameHandler: ((now: number, meta: VideoFrameCallbackMetadata) => void) | null = null;
let loopRunning = false;
let benchmarking = false;

const inferenceStats = new FrameStats(300);
const filters: OneEuroFilter[][] = Array.from({ length: MAX_HANDS }, () =>
  Array.from({ length: LANDMARK_COUNT * 3 }, () => new OneEuroFilter(1.2, 0.05, 1.0)),
);
let activeSlots = new Set<number>();
let lastPresented = 0;
let lastPresentedAt = performance.now();
let cameraFps = 0;

const status = (message: string): void => api.sendStatus(message);

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

async function startSource(p: Profile): Promise<void> {
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  if (init.mode === 'video') {
    video.srcObject = null;
    video.src = `${BASE}/video`;
    video.loop = true;
    await video.play();
    sourceLabel = 'video file';
    return;
  }
  const constraints = (deviceId?: string): MediaStreamConstraints => ({
    audio: false,
    video: {
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      width: { ideal: p.camera.width },
      height: { ideal: p.camera.height },
      frameRate: { ideal: p.camera.frameRate },
    },
  });
  try {
    stream = await navigator.mediaDevices.getUserMedia(constraints(init.deviceId));
  } catch (err) {
    if (!init.deviceId) throw err;
    stream = await navigator.mediaDevices.getUserMedia(constraints());
  }
  video.srcObject = stream;
  await video.play();
  const track = stream.getVideoTracks()[0];
  sourceLabel = track?.label ?? 'camera';
  const devices = await navigator.mediaDevices.enumerateDevices();
  api.sendCameras(devices.filter((d) => d.kind === 'videoinput').map((d) => ({ deviceId: d.deviceId, label: d.label })));
}

function ensureLoop(): void {
  if (loopRunning) return;
  loopRunning = true;
  const tick = (now: number, meta: VideoFrameCallbackMetadata): void => {
    video.requestVideoFrameCallback(tick);
    if (meta.presentedFrames !== undefined) {
      const dt = now - lastPresentedAt;
      if (dt >= 500) {
        cameraFps = ((meta.presentedFrames - lastPresented) * 1000) / dt;
        lastPresented = meta.presentedFrames;
        lastPresentedAt = now;
      }
    }
    frameHandler?.(now, meta);
  };
  video.requestVideoFrameCallback(tick);
}

function captureEpoch(now: number, meta: VideoFrameCallbackMetadata): number {
  return performance.timeOrigin + (meta.captureTime ?? now);
}

function liveHandler(now: number, meta: VideoFrameCallbackMetadata): void {
  if (!landmarker) return;
  const t0 = performance.now();
  const result = landmarker.detectForVideo(video, t0);
  const inferenceMs = performance.now() - t0;
  inferenceStats.record(inferenceMs);
  if (result.landmarks.length === 0) {
    activeSlots = new Set();
    return;
  }
  const t = captureEpoch(now, meta);
  const hands = toSamples(result, t);
  api.sendFrame({ t, inferenceMs, hands } satisfies HandFrame);
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

function nextFrame(): Promise<{ now: number; meta: VideoFrameCallbackMetadata }> {
  return new Promise((resolve) => {
    frameHandler = (now, meta) => {
      frameHandler = null;
      resolve({ now, meta });
    };
  });
}

interface Pass {
  measurements: DelegateMeasurement[];
  handFrames: number;
}

/**
 * Runs the given landmarkers on the same frames; only frames with hands count
 * unless none ever appear. A delegate that is clearly much slower than the best
 * one is dropped early so the benchmark does not waste seconds on it.
 */
async function measure(
  list: Array<{ delegate: DelegateName; hands: 1 | 2; lm: HandLandmarker }>,
  wantFrames: number,
  timeoutMs: number,
): Promise<Pass> {
  const withHands = list.map(() => [] as number[]);
  const withoutHands = list.map(() => [] as number[]);
  const active = list.map(() => true);
  const start = performance.now();
  let warmup = 10;
  let handFrames = 0;
  while (handFrames < wantFrames && performance.now() - start < timeoutMs) {
    await nextFrame();
    const ts = performance.now();
    let anyHand = false;
    const times = list.map(({ lm }, i) => {
      if (!active[i]) return null;
      const t0 = performance.now();
      const r = lm.detectForVideo(video, ts);
      if (r.landmarks.length > 0) anyHand = true;
      return performance.now() - t0;
    });
    if (warmup > 0) {
      warmup--;
      continue;
    }
    times.forEach((ms, i) => {
      if (ms !== null) (anyHand ? withHands : withoutHands)[i]?.push(ms);
    });
    if (anyHand) handFrames++;
    dropClearlySlower(list.length, active, [...withHands.keys()].map((i) => [...(withHands[i] ?? []), ...(withoutHands[i] ?? [])]));
  }
  const measurements = list.map(({ delegate: d, hands }, i) => {
    const enough = handFrames >= Math.min(wantFrames, 30);
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
  return { measurements, handFrames };
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
  status('Benchmark: pon una o dos manos frente a la cámara y muévelas (unos segundos)…');
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
    status('El equipo va justo con 2 manos: midiendo con 1 mano…');
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
  numHands = init.forceHands ?? selection.numHands;
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
    numHands: init.forceHands ?? 2,
    meetsMinimum: true,
    reliable: true,
    reason: `Profile "${name}" forced from the command line (no benchmark, performance not verified).`,
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
    status(`Benchmark failed: ${String(err)}`);
  } finally {
    benchmarking = false;
  }
}

function startStatsReporting(): void {
  setInterval(() => {
    const s = inferenceStats.summary();
    api.sendStats({
      cameraFps,
      inferenceAvgMs: s.avg,
      inferenceP95Ms: s.p95,
      delegate,
      numHands,
      source: sourceLabel,
      resolution: `${video.videoWidth}x${video.videoHeight}`,
    });
  }, 500);
}

async function main(): Promise<void> {
  init = await api.getInit();
  api.onCommand((cmd) => {
    if (cmd.type === 'set-camera') {
      init = { ...init, deviceId: cmd.deviceId };
      void startSource(profile);
    } else if (cmd.type === 'rerun-benchmark') {
      void runAndApplyBenchmark();
    }
  });
  try {
    await startSource(profile);
    ensureLoop();
    startStatsReporting();
    if (init.profileOverride) await applySelection(await forcedSelection(init.profileOverride));
    else await runAndApplyBenchmark();
  } catch (err) {
    status(`Tracker error: ${String(err)}`);
  }
}

void main();
