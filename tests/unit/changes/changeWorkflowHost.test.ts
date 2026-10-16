import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
    createCommitInfoVscodeDouble,
    createFakeExtensionUri,
} from "../../visual/recorder/commitInfoVscodeDouble";
vi.mock("vscode", () => {
    const double = createCommitInfoVscodeDouble();
    Object.defineProperty(double, "ProgressLocation", {
        value: { Notification: 15 },
        configurable: true,
    });
    Object.defineProperty(double.workspace, "textDocuments", { value: [] });
    Object.defineProperty(double.workspace, "notebookDocuments", { value: [] });
    Object.defineProperty(double.window, "showWarningMessage", {
        value: vi.fn().mockResolvedValue(undefined),
        configurable: true,
    });
    Object.defineProperty(double.window, "showQuickPick", {
        value: vi.fn().mockResolvedValue(undefined),
        configurable: true,
    });
    Object.defineProperty(double.window, "showInformationMessage", {
        value: vi.fn().mockResolvedValue(undefined),
    });
    Object.defineProperty(double.window, "withProgress", {
        value: async (_options: unknown, task: () => Promise<unknown>) => task(),
    });
    Object.defineProperty(double.l10n, "t", {
        value: (message: string, values: Record<string, string> = {}) =>
            message.replace(/\{([^}]+)\}/g, (match, key: string) => values[key] ?? match),
    });
    return double;
});
import { ChangeWorkflowHost } from "../../../src/views/ChangeWorkflowHost";
import { ChangelistStore } from "../../../src/changes/changelistStore";
import { ChangelistPersistence } from "../../../src/changes/changelistPersistence";
import { ChangeRangeTracker } from "../../../src/changes/changeRangeTracker";
import { PartialChanges } from "../../../src/git/partialChanges";
import { PartialIndexPublicationError } from "../../../src/git/partialIndexTransaction";
import * as vscode from "vscode";
import { GitExecutor } from "../../../src/git/executor";
import { GitOps } from "../../../src/git/operations";
import { changeIds } from "../../../src/changes/selection";
import {
    getCreatedWebviewPanels,
    resetCreatedWebviewPanelsForTests,
} from "../../visual/recorder/webviewPanelDouble";
import { removeScratchDirectories } from "../../helpers/scratchDirectories";
import type { PartialEditorReply } from "../../../src/webviews/protocol/changelists";

let root: string;
let gitOps: GitOps;
let host: ChangeWorkflowHost;
let hostDeps: ConstructorParameters<typeof ChangeWorkflowHost>[0];
let store: ChangelistStore;
let posted: unknown[];
let baselineHead: string;
let persistenceFailure: "none" | "before" | "after";
let values: Map<string, unknown>;
let storage: {
    get<T>(key: string): T | undefined;
    update(key: string, value: unknown): Promise<void>;
};
const base = Array.from({ length: 100 }, (_, i) => `line ${i}\n`).join("");
const first = base.replace("line 20\n", "selected\n");
const working = first.replace("line 80\n", "remaining\n");
const delivered = vi.fn();
function git(args: string[]) {
    return execFileSync("git", args, { cwd: root, encoding: "utf8" });
}
beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "intelligit-change-host-"));
    git(["init", "-q"]);
    git(["config", "user.name", "Host"]);
    git(["config", "user.email", "host@example.invalid"]);
    git(["config", "commit.gpgSign", "false"]);
    await writeFile(path.join(root, "file.txt"), base);
    git(["add", "--", "file.txt"]);
    git(["commit", "-qm", "base"]);
    baselineHead = git(["rev-parse", "HEAD"]);
    persistenceFailure = "none";
    const persist = ChangelistPersistence.prototype.write;
    vi.spyOn(ChangelistPersistence.prototype, "write").mockImplementation(async function (
        this: ChangelistPersistence,
        state,
    ) {
        if (
            persistenceFailure === "before" ||
            (persistenceFailure === "after" && git(["rev-parse", "HEAD"]) !== baselineHead)
        )
            throw new Error("injected metadata storage failure");
        return persist.call(this, state);
    });
    await writeFile(path.join(root, "file.txt"), working);
    gitOps = new GitOps(new GitExecutor(root));
    values = new Map<string, unknown>();
    storage = {
        get: <T>(key: string) => values.get(key) as T | undefined,
        update: async (key: string, value: unknown) => {
            if (
                persistenceFailure === "before" ||
                (persistenceFailure === "after" && git(["rev-parse", "HEAD"]) !== baselineHead)
            )
                throw new Error("injected metadata storage failure");
            values.set(key, structuredClone(value));
        },
    };
    store = ChangelistStore.forStorage(storage);
    const files = await gitOps.getStatus({ withStats: false });
    posted = [];
    delivered.mockClear();
    resetCreatedWebviewPanelsForTests();
    hostDeps = {
        root,
        extensionUri: createFakeExtensionUri(),
        gitOps,
        workspaceState: storage,
        files: () => files,
        post: (message) => posted.push(message),
        actions: {
            gitOps,
            refreshData: async () => undefined,
            postCommitted: delivered,
            fireWorkingTreeChanged: () => undefined,
            maybeOfferPublishBranch: async () => undefined,
        },
        postScopedCommit: delivered,
        runCommit: (operation) => operation(),
    };
    host = new ChangeWorkflowHost(hostDeps);
    await host.reconcile(files);
});
afterEach(async () => {
    vi.restoreAllMocks();
    (vscode.workspace.textDocuments as vscode.TextDocument[]).length = 0;
    host?.dispose();
    for (const panel of getCreatedWebviewPanels()) panel.dispose();
    resetCreatedWebviewPanelsForTests();
    await removeScratchDirectories(root);
});
async function partialEditor() {
    await host.handle({ type: "openPartialChanges", repositoryRoot: root, path: "file.txt" });
    const panel = getCreatedWebviewPanels()[0];
    const messages: PartialEditorReply[] = [];
    panel.webview.postMessage = (message: unknown) => {
        messages.push(message as PartialEditorReply);
        return Promise.resolve(true);
    };
    await panel.receiveMessage({ type: "ready" });
    const data = messages.find((message) => message.type === "partialFile");
    if (!data || data.type !== "partialFile") throw new Error("Missing partial snapshot");
    return {
        panel,
        messages,
        selection: {
            snapshotId: data.file.snapshotId,
            lineIds: changeIds(data.file.blocks.slice(0, 1)),
        },
    };
}

