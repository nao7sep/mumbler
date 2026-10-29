import { configDefaults, defineConfig } from "vitest/config";

import base from "./vitest.config";

// The live lane: the real Gemini API and the real managed ffmpeg and ffprobe,
// run only by npm run test:full. Files run one at a time because they share
// the tool cache, spend money, and wait on the network.
export default defineConfig({
  define: base.define,
  resolve: base.resolve,
  test: {
    environment: "node",
    include: ["tests/live/**/*.test.ts"],
    exclude: configDefaults.exclude,
    setupFiles: base.test?.setupFiles,
    fileParallelism: false,
    // Tests carry no timeouts (tests-folder-conventions).
    testTimeout: 0,
    hookTimeout: 0,
  },
});
