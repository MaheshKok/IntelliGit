import * as vscode from "vscode";
import type { GitOps } from "../git/operations";
import type { PartialChanges } from "../git/partialChanges";
import { ChangelistRevisionError, ChangelistStore } from "../changes/changelistStore";
import { changeIds, validateSelection } from "../changes/selection";
import type { ChangelistReply, ChangelistOutbound } from "../webviews/protocol/changelists";
import type { SelectedFileChanges } from "../webviews/protocol/changeSelection";
import type { WorkingFile } from "../types";
import { PartialChangesPanel } from "./PartialChangesPanel";
import { assertChangeBuffersSaved } from "./changeDirtyBuffers";
import { assertRepoPathArray, assertString } from "./messageValidation";
import { commitSelectedFromPanel, runGitOperationFromPanel } from "./commitPanelActions";
import { showDiffFromPanel } from "./panelFileActions";
import { getErrorMessage } from "../utils/errors";
import { showTimedWarningMessage } from "../utils/notifications";
import { PartialIndexPublicationError } from "../git/partialIndexTransaction";
import type { ChangelistState } from "../webviews/protocol/changeSelection";
import type { PartialFileSnapshot } from "../git/partialSnapshot";
import { ChangeRangeTracker } from "../changes/changeRangeTracker";
import { rangeSnapshot } from "../changes/rangeMapping";

interface ChangeWorkflowDeps {
    root: string;
    extensionUri: vscode.Uri;
    workspaceState?: vscode.Memento;
    gitOps: GitOps;
    files(): readonly WorkingFile[];
    post(
        message: ChangelistReply | { type: "error"; repositoryRoot: string; message: string },
    ): void;
    actions: CommitPanelActionDeps;
    runCommit(operation: () => Promise<void>): Promise<void>;
    mirrorDraft?(scope: string, text: string): void;
    postScopedCommit?(): void;
    clearLastCommit?(): boolean;
}
type CommitPanelActionDeps = Parameters<typeof commitSelectedFromPanel>[0];

const COMMANDS = new Set([
    "loadChangelists",
    "changelistDraft",
    "changelistAction",
    "openPartialChanges",
    "commitChangelist",
]);

/** Recognizes only the additive workflow family, leaving existing panel routes unchanged. */
export function isChangeWorkflowCommand(type: string): boolean {
    return COMMANDS.has(type);
}

/** Coordinates metadata and a captured-root Git service for one provider runtime. */
export class ChangeWorkflowHost {
    private readonly store: ChangelistStore;
    private readonly partial: PartialChanges;
    private readonly unsubscribe: () => void;
    private committing = false;
    private reconciling = 0;
    private readonly tracker: ChangeRangeTracker;
    private connected?: Promise<void>;
    private readonly poll: ReturnType<typeof setInterval>;
    private lastRevision = -1;

    /** Shares workspace metadata while each provider retains its own root-bound Git facade. */
    constructor(private readonly deps: ChangeWorkflowDeps) {
        this.store = ChangelistStore.forStorage(deps.workspaceState);
        this.partial = deps.gitOps.partialChangesFor(deps.root);
        this.tracker = new ChangeRangeTracker(deps.root, this.partial, this.store);
        this.unsubscribe = this.store.subscribe((root) => {
            if (root === this.deps.root)
                this.deps.post({
                    type: "setChangelists",
                    repositoryRoot: root,
                    state: this.store.view(root),
                    busy: this.reconciling > 0 || this.committing || this.store.isCommitting(root),
                    ...(this.partial.recoveryIssues().length ? { hasRecoveryIssues: true } : {}),
                });
        });
        this.poll = setInterval(() => {
            if (!this.connected) return;
            try {
                const revision = this.store.get(deps.root).revision;
                if (revision !== this.lastRevision) {
                    this.lastRevision = revision;
                    this.post();
                }
            } catch {
                this.post();
            }
        }, 1000);
        this.poll.unref();
    }

