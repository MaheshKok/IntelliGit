import * as vscode from "vscode";
import path from "node:path";
import { open, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import type { ShelfService } from "../services/shelfService";
import type { SelectedShelfInput } from "../services/shelfSelectedCapture";
import type { GitOps } from "../git/operations";
import { GitExecutor } from "../git/executor";
import type { PartialChanges } from "../git/partialChanges";
import {
    ChangelistRevisionError,
    ChangelistStore,
    TargetOperationLeaseHeldError,
    type TargetOperationLease,
} from "../changes/changelistStore";
import { ShelfWorktreeRemovalCompletedError } from "../shelf/recovery";
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
import { assertRepoRelativePath } from "../utils/fileOps";
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
    /** Root-matching shelf service enables selected save and removal in the standalone editor. */
    shelfService?: ShelfService;
    /** Gives workbench focus back to the view that sent a prompting request. */
    focusView?(): void;
}
type CommitPanelActionDeps = Parameters<typeof commitSelectedFromPanel>[0];

const COMMANDS = new Set([
    "loadChangelists",
    "changelistDraft",
    "changelistAction",
    "openPartialChanges",
    "commitChangelist",
    "saveChangelistShelf",
]);

/** Recognizes only the additive workflow family, leaving existing panel routes unchanged. */
export function isChangeWorkflowCommand(type: string): boolean {
    return COMMANDS.has(type);
}

/** An empty id cannot name one terminal result, so it must never reach the prompt or Git. */
function assertRequestId(value: unknown): string {
    const requestId = assertString(value, "requestId");
    if (!requestId) throw new Error("Expected a non-empty 'requestId'.");
    return requestId;
}

