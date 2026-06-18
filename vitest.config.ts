// Vitest configuration for unit testing the extension. Excludes VS Code API
// calls which require the Extension Development Host for integration tests.

import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
        globals: true,
        coverage: {
            provider: "v8",
            reporter: ["text", "html"],
            all: true,
            include: ["src/**/*.{ts,tsx}"],
            // Coverage ratchet: thresholds are a floor set a small margin
            // (~0.4-0.8pp) below the lowest aggregate reported across local
            // and CI runs of `bun run test:coverage`. The margin absorbs V8
            // instrumentation differences between platforms (e.g. macOS local
            // vs Linux/Node 22 in CI count branches and statements slightly
            // differently), which previously broke CI when thresholds were
            // pinned to the exact local numbers with zero headroom. CI is the
            // gate, so validate any increase against a CI run, not just local,
            // and keep the margin when ratcheting up.
            thresholds: {
                lines: 88.5,
                functions: 83.0,
                branches: 80.5,
                statements: 88.5,
            },
        },
    },
});
