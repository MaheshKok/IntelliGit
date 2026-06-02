// JetBrains merge tool orchestration extracted from extension.ts.
// Handles configuration prompts, detection, launch, and post-merge
// file inspection for JetBrains IDE merge tools.

import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { GitOps } from "../git/operations";
import { getErrorMessage } from "../utils/errors";
import { assertRepoRelativePath } from "../utils/fileOps";
import {
    containsConflictMarkers,
    detectInstalledJetBrainsMergeToolCandidates,
    detectInstalledJetBrainsMergeToolPath,
    launchJetBrainsMergeTool,
    resolveJetBrainsMergeBinaryPath,
} from "../utils/jetbrainsMergeTool";
import { runWithNotificationProgress } from "../utils/notifications";

function getIntelliGitConfig(): vscode.WorkspaceConfiguration | null {
    const getConfiguration = vscode.workspace.getConfiguration;
    if (typeof getConfiguration !== "function") return null;
    return getConfiguration.call(vscode.workspace, "intelligit");
}

export function getJetBrainsMergeToolPath(): string {
    return getIntelliGitConfig()?.get<string>("jetbrainsMergeTool.path", "").trim() ?? "";
}

export function getPreferExternalMergeTool(): boolean {
    return getIntelliGitConfig()?.get<boolean>("jetbrainsMergeTool.preferExternal", true) ?? true;
}

function getDefaultJetBrainsMergeToolPath(): string {
    switch (process.platform) {
        case "darwin":
            return "/Applications/PyCharm.app";
        case "win32":
            return "C:\\Program Files\\JetBrains\\PyCharm\\bin\\pycharm64.exe";
        default:
            return "pycharm";
    }
}

async function saveJetBrainsMergeToolPath(rawPath: string): Promise<string | null> {
    const trimmed = rawPath.trim();
    if (!trimmed) return null;

    if (path.isAbsolute(trimmed) && !fs.existsSync(trimmed)) {
        vscode.window.showErrorMessage(
            vscode.l10n.t("JetBrains path not found: {path}", { path: trimmed }),
        );
        return null;
    }

    let resolvedBinaryPath: string;
    try {
        resolvedBinaryPath = await resolveJetBrainsMergeBinaryPath(trimmed);
    } catch (err) {
        const msg = getErrorMessage(err);
        vscode.window.showErrorMessage(
            vscode.l10n.t("Invalid JetBrains merge tool path: {message}", { message: msg }),
        );
        return null;
    }

    const config = getIntelliGitConfig();
    if (config && typeof config.update === "function") {
        await config.update("jetbrainsMergeTool.path", trimmed, vscode.ConfigurationTarget.Global);
    }

    vscode.window.showInformationMessage(
        resolvedBinaryPath === trimmed
            ? vscode.l10n.t("Saved JetBrains merge tool path. Executable: {path}", {
                  path: resolvedBinaryPath,
              })
            : vscode.l10n.t("Saved JetBrains merge tool path. Resolved executable: {path}", {
                  path: resolvedBinaryPath,
              }),
    );
    return trimmed;
}

export async function promptForJetBrainsMergeToolPath(): Promise<string | null> {
    const existing = getJetBrainsMergeToolPath();
    const detected = existing ? null : await detectInstalledJetBrainsMergeToolPath();
    const suggested = existing || detected || getDefaultJetBrainsMergeToolPath();
    const input = await vscode.window.showInputBox({
        title: vscode.l10n.t("JetBrains Merge Tool Path"),
        prompt: vscode.l10n.t("Enter a JetBrains IDE binary path/command (pycharm, idea, webstorm) or a macOS .app bundle path."),
        placeHolder: suggested,
        value: suggested,
        ignoreFocusOut: true,
    });
    if (!input) return null;

    return saveJetBrainsMergeToolPath(input);
}