describe("root-bound selected-change host", () => {
    it("reports each persistent poll failure once and reports it again after recovery", async () => {
        host.dispose();
        vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
        try {
            host = new ChangeWorkflowHost(hostDeps);
            await host.reconcile(hostDeps.files());
            vi.advanceTimersByTime(1000);
            posted.length = 0;
            let failure: string | undefined;
            const get = store.get.bind(store);
            const reads = vi.spyOn(store, "get").mockImplementation((repositoryRoot) => {
                if (failure) throw new Error(failure);
                return get(repositoryRoot);
            });
            reads.mockImplementationOnce(() => {
                throw new Error("temporary metadata read failure");
            });
            vi.advanceTimersByTime(1000);
            expect(
                posted,
                "the captured poll error must be reported without a second read",
            ).toEqual([
                {
                    type: "error",
                    repositoryRoot: root,
                    message: "Changelist action failed: temporary metadata read failure",
                },
            ]);
            vi.advanceTimersByTime(1000);
            posted.length = 0;

            failure = "metadata needs review";
            vi.advanceTimersByTime(3000);
            expect(posted, "a persistent read failure should be delivered once").toEqual([
                {
                    type: "error",
                    repositoryRoot: root,
                    message: "Changelist action failed: metadata needs review",
                },
            ]);
            failure = "metadata is unavailable";
            vi.advanceTimersByTime(2000);
            expect(posted, "a different read failure must remain visible").toHaveLength(2);
            expect(posted.at(-1)).toMatchObject({
                message: "Changelist action failed: metadata is unavailable",
            });

            failure = undefined;
            vi.advanceTimersByTime(1000);
            failure = "metadata is unavailable";
            vi.advanceTimersByTime(2000);
            expect(
                posted,
                "recovery must allow the same failure to be reported again",
            ).toHaveLength(3);
            const readsBeforeDisposal = reads.mock.calls.length;
            host.dispose();
            vi.advanceTimersByTime(2000);
            expect(reads.mock.calls.length, "disposed hosts must stop reading metadata").toBe(
                readsBeforeDisposal,
            );
            expect(posted, "disposed hosts must stop polling").toHaveLength(3);
        } finally {
            host.dispose();
            vi.useRealTimers();
        }
    });

    it.each(
        ["delete", "rename"].flatMap((operation) =>
            ["all", "named"].map((scope) => [operation, scope]),
        ),
    )(
        "requires whole-file confirmation for a tracked %s before committing it in %s",
        async (operation, scope) => {
            const file = operation === "rename" ? "renamed.txt" : "file.txt";
            git(operation === "rename" ? ["mv", "file.txt", file] : ["rm", "-f", "file.txt"]);
            await host.reconcile(await gitOps.getStatus({ withStats: false }));
            expect(store.get(root).changes[file].stale).toBe(true);
            const open = vi.spyOn(PartialChanges.prototype, "open");
            const warning = vi.mocked(vscode.window.showWarningMessage);
            warning.mockResolvedValueOnce("Commit Whole Files" as never);

            await host.handle({
                type: "commitChangelist",
                repositoryRoot: root,
                revision: store.get(root).revision,
                listId: scope === "all" ? "all" : store.get(root).activeId,
                paths: [file],
                message: "structural change",
                amend: false,
                push: false,
            });

            expect(
                warning,
                "stale structural changes require explicit whole-file review",
            ).toHaveBeenCalledWith(
                expect.any(String),
                expect.objectContaining({ modal: true, detail: expect.stringContaining(file) }),
                "Commit Whole Files",
            );
            expect(
                open,
                "structural files cannot enter the partial snapshot path",
            ).not.toHaveBeenCalled();
            const errors = posted.filter(
                (message) => (message as { type: string }).type === "error",
            );
            expect(errors, JSON.stringify(errors)).toEqual([]);
            expect(git(["log", "-1", "--format=%s"])).toBe("structural change\n");
            expect(git(["status", "--porcelain"])).toBe("");
        },
    );

    it.each(["delete", "rename"])(
        "refuses whole-file review of a tracked %s with lines owned by another list",
        async (operation) => {
            const created = await store.create(root, store.get(root).revision, "Other");
            const otherId = created.lists.find((list) => list.name === "Other")!.id;
            const ownership = created.changes["file.txt"];
            const fingerprints = ownership.tracking!.anchors.map((anchor) => anchor.fingerprint);
            await store.assignChanges(
                root,
                created.revision,
                "file.txt",
                ownership.contentId,
                otherId,
                [fingerprints[0]],
                new Set(fingerprints),
            );
            const file = operation === "rename" ? "renamed.txt" : "file.txt";
            git(operation === "rename" ? ["mv", "file.txt", file] : ["rm", "-f", "file.txt"]);
            await host.reconcile(await gitOps.getStatus({ withStats: false }));
            const before = store.get(root);
            const index = git(["ls-files", "--stage"]);
            vi.mocked(vscode.window.showWarningMessage).mockClear();

            await host.handle({
                type: "commitChangelist",
                repositoryRoot: root,
                revision: before.revision,
                listId: before.activeId,
                paths: [file],
                message: "must not consume another list",
            });

            expect(
                posted,
                "foreign line ownership must refuse before whole-file review",
            ).toContainEqual(
                expect.objectContaining({
                    type: "error",
                    message: expect.stringContaining("The files belong to another changelist."),
                }),
            );
            expect(
                vscode.window.showWarningMessage,
                "foreign line ownership must refuse before whole-file review",
            ).not.toHaveBeenCalled();
            expect(git(["rev-parse", "HEAD"])).toBe(baselineHead);
            expect(git(["ls-files", "--stage"])).toBe(index);
            expect(store.get(root)).toEqual(before);
        },
    );

    it("preserves Git and stale metadata when whole-file review is cancelled", async () => {
        git(["rm", "-f", "file.txt"]);
        await host.reconcile(await gitOps.getStatus({ withStats: false }));
        const before = store.get(root);
        const index = git(["ls-files", "--stage"]);
        const open = vi.spyOn(PartialChanges.prototype, "open");
        vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce(undefined);
        await host.handle({
            type: "commitChangelist",
            repositoryRoot: root,
            revision: before.revision,
            listId: before.activeId,
            paths: ["file.txt"],
            message: "cancelled",
        });
        expect(vscode.window.showWarningMessage).toHaveBeenCalled();
        expect(open).not.toHaveBeenCalled();
        expect(git(["rev-parse", "HEAD"]), "cancelled review must preserve HEAD").toBe(
            baselineHead,
        );
        expect(git(["ls-files", "--stage"])).toBe(index);
        expect(store.get(root)).toEqual(before);
    });

    it("preserves an explicit empty inclusion on the source of a tracked rename", async () => {
        const ownership = store.get(root).changes["file.txt"];
        await store.recordSelection(root, "file.txt", ownership.contentId, "all", [], 4);
        git(["mv", "file.txt", "renamed.txt"]);
        await host.reconcile(await gitOps.getStatus({ withStats: false }));
        const before = store.get(root);
        const index = git(["ls-files", "--stage"]);
        vi.mocked(vscode.window.showWarningMessage).mockClear();
        await host.handle({
            type: "commitChangelist",
            repositoryRoot: root,
            revision: before.revision,
            listId: "all",
            paths: ["renamed.txt"],
            message: "must not broaden inclusion",
        });
        expect(posted, "source inclusion must not broaden into a whole-file commit").toContainEqual(
            expect.objectContaining({
                type: "error",
                message: expect.stringContaining(
                    "Commit partial text and structural changes separately.",
                ),
            }),
        );
        expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
        expect(git(["rev-parse", "HEAD"])).toBe(baselineHead);
        expect(git(["ls-files", "--stage"])).toBe(index);
        expect(store.get(root)).toEqual(before);
    });

    it("refuses a structural change that changes again while whole-file review is open", async () => {
        git(["rm", "-f", "file.txt"]);
        await host.reconcile(await gitOps.getStatus({ withStats: false }));
        const before = store.get(root);
        const index = git(["ls-files", "--stage"]);
        vi.mocked(vscode.window.showWarningMessage).mockImplementationOnce(async () => {
            await writeFile(path.join(root, "file.txt"), "restored while reviewing\n");
            return "Commit Whole Files" as never;
        });
        await host.handle({
            type: "commitChangelist",
            repositoryRoot: root,
            revision: before.revision,
            listId: "all",
            paths: ["file.txt"],
            message: "must not commit restored text",
        });
        expect(posted, "changed structural status must refuse before Git mutation").toContainEqual(
            expect.objectContaining({
                type: "error",
                message: expect.stringContaining("Refresh before committing"),
            }),
        );
        expect(git(["rev-parse", "HEAD"])).toBe(baselineHead);
        expect(git(["ls-files", "--stage"])).toBe(index);
        expect(await readFile(path.join(root, "file.txt"), "utf8")).toBe(
            "restored while reviewing\n",
        );
    });

    it("refuses mixed partial and structural work before opening snapshots or changing Git", async () => {
        await writeFile(path.join(root, "other.txt"), base);
        git(["add", "other.txt"]);
        git(["commit", "-qm", "other file"]);
        await writeFile(path.join(root, "other.txt"), working);
        await host.reconcile(await gitOps.getStatus({ withStats: false }));
        git(["rm", "-f", "file.txt"]);
        await host.reconcile(await gitOps.getStatus({ withStats: false }));
        const before = store.get(root);
        const head = git(["rev-parse", "HEAD"]);
        const index = git(["ls-files", "--stage"]);
        const open = vi.spyOn(PartialChanges.prototype, "open");
        await host.handle({
            type: "commitChangelist",
            repositoryRoot: root,
            revision: before.revision,
            listId: before.activeId,
            paths: ["file.txt", "other.txt"],
            message: "mixed work",
        });
        expect(posted).toContainEqual(
            expect.objectContaining({
                type: "error",
                message: expect.stringContaining(
                    "Commit partial text and structural changes separately.",
                ),
            }),
        );
        expect(open).not.toHaveBeenCalled();
        expect(git(["rev-parse", "HEAD"])).toBe(head);
        expect(git(["ls-files", "--stage"])).toBe(index);
        expect(await readFile(path.join(root, "other.txt"), "utf8")).toBe(working);
    });

    it("keeps initial loading busy while interrupted transaction recovery is pending", async () => {
        host.dispose();
        let finishRecovery!: () => void;
        const pending = new Promise<void>((resolve) => {
            finishRecovery = resolve;
        });
        const recover = vi
            .spyOn(PartialChanges.prototype, "recover")
            .mockImplementationOnce(async () => {
                await pending;
                return false;
            });
        host = new ChangeWorkflowHost(hostDeps);
        const load = host.handle({ type: "loadChangelists", repositoryRoot: root });
        try {
            await vi.waitFor(() => expect(recover).toHaveBeenCalledOnce());
            await store.saveDraft(root, "all", "", "metadata arriving during initial recovery");
            expect(
                posted.at(-1),
                "initial recovery must not enable changelist actions",
            ).toMatchObject({
                type: "setChangelists",
                busy: true,
            });
        } finally {
            finishRecovery();
            await load;
        }
        expect(posted.at(-1)).toMatchObject({ type: "setChangelists", busy: false });
    });

    it("keeps cold reconciliation busy while repository connection is pending", async () => {
        host.dispose();
        let finishConnection!: () => void;
        const pending = new Promise<void>((resolve) => {
            finishConnection = resolve;
        });
        const directories = await gitOps.getGitDirectories();
        vi.spyOn(gitOps, "getGitDirectories").mockImplementationOnce(async () => {
            await pending;
            return directories;
        });
        host = new ChangeWorkflowHost(hostDeps);
        const refresh = host.reconcile(hostDeps.files());
        try {
            await store.saveDraft(root, "all", "", "metadata arriving during connection");
            expect(posted.at(-1), "connection-time metadata must not enable actions").toMatchObject(
                {
                    type: "setChangelists",
                    busy: true,
                },
            );
        } finally {
            finishConnection();
            await refresh;
        }
    });

    it("keeps reconciliation busy until membership reconciliation settles", async () => {
        let finishMembership!: () => void;
        const pending = new Promise<void>((resolve) => {
            finishMembership = resolve;
        });
        const reconcileFiles = store.reconcileFiles;
        const membership = vi
            .spyOn(store, "reconcileFiles")
            .mockImplementationOnce(async (...args) => {
                await pending;
                return reconcileFiles.apply(store, args);
            });
        const refresh = host.reconcile(hostDeps.files());
        try {
            await vi.waitFor(() => expect(membership).toHaveBeenCalledOnce());
            await store.saveDraft(root, "all", "", "metadata arriving during membership update");
            expect(posted.at(-1), "pending membership must not enable actions").toMatchObject({
                type: "setChangelists",
                busy: true,
            });
        } finally {
            finishMembership();
            await refresh;
        }
        expect(posted.at(-1)).toMatchObject({ type: "setChangelists", busy: false });
    });

    it("keeps actions busy until every overlapping range reconciliation finishes", async () => {
        let finishFirst!: () => void;
        let finishSecond!: () => void;
        const first = new Promise<void>((resolve) => {
            finishFirst = resolve;
        });
        const second = new Promise<void>((resolve) => {
            finishSecond = resolve;
        });
        const reconcile = vi
            .spyOn(ChangeRangeTracker.prototype, "reconcile")
            .mockReturnValueOnce(first)
            .mockReturnValueOnce(second);
        const files = await gitOps.getStatus({ withStats: false });
        const firstRefresh = host.reconcile(files);
        const secondRefresh = host.reconcile(files);
        try {
            await vi.waitFor(() => expect(reconcile).toHaveBeenCalledTimes(2));
            expect(
                posted.at(-1),
                "actions must remain disabled while ranges are loading",
            ).toMatchObject({ type: "setChangelists", busy: true });
            await store.saveDraft(root, "all", "", "another pane's draft");
            expect(
                posted.at(-1),
                "intermediate metadata delivery must preserve busy state",
            ).toMatchObject({ type: "setChangelists", busy: true });
            finishFirst();
            await firstRefresh;
            expect(
                posted.at(-1),
                "one completed refresh must not enable a pending refresh",
            ).toMatchObject({ type: "setChangelists", busy: true });
            finishSecond();
            await secondRefresh;
            expect(posted.at(-1)).toMatchObject({ type: "setChangelists", busy: false });
        } finally {
            finishFirst();
            finishSecond();
            await Promise.all([firstRefresh, secondRefresh]);
        }
    });

    it("releases the range reconciliation busy state after a failed observation", async () => {
        vi.spyOn(ChangeRangeTracker.prototype, "reconcile").mockRejectedValueOnce(
            new Error("injected range observation failure"),
        );
        await expect(host.reconcile([])).rejects.toThrow("injected range observation failure");
        expect(posted.at(-1)).toMatchObject({ type: "setChangelists", busy: false });
    });

    it("captures pending edits under the old active list before switching future attribution", async () => {
        const created = await store.create(root, store.get(root).revision, "Later");
        const id = created.lists[1].id;
        await writeFile(path.join(root, "file.txt"), `pending edit\n${working}`);
        await host.handle({
            type: "changelistAction",
            repositoryRoot: root,
            action: "activate",
            listId: id,
            revision: created.revision,
        });
        const state = store.get(root);
        expect(state.activeId).toBe(id);
        expect(state.changes["file.txt"].stale).toBe(false);
        expect(state.changes["file.txt"].lines).toEqual({});
        expect(state.files["file.txt"]).toBe("default");
    });

    it("keeps edits omitted from cached status in the old active list", async () => {
        await writeFile(path.join(root, "newly-dirty.txt"), base);
        git(["add", "--", "newly-dirty.txt"]);
        git(["commit", "-qm", "add clean tracked file"]);
        const created = await store.create(root, store.get(root).revision, "Later");
        const id = created.lists[1].id;
        await writeFile(path.join(root, "newly-dirty.txt"), first);
        await host.handle({
            type: "changelistAction",
            repositoryRoot: root,
            action: "activate",
            listId: id,
            revision: created.revision,
        });
        await host.reconcile(await gitOps.getStatus({ withStats: false }));
        const state = store.get(root);
        expect(state.activeId).toBe(id);
        expect(
            state.files["newly-dirty.txt"],
            "an edit saved before activation must retain the previous active owner",
        ).toBe("default");
    });

    it("does not overwrite another window's activation during observation", async () => {
        let state = await store.create(root, store.get(root).revision, "Requested");
        const requested = state.lists[1].id;
        state = await store.create(root, state.revision, "Other window");
        const other = state.lists[2].id;
        await writeFile(path.join(root, "file.txt"), `pending edit\n${working}`);
        const open = PartialChanges.prototype.open;
        vi.spyOn(PartialChanges.prototype, "open").mockImplementationOnce(async function (
            this: PartialChanges,
            ...args
        ) {
            const view = await open.apply(this, args);
            await store.activate(root, store.get(root).revision, other);
            return view;
        });
        await host.handle({
            type: "changelistAction",
            repositoryRoot: root,
            action: "activate",
            listId: requested,
            revision: state.revision,
        });
        expect(store.get(root).activeId).toBe(other);
        expect(store.get(root).changes["file.txt"].stale).toBe(true);
        expect(posted).toContainEqual(
            expect.objectContaining({
                type: "error",
                message: expect.stringContaining("Changelists changed"),
            }),
        );
    });

    it("opens unchanged text when a concurrent draft save advances the metadata revision", async () => {
        const open = PartialChanges.prototype.open;
        vi.spyOn(PartialChanges.prototype, "open").mockImplementationOnce(async function (
            this: PartialChanges,
            ...args
        ) {
            const view = await open.apply(this, args);
            await store.saveDraft(root, "all", "", "Other window draft");
            return view;
        });
        const { messages } = await partialEditor();
        expect(messages.some((message) => message.type === "partialFile")).toBe(true);
        expect(store.draft(root, "all")).toBe("Other window draft");
        expect(git(["rev-parse", "HEAD"])).toBe(baselineHead);
    });

    it("reports a completed commit accurately when its metadata lease release fails", async () => {
        const { panel, selection, messages } = await partialEditor();
        const begin = store.beginCommit.bind(store);
        vi.spyOn(store, "beginCommit").mockImplementationOnce(async (repository) => {
            const release = await begin(repository);
            return async () => {
                await release();
                throw new Error("injected release failure");
            };
        });
        await panel.receiveMessage({ type: "commitSelection", selection, message: "One commit" });
        expect(git(["show", "HEAD:file.txt"])).toBe(first);
        expect(git(["rev-list", "--count", "HEAD"])).toBe("2\n");
        expect(messages.some((message) => message.type === "partialError")).toBe(false);
        expect(posted).toContainEqual(
            expect.objectContaining({ message: expect.stringContaining("Do not retry") }),
        );
        expect(store.isCommitting(root)).toBe(false);
    });

    it.each([false, true])(
        "restores staging inclusion after a dirty-buffer refusal and later commits the prior choice (existing=%s)",
        async (existing) => {
            const { panel, selection, messages } = await partialEditor();
            if (existing) {
                const data = messages.find((message) => message.type === "partialFile");
                if (!data || data.type !== "partialFile") throw new Error("Missing snapshot");
                await panel.receiveMessage({
                    type: "useSelection",
                    selection: {
                        snapshotId: data.file.snapshotId,
                        lineIds: changeIds(data.file.blocks.slice(1)),
                    },
                });
            }
            const before = store.get(root).changes["file.txt"].selections;
            const index = await readFile(path.join(root, ".git/index"));
            (vscode.workspace.textDocuments as vscode.TextDocument[]).push({
                uri: { scheme: "file", fsPath: path.join(root, "file.txt") },
                isDirty: true,
            } as vscode.TextDocument);
            await panel.receiveMessage({ type: "stageSelection", selection });
            expect(messages).toContainEqual(
                expect.objectContaining({
                    type: "partialError",
                    message: expect.stringContaining("Save the native editor"),
                }),
            );
            expect(store.get(root).changes["file.txt"].selections).toEqual(before);
            const restarted = new ChangelistStore(storage);
            await restarted.connect(root, path.join(root, ".git"));
            expect(restarted.get(root).changes["file.txt"].selections).toEqual(before);
            expect(await readFile(path.join(root, ".git/index"))).toEqual(index);
            expect(git(["rev-parse", "HEAD"])).toBe(baselineHead);
            (vscode.workspace.textDocuments as vscode.TextDocument[]).length = 0;
            await host.handle({
                type: "commitChangelist",
                repositoryRoot: root,
                revision: store.get(root).revision,
                listId: "all",
                paths: ["file.txt"],
                message: "original inclusion after refused staging",
            });
            expect(git(["show", "HEAD:file.txt"])).toBe(
                existing ? base.replace("line 80\n", "remaining\n") : working,
            );
        },
    );

    it.each(["empty", "foreign lock"] as const)(
        "does not keep a staging inclusion after %s refusal",
        async (refusal) => {
            const { panel, selection, messages } = await partialEditor();
            const before = store.get(root).changes["file.txt"].selections;
            const index = await readFile(path.join(root, ".git/index"));
            const lock = path.join(root, ".git/index.lock");
            if (refusal === "foreign lock") await writeFile(lock, "foreign owner");
            await panel.receiveMessage({
                type: "stageSelection",
                selection: { ...selection, lineIds: refusal === "empty" ? [] : selection.lineIds },
            });
            expect(messages).toContainEqual(expect.objectContaining({ type: "partialError" }));
            expect(store.get(root).changes["file.txt"].selections).toEqual(before);
            expect(await readFile(path.join(root, ".git/index"))).toEqual(index);
            expect(git(["rev-parse", "HEAD"])).toBe(baselineHead);
            expect(await readFile(path.join(root, "file.txt"), "utf8")).toBe(working);
            if (refusal === "foreign lock")
                expect(await readFile(lock, "utf8")).toBe("foreign owner");
        },
    );

    it("refuses staging before changing the index when inclusion cannot be persisted", async () => {
        const { panel, selection, messages } = await partialEditor();
        const index = await readFile(path.join(root, ".git/index"));
        persistenceFailure = "before";
        await panel.receiveMessage({ type: "stageSelection", selection });
        expect(messages).toContainEqual(
            expect.objectContaining({
                type: "partialError",
                message: expect.stringContaining("metadata storage"),
            }),
        );
        expect(store.get(root).changes["file.txt"].selections).toBeUndefined();
        expect(await readFile(path.join(root, ".git/index"))).toEqual(index);
    });

    it("keeps staging inclusion when a published index needs recovery", async () => {
        const { panel, selection, messages } = await partialEditor();
        const original = PartialChanges.prototype.stage;
        vi.spyOn(PartialChanges.prototype, "stage").mockImplementation(async function (
            this: PartialChanges,
            ...args
        ) {
            await original.apply(this, args);
            throw new PartialIndexPublicationError("index durability needs recovery");
        });
        await panel.receiveMessage({ type: "stageSelection", selection });
        expect(git(["show", ":file.txt"])).toBe(first);
        expect(git(["rev-parse", "HEAD"])).toBe(baselineHead);
        expect(store.get(root).changes["file.txt"].selections?.all.lineIds).toEqual(
            selection.lineIds,
        );
        expect(messages).toContainEqual(
            expect.objectContaining({
                type: "partialError",
                message: expect.stringContaining("durability"),
            }),
        );
    });

    it("warns and retains staging inclusion when rollback persistence fails", async () => {
        const { panel, selection, messages } = await partialEditor();
        vi.spyOn(PartialChanges.prototype, "stage").mockImplementation(async () => {
            persistenceFailure = "before";
            throw new Error("staging refused");
        });
        vi.spyOn(console, "error").mockImplementation(() => undefined);
        await panel.receiveMessage({ type: "stageSelection", selection });
        expect(git(["show", ":file.txt"])).toBe(base);
        expect(store.get(root).changes["file.txt"].selections?.all.lineIds).toEqual(
            selection.lineIds,
        );
        expect(posted).toContainEqual(
            expect.objectContaining({
                type: "error",
                message: expect.stringContaining("selection metadata could not be restored"),
            }),
        );
        expect(messages).toContainEqual(
            expect.objectContaining({
                type: "partialError",
                message: expect.stringContaining("staging refused"),
            }),
        );
    });

    it("holds the shared metadata lease while staging and releases it on failure", async () => {
        const { panel, selection } = await partialEditor();
        vi.spyOn(PartialChanges.prototype, "stage").mockImplementation(async () => {
            expect(store.isCommitting(root)).toBe(true);
            await expect(
                store.resetSelection(root, store.get(root).revision, "all", ["file.txt"]),
            ).rejects.toThrow("cannot change");
            throw new Error("staging refused");
        });
        await panel.receiveMessage({ type: "stageSelection", selection });
        expect(store.isCommitting(root)).toBe(false);
        expect(store.get(root).changes["file.txt"].selections).toBeUndefined();
    });

    it.each([false, true])(
        "restores prior inclusion after a rejected hook (existing=%s)",
        async (existing) => {
            const { panel, selection, messages } = await partialEditor();
            if (existing) {
                const file = messages.find((message) => message.type === "partialFile");
                if (!file || file.type !== "partialFile") throw new Error("Missing snapshot");
                await panel.receiveMessage({
                    type: "useSelection",
                    selection: {
                        snapshotId: file.file.snapshotId,
                        lineIds: changeIds(file.file.blocks.slice(1)),
                    },
                });
            }
            const before = store.get(root).changes["file.txt"].selections;
            const hook = path.join(root, ".git/hooks/pre-commit");
            await writeFile(hook, "#!/bin/sh\nexit 1\n");
            await chmod(hook, 0o755);
            await panel.receiveMessage({
                type: "commitSelection",
                selection,
                message: "hook rejection",
            });
            expect(git(["rev-parse", "HEAD"])).toBe(baselineHead);
            expect(store.get(root).changes["file.txt"].selections).toEqual(before);
            expect(messages).toContainEqual(expect.objectContaining({ type: "partialError" }));
        },
    );

    it("does not restore old inclusion after actual publication even if HEAD was reset back", async () => {
        const { panel, selection, messages } = await partialEditor();
        const original = GitExecutor.prototype.runBinary;
        vi.spyOn(GitExecutor.prototype, "runBinary").mockImplementation(async function (
            this: GitExecutor,
            args,
            options,
        ) {
            const result = await original.call(this, args, options);
            if (args[0] === "update-ref") git(["update-ref", args[3], args[5], args[4]]);
            return result;
        });
        await panel.receiveMessage({
            type: "commitSelection",
            selection,
            message: "published then reset",
        });
        expect(git(["rev-parse", "HEAD"])).toBe(baselineHead);
        expect(store.get(root).changes["file.txt"].selections?.all.lineIds).toEqual(
            selection.lineIds,
        );
        expect(messages).toContainEqual(
            expect.objectContaining({
                type: "partialError",
                message: expect.stringContaining("commit succeeded"),
            }),
        );
    });

    it("retains a fence when ref publication cannot be confirmed", async () => {
        const { panel, selection, messages } = await partialEditor();
        const original = GitExecutor.prototype.runBinary;
        vi.spyOn(GitExecutor.prototype, "runBinary").mockImplementation(function (
            this: GitExecutor,
            args,
            options,
        ) {
            if (args[0] === "update-ref")
                return Promise.reject(new Error("publication transport interrupted"));
            return original.call(this, args, options);
        });
        await panel.receiveMessage({
            type: "commitSelection",
            selection,
            message: "uncertain publication",
        });
        expect(git(["rev-parse", "HEAD"])).toBe(baselineHead);
        expect(store.get(root).changes["file.txt"].selections?.all.lineIds).toEqual(
            selection.lineIds,
        );
        expect(messages).toContainEqual(
            expect.objectContaining({
                type: "partialError",
                message: expect.stringContaining("could not be confirmed"),
            }),
        );
    });
    it("rejects an oversized partial commit before opening its file snapshots", async () => {
        const { panel, selection } = await partialEditor();
        await panel.receiveMessage({ type: "useSelection", selection });
        const head = git(["rev-parse", "HEAD"]);
        const index = await readFile(path.join(root, ".git/index"));
        await host.handle({
            type: "commitChangelist",
            repositoryRoot: root,
            revision: store.get(root).revision,
            listId: "all",
            paths: ["file.txt", ...Array.from({ length: 64 }, (_, i) => `missing-${i}.txt`)],
            message: "too many files",
        });
        expect(posted).toContainEqual(
            expect.objectContaining({
                type: "error",
                message: expect.stringContaining("1 to 64 text files"),
            }),
        );
        expect(git(["rev-parse", "HEAD"])).toBe(head);
        expect(await readFile(path.join(root, ".git/index"))).toEqual(index);
    });
    it("routes pending sidebar inclusion through real Git and does not commit the remainder twice", async () => {
        const { panel, selection } = await partialEditor();
        await panel.receiveMessage({ type: "useSelection", selection });
        const revision = store.get(root).revision;
        await host.handle({
            type: "commitChangelist",
            repositoryRoot: root,
            revision,
            listId: "all",
            paths: ["file.txt"],
            message: "selected only",
        });
        expect(git(["show", "HEAD:file.txt"])).toBe(first);
        expect(await readFile(path.join(root, "file.txt"), "utf8")).toBe(working);
        expect(delivered).toHaveBeenCalledTimes(1);
        const state = store.get(root);
        expect(state.changes["file.txt"].selections?.all.lineIds).toEqual([]);
        const head = git(["rev-parse", "HEAD"]);
        await host.handle({
            type: "commitChangelist",
            repositoryRoot: root,
            revision: state.revision,
            listId: "all",
            paths: ["file.txt"],
            message: "must not commit remainder",
        });
        expect(git(["rev-parse", "HEAD"])).toBe(head);
        expect(posted).toContainEqual(
            expect.objectContaining({
                type: "error",
                message: expect.stringContaining("No selected changes"),
            }),
        );
    });

    it("rejects another repository, stale revisions and a forged editor selection", async () => {
        await expect(
            host.handle({ type: "loadChangelists", repositoryRoot: "/unknown" }),
        ).rejects.toThrow("Unknown");
        const head = git(["rev-parse", "HEAD"]);
        await host.handle({
            type: "commitChangelist",
            repositoryRoot: root,
            revision: 0,
            listId: "all",
            paths: ["file.txt"],
            message: "stale",
        });
        const { panel, messages } = await partialEditor();
        await panel.receiveMessage({
            type: "stageSelection",
            selection: { snapshotId: "forged", lineIds: ["0:1"] },
        });
        expect(messages).toContainEqual(expect.objectContaining({ type: "partialError" }));
        expect(git(["rev-parse", "HEAD"])).toBe(head);
        expect(git(["show", ":file.txt"])).toBe(base);
    });

    it("fences duplicate editor commits and retains drafts after a failed action", async () => {
        const { panel, messages, selection } = await partialEditor();
        await panel.receiveMessage({ type: "commitSelection", selection, message: "" });
        expect(messages).toContainEqual(expect.objectContaining({ type: "partialError" }));
        await panel.receiveMessage({ type: "commitSelection", selection, message: "one commit" });
        expect(messages).toContainEqual(expect.objectContaining({ type: "partialCommitted" }));
        const head = git(["rev-parse", "HEAD"]);
        await panel.receiveMessage({ type: "commitSelection", selection, message: "duplicate" });
        expect(git(["rev-parse", "HEAD"])).toBe(head);
        expect(delivered).toHaveBeenCalledTimes(1);
    });

    it.each([false, true])(
        "does not change working inclusion when unstaging index lines (saved=%s)",
        async (saved) => {
            git(["add", "--", "file.txt"]);
            const { panel, selection, messages } = await partialEditor();
            if (saved) await panel.receiveMessage({ type: "useSelection", selection });
            const before = store.get(root);
            await panel.receiveMessage({ type: "ready", side: "index" });
            const indexed = messages.findLast((message) => message.type === "partialFile");
            if (!indexed || indexed.type !== "partialFile")
                throw new Error("Missing index snapshot");
            await panel.receiveMessage({
                type: "stageSelection",
                selection: {
                    snapshotId: indexed.file.snapshotId,
                    lineIds: changeIds(indexed.file.blocks.slice(0, 1)),
                },
            });
            expect(store.get(root)).toEqual(before);
            expect(git(["show", ":file.txt"])).toBe(base.replace("line 80\n", "remaining\n"));
            await host.handle({
                type: "commitChangelist",
                repositoryRoot: root,
                revision: before.revision,
                listId: "all",
                paths: ["file.txt"],
                message: "commit after unstage",
            });
            expect(posted).not.toContainEqual(expect.objectContaining({ type: "error" }));
            expect(git(["show", "HEAD:file.txt"])).toBe(saved ? first : working);
        },
    );

    it("refuses publication if the pre-commit inclusion fence cannot be persisted", async () => {
        const { panel, selection, messages } = await partialEditor();
        const index = await readFile(path.join(root, ".git/index"));
        persistenceFailure = "before";
        await panel.receiveMessage({
            type: "commitSelection",
            selection,
            message: "must not publish",
        });
        expect(messages).toContainEqual(
            expect.objectContaining({
                type: "partialError",
                message: expect.stringContaining("metadata storage"),
            }),
        );
        expect(git(["rev-parse", "HEAD"])).toBe(baselineHead);
        expect(await readFile(path.join(root, ".git/index"))).toEqual(index);
        expect(await readFile(path.join(root, "file.txt"), "utf8")).toBe(working);
        expect(delivered).not.toHaveBeenCalled();
    });

    it("keeps a durable partial fence after a committed selection cannot be consumed", async () => {
        const { panel, selection, messages } = await partialEditor();
        const before = store.get(root);
        expect(before.changes["file.txt"].selections).toBeUndefined();
        persistenceFailure = "after";
        await panel.receiveMessage({
            type: "commitSelection",
            selection,
            message: "published once",
        });
        expect(messages).toContainEqual(expect.objectContaining({ type: "partialCommitted" }));
        expect(git(["show", "HEAD:file.txt"])).toBe(first);
        expect(posted).toContainEqual(
            expect.objectContaining({
                type: "error",
                message: expect.stringContaining("commit succeeded"),
            }),
        );
        const restarted = new ChangelistStore(storage);
        await restarted.connect(root, path.join(root, ".git"));
        const persisted = restarted.get(root);
        expect(persisted.changes["file.txt"].selections?.all.lineIds).toEqual(selection.lineIds);
        const head = git(["rev-parse", "HEAD"]);
        await host.handle({
            type: "commitChangelist",
            repositoryRoot: root,
            revision: store.get(root).revision,
            listId: "all",
            paths: ["file.txt"],
            message: "must not include remainder",
        });
        expect(git(["rev-parse", "HEAD"])).toBe(head);
        expect(await readFile(path.join(root, "file.txt"), "utf8")).toBe(working);
        expect(delivered).toHaveBeenCalledTimes(1);
    });
});

