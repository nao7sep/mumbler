import { resolve } from "node:path";

import { defineConfig } from "vitest/config";

// Tests live next to the code they cover as *.test.ts. The default node
// environment suits the pure main/shared logic; the keyboard/DOM helpers under
// the renderer opt into jsdom via a per-file `// @vitest-environment jsdom`
// pragma, so no glob-based environment matching is needed here.
export default defineConfig({
  resolve: {
    alias: {
      "@shared": resolve("src/shared"),
      "@renderer": resolve("src/renderer/src"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
