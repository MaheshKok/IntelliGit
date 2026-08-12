// Phase 0 spike (PLAN.md step 3). This file exists to answer exactly one
// empirical question before any Layer-2 E2E infrastructure is built: can
// Playwright's `_electron` reach inside a real VS Code Extension Development
// Host, through its nested webview iframes, and see IntelliGit's React root
// actually mount with real content?
//
// This is deliberately NOT a fixture-repo test (a seeded fixture repository
// is Phase 1) and NOT a contentful assertion about IntelliGit's UI beyond
// "it rendered something real". The oracle here -- #root has children -- is
// chosen because it is provably able to fail: a broken webview build, a
// wrong frame in the resolution chain, or a webview that never mounts React
// all leave `#root` as the empty `<div id="root"></div>` that
// webviewHtml.ts's `buildWebviewShellHtml` always writes before the bundle
// runs (src/views/webviewHtml.ts:90). See PLAN.md "Governing principle".
//
// Selector chain confirmed empirically against a real 1.132.0 build
// (see the Phase 0 report for the exact evidence):
//   window.frameLocator("iframe.webview.ready").first()
//         .frameLocator("iframe#active-frame")
//         .locator("#root")
// VS Code wraps every webview in two nested iframes: an outer sandboxed
// `iframe.webview.ready` that VS Code itself owns, wrapping an inner
// `iframe#active-frame` that is the extension's actual document. `.first()`
// is deliberate, not incidental: IntelliGit registers two sibling webview
// views in the same activity-bar container (`intelligit.commitPanel` and
// `intelligit.sidebarGraph`, package.json `contributes.views.intelligit`),
// so more than one `iframe.webview.ready` can be present simultaneously.
// Observed DOM order put the Commit panel first; if a later phase needs a
// specific one of several webviews, resolve it by content instead of index.

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { test, expect, _electron as electron } from "@playwright/test";
import { toElectronLaunchEnv } from "../hostFixtures/electronLaunchHelpers";
import { resolveVSCodeExecutable } from "../hostFixtures/resolveVSCodeExecutable";

const execFileAsync = promisify(execFile);

// The pinned VS Code build this spike launches is no longer duplicated here:
// it lives in `tests/e2e/hostFixtures/vscodeVersion.ts` and is applied by
// `resolveVSCodeExecutable`. Two copies of a version pin drift, and the whole
// point of pinning is that a VS Code release landing overnight cannot turn
// this suite red without a deliberate, single-place bump.

const REPO_ROOT = path.resolve(__dirname, "../../..");

/**
 * Fixed git identity and commit dates applied to every git process this
 * spike spawns, extending the technique in
 * tests/integration/rebase/rebaseTestHarness.ts (deterministicGitEnvironment)
 * with the config/HOME isolation a full Electron launch also needs.
 */
const GIT_IDENTITY = {
    GIT_AUTHOR_NAME: "IntelliGit Spike",
    GIT_AUTHOR_EMAIL: "intelligit-spike@example.invalid",
    GIT_COMMITTER_NAME: "IntelliGit Spike",
    GIT_COMMITTER_EMAIL: "intelligit-spike@example.invalid",
    GIT_AUTHOR_DATE: "2000-01-01T00:00:00 +0000",
    GIT_COMMITTER_DATE: "2000-01-01T00:00:00 +0000",
} as const;

const directoriesToClean: string[] = [];

test.afterAll(async () => {
    // maxRetries/retryDelay matter here, not just belt-and-suspenders: a bare
    // `{ recursive: true, force: true }` failed empirically with `ENOTEMPTY`
    // on the scratch HOME directory, because a background process VS Code or
    // git spawned into that HOME can still be flushing a file to disk in the
    // brief window after `electronApp.close()` resolves but before this hook
    // runs -- a real race, not a hypothetical one. Retrying self-heals it
    // without masking a genuinely stuck directory, which still exhausts the
    // retries and rejects.
    await Promise.all(
        directoriesToClean
            .splice(0)
            .map((directory) =>
                rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }),
            ),
    );
});

