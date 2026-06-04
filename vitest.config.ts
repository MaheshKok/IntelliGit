// Vitest configuration for unit testing the extension. Excludes VS Code API
// calls which require the Extension Development Host for integration tests.

import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: ["tests/unit/**/*.test.ts", "tests/unit/**/*.test.tsx"],
        globals: true,
        coverage: {
            provider: "v8",
            reporter: ["text", "html"],
            all: true,
            include: ["src/**/*.{ts,tsx}"],
            thresholds: {
                lines: 85,
                functions: 79,
                branches: 77,
                statements: 85,
            },
        },
    },
});
