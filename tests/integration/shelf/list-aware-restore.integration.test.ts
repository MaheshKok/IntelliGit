import { spawn } from "node:child_process";
import { ChangelistPersistence } from "../../../src/changes/changelistPersistence";
import type { ShelfFileEntry } from "../../../src/shelf/model";
import { ShelfStore } from "../../../src/shelf/store";
import { resolveShelfPaths } from "../../../src/shelf/paths";
import { createHash, randomUUID } from "node:crypto";
import { readFile, realpath, unlink, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChangeRangeTracker } from "../../../src/changes/changeRangeTracker";
import { rangeSnapshot } from "../../../src/changes/rangeMapping";
import { GitOps } from "../../../src/git/operations";
import { PartialChanges } from "../../../src/git/partialChanges";
import { readPartialSnapshot } from "../../../src/git/partialSnapshot";
import { RepositoryMutationCoordinator } from "../../../src/git/mutationCoordinator";
import { RepositoryLock } from "../../../src/git/repositoryLock";
import { RepositoryMutationGate } from "../../../src/git/repositoryMutationGate";
import { ShelfService } from "../../../src/services/shelfService";
import { connectedChangelists } from "../../helpers/connectedChangelists";
import { cleanTemporaryRepositories, createShelfFixture, git } from "./shelfTestHarness";

afterEach(async () => {
    vi.restoreAllMocks();
    await cleanTemporaryRepositories();
});

async function restoreFixture(removeFromShelf = false, mixed = false, structural = false) {
    const base = Array.from({ length: 30 }, (_, index) => `line-${index + 1}\n`).join("");
    const raw = await createShelfFixture({
        initialFiles: { "shared.txt": base, "second.txt": "base\n" },
    });
    const f = { ...raw, root: await realpath(raw.root) };
    const changelists = await connectedChangelists(f.root);
    const service = new ShelfService({
        repositoryRoot: f.root,
        executor: f.executor,
        store: f.store,
        changelists,
        gate: new RepositoryMutationGate(new RepositoryMutationCoordinator(), new RepositoryLock()),
    });
    await writeFile(path.join(f.root, "shared.txt"), base.replace("line-25\n", "incoming-C\n"));
    if (structural) await unlink(path.join(f.root, "second.txt"));
    else if (mixed) await writeFile(path.join(f.root, "second.txt"), "incoming second\n");
    const saved = await service.shelve({
        name: "C shelf",
        paths: mixed ? ["shared.txt", "second.txt"] : ["shared.txt"],
        silent: true,
        keepLocal: true,
    });
    const shelf = await f.store.readCurrentShelfManifest(saved.shelfId!);
    if (mixed) await writeFile(path.join(f.root, "second.txt"), "local second\n");
    const local = base.replace("line-3\n", "owned-A\n").replace("line-12\n", "owned-B\n");
    await writeFile(path.join(f.root, "shared.txt"), local);
    for (const name of ["B", "C", "D"])
        await changelists.create(f.root, changelists.revision(f.root), name);
    const state = changelists.get(f.root);
    const a = state.lists[0].id;
    const b = state.lists.find((list) => list.name === "B")!.id;
    const c = state.lists.find((list) => list.name === "C")!.id;
    const d = state.lists.find((list) => list.name === "D")!.id;
    const before = await readPartialSnapshot(f.executor, f.root, "shared.txt", "working");
    await changelists.track(f.root, "shared.txt", rangeSnapshot(before));
    const changed = before.view.blocks
        .flatMap((block) => block.lines)
        .filter((line) => line.kind !== "context");
    for (const [owner, texts] of [
        [a, ["line-3", "owned-A"]],
        [b, ["line-12", "owned-B"]],
    ] as const) {
        await changelists.assignChanges(
            f.root,
            changelists.revision(f.root),
            "shared.txt",
            before.contentId,
            owner,
            changed
                .filter((line) => texts.includes(line.text.trimEnd()))
                .map((line) => line.fingerprint),
            new Set(changed.map((line) => line.fingerprint)),
        );
    }
    await changelists.activate(f.root, changelists.revision(f.root), c);
    await changelists.saveDraft(f.root, d, "", "destination draft");
    const index = await readFile(path.join(f.root, ".git", "index"));
    return {
        ...f,
        service,
        changelists,
        a,
        b,
        c,
        d,
        index,
        base,
        local,
        shelf,
        input: {
            id: saved.shelfId!,
            mode: "flattened" as const,
            removeFromShelf,
            expectedShelfGeneration: shelf.generation,
            targetOperation: {
                id: randomUUID(),
                root: f.root,
                target: {
                    kind: "existing" as const,
                    id: d,
                    revision: changelists.revision(f.root),
                },
                sourceChecksum: shelf.checksum,
                draftChoice: { kind: "keep" as const },
            },
        },
    };
}

describe("targeted shelf restore service", () => {
    it("restore targets D without stealing A or B and without activating D", async () => {
        const f = await restoreFixture();
        const result = await f.service.unshelve(f.input);
        expect(await readFile(path.join(f.root, "shared.txt"), "utf8")).toBe(
            f.local.replace("line-25\n", "incoming-C\n"),
        );
        expect(await readFile(path.join(f.root, ".git", "index"))).toEqual(f.index);
        const state = f.changelists.get(f.root);
        expect(state.activeId).toBe(f.c);
        expect(state.lists.find((list) => list.id === f.d)?.draft).toBe("destination draft");
        const after = await readPartialSnapshot(f.executor, f.root, "shared.txt", "working");
        for (const [owner, texts] of [
            [f.a, ["line-3", "owned-A"]],
            [f.b, ["line-12", "owned-B"]],
            [f.d, ["line-25", "incoming-C"]],
        ] as const) {
            const lines = after.view.blocks
                .flatMap((block) => block.lines)
                .filter((line) => line.kind !== "context" && texts.includes(line.text.trimEnd()));
            expect(lines).toHaveLength(2);
            for (const line of lines)
                expect(
                    state.changes["shared.txt"].lines[line.fingerprint] ??
                        state.files["shared.txt"],
                    `owner of ${line.text}`,
                ).toBe(owner);
        }
        expect(result.status).toBe("applied");
        expect(state.pendingTargetOperation).toBeUndefined();
        expect(state.targetOperationReceipts?.[f.input.targetOperation.id]?.outcome).toBe(
            "applied",
        );
        expect(await f.store.readCurrentShelfManifest(f.input.id)).toEqual(f.shelf);
    });
});

/** Reopens both durable stores to prove replay does not rely on process-local request caches. */
async function reopen(f: Awaited<ReturnType<typeof restoreFixture>>) {
    const changelists = await connectedChangelists(f.root);
    const store = new ShelfStore(
        await resolveShelfPaths({ repositoryRoot: f.root, globalStoragePath: f.storageRoot }),
    );
    const service = new ShelfService({
        repositoryRoot: f.root,
        executor: f.executor,
        store,
        changelists,
        gate: new RepositoryMutationGate(new RepositoryMutationCoordinator(), new RepositoryLock()),
    });
    return { changelists, store, service };
}

/** Shelves a second, unrelated change and builds a request that reuses the fixture's operation id. */
async function otherShelf(f: Awaited<ReturnType<typeof restoreFixture>>) {
    await writeFile(path.join(f.root, "second.txt"), "other shelf\n");
    const saved = await f.service.shelve({
        name: "Other shelf",
        paths: ["second.txt"],
        silent: true,
        keepLocal: true,
    });
    const shelf = await f.store.readCurrentShelfManifest(saved.shelfId!);
    return {
        shelf,
        input: {
            ...f.input,
            id: saved.shelfId!,
            expectedShelfGeneration: shelf.generation,
            targetOperation: { ...f.input.targetOperation, sourceChecksum: shelf.checksum },
        },
    };
}

