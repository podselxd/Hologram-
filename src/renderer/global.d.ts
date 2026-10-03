import type { HologramApi } from '../shared/api';

declare global {
  interface Window {
    hologram: HologramApi;
  }
}

export {};
