// Downloads the pinned VS Code build to a cache OUTSIDE the repository, and
// refuses to hand back an executable that lives inside it.
//
// This is not tidiness -- it is load-bearing, and it fixes a silent
// wrong-data bug. Every E2E launch passes
// `--extensionDevelopmentPath=<repoRoot>`, and VS Code's theme service
// treats an extension under development as authoritative for theming so a
// theme author sees their own theme immediately. From
// `workbench.desktop.main.js`'s `ColorThemeService.initialize`:
//
// ```js
// const devLocation = environmentService.extensionDevelopmentLocationURI?.[0];
// const devThemes = colorThemeRegistry.findThemeByExtensionLocation(devLocation);
// if (devThemes.length) {
//     // the dev extension's own theme WINS -- workbench.colorTheme is never consulted
//     return setColorTheme((devThemes.find(t => t.type === current.type) ?? devThemes[0]).id);
// }
// const theme = colorThemeRegistry.findThemeBySettingsId(settings.colorTheme, undefined);
// ```
//
// and `findThemeByExtensionLocation(o)` is
// `o ? getThemes().filter(t => t.location && isEqualOrParent(t.location, o)) : []`.
//
// `@vscode/test-electron` defaults its download cache to `.vscode-test` in
// the working directory -- i.e. INSIDE this repo. That put every built-in
// theme's `location` underneath `--extensionDevelopmentPath=<repoRoot>`, so
// `findThemeByExtensionLocation` matched all ~14 of them, VS Code concluded
// IntelliGit ships them, and it silently applied the first one whose type
// matched: **Abyss**. `workbench.colorTheme` was never read. Every capture
// -- "Dark Modern", "Light Modern", "Dark+", "Default High Contrast" alike
// -- produced Abyss, deterministically, on both cold and warm profiles.
// Ablation confirmed it: dropping `--extensionDevelopmentPath` (and nothing
// else) made the seeded theme apply correctly.
//
// Keeping the download outside the repo removes those themes from the
// extension-development subtree entirely, which is the whole fix.

import path from "node:path";
import os from "node:os";
import { mkdir, writeFile } from "node:fs/promises";
import { downloadAndUnzipVSCode } from "@vscode/test-electron";
import { VSCODE_VERSION } from "./vscodeVersion";

/**
 * Keeps Spotlight off the cache. The extracted build is ~930 MB across tens
 * of thousands of files, none of which anyone will ever search for: indexing
 * it is pure I/O churn against a disposable, re-downloadable artifact. A
 * `.metadata_never_index` marker in the directory root is the documented way
 * to opt a tree out, needs no privileges, and costs nothing on platforms
 * that ignore it. Best-effort: a failure here is not worth failing a test
 * run over.
 */
async function excludeFromSpotlight(cachePath: string): Promise<void> {
    if (process.platform !== "darwin") return;
    try {
        await writeFile(path.join(cachePath, ".metadata_never_index"), "", "utf8");
    } catch {
        // Indexing is a performance concern, never a correctness one.
    }
}

/**
 * Where the pinned build is cached. Deliberately outside the repository
 * (see the module comment). `INTELLIGIT_VSCODE_CACHE` overrides it so CI can
 * point at a runner-managed cache directory -- which must also be outside
 * the checkout, and `assertExecutableIsOutsideRepo` enforces that regardless
 * of what the override says.
 */
function vscodeCachePath(): string {
    return (
        process.env.INTELLIGIT_VSCODE_CACHE ??
        path.join(os.homedir(), ".cache", "intelligit-vscode-test")
    );
}

/**
 * Resolves the VS Code build requested by the caller without changing the pinned default.
 * Empty and whitespace-only overrides are treated as unset so a blank CI variable cannot select an
 * invalid build or turn a gating run into an implicit latest-version run.
 */
export function resolveVSCodeVersion(environment: NodeJS.ProcessEnv = process.env): string {
    // The TRIMMED value is what gets returned, not the raw one: a CI variable carrying a trailing
    // space would otherwise be judged non-empty here and then handed to the downloader verbatim,
    // which resolves no build at all.
    const requestedVersion = environment.INTELLIGIT_VSCODE_VERSION?.trim();
    return requestedVersion ? requestedVersion : VSCODE_VERSION;
}

/**
 * Fails loudly if `executablePath` is inside `repoRoot`. Without this the
 * only symptom of a regression is a fixture full of the wrong theme's
 * colours under the right theme's name -- which is precisely the silent
 * false-green this suite exists to make impossible. A path check is a real
 * oracle: it fails when the cache moves back inside the repo, whether that
 * happens by an env override, a changed default, or someone reinstating
 * `.vscode-test`.
 */
function assertExecutableIsOutsideRepo(executablePath: string, repoRoot: string): void {
    const relative = path.relative(repoRoot, executablePath);
    const isInside = relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
    if (isInside) {
        throw new Error(
            `VS Code was downloaded to "${executablePath}", which is inside the repository ` +
                `("${repoRoot}"). Every E2E launch passes --extensionDevelopmentPath=<repoRoot>, and ` +
                "VS Code gives themes contributed by the extension under development priority over " +
                "`workbench.colorTheme` -- so a build cached inside the repo makes VS Code treat all " +
                "of its built-in themes as IntelliGit's own and silently ignore the requested theme " +
                "(it applies Abyss instead). Point INTELLIGIT_VSCODE_CACHE at a directory outside the " +
                "checkout.",
        );
    }
}

/**
 * Resolves the requested VS Code executable, downloading it on first use, and verifies it is
 * outside `repoRoot` before returning it. Omitting `version` preserves the pinned-build default
 * used by existing callers; comparison checks pass an explicit version for each side.
 */
export async function resolveVSCodeExecutable(
    repoRoot: string,
    version = resolveVSCodeVersion(),
): Promise<string> {
    const cachePath = vscodeCachePath();
    // `downloadAndUnzipVSCode` creates the cache directory with a NON-recursive `mkdirSync`, so it
    // works only where the parent already exists. Nothing guaranteed that. On macOS the parent got
    // created as a side effect of the Spotlight opt-out below, and on Linux `~/.cache` exists by XDG
    // convention -- on Windows neither holds, `%USERPROFILE%\.cache` is simply absent, and the whole
    // job died in `globalSetup` with `ENOENT: no such file or directory, mkdir
    // 'C:\Users\runneradmin\.cache\intelligit-vscode-test'` before one smoke test ran (#223).
    // Created here rather than inside `excludeFromSpotlight`, which is darwin-only, best-effort, and
    // swallows its own failures by design: a correctness step must not live where failures are
    // discarded, and the helper depended on this directory rather than owning it.
    await mkdir(cachePath, { recursive: true });
    await excludeFromSpotlight(cachePath);
    const executablePath = await downloadAndUnzipVSCode({
        version,
        cachePath,
    });
    assertExecutableIsOutsideRepo(executablePath, repoRoot);
    return executablePath;
}
