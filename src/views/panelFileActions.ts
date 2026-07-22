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
import type { IconThemeService } from "./shared/IconThemeService";
import { showTimedInformationMessage } from "../utils/notifications";
import { createReadonlyDiffUri } from "../services/diffService";
import { mapWithConcurrency } from "../utils/concurrency";

type StashChange = [vscode.Uri, vscode.Uri, vscode.Uri];

type StashDiffUris = { stashed: vscode.Uri; local: vscode.Uri };
type StashFileContents = Awaited<ReturnType<GitOps["getStashFileContents"]>>;
type StashDiffSnapshot = {
    filePath: string;
    stashedContent: string;
    stashedRef: string;
    localContent: string;
    localRef: string;
    isLocalMissing: boolean;
};

interface PanelFileActionDeps {
    gitOps: GitOps;
    getWorkspaceRoot: () => vscode.Uri;
    refreshData: (silent?: boolean) => Promise<void>;
    fireWorkingTreeChanged: () => void;
}

interface StashSelectionDeps extends PanelFileActionDeps {
    iconTheme: IconThemeService;
    getFiles: () => WorkingFile[];
    getStashes: () => StashEntry[];
    currentBranchHasUpstream: () => Promise<boolean>;
    setStashState: (state: {
        selectedStashIndex: number;
        stashFiles: WorkingFile[];
        folderIconsByName: ThemeFolderIconMap;
    }) => void;
    postUpdate: (message: {
        type: "update";
        files: WorkingFile[];
        stashes: StashEntry[];
        stashFiles: WorkingFile[];
        selectedStashIndex: number;
        folderIcon?: ThemeTreeIcon;
        folderExpandedIcon?: ThemeTreeIcon;
        folderIconsByName: ThemeFolderIconMap;
        iconFonts: ThemeIconFont[];
        currentBranchHasUpstream: boolean;
    }) => void;
}

/**
 * Stages repository-relative paths requested by a commit-panel webview.
 *
 * Path validation happens inside this boundary before Git sees the list; a successful stage refreshes
 * panel state and notifies listeners that the working tree changed.
 */
export async function stageFilesFromPanel(
    deps: PanelFileActionDeps,
    pathsValue: unknown,
): Promise<void> {
    await deps.gitOps.stageFiles(assertRepoPathArray(pathsValue, "paths"));
    await deps.refreshData();
    deps.fireWorkingTreeChanged();
}

/**
 * Unstages repository-relative paths requested by a commit-panel webview.
 *
 * The same validation path as staging is used so untrusted webview arrays cannot address paths
 * outside the active repository before Git index state is refreshed.
 */
export async function unstageFilesFromPanel(
    deps: PanelFileActionDeps,
    pathsValue: unknown,
): Promise<void> {
    await deps.gitOps.unstageFiles(assertRepoPathArray(pathsValue, "paths"));
    await deps.refreshData();
    deps.fireWorkingTreeChanged();
}

/**
 * Delegates branch publishing to the extension command and refreshes panel state afterward.
 *
 * Remote selection, credential prompts, and upstream naming remain owned by the publish command;
 * this helper only bridges panel UI state back to the active repository view.
 */
/**
 * Marks currently unversioned files as intent-to-add from a webview drop action.
 *
 * The current Git status is re-read after the drag payload arrives so stale webview state cannot
 * move a file that has already become tracked, staged, deleted, or otherwise non-unversioned. The
 * refresh is silent because the row transition is a direct result of the user's drop gesture and
 * should not flash the global commit-panel refresh indicator.
 */
export async function trackUnversionedFilesFromPanel(
    deps: PanelFileActionDeps,
    pathsValue: unknown,
): Promise<void> {
    const paths = assertRepoPathArray(pathsValue, "paths");
    if (paths.length === 0) return;

    const currentFiles = await deps.gitOps.getStatus();
    const currentByPath = new Map(currentFiles.map((file) => [file.path, file]));
    const stalePaths = paths.filter((path) => {
        const status = currentByPath.get(path)?.status;
        return status !== "?" && status !== "A";
    });
    if (stalePaths.length > 0) {
        throw new Error(
            `Only unversioned files can be moved into Changes: ${stalePaths.join(", ")}`,
        );
    }

    await deps.gitOps.intentToAddFiles(paths);
    await deps.refreshData(true);
    deps.fireWorkingTreeChanged();
}

