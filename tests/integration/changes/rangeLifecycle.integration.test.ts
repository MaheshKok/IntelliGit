import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { GitExecutor } from "../../../src/git/executor";
import { GitOps } from "../../../src/git/operations";
import { PartialChanges } from "../../../src/git/partialChanges";
import { RepositoryLockBusyError } from "../../../src/git/repositoryLock";
import { ChangelistEvidenceError } from "../../../src/changes/changelistPersistence";
import { ChangelistStore } from "../../../src/changes/changelistStore";
import { ChangeRangeTracker } from "../../../src/changes/changeRangeTracker";
import { rangeSnapshot } from "../../../src/changes/rangeMapping";
import { removeScratchDirectories } from "../../helpers/scratchDirectories";

let root: string;
let store: ChangelistStore;
let partial: PartialChanges;
let tracker: ChangeRangeTracker;
let ops: GitOps;
let listB: string;
const base = Array.from({ length: 100 }, (_, i) => `line ${i}\n`).join("");
const calculation = base.replace("line 20\n", "calculation\n");
const both = calculation.replace("line 80\n", "color\n");
function git(...args: string[]): string {
    return execFileSync("git", args, { cwd: root, encoding: "utf8" });
}
async function refresh(): Promise<void> {
    const files = await ops.getStatus({ withStats: false });
    await tracker.reconcile(files);
    await store.reconcileFiles(
        root,
        files.map((file) => file.path),
    );
}
async function fingerprintOwners(): Promise<Record<string, string>> {
    const view = await partial.open("text.txt");
    const state = store.get(root);
    return Object.fromEntries(
        view.blocks
            .flatMap((block) => block.lines)
            .filter((line) => line.kind === "add")
            .map((line) => [
                line.text.trim(),
                state.changes["text.txt"].lines[line.fingerprint] ?? state.files["text.txt"],
            ]),
    );
}
beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "intelligit-range-lifecycle-"));
    git("init", "-q");
    git("config", "user.name", "Range Test");
    git("config", "user.email", "ranges@example.invalid");
    git("config", "commit.gpgSign", "false");
    await writeFile(path.join(root, "text.txt"), base);
    await writeFile(path.join(root, "other.txt"), "other\n");
    git("add", ".");
    git("commit", "-qm", "base");
    const executor = new GitExecutor(root);
    ops = new GitOps(executor);
    partial = new PartialChanges(executor, root);
    store = new ChangelistStore();
    await store.connect(root, path.join(root, ".git"));
    tracker = new ChangeRangeTracker(root, partial, store);
    await writeFile(path.join(root, "text.txt"), calculation);
    await refresh();
    let state = await store.create(root, store.get(root).revision, "Colors");
    listB = state.lists[1].id;
    state = await store.activate(root, state.revision, listB);
    await writeFile(path.join(root, "text.txt"), both);
    await refresh();
});
afterEach(async () => {
    vi.restoreAllMocks();
    await removeScratchDirectories(root);
});

