import { build } from 'esbuild';
import { cp, mkdir, rm, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// fileURLToPath (not .pathname) so Windows drive-letter paths resolve correctly.
const p = (rel) => fileURLToPath(new URL(`../${rel}`, import.meta.url));
const dist = p('dist');

try {
  await stat(p('assets/hand_landmarker.task'));
} catch {
  console.error('Missing assets/hand_landmarker.task. Run: npm run fetch-model');
  process.exit(1);
}

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

const common = { bundle: true, sourcemap: true, logLevel: 'info' };
await Promise.all([
  build({ ...common, entryPoints: [p('src/main/main.ts')], outfile: p('dist/main.js'), platform: 'node', format: 'cjs', target: 'node22', external: ['electron'] }),
  build({ ...common, entryPoints: [p('src/main/preload.ts')], outfile: p('dist/preload.js'), platform: 'node', format: 'cjs', target: 'node22', external: ['electron'] }),
  build({ ...common, entryPoints: [p('src/renderer/overlay/overlay.ts')], outfile: p('dist/overlay.js'), platform: 'browser', format: 'iife', target: 'chrome140' }),
  build({ ...common, entryPoints: [p('src/renderer/settings/settings.ts')], outfile: p('dist/settings.js'), platform: 'browser', format: 'iife', target: 'chrome140' }),
  build({ ...common, entryPoints: [p('src/renderer/tracker/tracker.ts')], outfile: p('dist/tracker.js'), platform: 'browser', format: 'iife', target: 'chrome140' }),
]);

await cp(p('src/renderer/overlay/overlay.html'), p('dist/overlay.html'));
await cp(p('src/renderer/tracker/tracker.html'), p('dist/tracker.html'));
await cp(p('src/renderer/settings/settings.html'), p('dist/settings.html'));
await cp(p('node_modules/@mediapipe/tasks-vision/wasm'), p('dist/wasm'), { recursive: true });
await mkdir(p('dist/model'), { recursive: true });
await cp(p('assets/hand_landmarker.task'), p('dist/model/hand_landmarker.task'));
console.log('build complete -> dist/');
