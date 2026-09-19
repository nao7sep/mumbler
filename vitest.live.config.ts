import { configDefaults, defineConfig } from "vitest/config";

import base from "./vitest.config";

// The live lane: the real Gemini API and the real managed ffmpeg and ffprobe,
// run only by npm run check:full. Files run one at a time because they share
// the tool cache, spend money, and wait on the network.
export default defineConfig({
  resolve: base.resolve,
  test: {
    environment: "node",
    include: ["tests/live/**/*.test.ts"],
    exclude: configDefaults.exclude,
    setupFiles: base.test?.setupFiles,
    fileParallelism: false,
    testTimeout: 15 * 60_000,
    hookTimeout: 30 * 60_000,
  },
});
