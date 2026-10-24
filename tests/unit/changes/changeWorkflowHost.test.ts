import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile, chmod, readdir, mkdir, link } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
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
import { ShelfService } from "../../../src/services/shelfService";
import { ShelfStore } from "../../../src/shelf/store";
import { resolveShelfPaths } from "../../../src/shelf/paths";
import { RepositoryMutationGate } from "../../../src/git/repositoryMutationGate";
import { RepositoryMutationCoordinator } from "../../../src/git/mutationCoordinator";
import { RepositoryLock } from "../../../src/git/repositoryLock";
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
    await host.settled();
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

async function selectedShelfEditor() {
    const shelves = new ShelfStore(
        await resolveShelfPaths({
            repositoryRoot: root,
            globalStoragePath: path.join(root, "shelf-storage"),
        }),
    );
    const service = new ShelfService({
        repositoryRoot: root,
        executor: new GitExecutor(root),
        gitOps,
        changelists: store,
        store: shelves,
        gate: new RepositoryMutationGate(new RepositoryMutationCoordinator(), new RepositoryLock()),
    });
    host.dispose();
    host = new ChangeWorkflowHost({ ...hostDeps, shelfService: service });
    Object.defineProperty(vscode.window, "showInputBox", {
        configurable: true,
        value: vi.fn().mockResolvedValue("selected shelf"),
    });
    const editor = await partialEditor();
    return { ...editor, service, shelves };
}