/**
 * Builds a sanitized git environment rooted at a fresh scratch HOME, so a
 * developer's real `~/.gitconfig`, credential helper, or global ignore file
 * can never leak into what the extension or its git subprocesses see.
 */
async function createSanitizedGitEnv(): Promise<Record<string, string>> {
    const home = await mkdtemp(path.join(tmpdir(), "intelligit-spike-home-"));
    directoriesToClean.push(home);
    // `toElectronLaunchEnv` drops undefined-valued process keys before Electron sees them; a cast
    // would compile and then pass an actual undefined through the child-process boundary.
    const inherited = toElectronLaunchEnv(process.env);
    return {
        ...inherited,
        HOME: home,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
        ...GIT_IDENTITY,
    };
}

/**
 * Initializes a minimal one-commit repository -- just enough for VS Code's
 * `workspaceContains:.git` activation event to activate the extension. A
 * fully seeded fixture repository exercising the mutating command surface is
 * Phase 1 (PLAN.md step 7), not this spike.
 */
async function createThrowawayGitRepo(env: NodeJS.ProcessEnv): Promise<string> {
    const root = await mkdtemp(path.join(tmpdir(), "intelligit-spike-repo-"));
    directoriesToClean.push(root);
    await execFileAsync("git", ["init", "--quiet", "-b", "main"], { cwd: root, env });
    await writeFile(path.join(root, "README.md"), "IntelliGit Phase 0 spike fixture.\n");
    await execFileAsync("git", ["add", "README.md"], { cwd: root, env });
    await execFileAsync("git", ["commit", "--quiet", "-m", "Initial commit"], { cwd: root, env });
    return root;
}

/**
 * Resolves the nested webview frame chain and returns `#root`'s child count,
 * polling the whole chain fresh until it succeeds or `timeoutMs` elapses.
 *
 * A single `toBeVisible` + `evaluate` pair is not enough against this real
 * webview host, for two independently observed reasons:
 *   1. `iframe.webview.ready` genuinely is not there yet on some runs --
 *      extension activation and the webview's own provisioning take a
 *      variable amount of time under load, and a fixed 5s wait was measured
 *      to be too short on one otherwise-successful run (the accessibility
 *      snapshot at that failure showed two generic, still-unclassed
 *      `iframe` elements present -- so the webview host existed, it just
 *      had not reached "ready" yet).
 *   2. Even once `#root` reports visible, VS Code was observed (three
 *      consecutive runs, same ~330ms-then-detach timing every time) to tear
 *      down and rebuild the outer/inner iframe pair once, shortly after
 *      first reveal, which throws `Frame was detached` on the very next
 *      call against the now-stale handle.
 * Retrying the *whole* re-resolution (not reusing any handle across
 * attempts) survives both. This does not soften the oracle: a genuinely
 * broken webview (wrong frame, failed build, `#root` that never gets
 * children) still exhausts `timeoutMs` and throws, or resolves to `0` and
 * fails the caller's `expect(childCount).toBeGreaterThan(0)` -- nothing here
 * catches or reinterprets that outcome.
 */
async function resolveMountedRootChildCount(
    window: import("@playwright/test").Page,
    { timeoutMs = 45_000 }: { timeoutMs?: number } = {},
): Promise<number> {
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown;
    while (Date.now() < deadline) {
        try {
            const outerFrame = window.frameLocator("iframe.webview.ready").first();
            const innerFrame = outerFrame.frameLocator("iframe#active-frame");
            const root = innerFrame.locator("#root");
            await expect(root).toBeVisible({ timeout: 3_000 });
            return await root.evaluate((el) => el.children.length);
        } catch (error) {
            lastError = error;
            await window.waitForTimeout(200);
        }
    }
    throw lastError;
}

