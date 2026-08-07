// Phase 0 steps 4-5 (PLAN.md): drives the capture of the HOST FIXTURES
// Layer 1's visual harness will render bundles against -- one canonicalized
// artifact per required built-in theme (dark-modern, light-modern, hc-black,
// hc-light).
//
// Re-runnable by design, not a one-off: PLAN.md's Phase 6 step 39
// recaptures all four fixtures in the pinned CI container and byte-compares
// the canonicalized output against what is committed under
// tests/visual/fixtures/host/ -- so this script's contract is to be the
// *same code path* every time it runs, local or CI, not a throwaway tool.
//
// Usage: `bun run capture:host-fixtures`
//
// This file only verifies build freshness and then spawns the Playwright
// test runner -- it does not call `captureHostFixture` itself. Found
// empirically: driving `_electron.launch()` from a bare `bun <script>.ts`
// process hangs indefinitely establishing the CDP WebSocket connection to
// Electron (reproduced three times, each exhausting a 300s timeout with the
// `101 Switching Protocols` response arriving only after the forced kill).
// The identical `captureHostFixture` call, unchanged, succeeded in 8.2s the
// moment it was driven through `node_modules/.bin/playwright test` instead
// (real Node -- the same mechanism `tests/e2e/spike/launch.spec.ts` already
// proved reliable). The actual capture therefore lives in
// `tests/e2e/hostFixtures/capture.spec.ts`; this script is the Bun-side
// pre-flight (no Electron involved here, so no hang risk) plus the process
// boundary that hands off to Node for the part that launches Electron.

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyBuildProvenance } from "./verifyBuildProvenance";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function main(): void {
    assertBuildIsFresh();

    const playwrightBin = path.join(REPO_ROOT, "node_modules", ".bin", "playwright");
    const result = spawnSync(
        playwrightBin,
        [
            "test",
            "--config=playwright.e2e.config.ts",
            "tests/e2e/hostFixtures/capture.spec.ts",
            "--reporter=list",
        ],
        {
            cwd: REPO_ROOT,
            stdio: "inherit",
            // Real Node, not Bun -- see this file's header comment for why
            // that distinction is load-bearing rather than incidental.
            env: { ...process.env },
        },
    );

    if (result.error) {
        console.error("capture-host-fixtures: failed to spawn the Playwright test runner:");
        console.error(result.error);
        process.exitCode = 1;
        return;
    }

    process.exitCode = result.status ?? 1;
}

/**
 * Fails fast, before spending minutes launching VS Code four times, if
 * `dist/` is missing or stale relative to its own build manifest. A capture
 * against a stale webview build would still likely mount something (this
 * script's own child-count check would not catch a webview that "works" but
 * is simply old code), so this check -- not the mount check -- is what
 * guarantees freshness.
 */
function assertBuildIsFresh(): void {
    const { ok, errors } = verifyBuildProvenance();
    if (!ok) {
        console.error("capture-host-fixtures: refusing to capture against an unverified build:");
        for (const error of errors) {
            console.error(`  - ${error}`);
        }
        console.error('Run "bun run build" first.');
        process.exit(1);
    }
}

main();