/** Git commands other than the read-only repository admission every targeted call performs. */
function beyondAdmission(spy: ReturnType<typeof vi.spyOn>) {
    return spy.mock.calls
        .map((call) => (call[0] as string[]).join(" "))
        .filter(
            (command) => !/^rev-parse --(?:show-toplevel|git-dir|git-common-dir)$/.test(command),
        );
}

/** Counts only actual worktree applies, excluding dry-run admission checks. */
function appliedCalls(spy: ReturnType<typeof vi.spyOn>) {
    return spy.mock.calls.filter(
        (call) => JSON.stringify(call[0]) === JSON.stringify(["apply", "-"]),
    ).length;
}

/** Replaces immutable source bytes as an external old client could, retaining its generation. */
async function replaceSource(f: Awaited<ReturnType<typeof restoreFixture>>) {
    const paths = await resolveShelfPaths({
        repositoryRoot: f.root,
        globalStoragePath: f.storageRoot,
    });
    const file = path.join(
        paths.root,
        "shelves",
        f.input.id,
        `gen-${f.shelf.generation}`,
        "manifest.json",
    );
    const source = JSON.parse(await readFile(file, "utf8"));
    source.metadata.name = "External replacement";
    source.checksum = createHash("sha256")
        .update(JSON.stringify({ ...source, checksum: "" }))
        .digest("hex");
    await writeFile(file, JSON.stringify(source));
    return source;
}

