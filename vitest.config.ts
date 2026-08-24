// Vitest configuration for unit testing the extension. Excludes VS Code API
// calls which require the Extension Development Host for integration tests.

import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
        globals: true,
        // Pins the Git configuration every test subprocess sees. See the module's own comment for
        // why this is process-level rather than per-module. `tests/unit/gitEnvironmentIsolation.
        // test.ts` fails if this line is removed, so the guarantee cannot be dropped silently.
        setupFiles: ["./tests/setup/gitEnvironment.ts"],
        // Deliberately NOT `restoreMocks: true`. It is the right default for a suite written
        // against it, but not for this one: the webview tests install `window.matchMedia` and
        // friends once per file and share them across their cases, so restoring after every test
        // leaves the second case onward reading `undefined` (~60 failures, `Cannot read properties
        // of undefined (reading 'matches')`). Files that spy on shared globals restore their own
        // spies instead -- see `tests/unit/e2e/pageObjects.test.ts`.
        // The shelf suites drive a real repository, so one test can spawn dozens of
        // git processes. Vitest's 5s default is comfortable until v8 coverage
        // instrumentation is layered on top, at which point the slowest of them time
        // out — which reads as a broken test rather than a slow one.
        testTimeout: 30_000,
        hookTimeout: 30_000,
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
            //
            // Re-baselined for `@vitest/coverage-v8` 4, and NOT comparable with
            // the floors that stood before it. That release maps V8's raw byte
            // ranges back through the source AST (`ast-v8-to-istanbul`) instead
            // of scoring the transpiled output, so the same fully-green suite
            // is now measured differently rather than measured worse. Measured
            // under it: statements 84.99, lines 87.65, branches 78.43 -- all
            // below floors the suite used to clear -- and functions 85.95,
            // which is ABOVE its old floor of 83.0. A change that moves two
            // metrics down and one up is an instrument change; lost coverage
            // does not improve a metric. 286 of 286 files pass either way.
            //
            // `functions` is now ratcheted on that CI number rather than on the
            // local one. PR #188's `build` job reported 84.98 / 78.31 / 85.90 /
            // 87.65 (stmts / branch / funcs / lines) against local 85.01 /
            // 78.42 / 85.98 / 87.67, so CI is the lower side on all four and is
            // what the floors are set from. 85.90 - 0.8 puts `functions` at
            // 85.1, restoring the same margin the other three already carry
            // (0.68, 0.61, 0.65) instead of the 2.9pp of slack it inherited
            // from the pre-upgrade instrument.
            thresholds: {
                lines: 87.0,
                functions: 85.1,
                branches: 77.7,
                statements: 84.3,
            },
        },
    },
});