export async function detectAndPickJetBrainsMergeToolPath(): Promise<string | null> {
    const candidates = await detectInstalledJetBrainsMergeToolCandidates();
    if (candidates.length === 0) {
        vscode.window.showWarningMessage(
            vscode.l10n.t("No JetBrains IDE installations were auto-detected. Enter the path manually instead."),
        );
        return promptForJetBrainsMergeToolPath();
    }

    const quickPickItems = await Promise.all(
        candidates.slice(0, 50).map(async (candidatePath) => {
            let detail: string | undefined;
            try {
                const resolved = await resolveJetBrainsMergeBinaryPath(candidatePath);
                detail =
                    resolved === candidatePath
                        ? undefined
                        : vscode.l10n.t("Resolved: {path}", { path: resolved });
            } catch {
                detail = undefined;
            }
            return {
                label: path.basename(candidatePath),
                description: candidatePath,
                detail,
                candidatePath,
            };
        }),
    );

    const MANUAL_SENTINEL = "__manual__";
    quickPickItems.push({
        label: vscode.l10n.t("$(edit) Enter path manually"),
        description: vscode.l10n.t("Open the path prompt"),
        detail: undefined,
        candidatePath: MANUAL_SENTINEL,
    });

    const picked = await vscode.window.showQuickPick(quickPickItems, {
        title: vscode.l10n.t("Detect JetBrains Merge Tool"),
        placeHolder: vscode.l10n.t("Select a detected JetBrains IDE to use as the merge tool"),
        ignoreFocusOut: true,
        matchOnDescription: true,
        matchOnDetail: true,
    });
    if (!picked) return null;
    if (picked.candidatePath === MANUAL_SENTINEL) {
        return promptForJetBrainsMergeToolPath();
    }
    return saveJetBrainsMergeToolPath(picked.candidatePath);
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

async function readMergedFileWithRetry(
    outputFileFsPath: string,
    beforeMergeText: string | null,
): Promise<string> {
    let lastReadError: unknown;
    const delaysMs = [0, 80, 160, 320, 500];

    for (let attempt = 0; attempt < delaysMs.length; attempt++) {
        if (delaysMs[attempt] > 0) {
            await sleep(delaysMs[attempt]);
        }

        try {
            const text = await fs.promises.readFile(outputFileFsPath, "utf8");
            const unchanged = beforeMergeText !== null && text === beforeMergeText;
            const hasConflictBlock = containsConflictMarkers(text);
            if ((unchanged || hasConflictBlock) && attempt < delaysMs.length - 1) {
                continue;
            }
            return text;
        } catch (readErr) {
            lastReadError = readErr;
        }
    }

    throw lastReadError instanceof Error
        ? lastReadError
        : new Error("Failed to read merged file after external merge tool closed.");
}

export async function openJetBrainsMergeToolForFile(
    filePath: string,
    repoRoot: string,
    gitOps: GitOps,
    refreshConflictUi: () => Promise<void>,
    openBuiltInMergeEditorForFile: (filePath: string) => Promise<void>,
): Promise<boolean> {
    let safePath: string;
    try {
        safePath = assertRepoRelativePath(filePath);
    } catch (error) {
        const msg = getErrorMessage(error);
        vscode.window.showErrorMessage(
            vscode.l10n.t("Invalid merge file path: {message}", { message: msg }),
        );
        return false;
    }

    let jetBrainsPath = getJetBrainsMergeToolPath();
    if (!jetBrainsPath) {
        const configureAction = vscode.l10n.t("Configure");
        const openVsCodeMergeEditorAction = vscode.l10n.t("Open VS Code Merge Editor");
        const action = await vscode.window.showInformationMessage(
            vscode.l10n.t("JetBrains merge tool path is not configured."),
            configureAction,
            openVsCodeMergeEditorAction,
        );
        if (action === openVsCodeMergeEditorAction) {
            try {
                await openBuiltInMergeEditorForFile(safePath);
                return true;
            } catch (error) {
                const msg = getErrorMessage(error);
                vscode.window.showErrorMessage(
                    vscode.l10n.t("Failed to open VS Code merge editor: {message}", {
                        message: msg,
                    }),
                );
                return false;
            }
        }
        if (action !== configureAction) return false;
        let configured: string | null;
        try {
            configured = await promptForJetBrainsMergeToolPath();
        } catch (error) {
            const msg = getErrorMessage(error);
            vscode.window.showErrorMessage(
                vscode.l10n.t("Failed to configure JetBrains merge tool: {message}", {
                    message: msg,
                }),
            );
            return false;
        }
        if (!configured) return false;
        jetBrainsPath = configured;
    }

    try {
        const versions = await gitOps.getConflictFileVersions(safePath);
        const outputFileFsPath = path.join(repoRoot, safePath);
        const beforeMergeText = await fs.promises
            .readFile(outputFileFsPath, "utf8")
            .catch(() => null);

        await runWithNotificationProgress(
            vscode.l10n.t("Opening JetBrains merge tool for {path}...", { path: safePath }),
            async () => {
                await launchJetBrainsMergeTool({
                    binaryPath: jetBrainsPath,
                    repoRootFsPath: repoRoot,
                    relativeFilePath: safePath,
                    outputFileFsPath,
                    baseContent: versions.base,
                    oursContent: versions.ours,
                    theirsContent: versions.theirs,
                });
            },
        );

        try {
            const mergedText = await readMergedFileWithRetry(outputFileFsPath, beforeMergeText);
            if (!containsConflictMarkers(mergedText)) {
                await gitOps.stageFile(safePath);
                vscode.window.showInformationMessage(
                    vscode.l10n.t("Merged and staged: {path}", { path: safePath }),
                );
            } else {
                vscode.window.showInformationMessage(
                    vscode.l10n.t(
                        "Merge tool closed, but conflict markers remain in {path}",
                        { path: safePath },
                    ),
                );
            }
        } catch (readErr) {
            const msg = getErrorMessage(readErr);
            vscode.window.showWarningMessage(
                vscode.l10n.t(
                    "Could not inspect merged file '{path}' after JetBrains merge: {message}",
                    { path: safePath, message: msg },
                ),
            );
        }

        try {
            await refreshConflictUi();
        } catch (uiError) {
            const msg = getErrorMessage(uiError);
            vscode.window.showErrorMessage(
                vscode.l10n.t("Failed to refresh conflict UI: {message}", { message: msg }),
            );
        }
        return true;
    } catch (error) {
        const message = getErrorMessage(error);
        vscode.window.showErrorMessage(
            vscode.l10n.t("JetBrains merge tool failed: {message}", { message }),
        );
        return false;
    }
}