/**
 * Publishes the current branch from the commit panel and refreshes local working-tree state.
 *
 * The helper delegates the publish flow to the extension command so credential prompts and remote
 * validation stay centralized, then performs a visible refresh because the branch/upstream state may
 * have changed and notifies listeners that working-tree metadata should be re-read.
 */
export async function publishBranchFromPanel(deps: PanelFileActionDeps): Promise<void> {
    await vscode.commands.executeCommand("intelligit.publishBranch");
    await deps.refreshData();
    deps.fireWorkingTreeChanged();
}

/**
 * Opens VS Code's Git change view for a validated repository-relative file path.
 *
 * The active repository root is supplied by the owning provider; path validation prevents a webview
 * payload from constructing editor URIs outside that root.
 */
export async function showDiffFromPanel(
    deps: PanelFileActionDeps,
    pathValue: unknown,
): Promise<void> {
    const filePath = assertRepoRelativePath(assertString(pathValue, "path"));
    const uri = vscode.Uri.joinPath(deps.getWorkspaceRoot(), filePath);
    await vscode.commands.executeCommand("git.openChange", uri);
}

/**
 * Identifies only VS Code's known missing-file conditions without depending on a particular
 * extension-host error class instance, which may differ across test and runtime boundaries.
 *
 * The generic message check covers the observed resolver error; all other filesystem errors must
 * propagate so permission and workspace failures do not become empty-file diffs.
 */
function isFileNotFoundError(error: unknown): boolean {
    return (
        typeof error === "object" &&
        error !== null &&
        (("code" in error && error.code === "FileNotFound") ||
            ("message" in error &&
                typeof error.message === "string" &&
                error.message.includes("Unable to resolve nonexistent file")))
    );
}

/**
 * Reads and labels a stashed snapshot and current local document without registering virtual URIs.
 *
 * The stash side always uses `after`; the base revision is never exposed. A matching open document
 * takes precedence to preserve dirty-buffer text. Otherwise the filesystem is checked before the
 * document opens. Only known missing-file errors become an empty snapshot so other workspace
 * failures can abort the whole batch cleanly.
 */
async function prepareStashLocalDiffSnapshot(
    workspaceRoot: vscode.Uri,
    filePath: string,
    ref: string,
    contents: StashFileContents,
): Promise<StashDiffSnapshot> {
    const localFile = vscode.Uri.joinPath(workspaceRoot, filePath);
    const openDocument = vscode.workspace.textDocuments.find(
        (document) => document.uri.toString() === localFile.toString(),
    );
    let localContent: string;
    let localRef: string;
    let isLocalMissing = false;
    if (openDocument !== undefined) {
        localContent = openDocument.getText();
        localRef = vscode.l10n.t("Local File");
    } else {
        try {
            await vscode.workspace.fs.stat(localFile);
            localContent = (await vscode.workspace.openTextDocument(localFile)).getText();
            localRef = vscode.l10n.t("Local File");
        } catch (error) {
            if (!isFileNotFoundError(error)) throw error;
            localContent = "";
            localRef = vscode.l10n.t("Empty local file (missing)");
            isLocalMissing = true;
        }
    }
    return {
        filePath,
        stashedContent: contents.after ?? "",
        stashedRef:
            contents.after === undefined
                ? vscode.l10n.t("Empty stashed file (missing: {ref})", { ref })
                : vscode.l10n.t("Stashed: {ref}", { ref }),
        localContent,
        localRef,
        isLocalMissing,
    };
}

/** Registers concrete virtual documents only after all fallible snapshot reads have completed. */
function createStashLocalDiffUris(snapshot: StashDiffSnapshot): StashDiffUris {
    const stashed = createReadonlyDiffUri(
        snapshot.filePath,
        snapshot.stashedContent,
        snapshot.stashedRef,
    );
    const local = createReadonlyDiffUri(
        snapshot.filePath,
        snapshot.localContent,
        snapshot.localRef,
    );
    return { stashed, local };
}

/**
 * Opens a VS Code diff for one stash file, or VS Code's multi-file changes editor for the whole stash.
 *
 * File-specific requests compare readonly snapshots of stashed and local content so each side has
 * an explicit resource label. Missing stash or workspace sides use explicitly labeled empty virtual
 * documents. A missing local file is the original (left) side, so its stashed snapshot renders as a
 * new-file addition; other filesystem errors reject. Stash-level requests retain every valid stash
 * file in the changes editor, preserving absent sides for added or deleted files.
 * Preview mode defaults to true for legacy callers; false keeps the resulting changes editor pinned
 * in a new tab.
 */