    /** Releases provider delivery; already-open editors still own their captured root. */
    dispose(): void {
        this.unsubscribe();
        clearInterval(this.poll);
    }

    /** Durable migration is awaited before host intents can mutate metadata or Git. */
    private connect(): Promise<void> {
        this.connected ??= this.deps.gitOps
            .getGitDirectories()
            .then(({ gitDir }) => this.store.connect(this.deps.root, gitDir))
            .catch((error: unknown) => {
                this.connected = undefined;
                throw error;
            });
        return this.connected;
    }

    /** Keeps actions busy through overlapping range observations and membership updates. */
    async reconcile(files: readonly WorkingFile[]): Promise<void> {
        this.reconciling++;
        try {
            await this.connect();
            this.post();
            if (this.store.isCommitting(this.deps.root)) return;
            await this.tracker.reconcile(files);
            await this.store.reconcileFiles(
                this.deps.root,
                files.filter((file) => file.status !== "!").map((file) => file.path),
            );
        } finally {
            this.reconciling--;
            this.post();
        }
    }

    /** Validates repository identity and keeps initial recovery/loading busy before allowing actions. */
    async handle(raw: Record<string, unknown>): Promise<void> {
        if (raw.repositoryRoot !== this.deps.root)
            throw new Error("Unknown changelist repository.");
        const loading = raw.type === "loadChangelists";
        if (loading) this.reconciling++;
        try {
            await this.connect();
            const message = raw as unknown as ChangelistOutbound;
            switch (message.type) {
                case "loadChangelists": {
                    const recovered = await this.partial.recover();
                    const files = this.deps.files();
                    await this.reconcile(
                        files.length
                            ? files
                            : await this.deps.gitOps.getStatus({ withStats: false }),
                    );
                    if (recovered) await this.deps.actions.refreshData();
                    break;
                }
                case "changelistDraft": {
                    const scope = assertString(message.listId, "listId");
                    if (message.action === "save") {
                        const requestId = assertString(message.requestId, "requestId");
                        try {
                            await this.store.saveDraft(
                                this.deps.root,
                                scope,
                                assertString(message.expected, "expected"),
                                assertString(message.message, "message"),
                            );
                            this.deps.post({
                                type: "changelistDraftResult",
                                repositoryRoot: this.deps.root,
                                listId: scope,
                                requestId,
                                message: this.store.draft(this.deps.root, scope),
                            });
                        } catch (error) {
                            this.deps.post({
                                type: "changelistDraftResult",
                                repositoryRoot: this.deps.root,
                                listId: scope,
                                requestId,
                                message:
                                    this.store
                                        .get(this.deps.root)
                                        .lists.find((list) => list.id === scope)?.draft ??
                                    this.store.get(this.deps.root).allDraft ??
                                    "",
                                error: getErrorMessage(error),
                            });
                            throw error;
                        }
                    } else if (message.action === "select")
                        this.store.selectDraft(this.deps.root, scope);
                    else throw new Error("Unknown commit draft action.");
                    if (this.store.mirrorScope(this.deps.root) === scope)
                        this.deps.mirrorDraft?.(scope, this.store.draft(this.deps.root, scope));
                    break;
                }
                case "changelistAction":
                    await this.changeList(message);
                    break;
                case "openPartialChanges":
                    this.open(assertString(message.path, "path"), message.listId);
                    break;
                case "commitChangelist":
                    await this.runCommit(() => this.commitList(message));
                    break;
            }
        } catch (error) {
            this.deps.post({
                type: "error",
                repositoryRoot: this.deps.root,
                message: vscode.l10n.t("Changelist action failed: {message}", {
                    message: getErrorMessage(error),
                }),
            });
        } finally {
            if (loading) this.reconciling--;
            this.post();
        }
    }