describe("scoped list and file save", () => {
    it.each(["success", "error"] as const)(
        "scoped %s reply completes before native notification dismissal",
        async (kind) => {
            const f = await selectedShelfEditor();
            let dismiss!: () => void;
            const notification = new Promise<undefined>((resolve) => {
                dismiss = () => resolve(undefined);
            });
            const show = vi.mocked(
                kind === "success"
                    ? vscode.window.showInformationMessage
                    : vscode.window.showWarningMessage,
            );
            show.mockClear();
            show.mockReturnValueOnce(notification);
            let completed = false;
            const operation = host
                .handle({
                    type: "saveChangelistShelf",
                    repositoryRoot: root,
                    requestId: "undismissed-notice",
                    revision: store.revision(root) + (kind === "error" ? 1 : 0),
                    scope: "files",
                    listId: "all",
                    paths: ["file.txt"],
                })
                .then(() => {
                    completed = true;
                });
            try {
                await vi.waitFor(() => expect(show).toHaveBeenCalled(), { timeout: 15000 });
                expect(
                    posted,
                    "terminal result must not wait for native notification dismissal",
                ).toContainEqual(
                    expect.objectContaining({
                        type: "changelistShelfResult",
                        requestId: "undismissed-notice",
                        ...(kind === "success"
                            ? { shelfId: expect.any(String) }
                            : { error: expect.any(String) }),
                    }),
                );
                expect(completed, "host releases the request before notification dismissal").toBe(
                    true,
                );
                expect((await f.shelves.listShelves()).shelfIds).toHaveLength(
                    kind === "success" ? 1 : 0,
                );
            } finally {
                dismiss();
                await operation;
            }
        },
    );

    it("saved scoped identity survives a failed native success notice", async () => {
        const f = await selectedShelfEditor();
        vi.mocked(vscode.window.showInformationMessage).mockRejectedValueOnce(
            new Error("notice delivery failed"),
        );
        await host.handle({
            type: "saveChangelistShelf",
            repositoryRoot: root,
            requestId: "notice",
            revision: store.revision(root),
            scope: "files",
            listId: "all",
            paths: ["file.txt"],
        });
        const ids = (await f.shelves.listShelves()).shelfIds;
        expect(ids).toHaveLength(1);
        expect(posted, "failed success notice retains durable identity").toContainEqual(
            expect.objectContaining({
                type: "changelistShelfResult",
                message: expect.stringContaining(ids[0]),
            }),
        );
    });

    it("single-owner whole-file save rejects source edits after host plan capture", async () => {
        const f = await selectedShelfEditor();
        const save = f.service.saveSelectedChanges.bind(f.service);
        vi.spyOn(f.service, "saveSelectedChanges").mockImplementationOnce(async (...args) => {
            await writeFile(path.join(root, "file.txt"), `${working}later edit\n`);
            return save(...args);
        });
        await host.handle({
            type: "saveChangelistShelf",
            repositoryRoot: root,
            requestId: "single-source",
            revision: store.revision(root),
            scope: "files",
            listId: "all",
            paths: ["file.txt"],
        });
        expect(
            (await f.shelves.listShelves()).shelfIds,
            "single-owner capture does not regenerate changed source",
        ).toEqual([]);
    });

    async function fixture() {
        const editor = await selectedShelfEditor();
        const data = editor.messages.find((message) => message.type === "partialFile")! as Extract<
            PartialEditorReply,
            { type: "partialFile" }
        >;
        const created = await store.create(root, store.revision(root), "Other 名前");
        const other = created.lists.find((list) => list.id !== "default")!.id;
        const lines = data.file.blocks
            .flatMap((block) => block.lines)
            .filter((line) => line.kind !== "context");
        await store.assignChanges(
            root,
            store.revision(root),
            "file.txt",
            data.contentId,
            other,
            data.file.blocks[1].lines
                .filter((line) => line.kind !== "context")
                .map((line) => line.fingerprint),
            new Set(lines.map((line) => line.fingerprint)),
        );
        await store.saveDraft(root, "default", "", "default draft\n");
        await store.saveDraft(root, other, "", "other draft 名前\n");
        await store.saveDraft(root, "all", "", "aggregate draft");
        await store.recordSelection(root, "file.txt", data.contentId, "default", [], lines.length);
        const request = {
            type: "saveChangelistShelf",
            repositoryRoot: root,
            requestId: "scoped-save-1",
            revision: store.revision(root),
            scope: "list",
            listId: "default",
        };
        return { ...editor, other, request };
    }

    it("list save captures only its owned ranges and preserves every source state", async () => {
        const f = await fixture();
        const before = store.get(root);
        const index = await readFile(path.join(root, ".git/index"));
        await host.handle(f.request);
        const ids = (await f.shelves.listShelves()).shelfIds;
        expect(ids, "list save publishes one shelf").toHaveLength(1);
        const manifest = await f.service.getShelfManifest(ids[0]);
        const patch = await f.service.exportPatch({ id: ids[0] });
        expect(patch.toString(), "list save excludes other owners").not.toContain("+remaining");
        expect(patch.toString()).toContain("+selected");
        expect(manifest.metadata.selection?.scope).toBe("list");
        expect(manifest.metadata.selection?.sourceLists.map((list) => list.id)).toEqual([
            "default",
        ]);
        expect(store.get(root)).toEqual(before);
        expect(await readFile(path.join(root, "file.txt"), "utf8")).toBe(working);
        expect(await readFile(path.join(root, ".git/index"))).toEqual(index);
        expect(git(["rev-parse", "HEAD"])).toBe(baselineHead);
    });

    it("whole-file save records all source owners and staged plus working layers", async () => {
        await writeFile(path.join(root, "file.txt"), first);
        git(["add", "file.txt"]);
        await writeFile(path.join(root, "file.txt"), working);
        const f = await fixture();
        const before = store.get(root);
        const index = await readFile(path.join(root, ".git/index"));
        await host.handle({ ...f.request, scope: "files", listId: "all", paths: ["file.txt"] });
        const ids = (await f.shelves.listShelves()).shelfIds;
        expect(ids, "whole-file save publishes one shelf").toHaveLength(1);
        const manifest = await f.service.getShelfManifest(ids[0]);
        expect(
            manifest.metadata.selection?.sourceLists.map((list) => list.id).sort(),
            "whole-file save keeps all owners",
        ).toEqual(["default", f.other].sort());
        expect(manifest.metadata.selection?.sourceLists.map((list) => list.draft).sort()).toEqual(
            ["default draft\n", "other draft 名前\n"].sort(),
        );
        expect(manifest.metadata.selection?.scopeDraft).toBe("aggregate draft");
        expect((await f.service.exportPatch({ id: ids[0] })).toString()).toContain("+remaining");
        expect(manifest.files[0].indexBlock).toBeDefined();
        expect(manifest.files[0].worktreeBlock).toBeDefined();
        expect(store.get(root)).toEqual(before);
        expect(await readFile(path.join(root, ".git/index"))).toEqual(index);
        expect(await readFile(path.join(root, "file.txt"), "utf8")).toBe(working);
        expect(git(["rev-parse", "HEAD"])).toBe(baselineHead);
    });

    it("cancelled names and zero explicit paths never publish or select all files", async () => {
        const f = await fixture();
        vi.mocked(vscode.window.showInputBox).mockResolvedValueOnce(undefined);
        await host.handle(f.request);
        await host.handle({
            ...f.request,
            requestId: "empty",
            scope: "files",
            listId: "all",
            paths: [],
        });
        expect((await f.shelves.listShelves()).shelfIds).toEqual([]);
        expect(posted).toContainEqual(
            expect.objectContaining({
                type: "changelistShelfResult",
                requestId: "empty",
                error: expect.stringMatching(/select/i),
            }),
        );
    });

    it("duplicate scoped requests cannot publish twice", async () => {
        const f = await fixture();
        await host.handle(f.request);
        await host.handle(f.request);
        expect(
            (await f.shelves.listShelves()).shelfIds,
            "duplicate save publishes only once",
        ).toHaveLength(1);
        expect(vscode.window.showInputBox).toHaveBeenCalledTimes(1);
    });

    it("revision changed during name prompt refuses save without changing origin", async () => {
        const f = await fixture();
        vi.mocked(vscode.window.showInputBox).mockImplementationOnce(async () => {
            await store.saveDraft(root, "default", "default draft\n", "edited during prompt");
            return "stale save";
        });
        await host.handle(f.request);
        expect((await f.shelves.listShelves()).shelfIds).toEqual([]);
        expect(posted).toContainEqual(
            expect.objectContaining({
                type: "changelistShelfResult",
                error: expect.stringMatching(/changed|stale/i),
            }),
        );
    });

    /** A list save whose `git status` read (or name prompt) runs `during` first; `other.txt` is changed but not yet scanned. */
    async function saveWithStatusRead(
        during: (f: Awaited<ReturnType<typeof fixture>>) => unknown,
        window: "status" | "prompt" = "status",
    ) {
        await writeFile(path.join(root, "other.txt"), "other\n");
        git(["add", "--", "other.txt"]);
        git(["commit", "-qm", "other"]);
        await host.reconcile(await gitOps.getStatus({ withStats: false }));
        await host.settled();
        const f = await fixture();
        await writeFile(path.join(root, "other.txt"), "other edited\n");
        // Membership runs before the range scan, so the file is listed without a range record yet.
        await store.reconcileFiles(root, ["file.txt", "other.txt"]);
        f.request.revision = store.revision(root);
        expect(store.get(root).files["other.txt"]).toBe("default");
        expect(store.get(root).changes["other.txt"], "the scan has not seen the edit").toBe(
            undefined,
        );
        const status = gitOps.getStatus.bind(gitOps);
        let duringRevision = 0;
        if (window === "prompt")
            vi.mocked(vscode.window.showInputBox).mockImplementationOnce(async () => {
                await during(f);
                duringRevision = store.revision(root);
                return "selected shelf";
            });
        else
            vi.spyOn(gitOps, "getStatus").mockImplementationOnce(async (options) => {
                const files = await status(options);
                await during(f);
                duringRevision = store.revision(root);
                return files;
            });
        posted.length = 0;
        await host.handle(f.request);
        expect(duringRevision, "a metadata write lands during the save").toBeGreaterThan(
            f.request.revision,
        );
        return f;
    }

    it("list save survives a range scan write landing during its Git reads", async () => {
        const f = await saveWithStatusRead(async () => {
            await host.reconcile(await gitOps.getStatus({ withStats: false }));
            await host.settled();
        });
        expect(
            posted.flatMap((message) => (message as { error?: string }).error ?? []),
            "a range scan observing a file must not refuse the save",
        ).toEqual([]);
        expect((await f.shelves.listShelves()).shelfIds).toHaveLength(1);
    });

    it("list save refuses a file moved to another list during its Git reads", async () => {
        const f = await saveWithStatusRead((fixture) =>
            store.moveFiles(root, store.revision(root), fixture.other, ["other.txt"]),
        );
        expect(posted, "an ownership change during the save must refuse it").toContainEqual(
            expect.objectContaining({
                type: "changelistShelfResult",
                error: expect.stringMatching(/changed/i),
            }),
        );
        expect((await f.shelves.listShelves()).shelfIds).toEqual([]);
    });

    it("list save survives a range scan write landing during its name prompt", async () => {
        const f = await saveWithStatusRead(async () => {
            await host.reconcile(await gitOps.getStatus({ withStats: false }));
            await host.settled();
        }, "prompt");
        expect(
            posted.flatMap((message) => (message as { error?: string }).error ?? []),
            "a range scan observing a file during the name prompt must not refuse the save",
        ).toEqual([]);
        expect((await f.shelves.listShelves()).shelfIds).toHaveLength(1);
    });

    it.each(["rename", "move"] as const)(
        "list save refuses a list %s during its name prompt",
        async (change) => {
            const f = await saveWithStatusRead(
                (fixture) =>
                    change === "rename"
                        ? store.rename(root, store.revision(root), "default", "Renamed")
                        : store.moveFiles(root, store.revision(root), fixture.other, ["other.txt"]),
                "prompt",
            );
            expect(posted, "the prompt check must refuse an intent change").toContainEqual(
                expect.objectContaining({
                    type: "changelistShelfResult",
                    error: expect.stringMatching(/during the save prompt/),
                }),
            );
            expect((await f.shelves.listShelves()).shelfIds).toEqual([]);
        },
    );

    it("concurrent duplicate intent is refused while one captured prompt is outstanding", async () => {
        const f = await fixture();
        let finish!: (name: string) => void;
        let opened!: () => void;
        const opening = new Promise<void>((resolve) => {
            opened = resolve;
        });
        vi.mocked(vscode.window.showInputBox).mockImplementationOnce(
            () =>
                new Promise<string>((resolve) => {
                    finish = resolve;
                    opened();
                }),
        );
        const firstSave = host.handle(f.request);
        await opening;
        await host.handle(f.request);
        finish("one shelf");
        await firstSave;
        expect(
            (await f.shelves.listShelves()).shelfIds,
            "concurrent duplicate never publishes twice",
        ).toHaveLength(1);
        expect(vscode.window.showInputBox).toHaveBeenCalledTimes(1);
    });

    it.each(["source", "draft", "dirty whole path"])(
        "captured whole-file %s changes refuse publication",
        async (changed) => {
            const f = await fixture();
            const save = f.service.saveSelectedChanges.bind(f.service);
            vi.spyOn(f.service, "saveSelectedChanges").mockImplementationOnce(async (...args) => {
                if (changed === "source")
                    await writeFile(path.join(root, "file.txt"), `${working}later\n`);
                if (changed === "draft") {
                    const [plan, lease, revision, scope, guard] = args;
                    return save(
                        {
                            ...plan,
                            sourceLists: plan.sourceLists.map((source) => ({
                                ...source,
                                draft: "forged draft",
                            })),
                        },
                        lease,
                        revision,
                        scope,
                        guard,
                    );
                }
                if (changed === "dirty whole path")
                    (vscode.workspace.textDocuments as unknown[]).push({
                        uri: { scheme: "file", fsPath: path.join(root, "file.txt") },
                        isDirty: true,
                        isClosed: false,
                    });
                return save(...args);
            });
            await host.handle({ ...f.request, scope: "files", listId: "all", paths: ["file.txt"] });
            expect(
                (await f.shelves.listShelves()).shelfIds,
                "stale whole-file input never publishes",
            ).toEqual([]);
            expect(posted).toContainEqual(
                expect.objectContaining({
                    type: "changelistShelfResult",
                    error: expect.any(String),
                }),
            );
        },
    );

    it("foreign origin cannot redirect a scoped save", async () => {
        const f = await fixture();
        await expect(
            host.handle({ ...f.request, repositoryRoot: `${root}-other` }),
        ).rejects.toThrow(/repository/);
        expect((await f.shelves.listShelves()).shelfIds).toEqual([]);
        expect(vscode.window.showInputBox).not.toHaveBeenCalled();
    });

    it("scoped save cleanup retains durable identity and prevents duplicate replay", async () => {
        const f = await fixture();
        const lock = f.shelves.withLock.bind(f.shelves);
        vi.spyOn(f.shelves, "withLock").mockImplementationOnce(async (operation) => {
            await lock(operation);
            throw new Error("cleanup failed");
        });
        await host.handle(f.request);
        const ids = (await f.shelves.listShelves()).shelfIds;
        expect(ids).toHaveLength(1);
        expect(posted, "scoped cleanup reports saved identity").toContainEqual(
            expect.objectContaining({
                type: "changelistShelfResult",
                error: expect.stringContaining(ids[0]),
            }),
        );
        await host.handle(f.request);
        expect((await f.shelves.listShelves()).shelfIds).toEqual(ids);
    });
});

