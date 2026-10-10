import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
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
import { Workbench } from "./pageObjects/workbench";
import { runGitRaw } from "../fixtures/repo/gitRun";
import { readPackageSmokeHostLogs } from "./hostFixtures/packageSmokeLogs";
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
        { readonly kind: "install"; readonly vsixPath: string } | { readonly kind: "list" };
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
    test("installs the root VSIX and mounts IntelliGit from the installed extension", async ({}, testInfo) => {
        test.setTimeout(180_000);
        const directoriesToClean: string[] = [];
        const mergeErrors: string[] = [];
        let userDataDir: string | undefined;
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
            // A real TypeScript revision proves packaged syntax assets load, beyond mounting React.
            await writeFile(
                path.join(workspacePath, "package-smoke.ts"),
                "export const answer = 42;\n",
            );
            await execFileAsync("git", ["add", "package-smoke.ts"], {
                cwd: workspacePath,
                env: environment,
            });
            await execFileAsync("git", ["commit", "--quiet", "-m", "Add syntax fixture"], {
                cwd: workspacePath,
                env: environment,
            });
            userDataDir = await mkdtemp(path.join(tmpdir(), "intelligit-package-smoke-profile-"));
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
            window.on("console", (message) => {
                if (message.text().includes("[IntelliGit] Merge editor operation failed:")) {
                    mergeErrors.push(message.text().slice(0, 16 * 1024));
                    if (mergeErrors.length > 16) mergeErrors.shift();
                }
            });
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
            await window.keyboard.press(`${process.platform === "darwin" ? "Meta" : "Control"}+P`);
            const input = window.locator(".quick-input-widget .quick-input-box input").first();
            await expect(input).toBeVisible();
            await input.fill("package-smoke.ts");
            await window
                .getByRole("option")
                .filter({ hasText: "package-smoke.ts" })
                .first()
                .click();
            await expect(input).toBeHidden();
            const [historyWindow] = await Promise.all([
                electronApp.waitForEvent("window", { timeout: 30_000 }),
                new Workbench(window).runCommand("IntelliGit: Show File History"),
            ]);
            const history = await new IntelliGitView(historyWindow).revealFileHistory();
            await expect(history.locator(".file-history")).toBeVisible({ timeout: 30_000 });
            await expect(history.locator(".code-lines").first()).toContainText(
                "export const answer = 42;",
            );
            // Shiki initializes after the first render; use the same startup bound as the window.
            await expect(history.locator('.code-lines span[style*="color"]').first()).toBeVisible({
                timeout: 30_000,
            });
            console.log(
                "[package smoke] installed History window renders syntax-highlighted revision",
            );
            await historyWindow.close();
            await runGitRaw(workspacePath, ["checkout", "-b", "incoming"], environment);
            await writeFile(
                path.join(workspacePath, "package-smoke.ts"),
                "export const answer = 43;\n",
            );
            await runGitRaw(workspacePath, ["commit", "-am", "Incoming edit"], environment);
            await runGitRaw(workspacePath, ["checkout", "main"], environment);
            await writeFile(
                path.join(workspacePath, "package-smoke.ts"),
                "export const answer = 44;\n",
            );
            await runGitRaw(workspacePath, ["commit", "-am", "Local edit"], environment);
            await runGitRaw(workspacePath, ["merge", "incoming"], environment).catch(
                () => undefined,
            );
            expect(await runGitRaw(workspacePath, ["ls-files", "-u"], environment)).not.toBe("");
            await new Workbench(window).runCommand("Open Conflict Session");
            const conflicts = await intelliGitView.revealConflictSession();
            await expect(conflicts.locator("tbody tr.row")).toHaveCount(1);
            await conflicts.locator("tbody tr.row").click();
            const merge = await intelliGitView.revealMergeWorkbench();
            await expect(
                merge.locator('[data-testid="merge-editor-1"] .cm-content'),
            ).toHaveAttribute("contenteditable", "true");
            await expect(merge.locator('.cm-content span[style*="color"]').first()).toBeVisible();
            // A lingering workbench tab tooltip can cover this webview toolbar on Linux.
            await window.mouse.move(0, 0);
            await window.keyboard.press("Escape");
            await expect(window.locator(".context-view .monaco-hover:visible")).toHaveCount(0);
            await merge
                .locator(".mw-toolbar")
                .getByRole("button", { name: "Accept left change", exact: true })
                .click();
            await merge.getByRole("button", { name: "Apply", exact: true }).click();
            await expect
                .poll(() => runGitRaw(workspacePath, ["ls-files", "-u"], environment))
                .toBe("");
            expect(await runGitRaw(workspacePath, ["show", ":package-smoke.ts"], environment)).toBe(
                "export const answer = 44;\n",
            );
            console.log(
                "[package smoke] installed merge workbench resolves and stages a real conflict",
            );
        } catch (error) {
            if (mergeErrors.length) {
                await testInfo.attach("merge-operation-errors.log", {
                    body: mergeErrors.join("\n"),
                    contentType: "text/plain",
                });
            }
            if (userDataDir) {
                try {
                    for (const log of await readPackageSmokeHostLogs(userDataDir)) {
                        await testInfo.attach(log.name, {
                            body: log.body,
                            contentType: "text/plain",
                        });
                    }
                } catch (diagnosticError) {
                    console.warn("Package smoke host logs unavailable:", diagnosticError);
                }
            }
            console.log(
                "Package smoke windows:",
                await electronApp
                    ?.evaluate(({ BrowserWindow }) =>
                        BrowserWindow.getAllWindows().map(
                            (window: {
                                getTitle(): string;
                                webContents: { getURL(): string };
                            }) => ({
                                title: window.getTitle(),
                                url: window.webContents.getURL(),
                            }),
                        ),
                    )
                    .catch(() => "unavailable"),
            );
            console.log(
                "Package smoke pages:",
                electronApp?.windows().map((page) => page.url()),
            );
            throw error;
        } finally {
            await electronApp?.close().catch(() => undefined);
            await cleanupDirectories(directoriesToClean);
        }
    });
});
