import * as vscode from "vscode";
import type { GitOps } from "../git/operations";
import type {
    StashEntry,
    ThemeFolderIconMap,
    ThemeIconFont,
    ThemeTreeIcon,
    WorkingFile,
} from "../types";
import { assertRepoRelativePath, deleteFileWithFallback } from "../utils/fileOps";
import { assertNumber, assertRepoPathArray, assertString } from "./messageValidation";
import type { IconThemeService } from "./shared";

interface PanelFileActionDeps {
    gitOps: GitOps;
    getWorkspaceRoot: () => vscode.Uri;
    refreshData: () => Promise<void>;
    fireWorkingTreeChanged: () => void;
}

interface ShelfSelectionDeps extends PanelFileActionDeps {
    iconTheme: IconThemeService;
    getFiles: () => WorkingFile[];
    getStashes: () => StashEntry[];
    currentBranchHasUpstream: () => Promise<boolean>;
    setShelfState: (state: {
        selectedShelfIndex: number;
        shelfFiles: WorkingFile[];
        folderIconsByName: ThemeFolderIconMap;
    }) => void;
    postUpdate: (message: {
        type: "update";
        files: WorkingFile[];
        stashes: StashEntry[];
        shelfFiles: WorkingFile[];
        selectedShelfIndex: number;
        folderIcon?: ThemeTreeIcon;
        folderExpandedIcon?: ThemeTreeIcon;
        folderIconsByName: ThemeFolderIconMap;
        iconFonts: ThemeIconFont[];
        currentBranchHasUpstream: boolean;
    }) => void;
}

export async function stageFilesFromPanel(
    deps: PanelFileActionDeps,
    pathsValue: unknown,
): Promise<void> {
    await deps.gitOps.stageFiles(assertRepoPathArray(pathsValue, "paths"));
    await deps.refreshData();
    deps.fireWorkingTreeChanged();
}

export async function unstageFilesFromPanel(
    deps: PanelFileActionDeps,
    pathsValue: unknown,
): Promise<void> {
    await deps.gitOps.unstageFiles(assertRepoPathArray(pathsValue, "paths"));
    await deps.refreshData();
    deps.fireWorkingTreeChanged();
}

export async function publishBranchFromPanel(deps: PanelFileActionDeps): Promise<void> {
    await vscode.commands.executeCommand("intelligit.publishBranch");
    await deps.refreshData();
    deps.fireWorkingTreeChanged();
}

export async function showDiffFromPanel(
    deps: PanelFileActionDeps,
    pathValue: unknown,
): Promise<void> {
    const filePath = assertRepoRelativePath(assertString(pathValue, "path"));
    const uri = vscode.Uri.joinPath(deps.getWorkspaceRoot(), filePath);
    await vscode.commands.executeCommand("git.openChange", uri);
}

export async function showShelfDiffFromPanel(
    deps: Pick<PanelFileActionDeps, "gitOps">,
    indexValue: unknown,
    pathValue: unknown,
): Promise<void> {
    const index = assertNumber(indexValue, "index");
    const filePath = assertRepoRelativePath(assertString(pathValue, "path"));
    const patch = await deps.gitOps.getShelvedFilePatch(index, filePath);
    const doc = await vscode.workspace.openTextDocument({
        content: patch || `No shelved diff found for ${filePath}.`,
        language: "diff",
    });
    await vscode.window.showTextDocument(doc, { preview: true });
}

export async function openFileFromPanel(
    deps: PanelFileActionDeps,
    pathValue: unknown,
): Promise<void> {
    const filePath = assertRepoRelativePath(assertString(pathValue, "path"));
    const uri = vscode.Uri.joinPath(deps.getWorkspaceRoot(), filePath);
    await vscode.window.showTextDocument(uri);
}

export async function deleteFileFromPanel(
    deps: PanelFileActionDeps,
    pathValue: unknown,
): Promise<void> {
    const filePath = assertRepoRelativePath(assertString(pathValue, "path"));
    const deleteAction = vscode.l10n.t("Delete");
    const confirm = await vscode.window.showWarningMessage(
        vscode.l10n.t("Delete {path}?", { path: filePath }),
        { modal: true },
        deleteAction,
    );
    if (confirm !== deleteAction) return;
    const deleted = await deleteFileWithFallback(deps.gitOps, deps.getWorkspaceRoot(), filePath);
    if (!deleted) return;
    vscode.window.showInformationMessage(vscode.l10n.t("Deleted {path}", { path: filePath }));
    await deps.refreshData();
    deps.fireWorkingTreeChanged();
}

export async function showHistoryFromPanel(
    deps: PanelFileActionDeps,
    pathValue: unknown,
): Promise<void> {
    const filePath = assertRepoRelativePath(assertString(pathValue, "path"));
    const history = await deps.gitOps.getFileHistory(filePath);
    const doc = await vscode.workspace.openTextDocument({
        content: history || "No history found.",
        language: "git-commit",
    });
    await vscode.window.showTextDocument(doc, { preview: true });
}

export async function selectShelfFromPanel(
    deps: ShelfSelectionDeps,
    indexValue: unknown,
): Promise<void> {
    const selectedShelfIndex = assertNumber(indexValue, "index");
    const files = deps.getFiles();
    const shelfFiles = await deps.iconTheme.decorateWorkingFiles(
        await deps.gitOps.getShelvedFiles(selectedShelfIndex),
    );
    const folderIconsByName = await deps.iconTheme.getFolderIconsByWorkingFiles([
        ...files,
        ...shelfFiles,
    ]);
    deps.setShelfState({ selectedShelfIndex, shelfFiles, folderIconsByName });
    const { folderIcons, iconFonts } = deps.iconTheme.getThemeData();
    deps.postUpdate({
        type: "update",
        files,
        stashes: deps.getStashes(),
        shelfFiles,
        selectedShelfIndex,
        folderIcon: folderIcons.folderIcon,
        folderExpandedIcon: folderIcons.folderExpandedIcon,
        folderIconsByName,
        iconFonts,
        currentBranchHasUpstream: await deps.currentBranchHasUpstream(),
    });
}
