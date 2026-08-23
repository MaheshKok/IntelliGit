// Layer 1 early warning: capture the pinned and Insiders builds in the same
// container, then compare their observable host payloads without rewriting
// the committed fixtures.
import path from "node:path";
import { expect, test } from "@playwright/test";
import { captureHostFixture } from "./captureHostFixture";
import { readConsumedThemeTokens } from "./consumedThemeTokens";
import { compareHostFixtures, formatHostFixtureDifferences } from "./hostFixtureComparator";
import { HOST_FIXTURE_THEMES } from "./hostFixtureThemes";
import { resolveVSCodeExecutable } from "./resolveVSCodeExecutable";
import { VSCODE_VERSION } from "./vscodeVersion";

const REPO_ROOT = path.resolve(__dirname, "../../..");
const PINNED_VSCODE_VERSION = VSCODE_VERSION;
const INSIDERS_VSCODE_VERSION = "insiders";
const BEFORE_ALL_TIMEOUT_MS = 20 * 60 * 1000;
const PER_THEME_TIMEOUT_MS = 15 * 60 * 1000;

let resolvedExecutables:
    | {
          readonly pinned: string;
          readonly insiders: string;
      }
    | undefined;

/**
 * The theme tokens this extension reads, scanned from `src` once for all four themes.
 *
 * Derived rather than listed: a hand-kept list would go stale the first time a webview styles
 * itself with a token nobody remembered to add, and the canary would stop watching it silently.
 * `readConsumedThemeTokens` throws rather than returning a short set, so a broken scan fails these
 * tests instead of quietly passing them.
 */
let consumedThemeTokens: ReadonlySet<string> | undefined;

test.beforeAll(async () => {
    // globalSetup pre-downloads the pinned build. This hook resolves that cached executable and
    // downloads the second build once, before the four per-theme tests begin.
    test.setTimeout(BEFORE_ALL_TIMEOUT_MS);
    consumedThemeTokens = readConsumedThemeTokens(REPO_ROOT);
    const pinned = await resolveVSCodeExecutable(REPO_ROOT, PINNED_VSCODE_VERSION);
    const insiders = await resolveVSCodeExecutable(REPO_ROOT, INSIDERS_VSCODE_VERSION);
    resolvedExecutables = { pinned, insiders };
});

for (const themeConfig of HOST_FIXTURE_THEMES) {
    test(`Insiders host fixture matches pinned payload: ${themeConfig.fixtureId}`, async () => {
        // Each theme performs two sequential real VS Code launches. With a 300s launch ceiling and
        // a 45s frame-resolution ceiling per capture, 15 minutes leaves room for setup/cleanup and
        // CI contention without making a genuinely hung test unbounded.
        test.setTimeout(PER_THEME_TIMEOUT_MS);

        if (!resolvedExecutables || !consumedThemeTokens) {
            throw new Error(
                "Host-fixture executables and consumed theme tokens were not resolved by beforeAll.",
            );
        }

        const pinnedFixture = await captureHostFixture(themeConfig, {
            vscodeExecutablePath: resolvedExecutables.pinned,
            repoRoot: REPO_ROOT,
        });
        const insidersFixture = await captureHostFixture(themeConfig, {
            vscodeExecutablePath: resolvedExecutables.insiders,
            repoRoot: REPO_ROOT,
        });
        const differences = compareHostFixtures(
            pinnedFixture,
            insidersFixture,
            consumedThemeTokens,
        );

        expect(
            differences,
            `Host fixture "${themeConfig.fixtureId}" differs between VS Code ${PINNED_VSCODE_VERSION} ` +
                `and Insiders, across the ${consumedThemeTokens.size} theme tokens this extension ` +
                `reads:\n${formatHostFixtureDifferences(differences)}`,
        ).toEqual([]);
    });
}