    private post(): void {
        try {
            this.deps.post({
                type: "setChangelists",
                repositoryRoot: this.deps.root,
                state: this.store.view(this.deps.root),
                busy:
                    this.reconciling > 0 ||
                    this.committing ||
                    this.store.isCommitting(this.deps.root),
                ...(this.partial.recoveryIssues().length ? { hasRecoveryIssues: true } : {}),
            });
        } catch (error) {
            this.deps.post({
                type: "error",
                repositoryRoot: this.deps.root,
                message: vscode.l10n.t("Changelist action failed: {message}", {
                    message: getErrorMessage(error),
                }),
            });
        }
    }

    /** Hold the metadata lease across Git publication; release failures never invite a duplicate commit. */
    private async runCommit(operation: () => Promise<void>): Promise<void> {
        if (this.committing) throw new Error("A selected commit is already in progress.");
        this.committing = true;
        this.post();
        let release: (() => Promise<void>) | undefined;
        let completed = false;
        try {
            release = await this.store.beginCommit(this.deps.root);
            await this.deps.runCommit(async () => {
                await operation();
                completed = true;
            });
        } finally {
            try {
                await release?.();
            } catch (error) {
                console.error("[IntelliGit] Changelist lease release failed:", error);
                if (completed)
                    this.warnCommitReview(
                        vscode.l10n.t(
                            "Selected commit succeeded, but its selection metadata needs review. Do not retry the commit.",
                        ),
                    );
            }
            this.committing = false;
            this.post();
        }
    }

    /** Validates webview list commands against their captured revision; partial ownership requires the range editor rather than a whole-file move. */
    private async changeList(
        message: Extract<ChangelistOutbound, { type: "changelistAction" }>,
    ): Promise<void> {
        const revision = expectedRevision(message.revision);
        const id =
            message.action === "create" ||
            (message.action === "move" && message.listId === undefined)
                ? ""
                : assertString(message.listId, "listId");
        switch (message.action) {
            case "reviewRecovery":
                await this.reviewRecovery();
                break;
            case "create":
            case "rename":
                await this.editList(message.action, revision, id);
                break;
            case "activate":
                await this.activate(revision, id);
                break;
            case "resetSelection":
                await this.store.resetSelection(
                    this.deps.root,
                    revision,
                    id,
                    assertRepoPathArray(message.paths, "paths"),
                );
                break;
            case "move": {
                const paths = assertRepoPathArray(message.paths, "paths");
                const source = message.sourceListId ?? "all";
                const metadata = this.store.get(this.deps.root);
                if (
                    paths.some(
                        (file) =>
                            metadata.changes[file]?.selections?.[source] !== undefined ||
                            (source !== "all" &&
                                Object.values(metadata.changes[file]?.lines ?? {}).some(
                                    (owner) => owner !== source,
                                )),
                    )
                ) {
                    throw new Error("Move partial selections through their partial editor.");
                }
                const chosen =
                    id ||
                    (
                        await vscode.window.showQuickPick(
                            [
                                ...metadata.lists
                                    .filter((list) => list.id !== source)
                                    .map((list) => ({ label: list.name, id: list.id })),
                                { label: vscode.l10n.t("New changelist"), id: "new" },
                            ],
                            { title: vscode.l10n.t("Move selected changes") },
                        )
                    )?.id;
                if (chosen === "new") await this.editList("create", revision, "", paths);
                else if (chosen)
                    await this.store.moveFiles(this.deps.root, revision, chosen, paths);
                break;
            }
            case "remove":
                await this.removeList(revision, id);
                break;
            default:
                throw new Error("Unknown changelist action.");
        }
    }

    /** Observe existing edits under the old active list before changing only future attribution. */
    private async activate(revision: number, id: string): Promise<void> {
        const before = this.store.get(this.deps.root);
        if (before.revision !== revision) throw new ChangelistRevisionError();
        await this.tracker.reconcile(this.deps.files());
        const latest = this.store.get(this.deps.root);
        // Observation may advance ownership revisions itself. Preserve those writes, but
        // never overwrite another window's intervening active-list choice.
        if (latest.activeId !== before.activeId) throw new ChangelistRevisionError();
        await this.store.activate(this.deps.root, latest.revision, id);
    }

