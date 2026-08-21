/// <reference types="vite/client" />

import type { OfflineApi } from "../../shared/contracts";

declare global {
  interface Window {
    offline: OfflineApi;
  }
}

export {};
