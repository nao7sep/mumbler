export const APP_SHELL_CHANNELS = {
  getBootstrap: "app-shell:get-bootstrap",
} as const;

export type CardStatus =
  | "Pending Review"
  | "Imported"
  | "Transcribing"
  | "Generating Metadata"
  | "Ready to Save"
  | "Error";

export interface AppBootstrap {
  appName: string;
  appVersion: string;
  platform: NodeJS.Platform;
  isPackaged: boolean;
  shellReadyAtUtc: string;
}

export interface MumblerShellApi {
  getBootstrap(): Promise<AppBootstrap>;
}

