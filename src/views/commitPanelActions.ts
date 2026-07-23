import * as vscode from "vscode";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { GitOps } from "../git/operations";
import { RepositoryLockBusyError } from "../git/repositoryLock";
import {
    ShelfRecoveryFullError,
    ShelfStaleCatalogError,
    ShelfStaleShelfError,
    type ShelfMutationResult,
    type ShelfService,
} from "../services/shelfService";
import { promptRebaseAfterPushRejection } from "../services/gitHelpers";
import { assertValidBranchName } from "../utils/gitRefs";
import type {
    InboundMessage,
    PerEntryResult,
    ShelfMutationStatus,
} from "../webviews/protocol/commitPanelMessages";
import {
    assertNumber,
    assertRepoPathArray,
    assertShelfChangeId,
    assertShelfGeneration,
    assertShelfId,
    assertShelfName,
    assertShelfToken,
    assertString,
    assertStringArray,
} from "./messageValidation";
import {
    runWithNotificationProgress,
    showTimedWarningMessage,
    showTimedInformationMessage,
} from "../utils/notifications";
import { showShelfDiffFromPanel } from "./shelfDiffActions";

interface CommitPanelActionDeps {
    gitOps: GitOps;
    refreshData: () => Promise<void>;
    refreshGraphData?: () => Promise<void>;
    fireWorkingTreeChanged: () => void;
    postCommitted: () => void;
    maybeOfferPublishBranch: () => Promise<void>;
    publishBranch?: () => Promise<void>;
}

/** Describes one validated stash mutation initiated by either commit-panel provider. */
export type StashMutation =
    | { action: "apply" | "pop"; index: number; reinstateIndex: boolean }
    | { action: "branch"; index: number; branchName: string }
    | { action: "delete"; index: number }
    | { action: "clear" };

/**
 * Validates an untrusted typed unstash payload and translates it into a host mutation.
 *
 * Current-branch mode accepts only apply/pop plus an explicit index-restoration flag. Branch mode
 * validates the new branch name and rejects an independent index-restoration option because
 * `git stash branch` restores the index by definition.
 */
export function stashMutationFromUnstashMessage(message: Record<string, unknown>): StashMutation {
    const index = assertNumber(message.index, "index");
    if (message.mode === "currentBranch") {
        if (message.action !== "apply" && message.action !== "pop") {
            throw new Error("Invalid stash unstash action received from webview.");
        }
        if (typeof message.reinstateIndex !== "boolean") {
            throw new Error("Expected boolean for 'reinstateIndex'.");
        }
        return {
            action: message.action,
            index,
            reinstateIndex: message.reinstateIndex,
        };
    }
    if (message.mode !== "branch") {
        throw new Error("Invalid stash unstash mode received from webview.");
    }
    if ("reinstateIndex" in message) {
        throw new Error("Branch stash unstash cannot set 'reinstateIndex'.");
    }
    const branchName = assertString(message.branchName, "branchName");
    assertValidBranchName(branchName);
    return { action: "branch", index, branchName };
}

/**
 * Executes one optionally correlated stash mutation and always posts its completion acknowledgement.
 *
 * Request IDs cross the untrusted webview boundary here. Missing IDs preserve legacy behavior;
 * present IDs must be non-empty strings and are echoed exactly once from an outer `finally`, after
 * mutation confirmation, conflict handling, and refresh have either completed or thrown.
 */
export async function executeStashMutationRequest(
    deps: Pick<CommitPanelActionDeps, "gitOps" | "refreshData" | "fireWorkingTreeChanged">,
    mutation: StashMutation,
    requestIdValue: unknown,
    postCompleted: (requestId: string) => void,
): Promise<void> {
    const requestId =
        requestIdValue === undefined ? undefined : assertString(requestIdValue, "requestId");
    if (requestId !== undefined && requestId.trim().length === 0) {
        throw new Error("Expected non-empty string for 'requestId'.");
    }
    try {
        await stashMutationFromPanel(deps, mutation);
    } finally {
        if (requestId !== undefined) postCompleted(requestId);
    }
}

