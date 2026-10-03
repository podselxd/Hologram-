import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

export interface Settings {
  deviceId?: string;
}

const file = (): string => path.join(app.getPath('userData'), 'settings.json');

export function loadSettings(): Settings {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(file(), 'utf8'));
    if (raw && typeof raw === 'object' && typeof (raw as Settings).deviceId === 'string') {
      return { deviceId: (raw as Settings).deviceId };
    }
  } catch {
    // first run or unreadable file: defaults
  }
  return {};
}

export function saveSettings(settings: Settings): void {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(settings, null, 2));
}

export function writeReport(name: string, data: unknown): void {
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.writeFileSync(path.join(app.getPath('userData'), name), JSON.stringify(data, null, 2));
  } catch (err) {
    console.error(`could not write ${name}:`, err);
  }
}