/**
 * Dismisses the first-run onboarding dialog a fresh `--user-data-dir`
 * always triggers on a real VS Code build. It is one multi-step overlay
 * (`.onboarding-a-overlay`) -- a "Sign in to use GitHub Copilot" step
 * followed by a "Make It Yours" theme-picker step -- not two separate
 * dialogs, and it blocks pointer events on the rest of the workbench until
 * closed. Escape was tried first and observed empirically to close it only
 * intermittently (a real failure on an unmodified re-run of this exact
 * flow), so this uses the dialog's own `Close` button instead, which closes
 * it deterministically regardless of which step it is currently showing.
 */
async function dismissFirstRunDialogs(
    window: import("@playwright/test").Page,
): Promise<{ fired: boolean }> {
    let fired = false;

    const continueWithoutSigningIn = window.getByRole("button", {
        name: "Continue without Signing In",
    });
    if (await continueWithoutSigningIn.isVisible().catch(() => false)) {
        await continueWithoutSigningIn.click();
        fired = true;
    }

    // Short timeout on purpose: prevention is expected to have worked, so this
    // is a cheap confirmation rather than a wait. A long timeout here would add
    // dead seconds to every launch in the tiered PR suite.
    const closeOnboarding = window.locator("button.onboarding-a-close-btn");
    await closeOnboarding.waitFor({ state: "visible", timeout: 1_000 }).catch(() => undefined);
    if (await closeOnboarding.isVisible().catch(() => false)) {
        await closeOnboarding.click();
        fired = true;
    }

    return { fired };
}

/**
 * Seeds a fresh profile so first-run UI never renders in the first place.
 *
 * Dismissing the onboarding overlay after the fact (see
 * `dismissFirstRunDialogs`) works, but it couples this suite to the overlay's
 * DOM -- a class name and button role that VS Code is free to change in any
 * release. Prevention is the load-bearing mechanism; the dismissal below is
 * kept only as a fallback for the case where prevention regresses, so that a
 * changed flag surfaces as a slow test rather than an unattended hang.
 *
 * `workbench.startupEditor: "none"` suppresses the welcome tab that
 * `--skip-welcome` does not always cover on a profile with no prior state.
 */
async function seedProfileSettings(userDataDir: string): Promise<void> {
    const userDir = path.join(userDataDir, "User");
    await mkdir(userDir, { recursive: true });
    await writeFile(
        path.join(userDir, "settings.json"),
        `${JSON.stringify(
            {
                "workbench.startupEditor": "none",
                "workbench.welcomePage.walkthroughs.openOnInstall": false,
                "update.showReleaseNotes": false,
                "telemetry.telemetryLevel": "off",
            },
            null,
            4,
        )}\n`,
        "utf8",
    );
}

