import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
    createCommitInfoVscodeDouble,
    createFakeExtensionUri,
} from "../../visual/recorder/commitInfoVscodeDouble";
vi.mock("vscode", () => {
    const double = createCommitInfoVscodeDouble();
    Object.defineProperty(double.workspace, "textDocuments", { value: [] });
    Object.defineProperty(double.workspace, "notebookDocuments", { value: [] });
    for (const name of ["showWarningMessage", "showInformationMessage", "showInputBox"])
        Object.defineProperty(double.window, name, {
            value: vi.fn().mockResolvedValue(undefined),
            configurable: true,
        });
    Object.defineProperty(double.l10n, "t", {
        value: (message: string, values: Record<string, string> = {}) =>
            message.replace(/\{([^}]+)\}/g, (match, key: string) => values[key] ?? match),
    });
    return double;
});
import * as vscode from "vscode";
import { ChangeWorkflowHost } from "../../../src/views/ChangeWorkflowHost";
import { ChangelistStore } from "../../../src/changes/changelistStore";
import { PartialChanges } from "../../../src/git/partialChanges";
import { ShelfService } from "../../../src/services/shelfService";
import { ShelfStore } from "../../../src/shelf/store";
import { resolveShelfPaths } from "../../../src/shelf/paths";
import { RepositoryMutationGate } from "../../../src/git/repositoryMutationGate";
import { RepositoryMutationCoordinator } from "../../../src/git/mutationCoordinator";
import { RepositoryLock } from "../../../src/git/repositoryLock";
import { GitExecutor } from "../../../src/git/executor";
import { GitOps } from "../../../src/git/operations";
import { rangeSnapshot } from "../../../src/changes/rangeMapping";
import { removeScratchDirectories } from "../../helpers/scratchDirectories";
import type { ChangelistReply } from "../../../src/webviews/protocol/changelists";

const base = Array.from({ length: 30 }, (_, i) => `line ${i}\n`).join("");
const remaining = base.replace("line 24\n", "other owner\n");
const working = remaining.replace("line 4\n", "selected owner\n");
type ShelfResult = Extract<ChangelistReply, { type: "changelistShelfResult" }>;