/** The metadata a save plan reads; a range record that names no line owner adds nothing to it. */
function saveIntent(state: ChangelistState): string {
    const files = Object.keys({ ...state.files, ...state.changes }).sort();
    return JSON.stringify([
        state.lists,
        state.activeId,
        state.allDraft ?? "",
        files.map((file) => [
            file,
            state.files[file] ?? state.activeId,
            Object.entries(state.changes[file]?.lines ?? {}).sort(),
            state.changes[file]?.stale === true,
        ]),
    ]);
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
    private retry?: Promise<void>;
    private prune?: {
        scan: Promise<void>;
        paths: readonly string[];
        epoch: number;
        done: Promise<void>;
    };
    private readonly poll: ReturnType<typeof setInterval>;
    private lastRevision = -1;
    private lastPollError?: string;
    private savingShelf = false;
    private readonly shelfRequests = new Map<
        string,
        {
            intent: string;
            result?: Extract<ChangelistReply, { type: "changelistShelfResult" }>;
        }
    >();

    /**
     * Shares metadata through a root-bound Git facade and polls until disposal.
     * Repeated poll failures are reported once per message until a successful read.
     */
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
                const revision = this.store.revision(deps.root);
                this.lastPollError = undefined;
                if (revision !== this.lastRevision) {
                    this.lastRevision = revision;
                    this.post();
                }
            } catch (error) {
                const message = getErrorMessage(error);
                if (message === this.lastPollError) return;
                this.lastPollError = message;
                this.deps.post({
                    type: "error",
                    repositoryRoot: deps.root,
                    message: vscode.l10n.t("Changelist action failed: {message}", { message }),
                });
            }
        }, 1000);
        this.poll.unref();
    }

    /** Releases provider delivery; already-open editors still own their captured root. */
    dispose(): void {
        this.unsubscribe();
        clearInterval(this.poll);
    }

    /**
     * Opens this root's aggregate partial editor after durable state is connected.
     * Path and connection failures reject to the native caller before a panel opens.
     */
    async openFromEditor(file: string): Promise<void> {
        const filePath = assertRepoRelativePath(file);
        await this.connect();
        this.open(filePath, undefined);
    }

    /** Captures the native file's root and metadata revision before any name dialog. */
    async saveFileFromEditor(file: string): Promise<void> {
        const filePath = assertRepoRelativePath(file);
        await this.connect();
        await this.saveScopedShelf({
            type: "saveChangelistShelf",
            repositoryRoot: this.deps.root,
            requestId: randomUUID(),
            revision: this.store.revision(this.deps.root),
            scope: "files",
            listId: "all",
            paths: [filePath],
        });
    }

    /** Durable migration is awaited before host intents can mutate metadata or Git, and before target prompts. */
    private connect(): Promise<void> {
        this.connected ??= this.store
            .observe(
                this.deps.root,
                this.deps.gitOps
                    .getGitDirectories()
                    .then(({ gitDir }) => this.store.connect(this.deps.root, gitDir)),
            )
            .catch((error: unknown) => {
                this.connected = undefined;
                throw error;
            });
        return this.connected;
    }

    /** Target prompts never wait for this observation: their hold refuses its writes and it re-observes after. */
    reconcile(files: readonly WorkingFile[]): Promise<void> {
        return this.observeFiles(files, this.store.observerEpoch(this.deps.root));
    }

    /**
     * Resolves once the latest range pass's prune has run, or has scheduled its retry after a hold
     * refused it. Only tests wait on it: a refresh that waited would keep its file list alive for
     * the whole pass.
     */
    settled(): Promise<void> {
        return this.prune?.done ?? Promise.resolve();
    }

    /** Keeps actions busy through connection and membership updates, never through the range scan. */
    private observeFiles(files: readonly WorkingFile[], epoch: number): Promise<void> {
        return this.startObservation(files, epoch)
            .catch((error: unknown) => this.retryAfterRefusal(error))
            .finally(() => this.post());
    }

    private retryAfterRefusal(error: unknown): void {
        if (!(error instanceof TargetOperationLeaseHeldError)) throw error;
        // A target hold or lease discarded this observation; re-read status once both end.
        // Every refusal before that shares one retry; it clears first so a new hold schedules anew.
        this.retry ??= this.store
            .targetOperationReleased(this.deps.root)
            .then(() => {
                this.retry = undefined;
                const fresh = this.store.observerEpoch(this.deps.root);
                return this.deps.gitOps
                    .getStatus({ withStats: false })
                    .then((latest) => this.observeFiles(latest, fresh));
            })
            .catch((retry: unknown) => this.postFailure(retry));
    }

    private postFailure(error: unknown): void {
        this.deps.post({
            type: "error",
            repositoryRoot: this.deps.root,
            message: vscode.l10n.t("Changelist action failed: {message}", {
                message: getErrorMessage(error),
            }),
        });
    }

    /**
     * Starts the range pass's prune without returning it: a caller waiting on it would keep its
     * whole file list alive through its handlers' scope until the pass ends, and at 10k files
     * every status refresh adds one.
     */
    private async startObservation(files: readonly WorkingFile[], epoch: number): Promise<void> {
        const paths = files.filter((file) => file.status !== "!").map((file) => file.path);
        await this.busyDuring(() => this.connect());
        if (this.store.isCommitting(this.deps.root)) return;
        // The scan opens each modified file in turn, which takes minutes in large repositories,
        // so new files are listed first. Commits and targeted operations keep their own
        // content, revision and hold fences; the second pass prunes what the scan consumed.
        await this.busyDuring(() => this.store.reconcileFiles(this.deps.root, paths, epoch));
        this.pruneAfter(this.tracker.reconcile(files, epoch), paths, epoch);
    }

    /**
     * Refreshes that join one pass share its single prune, run with the paths and epoch of the
     * last refresh that joined that pass. The tracker starts a pass with its last caller's files,
     * so a refresh that lands in the next queued pass never changes this one's prune.
     * No refresh waits on the prune, so the host reports its failure once.
     */
    private pruneAfter(scan: Promise<void>, paths: readonly string[], epoch: number): void {
        const joined = this.prune;
        if (joined?.scan === scan) {
            joined.paths = paths;
            joined.epoch = epoch;
            return;
        }
        const entry = { scan, paths, epoch, done: Promise.resolve() };
        this.prune = entry;
        entry.done = scan
            .then(async () => {
                await this.busyDuring(() =>
                    this.store.reconcileFiles(this.deps.root, entry.paths, entry.epoch),
                );
            })
            .catch((error: unknown) => this.retryAfterRefusal(error))
            .catch((error: unknown) => this.postFailure(error));
    }

    private async busyDuring<T>(work: () => Promise<T>): Promise<T> {
        this.reconciling++;
        try {
            return await work();
        } finally {
            this.reconciling--;
            this.post();
        }
    }

    /** Target prompts wait for the initial load's connection and recovery, never for its observer writes. */
    handle(raw: Record<string, unknown>): Promise<void> {
        return this.dispatch(
            raw,
            raw.type === "loadChangelists" && raw.repositoryRoot === this.deps.root
                ? this.store.observe(
                      this.deps.root,
                      this.connect().then(() => this.partial.recover()),
                  )
                : undefined,
        );
    }

    /** Validates repository identity and keeps initial recovery/loading busy before allowing actions. */
    private async dispatch(
        raw: Record<string, unknown>,
        recovering?: Promise<boolean>,
    ): Promise<void> {
        if (raw.repositoryRoot !== this.deps.root)
            throw new Error("Unknown changelist repository.");
        let loading = raw.type === "loadChangelists";
        const prompting =
            raw.type === "saveChangelistShelf" ||
            (raw.type === "changelistAction" &&
                raw.action !== "activate" &&
                raw.action !== "resetSelection");
        if (loading) this.reconciling++;
        try {
            await this.connect();
            const message = raw as unknown as ChangelistOutbound;
            switch (message.type) {
                case "loadChangelists": {
                    const recovered = await recovering;
                    // Recovery must finish before actions; the range scan below need not.
                    loading = false;
                    this.reconciling--;
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
                case "saveChangelistShelf":
                    await this.saveScopedShelf(message);
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
            // A closing native prompt leaves workbench focus on the editor group, not this view.
            if (prompting) this.deps.focusView?.();
        }
    }

    /** Reports this root's authoritative metadata, cross-host busy state, and recovery needs; read failures stay root-scoped. */
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
        const epoch = this.store.observerEpoch(this.deps.root);
        await this.tracker.reconcile(await this.deps.gitOps.getStatus({ withStats: false }), epoch);
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
        // The range scan may advance ownership revisions while the prompts are open. Preserve
        // those writes, but never apply over an intervening list, active-list or moved-file change.
        const intent = (state: ChangelistState) =>
            JSON.stringify([
                state.lists,
                state.activeId,
                movePaths.map((file) => [state.files[file], state.changes[file]]),
            ]);
        const before = this.store.get(this.deps.root);
        if (before.revision !== revision) throw new ChangelistRevisionError();
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
        const latest = () => {
            const state = this.store.get(this.deps.root);
            if (intent(state) !== intent(before)) throw new ChangelistRevisionError();
            return state.revision;
        };
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
                latest(),
                name,
                description,
                active.active,
                movePaths,
            );
        } else await this.store.edit(this.deps.root, latest(), id, name, description);
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
            /** Tracks loaded working bytes, tolerating a revision race only when authoritative content already matches. */
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
                return {
                    file: view,
                    contentId: snapshot.contentId,
                    lists,
                    listId,
                    selectedOperations: this.deps.shelfService?.repositoryRoot === this.deps.root,
                };
            },
            /** Holds the metadata lease across staging and restores prepared inclusion when an unpublished operation fails. */
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
            selected: (selection, operation) =>
                this.selectedOperation(file, listId, selection, operation),
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

    /** Keeps a scoped request terminal within its originating host, including cancellation and cleanup failure. */
    private async saveScopedShelf(
        message: Extract<ChangelistOutbound, { type: "saveChangelistShelf" }>,
    ): Promise<void> {
        const requestId = assertRequestId(message.requestId);
        const operation = message.operation ?? "save";
        const intent = JSON.stringify([
            message.repositoryRoot,
            message.revision,
            message.scope,
            message.listId,
            message.paths,
            operation,
        ]);
        const previous = this.shelfRequests.get(requestId);
        if (previous) {
            const stale = vscode.l10n.t("This save request is already in progress or stale.");
            this.deps.post(
                previous.intent === intent && previous.result
                    ? previous.result
                    : {
                          type: "changelistShelfResult",
                          repositoryRoot: this.deps.root,
                          requestId,
                          message: stale,
                          error: stale,
                      },
            );
            return;
        }
        const record: {
            intent: string;
            result?: Extract<ChangelistReply, { type: "changelistShelfResult" }>;
        } = { intent };
        this.shelfRequests.set(requestId, record);
        const reply: Extract<ChangelistReply, { type: "changelistShelfResult" }> = {
            type: "changelistShelfResult",
            repositoryRoot: this.deps.root,
            requestId,
            message: vscode.l10n.t("Save cancelled."),
        };
        if (this.savingShelf) {
            reply.error = reply.message = vscode.l10n.t(
                "Another save is in progress. Wait for its result.",
            );
            record.result = reply;
            this.deps.post(reply);
            return;
        }
        this.savingShelf = true;
        try {
            if (!["save", "saveAndRemove", "rollback"].includes(operation))
                throw new Error("Unknown shelf operation.");
            const state = this.store.get(this.deps.root);
            if (
                message.repositoryRoot !== this.deps.root ||
                expectedRevision(message.revision) !== state.revision
            )
                throw new Error("Changelists changed. Refresh before saving.");
            if (message.scope !== "list" && message.scope !== "files")
                throw new Error("Unknown shelf scope.");
            if (message.listId !== "all" && !state.lists.some((list) => list.id === message.listId))
                throw new Error("Unknown changelist.");
            if (message.scope === "list" && message.listId === "all")
                throw new Error("Choose one source changelist.");
            const paths =
                message.scope === "files"
                    ? [...new Set(assertRepoPathArray(message.paths, "paths"))]
                    : undefined;
            if (paths?.length === 0) throw new Error("Select whole files before saving.");
            const source =
                message.scope === "list"
                    ? state.lists.find((list) => list.id === message.listId)!.name
                    : vscode.l10n.t("Selected files");
            const name = await scopedShelfName(operation, source);
            if (name !== undefined) {
                if (saveIntent(this.store.get(this.deps.root)) !== saveIntent(state))
                    throw new Error("Changelists changed during the save prompt.");
                const plan = await this.scopedShelfPlan(state, message.listId, paths, name);
                await this.runScopedShelfOperation(operation, plan, message.listId, state, reply);
            }
        } catch (error) {
            // A failure after Save (for example the preview dialog) must still name the saved shelf.
            reply.error = reply.message = reply.shelfId
                ? vscode.l10n.t("Shelf {shelfId} is retained. {reason}", {
                      shelfId: reply.shelfId,
                      reason: getErrorMessage(error),
                  })
                : getErrorMessage(error);
        } finally {
            this.savingShelf = false;
            record.result = reply;
        }
        this.deps.post(reply);
        if (reply.error || reply.shelfId) {
            // Notification dismissal or delivery failure cannot delay or replace the terminal result.
            void Promise.resolve()
                .then(() =>
                    reply.error
                        ? vscode.window.showWarningMessage(reply.message)
                        : vscode.window.showInformationMessage(reply.message),
                )
                .catch(() => undefined);
        }
    }

    /** Resolves list membership independently of commit inclusion; explicit paths always capture whole files. */
    private async scopedShelfPlan(
        state: ChangelistState,
        scope: string,
        requested: string[] | undefined,
        name: string,
    ): Promise<SelectedShelfInput> {
        const status = await this.deps.gitOps.getStatus({ withStats: false });
        const changed = [
            ...new Set(status.filter((file) => file.status !== "!").map((file) => file.path)),
        ];
        const paths =
            requested ??
            changed.filter((file) => {
                const ranges = state.changes[file];
                return (
                    (state.files[file] ?? state.activeId) === scope ||
                    Object.values(ranges?.lines ?? {}).includes(scope)
                );
            });
        if (!paths.length || paths.some((file) => !changed.includes(file)))
            throw new Error("Select changed files before saving.");
        const baseCommit = (
            await new GitExecutor(this.deps.root).run(["rev-parse", "--verify", "HEAD"])
        ).trim();
        const plan: SelectedShelfInput = {
            name,
            scope: requested ? "files" : "list",
            baseCommit,
            sourceLists: [],
            scopeDraft: this.store.draft(this.deps.root, scope),
            selected: [],
            whole: [],
        };
        const selected: SelectedShelfInput["selected"][number][] = [];
        const whole: SelectedShelfInput["whole"][number][] = [];
        const sourceIds = new Set<string>();
        for (const file of paths) {
            const tracking = state.changes[file];
            if (tracking?.stale) throw new Error("Change assignments need review before saving.");
            const fallback = state.files[file] ?? state.activeId;
            if (!tracking || tracking.totalChanges === 0) {
                if (requested || fallback === scope) {
                    whole.push({ path: file, sourceListIds: [fallback] });
                    sourceIds.add(fallback);
                }
                continue;
            }
            const view = await this.partial.open(file);
            const snapshot = this.partial.snapshot(view.snapshotId);
            if (snapshot.contentId !== tracking.contentId)
                throw new Error("Source changes changed. Reopen their assignments.");
            const lines = view.blocks
                .flatMap((block) => block.lines)
                .filter(
                    (line) =>
                        line.kind !== "context" &&
                        (requested || (tracking.lines[line.fingerprint] ?? fallback) === scope),
                );
            if (!lines.length) continue;
            const owners = Object.fromEntries(
                lines.map((line) => [
                    line.fingerprint,
                    tracking.lines[line.fingerprint] ?? fallback,
                ]),
            );
            const ids = [...new Set(Object.values(owners))];
            ids.forEach((id) => sourceIds.add(id));
            if (requested)
                whole.push({ path: file, sourceListIds: ids, ownership: { snapshot, owners } });
            else {
                const lineIds = lines.map((line) => line.id);
                const patch = await this.partial.exportPatch(
                    { snapshotId: view.snapshotId, lineIds },
                    (files) => assertChangeBuffersSaved(this.deps.root, files),
                );
                selected.push({ snapshot, owners, lineIds, patch });
            }
        }
        if (!selected.length && !whole.length) throw new Error("No owned changes to save.");
        return {
            ...plan,
            selected,
            whole,
            sourceLists: state.lists
                .filter((list) => sourceIds.has(list.id))
                .map((list) => ({
                    id: list.id,
                    name: list.name,
                    description: list.description ?? "",
                    draft: list.draft ?? "",
                })),
        };
    }

    /** Revalidates under the actual lease and preserves the saved identity across cleanup errors. */
    private async publishScopedShelf(
        plan: SelectedShelfInput,
        before: ChangelistState,
        scope: string,
    ): Promise<string> {
        const service = this.deps.shelfService;
        if (!service || service.repositoryRoot !== this.deps.root)
            throw new Error("A shelf service for this repository is unavailable.");
        const lease = await this.store.acquireTargetOperationLease(this.deps.root);
        let savedId: string | undefined;
        let primary: Error | undefined;
        try {
            // The range scan may record ranges while the plan's Git reads run. The lease now blocks
            // every other write, so save against the latest revision only if the plan's view held.
            const latest = this.store.get(this.deps.root);
            if (saveIntent(latest) !== saveIntent(before))
                throw new Error("Changelists changed. Reopen the selected changes.");
            const result = await service.saveSelectedChanges(
                plan,
                lease,
                latest.revision,
                scope,
                (files) => assertChangeBuffersSaved(this.deps.root, files),
            );
            savedId = result.shelfId;
            if (!savedId) throw new Error("The shelf was not durably saved.");
            return savedId;
        } catch (error) {
            primary =
                error instanceof Error
                    ? error
                    : new Error(getErrorMessage(error), { cause: error });
            throw primary;
        } finally {
            try {
                await lease.release();
            } catch (error) {
                if (primary !== undefined) throw primary;
                if (savedId)
                    throw new Error(
                        `Shelf ${savedId} was saved. Metadata release failed; do not repeat the save. ${getErrorMessage(error)}`,
                        { cause: error },
                    );
                throw error;
            }
        }
    }

    /** Captures names, drafts and selected fingerprint owners before acquiring any mutation lock. */
    private selectedShelfPlan(
        snapshot: PartialFileSnapshot,
        selection: SelectedFileChanges,
        scope: string,
        name: string,
        patch: Buffer,
    ): SelectedShelfInput {
        const state = this.store.get(this.deps.root);
        const selected = validateSelection(snapshot.view.blocks, selection.lineIds);
        const owners = Object.fromEntries(
            snapshot.view.blocks
                .flatMap((block) => block.lines)
                .filter((line) => selected.has(line.id))
                .map((line) => [
                    line.fingerprint,
                    state.changes[snapshot.view.path]?.lines[line.fingerprint] ??
                        state.files[snapshot.view.path] ??
                        state.activeId,
                ]),
        );
        const ids = new Set(Object.values(owners));
        return {
            name,
            scope: "selection",
            baseCommit: snapshot.head,
            scopeDraft: this.store.draft(this.deps.root, scope),
            sourceLists: state.lists
                .filter((list) => ids.has(list.id))
                .map((list) => ({
                    id: list.id,
                    name: list.name,
                    description: list.description ?? "",
                    draft: list.draft ?? "",
                })),
            selected: [{ snapshot, lineIds: [...selection.lineIds], patch, owners }],
            whole: [],
        };
    }

    /** Save is durable before optional confirmation; browser messages never supply patch bytes or a destination. */
    private async selectedOperation(
        file: string,
        scope: string,
        selection: SelectedFileChanges,
        operation: "save" | "shelve" | "rollback" | "export",
    ): Promise<{ message: string; removed: boolean }> {
        const snapshot = this.assertFileSelection(file, selection);
        const shelf = this.deps.shelfService;
        if (!shelf || shelf.repositoryRoot !== this.deps.root)
            throw new Error("A shelf service for this repository is unavailable.");
        const guard = (files: readonly string[]) => assertChangeBuffersSaved(this.deps.root, files);
        if (operation === "export") {
            return this.exportSelectedPatch(snapshot, selection);
        }
        if (operation !== "save" && snapshot.view.side !== "working")
            throw new Error("Selected removal requires working-tree changes.");
        const name =
            operation === "rollback"
                ? vscode.l10n.t("Before selected rollback: {file}", {
                      file: path.basename(file).slice(0, 40),
                  })
                : await vscode.window.showInputBox({
                      title: vscode.l10n.t("Shelf selected changes"),
                      value: path.basename(file),
                  });
        if (name === undefined)
            return { message: vscode.l10n.t("Save cancelled."), removed: false };
        const revision = this.store.get(this.deps.root).revision;
        const patch = await this.partial.exportPatch(selection, guard);
        const plan = this.selectedShelfPlan(snapshot, selection, scope, name, patch);
        if (operation === "rollback" && !(await this.confirmSelectedRemoval(plan, true)))
            return { message: vscode.l10n.t("Rollback cancelled."), removed: false };
        const lease = await this.store.acquireTargetOperationLease(this.deps.root);
        let shelfId: string | undefined;
        let saveFailure: Error | undefined;
        try {
            const result = await shelf.saveSelectedChanges(plan, lease, revision, scope, guard);
            shelfId = result.shelfId;
            if (!shelfId) throw new Error("The selected shelf was not durably saved.");
        } catch (error) {
            saveFailure =
                error instanceof Error
                    ? error
                    : new Error(getErrorMessage(error), { cause: error });
            throw saveFailure;
        } finally {
            try {
                await lease.release();
            } catch (error) {
                if (saveFailure !== undefined) throw saveFailure;
                if (shelfId)
                    throw new Error(
                        `Shelf ${shelfId} was saved. Metadata release failed; do not repeat the save. ${getErrorMessage(error)}`,
                        { cause: error },
                    );
                throw error;
            }
        }
        if (operation !== "save") {
            if (operation === "shelve" && !(await this.confirmSelectedRemoval(plan, false)))
                return {
                    message: vscode.l10n.t("Removal cancelled. Shelf {shelfId} is retained.", {
                        shelfId,
                    }),
                    removed: false,
                };
            return this.removeSavedSelection(plan, selection, scope, revision, shelfId);
        }
        return {
            message: vscode.l10n.t("Selected changes saved in shelf {shelfId}.", { shelfId }),
            removed: false,
        };
    }

    /** The native picker grants only an output file; source aliases and Git internals cannot be overwritten. */
    private async exportSelectedPatch(
        snapshot: PartialFileSnapshot,
        selection: SelectedFileChanges,
    ): Promise<{ message: string; removed: boolean }> {
        const destination = await vscode.window.showSaveDialog({ filters: { Patch: ["patch"] } });
        if (!destination)
            return { message: vscode.l10n.t("Patch export cancelled."), removed: false };
        if (destination.scheme !== "file") throw new Error("Choose a local patch file.");
        const target = path.join(
            await realpath(path.dirname(destination.fsPath)),
            path.basename(destination.fsPath),
        );
        const source = path.join(snapshot.root, snapshot.view.path);
        if (
            target === source ||
            [snapshot.gitDir, snapshot.commonDir].some(
                (directory) => target === directory || target.startsWith(`${directory}${path.sep}`),
            )
        )
            throw new Error("Export to a separate patch file outside Git metadata.");
        const guard = (files: readonly string[]) => assertChangeBuffersSaved(this.deps.root, files);
        const patch = await this.partial.exportPatch(selection, guard);
        const handle = await open(
            target,
            constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW,
            0o600,
        );
        try {
            const output = await handle.stat();
            const protectedFiles = await Promise.all([stat(source), stat(snapshot.indexPath)]);
            if (
                !output.isFile() ||
                output.nlink > 1 ||
                protectedFiles.some((file) => file.dev === output.dev && file.ino === output.ino)
            )
                throw new Error("Export to a separate regular patch file.");
            await this.partial.validate(selection, guard);
            await handle.truncate(0);
            await handle.writeFile(patch);
        } finally {
            await handle.close();
        }
        return { message: vscode.l10n.t("Selected patch exported."), removed: false };
    }

    /** Presents the exact captured diff and selection counts outside every metadata/Git/store lock. */
    private async confirmSelectedRemoval(
        plan: SelectedShelfInput,
        rollback: boolean,
    ): Promise<boolean> {
        let ranges = 0;
        let lines = 0;
        for (const entry of plan.selected) {
            const ids = new Set(entry.lineIds);
            lines += ids.size;
            for (const block of entry.snapshot.view.blocks) {
                let selected = false;
                for (const line of block.lines) {
                    const next = ids.has(line.id);
                    if (next && !selected) ranges++;
                    selected = next;
                }
            }
        }
        const action = rollback
            ? vscode.l10n.t("Rollback Selected Changes")
            : vscode.l10n.t("Remove Selected Changes");
        return (
            (await vscode.window.showWarningMessage(
                rollback
                    ? vscode.l10n.t(
                          "Roll back the selected changes? An independent recovery shelf will be kept.",
                      )
                    : vscode.l10n.t("Remove the saved selected changes? The shelf will be kept."),
                {
                    modal: true,
                    detail: [
                        vscode.l10n.t(
                            "{files} file(s), {ranges} selected range(s), {lines} changed line(s)",
                            { files: plan.selected.length + plan.whole.length, ranges, lines },
                        ),
                        ...plan.whole.map((entry) =>
                            // The preview renders only bytes captured into the plan; nothing is re-read after confirmation.
                            entry.ownership
                                ? [
                                      vscode.l10n.t(
                                          "{path}: whole file, including staged changes",
                                          { path: entry.path },
                                      ),
                                      ...entry.ownership.snapshot.view.blocks.flatMap((block) => [
                                          `@@ -${block.oldStart},${block.oldCount} +${block.newStart},${block.newCount} @@`,
                                          ...block.lines.map(
                                              (line) => `${DIFF_PREFIX[line.kind]}${line.text}`,
                                          ),
                                      ]),
                                  ].join("\n")
                                : vscode.l10n.t(
                                      "{path}: whole file (binary, untracked or structural change; no text diff was captured)",
                                      { path: entry.path },
                                  ),
                        ),
                        ...plan.selected.map((entry) => entry.patch.toString("utf8")),
                    ].join("\n\n"),
                },
                action,
            )) === action
        );
    }

    /** Reacquires metadata only after confirmation; completed removals remain terminal through cleanup failures. */
    private async removeSavedSelection(
        plan: SelectedShelfInput,
        selection: SelectedFileChanges,
        scope: string,
        revision: number,
        shelfId: string,
    ): Promise<{ message: string; removed: boolean }> {
        let completed = false;
        let failure: unknown;
        let lease: TargetOperationLease | undefined;
        try {
            lease = await this.store.acquireTargetOperationLease(this.deps.root);
            await this.deps.shelfService!.removeSelectedChanges(
                plan,
                selection,
                this.partial,
                lease,
                revision,
                scope,
                (files) => assertChangeBuffersSaved(this.deps.root, files),
            );
            completed = true;
            await this.consumeRemovedSelection(plan, scope, lease);
        } catch (error) {
            completed ||= error instanceof ShelfWorktreeRemovalCompletedError;
            failure = error;
        } finally {
            if (lease) {
                try {
                    await lease.release();
                } catch (error) {
                    failure ??= error;
                }
            }
        }
        if (failure) {
            if (!completed)
                throw new Error(
                    `Shelf ${shelfId} is retained. Selected removal did not complete: ${getErrorMessage(failure)}`,
                    { cause: failure },
                );
            return {
                message: vscode.l10n.t(
                    "Selected removal completed. Shelf {shelfId} is retained. Review recovery and metadata; do not repeat removal. {reason}",
                    { shelfId, reason: getErrorMessage(failure) },
                ),
                removed: true,
            };
        }
        try {
            await this.deps.actions.refreshData();
            this.deps.actions.fireWorkingTreeChanged();
        } catch (error) {
            return {
                message: vscode.l10n.t(
                    "Selected removal completed. Shelf {shelfId} is retained. Refresh failed; do not repeat removal. {reason}",
                    { shelfId, reason: getErrorMessage(error) },
                ),
                removed: true,
            };
        }
        return {
            message: vscode.l10n.t(
                "Selected changes removed. Recovery shelf {shelfId} is retained.",
                { shelfId },
            ),
            removed: true,
        };
    }

    /** Plain Save never removes; Save and Remove saves before its preview; Rollback confirms before its recovery save. */
    private async runScopedShelfOperation(
        operation: "save" | "saveAndRemove" | "rollback",
        plan: SelectedShelfInput,
        scope: string,
        before: ChangelistState,
        reply: Extract<ChangelistReply, { type: "changelistShelfResult" }>,
    ): Promise<void> {
        if (operation === "rollback" && !(await this.confirmSelectedRemoval(plan, true))) {
            reply.message = vscode.l10n.t("Rollback cancelled. Nothing was saved or removed.");
            return;
        }
        reply.shelfId = await this.publishScopedShelf(plan, before, scope);
        reply.message = vscode.l10n.t("Shelf {shelfId} was saved. Local changes are unchanged.", {
            shelfId: reply.shelfId,
        });
        if (operation === "saveAndRemove" && !(await this.confirmSelectedRemoval(plan, false)))
            reply.message = vscode.l10n.t(
                "Removal cancelled. Shelf {shelfId} is retained. Local changes are unchanged.",
                { shelfId: reply.shelfId },
            );
        else if (operation !== "save") {
            const removal = await this.removeScopedPlan(plan, scope, before, reply.shelfId);
            reply.message = removal.message;
            if (removal.failed) reply.error = removal.message;
        }
    }

    /** Reacquires metadata only after confirmation; names exact completed and retained paths instead of offering a repeatable removal. */
    private async removeScopedPlan(
        plan: SelectedShelfInput,
        scope: string,
        before: ChangelistState,
        shelfId: string,
    ): Promise<{ message: string; failed: boolean }> {
        let result: Awaited<ReturnType<ShelfService["removeScopedChanges"]>> | undefined;
        let failure: unknown;
        let lease: TargetOperationLease | undefined;
        try {
            lease = await this.store.acquireTargetOperationLease(this.deps.root);
            // As in Save: a scan may have moved the revision; remove only if the plan's view held.
            const latest = this.store.get(this.deps.root);
            if (saveIntent(latest) !== saveIntent(before))
                throw new Error("Changelists changed. Reopen the selected changes.");
            result = await this.deps.shelfService!.removeScopedChanges(
                plan,
                shelfId,
                this.partial,
                lease,
                latest.revision,
                scope,
                (files) => assertChangeBuffersSaved(this.deps.root, files),
            );
            if (result.completedPaths.length)
                await this.consumeRemovedSelection(plan, scope, lease, result.completedPaths);
        } catch (error) {
            failure = error;
        } finally {
            if (lease) {
                try {
                    await lease.release();
                } catch (error) {
                    failure ??= error;
                }
            }
        }
        if (!result)
            return {
                failed: true,
                message: vscode.l10n.t(
                    "Shelf {shelfId} is retained. Removal was refused: {reason}",
                    {
                        shelfId,
                        reason: getErrorMessage(failure),
                    },
                ),
            };
        if (result.completedPaths.length) {
            try {
                await this.deps.actions.refreshData();
                this.deps.actions.fireWorkingTreeChanged();
            } catch (error) {
                failure ??= error;
            }
        }
        const removed = result.completedPaths.join(", ") || vscode.l10n.t("none");
        const reason =
            result.error ?? (failure === undefined ? undefined : getErrorMessage(failure));
        if (reason === undefined)
            return {
                failed: false,
                message: vscode.l10n.t("Removed: {removed}. Shelf {shelfId} is retained.", {
                    removed,
                    shelfId,
                }),
            };
        return {
            failed: true,
            message: vscode.l10n.t(
                "Shelf {shelfId} is retained. Removed: {removed}. Not removed: {retained}. Do not repeat removal; review the remaining changes and their assignments. {reason}",
                {
                    shelfId,
                    removed,
                    retained: result.retainedPaths.join(", ") || vscode.l10n.t("none"),
                    reason,
                },
            ),
        };
    }

    /** Reconciles surviving anchors and consumes only completed captured paths under the same real metadata lease. */
    private async consumeRemovedSelection(
        plan: SelectedShelfInput,
        scope: string,
        lease: TargetOperationLease,
        completed?: readonly string[],
    ): Promise<void> {
        const entries = [
            ...plan.selected.map((entry) => ({
                file: entry.snapshot.view.path,
                owners: entry.owners,
            })),
            // Whole-file entries without range evidence have no line owners to consume.
            ...plan.whole.flatMap((entry) =>
                entry.ownership ? [{ file: entry.path, owners: entry.ownership.owners }] : [],
            ),
        ].filter((entry) => !completed || completed.includes(entry.file));
        for (const { file, owners } of entries) {
            const view = await this.partial.open(file);
            const snapshot = this.partial.snapshot(view.snapshotId);
            const available = new Set(
                view.blocks
                    .flatMap((block) => block.lines)
                    .filter((line) => line.kind !== "context")
                    .map((line) => line.fingerprint),
            );
            await this.store.consumeCommitted(
                this.deps.root,
                file,
                snapshot.contentId,
                scope,
                new Set(Object.keys(owners)),
                available,
                changeIds(view.blocks).length,
                rangeSnapshot(snapshot),
                lease,
            );
        }
    }

    /** Keeps exact inclusion and ownership fences while obtaining review for stale structural files. */
    private async reviewCommitPaths(
        paths: readonly string[],
        state: ChangelistState,
        id: string,
        amend: boolean,
    ): Promise<"partial" | "whole" | "cancelled"> {
        const structural = new Map<string, WorkingFile>();
        let structuralStatus: WorkingFile[] = [];
        if (paths.some((file) => state.changes[file]?.stale)) {
            const status = await this.deps.gitOps.getStatus({ withStats: false });
            for (const file of status) {
                if (
                    paths.includes(file.path) &&
                    state.changes[file.path]?.stale &&
                    (file.status === "D" || file.status === "R")
                )
                    structural.set(file.path, file);
            }
            structuralStatus = status.filter((file) => structural.has(file.path));
        }
        const hasPartial = paths.some(
            (file) =>
                state.changes[file]?.selections?.[id] !== undefined ||
                (!structural.has(file) &&
                    (state.changes[file]?.stale ||
                        (id !== "all" && state.changes[file]?.tracking !== undefined) ||
                        Object.keys(state.changes[file]?.lines ?? {}).length > 0)),
        );
        if (
            structural.size &&
            (hasPartial ||
                [...structural.values()].some(
                    ({ sourcePath }) =>
                        sourcePath && state.changes[sourcePath]?.selections?.[id] !== undefined,
                ))
        )
            throw new Error(
                vscode.l10n.t("Commit partial text and structural changes separately."),
            );
        if (hasPartial) {
            if (amend) throw new Error("Partial amend requires the whole-file commit workflow.");
            if (paths.length > 64) throw new Error("Select 1 to 64 text files.");
            return "partial";
        }
        if (id !== "all" && paths.some((file) => state.files[file] !== id))
            throw new Error("The files belong to another changelist.");
        if (!structural.size) return "whole";
        if (
            id !== "all" &&
            [...structural.values()].some((file) =>
                [file.path, ...(file.sourcePath ? [file.sourcePath] : [])].some(
                    (name) =>
                        (state.files[name] !== undefined && state.files[name] !== id) ||
                        Object.values(state.changes[name]?.lines ?? {}).some(
                            (owner) => owner !== id,
                        ),
                ),
            )
        )
            throw new Error("The files belong to another changelist.");
        const confirmLabel = vscode.l10n.t("Commit Whole Files");
        const confirm = await vscode.window.showWarningMessage(
            vscode.l10n.t(
                "These deleted or renamed files have stale change assignments. Commit their complete changes?",
            ),
            { modal: true, detail: paths.join("\n") },
            confirmLabel,
        );
        if (confirm !== confirmLabel) return "cancelled";
        const latest = await this.deps.gitOps.getStatus({ withStats: false });
        if (
            this.store.get(this.deps.root).revision !== state.revision ||
            JSON.stringify(latest.filter((file) => structural.has(file.path))) !==
                JSON.stringify(structuralStatus)
        )
            throw new Error("Changelists changed. Refresh before committing.");
        return "whole";
    }

    /** Whole-owned tracked text uses exact transaction fences without manufacturing partial inclusion. */
    private async tryCommitWholeOwned(
        paths: readonly string[],
        state: ChangelistState,
        id: string,
        message: Extract<ChangelistOutbound, { type: "commitChangelist" }>,
    ): Promise<boolean> {
        if (
            id === "all" ||
            message.amend === true ||
            !paths.length ||
            !paths.every((file) => {
                const ownership = state.changes[file];
                return (
                    ownership?.tracking &&
                    !ownership.stale &&
                    ownership.selections?.[id] === undefined
                );
            })
        )
            return false;
        const consumed: { path: string; fingerprints: ReadonlySet<string> }[] = [];
        const commit = await this.partial.tryCommitWholeFiles(
            paths,
            assertString(message.message, "message"),
            (snapshot) => {
                const file = snapshot.view.path;
                const ownership = state.changes[file];
                if (ownership.contentId !== snapshot.contentId)
                    throw new Error("Change assignments need review. Reopen the partial editor.");
                const fallback = state.files[file] ?? state.activeId;
                const lines = snapshot.view.blocks
                    .flatMap((block) => block.lines)
                    .filter((line) => line.kind !== "context");
                if (
                    !lines.length ||
                    lines.some((line) => (ownership.lines[line.fingerprint] ?? fallback) !== id)
                )
                    return false;
                consumed.push({
                    path: file,
                    fingerprints: new Set(lines.map((line) => line.fingerprint)),
                });
                return true;
            },
            async (files) => {
                if (this.store.get(this.deps.root).revision !== state.revision)
                    throw new Error("Changelists changed during commit preparation.");
                await assertChangeBuffersSaved(this.deps.root, files);
            },
        );
        if (commit === undefined) return false;
        await this.consumeSelection(consumed, id);
        await this.afterCommit(id, message.message);
        if (message.push === true) await runGitOperationFromPanel(this.deps.actions, "push");
        return true;
    }

    /** Checks list/revision and exact inclusion; stale structural files require review, while tracked text keeps snapshot fences. */
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
        if (await this.tryCommitWholeOwned(paths, state, id, message)) return;
        const route = await this.reviewCommitPaths(paths, state, id, message.amend === true);
        if (route === "cancelled") return;
        if (route === "whole") {
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
            if (state.changes[file]?.stale)
                throw new Error("Change assignments need review. Reopen the partial editor.");
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

    /** Removes consumed ownership against fresh remaining changes; cleanup failure requests review without undoing the commit. */
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

const DIFF_PREFIX = { add: "+", remove: "-", context: " " } as const;

function expectedRevision(value: number): number {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid changelist revision.");
    return value;
}

/** Rollback's recovery shelf is not a named save, so it never prompts for a name. */
async function scopedShelfName(operation: string, source: string): Promise<string | undefined> {
    if (operation === "rollback")
        return vscode.l10n.t("Before rollback: {source}", { source: source.slice(0, 40) });
    return vscode.window.showInputBox({ title: vscode.l10n.t("Save to Shelf"), value: source });
}
