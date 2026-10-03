/** Pure pixel generator for the tray icon: a crystal-blue dot, BGRA, premultiplied-free. */
export function trayIconPixels(size: number): Buffer {
  const buf = Buffer.alloc(size * size * 4);
  const c = (size - 1) / 2;
  const radius = size / 2 - 1;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - c, y - c) / radius;
      const i = (y * size + x) * 4;
      if (d > 1) continue; // transparent
      const edge = d > 0.85 ? (1 - d) / 0.15 : 1;
      const t = Math.min(d / 0.9, 1);
      const r = Math.round(235 + (20 - 235) * t);
      const g = Math.round(250 + (80 - 250) * t);
      const b = Math.round(255 + (180 - 255) * t);
      buf[i] = b;
      buf[i + 1] = g;
      buf[i + 2] = r;
      buf[i + 3] = Math.round(255 * edge);
    }
  }
  return buf;
}