let root: string;
let host: ChangeWorkflowHost;
let store: ChangelistStore;
let service: ShelfService;
let shelves: ShelfStore;
let posted: unknown[];
let other: string;
const git = (args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
const read = (file: string) => readFile(path.join(root, file), "utf8");
const index = () => readFile(path.join(root, ".git/index"));
const warn = () => vi.mocked(vscode.window.showWarningMessage);
const results = () =>
    posted.filter(
        (message): message is ShelfResult =>
            (message as ShelfResult).type === "changelistShelfResult",
    );
const shelfIds = async () => (await shelves.listShelves()).shelfIds;

/** Two default-owned ranges, two other-owned ranges, and an unrelated staged plus working file. */
beforeEach(async () => {
    vi.resetAllMocks();
    root = await mkdtemp(path.join(tmpdir(), "intelligit-scoped-removal-"));
    git(["init", "-q"]);
    git(["config", "user.name", "Host"]);
    git(["config", "user.email", "host@example.invalid"]);
    git(["config", "commit.gpgSign", "false"]);
    for (const file of ["first.txt", "second.txt"]) await writeFile(path.join(root, file), base);
    await writeFile(path.join(root, "unrelated.txt"), "base\n");
    git(["add", "."]);
    git(["commit", "-qm", "base"]);
    await writeFile(path.join(root, "unrelated.txt"), "staged\n");
    git(["add", "unrelated.txt"]);
    await writeFile(path.join(root, "unrelated.txt"), "working\n");
    for (const file of ["first.txt", "second.txt"]) await writeFile(path.join(root, file), working);
    const gitOps = new GitOps(new GitExecutor(root));
    const values = new Map<string, unknown>();
    const storage = {
        get: <T>(key: string) => values.get(key) as T | undefined,
        update: async (key: string, value: unknown) => {
            values.set(key, structuredClone(value));
        },
        keys: () => [...values.keys()],
    };
    store = ChangelistStore.forStorage(storage);
    shelves = new ShelfStore(
        await resolveShelfPaths({
            repositoryRoot: root,
            globalStoragePath: path.join(root, ".git", "shelf-storage"),
        }),
    );
    service = new ShelfService({
        repositoryRoot: root,
        executor: new GitExecutor(root),
        gitOps,
        changelists: store,
        store: shelves,
        gate: new RepositoryMutationGate(new RepositoryMutationCoordinator(), new RepositoryLock()),
    });
    posted = [];
    const files = await gitOps.getStatus({ withStats: false });
    host = new ChangeWorkflowHost({
        root,
        extensionUri: createFakeExtensionUri(),
        gitOps,
        workspaceState: storage,
        files: () => files,
        post: (message) => posted.push(message),
        actions: {
            gitOps,
            refreshData: async () => undefined,
            postCommitted: vi.fn(),
            fireWorkingTreeChanged: () => undefined,
            maybeOfferPublishBranch: async () => undefined,
        },
        runCommit: (operation) => operation(),
        shelfService: service,
    });
    await host.reconcile(files);
    await host.settled();
    other = (await store.create(root, store.revision(root), "Other")).lists[1].id;
    // Without this, the untracked-by-range file falls back to the active list and is list-owned.
    await store.moveFiles(root, store.revision(root), other, ["unrelated.txt"]);
    const partial = new PartialChanges(new GitExecutor(root), root);
    for (const file of ["first.txt", "second.txt"]) {
        const view = await partial.open(file);
        const snapshot = partial.snapshot(view.snapshotId);
        await store.track(root, file, rangeSnapshot(snapshot));
        const lines = view.blocks
            .flatMap((block) => block.lines)
            .filter((line) => line.kind !== "context");
        await store.assignChanges(
            root,
            store.revision(root),
            file,
            snapshot.contentId,
            other,
            lines
                .filter((line) => line.text.includes("24") || line.text.includes("other owner"))
                .map((line) => line.fingerprint),
            new Set(lines.map((line) => line.fingerprint)),
        );
    }
    vi.mocked(vscode.window.showInputBox).mockResolvedValue("scoped shelf");
    warn().mockResolvedValue(undefined);
});
afterEach(async () => {
    vi.restoreAllMocks();
    host?.dispose();
    await removeScratchDirectories(root);
});

function request(
    operation: "save" | "saveAndRemove" | "rollback" | undefined,
    overrides: Record<string, unknown> = {},
) {
    return {
        type: "saveChangelistShelf",
        repositoryRoot: root,
        requestId: `request-${operation ?? "plain"}`,
        revision: store.revision(root),
        scope: "list",
        listId: "default",
        ...(operation ? { operation } : {}),
        ...overrides,
    };
}

async function untouched(indexBytes: Buffer) {
    expect(await read("first.txt"), "first.txt bytes are unchanged").toBe(working);
    expect(await read("second.txt"), "second.txt bytes are unchanged").toBe(working);
    expect(await read("unrelated.txt")).toBe("working\n");
    expect(await index(), "index bytes are unchanged").toEqual(indexBytes);
}

describe("list and file Save and Remove", () => {
    it("save alone never calls removal", async () => {
        const remove = vi.spyOn(service, "removeScopedChanges");
        const rollback = vi.spyOn(PartialChanges.prototype, "rollbackCaptured");
        const indexBytes = await index();
        const before = store.get(root);
        await host.handle(request(undefined));
        await host.handle(request("save", { requestId: "explicit-save" }));
        expect(remove, "save alone never calls removal").not.toHaveBeenCalled();
        expect(rollback, "save alone never rolls back").not.toHaveBeenCalled();
        expect(warn(), "save alone never asks to remove").not.toHaveBeenCalled();
        expect(await shelfIds()).toHaveLength(2);
        expect(store.get(root)).toEqual(before);
        await untouched(indexBytes);
    });

    it("removes only the list's ranges after durable save, preserving other owners and unrelated bytes", async () => {
        const indexBytes = await index();
        const removalShelfCounts: number[] = [];
        const remove = service.removeScopedChanges.bind(service);
        vi.spyOn(service, "removeScopedChanges").mockImplementation(async (...args) => {
            removalShelfCounts.push((await shelfIds()).length);
            return remove(...args);
        });
        warn().mockImplementationOnce(async (_message, options) => {
            expect(await shelfIds(), "durable save precedes the removal preview").toHaveLength(1);
            const lease = await store.acquireTargetOperationLease(root);
            await lease.release();
            expect((options as { detail: string }).detail).toContain(
                "2 file(s), 2 selected range(s), 4 changed line(s)",
            );
            expect((options as { detail: string }).detail).toContain("+selected owner");
            expect((options as { detail: string }).detail).not.toContain("+other owner");
            return "Remove Selected Changes" as never;
        });
        await host.handle(request("saveAndRemove"));
        expect(removalShelfCounts, "removal begins only after durable shelf publication").toEqual([
            1,
        ]);
        const [id] = await shelfIds();
        expect(results()).toEqual([
            expect.objectContaining({ shelfId: id, message: expect.stringContaining(id) }),
        ]);
        expect(results()[0].error).toBeUndefined();
        for (const file of ["first.txt", "second.txt"]) {
            expect(await read(file), "partial removal preserves other-list lines").toBe(remaining);
            expect(
                Object.values(store.get(root).changes[file].lines),
                "non-selected ownership survives removal",
            ).toEqual([other, other]);
        }
        expect(await index(), "partial removal preserves index bytes").toEqual(indexBytes);
        expect(await read("unrelated.txt")).toBe("working\n");
    });

    it("cancel removal retains shelf and every local byte", async () => {
        const indexBytes = await index();
        const before = store.get(root);
        const remove = vi.spyOn(service, "removeScopedChanges");
        await host.handle(request("saveAndRemove"));
        const [id] = await shelfIds();
        expect(id, "cancel keeps the durable shelf").toBeDefined();
        expect(remove, "cancel never removes").not.toHaveBeenCalled();
        expect(results()[0]).toMatchObject({
            shelfId: id,
            message: expect.stringMatching(new RegExp(`cancelled.*${id}`)),
        });
        expect(results()[0].error).toBeUndefined();
        expect(store.get(root)).toEqual(before);
        await untouched(indexBytes);
    });

    it.each(["source edit", "ownership revision"])(
        "%s after preview saves recovery but refuses removal",
        async (fault) => {
            const indexBytes = await index();
            const rollback = vi.spyOn(PartialChanges.prototype, "rollbackCaptured");
            warn().mockImplementationOnce(async () => {
                if (fault === "source edit")
                    await writeFile(path.join(root, "second.txt"), `${working}external\n`);
                else await store.saveDraft(root, "default", "", "changed during preview");
                return "Remove Selected Changes" as never;
            });
            await host.handle(request("saveAndRemove"));
            const [id] = await shelfIds();
            expect(rollback, "stale preview removes no path").not.toHaveBeenCalled();
            expect(results()[0]).toMatchObject({
                shelfId: id,
                error: expect.stringContaining(id),
            });
            expect(await read("first.txt")).toBe(working);
            expect(await read("second.txt")).toBe(
                fault === "source edit" ? `${working}external\n` : working,
            );
            expect(await index()).toEqual(indexBytes);
            expect(await shelves.readCurrentShelfManifest(id)).toMatchObject({ generation: 1 });
        },
    );

    it("partial failure reports exact completed and retained paths and reconciles only completed paths", async () => {
        const original = PartialChanges.prototype.rollbackCaptured;
        vi.spyOn(PartialChanges.prototype, "rollbackCaptured").mockImplementation(async function (
            this: PartialChanges,
            ...args
        ) {
            if (args[0].view.path === "second.txt")
                await writeFile(path.join(root, "second.txt"), `${working}external\n`);
            return original.apply(this, args);
        });
        warn().mockResolvedValueOnce("Remove Selected Changes" as never);
        const secondBefore = store.get(root).changes["second.txt"];
        await host.handle(request("saveAndRemove"));
        const [id] = await shelfIds();
        const result = results()[0];
        expect(result.shelfId).toBe(id);
        expect(result.error).toContain(id);
        expect(result.error).toContain("Removed: first.txt.");
        expect(result.error).toContain("Not removed: second.txt.");
        expect(result.error).toMatch(/do not repeat/i);
        expect(await read("first.txt")).toBe(remaining);
        expect(await read("second.txt")).toBe(`${working}external\n`);
        expect(
            store.get(root).changes["second.txt"],
            "metadata of a retained path is not reconciled",
        ).toEqual(secondBefore);
        expect(Object.values(store.get(root).changes["first.txt"].lines)).toEqual([other, other]);
    });

    it("removal metadata failure reports saved recovery and completed Git without retry", async () => {
        warn().mockResolvedValue("Remove Selected Changes" as never);
        vi.spyOn(store, "consumeCommitted").mockRejectedValueOnce(
            new Error("metadata unavailable"),
        );
        const remove = vi.spyOn(service, "removeScopedChanges");
        await host.handle(request("saveAndRemove"));
        const [id] = await shelfIds();
        expect(results()[0]).toMatchObject({ shelfId: id, error: expect.stringContaining(id) });
        expect(results()[0].error).toMatch(/do not repeat/i);
        expect(results()[0].error).toContain("first.txt, second.txt");
        expect(await read("first.txt")).toBe(remaining);
        expect(await read("second.txt")).toBe(remaining);
        await host.handle(request("saveAndRemove"));
        expect(remove, "duplicate request id runs removal once").toHaveBeenCalledTimes(1);
        expect(results()[1], "duplicate returns the known result").toEqual(results()[0]);
        expect(await shelfIds()).toEqual([id]);
    });

    it("duplicate request while the preview is open neither saves nor removes twice", async () => {
        let confirm!: (value: string) => void;
        let opened!: () => void;
        const opening = new Promise<void>((resolve) => (opened = resolve));
        warn().mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    confirm = resolve as (value: string) => void;
                    opened();
                }) as never,
        );
        const remove = vi.spyOn(service, "removeScopedChanges");
        const first = host.handle(request("saveAndRemove"));
        await opening;
        await host.handle(request("saveAndRemove"));
        confirm("Remove Selected Changes");
        await first;
        expect(remove, "duplicate request id runs removal once").toHaveBeenCalledTimes(1);
        expect(await shelfIds()).toHaveLength(1);
        expect(results()[0].error).toMatch(/in progress/);
    });

    it("whole-file save and remove reverts every layer of the chosen file only", async () => {
        git(["add", "first.txt"]);
        await writeFile(path.join(root, "first.txt"), `${working}working layer\n`);
        const files = await new GitOps(new GitExecutor(root)).getStatus({ withStats: false });
        await host.reconcile(files);
        await host.settled();
        const unrelatedIndex = git(["show", ":unrelated.txt"]);
        warn().mockImplementationOnce(async (_message, options) => {
            expect((options as { detail: string }).detail).toContain("first.txt: whole file");
            expect(
                (options as { detail: string }).detail,
                "whole-file preview shows the captured working-layer diff",
            ).toContain("+working layer");
            return "Remove Selected Changes" as never;
        });
        await host.handle(
            request("saveAndRemove", { scope: "files", listId: "all", paths: ["first.txt"] }),
        );
        const [id] = await shelfIds();
        expect(results()[0]).toMatchObject({ shelfId: id });
        expect(results()[0].error).toBeUndefined();
        expect(await read("first.txt")).toBe(base);
        expect(git(["show", ":first.txt"])).toBe(base);
        expect(await read("second.txt")).toBe(working);
        expect(git(["show", ":unrelated.txt"])).toBe(unrelatedIndex);
        expect(store.get(root).changes["first.txt"]?.stale ?? false).toBe(false);
    });

    it("whole-file preview is the captured diff, never regenerated from later edits", async () => {
        await writeFile(path.join(root, "first.txt"), `${working}working layer\n`);
        await host.reconcile(
            await new GitOps(new GitExecutor(root)).getStatus({ withStats: false }),
        );
        await host.settled();
        const original = PartialChanges.prototype.snapshot;
        vi.spyOn(PartialChanges.prototype, "snapshot").mockImplementation(function (
            this: PartialChanges,
            ...args
        ) {
            const captured = original.apply(this, args);
            writeFileSync(path.join(root, "first.txt"), `${working}edited after capture\n`);
            return captured;
        });
        let detail = "";
        warn().mockImplementationOnce(async (_message, options) => {
            detail = (options as { detail: string }).detail;
            return "Rollback Selected Changes" as never;
        });
        await host.handle(
            request("rollback", { scope: "files", listId: "all", paths: ["first.txt"] }),
        );
        expect(detail, "preview keeps the captured line").toContain("+working layer");
        expect(detail, "preview is not regenerated after capture").not.toContain(
            "edited after capture",
        );
        expect(await read("first.txt"), "changed source is never removed").toBe(
            `${working}edited after capture\n`,
        );
    });
});