describe("selected shelf host operations", () => {
    it("rollback retains independent recovery shelf and confirms before capture", async () => {
        const editor = await selectedShelfEditor();
        vi.mocked(vscode.window.showWarningMessage).mockImplementationOnce(async () => {
            expect(
                (await editor.shelves.listShelves()).shelfIds,
                "rollback confirmation precedes independent recovery capture",
            ).toHaveLength(0);
            return "Rollback Selected Changes" as never;
        });
        await editor.panel.receiveMessage({
            type: "rollbackSelection",
            selection: editor.selection,
        });
        const ids = (await editor.shelves.listShelves()).shelfIds;
        expect(ids, "rollback retains independent recovery shelf").toHaveLength(1);
        expect(await readFile(path.join(root, "file.txt"), "utf8")).toBe(
            base.replace("line 80\n", "remaining\n"),
        );
        expect(editor.messages).toContainEqual(
            expect.objectContaining({
                type: "partialOperationCompleted",
                removed: true,
                message: expect.stringContaining(ids[0]),
            }),
        );
    });

    it("consumes metadata with the actual held lease and refuses forged released and foreign handles", async () => {
        const editor = await selectedShelfEditor();
        const snapshot = editor.messages.find(
            (message) => message.type === "partialFile",
        )! as Extract<PartialEditorReply, { type: "partialFile" }>;
        const foreign = new ChangelistStore();
        await foreign.connect(root, path.join(root, ".git"));
        const lease = await store.acquireTargetOperationLease(root);
        const consume = async (handle: typeof lease) =>
            store.consumeCommitted(
                root,
                "file.txt",
                snapshot.contentId,
                "all",
                new Set(),
                new Set(),
                4,
                undefined,
                handle,
            );
        try {
            await expect(consume({ ...lease })).rejects.toThrow(/lease/);
            await expect(async () =>
                foreign.consumeCommitted(
                    root,
                    "file.txt",
                    snapshot.contentId,
                    "all",
                    new Set(),
                    new Set(),
                    4,
                    undefined,
                    lease,
                ),
            ).rejects.toThrow(/lease/);
            await expect(
                consume(lease),
                "real held lease permits completed consumption without reentrant acquire",
            ).resolves.toMatchObject({ revision: expect.any(Number) });
        } finally {
            await lease.release();
        }
        await expect(consume(lease)).rejects.toThrow(/lease/);
    });
    it("partial removal preserves other-list lines and index bytes after durable save", async () => {
        const editor = await selectedShelfEditor();
        const removalShelfCounts: number[] = [];
        const remove = editor.service.removeSelectedChanges.bind(editor.service);
        vi.spyOn(editor.service, "removeSelectedChanges").mockImplementation(async (...args) => {
            removalShelfCounts.push((await editor.shelves.listShelves()).shelfIds.length);
            return remove(...args);
        });
        const data = editor.messages.find((message) => message.type === "partialFile")! as Extract<
            PartialEditorReply,
            { type: "partialFile" }
        >;
        const created = await store.create(root, store.revision(root), "Other owner");
        const other = created.lists.find((list) => list.id !== "default")!.id;
        const otherFingerprints = data.file.blocks[1].lines
            .filter((line) => line.kind !== "context")
            .map((line) => line.fingerprint);
        await store.assignChanges(
            root,
            store.revision(root),
            "file.txt",
            data.contentId,
            other,
            otherFingerprints,
            new Set(
                data.file.blocks
                    .flatMap((block) => block.lines)
                    .filter((line) => line.kind !== "context")
                    .map((line) => line.fingerprint),
            ),
        );
        const before = store.get(root);
        const index = await readFile(path.join(root, ".git/index"));
        vi.mocked(vscode.window.showWarningMessage).mockImplementationOnce(async () => {
            expect(
                (await editor.shelves.listShelves()).shelfIds,
                "durable save precedes removal",
            ).toHaveLength(1);
            const lease = await store.acquireTargetOperationLease(root);
            await lease.release();
            return "Remove Selected Changes" as never;
        });
        await editor.panel.receiveMessage({ type: "shelveSelection", selection: editor.selection });
        expect(removalShelfCounts, "removal begins only after durable shelf publication").toEqual([
            1,
        ]);
        expect(
            await readFile(path.join(root, "file.txt"), "utf8"),
            "selected removal preserves the remainder",
        ).toBe(base.replace("line 80\n", "remaining\n"));
        expect(await readFile(path.join(root, ".git/index"))).toEqual(index);
        expect(store.get(root).lists).toEqual(before.lists);
        expect(
            Object.values(store.get(root).changes["file.txt"].lines),
            "non-selected ownership survives removal",
        ).toEqual([other, other]);
        expect(editor.messages).toContainEqual(
            expect.objectContaining({ type: "partialOperationCompleted", removed: true }),
        );
    });

    it("removal metadata failure reports saved recovery and completed Git without retry", async () => {
        const editor = await selectedShelfEditor();
        vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce(
            "Remove Selected Changes" as never,
        );
        vi.spyOn(store, "consumeCommitted").mockRejectedValueOnce(
            new Error("metadata unavailable"),
        );
        const remove = vi.spyOn(PartialChanges.prototype, "rollback");
        await editor.panel.receiveMessage({ type: "shelveSelection", selection: editor.selection });
        const ids = (await editor.shelves.listShelves()).shelfIds;
        expect(ids).toHaveLength(1);
        expect(await readFile(path.join(root, "file.txt"), "utf8")).toBe(
            base.replace("line 80\n", "remaining\n"),
        );
        expect(editor.messages).toContainEqual(
            expect.objectContaining({
                type: "partialOperationCompleted",
                removed: true,
                message: expect.stringContaining("do not repeat"),
            }),
        );
        expect(editor.messages).toContainEqual(
            expect.objectContaining({ message: expect.stringContaining(ids[0]) }),
        );
        await editor.panel.receiveMessage({ type: "shelveSelection", selection: editor.selection });
        expect(remove, "completed operation cannot replay in this editor").toHaveBeenCalledTimes(1);
    });

    it("rejects malformed partial shelf requests before capture", async () => {
        const editor = await selectedShelfEditor();
        const save = vi.spyOn(editor.service, "saveSelectedChanges");
        for (const selection of [
            null,
            { snapshotId: editor.selection.snapshotId, lineIds: [42] },
            { snapshotId: "foreign", lineIds: [] },
        ])
            await editor.panel.receiveMessage({ type: "saveSelection", selection });
        expect(save).not.toHaveBeenCalled();
        expect((await editor.shelves.listShelves()).shelfIds).toEqual([]);
        expect(editor.messages.filter((message) => message.type === "partialError")).toHaveLength(
            3,
        );
    });

    it.each(["metadata release", "completion delivery"])(
        "%s failure after removal reports completion and retained recovery without retry",
        async (failure) => {
            const editor = await selectedShelfEditor();
            vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce(
                "Remove Selected Changes" as never,
            );
            if (failure === "metadata release") {
                const acquire = ChangelistPersistence.prototype.acquire;
                let acquisitions = 0;
                vi.spyOn(ChangelistPersistence.prototype, "acquire").mockImplementation(
                    async function (this: ChangelistPersistence) {
                        const release = await acquire.call(this);
                        const removalLease = ++acquisitions === 2;
                        return async () => {
                            await release();
                            if (removalLease) throw new Error("injected metadata release failure");
                        };
                    },
                );
            } else {
                const post = editor.panel.webview.postMessage.bind(editor.panel.webview);
                vi.spyOn(editor.panel.webview, "postMessage").mockImplementation(
                    async (message) => {
                        if ((message as PartialEditorReply).type === "partialOperationCompleted")
                            throw new Error("injected completion delivery failure");
                        return post(message);
                    },
                );
            }
            const remove = vi.spyOn(PartialChanges.prototype, "rollback");
            await editor.panel.receiveMessage({
                type: "shelveSelection",
                selection: editor.selection,
            });
            const ids = (await editor.shelves.listShelves()).shelfIds;
            expect(ids).toHaveLength(1);
            expect(await readFile(path.join(root, "file.txt"), "utf8")).toBe(
                base.replace("line 80\n", "remaining\n"),
            );
            expect(
                editor.messages,
                "completed removal retains a visible recovery identity",
            ).toContainEqual(expect.objectContaining({ message: expect.stringContaining(ids[0]) }));
            expect(editor.messages, "post-removal failure must prohibit retry").toContainEqual(
                expect.objectContaining({ message: expect.stringContaining("do not repeat") }),
            );
            await editor.panel.receiveMessage({
                type: "shelveSelection",
                selection: editor.selection,
            });
            expect(
                remove,
                "completed operation cannot replay after cleanup or delivery failure",
            ).toHaveBeenCalledTimes(1);
        },
    );

    it("selected export refuses the source file and Git index as native destinations", async () => {
        const editor = await selectedShelfEditor();
        const index = await readFile(path.join(root, ".git/index"));
        for (const file of ["file.txt", ".git/index"]) {
            Object.defineProperty(vscode.window, "showSaveDialog", {
                configurable: true,
                value: vi.fn().mockResolvedValue({ scheme: "file", fsPath: path.join(root, file) }),
            });
            await editor.panel.receiveMessage({
                type: "exportSelection",
                selection: editor.selection,
            });
            expect(
                await readFile(path.join(root, "file.txt"), "utf8"),
                "export preserves selected source bytes",
            ).toBe(working);
            expect(
                await readFile(path.join(root, ".git/index")),
                "export preserves exact index bytes",
            ).toEqual(index);
        }
    });

    it("selected export refuses a hard-linked HEAD alias before truncating Git state", async () => {
        const editor = await selectedShelfEditor();
        const target = path.join(root, "head-alias.patch");
        const headFile = path.join(root, ".git/HEAD");
        const head = await readFile(headFile);
        const index = await readFile(path.join(root, ".git/index"));
        await link(headFile, target);
        Object.defineProperty(vscode.window, "showSaveDialog", {
            configurable: true,
            value: vi.fn().mockResolvedValue({ scheme: "file", fsPath: target }),
        });
        await editor.panel.receiveMessage({ type: "exportSelection", selection: editor.selection });
        expect(
            await readFile(headFile),
            "export must not truncate HEAD through an outside hard link",
        ).toEqual(head);
        expect(await readFile(path.join(root, ".git/index"))).toEqual(index);
        expect(await readFile(path.join(root, "file.txt"), "utf8")).toBe(working);
        expect(editor.messages).toContainEqual(expect.objectContaining({ type: "partialError" }));
    });

    it.each(["revision", "dirty buffer"])(
        "stale postpreview %s retains saved recovery and refuses removal",
        async (kind) => {
            const editor = await selectedShelfEditor();
            const remove = vi.spyOn(PartialChanges.prototype, "rollback");
            vi.mocked(vscode.window.showWarningMessage).mockImplementationOnce(async () => {
                if (kind === "revision") await store.saveDraft(root, "default", "", "later draft");
                else
                    (vscode.workspace.textDocuments as unknown[]).push({
                        isDirty: true,
                        uri: { scheme: "file", fsPath: path.join(root, "file.txt") },
                    });
                return "Remove Selected Changes" as never;
            });
            await editor.panel.receiveMessage({
                type: "shelveSelection",
                selection: editor.selection,
            });
            const ids = (await editor.shelves.listShelves()).shelfIds;
            expect(ids).toHaveLength(1);
            expect(await readFile(path.join(root, "file.txt"), "utf8")).toBe(working);
            expect(editor.messages).toContainEqual(
                expect.objectContaining({
                    type: "partialError",
                    message: expect.stringContaining(ids[0]),
                }),
            );
            expect(remove).not.toHaveBeenCalled();
        },
    );

    it("save alone never calls removal and preserves exact source drafts and inclusion", async () => {
        const editor = await selectedShelfEditor();
        await store.saveDraft(root, "default", "", " exact source draft 名前\n");
        await store.saveDraft(root, "all", "", "separate aggregate draft");
        const before = store.get(root);
        const index = await readFile(path.join(root, ".git/index"));
        const remove = vi.spyOn(PartialChanges.prototype, "rollback");
        await editor.panel.receiveMessage({ type: "saveSelection", selection: editor.selection });
        expect(editor.messages.filter((message) => message.type === "partialError")).toEqual([]);
        const catalog = await editor.shelves.listShelves();
        expect(catalog.shelfIds, "save publishes one durable shelf").toHaveLength(1);
        expect(remove, "save alone never calls removal").not.toHaveBeenCalled();
        expect(await readFile(path.join(root, "file.txt"), "utf8")).toBe(working);
        expect(await readFile(path.join(root, ".git/index"))).toEqual(index);
        expect(store.get(root)).toEqual(before);
        const saved = await editor.service.getShelfManifest(catalog.shelfIds[0]);
        expect(saved.metadata.selection?.sourceLists).toEqual(
            before.lists.map((list) => ({
                id: list.id,
                name: list.name,
                description: list.description ?? "",
                draft: list.draft ?? "",
            })),
        );
        expect(saved.metadata.selection?.scopeDraft).toBe("separate aggregate draft");
    });

    it("service rejects forged released and foreign metadata leases before capture", async () => {
        const editor = await selectedShelfEditor();
        const save = vi.spyOn(editor.service, "saveSelectedChanges");
        await editor.panel.receiveMessage({ type: "saveSelection", selection: editor.selection });
        const [plan, released, revision, scope, guard] = save.mock.calls[0];
        await expect(
            editor.service.saveSelectedChanges(plan, released, revision, scope, guard),
        ).rejects.toThrow(/lease/);
        const lease = await store.acquireTargetOperationLease(root);
        try {
            await expect(
                editor.service.saveSelectedChanges(plan, { ...lease }, revision, scope, guard),
            ).rejects.toThrow(/lease/);
        } finally {
            await lease.release();
        }
        const foreign = new ChangelistStore();
        await foreign.connect(root, path.join(root, ".git"));
        const foreignLease = await foreign.acquireTargetOperationLease(root);
        try {
            await expect(
                editor.service.saveSelectedChanges(plan, foreignLease, revision, scope, guard),
            ).rejects.toThrow(/lease/);
        } finally {
            await foreignLease.release();
        }
        expect(
            (await editor.shelves.listShelves()).shelfIds,
            "invalid capability cannot publish another shelf",
        ).toHaveLength(1);
    });

    it("save lock-release failure reports durable shelf identity without removing local changes", async () => {
        const editor = await selectedShelfEditor();
        const locked = editor.shelves.withLock.bind(editor.shelves);
        vi.spyOn(editor.shelves, "withLock").mockImplementationOnce(async (operation) => {
            await locked(operation);
            throw new Error("injected shelf lock release failure");
        });
        const before = store.get(root);
        await editor.panel.receiveMessage({ type: "saveSelection", selection: editor.selection });
        const ids = (await editor.shelves.listShelves()).shelfIds;
        expect(ids).toHaveLength(1);
        expect(
            editor.messages,
            "durable save cleanup failure retains saved shelf identity",
        ).toContainEqual(
            expect.objectContaining({
                type: "partialError",
                message: expect.stringContaining(ids[0]),
            }),
        );
        expect(editor.messages, "durable save cleanup failure warns against repeat").toContainEqual(
            expect.objectContaining({ message: expect.stringContaining("do not repeat") }),
        );
        expect(await readFile(path.join(root, "file.txt"), "utf8")).toBe(working);
        expect(store.get(root)).toEqual(before);
    });

    it.each(["false result", "disposed panel"])(
        "selected save completion with %s warns natively and prevents repeat",
        async (failure) => {
            const editor = await selectedShelfEditor();
            const save = editor.service.saveSelectedChanges.bind(editor.service);
            const saves = vi
                .spyOn(editor.service, "saveSelectedChanges")
                .mockImplementation(async (...args) => {
                    const result = await save(...args);
                    if (failure === "disposed panel") editor.panel.dispose();
                    return result;
                });
            if (failure === "false result") {
                const post = editor.panel.webview.postMessage.bind(editor.panel.webview);
                vi.spyOn(editor.panel.webview, "postMessage").mockImplementation(async (message) =>
                    (message as PartialEditorReply).type === "partialOperationCompleted"
                        ? false
                        : post(message),
                );
            }
            await editor.panel.receiveMessage({
                type: "saveSelection",
                selection: editor.selection,
            });
            const ids = (await editor.shelves.listShelves()).shelfIds;
            expect(ids).toHaveLength(1);
            expect(
                vscode.window.showWarningMessage,
                "undelivered completion exposes saved recovery identity natively",
            ).toHaveBeenCalledWith(expect.stringContaining(ids[0]));
            expect(
                vscode.window.showWarningMessage,
                "undelivered completion forbids repeating the completed save",
            ).toHaveBeenCalledWith(expect.stringContaining("do not repeat"));
            await editor.panel.receiveMessage({
                type: "saveSelection",
                selection: editor.selection,
            });
            expect(
                saves,
                "failed completion delivery fences duplicate saves",
            ).toHaveBeenCalledTimes(1);
            expect(await readFile(path.join(root, "file.txt"), "utf8")).toBe(working);
        },
    );

    it("combined save cleanup failures preserve the durable shelf identity", async () => {
        const editor = await selectedShelfEditor();
        const locked = editor.shelves.withLock.bind(editor.shelves);
        vi.spyOn(editor.shelves, "withLock").mockImplementationOnce(async (operation) => {
            await locked(operation);
            throw new Error("injected shelf lock release failure");
        });
        const acquire = ChangelistPersistence.prototype.acquire;
        vi.spyOn(ChangelistPersistence.prototype, "acquire").mockImplementationOnce(async function (
            this: ChangelistPersistence,
        ) {
            const release = await acquire.call(this);
            return async () => {
                await release();
                throw new Error("injected metadata release failure");
            };
        });
        await editor.panel.receiveMessage({ type: "saveSelection", selection: editor.selection });
        const ids = (await editor.shelves.listShelves()).shelfIds;
        expect(ids).toHaveLength(1);
        expect(
            editor.messages,
            "secondary metadata cleanup must preserve the saved shelf identity",
        ).toContainEqual(
            expect.objectContaining({
                type: "partialError",
                message: expect.stringContaining(ids[0]),
            }),
        );
        expect(
            editor.messages,
            "combined cleanup failures still warn against repeating the durable save",
        ).toContainEqual(
            expect.objectContaining({ message: expect.stringContaining("do not repeat") }),
        );
        expect(await readFile(path.join(root, "file.txt"), "utf8")).toBe(working);
    });

    it.each(["false result", "disposed panel"])(
        "selected save cleanup error with %s retains its native recovery notice without retry",
        async (failure) => {
            const editor = await selectedShelfEditor();
            const locked = editor.shelves.withLock.bind(editor.shelves);
            vi.spyOn(editor.shelves, "withLock").mockImplementationOnce(async (operation) => {
                await locked(operation);
                if (failure === "disposed panel") editor.panel.dispose();
                throw new Error("injected shelf lock release failure");
            });
            if (failure === "false result") {
                const post = editor.panel.webview.postMessage.bind(editor.panel.webview);
                vi.spyOn(editor.panel.webview, "postMessage").mockImplementation(async (message) =>
                    (message as PartialEditorReply).type === "partialError" ? false : post(message),
                );
            }
            const saves = vi.spyOn(editor.service, "saveSelectedChanges");
            await editor.panel.receiveMessage({
                type: "saveSelection",
                selection: editor.selection,
            });
            const ids = (await editor.shelves.listShelves()).shelfIds;
            expect(ids).toHaveLength(1);
            expect(
                vscode.window.showWarningMessage,
                "undeliverable selected error preserves the saved identity natively",
            ).toHaveBeenCalledWith(expect.stringContaining(ids[0]));
            expect(
                vscode.window.showWarningMessage,
                "native recovery notice preserves the host cleanup error",
            ).toHaveBeenCalledWith(
                expect.stringContaining("was saved. Lock cleanup failed; do not repeat the save."),
            );
            await editor.panel.receiveMessage({
                type: "saveSelection",
                selection: editor.selection,
            });
            expect(
                saves,
                "undeliverable cleanup failure cannot repeat the save",
            ).toHaveBeenCalledTimes(1);
        },
    );

    it("exports only host-generated selected bytes to the native destination without consuming metadata", async () => {
        const editor = await selectedShelfEditor();
        const before = store.get(root);
        const target = path.join(root, "selected.patch");
        Object.defineProperty(vscode.window, "showSaveDialog", {
            configurable: true,
            value: vi.fn().mockResolvedValue({ scheme: "file", fsPath: target }),
        });
        await editor.panel.receiveMessage({
            type: "exportSelection",
            selection: editor.selection,
            path: path.join(root, "file.txt"),
            patch: "forged",
        });
        const patch = await readFile(target, "utf8");
        expect(patch).toContain("+selected");
        expect(patch).not.toContain("remaining");
        expect(patch).not.toContain("forged");
        expect(store.get(root)).toEqual(before);
    });

    it("cancel removal retains shelf and every local byte with all locks released at confirmation", async () => {
        const editor = await selectedShelfEditor();
        const before = store.get(root);
        const index = await readFile(path.join(root, ".git/index"));
        const remove = vi.spyOn(PartialChanges.prototype, "rollback");
        vi.mocked(vscode.window.showWarningMessage).mockImplementationOnce(async () => {
            expect(
                (await editor.shelves.listShelves()).shelfIds,
                "save precedes confirmation",
            ).toHaveLength(1);
            const lease = await store.acquireTargetOperationLease(root);
            await lease.release();
            return undefined;
        });
        await editor.panel.receiveMessage({ type: "shelveSelection", selection: editor.selection });
        expect(editor.messages.filter((message) => message.type === "partialError")).toEqual([]);
        expect(
            (await editor.shelves.listShelves()).shelfIds,
            "cancel keeps the durable shelf",
        ).toHaveLength(1);
        expect(remove).not.toHaveBeenCalled();
        expect(await readFile(path.join(root, "file.txt"), "utf8")).toBe(working);
        expect(await readFile(path.join(root, ".git/index"))).toEqual(index);
        expect(store.get(root)).toEqual(before);
    });
});