    /** Collects all metadata before a single CAS write, so cancelling any prompt changes nothing. */
    private async editList(
        action: "create" | "rename",
        revision: number,
        id: string,
        movePaths: readonly string[] = [],
    ): Promise<void> {
        const name = await vscode.window.showInputBox({
            title:
                action === "create"
                    ? vscode.l10n.t("New changelist")
                    : vscode.l10n.t("Rename changelist"),
            value:
                action === "rename"
                    ? this.store.get(this.deps.root).lists.find((list) => list.id === id)?.name
                    : "",
            validateInput: (value) =>
                !value.trim() || value.length > 80
                    ? vscode.l10n.t("Enter a changelist name of 1 to 80 characters.")
                    : undefined,
        });
        if (name === undefined) return;
        const description = await vscode.window.showInputBox({
            title: vscode.l10n.t("Changelist description"),
            value:
                action === "rename"
                    ? (this.store.get(this.deps.root).lists.find((list) => list.id === id)
                          ?.description ?? "")
                    : "",
            validateInput: (value) =>
                value.length > 4000 ? vscode.l10n.t("Enter at most 4000 characters.") : undefined,
        });
        if (description === undefined) return;
        if (action === "create") {
            const active = await vscode.window.showQuickPick(
                [
                    {
                        label: vscode.l10n.t("Keep the current active changelist"),
                        active: false,
                    },
                    {
                        label: vscode.l10n.t("Make the new changelist active"),
                        active: true,
                    },
                ],
                { title: vscode.l10n.t("New changelist") },
            );
            if (!active) return;
            await this.store.create(
                this.deps.root,
                revision,
                name,
                description,
                active.active,
                movePaths,
            );
        } else await this.store.edit(this.deps.root, revision, id, name, description);
    }

    /** Names a surviving destination and resolves draft conflicts before removing any metadata. */
    private async removeList(revision: number, id: string): Promise<void> {
        const state = this.store.get(this.deps.root);
        const source = state.lists.find((list) => list.id === id);
        if (!source) throw new Error("The changelist no longer exists.");
        const survivors = state.lists.filter((list) => list.id !== id);
        const target = survivors.length
            ? await vscode.window.showQuickPick(
                  [...survivors]
                      .sort(
                          (a, b) =>
                              Number(b.id === state.activeId) - Number(a.id === state.activeId),
                      )
                      .map((list) => ({ label: list.name, list })),
                  { title: vscode.l10n.t("Move remaining changes to changelist") },
              )
            : undefined;
        if (survivors.length && !target) return;
        let draftChoice: "source" | "target" | "append" | undefined;
        if (source.draft && target?.list.draft) {
            const choice = await vscode.window.showQuickPick(
                [
                    {
                        label: vscode.l10n.t("Append both drafts"),
                        detail: `${target.list.draft}\n\n${source.draft}`,
                        choice: "append" as const,
                    },
                    {
                        label: vscode.l10n.t("Keep destination draft"),
                        detail: target.list.draft,
                        choice: "target" as const,
                    },
                    {
                        label: vscode.l10n.t("Keep removed list's draft"),
                        detail: source.draft,
                        choice: "source" as const,
                    },
                ],
                { title: vscode.l10n.t("Choose the commit draft to preserve") },
            );
            if (!choice) return;
            draftChoice = choice.choice;
        }
        const confirm = await vscode.window.showWarningMessage(
            vscode.l10n.t(
                "Remove {source} and move its changes to {target}? File content and staging are preserved.",
                {
                    source: source.name,
                    target: target?.list.name ?? "Changes",
                },
            ),
            { modal: true },
            vscode.l10n.t("Remove"),
        );
        if (confirm) {
            await this.store.remove(this.deps.root, revision, id, target?.list.id, draftChoice);
            const scope = this.store.mirrorScope(this.deps.root);
            this.deps.mirrorDraft?.(scope, this.store.draft(this.deps.root, scope));
        }
    }