// Windows exceeded five minutes for this 65-file, >16 MiB real-Git regression.
it(
    "commits 65 fully owned files without partial limits and preserves unrelated state",
    async () => {
        const paths = Array.from({ length: 65 }, (_, i) => `owned-${i}.txt`);
        const ownedBase = `${"unchanged ".repeat(100)}\n`.repeat(300);
        const ownedWorking = `${ownedBase}changed\n`;
        expect(Buffer.byteLength(ownedWorking) * paths.length).toBeGreaterThan(16 * 1024 * 1024);
        for (const file of paths) await writeFile(path.join(root, file), ownedBase);
        git(["add", "--", ...paths]);
        git(["commit", "-qm", "65 tracked files"]);
        await writeFile(path.join(root, "file.txt"), first);
        git(["add", "--", "file.txt"]);
        await writeFile(path.join(root, "file.txt"), working);
        await store.saveDraft(root, "all", "", "unrelated aggregate draft");
        const created = await store.create(root, store.get(root).revision, "Fully owned");
        const id = created.lists.find((list) => list.name === "Fully owned")!.id;
        await store.activate(root, store.get(root).revision, id);
        for (const file of paths) await writeFile(path.join(root, file), ownedWorking);
        await host.reconcile(await gitOps.getStatus({ withStats: false }));
        const state = store.get(root);
        for (const file of paths) {
            expect(state.files[file], "file fallback belongs to the requested list").toBe(id);
            expect(state.changes[file].tracking).toBeDefined();
            expect(state.changes[file].stale).not.toBe(true);
            expect(state.changes[file].selections?.[id]).toBeUndefined();
            expect(Object.values(state.changes[file].lines).every((owner) => owner === id)).toBe(
                true,
            );
        }
        const head = git(["rev-parse", "HEAD"]).trim();
        const unrelatedIndex = git(["ls-files", "--stage", "--", "file.txt"]);
        await host.handle({
            type: "commitChangelist",
            repositoryRoot: root,
            revision: state.revision,
            listId: id,
            paths,
            message: "all 65 owned files",
        });
        expect(
            posted.filter((message) => (message as { type?: string }).type === "error"),
            "fully owned files without explicit inclusion must not acquire the partial-only cap",
        ).toEqual([]);
        expect(git(["rev-list", "--count", `${head}..HEAD`]).trim()).toBe("1");
        expect(
            git(["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"])
                .trim()
                .split("\n")
                .sort(),
        ).toEqual([...paths].sort());
        for (const file of paths) expect(git(["show", `HEAD:${file}`])).toBe(ownedWorking);
        expect(git(["ls-files", "--stage", "--", "file.txt"])).toBe(unrelatedIndex);
        expect(await readFile(path.join(root, "file.txt"), "utf8")).toBe(working);
        expect(store.get(root).allDraft).toBe("unrelated aggregate draft");
    },
    process.platform === "win32" ? 600_000 : 300_000,
);