export async function showStashDiffFromPanel(
    deps: Pick<PanelFileActionDeps, "gitOps" | "getWorkspaceRoot">,
    indexValue: unknown,
    pathValue: unknown,
    preview = true,
): Promise<void> {
    const index = assertNumber(indexValue, "index");
    const ref = `stash@{${index}}`;
    if (pathValue !== undefined) {
        const filePath = assertRepoRelativePath(assertString(pathValue, "path"));
        const contents = await deps.gitOps.getStashFileContents(index, filePath);
        const snapshot = await prepareStashLocalDiffSnapshot(
            deps.getWorkspaceRoot(),
            filePath,
            ref,
            contents,
        );
        const { stashed, local } = createStashLocalDiffUris(snapshot);
        const [original, modified] = snapshot.isLocalMissing ? [local, stashed] : [stashed, local];
        const title = snapshot.isLocalMissing
            ? `${filePath} (${snapshot.localRef} <-> ${snapshot.stashedRef})`
            : vscode.l10n.t("{path} (Stashed: {ref}) <-> Local File", { path: filePath, ref });
        await vscode.commands.executeCommand("vscode.diff", original, modified, title, { preview });
        return;
    }

    const files = await deps.gitOps.getStashFiles(index);
    const workspaceRoot = deps.getWorkspaceRoot();
    const snapshots = await mapWithConcurrency<WorkingFile, StashDiffSnapshot>(
        files,
        4,
        async (file) => {
            const contents = await deps.gitOps.getStashFileContents(index, file.path);
            return prepareStashLocalDiffSnapshot(workspaceRoot, file.path, ref, contents);
        },
    );
    const changes = snapshots.map((snapshot): StashChange => {
        const { stashed, local } = createStashLocalDiffUris(snapshot);
        return snapshot.isLocalMissing ? [stashed, local, stashed] : [stashed, stashed, local];
    });
    await vscode.commands.executeCommand("vscode.changes", `Stash ${ref}`, changes);
    if (!preview) await vscode.commands.executeCommand("workbench.action.keepEditor");
}

/**
 * Opens a validated repository file in the editor without mutating Git state.
 *
 * The workspace root comes from the active provider, making this action safe for both docked and
 * undocked panels as long as their repository root assumptions stay in sync.
 */
export async function openFileFromPanel(
    deps: PanelFileActionDeps,
    pathValue: unknown,
): Promise<void> {
    const filePath = assertRepoRelativePath(assertString(pathValue, "path"));
    const uri = vscode.Uri.joinPath(deps.getWorkspaceRoot(), filePath);
    await vscode.window.showTextDocument(uri);
}

/**
 * Confirms and deletes a repository-relative file selected from the commit panel.
 *
 * Deletion uses the shared Git/filesystem fallback helper, then refreshes and emits change events
 * only when a file was actually removed.
 */
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
    showTimedInformationMessage(vscode.l10n.t("Deleted {path}", { path: filePath }));
    await deps.refreshData();
    deps.fireWorkingTreeChanged();
}

/**
 * Loads a stash selection, decorates its files, and posts a full panel update.
 *
 * Selecting a stash does not mutate the repository. It refreshes provider-held stash state and
 * includes current branch upstream status so push-related UI stays consistent with working files.
 */
export async function selectStashFromPanel(
    deps: StashSelectionDeps,
    indexValue: unknown,
): Promise<void> {
    const selectedStashIndex = assertNumber(indexValue, "index");
    const files = deps.getFiles();
    const stashFiles = await deps.iconTheme.decorateWorkingFiles(
        await deps.gitOps.getStashFiles(selectedStashIndex),
    );
    const folderIconsByName = await deps.iconTheme.getFolderIconsByWorkingFiles([
        ...files,
        ...stashFiles,
    ]);
    deps.setStashState({ selectedStashIndex, stashFiles, folderIconsByName });
    const { folderIcons, iconFonts } = deps.iconTheme.getThemeData();
    deps.postUpdate({
        type: "update",
        files,
        stashes: deps.getStashes(),
        stashFiles,
        selectedStashIndex,
        folderIcon: folderIcons.folderIcon,
        folderExpandedIcon: folderIcons.folderExpandedIcon,
        folderIconsByName,
        iconFonts,
        currentBranchHasUpstream: await deps.currentBranchHasUpstream(),
    });
}
