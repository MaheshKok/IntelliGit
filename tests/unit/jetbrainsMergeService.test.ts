import * as os from "os";
import * as path from "path";
import { promises as fsp } from "fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { interpolateL10n } from "./utils/l10nTestHelper";

const mocks = vi.hoisted(() => ({
    configValues: new Map<string, unknown>(),
    workspaceConfigValues: new Map<string, unknown>(),
    configUpdate: vi.fn(),
    showInformationMessage: vi.fn(),
    showWarningMessage: vi.fn(),
    showErrorMessage: vi.fn(),
    showInputBox: vi.fn(),
    showQuickPick: vi.fn(),
    launchJetBrainsMergeTool: vi.fn(),
    resolveJetBrainsMergeBinaryPath: vi.fn(),
    detectInstalledJetBrainsMergeToolCandidates: vi.fn(),
    detectInstalledJetBrainsMergeToolPath: vi.fn(),
    runWithNotificationProgress: vi.fn(),
}));

vi.mock("vscode", () => ({
    ConfigurationTarget: { Global: 1 },
    env: { language: "en" },
    l10n: { t: interpolateL10n },
    workspace: {
        getConfiguration: () => ({
            get: (key: string, defaultValue?: unknown) =>
                mocks.workspaceConfigValues.has(key)
                    ? mocks.workspaceConfigValues.get(key)
                    : mocks.configValues.has(key)
                      ? mocks.configValues.get(key)
                      : defaultValue,
            inspect: (key: string) => ({
                globalValue: mocks.configValues.get(key),
                workspaceValue: mocks.workspaceConfigValues.get(key),
            }),
            update: mocks.configUpdate,
        }),
    },
    window: {
        showInformationMessage: mocks.showInformationMessage,
        showWarningMessage: mocks.showWarningMessage,
        showErrorMessage: mocks.showErrorMessage,
        showInputBox: mocks.showInputBox,
        showQuickPick: mocks.showQuickPick,
    },
}));

vi.mock("../../src/utils/jetbrainsMergeTool", () => ({
    containsConflictMarkers: (text: string) =>
        text.includes("<<<<<<<") && text.includes("=======") && text.includes(">>>>>>>"),
    detectInstalledJetBrainsMergeToolCandidates: mocks.detectInstalledJetBrainsMergeToolCandidates,
    detectInstalledJetBrainsMergeToolPath: mocks.detectInstalledJetBrainsMergeToolPath,
    launchJetBrainsMergeTool: mocks.launchJetBrainsMergeTool,
    resolveJetBrainsMergeBinaryPath: mocks.resolveJetBrainsMergeBinaryPath,
}));

vi.mock("../../src/utils/notifications", () => ({
    runWithNotificationProgress: mocks.runWithNotificationProgress,
}));

import {
    detectAndPickJetBrainsMergeToolPath,
    getJetBrainsMergeToolPath,
    openJetBrainsMergeToolForFile,
} from "../../src/services/jetbrainsMergeService";
import type { GitOps } from "../../src/git/operations";

function makeGitOps(): GitOps {
    return {
        getConflictFileVersions: vi.fn(async () => ({
            base: "base",
            ours: "ours",
            theirs: "theirs",
        })),
        stageFile: vi.fn(async () => undefined),
    } as unknown as GitOps;
}