    /** Reviews captured-worktree records; dismissal cannot restore or mutate Git history/index. */
    private async reviewRecovery(): Promise<void> {
        await this.partial.recover();
        const chosen = await vscode.window.showQuickPick(
            this.partial.recoveryIssues().map((issue) => ({
                label: issue.id,
                description: issue.reason,
                detail: issue.commit,
                issue,
            })),
            { title: vscode.l10n.t("Review partial-index recovery") },
        );
        if (!chosen) return;
        if (chosen.issue.kind !== "quarantined" && chosen.issue.kind !== "unreadable") {
            showTimedWarningMessage(chosen.issue.reason);
            return;
        }
        const confirm = await vscode.window.showWarningMessage(
            vscode.l10n.t(
                "Discard this recovery record? Git history, index, worktree and locks will not change.",
            ),
            { modal: true },
            vscode.l10n.t("Discard recovery record"),
        );
        if (confirm) await this.partial.discardRecovery(chosen.issue.id, chosen.issue.location);
    }

    /** Binds a partial editor to its captured list and repository; selections are revalidated against host snapshots before Git mutations. */
    private open(file: string, requestedList: string | undefined): void {
        const listId = requestedList ?? "all";
        new PartialChangesPanel(this.deps.extensionUri, file, {
            load: async (side) => {
                const revision = this.store.get(this.deps.root).revision;
                const view = await this.partial.open(file, side);
                const snapshot = this.partial.snapshot(view.snapshotId);
                if (side === "working") {
                    try {
                        await this.store.track(
                            this.deps.root,
                            view.path,
                            rangeSnapshot(snapshot),
                            revision,
                        );
                    } catch (error) {
                        // A concurrent observer/draft writer need not prevent a read-only load
                        // when the authoritative record already describes these exact bytes.
                        if (
                            !(error instanceof ChangelistRevisionError) ||
                            this.store.get(this.deps.root).changes[view.path]?.contentId !==
                                snapshot.contentId
                        )
                            throw error;
                    }
                }
                const lists = this.store.view(this.deps.root);
                return { file: view, contentId: snapshot.contentId, lists, listId };
            },
            stage: async (selection) => {
                const snapshot = this.assertFileSelection(file, selection);
                const release = await this.store.beginCommit(this.deps.root);
                try {
                    const previous = this.store.get(this.deps.root);
                    const prepared =
                        snapshot.view.side === "working"
                            ? await this.store.prepareStageInclusion(
                                  this.deps.root,
                                  previous.revision,
                                  listId,
                                  {
                                      path: file,
                                      contentId: snapshot.contentId,
                                      lineIds: selection.lineIds,
                                      total: changeIds(snapshot.view.blocks).length,
                                  },
                              )
                            : undefined;
                    try {
                        await this.partial.stage(selection, (files) =>
                            assertChangeBuffersSaved(this.deps.root, files),
                        );
                    } catch (error) {
                        if (prepared)
                            await this.restoreFailedInclusion(
                                error,
                                previous,
                                prepared,
                                listId,
                                [file],
                                snapshot,
                                vscode.l10n.t(
                                    "Selected changes were not staged, but their selection metadata could not be restored. Review the selection before retrying.",
                                ),
                            );
                        throw error;
                    }
                } finally {
                    await release();
                }
                await this.deps.actions.refreshData();
                this.deps.actions.fireWorkingTreeChanged();
            },
            use: async (selection) => {
                const snapshot = this.assertFileSelection(file, selection);
                if (snapshot.view.side !== "working")
                    throw new Error("Use a working-tree selection for the Commit panel.");
                await this.store.recordSelection(
                    this.deps.root,
                    file,
                    snapshot.contentId,
                    listId,
                    selection.lineIds,
                    changeIds(snapshot.view.blocks).length,
                );
            },
            commit: async (selection, message) => {
                const original = this.assertFileSelection(file, selection);
                const selected = new Set(selection.lineIds);
                const fingerprints = new Set(
                    original.view.blocks
                        .flatMap((block) => block.lines)
                        .filter((line) => selected.has(line.id))
                        .map((line) => line.fingerprint),
                );
                let commit = "";
                await this.runCommit(async () => {
                    const previous = this.store.get(this.deps.root);
                    const prepared = await this.store.prepareCommitInclusion(
                        this.deps.root,
                        previous.revision,
                        listId,
                        [
                            {
                                path: file,
                                contentId: original.contentId,
                                lineIds: selection.lineIds,
                                total: changeIds(original.view.blocks).length,
                            },
                        ],
                    );
                    commit = await this.commitWithInclusion(
                        [selection],
                        assertString(message, "message"),
                        (files) => assertChangeBuffersSaved(this.deps.root, files),
                        previous,
                        prepared,
                        listId,
                        [file],
                        original,
                    );
                    await this.consumeSelection([{ path: file, fingerprints }], listId);
                    await this.afterCommit(listId, message);
                });
                return commit;
            },
            assign: async (selection, id, revision) => {
                const snapshot = this.assertFileSelection(file, selection);
                if (snapshot.view.side !== "working")
                    throw new Error("Assign working-tree changes, not index changes.");
                const selected = validateSelection(snapshot.view.blocks, selection.lineIds);
                const lines = snapshot.view.blocks
                    .flatMap((block) => block.lines)
                    .filter((line) => line.kind !== "context");
                await this.store.assignChanges(
                    this.deps.root,
                    expectedRevision(revision),
                    file,
                    snapshot.contentId,
                    assertString(id, "listId"),
                    lines.filter((line) => selected.has(line.id)).map((line) => line.fingerprint),
                    new Set(lines.map((line) => line.fingerprint)),
                );
            },
            openNative: () =>
                showDiffFromPanel(
                    {
                        gitOps: this.deps.gitOps,
                        getWorkspaceRoot: () => vscode.Uri.file(this.deps.root),
                        refreshData: this.deps.actions.refreshData,
                        fireWorkingTreeChanged: this.deps.actions.fireWorkingTreeChanged,
                    },
                    file,
                ),
        });
    }

