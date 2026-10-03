import { mkdir, stat, writeFile } from 'node:fs/promises';

const URL_ = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';
const OUT = new URL('../assets/hand_landmarker.task', import.meta.url);

try {
  const existing = await stat(OUT);
  if (existing.size > 1_000_000) {
    console.log('hand_landmarker.task already present');
    process.exit(0);
  }
} catch {
  // not downloaded yet
}

const res = await fetch(URL_);
if (!res.ok) {
  console.error(`download failed: HTTP ${res.status}`);
  process.exit(1);
}
const data = Buffer.from(await res.arrayBuffer());
if (data.length < 1_000_000) {
  console.error(`download looks truncated (${data.length} bytes)`);
  process.exit(1);
}
await mkdir(new URL('../assets/', import.meta.url), { recursive: true });
await writeFile(OUT, data);
console.log(`saved hand_landmarker.task (${(data.length / 1e6).toFixed(1)} MB)`);
