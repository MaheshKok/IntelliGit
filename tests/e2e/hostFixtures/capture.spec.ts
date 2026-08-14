// Phase 0 steps 4-5 (PLAN.md): the actual capture of all four HOST FIXTURES,
// run as a Playwright test rather than a bare script.
//
// This is not a style choice. Every one of the four fixture captures drives
// a real `_electron.launch()` against downloaded VS Code, and that call was
// found empirically to hang indefinitely -- reproduced three separate times,
// exhausting a 300s timeout every time, the CDP WebSocket's `101 Switching
// Protocols` response arriving only after the forced kill -- whenever it was
// invoked by a bare `bun <script>.ts` process. The exact same
// `captureHostFixture` call, unchanged, driven instead through
// `node_modules/.bin/playwright test` (real Node, the same mechanism
// `tests/e2e/spike/launch.spec.ts` already proved reliable) succeeded in
// 8.2s. `scripts/capture-host-fixtures.ts` is the `bun run
// capture:host-fixtures` entry point a developer runs; it now only verifies
// build freshness under Bun (no Electron involved, so no hang risk) and
// spawns this file through the Playwright test runner for the part that
// actually launches Electron.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "@playwright/test";
import { HOST_FIXTURE_CAPTURE_TIMEOUT_MS } from "./captureBudget";
import { captureHostFixture } from "./captureHostFixture";
import { HOST_FIXTURE_THEMES } from "./hostFixtureThemes";
import { hostFixtureFilePath, hostFixtureOutputDir, serializeHostFixture } from "./hostFixtureFile";
import { resolveVSCodeExecutable } from "./resolveVSCodeExecutable";
import type { HostFixture, HostFixtureId } from "./types";

const REPO_ROOT = path.resolve(__dirname, "../../..");

interface CapturedEntry {
    readonly fixtureId: HostFixtureId;
    readonly fixture: HostFixture;
}

/**
 * Guards against the exact failure mode PLAN.md calls out for this step:
 * four fixtures that are silently identical (every capture reusing whatever
 * theme was already active, or a broken theme seed) would still produce four
 * files and a green run. Distinct `themeKind` across every capture is the
 * cheapest structural proof each one actually ran against the theme it was
 * asked for -- and `captureHostFixture` already fails loudly on a
 * requested-vs-observed mismatch, so this is a second, independent check
 * across the whole batch, not a restatement of that one.
 */
function assertFixturesAreGenuinelyDistinct(captured: readonly CapturedEntry[]): void {
    const seenKinds = new Map<string, HostFixtureId>();
    for (const { fixtureId, fixture } of captured) {
        const kind = fixture.provenance.themeKind;
        const existingFixtureId = seenKinds.get(kind);
        if (existingFixtureId) {
            throw new Error(
                `Host fixture capture bug: "${fixtureId}" and "${existingFixtureId}" both captured ` +
                    `themeKind "${kind}". Fixtures must be genuinely distinct, not four copies of one ` +
                    "theme -- this is a bug in the capture, not a result to report as success.",
            );
        }
        seenKinds.set(kind, fixtureId);
    }
}

test("capture all four host fixtures (dark-modern, light-modern, hc-black, hc-light)", async () => {
    // Derived from the per-launch and per-frame ceilings rather than picked, so
    // this bound can never fall BELOW the ones nested inside it. The previous
    // hand-picked ten minutes did exactly that -- four launches at a 300s
    // ceiling each need twenty minutes of headroom before the second one can
    // even reach its own timeout -- which replaced every specific launch failure
    // with a generic "Test timeout of 600000ms exceeded". See captureBudget.ts.
    test.setTimeout(HOST_FIXTURE_CAPTURE_TIMEOUT_MS);

    const executablePath = await resolveVSCodeExecutable(REPO_ROOT);
    await mkdir(hostFixtureOutputDir(REPO_ROOT), { recursive: true });

    const captured: CapturedEntry[] = [];
    for (const themeConfig of HOST_FIXTURE_THEMES) {
        // eslint-disable-next-line no-console
        console.log(
            `Capturing host fixture "${themeConfig.fixtureId}" (workbench.colorTheme="${themeConfig.colorThemeSetting}")...`,
        );

        // Sequential, not parallel: each capture launches a full VS Code
        // instance under a fresh profile, and PLAN.md step 5 requires each
        // theme in its own fresh profile -- running four at once would only
        // race disk/CPU for no benefit this capture needs.
        // eslint-disable-next-line no-await-in-loop
        const fixture = await captureHostFixture(themeConfig, {
            vscodeExecutablePath: executablePath,
            repoRoot: REPO_ROOT,
        });
        captured.push({ fixtureId: themeConfig.fixtureId, fixture });

        const outputPath = hostFixtureFilePath(REPO_ROOT, themeConfig.fixtureId);
        // eslint-disable-next-line no-await-in-loop
        await writeFile(outputPath, serializeHostFixture(fixture), "utf8");

        // eslint-disable-next-line no-console
        console.log(
            `  themeKind=${fixture.provenance.themeKind} ` +
                `body.classList=[${fixture.body.classList.join(", ")}] ` +
                `-> ${path.relative(REPO_ROOT, outputPath)}`,
        );
    }

    assertFixturesAreGenuinelyDistinct(captured);
    // eslint-disable-next-line no-console
    console.log(`\nCaptured ${captured.length} host fixtures.`);
});