describe("targeted restore durability and admission", () => {
    it("source checksum replacement rejects before Git or new list publication", async () => {
        const f = await restoreFixture();
        const spy = vi.spyOn(f.executor, "runBinary");
        const before = f.changelists.get(f.root);
        await replaceSource(f);
        const result = await f.service.unshelve({
            ...f.input,
            targetOperation: {
                ...f.input.targetOperation,
                target: { kind: "new", name: "Never created", revision: before.revision },
            },
        });
        expect(result.status, "same-generation checksum replacement must be stale").toBe("stale");
        expect(appliedCalls(spy), "stale source must run zero Git applies").toBe(0);
        expect(f.changelists.get(f.root)).toEqual(before);
        expect(await readFile(path.join(f.root, "shared.txt"), "utf8")).toBe(f.local);
    });

    it("actual shelf collaborator root mismatch rejects before Git", async () => {
        const f = await restoreFixture();
        const other = await restoreFixture();
        const spy = vi.spyOn(f.executor, "runBinary");
        const service = new ShelfService({
            repositoryRoot: f.root,
            executor: f.executor,
            store: other.store,
            changelists: f.changelists,
            gate: new RepositoryMutationGate(
                new RepositoryMutationCoordinator(),
                new RepositoryLock(),
            ),
        });
        const result = await service.unshelve({
            ...f.input,
            id: other.input.id,
            expectedShelfGeneration: other.shelf.generation,
            targetOperation: { ...f.input.targetOperation, sourceChecksum: other.shelf.checksum },
        });
        expect(result.status).toBe("stale");
        expect(appliedCalls(spy), "wrong actual shelf root must not apply").toBe(0);
        expect(f.changelists.get(f.root).pendingTargetOperation).toBeUndefined();
    });

    it("captured root mismatch and stale destination revision run zero Git commands", async () => {
        const f = await restoreFixture();
        const spy = vi.spyOn(f.executor, "runBinary");
        const first = await f.service.unshelve({
            ...f.input,
            targetOperation: { ...f.input.targetOperation, root: path.dirname(f.root) },
        });
        expect(first.status).toBe("stale");
        await f.changelists.saveDraft(f.root, f.d, "destination draft", "later draft");
        expect((await f.service.unshelve(f.input)).status).toBe("stale");
        expect(appliedCalls(spy)).toBe(0);
        expect(f.changelists.get(f.root).lists.find((list) => list.id === f.d)?.draft).toBe(
            "later draft",
        );
    });

    it("known completed request returns its receipt without another apply", async () => {
        const f = await restoreFixture(true);
        const spy = vi.spyOn(f.executor, "runBinary");
        expect((await f.service.unshelve(f.input)).status).toBe("applied");
        const current = await f.store.readCurrentShelfManifest(f.input.id);
        expect(current.generation).toBe(f.shelf.generation + 1);
        expect(current.files.every((entry) => entry.lifecycle === "applied")).toBe(true);
        const second = await reopen(f);
        expect((await second.service.unshelve(f.input)).status).toBe("applied");
        expect(appliedCalls(spy), "terminal receipt must prevent repeat Git").toBe(1);
        expect(await second.store.readCurrentShelfManifest(f.input.id)).toEqual(current);
    });

    it("reused operation id for a different shelf never reports applied", async () => {
        const f = await restoreFixture();
        expect((await f.service.unshelve(f.input)).status).toBe("applied");
        const other = await otherShelf(f);
        const spy = vi.spyOn(f.executor, "runBinary");
        const before = f.changelists.get(f.root);
        const result = await f.service.unshelve(other.input);
        expect(result.status, "a receipt must never answer for another shelf").toBe("stale");
        expect(result.entries, "another operation's entries must not be relabelled").toEqual([]);
        expect(beyondAdmission(spy), "identity refusal must run no Git past admission").toEqual([]);
        expect(f.changelists.get(f.root)).toEqual(before);
        expect(await f.store.readCurrentShelfManifest(other.input.id)).toEqual(other.shelf);
        expect(await readFile(path.join(f.root, "second.txt"), "utf8")).toBe("other shelf\n");
    });

    it("reused operation id for a different selection never reports applied", async () => {
        const f = await restoreFixture(false, true);
        const shared = f.shelf.files.find(
            (entry) => (entry.worktreeBlock ?? entry.indexBlock)?.path === "shared.txt",
        )!.changeId;
        expect((await f.service.unshelve({ ...f.input, changeIds: [shared] })).status).toBe(
            "applied",
        );
        const spy = vi.spyOn(f.executor, "runBinary");
        const before = f.changelists.get(f.root);
        const result = await f.service.unshelve(f.input);
        expect(result.status, "a receipt must never answer for another selection").toBe("stale");
        expect(beyondAdmission(spy), "identity refusal must run no Git past admission").toEqual([]);
        expect(f.changelists.get(f.root)).toEqual(before);
        expect(await readFile(path.join(f.root, "second.txt"), "utf8")).toBe("local second\n");
    });

    it("reused pending operation id for a different shelf never resumes it", async () => {
        const f = await restoreFixture();
        const other = await otherShelf(f);
        const target = {
            ...f.input.targetOperation.target,
            revision: f.changelists.revision(f.root),
        };
        vi.spyOn(f.changelists, "finishTargetOperation").mockRejectedValueOnce(
            new Error("receipt interruption"),
        );
        expect(
            (
                await f.service.unshelve({
                    ...f.input,
                    targetOperation: { ...f.input.targetOperation, target },
                })
            ).status,
        ).toBe("appliedNeedsReview");
        const spy = vi.spyOn(f.executor, "runBinary");
        const before = f.changelists.get(f.root);
        const result = await f.service.unshelve({
            ...other.input,
            targetOperation: { ...other.input.targetOperation, target },
        });
        expect(result.status, "a pending record must never answer for another shelf").toBe("stale");
        expect(result.entries, "another operation's entries must not be relabelled").toEqual([]);
        expect(beyondAdmission(spy), "identity refusal must run no Git past admission").toEqual([]);
        expect(f.changelists.get(f.root)).toEqual(before);
        expect(await f.store.readCurrentShelfManifest(other.input.id)).toEqual(other.shelf);
    });

    it("reused pending operation id with a different draft choice never resumes it", async () => {
        const f = await restoreFixture();
        const spy = vi.spyOn(f.executor, "runBinary");
        vi.spyOn(f.changelists, "finishTargetOperation").mockRejectedValueOnce(
            new Error("receipt interruption"),
        );
        expect((await f.service.unshelve(f.input)).status).toBe("appliedNeedsReview");
        const before = f.changelists.get(f.root);
        const result = await f.service.unshelve({
            ...f.input,
            targetOperation: {
                ...f.input.targetOperation,
                draftChoice: {
                    kind: "copySource",
                    sourceListId: "default",
                    expectedDestinationDraft: "destination draft",
                },
            },
        });
        expect(result.status, "a changed draft choice is a different request").toBe("stale");
        expect(f.changelists.get(f.root)).toEqual(before);
        expect((await f.service.unshelve(f.input)).status, "original request still completes").toBe(
            "applied",
        );
        expect(appliedCalls(spy)).toBe(1);
    });

    it("known copied-draft receipt replays without Git after shelf publication", async () => {
        const f = await restoreFixture(true);
        const input = await copySource(f);
        const spy = vi.spyOn(f.executor, "runBinary");
        expect((await f.service.unshelve(input)).status).toBe("applied");
        const second = await reopen(f);
        expect((await second.service.unshelve(input)).status).toBe("applied");
        expect(appliedCalls(spy), "terminal receipt must prevent repeat Git").toBe(1);
    });

    it("no-removal restore preserves reusable shelf across restart", async () => {
        const f = await restoreFixture();
        const spy = vi.spyOn(f.executor, "runBinary");
        vi.spyOn(f.changelists, "finishTargetOperation").mockRejectedValueOnce(
            new Error("receipt interruption"),
        );
        expect((await f.service.unshelve(f.input)).status).toBe("appliedNeedsReview");
        expect(f.changelists.get(f.root).pendingTargetOperation?.phase).toBe("ownershipPublished");
        expect(
            await f.store.readCurrentShelfManifest(f.input.id),
            "remove=false must preserve exact reusable manifest",
        ).toEqual(f.shelf);
        const second = await reopen(f);
        expect((await second.service.unshelve(f.input)).status).toBe("applied");
        expect(await second.store.readCurrentShelfManifest(f.input.id)).toEqual(f.shelf);
        expect(appliedCalls(spy)).toBe(1);
    });

    it("ownership-to-shelf crash retains pending and applies exactly once", async () => {
        const f = await restoreFixture(true);
        const spy = vi.spyOn(f.executor, "runBinary");
        vi.spyOn(f.changelists, "publishTargetShelf").mockRejectedValueOnce(
            new Error("ownership boundary"),
        );
        expect((await f.service.unshelve(f.input)).status).toBe("appliedNeedsReview");
        expect(f.changelists.get(f.root).pendingTargetOperation?.phase).toBe("ownershipPublished");
        expect(await f.store.readCurrentShelfManifest(f.input.id)).toEqual(f.shelf);
        const second = await reopen(f);
        expect((await second.service.unshelve(f.input)).status).toBe("applied");
        expect(second.changelists.get(f.root).pendingTargetOperation).toBeUndefined();
        expect(appliedCalls(spy)).toBe(1);
    });

    it("shelf-pointer-to-ack crash publishes no duplicate generation", async () => {
        const f = await restoreFixture(true);
        const spy = vi.spyOn(f.executor, "runBinary");
        const publish = f.store.publishTargetOperation.bind(f.store);
        vi.spyOn(f.store, "publishTargetOperation").mockImplementationOnce(async (request) => {
            await publish(request);
            throw new Error("pointer acknowledged only on disk");
        });
        expect((await f.service.unshelve(f.input)).status).toBe("appliedNeedsReview");
        const published = await f.store.readCurrentShelfManifest(f.input.id);
        expect(published.generation).toBe(f.shelf.generation + 1);
        expect(f.changelists.get(f.root).pendingTargetOperation?.phase).toBe("ownershipPublished");
        const second = await reopen(f);
        expect((await second.service.unshelve(f.input)).status).toBe("applied");
        expect(await second.store.readCurrentShelfManifest(f.input.id)).toEqual(published);
        expect(appliedCalls(spy)).toBe(1);
    });

    it("metadata failure after apply is recovered without another apply", async () => {
        const f = await restoreFixture();
        const spy = vi.spyOn(f.executor, "runBinary");
        vi.spyOn(f.changelists, "checkpointTargetOperation").mockRejectedValueOnce(
            new Error("after Git before checkpoint"),
        );
        expect((await f.service.unshelve(f.input)).status).toBe("appliedNeedsReview");
        expect(f.changelists.get(f.root).pendingTargetOperation?.phase).toBe("prepared");
        const second = await reopen(f);
        expect((await second.service.unshelve(f.input)).status).toBe("appliedNeedsReview");
        expect(second.changelists.get(f.root).pendingTargetOperation?.phase).toBe("reviewRequired");
        expect(appliedCalls(spy), "uncertain Git must never replay").toBe(1);
        expect(await readFile(path.join(f.root, "shared.txt"), "utf8")).toBe(
            f.local.replace("line-25\n", "incoming-C\n"),
        );
    });

    it("interruption before Git completes notApplied only with exact unchanged evidence", async () => {
        const f = await restoreFixture();
        const binary = f.executor.runBinary.bind(f.executor);
        const spy = vi.spyOn(f.executor, "runBinary").mockImplementation(async (args, options) => {
            if (JSON.stringify(args) === JSON.stringify(["apply", "-"]))
                throw new Error("before Git");
            return binary(args, options);
        });
        expect((await f.service.unshelve(f.input)).status).toBe("appliedNeedsReview");
        const second = await reopen(f);
        expect((await second.service.unshelve(f.input)).status).toBe("notApplied");
        expect(appliedCalls(spy)).toBe(1);
        expect(await readFile(path.join(f.root, "shared.txt"), "utf8")).toBe(f.local);
        expect(second.changelists.get(f.root).pendingTargetOperation).toBeUndefined();
    });

    it("gitApplied-to-ownership interruption resumes attribution without another apply", async () => {
        const f = await restoreFixture();
        const spy = vi.spyOn(f.executor, "runBinary");
        vi.spyOn(f.changelists, "publishTargetOwnership").mockRejectedValueOnce(
            new Error("before ownership"),
        );
        expect((await f.service.unshelve(f.input)).status).toBe("appliedNeedsReview");
        expect(f.changelists.get(f.root).pendingTargetOperation?.phase).toBe("gitApplied");
        const second = await reopen(f);
        expect((await second.service.unshelve(f.input)).status).toBe("applied");
        expect(appliedCalls(spy)).toBe(1);
    });

    it("failure kept for review after Git writes its error to the Shelf log", async () => {
        const f = await restoreFixture();
        const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
        vi.spyOn(f.changelists, "publishTargetOwnership").mockRejectedValueOnce(
            new Error("ownership write refused"),
        );
        expect((await f.service.unshelve(f.input)).status).toBe("appliedNeedsReview");
        expect(f.changelists.get(f.root).pendingTargetOperation?.phase).toBe("gitApplied");
        expect(warning).toHaveBeenCalledWith(
            expect.stringMatching(
                new RegExp(
                    `^\\[Shelf\\] .*${f.input.targetOperation.id}.*: ownership write refused$`,
                ),
            ),
        );
    });

    it("stale shelf after ownership never recopies draft or reapplies Git", async () => {
        const f = await restoreFixture();
        const spy = vi.spyOn(f.executor, "runBinary");
        vi.spyOn(f.changelists, "finishTargetOperation").mockRejectedValueOnce(
            new Error("after ownership"),
        );
        expect((await f.service.unshelve(f.input)).status).toBe("appliedNeedsReview");
        await f.changelists.saveDraft(f.root, f.d, "destination draft", "later user draft");
        const replaced = await replaceSource(f);
        const second = await reopen(f);
        expect((await second.service.unshelve(f.input)).status).toBe("appliedNeedsReview");
        expect(second.changelists.get(f.root).lists.find((list) => list.id === f.d)?.draft).toBe(
            "later user draft",
        );
        expect(await second.store.readCurrentShelfManifest(f.input.id)).toEqual(replaced);
        expect(appliedCalls(spy)).toBe(1);
    });

    it("restore conflict preserves local edit and retains target after restart", async () => {
        const f = await restoreFixture(true, true);
        const spy = vi.spyOn(f.executor, "runBinary");
        const result = await f.service.unshelve(f.input);
        expect(result.status).toBe("conflicted");
        expect(result.entries.some((entry) => entry.kind === "applied")).toBe(true);
        expect(result.entries.some((entry) => entry.kind === "conflicted")).toBe(true);
        const pending = f.changelists.get(f.root).pendingTargetOperation!;
        expect(pending.destinationId).toBe(f.d);
        const persistence = await ChangelistPersistence.open(f.root, path.join(f.root, ".git"));
        const evidence = await persistence.loadTargetOperationEvidence(pending.evidenceHash);
        expect(evidence.entries.map((entry) => entry.outcome).sort()).toEqual([
            "applied",
            "conflicted",
        ]);
        const conflicted = await readFile(path.join(f.root, "second.txt"), "utf8");
        expect(conflicted).toContain("local second\n");
        expect(conflicted).toContain("incoming second\n");
        expect(conflicted).toContain("<<<<<<< ");
        expect(await readFile(path.join(f.root, ".git", "index"))).toEqual(f.index);
        expect(await f.store.readCurrentShelfManifest(f.input.id)).toEqual(f.shelf);
        const second = await reopen(f);
        expect((await second.service.unshelve(f.input)).status).toBe("conflicted");
        expect(second.changelists.get(f.root).pendingTargetOperation?.destinationId).toBe(f.d);
        expect(appliedCalls(spy)).toBe(1);
    });

    it.each(["lease release", "delivery"] as const)(
        "%s failure after durable completion retains appliedNeedsReview identity",
        async (kind) => {
            const f = await restoreFixture();
            if (kind === "lease release") {
                const acquire = ChangelistPersistence.prototype.acquire;
                vi.spyOn(ChangelistPersistence.prototype, "acquire").mockImplementationOnce(
                    async function () {
                        const release = await acquire.call(this);
                        return async () => {
                            await release();
                            throw new Error("release after completion");
                        };
                    },
                );
            } else {
                const finish = f.changelists.finishTargetOperation.bind(f.changelists);
                vi.spyOn(f.changelists, "finishTargetOperation").mockImplementationOnce(
                    async (...args) => {
                        await finish(...args);
                        throw new Error("delivery after receipt");
                    },
                );
            }
            const result = await f.service.unshelve(f.input);
            expect(result.status).toBe("appliedNeedsReview");
            expect(result.operationId).toBe(f.input.targetOperation.id);
            expect(
                f.changelists.get(f.root).targetOperationReceipts?.[result.operationId]?.outcome,
            ).toBe("applied");
            expect((await (await reopen(f)).service.unshelve(f.input)).status).toBe("applied");
        },
    );

    it("ownership read rejects released leases after awaited hydration", async () => {
        const f = await restoreFixture();
        const lease = await f.changelists.acquireTargetOperationLease(f.root);
        const load = ChangelistPersistence.prototype.loadSnapshot;
        vi.spyOn(ChangelistPersistence.prototype, "loadSnapshot").mockImplementationOnce(
            async function (...args) {
                const value = await load.apply(this, args);
                await lease.release();
                return value;
            },
        );
        await expect(
            f.changelists.readTargetOperationOwnership(f.root, lease, ["shared.txt"]),
        ).rejects.toThrow();
    });
});