/** Snapshots Git bytes without status refreshes that could rewrite the index. */
async function nativeGitSnapshot() {
    return {
        head: git(["rev-parse", "HEAD"]),
        index: await readFile(path.resolve(root, git(["rev-parse", "--git-path", "index"]).trim())),
        worktree: await readFile(path.join(root, "file.txt")),
        staged: git(["diff", "--cached", "--binary"]),
        unstaged: git(["diff", "--binary"]),
    };
}

/** Completes the real partial panel's ready exchange and requires usable file data. */
async function readyNativePanel() {
    const panel = getCreatedWebviewPanels().at(-1)!;
    const messages: PartialEditorReply[] = [];
    panel.webview.postMessage = (message: unknown) => {
        messages.push(message as PartialEditorReply);
        return Promise.resolve(true);
    };
    await panel.receiveMessage({ type: "ready" });
    const data = messages.find((message) => message.type === "partialFile");
    expect(data, JSON.stringify(messages)).toBeDefined();
    if (!data || data.type !== "partialFile") throw new Error("Missing native partial data");
    return data;
}

describe("root-bound selected-change host", () => {
    it("reports each persistent poll failure once and reports it again after recovery", async () => {
        host.dispose();
        vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
        try {
            host = new ChangeWorkflowHost(hostDeps);
            await host.reconcile(hostDeps.files());
            await host.settled();
            vi.advanceTimersByTime(1000);
            posted.length = 0;
            let failure: string | undefined;
            const get = store.revision.bind(store);
            const reads = vi.spyOn(store, "revision").mockImplementation((repositoryRoot) => {
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

    it("native entry opens a usable aggregate editor without changing scope or Git state", async () => {
        const created = await store.create(root, store.get(root).revision, "Native list");
        const id = created.lists.find((list) => list.name === "Native list")!.id;
        await store.activate(root, store.get(root).revision, id);
        await store.saveDraft(root, "all", "", "aggregate draft");
        await store.saveDraft(root, id, "", "named draft");
        store.selectDraft(root, id);
        const before = store.get(root);
        const gitBefore = await nativeGitSnapshot();
        await host.openFromEditor("file.txt");
        const data = await readyNativePanel();
        expect(data).toMatchObject({ listId: "all", file: { path: "file.txt" } });
        expect(JSON.stringify(data.file.blocks)).toContain("selected");
        expect(JSON.stringify(data.file.blocks)).toContain("remaining");
        expect(store.get(root).activeId).toBe(before.activeId);
        expect(store.get(root).lists).toEqual(before.lists);
        expect(store.get(root).allDraft).toBe(before.allDraft);
        expect(store.mirrorScope(root)).toBe(id);
        expect(
            await nativeGitSnapshot(),
            "opening must preserve HEAD, raw index, worktree and diffs",
        ).toEqual(gitBefore);
    });

    it.each(["../outside.txt", "/outside.txt"])(
        "native entry rejects traversal before connecting or opening a panel: %s",
        async (file) => {
            host.dispose();
            host = new ChangeWorkflowHost(hostDeps);
            const connect = vi.spyOn(ChangelistStore.prototype, "connect");
            await expect(
                host.openFromEditor(file),
                "unsafe native paths must reject",
            ).rejects.toThrow();
            expect(
                connect,
                "unsafe native paths must reject before connecting",
            ).not.toHaveBeenCalled();
            expect(getCreatedWebviewPanels()).toHaveLength(0);
        },
    );

    it("native entry accepts a nested repository-relative filename", async () => {
        await mkdir(path.join(root, "nested"));
        await writeFile(path.join(root, "nested/file.txt"), "nested base\n");
        git(["add", "nested/file.txt"]);
        git(["commit", "-qm", "nested baseline"]);
        await writeFile(path.join(root, "nested/file.txt"), "nested change\n");
        await host.openFromEditor("nested/file.txt");
        const data = await readyNativePanel();
        expect(data.file.path).toBe("nested/file.txt");
        expect(JSON.stringify(data.file.blocks)).toContain("nested change");
    });

    it("native entry waits for durable connection before opening a panel", async () => {
        host.dispose();
        host = new ChangeWorkflowHost(hostDeps);
        let finish!: () => void;
        const pending = new Promise<void>((resolve) => {
            finish = resolve;
        });
        const connect = vi
            .spyOn(ChangelistStore.prototype, "connect")
            .mockImplementationOnce(() => pending);
        const opening = host.openFromEditor("file.txt");
        try {
            await vi.waitFor(() => expect(connect).toHaveBeenCalledOnce());
            expect(
                getCreatedWebviewPanels().length,
                "native entry must not open before durable connection",
            ).toBe(0);
        } finally {
            finish();
            await opening;
        }
        expect(getCreatedWebviewPanels()).toHaveLength(1);
    });

    it("native entry propagates durable connection failure without opening a panel", async () => {
        host.dispose();
        host = new ChangeWorkflowHost(hostDeps);
        const connect = vi
            .spyOn(ChangelistStore.prototype, "connect")
            .mockRejectedValueOnce(new Error("native durable failure"));
        await expect(host.openFromEditor("file.txt")).rejects.toThrow("native durable failure");
        expect(getCreatedWebviewPanels()).toHaveLength(0);
        connect.mockRestore();
        await host.openFromEditor("file.txt");
        expect((await readyNativePanel()).file.path).toBe("file.txt");
    });

    it("native entry preserves interrupted-publication recovery", async () => {
        const partial = gitOps.partialChangesFor(root);
        const view = await partial.open("file.txt");
        await expect(
            partial.commit(
                [{ snapshotId: view.snapshotId, lineIds: changeIds(view.blocks.slice(0, 1)) }],
                "recoverable native",
                () => undefined,
                {
                    afterPublish: async () => {
                        throw new Error("native crash boundary");
                    },
                },
            ),
        ).rejects.toThrow("commit succeeded");
        const committed = git(["rev-parse", "HEAD"]);
        const journals = path.join(root, ".git/intelligit/partial-index");
        expect(await readdir(journals)).toHaveLength(1);
        expect(git(["show", ":file.txt"])).toBe(base);
        await host.openFromEditor("file.txt");
        const data = await readyNativePanel();
        expect(data.file.path).toBe("file.txt");
        expect(git(["rev-parse", "HEAD"])).toBe(committed);
        expect(git(["show", ":file.txt"]), "native ready must recover the prepared index").toBe(
            first,
        );
        expect(await readFile(path.join(root, "file.txt"), "utf8")).toBe(working);
        expect(await partial.recover()).toBe(false);
        expect(partial.recoveryIssues()).toEqual([]);
        expect(await readdir(journals)).toEqual([]);
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
            await host.settled();
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
            const view = await new PartialChanges(new GitExecutor(root), root).open("file.txt");
            const fingerprints = view.blocks.flatMap((block) =>
                block.lines
                    .filter((line) => line.kind !== "context")
                    .map((line) => line.fingerprint),
            );
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
            await host.settled();
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
        await host.settled();
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
        await host.settled();
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
        await host.settled();
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
        await host.settled();
        git(["rm", "-f", "file.txt"]);
        await host.reconcile(await gitOps.getStatus({ withStats: false }));
        await host.settled();
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

    it("keeps actions usable while overlapping range reconciliations are pending", async () => {
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
            expect(posted.at(-1), "queued range scans must not disable actions").toMatchObject({
                type: "setChangelists",
                busy: false,
            });
            await store.saveDraft(root, "all", "", "another pane's draft");
            expect(
                posted.at(-1),
                "intermediate metadata delivery must keep actions usable",
            ).toMatchObject({ type: "setChangelists", busy: false });
            finishFirst();
            await firstRefresh;
            expect(
                posted.at(-1),
                "a finished refresh's membership update must release busy",
            ).toMatchObject({ type: "setChangelists", busy: false });
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
        await host.reconcile([]);
        await host.settled();
        expect(posted, "the host reports the failed range pass").toContainEqual({
            type: "error",
            repositoryRoot: root,
            message: "Changelist action failed: injected range observation failure",
        });
        expect(
            posted
                .filter((message) => (message as { type?: string }).type === "setChangelists")
                .at(-1),
        ).toMatchObject({ busy: false });
    });

    it("holds no refresh's files while one range pass runs, then prunes once with the newest epoch", async () => {
        setFlagsFromString("--expose-gc");
        const gc = runInNewContext("gc") as unknown;
        if (typeof gc !== "function") throw new Error("--expose-gc did not provide gc()");
        let finishPass!: () => void;
        const pass = new Promise<void>((resolve) => {
            finishPass = resolve;
        });
        // Every refresh during a running pass shares one queued pass, as the real tracker does.
        const scan = vi.spyOn(ChangeRangeTracker.prototype, "reconcile").mockReturnValue(pass);
        const membership = vi.spyOn(store, "reconcileFiles").mockResolvedValue(undefined);
        let epoch = 100;
        vi.spyOn(store, "observerEpoch").mockImplementation(() => ++epoch);
        const status = await gitOps.getStatus({ withStats: false });
        const held: WeakRef<object>[] = [];
        // A sync helper owns each array: a local in this async test would stay in its own frame.
        const refresh = () => {
            const files = status.map((file) => ({ ...file }));
            held.push(new WeakRef(files));
            return host.reconcile(files);
        };
        const refreshes: Promise<void>[] = [];
        for (let i = 1; i <= 5; i++) {
            refreshes.push(refresh());
            await vi.waitFor(() => expect(scan).toHaveBeenCalledTimes(i));
        }
        // The spy's own call log would otherwise keep every array alive.
        scan.mockClear();
        for (let round = 0; round < 3; round++) {
            gc();
            await new Promise((resolve) => setImmediate(resolve));
        }
        expect(
            held.filter((ref) => ref.deref() !== undefined),
            "a refresh waiting on the shared pass must not keep its files array",
        ).toHaveLength(0);
        finishPass();
        await Promise.all(refreshes);
        expect(
            membership.mock.calls.slice(5).map((call) => call[2]),
            "one prune per finished pass, with the newest refresh's epoch",
        ).toEqual([epoch]);
    });

    it("settles each refresh before the shared prune, so its caller's handlers drop their files", async () => {
        setFlagsFromString("--expose-gc");
        const gc = runInNewContext("gc") as unknown;
        if (typeof gc !== "function") throw new Error("--expose-gc did not provide gc()");
        let finishPass!: () => void;
        const pass = new Promise<void>((resolve) => {
            finishPass = resolve;
        });
        const scan = vi.spyOn(ChangeRangeTracker.prototype, "reconcile").mockReturnValue(pass);
        const membership = vi.spyOn(store, "reconcileFiles").mockResolvedValue(undefined);
        const status = await gitOps.getStatus({ withStats: false });
        const held: WeakRef<object>[] = [];
        // Like the commit panel, each caller's error handler shares a scope that holds its files.
        const refresh = () => {
            const files = status.map((file) => ({ ...file }));
            held.push(new WeakRef(files));
            return host.reconcile(files).catch(() => files.length);
        };
        const refreshes: Promise<unknown>[] = [];
        for (let i = 1; i <= 5; i++) {
            refreshes.push(refresh());
            await vi.waitFor(() => expect(scan).toHaveBeenCalledTimes(i));
        }
        scan.mockClear();
        try {
            for (let round = 0; round < 3; round++) {
                gc();
                await new Promise((resolve) => setImmediate(resolve));
            }
            expect(
                held.filter((ref) => ref.deref() !== undefined),
                "a caller's handler on a refresh must not keep its files while the shared pass runs",
            ).toHaveLength(0);
        } finally {
            finishPass();
            await Promise.all(refreshes);
        }
        await vi.waitFor(() => expect(membership).toHaveBeenCalledTimes(6));
    });

    it("prunes each range pass once, with the newest refresh's files and epoch", async () => {
        let finishFirst!: () => void;
        let finishSecond!: () => void;
        const firstPass = new Promise<void>((resolve) => {
            finishFirst = resolve;
        });
        const secondPass = new Promise<void>((resolve) => {
            finishSecond = resolve;
        });
        // The first refresh starts a pass; later ones join the pass queued behind it.
        const scan = vi
            .spyOn(ChangeRangeTracker.prototype, "reconcile")
            .mockReturnValueOnce(firstPass)
            .mockReturnValue(secondPass);
        const membership = vi.spyOn(store, "reconcileFiles").mockResolvedValue(undefined);
        let epoch = 200;
        vi.spyOn(store, "observerEpoch").mockImplementation(() => ++epoch);
        const files = await gitOps.getStatus({ withStats: false });
        // The last refresh to join the queued pass lists a file the earlier ones lack.
        const last = [
            ...files,
            ...files.slice(0, 1).map((file) => ({ ...file, path: "joined-last.txt", status: "M" })),
        ];
        const pathsOf = (list: typeof files) =>
            list.filter((file) => file.status !== "!").map((file) => file.path);
        expect(pathsOf(last)).not.toEqual(pathsOf(files));
        const refreshes: Promise<void>[] = [];
        for (let i = 1; i <= 3; i++) {
            refreshes.push(host.reconcile(i === 3 ? last : files));
            await vi.waitFor(() => expect(scan).toHaveBeenCalledTimes(i));
        }
        finishFirst();
        await refreshes[0];
        finishSecond();
        await Promise.all(refreshes);
        expect(
            membership.mock.calls.slice(3).map((call) => call[2]),
            "each pass prunes once, with the newest refresh's epoch",
        ).toEqual([203, 203]);
        expect(
            membership.mock.calls.slice(3).map((call) => call[1]),
            "a running pass prunes with the newest refresh's files, even one queued behind it",
        ).toEqual([pathsOf(last), pathsOf(last)]);
    });

    it("keeps a newer refresh's file in the list it was moved to through an earlier pass's prune", async () => {
        let finishFirst!: () => void;
        let finishSecond!: () => void;
        const firstPass = new Promise<void>((resolve) => {
            finishFirst = resolve;
        });
        const secondPass = new Promise<void>((resolve) => {
            finishSecond = resolve;
        });
        const scan = vi
            .spyOn(ChangeRangeTracker.prototype, "reconcile")
            .mockReturnValueOnce(firstPass)
            .mockReturnValue(secondPass);
        const membership = vi.spyOn(store, "reconcileFiles");
        const files = await gitOps.getStatus({ withStats: false });
        const later = [...files, { ...files[0]!, path: "late.txt", status: "?" }];
        const refreshes = [host.reconcile(files)];
        await vi.waitFor(() => expect(scan).toHaveBeenCalledTimes(1));
        // The later refresh joins the queued pass only after its own first pass listed the file.
        refreshes.push(host.reconcile(later));
        await vi.waitFor(() => expect(scan).toHaveBeenCalledTimes(2));
        const made = await store.create(root, store.revision(root), "Later", "", false, [
            "late.txt",
        ]);
        const list = made.lists.find((item) => item.name === "Later")!.id;
        finishFirst();
        await vi.waitFor(() => expect(membership).toHaveBeenCalledTimes(3));
        await membership.mock.results[2]!.value;
        expect(
            store.get(root).files["late.txt"],
            "a pass's prune keeps a newer refresh's file and its move",
        ).toBe(list);
        finishSecond();
        await Promise.all(refreshes);
        await host.settled();
        expect(
            store.get(root).files["late.txt"],
            "the next pass must not hand the moved file to the active list",
        ).toBe(list);
    });

    it("does not re-add a file a newer refresh dropped when an earlier pass prunes", async () => {
        let finishFirst!: () => void;
        let finishSecond!: () => void;
        const firstPass = new Promise<void>((resolve) => {
            finishFirst = resolve;
        });
        const secondPass = new Promise<void>((resolve) => {
            finishSecond = resolve;
        });
        const scan = vi
            .spyOn(ChangeRangeTracker.prototype, "reconcile")
            .mockReturnValueOnce(firstPass)
            .mockReturnValue(secondPass);
        const membership = vi.spyOn(store, "reconcileFiles");
        const files = await gitOps.getStatus({ withStats: false });
        const earlier = [...files, { ...files[0]!, path: "gone.txt", status: "?" }];
        const refreshes = [host.reconcile(earlier)];
        await vi.waitFor(() => expect(scan).toHaveBeenCalledTimes(1));
        refreshes.push(host.reconcile(files));
        await vi.waitFor(() => expect(scan).toHaveBeenCalledTimes(2));
        expect(store.get(root).files["gone.txt"], "the newer refresh removed the file").toBe(
            undefined,
        );
        finishFirst();
        await vi.waitFor(() => expect(membership).toHaveBeenCalledTimes(3));
        await membership.mock.results[2]!.value;
        expect(
            store.get(root).files["gone.txt"],
            "an earlier pass's prune must not re-add a file the newer refresh dropped",
        ).toBe(undefined);
        finishSecond();
        await Promise.all(refreshes);
        await host.settled();
    });

    it("reports a failed shared prune once, without rejecting the refreshes that joined it", async () => {
        let finishPass!: () => void;
        const pass = new Promise<void>((resolve) => {
            finishPass = resolve;
        });
        vi.spyOn(ChangeRangeTracker.prototype, "reconcile").mockReturnValue(pass);
        const membership = vi.spyOn(store, "reconcileFiles").mockResolvedValue(undefined);
        const files = await gitOps.getStatus({ withStats: false });
        const refreshes = [host.reconcile(files), host.reconcile(files)];
        await vi.waitFor(() => expect(membership).toHaveBeenCalledTimes(2));
        membership.mockRejectedValueOnce(new Error("injected prune failure"));
        finishPass();
        const settled = await Promise.allSettled(refreshes);
        expect(
            settled.map((result) => result.status),
            "a failed prune belongs to the host, not to the refreshes that joined it",
        ).toEqual(["fulfilled", "fulfilled"]);
        const errors = () =>
            (posted as { type?: string; message?: string }[])
                .filter((message) => message.type === "error")
                .map((message) => message.message);
        await vi.waitFor(() =>
            expect(errors(), "the host reports the failed prune exactly once").toEqual([
                "Changelist action failed: injected prune failure",
            ]),
        );
        expect(membership).toHaveBeenCalledTimes(3);
        await vi.waitFor(() =>
            expect(posted.at(-1)).toMatchObject({ type: "setChangelists", busy: false }),
        );
    });

    it("keeps changelist actions busy while a shared prune runs", async () => {
        let finishPass!: () => void;
        const pass = new Promise<void>((resolve) => {
            finishPass = resolve;
        });
        let finishPrune!: () => void;
        const prune = new Promise<void>((resolve) => {
            finishPrune = resolve;
        });
        vi.spyOn(ChangeRangeTracker.prototype, "reconcile").mockReturnValue(pass);
        const membership = vi.spyOn(store, "reconcileFiles").mockResolvedValue(undefined);
        const files = await gitOps.getStatus({ withStats: false });
        const refreshes = [host.reconcile(files), host.reconcile(files)];
        await vi.waitFor(() => expect(membership).toHaveBeenCalledTimes(2));
        membership.mockImplementationOnce(() => prune);
        finishPass();
        try {
            await vi.waitFor(() => expect(membership).toHaveBeenCalledTimes(3));
            await store.saveDraft(root, "all", "", "metadata arriving during the shared prune");
            expect(posted.at(-1), "a pending prune must not enable actions").toMatchObject({
                type: "setChangelists",
                busy: true,
            });
        } finally {
            finishPrune();
            await Promise.all(refreshes);
        }
        expect(posted.at(-1)).toMatchObject({ type: "setChangelists", busy: false });
    });

    it("keeps changelist actions usable while the cold range scan walks a large file set", async () => {
        host.dispose();
        const names = Array.from(
            { length: 40 },
            (_, i) => `bench-${String(i).padStart(5, "0")}.txt`,
        );
        await Promise.all(names.map((name) => writeFile(path.join(root, name), base)));
        git(["add", "--", ...names]);
        git(["commit", "-qm", "many"]);
        await Promise.all(names.map((name) => writeFile(path.join(root, name), working)));
        const files = await gitOps.getStatus({ withStats: false });
        let resume!: () => void;
        const scanning = new Promise<void>((resolve) => {
            resume = resolve;
        });
        const open = PartialChanges.prototype.open;
        const opened = vi
            .spyOn(PartialChanges.prototype, "open")
            .mockImplementation(async function (this: PartialChanges, ...args) {
                await scanning;
                return open.apply(this, args);
            });
        host = new ChangeWorkflowHost({ ...hostDeps, files: () => files });
        const load = host.handle({ type: "loadChangelists", repositoryRoot: root });
        try {
            await vi.waitFor(() => expect(opened).toHaveBeenCalledOnce());
            await store.saveDraft(root, "all", "", "metadata arriving during the scan");
            expect(
                posted.at(-1),
                "a running range scan must not disable changelist actions",
            ).toMatchObject({ type: "setChangelists", busy: false });
            const later = (await store.create(root, store.get(root).revision, "Later")).lists[1].id;
            posted.length = 0;
            await host.handle({
                type: "changelistAction",
                repositoryRoot: root,
                action: "move",
                listId: later,
                paths: [names[1]],
                revision: store.get(root).revision,
            });
            expect(
                posted
                    .filter((message) => (message as { type: string }).type === "error")
                    .map((message) => (message as { message: string }).message),
                "a mid-scan move must not be refused",
            ).toEqual([]);
            expect(store.get(root).files[names[1]], "a whole-file move must apply mid-scan").toBe(
                later,
            );
            expect(
                opened,
                "the scan must still be parked on its first file",
            ).toHaveBeenCalledOnce();
        } finally {
            resume();
            await load;
        }
        expect(posted.at(-1)).toMatchObject({ type: "setChangelists", busy: false });
    });

    it("refuses a partial commit whose ranges the running scan has not re-read", async () => {
        const original = store.get(root).activeId;
        const later = (await store.create(root, store.get(root).revision, "Later")).lists[1].id;
        await host.handle({
            type: "changelistAction",
            repositoryRoot: root,
            action: "activate",
            listId: later,
            revision: store.get(root).revision,
        });
        await writeFile(path.join(root, "file.txt"), `later edit\n${working}`);
        await host.reconcile(await gitOps.getStatus({ withStats: false }));
        await host.settled();
        expect(store.get(root).files["file.txt"]).toBe(original);
        expect(Object.values(store.get(root).changes["file.txt"].lines)).toContain(later);
        await writeFile(path.join(root, "file.txt"), `later edit\n${working}unobserved edit\n`);
        host.dispose();
        let resume!: () => void;
        const scanning = new Promise<void>((resolve) => {
            resume = resolve;
        });
        const open = PartialChanges.prototype.open;
        let parked = false;
        const opened = vi
            .spyOn(PartialChanges.prototype, "open")
            .mockImplementation(async function (this: PartialChanges, ...args) {
                if (!parked) {
                    parked = true;
                    await scanning;
                }
                return open.apply(this, args);
            });
        host = new ChangeWorkflowHost({
            ...hostDeps,
            files: () => [{ path: "file.txt", status: "M" }] as never,
        });
        const load = host.handle({ type: "loadChangelists", repositoryRoot: root });
        try {
            await vi.waitFor(() => expect(opened).toHaveBeenCalledOnce());
            posted.length = 0;
            await host.handle({
                type: "commitChangelist",
                repositoryRoot: root,
                revision: store.get(root).revision,
                listId: original,
                paths: ["file.txt"],
                message: "must wait for fresh ranges",
            });
            expect(posted, "stale ranges must refuse the partial commit").toContainEqual(
                expect.objectContaining({
                    type: "error",
                    message: expect.stringContaining("Change assignments need review"),
                }),
            );
            expect(git(["rev-parse", "HEAD"]), "a refused commit must keep HEAD").toBe(
                baselineHead,
            );
        } finally {
            resume();
            await load;
        }
    });

    /** Answers the create prompts, running `during` while the name prompt is open. */
    function createPrompts(during: () => Promise<unknown>) {
        Object.defineProperty(vscode.window, "showInputBox", {
            configurable: true,
            value: vi
                .fn()
                .mockImplementationOnce(async () => {
                    await during();
                    return "Mid-scan";
                })
                .mockResolvedValueOnce(""),
        });
        Object.defineProperty(vscode.window, "showQuickPick", {
            configurable: true,
            value: vi.fn(async (items: readonly unknown[]) => items[0]),
        });
    }

    it("creates a list whose prompts stayed open while the range scan wrote", async () => {
        const revision = store.get(root).revision;
        await writeFile(path.join(root, "file.txt"), `scan edit\n${working}`);
        let scanned = revision;
        createPrompts(async () => {
            await host.reconcile(await gitOps.getStatus({ withStats: false }));
            await host.settled();
            scanned = store.get(root).revision;
        });
        posted.length = 0;
        await host.handle({
            type: "changelistAction",
            repositoryRoot: root,
            action: "create",
            revision,
        });
        expect(scanned, "the scan must write while the prompt is open").toBeGreaterThan(revision);
        expect(
            posted
                .filter((message) => (message as { type: string }).type === "error")
                .map((message) => (message as { message: string }).message),
            "a range write during the prompts must not refuse the new list",
        ).toEqual([]);
        expect(store.get(root).lists.map((list) => list.name)).toContain("Mid-scan");
    });

    it.each([
        ["another list is created", () => store.create(root, store.revision(root), "Elsewhere")],
        [
            "the active list changes",
            () => store.activate(root, store.revision(root), store.get(root).lists[1].id),
        ],
    ])("refuses a new list when %s while its prompts are open", async (_, interfere) => {
        // Exists before the click, so the active-list case changes nothing but the active list.
        await store.create(root, store.revision(root), "Existing");
        const revision = store.get(root).revision;
        const lists = () => store.get(root).lists.map((list) => list.name);
        let seen: string[] = [];
        createPrompts(async () => {
            await interfere();
            seen = lists();
        });
        posted.length = 0;
        await host.handle({
            type: "changelistAction",
            repositoryRoot: root,
            action: "create",
            revision,
        });
        expect(posted, "an intervening list change must refuse the create").toContainEqual(
            expect.objectContaining({
                type: "error",
                message: expect.stringContaining("Changelists changed"),
            }),
        );
        expect(lists(), "a refused create must write nothing").toEqual(seen);
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
        await host.settled();
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
        await host.settled();
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

describe("focus after native prompts", () => {
    it("hands focus back to the requesting view after a cancelled prompt, and only then", async () => {
        const focusView = vi.fn();
        host.dispose();
        host = new ChangeWorkflowHost({ ...hostDeps, focusView });
        await host.handle({ type: "loadChangelists", repositoryRoot: root });
        expect(
            focusView,
            "a reload opens no prompt and keeps focus where it is",
        ).not.toHaveBeenCalled();
        const revision = store.revision(root);
        Object.defineProperty(vscode.window, "showInputBox", {
            configurable: true,
            value: vi.fn().mockResolvedValue(undefined),
        });
        await host.handle({
            type: "changelistAction",
            repositoryRoot: root,
            revision,
            action: "create",
        });
        expect(store.revision(root), "the cancelled prompt changed nothing").toBe(revision);
        expect(focusView, "a closed prompt returns focus to its view").toHaveBeenCalledTimes(1);
    });
});
