import { execFile } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { expect, test, type ElectronApplication, _electron as electron } from "@playwright/test";
import { resolveCliArgsFromVSCodeExecutablePath } from "@vscode/test-electron";

import {
    cleanupDirectories,
    createSanitizedGitEnv,
    createThrowawayGitRepo,
    dismissFirstRunDialogs,
    seedProfileSettings,
    toElectronLaunchEnv,
} from "./hostFixtures/electronLaunchHelpers";
import {
    resolveVSCodeExecutable,
    resolveVSCodeVersion,
} from "./hostFixtures/resolveVSCodeExecutable";
import {
    assertExactInstalledExtensionVersion,
    buildInstalledExtensionLaunchArgs,
    buildPackageCliInvocation,
} from "./hostFixtures/packageSmokeHelpers";
import { IntelliGitView } from "./pageObjects/intelliGitView";
import { selectSoleVsix, verifyVsixPackage } from "../../scripts/verifyVsixPackage.js";

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(__dirname, "../..");

interface PackageManifest {
    readonly name: string;
    readonly publisher: string;
    readonly version: string;
}

/**
 * Runs one package-management command against the smoke test's fresh profile.
 *
 * @param options Resolved VS Code executable, isolated directories, and operation.
 * @returns Raw stdout and stderr from the CLI process.
 */
async function runPackageCli(options: {
    readonly executablePath: string;
    readonly directories: {
        readonly userDataDir: string;
        readonly extensionsDir: string;
    };
    readonly operation:
        | { readonly kind: "install"; readonly vsixPath: string }
        | { readonly kind: "list" };
    readonly environment: NodeJS.ProcessEnv;
}): Promise<{ readonly stdout: string; readonly stderr: string }> {
    const cliArgs = resolveCliArgsFromVSCodeExecutablePath(options.executablePath, {
        reuseMachineInstall: true,
    });
    const invocation = buildPackageCliInvocation({
        cliArgs,
        userDataDir: options.directories.userDataDir,
        extensionsDir: options.directories.extensionsDir,
        operation: options.operation,
    });
    return execFileAsync(invocation.executablePath, [...invocation.args], {
        env: toElectronLaunchEnv(options.environment),
        maxBuffer: 2 * 1024 * 1024,
        shell: invocation.useShell,
    });
}

test.describe("installed VSIX package smoke", () => {
    test("installs the root VSIX and mounts IntelliGit from the installed extension", async () => {
        test.setTimeout(180_000);
        const directoriesToClean: string[] = [];
        let electronApp: ElectronApplication | undefined;

        try {
            const packageManifest = JSON.parse(
                await readFile(path.join(REPO_ROOT, "package.json"), "utf8"),
            ) as PackageManifest;
            const expectedExtensionVersion = `${packageManifest.publisher}.${packageManifest.name}@${packageManifest.version}`;
            const vsixPath = selectSoleVsix(REPO_ROOT);
            const packageVerification = await verifyVsixPackage({
                cwd: REPO_ROOT,
                vsixPath,
                skipVsceSelection: true,
            });
            if (!packageVerification.ok) {
                throw new Error(
                    `Root VSIX failed package verification:\n${packageVerification.errors.join("\n")}`,
                );
            }

            const environment = await createSanitizedGitEnv(directoriesToClean);
            // The installed package path must not activate the development-only control channel,
            // even when a caller's ambient shell happens to carry those variables.
            delete environment.INTELLIGIT_E2E;
            delete environment.INTELLIGIT_E2E_CHANNEL_DIR;
            const workspacePath = await createThrowawayGitRepo(environment, directoriesToClean);
            const userDataDir = await mkdtemp(
                path.join(tmpdir(), "intelligit-package-smoke-profile-"),
            );
            const extensionsDir = await mkdtemp(
                path.join(tmpdir(), "intelligit-package-smoke-extensions-"),
            );
            directoriesToClean.push(userDataDir, extensionsDir);
            await seedProfileSettings(userDataDir);

            const requestedVSCodeVersion = resolveVSCodeVersion(process.env);
            const executablePath = await resolveVSCodeExecutable(REPO_ROOT, requestedVSCodeVersion);
            console.log(
                `[package smoke] resolved VS Code ${requestedVSCodeVersion}: ${executablePath}`,
            );
            console.log(`[package smoke] root VSIX: ${vsixPath}`);

            await runPackageCli({
                executablePath,
                directories: { userDataDir, extensionsDir },
                operation: { kind: "install", vsixPath },
                environment,
            });
            const listResult = await runPackageCli({
                executablePath,
                directories: { userDataDir, extensionsDir },
                operation: { kind: "list" },
                environment,
            });
            assertExactInstalledExtensionVersion(listResult.stdout, expectedExtensionVersion);
            const installedExtensionLine = listResult.stdout
                .split(/\r?\n/)
                .map((line) => line.trim())
                .find((line) =>
                    line
                        .toLowerCase()
                        .startsWith(
                            `${packageManifest.publisher}.${packageManifest.name}@`.toLowerCase(),
                        ),
                );
            console.log(
                `[package smoke] exact installed extension: ${installedExtensionLine} ` +
                    `(manifest: ${expectedExtensionVersion})`,
            );

            const launchArgs = buildInstalledExtensionLaunchArgs({
                userDataDir,
                extensionsDir,
                workspacePath,
            });
            expect(launchArgs).not.toContainEqual(
                expect.stringMatching(/^--extensionDevelopmentPath=/),
            );
            console.log("[package smoke] installed launch has no --extensionDevelopmentPath");

            electronApp = await electron.launch({
                executablePath,
                args: [...launchArgs],
                env: toElectronLaunchEnv(environment),
                timeout: 60_000,
            });
            const window = await electronApp.firstWindow();
            await window.waitForLoadState("domcontentloaded");
            await dismissFirstRunDialogs(window);

            const intelliGitView = new IntelliGitView(window);
            const frame = await intelliGitView.reveal();
            const root = frame.locator("#root");
            await expect(root).toBeVisible();
            // The workbench may replace a webview's `#active-frame` after its document has already
            // rendered, and `locator.evaluate` does not retry across that swap -- it fails outright
            // with "Frame was detached". `toBeVisible` above survives it because web-first
            // assertions re-resolve; a bare `evaluate` between two of them does not, so the read
            // repeats under `toPass` and a swap becomes a retry rather than a red pipeline.
            // Observed on VS Code 1.96.0 in CI run 32411770447, green on an unmodified re-run.
            let childCount = 0;
            await expect(async () => {
                childCount = await root.evaluate((element) => element.children.length);
                expect(childCount).toBeGreaterThan(0);
            }).toPass({ timeout: 30_000, intervals: [250] });
            console.log(
                `[package smoke] IntelliGit activity-bar webview mounted (#root children: ${childCount})`,
            );
        } finally {
            await electronApp?.close().catch(() => undefined);
            await cleanupDirectories(directoriesToClean);
        }
    });
});