/** Narrow host dependency surface used by both commit-panel providers for shelf requests. */
export interface ShelfActionDeps {
    shelfService: ShelfService;
    refreshData: () => Promise<void>;
    fireWorkingTreeChanged: () => void;
    /** Resolves an export destination from a host-owned picker, never from webview input. */
    selectExportDestination?: () => Promise<string | undefined>;
    /** Resolves import sources from a host-owned picker, never from webview input. */
    selectImportSources?: () => Promise<readonly string[] | undefined>;
}

/** Narrow host dependency surface for the non-mutating shelf merge-editor launch. */
export interface ShelfConflictEditorActionDeps {
    shelfService: ShelfService;
    openShelfConflictEditor: (shelfId: string, changeId: string) => Promise<void>;
}

/** Revalidates an untrusted shelf conflict launch before opening the host-owned panel. */
export async function openShelfConflictEditorFromMessage(
    deps: ShelfConflictEditorActionDeps,
    message: Record<string, unknown>,
): Promise<void> {
    if (message.type !== "shelfOpenConflictEditor") {
        throw new Error("Invalid shelf conflict editor request received from webview.");
    }
    const shelfId = await assertExistingShelf(deps.shelfService, message.shelfId);
    const changeId = assertShelfChangeId(message.changeId, "changeId");
    await assertExistingChangeIds(deps.shelfService, shelfId, [changeId]);
    await deps.openShelfConflictEditor(shelfId, changeId);
}

type ShelfMutationCompleted = Extract<InboundMessage, { type: "shelfMutationCompleted" }>;

/** Executes all correlated shelf mutations and posts a typed completion even after failures. */
export async function executeShelfMutationRequest(
    deps: ShelfActionDeps,
    message: Record<string, unknown>,
    postCompleted: (message: ShelfMutationCompleted) => void,
): Promise<void> {
    const requestId = assertShelfToken(message.requestId, "requestId");
    let completion: ShelfMutationCompleted = {
        type: "shelfMutationCompleted",
        requestId,
        status: "error",
        entries: [],
    };
    let workingTreeChanged = false;
    try {
        const exportFileUri =
            message.type === "shelfExportPatch"
                ? await deps.selectExportDestination?.()
                : undefined;
        const importFileUris =
            message.type === "shelfImportPatch" ? await deps.selectImportSources?.() : undefined;
        if (message.type === "shelfExportPatch" && exportFileUri === undefined) {
            completion = {
                type: "shelfMutationCompleted",
                requestId,
                status: "ok",
                entries: [],
                message: "Patch export cancelled.",
            };
            return;
        }
        if (message.type === "shelfImportPatch" && importFileUris === undefined) {
            completion = {
                type: "shelfMutationCompleted",
                requestId,
                status: "ok",
                entries: [],
                message: "Patch import cancelled.",
            };
            return;
        }
        const result = await shelfMutationFromMessage(
            deps.shelfService,
            message,
            exportFileUri,
            importFileUris,
        );
        workingTreeChanged = changesWorkingTree(message.type) && result.status !== "error";
        completion = await shelfCompletion(requestId, result, deps.shelfService);
    } catch (error) {
        completion = completionForShelfError(requestId, error);
        throw error;
    } finally {
        try {
            await deps.refreshData();
            if (workingTreeChanged) deps.fireWorkingTreeChanged();
        } finally {
            postCompleted(completion);
        }
    }
}