    private assertFileSelection(file: string, value: SelectedFileChanges) {
        if (
            !value ||
            typeof value.snapshotId !== "string" ||
            !Array.isArray(value.lineIds) ||
            value.lineIds.length > 100_000 ||
            value.lineIds.some((id) => typeof id !== "string")
        ) {
            throw new Error("Invalid partial change selection.");
        }
        const snapshot = this.partial.snapshot(value.snapshotId);
        if (snapshot.view.path !== file)
            throw new Error("The partial editor cannot target another file.");
        validateSelection(snapshot.view.blocks, value.lineIds);
        return snapshot;
    }

    /** Checks list identity and revision, then commits exact whole-file or partial inclusion; stale ranges and partial amend are refused. */
    private async commitList(
        message: Extract<ChangelistOutbound, { type: "commitChangelist" }>,
    ): Promise<void> {
        const paths = assertRepoPathArray(message.paths, "paths");
        const state = this.store.get(this.deps.root);
        if (expectedRevision(message.revision) !== state.revision)
            throw new Error("Changelists changed. Refresh before committing.");
        const id = assertString(message.listId, "listId");
        if (id !== "all" && !state.lists.some((list) => list.id === id))
            throw new Error("Unknown changelist.");
        const hasPartial = paths.some(
            (file) =>
                state.changes[file]?.stale ||
                (id !== "all" && state.changes[file]?.tracking !== undefined) ||
                Object.keys(state.changes[file]?.lines ?? {}).length > 0 ||
                state.changes[file]?.selections?.[id] !== undefined,
        );
        if (!hasPartial) {
            if (id !== "all" && paths.some((file) => state.files[file] !== id))
                throw new Error("The files belong to another changelist.");
            await commitSelectedFromPanel(
                {
                    ...this.deps.actions,
                    postCommitted: () => this.completeDraft(id, message.message),
                },
                {
                    paths,
                    message: assertString(message.message, "message"),
                    amend: message.amend === true,
                    push: message.push === true,
                    rejectActiveOperation: true,
                },
            );
            return;
        }
        if (message.amend)
            throw new Error("Partial amend requires the whole-file commit workflow.");
        if (paths.length > 64) throw new Error("Select 1 to 64 text files.");
        const selections: SelectedFileChanges[] = [];
        let initialSnapshot: PartialFileSnapshot | undefined;
        const inclusions: {
            path: string;
            contentId: string;
            lineIds: string[];
            total: number;
        }[] = [];
        const consumed: { path: string; fingerprints: ReadonlySet<string> }[] = [];
        for (const file of paths) {
            const view = await this.partial.open(file);
            const snapshot = this.partial.snapshot(view.snapshotId);
            initialSnapshot ??= snapshot;
            const ownership = state.changes[file];
            const inclusion = ownership?.selections?.[id];
            if (ownership && (ownership.stale || ownership.contentId !== snapshot.contentId)) {
                throw new Error("Change assignments need review. Reopen the partial editor.");
            }
            if (
                inclusion &&
                (inclusion.reviewRequired || inclusion.contentId !== snapshot.contentId)
            ) {
                throw new Error("The partial selection needs review. Reopen its changes.");
            }
            const included = inclusion
                ? validateSelection(view.blocks, inclusion.lineIds)
                : undefined;
            const fallback = state.files[file] ?? state.activeId;
            const lines = view.blocks
                .flatMap((block) => block.lines)
                .filter(
                    (line) =>
                        line.kind !== "context" &&
                        (!included || included.has(line.id)) &&
                        (id === "all" || (ownership?.lines[line.fingerprint] ?? fallback) === id),
                );
            if (!lines.length) throw new Error("No selected changes belong to this changelist.");
            selections.push({ snapshotId: view.snapshotId, lineIds: lines.map((line) => line.id) });
            inclusions.push({
                path: file,
                contentId: snapshot.contentId,
                lineIds: lines.map((line) => line.id),
                total: changeIds(view.blocks).length,
            });
            consumed.push({
                path: file,
                fingerprints: new Set(lines.map((line) => line.fingerprint)),
            });
        }
        if (this.store.get(this.deps.root).revision !== state.revision)
            throw new Error("Changelists changed during commit preparation.");
        if (!initialSnapshot) throw new Error("Select changes before committing.");
        const prepared = await this.store.prepareCommitInclusion(
            this.deps.root,
            state.revision,
            id,
            inclusions,
        );
        await this.commitWithInclusion(
            selections,
            assertString(message.message, "message"),
            async (files) => {
                if (this.store.get(this.deps.root).revision !== prepared.revision) {
                    throw new Error("Changelists changed during commit preparation.");
                }
                await assertChangeBuffersSaved(this.deps.root, files);
            },
            state,
            prepared,
            id,
            paths,
            initialSnapshot,
        );
        await this.consumeSelection(consumed, id);
        await this.afterCommit(id, message.message);
        if (message.push === true) await runGitOperationFromPanel(this.deps.actions, "push");
    }

