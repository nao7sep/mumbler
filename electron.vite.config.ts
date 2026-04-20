import { resolve } from "node:path";

import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";

export default defineConfig({
  main: {
    build: {
      outDir: "out/main",
    },
    define: {
      "process.env.WS_NO_BUFFER_UTIL": '"1"',
      "process.env.WS_NO_UTF_8_VALIDATE": '"1"',
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
    build: {
      outDir: resolve("out/renderer"),
      emptyOutDir: true,
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