it("actual service SIGKILL after pointer resumes in a second process without Git replay", async () => {
    const f = await restoreFixture(true);
    await writeFile(path.join(f.root, "restore-input.json"), JSON.stringify(f.input));
    const worker = (mode: string) =>
        new Promise<{ pid: number; code: number | null; stderr: string }>((resolve, reject) => {
            const child = spawn(
                "bun",
                ["tests/integration/shelf/listAwareRestoreCrashWorker.ts", f.root, mode],
                { cwd: process.cwd(), stdio: ["ignore", "ignore", "pipe"] },
            );
            let stderr = "";
            child.stderr.on("data", (data: Buffer) => {
                stderr += data.toString();
            });
            child.once("error", reject);
            child.once("close", (code) => resolve({ pid: child.pid!, code, stderr }));
        });
    const crashed = await worker("crash");
    expect(crashed.stderr).toBe("");
    expect(crashed.code).not.toBe(0);
    expect(() => process.kill(crashed.pid, 0)).toThrow();
    const paths = await resolveShelfPaths({
        repositoryRoot: f.root,
        globalStoragePath: f.storageRoot,
    });
    const durable = JSON.parse(
        await readFile(
            path.join(f.root, ".git", "intelligit", "changelists", "state.json"),
            "utf8",
        ),
    );
    expect(durable.state.pendingTargetOperation.phase).toBe("ownershipPublished");
    for (const lockFile of [
        path.join(paths.root, ".store-lock", "store.lock"),
        path.join(f.root, ".git", "intelligit", "repo.lock"),
        path.join(f.root, ".git", "intelligit", "changelists", "metadata.lock"),
    ]) {
        const owner = JSON.parse(await readFile(lockFile, "utf8"));
        expect(owner.pid).toBe(crashed.pid);
        await writeFile(lockFile, JSON.stringify({ ...owner, heartbeatAt: 0 }));
    }
    const second = await reopen(f);
    const published = await second.store.readCurrentShelfManifest(f.input.id);
    await second.changelists.saveDraft(f.root, f.d, "destination draft", "later user draft");
    const resumed = await worker("resume");
    expect(resumed.stderr).toBe("");
    expect(resumed.code).toBe(0);
    const result = JSON.parse(await readFile(path.join(f.root, "restore-result.json"), "utf8"));
    expect(result.result.status).toBe("applied");
    expect(result.state.pendingTargetOperation).toBeUndefined();
    expect(result.state.lists.find((list: { id: string }) => list.id === f.d).draft).toBe(
        "later user draft",
    );
    expect(await second.store.readCurrentShelfManifest(f.input.id)).toEqual(published);
    expect(
        await readFile(path.join(f.root, "restore-apply-count"), "utf8"),
        "second process must never apply Git again",
    ).toBe("1\n");
    expect(await readFile(path.join(f.root, ".git", "index"))).toEqual(f.index);
});

