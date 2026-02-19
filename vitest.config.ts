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
            include: [
                "src/webviews/react/branch-column/menu.ts",
                "src/webviews/react/branch-column/treeModel.ts",
                "src/webviews/react/branch-column/highlight.tsx",
                "src/webviews/react/commit-list/commitMenu.tsx",
                "src/webviews/react/commitGraphTypes.ts",
                "src/webviews/react/shared/fileTree.ts",
            ],
            thresholds: {
                lines: 90,
                functions: 90,
                branches: 90,
                statements: 90,
            },
        },
    },
});
