/// <reference types="vite/client" />

import type { MumblerBridgeApi } from "@shared/app-shell";

declare global {
  interface Window {
    mumbler: MumblerBridgeApi;
  }
}

export {};
