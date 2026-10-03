import type { ProfileName } from '../shared/types';

export interface CliOptions {
  videoPath?: string;
  profile?: ProfileName;
  hands?: 1 | 2;
  hud: boolean;
}

export function parseCli(argv: string[]): CliOptions {
  const opts: CliOptions = { hud: true };
  for (const arg of argv) {
    if (arg.startsWith('--video=')) opts.videoPath = arg.slice('--video='.length);
    else if (arg.startsWith('--profile=')) {
      const v = arg.slice('--profile='.length);
      if (v === 'low' || v === 'medium' || v === 'high') opts.profile = v;
    } else if (arg.startsWith('--hands=')) {
      const v = arg.slice('--hands='.length);
      if (v === '1') opts.hands = 1;
      else if (v === '2') opts.hands = 2;
    } else if (arg === '--no-hud') opts.hud = false;
  }
  return opts;
}