describe("range ownership across real Git lifecycle operations", () => {
    it("surfaces damaged range evidence without reporting a successful observation", async () => {
        const before = store.get(root);
        const filename = path.join(
            root,
            ".git",
            "intelligit",
            "changelists",
            "evidence",
            `${before.changes["text.txt"].tracking!.blob}.json`,
        );
        const original = await readFile(filename);
        await writeFile(filename, "{broken payload");
        await writeFile(path.join(root, "text.txt"), `new header\n${both}`);
        await expect(refresh()).rejects.toBeInstanceOf(ChangelistEvidenceError);
        expect(store.get(root)).toEqual(before);
        expect(await readFile(filename, "utf8")).toBe("{broken payload");
        await writeFile(filename, original);
        await refresh();
        expect(await fingerprintOwners()).toEqual({
            "new header": listB,
            calculation: "default",
            color: listB,
        });
    });

    it("surfaces an exhausted metadata lease without making ownership stale and retries the observation", async () => {
        const before = store.get(root);
        await writeFile(path.join(root, "text.txt"), `new header\n${both}`);
        vi.spyOn(store, "track").mockRejectedValueOnce(new RepositoryLockBusyError());
        await expect(refresh()).rejects.toBeInstanceOf(RepositoryLockBusyError);
        expect(store.get(root)).toEqual(before);
        await refresh();
        expect(await fingerprintOwners()).toEqual({
            "new header": listB,
            calculation: "default",
            color: listB,
        });
        expect(store.get(root).changes["text.txt"].stale).not.toBe(true);
    });

    it("retries a draft-only race without losing new-edit attribution", async () => {
        await writeFile(path.join(root, "text.txt"), `new header\n${both}`);
        const other = new ChangelistStore();
        await other.connect(root, path.join(root, ".git"));
        const open = partial.open.bind(partial);
        vi.spyOn(partial, "open").mockImplementationOnce(async (...args) => {
            const view = await open(...args);
            await other.saveDraft(root, "all", "", "Concurrent draft");
            return view;
        });
        await refresh();
        expect(store.get(root).changes["text.txt"].stale).not.toBe(true);
        expect(await fingerprintOwners()).toEqual({
            "new header": listB,
            calculation: "default",
            color: listB,
        });
        expect(store.draft(root, "all")).toBe("Concurrent draft");
    });

    it.each(["merge", "cherry-pick", "rebase"])(
        "preserves local ownership across an external %s that changes another file",
        async (operation) => {
            const upstream = await mkdtemp(path.join(tmpdir(), "intelligit-range-upstream-"));
            try {
                git("worktree", "add", "-b", "range-upstream", upstream, "HEAD");
                await writeFile(path.join(upstream, "other.txt"), "upstream change\n");
                execFileSync("git", ["-C", upstream, "add", "other.txt"]);
                execFileSync("git", ["-C", upstream, "commit", "-qm", "upstream"]);
                if (operation === "rebase") git("rebase", "--autostash", "range-upstream");
                else git(operation, "range-upstream");
                await refresh();
                expect(await fingerprintOwners()).toEqual({ calculation: "default", color: listB });
                expect(store.get(root).changes["text.txt"].stale).not.toBe(true);
                expect(await readFile(path.join(root, "text.txt"), "utf8")).toBe(both);
                expect(git("show", "HEAD:other.txt")).toBe("upstream change\n");
            } finally {
                git("worktree", "remove", "--force", upstream);
                await removeScratchDirectories(upstream);
            }
        },
    );

    it("fences an unknown first-capture failure instead of assigning the file implicitly", async () => {
        await writeFile(path.join(root, "other.txt"), "unobserved edit\n");
        const open = partial.open.bind(partial);
        vi.spyOn(partial, "open").mockImplementation(async (...args) => {
            if (args[0] === "other.txt") throw new Error("unexpected snapshot failure");
            return open(...args);
        });
        await refresh();
        expect(store.get(root).changes["other.txt"].stale).toBe(true);
        expect(await readFile(path.join(root, "other.txt"), "utf8")).toBe("unobserved edit\n");
    });

    it.each([false, true])(
        "keeps an oversized rewrite reviewable without losing evidence (tracked=%s)",
        async (tracked) => {
            const filename = path.join(root, "large.txt");
            const original = Array.from({ length: 50_001 }, (_, index) => `base ${index}\n`).join(
                "",
            );
            const rewritten = Array.from({ length: 50_001 }, (_, index) => `new ${index}\n`).join(
                "",
            );
            await writeFile(filename, original);
            git("add", "large.txt");
            git("commit", "-qm", "large base");
            if (tracked) {
                await writeFile(filename, original.replace("base 0\n", "first edit\n"));
                await refresh();
            }
            const previous = store.get(root).changes["large.txt"];
            if (tracked) expect(previous?.tracking).toBeDefined();
            const indexBefore = git("write-tree");
            await writeFile(filename, rewritten);

            await expect(
                refresh(),
                "oversized fresh evidence must not abort refresh",
            ).resolves.toBeUndefined();

            expect(store.get(root).changes["large.txt"]).toEqual(
                tracked ? { ...previous, stale: true } : undefined,
            );
            expect(await readFile(filename, "utf8")).toBe(rewritten);
            expect(git("write-tree")).toBe(indexBefore);
            await expect(
                refresh(),
                "unsupported content must remain refreshable",
            ).resolves.toBeUndefined();
        },
        30_000,
    );

    it("keeps known unsupported new binary content in the whole-file workflow", async () => {
        const bytes = Buffer.from([0, 1, 2, 255]);
        await writeFile(path.join(root, "other.txt"), bytes);
        await refresh();
        expect(store.get(root).changes["other.txt"]).toBeUndefined();
        expect(await readFile(path.join(root, "other.txt"))).toEqual(bytes);
    });

    it("requires review when another window activates a list during snapshot capture", async () => {
        await writeFile(path.join(root, "text.txt"), `racing edit\n${both}`);
        const other = new ChangelistStore();
        await other.connect(root, path.join(root, ".git"));
        const open = partial.open.bind(partial);
        const intercept = vi.spyOn(partial, "open").mockImplementationOnce(async (...args) => {
            const view = await open(...args);
            await other.activate(root, other.get(root).revision, "default");
            return view;
        });
        try {
            await refresh();
        } finally {
            intercept.mockRestore();
        }
        expect(store.get(root).activeId).toBe("default");
        expect(store.get(root).changes["text.txt"].stale).toBe(true);
        expect(Object.values(store.get(root).changes["text.txt"].lines)).toContain(listB);
        expect(await readFile(path.join(root, "text.txt"), "utf8")).toBe(`racing edit\n${both}`);
    });

    it("attributes new work to B, survives shifts and commits only A with the complete remaining bytes intact", async () => {
        const index = await readFile(path.join(root, ".git/index"));
        const head = git("rev-parse", "HEAD");
        expect(await fingerprintOwners()).toEqual({ calculation: "default", color: listB });
        await writeFile(path.join(root, "text.txt"), `new heading\n${both}`);
        await refresh();
        expect(await fingerprintOwners()).toEqual({
            "new heading": listB,
            calculation: "default",
            color: listB,
        });
        expect(git("rev-parse", "HEAD")).toBe(head);
        expect(await readFile(path.join(root, ".git/index"))).toEqual(index);
        const view = await partial.open("text.txt");
        const original = partial.snapshot(view.snapshotId);
        const state = store.get(root);
        const selected = view.blocks
            .flatMap((block) => block.lines)
            .filter(
                (line) =>
                    line.kind !== "context" &&
                    (state.changes["text.txt"].lines[line.fingerprint] ?? "default") === "default",
            );
        const release = await store.beginCommit(root);
        try {
            await store.prepareCommitInclusion(root, state.revision, "default", [
                {
                    path: "text.txt",
                    contentId: original.contentId,
                    lineIds: selected.map((line) => line.id),
                    total: view.blocks
                        .flatMap((b) => b.lines)
                        .filter((line) => line.kind !== "context").length,
                },
            ]);
            await partial.commit(
                [{ snapshotId: view.snapshotId, lineIds: selected.map((line) => line.id) }],
                "calculation only",
                () => undefined,
            );
            const remaining = await partial.open("text.txt");
            const snapshot = partial.snapshot(remaining.snapshotId);
            const anchors = remaining.blocks
                .flatMap((block) => block.lines)
                .filter((line) => line.kind !== "context");
            await store.consumeCommitted(
                root,
                "text.txt",
                snapshot.contentId,
                "default",
                new Set(selected.map((line) => line.fingerprint)),
                new Set(anchors.map((line) => line.fingerprint)),
                anchors.length,
                rangeSnapshot(snapshot),
            );
        } finally {
            await release();
        }
        expect(git("show", "HEAD:text.txt")).toBe(calculation);
        expect(git("rev-parse", "HEAD^").trim()).toBe(head.trim());
        expect(git("show", ":text.txt")).toBe(calculation);
        expect(await readFile(path.join(root, "text.txt"), "utf8")).toBe(`new heading\n${both}`);
        expect(await fingerprintOwners()).toEqual({ "new heading": listB, color: listB });
        expect(store.get(root).changes["text.txt"].stale).toBe(false);
        expect(store.get(root).changes["text.txt"].selections?.default.lineIds).toEqual([]);
        expect(store.get(root).changes["text.txt"].selections?.all.lineIds).toEqual([]);
    });

    it("keeps ownership and explicit exclusion across external add/reset, reload and detached HEAD", async () => {
        const view = await partial.open("text.txt");
        const snapshot = partial.snapshot(view.snapshotId);
        await store.recordSelection(root, "text.txt", snapshot.contentId, "all", [], 4);
        git("add", "text.txt");
        await refresh();
        git("reset", "-q", "HEAD", "--", "text.txt");
        await refresh();
        git("checkout", "--detach", "-q", "HEAD");
        await refresh();
        const fresh = new ChangelistStore();
        await fresh.connect(root, path.join(root, ".git"));
        expect(fresh.get(root)).toEqual(store.get(root));
        expect(await fingerprintOwners()).toEqual({ calculation: "default", color: listB });
        expect(fresh.get(root).changes["text.txt"].selections?.all.lineIds).toEqual([]);
        expect(await readFile(path.join(root, "text.txt"), "utf8")).toBe(both);
    });

    it("retains explicit empty inclusion when an external commit makes a file clean", async () => {
        const view = await partial.open("text.txt");
        const snapshot = partial.snapshot(view.snapshotId);
        await store.recordSelection(root, "text.txt", snapshot.contentId, "all", [], 4);
        git("add", "text.txt");
        git("commit", "-qm", "external commit");
        await refresh();
        expect(store.get(root).changes["text.txt"]).toMatchObject({
            totalChanges: 0,
            selections: { all: { lineIds: [] } },
        });
        expect(store.get(root).files["text.txt"]).toBe("default");
    });

    it("restores ownership after stash push/apply and consumes a verified external commit", async () => {
        git("stash", "push", "-qm", "range work");
        await refresh();
        expect(store.get(root).changes["text.txt"]).toMatchObject({ totalChanges: 0 });
        git("stash", "apply", "--quiet");
        await refresh();
        expect(await fingerprintOwners()).toEqual({ calculation: "default", color: listB });
        git("add", "text.txt");
        git("commit", "-qm", "external commit");
        await refresh();
        expect(store.get(root).changes["text.txt"]).toBeUndefined();
        expect(store.get(root).files["text.txt"]).toBeUndefined();
        expect(await readFile(path.join(root, "text.txt"), "utf8")).toBe(both);
    });

    it("fences rename ownership at both paths instead of assigning it to the active list", async () => {
        git("mv", "text.txt", "renamed.txt");
        const head = git("rev-parse", "HEAD");
        const index = await readFile(path.join(root, ".git/index"));
        await refresh();
        expect(store.get(root).changes["text.txt"].stale).toBe(true);
        expect(store.get(root).changes["renamed.txt"].stale).toBe(true);
        expect(git("rev-parse", "HEAD")).toBe(head);
        expect(await readFile(path.join(root, ".git/index"))).toEqual(index);
        expect(await readFile(path.join(root, "renamed.txt"), "utf8")).toBe(both);
    });

    it("isolates a linked worktree with the same relative path and branch family", async () => {
        const linked = path.join(root, "linked");
        git("worktree", "add", "-qb", "linked-feature", linked, "HEAD");
        const linkedOps = new GitOps(new GitExecutor(linked));
        const dirs = await linkedOps.getGitDirectories();
        const linkedStore = new ChangelistStore();
        await linkedStore.connect(linked, dirs.gitDir);
        expect(linkedStore.get(linked).changes).toEqual({});
        expect(linkedStore.get(linked).lists).toHaveLength(1);
        await linkedStore.create(linked, 0, "Linked only");
        expect(store.get(root).lists.map((list) => list.name)).toEqual(["Changes", "Colors"]);
        expect(await fingerprintOwners()).toEqual({ calculation: "default", color: listB });
    });
});
