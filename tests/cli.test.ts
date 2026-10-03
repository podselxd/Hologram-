import { describe, expect, it } from 'vitest';
import { parseCli } from '../src/main/cli';
import { trayIconPixels } from '../src/main/iconPixels';

describe('parseCli', () => {
  it('has safe defaults', () => {
    expect(parseCli([])).toEqual({ hud: true, safeRender: false });
  });
  it('reads every option', () => {
    const o = parseCli(['--video=a.webm', '--profile=high', '--hands=1', '--no-hud', '--safe-render']);
    expect(o).toEqual({ videoPath: 'a.webm', profile: 'high', hands: 1, hud: false, safeRender: true });
  });
  it('ignores invalid values', () => {
    const o = parseCli(['--profile=ultra', '--hands=3']);
    expect(o.profile).toBeUndefined();
    expect(o.hands).toBeUndefined();
  });
});

describe('trayIconPixels', () => {
  it('draws an opaque centre and transparent corners', () => {
    const size = 32;
    const px = trayIconPixels(size);
    expect(px.length).toBe(size * size * 4);
    const centre = ((size / 2) * size + size / 2) * 4;
    expect(px[centre + 3]).toBe(255);
    expect(px[3]).toBe(0);
  });
});
