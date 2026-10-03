import type { Settings } from './settings';
import type {
  CameraInfo,
  Command,
  HandFrame,
  InitConfig,
  PreviewImage,
  ProfileSelection,
  RenderStats,
  SettingsCommand,
  TrackerStats,
  UpdateAction,
  UpdateSnapshot,
} from './types';

/** Surface exposed on `window.hologram` by the preload script (shared by every window). */
export interface HologramApi {
  getInit(): Promise<InitConfig>;
  getSettings(): Promise<Settings>;
  // settings window -> main (validated and sender-checked there)
  patchSettings(patch: Partial<Settings>): void;
  settingsCommand(command: SettingsCommand): void;
  setPreview(enabled: boolean): void;
  updateAction(action: UpdateAction): void;
  // tracker -> main
  sendFrame(frame: HandFrame): void;
  sendStats(stats: TrackerStats): void;
  sendStatus(message: string): void;
  sendProfile(selection: ProfileSelection): void;
  sendCameras(cameras: CameraInfo[]): void;
  sendPreview(image: PreviewImage): void;
  // overlay -> main
  sendRenderStats(stats: RenderStats): void;
  // main -> renderers
  onFrame(cb: (frame: HandFrame) => void): void;
  onStats(cb: (stats: TrackerStats) => void): void;
  onStatus(cb: (message: string) => void): void;
  onProfile(cb: (selection: ProfileSelection) => void): void;
  onCommand(cb: (command: Command) => void): void;
  onSettings(cb: (settings: Settings) => void): void;
  onCameras(cb: (cameras: CameraInfo[]) => void): void;
  onRenderStats(cb: (stats: RenderStats) => void): void;
  onUpdate(cb: (snapshot: UpdateSnapshot) => void): void;
  onPreview(cb: (image: PreviewImage) => void): void;
}

export const CH = {
  init: 'hologram:init',
  getSettings: 'hologram:get-settings',
  patchSettings: 'hologram:patch-settings',
  settings: 'hologram:settings',
  settingsCommand: 'hologram:settings-command',
  setPreview: 'hologram:set-preview',
  updateAction: 'hologram:update-action',
  update: 'hologram:update',
  preview: 'hologram:preview',
  frame: 'hologram:frame',
  stats: 'hologram:stats',
  status: 'hologram:status',
  profile: 'hologram:profile',
  cameras: 'hologram:cameras',
  renderStats: 'hologram:render-stats',
  command: 'hologram:command',
} as const;
