/**
 * The app's version, single-sourced from package.json and injected as a build
 * define (electron.vite.config.ts). Electron's app.getVersion() answers about the
 * running binary, which is this app only when it is packaged.
 */
declare const __APP_VERSION__: string;
