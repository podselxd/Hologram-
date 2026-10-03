import { describe, expect, it } from 'vitest';
import { paletteFor, smoothingParams } from '../src/shared/appearance';
import { applyPatch, COLORS, DEFAULT_SETTINGS, sanitizePatch, sanitizeSettings } from '../src/shared/settings';
import { isPreviewImage, isSettingsCommand, isUpdateAction, MAX_PREVIEW_BYTES } from '../src/shared/validate';
import { OneEuroFilter } from '../src/shared/oneEuro';
import { toScreen } from '../src/shared/mapping';

describe('sanitizePatch', () => {
  it('keeps valid fields', () => {
    expect(sanitizePatch({ profile: 'high', hands: 2, color: 'verde', mirror: false })).toEqual({
      profile: 'high',
      hands: 2,
      color: 'verde',
      mirror: false,
    });
  });
  it('drops invalid fields and unknown keys', () => {
    expect(sanitizePatch({ profile: 'ultra', hands: 3, color: 'rojo', mirror: 'yes', evil: true, hud: true, __proto__: { x: 1 } })).toEqual({});
  });
  it('clamps numbers and rejects NaN', () => {
    expect(sanitizePatch({ smoothing: 9, dotSize: -4 })).toEqual({ smoothing: 1, dotSize: 0.6 });
    expect(sanitizePatch({ smoothing: NaN, dotSize: Infinity })).toEqual({});
  });
  it('limits the device id length', () => {
    expect(sanitizePatch({ deviceId: 'x'.repeat(513) })).toEqual({});
    expect(sanitizePatch({ deviceId: 'cam-1' })).toEqual({ deviceId: 'cam-1' });
  });
  it('validates the hand-control settings', () => {
    expect(sanitizePatch({ control: 'on', dominantHand: 'left', zoneSize: 5, zoneOffsetY: -1, pinchSensitivity: 0.7 })).toEqual({
      control: 'on',
      dominantHand: 'left',
      zoneSize: 1,
      zoneOffsetY: -0.3,
      pinchSensitivity: 0.7,
    });
    expect(sanitizePatch({ control: 'always', dominantHand: 'both', zoneSize: NaN })).toEqual({});
    expect(DEFAULT_SETTINGS.control).toBe('test'); // never moves the real mouse until the user says so
    expect(sanitizePatch({ requireArming: true })).toEqual({ requireArming: true });
    expect(sanitizePatch({ requireArming: 'yes' })).toEqual({});
    expect(sanitizePatch({ openAtLogin: true })).toEqual({ openAtLogin: true });
    expect(DEFAULT_SETTINGS.openAtLogin).toBe(false);
  });
  it('validates the camera backend', () => {
    expect(sanitizePatch({ cameraBackend: 'directshow' })).toEqual({ cameraBackend: 'directshow' });
    expect(sanitizePatch({ cameraBackend: 'v4l2' })).toEqual({});
    expect(DEFAULT_SETTINGS.cameraBackend).toBe('auto');
  });
  it('validates the auto-update mode', () => {
    expect(sanitizePatch({ autoUpdate: 'ask' })).toEqual({ autoUpdate: 'ask' });
    expect(sanitizePatch({ autoUpdate: 'always' })).toEqual({});
    expect(DEFAULT_SETTINGS.autoUpdate).toBe('auto');
  });
  it('survives non-objects', () => {
    for (const v of [null, undefined, 5, 'x', []]) expect(sanitizePatch(v)).toEqual({});
  });
});

describe('settings merge', () => {
  it('falls back to defaults for a broken file', () => {
    expect(sanitizeSettings('garbage')).toEqual(DEFAULT_SETTINGS);
  });
  it('removes the device id when set to empty (system default)', () => {
    const s = applyPatch({ ...DEFAULT_SETTINGS, deviceId: 'a' }, { deviceId: '' });
    expect('deviceId' in s).toBe(false);
  });
  it('migrates an old settings file', () => {
    expect(sanitizeSettings({ deviceId: 'cam', safeRender: true })).toEqual({ ...DEFAULT_SETTINGS, deviceId: 'cam', safeRender: true });
  });
});

describe('appearance', () => {
  it('has a palette for every colour', () => {
    for (const c of COLORS) {
      const p = paletteFor(c);
      expect(p.coreStops.length).toBeGreaterThan(2);
      expect(p.trail(0.5)).toMatch(/^rgba\(/);
    }
  });
  it('smoothing is monotonic: more smoothing, lower cutoff', () => {
    expect(smoothingParams(0).minCutoff).toBeGreaterThan(smoothingParams(0.5).minCutoff);
    expect(smoothingParams(0.5).minCutoff).toBeGreaterThan(smoothingParams(1).minCutoff);
    expect(smoothingParams(5).minCutoff).toBeCloseTo(smoothingParams(1).minCutoff);
  });
});

describe('OneEuroFilter.configure', () => {
  it('changes smoothing without losing state', () => {
    const f = new OneEuroFilter(2, 0.05, 1);
    for (let i = 0; i < 20; i++) f.filter(0.5, i * 16.7);
    f.configure(0.3, 0.05);
    const y = f.filter(0.5, 21 * 16.7);
    expect(y).toBeCloseTo(0.5, 3);
  });
});

describe('toScreen mirror', () => {
  it('can be turned off', () => {
    expect(toScreen(0.25, 0.5, 100, 100, false)).toEqual([25, 50]);
    expect(toScreen(0.25, 0.5, 100, 100)).toEqual([75, 50]);
  });
});

describe('ipc validators', () => {
  it('accepts only known commands and update actions', () => {
    expect(isSettingsCommand('quit')).toBe(true);
    expect(isSettingsCommand('rm -rf')).toBe(false);
    expect(isUpdateAction('apply')).toBe(true);
    expect(isUpdateAction('exec')).toBe(false);
    expect(isUpdateAction(undefined)).toBe(false);
  });
  it('bounds preview images', () => {
    const ok = { width: 320, height: 240, data: new Uint8Array(1000) };
    expect(isPreviewImage(ok)).toBe(true);
    expect(isPreviewImage({ ...ok, width: 5 })).toBe(false);
    expect(isPreviewImage({ ...ok, width: 320.5 })).toBe(false);
    expect(isPreviewImage({ ...ok, data: new Uint8Array(MAX_PREVIEW_BYTES + 1) })).toBe(false);
    expect(isPreviewImage({ ...ok, data: 'x' })).toBe(false);
    expect(isPreviewImage(null)).toBe(false);
  });
});