/** Adds an explicit captured source draft to this fixture's persisted shelf. */
async function copySource(f: Awaited<ReturnType<typeof restoreFixture>>) {
    const shelf = await f.store.writeShelfGeneration(f.input.id, {
        schemaVersion: 2,
        objectHashes: f.shelf.objectHashes,
        files: f.shelf.files,
        metadata: {
            ...f.shelf.metadata,
            selection: {
                version: 1,
                scope: "files",
                sourceLists: [
                    { id: "default", name: "Source", description: "", draft: "source draft" },
                ],
                entries: f.shelf.files.map((entry) => ({
                    changeId: entry.changeId,
                    sourceListIds: ["default"],
                })),
            },
        },
    });
    return {
        ...f.input,
        expectedShelfGeneration: shelf.generation,
        targetOperation: {
            ...f.input.targetOperation,
            sourceChecksum: shelf.checksum,
            draftChoice: {
                kind: "copySource" as const,
                sourceListId: "default",
                expectedDestinationDraft: "destination draft",
            },
        },
    };
}

describe("targeted restore captured decisions", () => {
    it("explicit draft copy happens once and a later destination draft survives replay", async () => {
        const f = await restoreFixture(true);
        const input = await copySource(f);
        const spy = vi.spyOn(f.executor, "runBinary");
        vi.spyOn(f.changelists, "publishTargetShelf").mockRejectedValueOnce(
            new Error("after draft copy"),
        );
        expect((await f.service.unshelve(input)).status).toBe("appliedNeedsReview");
        expect(f.changelists.get(f.root).lists.find((list) => list.id === f.d)?.draft).toBe(
            "source draft",
        );
        await f.changelists.saveDraft(f.root, f.d, "source draft", "later draft");
        const second = await reopen(f);
        expect((await second.service.unshelve(input)).status).toBe("applied");
        expect(
            second.changelists.get(f.root).lists.find((list) => list.id === f.d)?.draft,
            "ownership checkpoint must prevent draft recopy",
        ).toBe("later draft");
        expect(appliedCalls(spy)).toBe(1);
    });

    it("changed destination draft rejects captured copy before Git", async () => {
        const f = await restoreFixture();
        const input = await copySource(f);
        await f.changelists.saveDraft(f.root, f.d, "destination draft", "edited during prompt");
        const spy = vi.spyOn(f.executor, "runBinary");
        await expect(
            f.service.unshelve({
                ...input,
                targetOperation: {
                    ...input.targetOperation,
                    target: {
                        ...input.targetOperation.target,
                        revision: f.changelists.revision(f.root),
                    },
                },
            }),
        ).rejects.toThrow("destination draft changed");
        expect(appliedCalls(spy)).toBe(0);
        expect(f.changelists.get(f.root).pendingTargetOperation).toBeUndefined();
    });

    it("stale conflict source remains pending review after restart", async () => {
        const f = await restoreFixture(true, true);
        expect((await f.service.unshelve(f.input)).status).toBe("conflicted");
        const bytes = await readFile(path.join(f.root, "second.txt"));
        await replaceSource(f);
        const second = await reopen(f);
        const spy = vi.spyOn(f.executor, "runBinary");
        expect(
            (await second.service.unshelve(f.input)).status,
            "changed conflict shelf must require review",
        ).toBe("appliedNeedsReview");
        expect(second.changelists.get(f.root).pendingTargetOperation?.destinationId).toBe(f.d);
        expect(await readFile(path.join(f.root, "second.txt"))).toEqual(bytes);
        expect(appliedCalls(spy)).toBe(0);
    });

    it("external affected-file edit before ownership is retained for review", async () => {
        const f = await restoreFixture();
        const publish = f.changelists.publishTargetOwnership.bind(f.changelists);
        vi.spyOn(f.changelists, "publishTargetOwnership").mockImplementationOnce(
            async (...args) => {
                await writeFile(path.join(f.root, "shared.txt"), "external edit\n");
                return publish(...args);
            },
        );
        // The observation was captured before this injected external edit; the next independent completion observation must reject it.
        expect((await f.service.unshelve(f.input)).status).toBe("appliedNeedsReview");
        expect(await readFile(path.join(f.root, "shared.txt"), "utf8")).toBe("external edit\n");
        expect(f.changelists.get(f.root).pendingTargetOperation?.phase).toBe("reviewRequired");
        expect(await f.store.readCurrentShelfManifest(f.input.id)).toEqual(f.shelf);
    });

    it.each([false, true])(
        "retained exact entries with successful subset=%s never silently clear pending",
        async (partial) => {
            const f = await restoreFixture(true, partial);
            if (!partial)
                await writeFile(
                    path.join(f.root, "shared.txt"),
                    f.local.replace("line-25\n", "local conflicting change\n"),
                );
            const input = { ...f.input, mode: "exactState" as const };
            const spy = vi.spyOn(f.executor, "runBinary");
            const result = await f.service.unshelve(input);
            expect(result.entries.some((entry) => entry.kind === "retained")).toBe(true);
            expect(result.status).toBe(partial ? "appliedNeedsReview" : "notApplied");
            expect(appliedCalls(spy)).toBe(partial ? 1 : 0);
            expect(await f.store.readCurrentShelfManifest(f.input.id)).toEqual(f.shelf);
            const second = await reopen(f);
            expect((await second.service.unshelve(input)).status).toBe(
                partial ? "appliedNeedsReview" : "notApplied",
            );
            expect(appliedCalls(spy)).toBe(partial ? 1 : 0);
            expect(!!second.changelists.get(f.root).pendingTargetOperation).toBe(partial);
        },
    );
});

/** Opens the host-owned conflict session for the fixture's conflicted second-file entry. */
async function conflictSession(
    f: Awaited<ReturnType<typeof restoreFixture>>,
    service: ShelfService = f.service,
) {
    const change = (f.shelf.files as readonly ShelfFileEntry[]).find(
        (entry) => entry.worktreeBlock?.path === "second.txt",
    )!;
    const payload = await service.openShelfConflictSession(f.input.id, change.changeId);
    return {
        payload,
        resolve: (content: string) =>
            service.applyShelfConflictResolution({
                id: f.input.id,
                changeId: change.changeId,
                content,
                expectedShelfGeneration: payload.shelfGeneration,
                expectedPathFingerprint: payload.worktreeFingerprint,
                ...(payload.operationId ? { operationId: payload.operationId } : {}),
            }),
    };
}

/** Reads the saved owner of one changed line in the current working file. */
async function lineOwner(
    f: Awaited<ReturnType<typeof restoreFixture>>,
    changelists: typeof f.changelists,
    text: string,
) {
    const after = await readPartialSnapshot(f.executor, f.root, "second.txt", "working");
    const lines = after.view.blocks
        .flatMap((block) => block.lines)
        .filter((line) => line.kind !== "context" && line.text.trimEnd() === text);
    expect(lines, `changed line ${text}`).toHaveLength(1);
    const state = changelists.get(f.root);
    return state.changes["second.txt"]?.lines[lines[0].fingerprint] ?? state.files["second.txt"];
}

