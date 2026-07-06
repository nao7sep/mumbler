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
    // Isolate the write-through backup store per test: point MUMBLER_HOME at a throwaway root and close the
    // store singleton after each test, so a recording save never touches the developer's real ~/.mumbler
    // and the store re-opens per root (data-backup conventions' test-migration). See the setup file.
    setupFiles: ["tests/setup/backup-store-isolation.ts"],
    coverage: {
      // V8's native coverage; `include` spans all source so the report flags
      // logic no test reaches, not just a score for what is reached.
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      include: ["src/**/*.{ts,tsx}"],
      // Excluded as framework wiring with no decision to cover:
      exclude: [
        "src/main/index.ts", // Electron main entry / bootstrap
        "src/preload/**", // contextBridge wiring
        "src/renderer/src/main.tsx", // React DOM mount
        "**/*.d.ts",
      ],
    },
  },
});