it.each(["capture", "hook"] as const)(
    "whole-owned metadata guard rejects a %s-time revision change",
    async (when) => {
        const marker = path.join(root, "owned-hook-ran");
        if (when === "hook") {
            const hook = path.join(root, ".git/hooks/pre-commit");
            await writeFile(hook, "#!/bin/sh\nprintf ran > owned-hook-ran\n");
            await chmod(hook, 0o755);
        }
        const state = store.get(root);
        const head = git(["rev-parse", "HEAD"]);
        const index = await readFile(path.join(root, ".git/index"));
        const commit = PartialChanges.prototype.tryCommitWholeFiles;
        let injected = false;
        vi.spyOn(PartialChanges.prototype, "tryCommitWholeFiles").mockImplementation(
            async function (this: PartialChanges, paths, message, ownsSnapshot, guard, faults) {
                return commit.call(
                    this,
                    paths,
                    message,
                    ownsSnapshot,
                    async (files) => {
                        if (
                            !injected &&
                            (when === "capture" ||
                                (await readFile(marker, "utf8").catch(() => undefined)))
                        ) {
                            injected = true;
                            await store.registerChanges(
                                root,
                                "observed.txt",
                                "newer-observation",
                                1,
                            );
                        }
                        await guard(files);
                    },
                    faults,
                );
            },
        );
        await host.handle({
            type: "commitChangelist",
            repositoryRoot: root,
            revision: state.revision,
            listId: state.activeId,
            paths: ["file.txt"],
            message: "must not publish",
        });
        expect(injected, "the whole-owned transaction reached the requested metadata fence").toBe(
            true,
        );
        expect(posted).toContainEqual(
            expect.objectContaining({
                type: "error",
                message: expect.stringContaining("Changelists changed during commit preparation"),
            }),
        );
        expect(git(["rev-parse", "HEAD"]), "metadata drift must prevent ref publication").toBe(
            head,
        );
        expect(await readFile(path.join(root, ".git/index"))).toEqual(index);
        expect(store.get(root).changes["observed.txt"].contentId).toBe("newer-observation");
    },
);