/** Validates and executes a single shelf request without pre-checking any service CAS input. */
export async function shelfMutationFromMessage(
    shelfService: ShelfService,
    message: Record<string, unknown>,
    hostExportFileUri?: string,
    hostImportFileUris?: readonly string[],
): Promise<ShelfMutationResult> {
    switch (message.type) {
        case "shelveSave": {
            if ("shelfId" in message) throw new Error("Shelf IDs are generated by the host.");
            return shelfService.shelve({
                name: assertShelfName(message.name, "name"),
                paths: assertRepoPathArray(message.paths, "paths"),
                silent: assertBoolean(message.silent, "silent"),
                keepLocal: assertBoolean(message.keepLocal, "keepLocal"),
                idempotencyToken: assertShelfToken(message.idempotencyToken, "idempotencyToken"),
                expectedCatalogGeneration: assertShelfGeneration(
                    message.expectedCatalogGeneration,
                    "expectedCatalogGeneration",
                ),
            });
        }
        case "unshelve": {
            const shelfId = await assertExistingShelf(shelfService, message.shelfId);
            const changeIds = await assertExistingChangeIds(
                shelfService,
                shelfId,
                message.changeIds,
            );
            return shelfService.unshelve({
                id: shelfId,
                expectedShelfGeneration: assertShelfGeneration(
                    message.expectedGeneration,
                    "expectedGeneration",
                ),
                changeIds,
                removeFromShelf: assertBoolean(message.removeFromShelf, "removeFromShelf"),
                mode: assertUnshelveMode(message.mode),
            });
        }
        case "shelfDelete":
            return shelfService.deleteShelf({
                id: await assertExistingShelf(shelfService, message.shelfId),
                expectedShelfGeneration: assertShelfGeneration(
                    message.expectedGeneration,
                    "expectedGeneration",
                ),
            });
        case "shelfRename":
            return shelfService.renameShelf({
                id: await assertExistingShelf(shelfService, message.shelfId),
                expectedShelfGeneration: assertShelfGeneration(
                    message.expectedGeneration,
                    "expectedGeneration",
                ),
                name: assertShelfName(message.name, "name"),
            });
        case "shelfExportPatch": {
            const shelfId = await assertExistingShelf(shelfService, message.shelfId);
            const changeIds = await assertExistingChangeIds(
                shelfService,
                shelfId,
                message.changeIds,
            );
            assertShelfGeneration(message.expectedGeneration, "expectedGeneration");
            const fileUri = assertAbsolutePath(hostExportFileUri, "host export destination");
            await writeFile(fileUri, await shelfService.exportPatch({ id: shelfId, changeIds }));
            return { status: "ok", entries: [], shelfId };
        }
        case "shelfImportPatch":
            return shelfService.importPatch({
                fileUris: assertAbsolutePaths(hostImportFileUris, "host import sources"),
                idempotencyToken: assertShelfToken(message.idempotencyToken, "idempotencyToken"),
                expectedCatalogGeneration: assertShelfGeneration(
                    message.expectedCatalogGeneration,
                    "expectedCatalogGeneration",
                ),
            });
        case "shelfRestoreGhost":
            return shelfService.restoreGhost({
                id: await assertExistingShelf(shelfService, message.shelfId),
                expectedShelfGeneration: assertShelfGeneration(
                    message.expectedGeneration,
                    "expectedGeneration",
                ),
            });
        case "shelfCleanUp": {
            const shelfIds = assertStringArray(message.shelfIds, "shelfIds").map((value) =>
                assertShelfId(value, "shelfIds"),
            );
            await Promise.all(
                shelfIds.map((shelfId) => assertExistingShelf(shelfService, shelfId)),
            );
            return shelfService.cleanUp({
                shelfIds,
                expectedCatalogGeneration: assertShelfGeneration(
                    message.expectedCatalogGeneration,
                    "expectedCatalogGeneration",
                ),
            });
        }
        case "shelfResolveStructural": {
            const shelfId = await assertExistingShelf(shelfService, message.shelfId);
            const changeId = assertShelfChangeId(message.changeId, "changeId");
            await assertExistingChangeIds(shelfService, shelfId, [changeId]);
            return shelfService.resolveStructural({
                id: shelfId,
                changeId,
                expectedShelfGeneration: assertShelfGeneration(
                    message.expectedGeneration,
                    "expectedGeneration",
                ),
                expectedPathFingerprint: assertShelfToken(
                    message.expectedPathFingerprint,
                    "expectedPathFingerprint",
                ),
                action: assertStructuralAction(message.action),
                targetPath:
                    message.targetPath === undefined
                        ? undefined
                        : assertRepoPathArray([message.targetPath], "targetPath")[0],
            });
        }
        case "shelfPurgeRecovery":
            await shelfService.purgeRecovery();
            return { status: "ok", entries: [] };
        default:
            throw new Error("Invalid shelf mutation received from webview.");
    }
}

