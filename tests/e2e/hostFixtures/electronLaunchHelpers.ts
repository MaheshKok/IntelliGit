// Launch machinery for the Phase 0 host-fixture capture, deliberately
// mirroring `tests/e2e/spike/launch.spec.ts` rather than importing from it.
// That file is frozen, already-passed spike output ("do not redo it, do not
// remove the flags it found"); this module re-derives the same techniques so
// the spike file itself never has to change. Where a choice here is load-
// bearing for a non-obvious reason, the comment says so once and points back
// to the spike's own (more detailed) rationale instead of repeating it.

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { Page } from "@playwright/test";

const execFileAsync = promisify(execFile);

/** Fixed git identity and commit dates for every git process this capture spawns -- see `tests/e2e/spike/launch.spec.ts`'s `GIT_IDENTITY` for the same technique, extending `tests/integration/rebase/rebaseTestHarness.ts`. */
const GIT_IDENTITY = {
    GIT_AUTHOR_NAME: "IntelliGit Host Fixture Capture",
    GIT_AUTHOR_EMAIL: "intelligit-host-fixture@example.invalid",
    GIT_COMMITTER_NAME: "IntelliGit Host Fixture Capture",
    GIT_COMMITTER_EMAIL: "intelligit-host-fixture@example.invalid",
    GIT_AUTHOR_DATE: "2000-01-01T00:00:00 +0000",
    GIT_COMMITTER_DATE: "2000-01-01T00:00:00 +0000",
} as const;

/**
 * Builds a sanitized git environment rooted at a fresh scratch `HOME`, so a
 * developer's real `~/.gitconfig`, credential helper, or global ignore file
 * can never leak into what the extension or its git subprocesses see. Pushes
 * the scratch `HOME` onto `directoriesToClean` for the caller to dispose.
 */
export async function createSanitizedGitEnv(
    directoriesToClean: string[],
): Promise<NodeJS.ProcessEnv> {
    const home = await mkdtemp(path.join(tmpdir(), "intelligit-hostfixture-home-"));
    directoriesToClean.push(home);
    return {
        ...process.env,
        HOME: home,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
        ...GIT_IDENTITY,
    };
}

/**
 * Narrows a `NodeJS.ProcessEnv` (whose index signature is `string |
 * undefined`, since looking up an absent key yields `undefined`) down to the
 * `{ [key: string]: string }` Playwright's `electron.launch({ env })` option
 * requires. Every key actually present on a real env object always holds a
 * string -- `undefined` only shows up when indexing a key that was never
 * set -- so dropping `undefined` entries here is a type narrowing, not a
 * behavior change: it removes nothing `Object.entries` would ever have
 * produced for a real environment object.
 */
export function toElectronLaunchEnv(env: NodeJS.ProcessEnv): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) {
        if (value !== undefined) {
            result[key] = value;
        }
    }
    return result;
}

/**
 * Initializes a minimal one-commit repository -- just enough for VS Code's
 * `workspaceContains:.git` activation event to activate the extension. Host
 * theme capture does not exercise any git behaviour, so this repo's content
 * is otherwise irrelevant.
 */
export async function createThrowawayGitRepo(
    env: NodeJS.ProcessEnv,
    directoriesToClean: string[],
): Promise<string> {
    const root = await mkdtemp(path.join(tmpdir(), "intelligit-hostfixture-repo-"));
    directoriesToClean.push(root);
    await execFileAsync("git", ["init", "--quiet", "-b", "main"], { cwd: root, env });
    await writeFile(path.join(root, "README.md"), "IntelliGit host-fixture capture repo.\n");
    await execFileAsync("git", ["add", "README.md"], { cwd: root, env });
    await execFileAsync("git", ["commit", "--quiet", "-m", "Initial commit"], { cwd: root, env });
    return root;
}

/**
 * Seeds a fresh profile so first-run UI never renders, and -- the reason
 * this capture needs its own copy of the spike's `seedProfileSettings`
 * rather than reusing it verbatim -- pins `workbench.colorTheme` to the
 * exact built-in theme this capture is for. This is the "explicitly
 * selected built-in theme ID" PLAN.md step 5 requires: never "whatever theme
 * happened to be active".
 */