describe("targeted conflict continuation", () => {
    it("resolved conflict attributes only reviewed result", async () => {
        const f = await restoreFixture(true, true);
        const spy = vi.spyOn(f.executor, "runBinary");
        expect((await f.service.unshelve(f.input)).status).toBe("conflicted");
        const session = await conflictSession(f);
        expect(session.payload.operationId, "the editor must carry the host operation").toBe(
            f.input.targetOperation.id,
        );
        expect(await session.resolve("local second\nincoming second\n")).toEqual({
            status: "applied",
            newGeneration: expect.any(Number),
        });
        expect(await readFile(path.join(f.root, "second.txt"), "utf8")).toBe(
            "local second\nincoming second\n",
        );
        const state = f.changelists.get(f.root);
        expect(state.pendingTargetOperation).toBeUndefined();
        expect(state.targetOperationReceipts?.[f.input.targetOperation.id]?.outcome).toBe(
            "applied",
        );
        expect(
            await lineOwner(f, f.changelists, "incoming second"),
            "the reviewed incoming line belongs to the restore target",
        ).toBe(f.d);
        expect(
            await lineOwner(f, f.changelists, "local second"),
            "the kept local line keeps its prior owner",
        ).toBe(f.c);
        expect(
            await lineOwner(f, f.changelists, "base"),
            "the local deletion keeps its prior owner",
        ).toBe(f.c);
        expect(state.activeId).toBe(f.c);
        expect(await readFile(path.join(f.root, ".git", "index"))).toEqual(f.index);
        expect(appliedCalls(spy), "resolution must not replay the shelf apply").toBe(1);
        expect(
            (await f.store.readCurrentShelfManifest(f.input.id)).metadata.targetOperationReceipt
                ?.targetOperationId,
        ).toBe(f.input.targetOperation.id);
    });

    it("reviewed result that rewrites a local line stops for review instead of guessing", async () => {
        const f = await restoreFixture(true, true);
        expect((await f.service.unshelve(f.input)).status).toBe("conflicted");
        const session = await conflictSession(f);
        expect(await session.resolve("reviewed second\n")).toEqual({
            status: "applied",
            newGeneration: expect.any(Number),
            needsReview: true,
        });
        expect(await readFile(path.join(f.root, "second.txt"), "utf8")).toBe("reviewed second\n");
        const state = f.changelists.get(f.root);
        expect(state.pendingTargetOperation?.phase).toBe("reviewRequired");
        expect(state.pendingTargetOperation?.destinationId).toBe(f.d);
        expect(
            state.changes["second.txt"],
            "no owner is guessed for a rewritten line",
        ).toBeUndefined();
    });

    it("stale conflict editor cannot overwrite later edits", async () => {
        const f = await restoreFixture(true, true);
        expect((await f.service.unshelve(f.input)).status).toBe("conflicted");
        const session = await conflictSession(f);
        await writeFile(path.join(f.root, "second.txt"), "later edit\n");
        expect(await session.resolve("reviewed second\n")).toEqual({
            status: "stale",
            reason: "operation",
        });
        expect(
            await readFile(path.join(f.root, "second.txt"), "utf8"),
            "a stale editor must never overwrite later edits",
        ).toBe("later edit\n");
        expect(f.changelists.get(f.root).pendingTargetOperation?.phase).toBe("conflicted");
        expect(await f.store.readCurrentShelfManifest(f.input.id)).toEqual(f.shelf);
    });

    it("conflict restart keeps target, resolves once and never recopies the draft", async () => {
        const f = await restoreFixture(true, true);
        const input = await copySource(f);
        const spy = vi.spyOn(f.executor, "runBinary");
        expect((await f.service.unshelve(input)).status).toBe("conflicted");
        const second = await reopen(f);
        expect(second.changelists.get(f.root).pendingTargetOperation?.destinationId).toBe(f.d);
        const session = await conflictSession(f, second.service);
        expect((await session.resolve("local second\nincoming second\n")).status).toBe("applied");
        const draft = () =>
            second.changelists.get(f.root).lists.find((list) => list.id === f.d)?.draft;
        expect(draft()).toBe("source draft");
        expect(await lineOwner(f, second.changelists, "incoming second")).toBe(f.d);
        await second.changelists.saveDraft(f.root, f.d, "source draft", "later draft");
        const third = await reopen(f);
        expect((await third.service.unshelve(input)).status).toBe("applied");
        expect(
            third.changelists.get(f.root).lists.find((list) => list.id === f.d)?.draft,
            "a completed conflict restore must never recopy its draft",
        ).toBe("later draft");
        expect(appliedCalls(spy)).toBe(1);
    });

    it("closing the conflict editor keeps the operation pending", async () => {
        const f = await restoreFixture(true, true);
        expect((await f.service.unshelve(f.input)).status).toBe("conflicted");
        const pending = f.changelists.get(f.root).pendingTargetOperation;
        const session = await conflictSession(f);
        expect(
            f.changelists.get(f.root).pendingTargetOperation,
            "opening a session never advances the operation",
        ).toEqual(pending);
        await expect(
            f.service.applyShelfConflictResolution({
                id: f.input.id,
                changeId: (f.shelf.files as readonly ShelfFileEntry[]).find(
                    (entry) => entry.worktreeBlock?.path === "second.txt",
                )!.changeId,
                content: "untargeted\n",
                expectedShelfGeneration: session.payload.shelfGeneration,
                expectedPathFingerprint: session.payload.worktreeFingerprint,
            }),
            "an editor without the operation must not complete it",
        ).rejects.toThrow("Pending target operation");
        expect((await f.service.unshelve(f.input)).status).toBe("conflicted");
        expect(f.changelists.get(f.root).pendingTargetOperation?.destinationId).toBe(f.d);
    });
});

it("structural entry outcome and captured target survive service restart", async () => {
    const f = await restoreFixture(true, true, true);
    const first = await f.service.unshelve(f.input);
    expect(first.status).toBe("conflicted");
    const structural = first.entries.find((entry) => entry.kind === "structuralPending");
    expect(structural).toMatchObject({ kind: "structuralPending", path: "second.txt" });
    expect(await readFile(path.join(f.root, "second.txt"), "utf8")).toBe("local second\n");
    const second = await reopen(f);
    const resumed = await second.service.unshelve(f.input);
    expect(resumed.status).toBe("conflicted");
    expect(resumed.entries.find((entry) => entry.kind === "structuralPending")).toEqual(structural);
    expect(second.changelists.get(f.root).pendingTargetOperation?.destinationId).toBe(f.d);
    expect(await f.store.readCurrentShelfManifest(f.input.id)).toEqual(f.shelf);
});

it("clean added file uses actual absent HEAD evidence for whole-file attribution", async () => {
    const f = await restoreFixture();
    await writeFile(path.join(f.root, "added.txt"), "new shelved file\n");
    const saved = await f.service.shelve({
        name: "Added",
        paths: ["added.txt"],
        silent: true,
        keepLocal: true,
    });
    const shelf = await f.store.readCurrentShelfManifest(saved.shelfId!);
    await unlink(path.join(f.root, "added.txt"));
    const input = {
        ...f.input,
        id: saved.shelfId!,
        expectedShelfGeneration: shelf.generation,
        targetOperation: { ...f.input.targetOperation, sourceChecksum: shelf.checksum },
    };
    expect((await f.service.unshelve(input)).status).toBe("applied");
    expect(await readFile(path.join(f.root, "added.txt"), "utf8")).toBe("new shelved file\n");
    expect(f.changelists.get(f.root).files["added.txt"]).toBe(f.d);
    expect(f.changelists.get(f.root).activeId).toBe(f.c);
    expect(await readFile(path.join(f.root, ".git", "index"))).toEqual(f.index);
});