describe("list and file Rollback", () => {
    it("rollback retains independent recovery shelf", async () => {
        warn().mockImplementationOnce(async () => {
            expect(await shelfIds(), "rollback confirms before recovery capture").toHaveLength(0);
            return "Rollback Selected Changes" as never;
        });
        await host.handle(request("rollback"));
        const ids = await shelfIds();
        expect(ids, "rollback retains independent recovery shelf").toHaveLength(1);
        expect(vscode.window.showInputBox, "rollback is not a named save").not.toHaveBeenCalled();
        expect(results()[0]).toMatchObject({ shelfId: ids[0] });
        expect(results()[0].error).toBeUndefined();
        expect(await read("first.txt")).toBe(remaining);
        expect(await read("second.txt")).toBe(remaining);
        expect(await shelves.readCurrentShelfManifest(ids[0])).toMatchObject({ generation: 1 });
    });

    it("cancelled rollback captures nothing and changes nothing", async () => {
        const indexBytes = await index();
        await host.handle(request("rollback"));
        expect(await shelfIds()).toEqual([]);
        expect(results()[0]).toMatchObject({ message: expect.stringMatching(/cancelled/i) });
        expect(results()[0].error).toBeUndefined();
        await untouched(indexBytes);
    });

    it("rejects an unknown operation before any prompt", async () => {
        await host.handle(request("saveAndRemove", { operation: "restore" }));
        expect(vscode.window.showInputBox).not.toHaveBeenCalled();
        expect(results()[0].error).toMatch(/operation/i);
        expect(await shelfIds()).toEqual([]);
    });
});