export async function seedProfileSettings(
    userDataDir: string,
    colorThemeSetting: string,
): Promise<void> {
    const userDir = path.join(userDataDir, "User");
    await mkdir(userDir, { recursive: true });
    await writeFile(
        path.join(userDir, "settings.json"),
        `${JSON.stringify(
            {
                "workbench.colorTheme": colorThemeSetting,
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

/**
 * Dismisses the first-run onboarding dialog a fresh `--user-data-dir` can
 * still trigger despite the prevention flags/settings above. See
 * `tests/e2e/spike/launch.spec.ts`'s `dismissFirstRunDialogs` for the full
 * rationale (Escape only closes it intermittently; the dialog's own `Close`
 * button is deterministic) -- this is the same technique, kept as a fallback
 * here for the same reason: prevention is the load-bearing mechanism.
 */
export async function dismissFirstRunDialogs(window: Page): Promise<{ readonly fired: boolean }> {
    let fired = false;

    const continueWithoutSigningIn = window.getByRole("button", {
        name: "Continue without Signing In",
    });
    if (await continueWithoutSigningIn.isVisible().catch(() => false)) {
        await continueWithoutSigningIn.click();
        fired = true;
    }

    const closeOnboarding = window.locator("button.onboarding-a-close-btn");
    await closeOnboarding.waitFor({ state: "visible", timeout: 1_000 }).catch(() => undefined);
    if (await closeOnboarding.isVisible().catch(() => false)) {
        await closeOnboarding.click();
        fired = true;
    }

    return { fired };
}

/**
 * The exact Electron launch args the spike proved necessary, parameterized
 * per invocation. `--password-store=basic` and `--skip-welcome` are
 * load-bearing, not cosmetic -- see `tests/e2e/spike/launch.spec.ts` for the
 * full evidence (a MODAL keychain dialog on macOS / no keychain agent on
 * headless Linux for the former; an unattended onboarding overlay blocking
 * every route to the IntelliGit view for the latter). Both failure modes
 * present as an unattended hang, not a failure, on a headless runner.
 *
 * `--force-disable-user-env` is included defensively, though it turned out
 * NOT to be the fix for the hang described below -- keeping the finding
 * accurate rather than convenient. VS Code 1.132.0 spawns the user's
 * interactive login shell to resolve `PATH`/env on every launch
 * (`resolveShellEnvironment` in `out/main.js`, and independently again for
 * the bundled "AgentHost" utility process); that function checks
 * `args["force-disable-user-env"]` first and returns `{}` immediately when
 * set (verified directly against `out/main.js`:
 * `e["force-disable-user-env"]?(n.trace("resolveShellEnv(): skipped
 * (--force-disable-user-env)"),{}):...`). This capture never opens an
 * integrated terminal or runs a task, so the resolved shell env has no
 * observable effect on the captured fixture, and skipping a real (if here
 * not the dominant) source of slowness is free. It is **not**, by itself,
 * what fixed the multi-minute hang observed empirically on this machine:
 * that hang reproduced identically with this flag present, every time the
 * capture was driven by a bare `bun <script>.ts` invocation, and disappeared
 * (8.2s, reliably) the moment the exact same `captureHostFixture` call was
 * driven through the Playwright test runner instead -- see
 * `tests/e2e/hostFixtures/capture.spec.ts` and its comment for the actual
 * root cause (a Bun-vs-Node incompatibility establishing the CDP WebSocket
 * connection to Electron, not anything about VS Code's shell-env resolution
 * or this file's launch args).
 */
export function buildElectronLaunchArgs(options: {
    readonly repoRoot: string;
    readonly userDataDir: string;
    readonly extensionsDir: string;
    readonly workspacePath: string;
}): readonly string[] {
    const { repoRoot, userDataDir, extensionsDir, workspacePath } = options;
    return [
        `--extensionDevelopmentPath=${repoRoot}`,
        "--disable-workspace-trust",
        "--skip-release-notes",
        "--skip-welcome",
        "--disable-gpu",
        "--password-store=basic",
        // Load-bearing, and NOT redundant with `--password-store=basic`: that
        // flag only governs Chromium's own password store, while VS Code's
        // SecretStorage API is a separate path that still reaches for the OS
        // keychain. On macOS that raises a MODAL native prompt owned by the
        // Electron MAIN process -- which blocks the main process outright, so
        // every Playwright channel dies at once (page.evaluate, page.screenshot
        // AND electronApp.evaluate all hang forever, with the app itself still
        // rendering perfectly). That signature is why this reads as an
        // unattended hang rather than a failure.
        //
        // The trigger is the scratch `HOME` from `createSanitizedGitEnv`: with
        // a real `HOME`, VS Code finds existing state and never asks. Isolated
        // by ablation against this exact build (VS Code 1.132.0 / Electron
        // 42.7.1) -- bare env renders; `GIT_CONFIG_GLOBAL` alone renders;
        // scratch `HOME` alone HANGS; scratch `HOME` + this flag renders.
        //
        // Keeping it is also the correct security posture, independent of the
        // hang: a disposable test profile must never be able to read or write
        // the developer's real secret store.
        "--use-inmemory-secretstorage",
        "--force-disable-user-env",
        `--user-data-dir=${userDataDir}`,
        `--extensions-dir=${extensionsDir}`,
        workspacePath,
    ];
}

/**
 * Removes every directory this capture allocated. Mirrors the spike's
 * `afterAll` cleanup exactly, including the retry/backoff: a bare
 * `{ recursive: true, force: true }` was observed empirically to fail with
 * `ENOTEMPTY` when a background process VS Code or git spawned into the
 * scratch `HOME` is still flushing a file in the brief window after the
 * Electron app closes -- a real race, not a hypothetical one.
 */
export async function cleanupDirectories(directories: readonly string[]): Promise<void> {
    await Promise.all(
        directories.map((directory) =>
            rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }),
        ),
    );
}