test.describe("Phase 0 spike: _electron reaches the IntelliGit webview", () => {
    test("opens the IntelliGit view and finds a mounted #root inside the nested webview frame", async () => {
        test.setTimeout(180_000);
        const launchStartedAt = Date.now();

        const env = await createSanitizedGitEnv();
        const repoPath = await createThrowawayGitRepo(env);

        const userDataDir = await mkdtemp(path.join(tmpdir(), "intelligit-spike-userdata-"));
        directoriesToClean.push(userDataDir);
        const extensionsDir = await mkdtemp(path.join(tmpdir(), "intelligit-spike-extensions-"));
        directoriesToClean.push(extensionsDir);

        await seedProfileSettings(userDataDir);

        // Resolved through the shared helper, NOT `downloadAndUnzipVSCode`
        // directly: its default cache is `.vscode-test` inside this repo,
        // which puts every built-in theme underneath
        // `--extensionDevelopmentPath=${REPO_ROOT}` and makes VS Code apply a
        // built-in theme of its own choosing instead of the configured one.
        // See `tests/e2e/hostFixtures/resolveVSCodeExecutable.ts`.
        const executablePath = await resolveVSCodeExecutable(REPO_ROOT);

        const electronApp = await electron.launch({
            executablePath,
            args: [
                `--extensionDevelopmentPath=${REPO_ROOT}`,
                "--disable-workspace-trust",
                "--skip-release-notes",
                // Suppresses the first-run onboarding walkthrough ("Make It
                // Yours", the theme picker). Without it a fresh profile shows a
                // modal overlay that blocks every route to the IntelliGit view.
                "--skip-welcome",
                "--disable-gpu",
                // Electron backs VS Code's SecretStorage with the OS keychain,
                // and IntelliGit touches that path during activation
                // (src/activation/repositoryMode.ts:214 constructs
                // CredentialStore(context.secrets)). On macOS a fresh profile
                // therefore raises a MODAL keychain authorization dialog, and
                // on a headless Linux runner there is no keychain agent to
                // answer at all. `basic` selects a plaintext store inside the
                // disposable profile, which is correct for a throwaway profile
                // holding only test credentials. Omitting this flag does not
                // fail the run -- it HANGS it, which CI cannot distinguish from
                // a slow test until the job times out.
                "--password-store=basic",
                // `--password-store=basic` alone is NOT sufficient, contrary to
                // what the comment above originally assumed: it governs only
                // Chromium's own password store, while VS Code's SecretStorage
                // is a separate path that still reaches the OS keychain. The
                // resulting modal is owned by the Electron MAIN process, so it
                // blocks that process outright and every Playwright channel
                // hangs together -- page.evaluate, page.screenshot and
                // electronApp.evaluate alike -- while the app keeps rendering
                // normally. Ablated against VS Code 1.132.0 / Electron 42.7.1:
                // the scratch `HOME` above is the trigger, and this flag is
                // what actually clears it. See
                // `tests/e2e/hostFixtures/electronLaunchHelpers.ts` for the
                // full evidence table.
                "--use-inmemory-secretstorage",
                `--user-data-dir=${userDataDir}`,
                `--extensions-dir=${extensionsDir}`,
                repoPath,
            ],
            env,
        });

        try {
            const window = await electronApp.firstWindow();
            await window.waitForLoadState("domcontentloaded");

            // Prevention (flags + seeded settings) is the mechanism; this is
            // only a fallback. Report when it fires, because a silently-firing
            // fallback is how a broken flag stays invisible until the day the
            // dismissal selector also breaks and CI hangs instead of failing.
            const { fired } = await dismissFirstRunDialogs(window);
            console.log(
                fired
                    ? "[Phase 0 spike] WARNING: first-run dialog appeared -- prevention flags regressed"
                    : "[Phase 0 spike] first-run dialogs prevented (no dismissal needed)",
            );

            // Reveal the IntelliGit view container. The extension activates
            // on workspaceContains:.git (the throwaway repo above satisfies
            // that), so the activity-bar icon is populated by the time this
            // click lands. The aria-label lives on the inner <a>, not the
            // outer [role="tab"] <li> -- confirmed against the real DOM.
            await window.locator('a.action-label[aria-label="IntelliGit"]').click();

            // VS Code's webview host is a two-layer nested iframe: an outer
            // sandboxed `iframe.webview.ready` VS Code itself owns, wrapping
            // an inner `iframe#active-frame` that is the extension's actual
            // document -- the one containing our `<div id="root">`. Resolved
            // through resolveMountedRootChildCount, which retries across the
            // one-time iframe replacement VS Code performs shortly after
            // first reveal (see that function's doc comment for the evidence).
            const childCount = await resolveMountedRootChildCount(window);

            // The gate: #root must actually have rendered children, not just
            // exist as an empty mount point. An empty #root would mean React
            // never mounted into the frame this test resolved -- exactly the
            // silent-false-green this spike exists to rule out.
            expect(childCount).toBeGreaterThan(0);

            const launchSeconds = (Date.now() - launchStartedAt) / 1000;
            console.log(
                `[Phase 0 spike] launch-to-assertion: ${launchSeconds.toFixed(1)}s, ` +
                    `#root child count: ${childCount}`,
            );
        } finally {
            await electronApp.close();
        }
    });
});
