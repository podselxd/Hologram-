import type { ColorPreset } from './settings';

export interface Palette {
  glowStops: Array<[number, string]>;
  coreStops: Array<[number, string]>;
  halo: string;
  rim: string;
  line: string;
  trail: (alpha: number) => string;
}

interface Base {
  /** Bright glow / halo colour. */
  glow: [number, number, number];
  /** Saturated body of the dot. */
  mid: [number, number, number];
  /** Dark rim that keeps dots visible on white windows. */
  rim: [number, number, number];
  /** Light colour of the skeleton lines. */
  line: [number, number, number];
  /** Light tint between the white centre and the body. */
  light: [number, number, number];
}

const BASES: Record<ColorPreset, Base> = {
  azul: { glow: [60, 160, 255], mid: [40, 140, 255], rim: [15, 70, 170], line: [130, 215, 255], light: [110, 205, 255] },
  cian: { glow: [40, 230, 230], mid: [20, 200, 220], rim: [0, 100, 120], line: [140, 255, 245], light: [120, 245, 240] },
  violeta: { glow: [170, 110, 255], mid: [140, 90, 255], rim: [70, 40, 150], line: [210, 180, 255], light: [190, 150, 255] },
  verde: { glow: [80, 255, 150], mid: [50, 220, 120], rim: [10, 100, 60], line: [170, 255, 200], light: [130, 255, 170] },
};

const rgba = ([r, g, b]: [number, number, number], a: number): string => `rgba(${r},${g},${b},${a})`;

export function paletteFor(color: ColorPreset): Palette {
  const b = BASES[color];
  return {
    glowStops: [
      [0, rgba(b.glow, 0.35)],
      [0.5, rgba(b.mid, 0.12)],
      [1, rgba(b.mid, 0)],
    ],
    coreStops: [
      [0, 'rgba(245,252,255,1)'],
      [0.3, rgba(b.light, 0.98)],
      [0.62, rgba(b.mid, 0.95)],
      [0.85, rgba(b.rim, 0.85)],
      [1, rgba(b.rim, 0)],
    ],
    halo: rgba(b.mid, 0.22),
    rim: rgba(b.rim, 0.55),
    line: rgba(b.line, 0.95),
    trail: (alpha) => rgba(b.glow, Number(alpha.toFixed(3))),
  };
}

/** Maps the 0..1 smoothing slider to One-Euro parameters (0 = responsive, 1 = smooth). */
export function smoothingParams(smoothing: number): { minCutoff: number; beta: number } {
  const s = Math.min(1, Math.max(0, smoothing));
  return { minCutoff: 2.2 - 1.8 * s, beta: 0.05 };
}