it("a file clean before the restore is owned whole by the destination, not partially", async () => {
    const f = await restoreFixture();
    await writeFile(path.join(f.root, "second.txt"), "base\nshelved second\n");
    const edited = await readPartialSnapshot(f.executor, f.root, "second.txt", "working");
    await f.changelists.track(f.root, "second.txt", rangeSnapshot(edited));
    const saved = await f.service.shelve({
        name: "Second",
        paths: ["second.txt"],
        silent: true,
        keepLocal: false,
    });
    expect(await readFile(path.join(f.root, "second.txt"), "utf8")).toBe("base\n");
    const shelf = await f.store.readCurrentShelfManifest(saved.shelfId!);
    const input = {
        ...f.input,
        id: saved.shelfId!,
        expectedShelfGeneration: shelf.generation,
        targetOperation: {
            ...f.input.targetOperation,
            target: { ...f.input.targetOperation.target, revision: f.changelists.revision(f.root) },
            sourceChecksum: shelf.checksum,
        },
    };
    expect((await f.service.unshelve(input)).status).toBe("applied");
    expect(await readFile(path.join(f.root, "second.txt"), "utf8")).toBe("base\nshelved second\n");
    const state = f.changelists.get(f.root);
    expect(state.files["second.txt"], "whole-file owner of second.txt").toBe(f.d);
    // Any line owner makes the commit panel mark the file Partial and disable its shelf actions.
    expect(
        Object.keys(state.changes["second.txt"]?.lines ?? {}),
        "line owners of second.txt",
    ).toEqual([]);
    expect(state.activeId).toBe(f.c);
});

it("restoring into the list that already owns a changed file keeps it whole, not Partial", async () => {
    const f = await restoreFixture();
    const committed = Array.from({ length: 10 }, (_, index) => `row-${index + 1}\n`).join("");
    const file = path.join(f.root, "owned.txt");
    await writeFile(file, committed);
    await git(f.root, ["add", "owned.txt"]);
    await git(f.root, ["commit", "-m", "owned fixture"]);
    await writeFile(file, committed.replace("row-9\n", "shelved-9\n"));
    const saved = await f.service.shelve({
        name: "Owned",
        paths: ["owned.txt"],
        silent: true,
        keepLocal: false,
    });
    const local = committed.replace("row-2\n", "local-2\n");
    await writeFile(file, local);
    const edited = await readPartialSnapshot(f.executor, f.root, "owned.txt", "working");
    await f.changelists.track(f.root, "owned.txt", rangeSnapshot(edited));
    await f.changelists.moveFiles(f.root, f.changelists.revision(f.root), f.d, ["owned.txt"]);
    const shelf = await f.store.readCurrentShelfManifest(saved.shelfId!);
    const input = {
        ...f.input,
        id: saved.shelfId!,
        expectedShelfGeneration: shelf.generation,
        targetOperation: {
            ...f.input.targetOperation,
            target: { ...f.input.targetOperation.target, revision: f.changelists.revision(f.root) },
            sourceChecksum: shelf.checksum,
        },
    };
    expect((await f.service.unshelve(input)).status).toBe("applied");
    expect(await readFile(file, "utf8")).toBe(local.replace("row-9\n", "shelved-9\n"));
    const state = f.changelists.get(f.root);
    expect(state.files["owned.txt"], "whole-file owner of owned.txt").toBe(f.d);
    expect(
        Object.keys(state.changes["owned.txt"]?.lines ?? {}),
        "line owners of owned.txt",
    ).toEqual([]);
});

it("ownership read returns detached snapshots and rejects same-lease revision drift", async () => {
    const f = await restoreFixture();
    const lease = await f.changelists.acquireTargetOperationLease(f.root);
    try {
        const first = await f.changelists.readTargetOperationOwnership(f.root, lease, [
            "shared.txt",
        ]);
        const original = structuredClone(first);
        first["shared.txt"]!.lines = {};
        expect(
            await f.changelists.readTargetOperationOwnership(f.root, lease, ["shared.txt"]),
        ).toEqual(original);
        const load = ChangelistPersistence.prototype.loadSnapshot;
        vi.spyOn(ChangelistPersistence.prototype, "loadSnapshot").mockImplementationOnce(
            async function (...args) {
                const value = await load.apply(this, args);
                const current = f.changelists.get(f.root).changes["shared.txt"];
                await f.changelists.consumeCommitted(
                    f.root,
                    "shared.txt",
                    current.contentId,
                    f.a,
                    new Set(),
                    new Set(Object.keys(current.lines)),
                    current.totalChanges!,
                    undefined,
                    lease,
                );
                return value;
            },
        );
        await expect(
            f.changelists.readTargetOperationOwnership(f.root, lease, ["shared.txt"]),
        ).rejects.toThrow("Changelists changed");
    } finally {
        await lease.release();
    }
});

it("clean tracked deletion remains structural pending without applying Git", async () => {
    const f = await restoreFixture(true, true, true);
    await writeFile(path.join(f.root, "second.txt"), "base\n");
    const deleted = (f.shelf.files as readonly ShelfFileEntry[]).find(
        (entry) => entry.worktreeBlock?.status === "D",
    )!;
    expect(deleted.worktreeBlock?.path).toBe("second.txt");
    const input = { ...f.input, changeIds: [deleted.changeId] };
    const spy = vi.spyOn(f.executor, "runBinary");
    const first = await f.service.unshelve(input);
    expect(first.status).toBe("conflicted");
    expect(first.entries).toMatchObject([{ kind: "structuralPending", path: "second.txt" }]);
    expect(await readFile(path.join(f.root, "second.txt"), "utf8")).toBe("base\n");
    expect(await readFile(path.join(f.root, "shared.txt"), "utf8")).toBe(f.local);
    expect(await readFile(path.join(f.root, ".git", "index"))).toEqual(f.index);
    expect(appliedCalls(spy), "clean deletion must await structural choice before Git").toBe(0);
    const second = await reopen(f);
    expect((await second.service.unshelve(input)).entries).toEqual(first.entries);
    expect(second.changelists.get(f.root).pendingTargetOperation?.destinationId).toBe(f.d);
    expect(second.changelists.get(f.root).activeId).toBe(f.c);
    expect(await f.store.readCurrentShelfManifest(f.input.id)).toEqual(f.shelf);
    expect(appliedCalls(spy)).toBe(0);
});

