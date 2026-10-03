export interface CameraModeResult {
  width: number;
  height: number;
  /** Frames per second actually delivered in this mode (measured). */
  fps: number;
  /** Frame rate the camera claimed for this mode. */
  negotiatedFps: number;
}

/**
 * Picks the camera mode to keep after a probe: the fastest one, and among modes within 10 % of the fastest,
 * the one whose width is closest to what the profile wants (the hand model does not need more pixels).
 */
export function pickBestCameraMode(results: CameraModeResult[], targetWidth: number): CameraModeResult | null {
  const valid = results.filter((r) => r.width > 0 && r.height > 0 && Number.isFinite(r.fps) && r.fps >= 0);
  if (valid.length === 0) return null;
  const top = Math.max(...valid.map((r) => r.fps));
  const near = valid.filter((r) => r.fps >= top * 0.9);
  near.sort((a, b) => Math.abs(a.width - targetWidth) - Math.abs(b.width - targetWidth) || b.fps - a.fps);
  return near[0] ?? null;
}
