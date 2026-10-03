import type {
  CameraInfo,
  Command,
  HandFrame,
  InitConfig,
  ProfileSelection,
  RenderStats,
  TrackerStats,
} from './types';

/** Surface exposed on `window.hologram` by the preload script. */
export interface HologramApi {
  getInit(): Promise<InitConfig>;
  // tracker -> main -> overlay
  sendFrame(frame: HandFrame): void;
  sendStats(stats: TrackerStats): void;
  sendStatus(message: string): void;
  sendProfile(selection: ProfileSelection): void;
  sendCameras(cameras: CameraInfo[]): void;
  // overlay -> main
  sendRenderStats(stats: RenderStats): void;
  // main -> renderers
  onFrame(cb: (frame: HandFrame) => void): void;
  onStats(cb: (stats: TrackerStats) => void): void;
  onStatus(cb: (message: string) => void): void;
  onProfile(cb: (selection: ProfileSelection) => void): void;
  onCommand(cb: (command: Command) => void): void;
}

export const CH = {
  init: 'hologram:init',
  frame: 'hologram:frame',
  stats: 'hologram:stats',
  status: 'hologram:status',
  profile: 'hologram:profile',
  cameras: 'hologram:cameras',
  renderStats: 'hologram:render-stats',
  command: 'hologram:command',
} as const;
