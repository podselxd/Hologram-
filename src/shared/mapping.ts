/**
 * Phase 1 mapping: the whole camera image is stretched over the screen and
 * mirrored horizontally, so the overlay behaves like a mirror.
 * (Phase 2 replaces this with a calibrated control zone.)
 */
export function toScreen(x01: number, y01: number, width: number, height: number, mirror = true): [number, number] {
  return [(mirror ? 1 - x01 : x01) * width, y01 * height];
}

/** MediaPipe hand skeleton as pairs of landmark indices. */
export const HAND_CONNECTIONS: ReadonlyArray<readonly [number, number]> = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
];

export const FINGERTIPS = [4, 8, 12, 16, 20] as const;
