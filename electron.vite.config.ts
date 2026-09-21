import { resolve } from "node:path";

import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";

import { defineConfig } from "electron-vite";

// Single source of truth for the app version: package.json, injected as
// __APP_VERSION__. Electron's own getVersion() answers about the running binary,
// so an unpackaged run reported Electron's version as the app's.
const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

export default defineConfig({
  main: {
    build: {
      outDir: "out/main",
      rollupOptions: {
        input: {
          index: resolve("src/main/index.ts"),
          "backup-store-worker": resolve("src/main/core/backup-store-worker.ts"),
        },
        output: {
          entryFileNames: "[name].js",
        },
      },
    },
    define: {
      "process.env.WS_NO_BUFFER_UTIL": '"1"',
      "process.env.WS_NO_UTF_8_VALIDATE": '"1"',
      __APP_VERSION__: JSON.stringify(version),
    },
    resolve: {
      alias: {
        "@shared": resolve("src/shared"),
      },
    },
  },
  preload: {
    build: {
      outDir: "out/preload",
      rollupOptions: {
        output: {
          format: "cjs",
          entryFileNames: "[name].cjs",
        },
      },
    },
    resolve: {
      alias: {
        "@shared": resolve("src/shared"),
      },
    },
  },
  renderer: {
    root: resolve("src/renderer"),
    server: {
      host: "127.0.0.1",
      port: 27259,
      strictPort: true,
    },
    build: {
      outDir: resolve("out/renderer"),
      emptyOutDir: true,
      minify: true,
    },
    resolve: {
      alias: {
        "@renderer": resolve("src/renderer/src"),
        "@shared": resolve("src/shared"),
      },
    },
    plugins: [react()],
  },
});