/** Validates and opens immutable shelf artifacts as read-only diff documents. */
export async function shelfReadFromMessage(
    shelfService: ShelfService,
    message: Record<string, unknown>,
    getWorkspaceRoot: () => vscode.Uri,
): Promise<void> {
    const shelfId = await assertExistingShelf(shelfService, message.shelfId);
    assertShelfGeneration(message.expectedGeneration, "expectedGeneration");
    const changeId =
        message.changeId === undefined
            ? undefined
            : assertShelfChangeId(message.changeId, "changeId");
    if (changeId !== undefined) await assertExistingChangeIds(shelfService, shelfId, [changeId]);
    const mode =
        message.type === "shelfDiff"
            ? "baseToShelved"
            : message.type === "shelfCompareWithLocal"
              ? "shelvedToLocal"
              : undefined;
    if (!mode) throw new Error("Invalid shelf diff request received from webview.");
    await showShelfDiffFromPanel(
        { shelfReader: shelfService, getWorkspaceRoot },
        shelfId,
        changeId,
        mode,
    );
}

/** Converts service outcomes into the protocol's explicit per-entry contract. */
async function shelfCompletion(
    requestId: string,
    result: ShelfMutationResult,
    shelfService: ShelfService,
): Promise<ShelfMutationCompleted> {
    const catalog = await shelfService.listShelves();
    return {
        type: "shelfMutationCompleted",
        requestId,
        status: result.status,
        entries: result.entries.map(protocolEntry),
        shelfId: result.shelfId,
        newGeneration: result.newGeneration,
        newCatalogGeneration: catalog.catalogGeneration,
    };
}

function protocolEntry(entry: PerEntryResult): PerEntryResult {
    return { ...entry };
}

function completionForShelfError(requestId: string, error: unknown): ShelfMutationCompleted {
    return {
        type: "shelfMutationCompleted",
        requestId,
        status: shelfStatusForError(error),
        entries: [],
        message: error instanceof Error ? error.message : String(error),
    };
}

function shelfStatusForError(error: unknown): ShelfMutationStatus {
    if (error instanceof RepositoryLockBusyError) return "busy";
    if (error instanceof ShelfStaleShelfError) return "staleShelf";
    if (error instanceof ShelfStaleCatalogError) return "staleCatalog";
    if (error instanceof ShelfRecoveryFullError) return "recoveryFull";
    return "error";
}

function changesWorkingTree(type: unknown): boolean {
    return type === "shelveSave" || type === "unshelve" || type === "shelfResolveStructural";
}

async function assertExistingShelf(shelfService: ShelfService, value: unknown): Promise<string> {
    const shelfId = assertShelfId(value, "shelfId");
    const catalog = await shelfService.listShelves();
    if (!catalog.shelves.some((shelf) => shelf.id === shelfId)) {
        throw new Error("Shelf does not exist.");
    }
    return shelfId;
}

async function assertExistingChangeIds(
    shelfService: ShelfService,
    shelfId: string,
    value: unknown,
): Promise<string[] | undefined> {
    if (value === undefined) return undefined;
    const changeIds = assertStringArray(value, "changeIds").map((changeId) =>
        assertShelfChangeId(changeId, "changeIds"),
    );
    const known = new Set(
        (await shelfService.getShelfFiles(shelfId)).map((entry) => entry.changeId),
    );
    if (changeIds.some((changeId) => !known.has(changeId))) {
        throw new Error("Shelf change ID does not exist.");
    }
    return changeIds;
}

function assertBoolean(value: unknown, field: string): boolean {
    if (typeof value !== "boolean") throw new Error(`Expected boolean for '${field}'.`);
    return value;
}

function assertUnshelveMode(value: unknown): "flattened" | "exactState" {
    if (value === "flattened" || value === "exactState") return value;
    throw new Error("Invalid shelf unshelve mode received from webview.");
}

function assertStructuralAction(
    value: unknown,
): "keepLocal" | "useShelved" | "deleteLocal" | "renameLocal" {
    if (
        value === "keepLocal" ||
        value === "useShelved" ||
        value === "deleteLocal" ||
        value === "renameLocal"
    ) {
        return value;
    }
    throw new Error("Invalid structural shelf action received from webview.");
}

function assertAbsolutePaths(value: unknown, field: string): string[] {
    return assertStringArray(value, field).map((item) => assertAbsolutePath(item, field));
}

function assertAbsolutePath(value: unknown, field: string): string {
    const filePath = assertString(value, field);
    if (!path.isAbsolute(filePath)) throw new Error(`Expected absolute path for '${field}'.`);
    return filePath;
}

/**
 * Git operation identifiers accepted from the Changes toolbar.
 *
 * `fetch` updates remote-tracking refs, `pull` rebases the current branch onto its upstream,
 * `push` sends local commits to the upstream, and `sync` runs pull-rebase followed by push.
 */
