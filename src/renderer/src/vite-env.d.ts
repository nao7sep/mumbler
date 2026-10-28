/// <reference types="vite/client" />

import type { MumblerShellApi } from "@shared/app-shell";

declare global {
  interface Window {
    mumbler: MumblerShellApi;
  }
}

export {};
