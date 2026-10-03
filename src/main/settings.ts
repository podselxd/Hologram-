import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_SETTINGS, sanitizeSettings, type Settings } from '../shared/settings';

export type { Settings };

const file = (): string => path.join(app.getPath('userData'), 'settings.json');

export function loadSettings(): Settings {
  try {
    return sanitizeSettings(JSON.parse(fs.readFileSync(file(), 'utf8')));
  } catch {
    return { ...DEFAULT_SETTINGS }; // first run or unreadable file
  }
}

export function saveSettings(settings: Settings): void {
  try {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), JSON.stringify(settings, null, 2));
  } catch (err) {
    console.error('could not save settings:', err);
  }
}

export function writeReport(name: string, data: unknown): void {
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.writeFileSync(path.join(app.getPath('userData'), name), JSON.stringify(data, null, 2));
  } catch (err) {
    console.error(`could not write ${name}:`, err);
  }
}