export type CommitPanelGitOperation = "fetch" | "pull" | "push" | "sync";

/** Returns whether the current local branch has already been published upstream. */
async function currentBranchIsPublished(gitOps: GitOps): Promise<boolean> {
    const branches = await gitOps.getBranches();
    const currentBranch = branches.find((branch) => branch.isCurrent && !branch.isRemote);
    return currentBranch?.upstream !== undefined && currentBranch.upstream.length > 0;
}

/** Warns when repository-modifying actions should wait for a clean working tree. */
async function warnIfUncommittedChanges(gitOps: GitOps): Promise<boolean> {
    if (!(await gitOps.hasUncommittedChanges())) return false;
    showTimedWarningMessage(
        vscode.l10n.t("There are uncommitted changes, please commit or stash them first."),
    );
    return true;
}

/**
 * Commits the validated subset of selected Changes-panel files and optionally pushes it.
 *
 * Callers must pass repository-relative paths that have already crossed the webview validation
 * boundary. The action stages those paths, warns on missing commit input, retries push rejection via
 * the rebase prompt, and refreshes panel/working-tree state only after a successful commit path.
 */
export async function commitSelectedFromPanel(
    deps: CommitPanelActionDeps,
    options: { message: string; amend: boolean; push: boolean; paths: string[] },
): Promise<void> {
    const { gitOps, refreshData, fireWorkingTreeChanged, postCommitted } = deps;
    const { message, amend, push, paths } = options;
    if (!message && !amend) {
        showTimedWarningMessage(vscode.l10n.t("Enter a commit message."));
        return;
    }
    if (paths.length === 0 && !amend) {
        showTimedWarningMessage(vscode.l10n.t("Select files to commit."));
        return;
    }
    if (paths.length > 0) {
        await gitOps.stageFiles(paths);
    }
    const progressTitle = push
        ? vscode.l10n.t("Committing and pushing...")
        : vscode.l10n.t("Committing...");
    await runWithNotificationProgress(progressTitle, async () => {
        await gitOps.commit(message, amend);
    });
    if (push) {
        try {
            await runGitOperationFromPanel(deps, "push");
        } catch (err) {
            postCommitted();
            await refreshData();
            fireWorkingTreeChanged();
            throw err;
        }
        postCommitted();
    } else {
        showTimedInformationMessage(vscode.l10n.t("Committed successfully."));
        postCommitted();
        await refreshData();
        fireWorkingTreeChanged();
    }
}

/**
 * Runs the commit-only button action for the current Changes-panel repository.
 *
 * The helper owns user-facing validation for empty messages, progress notification, success UI,
 * draft reset signaling, panel refresh, and working-tree change notification.
 */
export async function commitOnlyFromPanel(
    deps: CommitPanelActionDeps,
    message: string,
    amend: boolean,
): Promise<void> {
    if (!message && !amend) {
        showTimedWarningMessage(vscode.l10n.t("Enter a commit message."));
        return;
    }
    await runWithNotificationProgress(vscode.l10n.t("Committing..."), async () => {
        await deps.gitOps.commit(message, amend);
    });
    showTimedInformationMessage(vscode.l10n.t("Committed successfully."));
    deps.postCommitted();
    await deps.refreshData();
    deps.fireWorkingTreeChanged();
}

/**
 * Commits the current panel changes and pushes the active branch with push-rejection recovery.
 *
 * Rebase retry prompts are handled here so both docked and undocked panels surface the same UX;
 * unrecovered errors are rethrown for the provider message handler to report to the webview.
 */
export async function commitAndPushFromPanel(
    deps: CommitPanelActionDeps,
    message: string,
    amend: boolean,
): Promise<void> {
    if (!message && !amend) {
        showTimedWarningMessage(vscode.l10n.t("Enter a commit message."));
        return;
    }
    await runWithNotificationProgress(vscode.l10n.t("Committing and pushing..."), async () => {
        await deps.gitOps.commit(message, amend);
    });
    await runGitOperationFromPanel(deps, "push");
    deps.postCommitted();
}

