// Phase 6d (PLAN.md step 39): recapture each pinned host fixture and compare its
// complete artifact, including provenance and exact serialized bytes.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { captureHostFixture } from "./captureHostFixture";
import { compareHostFixtureStaleness, formatHostFixtureDifferences } from "./hostFixtureComparator";
import { hostFixtureFilePath } from "./hostFixtureFile";
import { HOST_FIXTURE_THEMES } from "./hostFixtureThemes";
import { resolveVSCodeExecutable } from "./resolveVSCodeExecutable";
import { VSCODE_VERSION } from "./vscodeVersion";
import type { HostFixtureThemeConfig } from "./types";

const REPO_ROOT = path.resolve(__dirname, "../../..");
const PER_THEME_TIMEOUT_MS = 15 * 60 * 1000;

async function assertHostFixtureIsFresh(themeConfig: HostFixtureThemeConfig): Promise<void> {
    const executablePath = await resolveVSCodeExecutable(REPO_ROOT, VSCODE_VERSION);
    const capturedFixture = await captureHostFixture(themeConfig, {
        vscodeExecutablePath: executablePath,
        repoRoot: REPO_ROOT,
    });
    // `readFile` deliberately replaces an existence check: missing files and directories are both
    // hard failures, never an empty comparison that could report false success.
    const committedBytes = await readFile(hostFixtureFilePath(REPO_ROOT, themeConfig.fixtureId));
    const differences = compareHostFixtureStaleness(committedBytes, capturedFixture);

    expect(
        differences,
        `Host fixture "${themeConfig.fixtureId}" is stale against pinned VS Code ${VSCODE_VERSION}:\n` +
            formatHostFixtureDifferences(differences),
    ).toEqual([]);
}

// Driven off the theme table rather than four positional lookups, matching `compare.spec.ts`.
// Hardcoded `HOST_FIXTURE_THEMES[0..3]` with hardcoded titles fails in both directions: a fifth
// theme gets no staleness test at all -- silently, since the four that exist still pass -- and a
// reorder leaves each title naming a fixture the body no longer captures.
for (const themeConfig of HOST_FIXTURE_THEMES) {
    test(`pinned host fixture is fresh: ${themeConfig.fixtureId}`, async () => {
        test.setTimeout(PER_THEME_TIMEOUT_MS);
        await assertHostFixtureIsFresh(themeConfig);
    });
}
