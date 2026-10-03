import { describe, expect, it } from 'vitest';
import { pickBestCameraMode } from '../src/shared/cameraModes';

const m = (width: number, height: number, fps: number) => ({ width, height, fps, negotiatedFps: 30 });

describe('pickBestCameraMode', () => {
  it('prefers the mode that really delivers more frames', () => {
    expect(pickBestCameraMode([m(640, 480, 15), m(1280, 720, 15), m(640, 360, 30)], 640)).toEqual(m(640, 360, 30));
  });
  it('among equally fast modes picks the width closest to the target', () => {
    expect(pickBestCameraMode([m(1280, 720, 30), m(640, 480, 29), m(320, 240, 30)], 640)).toEqual(m(640, 480, 29));
  });
  it('ignores broken entries and handles empty input', () => {
    expect(pickBestCameraMode([], 640)).toBeNull();
    expect(pickBestCameraMode([m(0, 0, 60), m(640, 480, NaN)], 640)).toBeNull();
  });
});