/**
 * Runs a top-level Git operation requested from the Changes toolbar.
 *
 * The caller supplies `gitOps` for Git I/O, `refreshData` for the Changes snapshot,
 * optional `refreshGraphData` for the embedded graph, and `fireWorkingTreeChanged` for
 * extension listeners that react to repository updates. On success, the panel shows the
 * operation-specific completion message, refreshes panel data, refreshes graph data when
 * available, and fires the working-tree change event.
 *
 * `fetch` updates remote-tracking refs only, `pull` runs `pull --rebase`, `push` pushes the
 * current branch, and `sync` always runs pull-rebase before push. Git failures are rethrown
 * except rejected `push` or `sync` operations may prompt for a rebase retry through
 * `promptRebaseAfterPushRejection`.
 */
export async function runGitOperationFromPanel(
    deps: Pick<
        CommitPanelActionDeps,
        "gitOps" | "refreshData" | "refreshGraphData" | "fireWorkingTreeChanged" | "publishBranch"
    >,
    operation: CommitPanelGitOperation,
): Promise<void> {
    if (
        (operation === "pull" || operation === "sync") &&
        (await warnIfUncommittedChanges(deps.gitOps))
    ) {
        return;
    }

    if (!(await currentBranchIsPublished(deps.gitOps))) {
        if (operation === "push") {
            // Publishing must finish before commit-panel and graph refresh read branch state.
            // react-doctor-disable-next-line react-doctor/async-parallel
            await (deps.publishBranch?.() ??
                vscode.commands.executeCommand("intelligit.publishBranch"));
            await deps.refreshData();
            await deps.refreshGraphData?.();
            deps.fireWorkingTreeChanged();
            return;
        }
        if (operation === "pull" || operation === "sync") {
            showTimedWarningMessage(vscode.l10n.t("The repo has not been published yet."));
            return;
        }
    }

    const labels = {
        fetch: {
            progress: vscode.l10n.t("Fetching..."),
            success: vscode.l10n.t("Fetched successfully."),
        },
        pull: {
            progress: vscode.l10n.t("Pulling..."),
            success: vscode.l10n.t("Pulled successfully."),
        },
        push: {
            progress: vscode.l10n.t("Pushing..."),
            success: vscode.l10n.t("Pushed successfully."),
        },
        sync: {
            progress: vscode.l10n.t("Syncing..."),
            success: vscode.l10n.t("Synced successfully."),
        },
    }[operation];

    try {
        await runWithNotificationProgress(labels.progress, async () => {
            if (operation === "fetch") {
                await deps.gitOps.fetch();
            } else if (operation === "pull") {
                await deps.gitOps.pullRebase();
            } else if (operation === "push") {
                await deps.gitOps.push();
            } else {
                await deps.gitOps.pullRebase();
                await deps.gitOps.push();
            }
        });
    } catch (err) {
        if (
            (operation === "push" || operation === "sync") &&
            (await promptRebaseAfterPushRejection(err, deps.gitOps, async () => {
                await deps.gitOps.push();
            }))
        ) {
            showTimedInformationMessage(labels.success);
            await deps.refreshData();
            await deps.refreshGraphData?.();
            deps.fireWorkingTreeChanged();
            return;
        }
        throw err;
    }

    showTimedInformationMessage(labels.success);
    await deps.refreshData();
    await deps.refreshGraphData?.();
    deps.fireWorkingTreeChanged();
}

/**
 * Prompts before rolling back selected paths or the entire working tree from the panel.
 *
 * An empty path list intentionally means “rollback all changes.” Path values must already be
 * validated by the caller before this destructive Git operation is offered to the user.
 */
export async function rollbackFromPanel(
    deps: Pick<CommitPanelActionDeps, "gitOps" | "refreshData" | "fireWorkingTreeChanged">,
    paths: string[],
): Promise<void> {
    const rollbackAction = vscode.l10n.t("Rollback");
    if (paths.length === 0) {
        const confirm = await vscode.window.showWarningMessage(
            vscode.l10n.t("Rollback all changes?"),
            { modal: true },
            rollbackAction,
        );
        if (confirm !== rollbackAction) return;
        await deps.gitOps.rollbackAll();
    } else {
        const confirm = await vscode.window.showWarningMessage(
            vscode.l10n.t("Rollback {count} file(s)?", { count: paths.length }),
            { modal: true },
            rollbackAction,
        );
        if (confirm !== rollbackAction) return;
        await deps.gitOps.rollbackFiles(paths);
    }
    showTimedInformationMessage(vscode.l10n.t("Changes rolled back."));
    await deps.refreshData();
    deps.fireWorkingTreeChanged();
}

