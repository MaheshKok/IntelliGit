// Core capture: launches one fresh, themed VS Code profile, resolves the
// nested webview frame chain the spike proved reachable, and reads back a
// canonicalized host fixture. This is "the same code path" PLAN.md's Phase 6
// step 39 recaptures in the pinned CI container and byte-compares against
// the committed artifacts -- so this module is written to be called
// programmatically (by `scripts/capture-host-fixtures.ts` today, and by a
// step-39 unit test later), not to be a one-off CLI-only script.

import { _electron as electron } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import {
    canonicalizeClassList,
    canonicalizeDataset,
    canonicalizeStyleCssText,
} from "./canonicalizeHostFixture";
import {
    buildElectronLaunchArgs,
    cleanupDirectories,
    createSanitizedGitEnv,
    createThrowawayGitRepo,
    dismissFirstRunDialogs,
    seedProfileSettings,
    toElectronLaunchEnv,
} from "./electronLaunchHelpers";
import { resolveVSCodeProductInfo } from "./resolveVSCodeProduct";
import { HOST_FIXTURE_SCHEMA_VERSION } from "./types";
import type { HostFixture, HostFixtureThemeConfig, RawHostSnapshot } from "./types";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/** Inputs a capture run needs that are shared across every theme in the matrix, so callers resolve them once (downloading VS Code, in particular) rather than per fixture. */
export interface CaptureHostFixtureOptions {
    readonly vscodeExecutablePath: string;
    readonly repoRoot: string;
    /** How long to keep retrying frame resolution before giving up. Defaults to the same 45s budget the spike's own retry loop uses. */
    readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 45_000;
const FRAME_POLL_INTERVAL_MS = 200;
/**
 * Explicit timeout for `electron.launch()` itself, distinct from
 * `DEFAULT_TIMEOUT_MS` (which only bounds frame-chain resolution *after* the
 * app has launched). Playwright's Electron launch defaults to 180s, which is
 * comfortable on an otherwise-idle machine but was observed empirically to be
 * too tight under real contention -- a dev machine with other heavy
 * processes running, or a loaded CI runner -- where a full VS Code cold
 * start plus the CDP handshake can take longer. A generous, explicit value
 * here is cheap (it only extends the *ceiling*, not the typical run time) and
 * turns "launch was merely slow" into a passing run instead of a flaky
 * failure indistinguishable from a genuinely broken launch.
 */
const ELECTRON_LAUNCH_TIMEOUT_MS = 300_000;
const FRAME_VISIBLE_TIMEOUT_MS = 3_000;

/**
 * Reads the raw (pre-canonicalization) host snapshot out of the currently
 * mounted `#root`, in one `evaluate` round trip. Everything inside the
 * callback runs in the page, not in Node -- it must not close over anything
 * from the outer scope.
 */
async function readRawHostSnapshot(root: Locator): Promise<RawHostSnapshot> {
    return root.evaluate((rootEl) => {
        const doc = rootEl.ownerDocument;
        const docEl = doc.documentElement;
        const body = doc.body;
        return {
            childCount: rootEl.children.length,
            documentElement: {
                styleCssText: docEl.style.cssText,
                classList: Array.from(docEl.classList),
                dataset: { ...docEl.dataset },
            },
            body: {
                classList: Array.from(body.classList),
                dataset: { ...body.dataset },
            },
        };
    });
}

/**
 * Resolves the nested webview frame chain and reads a raw host snapshot,
 * retrying the whole resolution (never reusing a handle across attempts)
 * until it succeeds or `timeoutMs` elapses.
 *
 * This is the same two-reason retry the spike's `resolveMountedRootChildCount`
 * documents in detail: the outer `iframe.webview.ready` is not always present
 * immediately, and VS Code was observed to tear down and rebuild the
 * outer/inner iframe pair once shortly after first reveal, which throws
 * `Frame was detached` against a stale handle. Retrying the whole chain
 * survives both without softening the oracle -- a genuinely broken webview
 * still exhausts `timeoutMs` and throws.
 */
async function resolveHostSnapshotWithRetry(
    window: Page,
    { timeoutMs = DEFAULT_TIMEOUT_MS }: { readonly timeoutMs?: number } = {},
): Promise<RawHostSnapshot> {
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown;

    while (Date.now() < deadline) {
        try {
            const outerFrame = window.frameLocator("iframe.webview.ready").first();
            const innerFrame = outerFrame.frameLocator("iframe#active-frame");
            const root = innerFrame.locator("#root");
            await root.waitFor({ state: "visible", timeout: FRAME_VISIBLE_TIMEOUT_MS });
            return await readRawHostSnapshot(root);
        } catch (error) {
            lastError = error;
            await window.waitForTimeout(FRAME_POLL_INTERVAL_MS);
        }
    }

    throw lastError;
}

/**
 * Captures one canonicalized host fixture for one theme: a fresh sanitized
 * git env, a fresh throwaway repo, a fresh profile with `workbench.colorTheme`
 * pinned to `themeConfig.colorThemeSetting`, a real VS Code launch, and a
 * verified read-back of the theme VS Code actually applied.
 *
 * Fails loudly (never silently retries past, never returns a best-effort
 * result) in exactly two cases:
 *   - `#root` never gains children -- the webview shell exists but React
 *     never mounted into it, so there is no real host state to capture.
 *   - the captured `data-vscode-theme-kind` does not match
 *     `themeConfig.expectedThemeKind` -- the profile seed did not take, or
 *     VS Code's theme-kind mapping changed underneath this fixture.
 */
export async function captureHostFixture(
    themeConfig: HostFixtureThemeConfig,
    { vscodeExecutablePath, repoRoot, timeoutMs }: CaptureHostFixtureOptions,
): Promise<HostFixture> {
    const directoriesToClean: string[] = [];

    try {
        const env = await createSanitizedGitEnv(directoriesToClean);
        const workspacePath = await createThrowawayGitRepo(env, directoriesToClean);

        const userDataDir = await mkdtemp(path.join(tmpdir(), "intelligit-hostfixture-userdata-"));
        directoriesToClean.push(userDataDir);
        const extensionsDir = await mkdtemp(
            path.join(tmpdir(), "intelligit-hostfixture-extensions-"),
        );
        directoriesToClean.push(extensionsDir);

        await seedProfileSettings(userDataDir, themeConfig.colorThemeSetting);

        const electronApp = await electron.launch({
            executablePath: vscodeExecutablePath,
            args: [
                ...buildElectronLaunchArgs({
                    repoRoot,
                    userDataDir,
                    extensionsDir,
                    workspacePath,
                }),
            ],
            env: toElectronLaunchEnv(env),
            timeout: ELECTRON_LAUNCH_TIMEOUT_MS,
        });

        try {
            const window = await electronApp.firstWindow();
            await window.waitForLoadState("domcontentloaded");
            await dismissFirstRunDialogs(window);

            await window.locator('a.action-label[aria-label="IntelliGit"]').click();

            const snapshot = await resolveHostSnapshotWithRetry(window, { timeoutMs });
            if (snapshot.childCount <= 0) {
                throw new Error(
                    `Host fixture capture for "${themeConfig.fixtureId}" found an empty #root -- the ` +
                        "webview shell loaded but React never mounted into it, so there is no real host " +
                        "state to capture.",
                );
            }

            const themeKind = snapshot.body.dataset.vscodeThemeKind ?? "";
            if (themeKind !== themeConfig.expectedThemeKind) {
                throw new Error(
                    `Theme kind mismatch for fixture "${themeConfig.fixtureId}": requested ` +
                        `workbench.colorTheme "${themeConfig.colorThemeSetting}" but the webview reports ` +
                        `data-vscode-theme-kind "${themeKind}" (expected "${themeConfig.expectedThemeKind}"). ` +
                        "Either the seeded profile setting did not apply, or VS Code's theme-kind mapping " +
                        "changed underneath this fixture -- this capture refuses to record a mismatch " +
                        "silently.",
                );
            }

            // Kind alone is far too coarse to prove the theme applied: every
            // built-in dark theme reports `vscode-dark`, so a profile that
            // silently fell back to Abyss passes a kind check while carrying
            // Abyss's colours into a fixture labelled "dark-modern". That is
            // exactly the failure this capture exists to make impossible --
            // an artifact whose provenance is well-formed and whose contents
            // belong to something else. So the observed identity is checked
            // too, and provenance records what was OBSERVED rather than what
            // was requested; recording the request makes the field unable to
            // disagree with reality, which makes it worthless as evidence.
            const observedThemeId = snapshot.body.dataset.vscodeThemeId ?? "";
            const observedThemeName = snapshot.body.dataset.vscodeThemeName ?? "";
            const requested = themeConfig.colorThemeSetting;
            // VS Code populates these from the theme's contributed `id` and its
            // `label`, which are not required to be equal; matching either is
            // sufficient to prove the requested theme is the one that applied.
            if (observedThemeId !== requested && observedThemeName !== requested) {
                throw new Error(
                    `Theme identity mismatch for fixture "${themeConfig.fixtureId}": requested ` +
                        `workbench.colorTheme "${requested}" but the webview reports ` +
                        `data-vscode-theme-id "${observedThemeId}" / data-vscode-theme-name ` +
                        `"${observedThemeName}". The seeded profile setting did not apply, so this ` +
                        "capture would have recorded another theme's colours under the requested " +
                        "theme's name.",
                );
            }

            const productInfo = resolveVSCodeProductInfo(vscodeExecutablePath);

            return {
                provenance: {
                    captureSchemaVersion: HOST_FIXTURE_SCHEMA_VERSION,
                    vscodeVersion: productInfo.version,
                    vscodeCommit: productInfo.commit,
                    platform: `${process.platform}-${process.arch}`,
                    themeId: observedThemeId,
                    themeName: observedThemeName,
                    requestedTheme: requested,
                    themeKind,
                },
                documentElement: {
                    styleCssText: canonicalizeStyleCssText(snapshot.documentElement.styleCssText),
                    classList: canonicalizeClassList(snapshot.documentElement.classList),
                    dataset: canonicalizeDataset(snapshot.documentElement.dataset),
                },
                body: {
                    classList: canonicalizeClassList(snapshot.body.classList),
                    dataset: canonicalizeDataset(snapshot.body.dataset),
                },
            };
        } finally {
            await electronApp.close();
        }
    } finally {
        await cleanupDirectories(directoriesToClean);
    }
}