    private async commitWithInclusion(
        selections: readonly SelectedFileChanges[],
        message: string,
        guard: (files: readonly string[]) => Promise<void>,
        previous: ChangelistState,
        prepared: ChangelistState,
        scope: string,
        paths: readonly string[],
        snapshot: Pick<PartialFileSnapshot, "root" | "gitDir" | "head" | "ref">,
    ): Promise<string> {
        try {
            return await this.partial.commit(selections, message, guard);
        } catch (error) {
            await this.restoreFailedInclusion(
                error,
                previous,
                prepared,
                scope,
                paths,
                snapshot,
                vscode.l10n.t(
                    "Selected commit was not published, but its selection metadata could not be restored. Review the selection before retrying.",
                ),
            );
            throw error;
        }
    }

    private async restoreFailedInclusion(
        error: unknown,
        previous: ChangelistState,
        prepared: ChangelistState,
        scope: string,
        paths: readonly string[],
        snapshot: Pick<PartialFileSnapshot, "root" | "gitDir" | "head" | "ref">,
        warning: string,
    ): Promise<void> {
        if (
            error instanceof PartialIndexPublicationError ||
            !(await this.partial.canRestoreInclusion(snapshot))
        )
            return;
        try {
            await this.store.restoreCommitInclusion(
                this.deps.root,
                previous,
                prepared,
                scope,
                paths,
            );
        } catch (restoreError) {
            console.error(
                "[IntelliGit] Failed selected action inclusion needs review:",
                restoreError,
            );
            this.warnCommitReview(warning);
        }
    }

