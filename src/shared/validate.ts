import type { PreviewImage, SettingsCommand, UpdateAction } from './types';

const COMMANDS: readonly string[] = ['rerun-benchmark', 'toggle-overlay', 'quit'];
const ACTIONS: readonly string[] = ['check', 'download', 'apply', 'rollback'];

export const MAX_PREVIEW_BYTES = 2_000_000;

export const isSettingsCommand = (v: unknown): v is SettingsCommand => typeof v === 'string' && COMMANDS.includes(v);
export const isUpdateAction = (v: unknown): v is UpdateAction => typeof v === 'string' && ACTIONS.includes(v);

/** Structural check of an IPC payload: sizes are bounded so a bad renderer cannot flood the main process. */
export function isPreviewImage(v: unknown): v is PreviewImage {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  const w = o['width'];
  const h = o['height'];
  const d = o['data'];
  if (typeof w !== 'number' || typeof h !== 'number' || !Number.isInteger(w) || !Number.isInteger(h)) return false;
  if (w < 16 || h < 16 || w > 1920 || h > 1920) return false;
  return d instanceof Uint8Array && d.byteLength > 0 && d.byteLength <= MAX_PREVIEW_BYTES;
}