it("clean tracked rename retains both endpoints and target through restart", async () => {
    const f = await restoreFixture();
    await git(f.root, ["mv", "second.txt", "renamed.txt"]);
    const saved = await f.service.shelve({
        name: "Rename",
        paths: ["second.txt", "renamed.txt"],
        silent: true,
        keepLocal: true,
    });
    const shelf = await f.store.readCurrentShelfManifest(saved.shelfId!);
    expect(shelf.files).toHaveLength(1);
    expect((shelf.files[0] as ShelfFileEntry).indexBlock).toMatchObject({
        status: "R",
        renamedFrom: "second.txt",
        path: "renamed.txt",
    });
    await git(f.root, ["reset", "HEAD", "--", "second.txt", "renamed.txt"]);
    await git(f.root, ["restore", "--source=HEAD", "--worktree", "--", "second.txt"]);
    await unlink(path.join(f.root, "renamed.txt"));
    const index = await readFile(path.join(f.root, ".git", "index"));
    const input = {
        ...f.input,
        id: saved.shelfId!,
        expectedShelfGeneration: shelf.generation,
        targetOperation: { ...f.input.targetOperation, sourceChecksum: shelf.checksum },
    };
    const spy = vi.spyOn(f.executor, "runBinary");
    const first = await f.service.unshelve(input);
    expect(first.status).toBe("conflicted");
    expect(first.entries).toMatchObject([{ kind: "structuralPending", path: "second.txt" }]);
    expect(await readFile(path.join(f.root, "second.txt"), "utf8")).toBe("base\n");
    await expect(readFile(path.join(f.root, "renamed.txt"))).rejects.toMatchObject({
        code: "ENOENT",
    });
    expect(await readFile(path.join(f.root, ".git", "index"))).toEqual(index);
    expect(await readFile(path.join(f.root, "shared.txt"), "utf8")).toBe(f.local);
    expect(appliedCalls(spy), "rename must await structural choice before Git").toBe(0);
    const second = await reopen(f);
    expect((await second.service.unshelve(input)).entries).toEqual(first.entries);
    expect(second.changelists.get(f.root).pendingTargetOperation?.destinationId).toBe(f.d);
    expect(second.changelists.get(f.root).activeId).toBe(f.c);
    expect(await f.store.readCurrentShelfManifest(input.id)).toEqual(shelf);
    expect(appliedCalls(spy)).toBe(0);
});

/** Rewrites `.git/index` with stat data only, as an outside `git status` (VS Code's Git) does. */
async function refreshIndexStat(root: string) {
    const index = path.join(root, ".git", "index");
    const before = await readFile(index);
    const later = new Date(Date.now() + 60_000);
    await utimes(path.join(root, "second.txt"), later, later);
    await git(root, ["status", "--porcelain"]);
    expect(await readFile(index), "the outside refresh rewrites the index").not.toEqual(before);
}

// Each seam lands the refresh at a different restore checkpoint: the next entry's pre-check, the
// flattened index guard after the last entry, and ownership publication after the Git checkpoint.
it.each([
    ["between two entries", "checkpointTargetOperation", 1],
    ["after the last entry applies", "applyEntry", 20],
    ["before ownership publication", "checkpointTargetOperation", 21],
] as const)(
    "an outside index stat refresh %s of a re-shelved restore into the same list finishes applied",
    async (_when, seam, call) => {
        const f = await restoreFixture();
        const files = Array.from({ length: 20 }, (_, index) => `loop-${index + 1}.txt`);
        for (const file of files) await writeFile(path.join(f.root, file), "committed\n");
        await git(f.root, ["add", ...files]);
        await git(f.root, ["commit", "-m", "loop fixture"]);
        for (const file of files) {
            await writeFile(path.join(f.root, file), `changed ${file}\n`);
            const snapshot = await readPartialSnapshot(f.executor, f.root, file, "working");
            await f.changelists.track(f.root, file, rangeSnapshot(snapshot));
        }
        await f.changelists.moveFiles(f.root, f.changelists.revision(f.root), f.d, files);
        for (const round of [1, 2]) {
            const saved = await f.service.shelve({
                name: `Loop ${round}`,
                paths: files,
                silent: true,
                keepLocal: false,
            });
            const shelf = await f.store.readCurrentShelfManifest(saved.shelfId!);
            const owner = (seam === "applyEntry" ? f.service : f.changelists) as unknown as Record<
                typeof seam,
                (...args: unknown[]) => Promise<unknown>
            >;
            const original = owner[seam].bind(owner);
            let calls = 0;
            const apply = vi.spyOn(owner, seam).mockImplementation(async (...args) => {
                const value = await original(...args);
                if (round === 2 && ++calls === call) await refreshIndexStat(f.root);
                return value;
            });
            const result = await f.service.unshelve({
                ...f.input,
                id: saved.shelfId!,
                expectedShelfGeneration: shelf.generation,
                targetOperation: {
                    ...f.input.targetOperation,
                    id: randomUUID(),
                    target: {
                        ...f.input.targetOperation.target,
                        revision: f.changelists.revision(f.root),
                    },
                    sourceChecksum: shelf.checksum,
                },
            });
            apply.mockRestore();
            expect(result.status, `restore round ${round}`).toBe("applied");
            const state = f.changelists.get(f.root);
            for (const file of files) {
                expect(await readFile(path.join(f.root, file), "utf8")).toBe(`changed ${file}\n`);
                expect(state.files[file], `round ${round} owner of ${file}`).toBe(f.d);
            }
        }
    },
    // Two 20-file shelve and restore rounds take about 24 s alone, past the default under a full run.
    120_000,
);

// The observer pass after a shelve opens the first shelved file while VS Code's own `git status`
// rewrites the index; a stale mark set there would follow the file into the next restore.
it("an outside index stat refresh during the observer's capture of a shelved file leaves its restore applied", async () => {
    const f = await restoreFixture();
    const files = Array.from({ length: 20 }, (_, index) => `loop-${index + 1}.txt`);
    for (const file of files) await writeFile(path.join(f.root, file), "committed\n");
    await git(f.root, ["add", ...files]);
    await git(f.root, ["commit", "-m", "loop fixture"]);
    for (const file of files) {
        await writeFile(path.join(f.root, file), `changed ${file}\n`);
        const snapshot = await readPartialSnapshot(f.executor, f.root, file, "working");
        await f.changelists.track(f.root, file, rangeSnapshot(snapshot));
    }
    await f.changelists.moveFiles(f.root, f.changelists.revision(f.root), f.d, files);
    const saved = await f.service.shelve({
        name: "Loop",
        paths: files,
        silent: true,
        keepLocal: false,
    });
    const shelf = await f.store.readCurrentShelfManifest(saved.shelfId!);
    // `ls-tree` runs after the capture reads the index and before it rechecks it.
    const run = f.executor.run.bind(f.executor);
    let refreshed = false;
    const capture = vi.spyOn(f.executor, "run").mockImplementation(async (args, options) => {
        const output = await run(args, options);
        if (!refreshed && args.includes("ls-tree") && args.at(-1) === files[0]) {
            refreshed = true;
            await refreshIndexStat(f.root);
        }
        return output;
    });
    await new ChangeRangeTracker(
        f.root,
        new PartialChanges(f.executor, f.root),
        f.changelists,
    ).reconcile(await new GitOps(f.executor).getStatus({ withStats: false }));
    capture.mockRestore();
    expect(refreshed, "the refresh lands inside the first shelved file's capture").toBe(true);
    const stale = f.changelists.get(f.root).changes[files[0]]?.stale;
    const result = await f.service.unshelve({
        ...f.input,
        id: saved.shelfId!,
        expectedShelfGeneration: shelf.generation,
        targetOperation: {
            ...f.input.targetOperation,
            target: {
                ...f.input.targetOperation.target,
                revision: f.changelists.revision(f.root),
            },
            sourceChecksum: shelf.checksum,
        },
    });
    expect(result.status, "restore after the observer pass the refresh raced").toBe("applied");
    expect(stale, "a stat-only index rewrite during capture does not lose ownership").not.toBe(
        true,
    );
    const state = f.changelists.get(f.root);
    for (const file of files) {
        expect(await readFile(path.join(f.root, file), "utf8")).toBe(`changed ${file}\n`);
        expect(state.files[file], `owner of ${file}`).toBe(f.d);
    }
}, 120_000);
