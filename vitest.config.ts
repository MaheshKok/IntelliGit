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
            // Coverage ratchet: keep these thresholds at the latest passing
            // aggregate values reported by `bun run test:coverage`. When a
            // change improves coverage, raise the corresponding value in the
            // same commit so future edits cannot silently lower the baseline.
            thresholds: {
                lines: 88.72,
                functions: 83.63,
                branches: 80.21,
                statements: 88.72,
            },
        },
    },
});