/**
 * Saves the current or selected working-tree changes to a stash entry from the panel.
 *
 * The caller supplies the UI-derived stash name and already validated optional paths; this helper
 * owns the success notification plus follow-up refresh/change events after Git mutates the stash.
 */
export async function stashSaveFromPanel(
    deps: Pick<CommitPanelActionDeps, "gitOps" | "refreshData" | "fireWorkingTreeChanged">,
    options: { name: string; paths?: string[] },
): Promise<void> {
    await deps.gitOps.stashSave(options.paths, options.name);
    showTimedInformationMessage(vscode.l10n.t("Changes stashed."));
    await deps.refreshData();
    deps.fireWorkingTreeChanged();
}

/**
 * Runs a stash mutation and opens the merge session when Git leaves conflict markers behind.
 */
async function runStashMutationWithConflicts(
    deps: Pick<CommitPanelActionDeps, "gitOps" | "refreshData" | "fireWorkingTreeChanged">,
    mutate: () => Promise<unknown>,
): Promise<boolean> {
    try {
        await mutate();
        return false;
    } catch (err) {
        const conflicts = await deps.gitOps.getConflictFilesDetailed();
        if (conflicts.length === 0) throw err;
        await vscode.commands.executeCommand("intelligit.openConflictSession");
        return true;
    }
}

/**
 * Applies, pops, branches, deletes, or clears stashes selected in the panel.
 *
 * Destructive requests require a modal confirmation. Every attempt refreshes stash data in `finally`
 * so both providers clear their busy state even after cancellation, conflict, or failure; only actions
 * that changed the working tree notify working-tree listeners.
 */
export async function stashMutationFromPanel(
    deps: Pick<CommitPanelActionDeps, "gitOps" | "refreshData" | "fireWorkingTreeChanged">,
    mutation: StashMutation,
): Promise<void> {
    let workingTreeChanged = false;
    try {
        if (mutation.action === "delete") {
            const deleteAction = vscode.l10n.t("Delete");
            const confirm = await vscode.window.showWarningMessage(
                vscode.l10n.t("Delete this stashed change?"),
                { modal: true },
                deleteAction,
            );
            if (confirm !== deleteAction) return;
            await deps.gitOps.stashDelete(mutation.index);
            showTimedInformationMessage(vscode.l10n.t("Stashed change deleted."));
            return;
        }
        if (mutation.action === "clear") {
            const clearAction = vscode.l10n.t("Clear All Stashes");
            const confirm = await vscode.window.showWarningMessage(
                vscode.l10n.t(
                    "Clear all stashes? This is irreversible and may prevent recovery of saved work.",
                ),
                { modal: true },
                clearAction,
            );
            if (confirm !== clearAction) return;
            await deps.gitOps.stashClear();
            showTimedInformationMessage(vscode.l10n.t("All stashed changes cleared."));
            return;
        }

        const conflicted =
            mutation.action === "branch"
                ? await runStashMutationWithConflicts(deps, () =>
                      deps.gitOps.stashBranch(mutation.branchName, mutation.index),
                  )
                : await runStashMutationWithConflicts(deps, () =>
                      mutation.action === "pop"
                          ? mutation.reinstateIndex
                              ? deps.gitOps.stashPop(mutation.index, true)
                              : deps.gitOps.stashPop(mutation.index)
                          : mutation.reinstateIndex
                            ? deps.gitOps.stashApply(mutation.index, true)
                            : deps.gitOps.stashApply(mutation.index),
                  );
        workingTreeChanged = true;
        if (conflicted) return;
        if (mutation.action === "branch") {
            showTimedInformationMessage(vscode.l10n.t("Stashed changes restored on new branch."));
        } else if (mutation.action === "pop") {
            showTimedInformationMessage(vscode.l10n.t("Unstashed changes."));
        } else {
            showTimedInformationMessage(vscode.l10n.t("Applied stashed changes."));
        }
    } finally {
        await deps.refreshData();
        if (workingTreeChanged) deps.fireWorkingTreeChanged();
    }
}