    private warnCommitReview(message: string): void {
        try {
            showTimedWarningMessage(message);
            this.deps.post({ type: "error", repositoryRoot: this.deps.root, message });
        } catch (error) {
            console.error(
                "[IntelliGit] Selected commit review warning could not be delivered:",
                error,
            );
        }
    }

    private async consumeSelection(
        files: readonly { path: string; fingerprints: ReadonlySet<string> }[],
        scope: string,
    ): Promise<void> {
        try {
            for (const file of files) {
                const view = await this.partial.open(file.path);
                const snapshot = this.partial.snapshot(view.snapshotId);
                const available = new Set(
                    view.blocks
                        .flatMap((block) => block.lines)
                        .filter((line) => line.kind !== "context")
                        .map((line) => line.fingerprint),
                );
                await this.store.consumeCommitted(
                    this.deps.root,
                    file.path,
                    snapshot.contentId,
                    scope,
                    file.fingerprints,
                    available,
                    changeIds(view.blocks).length,
                    rangeSnapshot(snapshot),
                );
            }
        } catch (error) {
            console.error(
                "[IntelliGit] Selected commit inclusion needs review after completion:",
                error,
            );
            this.warnCommitReview(
                vscode.l10n.t(
                    "Selected commit succeeded, but its selection metadata needs review. Do not retry the commit.",
                ),
            );
        }
    }

    /** Completion consumes only the captured scope's unchanged draft; publication is never retried. */
    private async completeDraft(scope: string, message: string): Promise<void> {
        this.deps.postScopedCommit?.();
        if (this.deps.clearLastCommit?.() === false) return;
        await this.store.clearCommittedDraft(this.deps.root, scope, message);
        if (this.store.mirrorScope(this.deps.root) === scope)
            this.deps.mirrorDraft?.(scope, this.store.draft(this.deps.root, scope));
    }

    /** Settles draft completion and refresh independently after Git succeeds so notification failures cannot turn success into a retryable commit. */
    private async afterCommit(scope?: string, message?: string): Promise<void> {
        const results = await Promise.allSettled([
            scope === undefined
                ? this.deps.actions.postCommitted()
                : this.completeDraft(scope, message ?? ""),
            this.deps.actions.refreshData(),
            this.deps.actions.refreshGraphData?.() ?? Promise.resolve(),
        ]);
        for (const result of results) {
            if (result.status === "rejected")
                console.error("[IntelliGit] Selected commit delivery failed:", result.reason);
        }
        try {
            this.deps.actions.fireWorkingTreeChanged();
        } catch (error) {
            console.error("[IntelliGit] Selected commit refresh failed:", error);
        }
    }
}

function expectedRevision(value: number): number {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid changelist revision.");
    return value;
}
