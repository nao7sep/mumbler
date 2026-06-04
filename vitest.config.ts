import { resolve } from "node:path";

import { defineConfig } from "vitest/config";

// Tests live under tests/, mirroring the src/ tree, and reach their subjects
// through the same path aliases the app uses. The default node environment suits
// the pure main/shared logic; the keyboard/DOM helpers under the renderer opt
// into jsdom via a per-file `// @vitest-environment jsdom` pragma, so no
// glob-based environment matching is needed here.
export default defineConfig({
  resolve: {
    alias: {
      "@shared": resolve("src/shared"),
      "@main": resolve("src/main"),
      "@renderer": resolve("src/renderer/src"),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