describe("jetbrainsMergeService", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.configValues.clear();
        mocks.workspaceConfigValues.clear();
        mocks.configUpdate.mockImplementation(async (key: string, value: unknown) => {
            mocks.configValues.set(key, value);
        });
        mocks.showInformationMessage.mockResolvedValue(undefined);
        mocks.showWarningMessage.mockResolvedValue(undefined);
        mocks.showErrorMessage.mockResolvedValue(undefined);
        mocks.showInputBox.mockResolvedValue(undefined);
        mocks.showQuickPick.mockResolvedValue(undefined);
        mocks.resolveJetBrainsMergeBinaryPath.mockImplementation(async (input: string) => input);
        mocks.detectInstalledJetBrainsMergeToolCandidates.mockResolvedValue([]);
        mocks.detectInstalledJetBrainsMergeToolPath.mockResolvedValue(null);
        mocks.runWithNotificationProgress.mockImplementation(
            async (_title: string, task: () => Promise<void>) => task(),
        );
    });

    it("opens the built-in merge editor when no JetBrains path is configured and the user chooses fallback", async () => {
        const gitOps = makeGitOps();
        const refreshConflictUi = vi.fn(async () => undefined);
        const openBuiltInMergeEditorForFile = vi.fn(async () => undefined);
        mocks.configValues.set("jetbrainsMergeTool.path", "");
        mocks.showInformationMessage.mockResolvedValueOnce("Open VS Code Merge Editor");

        const result = await openJetBrainsMergeToolForFile(
            "src/conflicted.ts",
            "/repo",
            gitOps,
            refreshConflictUi,
            openBuiltInMergeEditorForFile,
        );

        expect(result).toBe(true);
        expect(openBuiltInMergeEditorForFile).toHaveBeenCalledWith("src/conflicted.ts");
        expect(gitOps.getConflictFileVersions).not.toHaveBeenCalled();
        expect(mocks.launchJetBrainsMergeTool).not.toHaveBeenCalled();
    });

    it("launches the configured merge tool, stages resolved files, and refreshes conflict UI", async () => {
        const repoRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "intelligit-merge-service-"));
        const safePath = "src/conflicted.ts";
        const outputPath = path.join(repoRoot, safePath);
        const gitOps = makeGitOps();
        const refreshConflictUi = vi.fn(async () => undefined);
        try {
            await fsp.mkdir(path.dirname(outputPath), { recursive: true });
            await fsp.writeFile(
                outputPath,
                "<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> branch\n",
                "utf8",
            );
            mocks.configValues.set("jetbrainsMergeTool.path", "/usr/local/bin/pycharm");
            mocks.launchJetBrainsMergeTool.mockImplementation(
                async (input: { outputFileFsPath: string }) => {
                    await fsp.writeFile(input.outputFileFsPath, "resolved\n", "utf8");
                    return { exitCode: 0, signal: null };
                },
            );

            const result = await openJetBrainsMergeToolForFile(
                safePath,
                repoRoot,
                gitOps,
                refreshConflictUi,
                vi.fn(),
            );

            expect(result).toBe(true);
            expect(mocks.launchJetBrainsMergeTool).toHaveBeenCalledWith(
                expect.objectContaining({
                    binaryPath: "/usr/local/bin/pycharm",
                    repoRootFsPath: repoRoot,
                    relativeFilePath: safePath,
                    outputFileFsPath: outputPath,
                    baseContent: "base",
                    oursContent: "ours",
                    theirsContent: "theirs",
                }),
            );
            expect(gitOps.stageFile).toHaveBeenCalledWith(safePath);
            expect(refreshConflictUi).toHaveBeenCalled();
            expect(mocks.showInformationMessage).toHaveBeenCalledWith(
                `Merged and staged: ${safePath}`,
            );
        } finally {
            await fsp.rm(repoRoot, { recursive: true, force: true });
        }
    });

    it("keeps unresolved conflict files unstaged after the external merge tool closes", async () => {
        const repoRoot = await fsp.mkdtemp(
            path.join(os.tmpdir(), "intelligit-merge-service-markers-"),
        );
        const safePath = "src/conflicted.ts";
        const outputPath = path.join(repoRoot, safePath);
        const gitOps = makeGitOps();
        try {
            await fsp.mkdir(path.dirname(outputPath), { recursive: true });
            await fsp.writeFile(outputPath, "before", "utf8");
            mocks.configValues.set("jetbrainsMergeTool.path", "/usr/local/bin/pycharm");
            mocks.launchJetBrainsMergeTool.mockImplementation(
                async (input: { outputFileFsPath: string }) => {
                    await fsp.writeFile(
                        input.outputFileFsPath,
                        "<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> branch\n",
                        "utf8",
                    );
                    return { exitCode: 0, signal: null };
                },
            );

            const result = await openJetBrainsMergeToolForFile(
                safePath,
                repoRoot,
                gitOps,
                vi.fn(async () => undefined),
                vi.fn(),
            );

            expect(result).toBe(true);
            expect(gitOps.stageFile).not.toHaveBeenCalled();
            expect(mocks.showInformationMessage).toHaveBeenCalledWith(
                `Merge tool closed, but conflict markers remain in ${safePath}`,
            );
        } finally {
            await fsp.rm(repoRoot, { recursive: true, force: true });
        }
    });

    it("surfaces invalid paths and launch failures without refreshing conflict UI", async () => {
        const gitOps = makeGitOps();
        const refreshConflictUi = vi.fn(async () => undefined);
        mocks.configValues.set("jetbrainsMergeTool.path", "/usr/local/bin/pycharm");

        await expect(
            openJetBrainsMergeToolForFile(
                "../secret.txt",
                "/repo",
                gitOps,
                refreshConflictUi,
                vi.fn(),
            ),
        ).resolves.toBe(false);
        expect(mocks.showErrorMessage).toHaveBeenCalledWith(
            expect.stringContaining("Invalid merge file path"),
        );
        expect(gitOps.getConflictFileVersions).not.toHaveBeenCalled();

        mocks.showErrorMessage.mockClear();
        mocks.launchJetBrainsMergeTool.mockRejectedValueOnce(new Error("tool crashed"));
        await expect(
            openJetBrainsMergeToolForFile(
                "src/conflicted.ts",
                "/repo",
                gitOps,
                refreshConflictUi,
                vi.fn(),
            ),
        ).resolves.toBe(false);
        expect(mocks.showErrorMessage).toHaveBeenCalledWith(
            "JetBrains merge tool failed: tool crashed",
        );
        expect(refreshConflictUi).not.toHaveBeenCalled();
    });

    it("lets the user pick a detected JetBrains tool and saves the selected path", async () => {
        const testRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "intelligit-detected-tool-"));
        const detectedPath = path.join(testRoot, "PyCharm.app");
        try {
            await fsp.mkdir(detectedPath);
            mocks.detectInstalledJetBrainsMergeToolCandidates.mockResolvedValue([detectedPath]);
            mocks.resolveJetBrainsMergeBinaryPath.mockResolvedValue(
                path.join(detectedPath, "Contents/MacOS/pycharm"),
            );
            mocks.showQuickPick.mockImplementation(
                async (items: Array<{ candidatePath: string }>) => items[0],
            );

            const result = await detectAndPickJetBrainsMergeToolPath();

            expect(result).toBe(detectedPath);
            expect(mocks.configUpdate).toHaveBeenCalledWith(
                "jetbrainsMergeTool.path",
                detectedPath,
                1,
            );
            expect(mocks.showInformationMessage).toHaveBeenCalledWith(
                `Saved JetBrains merge tool path. Resolved executable: ${path.join(
                    detectedPath,
                    "Contents/MacOS/pycharm",
                )}`,
            );
        } finally {
            await fsp.rm(testRoot, { recursive: true, force: true });
        }
    });

    it("ignores workspace-configured merge tool paths", () => {
        mocks.workspaceConfigValues.set("jetbrainsMergeTool.path", "./workspace-tool");

        expect(getJetBrainsMergeToolPath()).toBe("");
    });

    it("contributes the merge tool path setting at machine scope", async () => {
        const manifest = JSON.parse(
            await fsp.readFile(path.join(process.cwd(), "package.json"), "utf8"),
        ) as {
            contributes?: {
                configuration?: {
                    properties?: Record<string, { scope?: string }>;
                };
            };
        };

        expect(
            manifest.contributes?.configuration?.properties?.["intelligit.jetbrainsMergeTool.path"]
                ?.scope,
        ).toBe("machine");
    });
});
