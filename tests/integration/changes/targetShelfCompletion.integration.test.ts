import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, realpath, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { removeScratchDirectories } from "../../helpers/scratchDirectories";
import { ChangelistPersistence } from "../../../src/changes/changelistPersistence";
import { ShelfStore } from "../../../src/shelf/store";
import { resolveShelfPaths } from "../../../src/shelf/paths";
import {
    createCompletionFixture,
    openCompletionFixture,
    operationId,
} from "./targetShelfCompletionFixture";

const roots: string[] = [];
afterEach(async () => {
    vi.restoreAllMocks();
    await removeScratchDirectories(...roots.splice(0));
});
async function fixture(options: Parameters<typeof createCompletionFixture>[0] = {}) {
    const f = await createCompletionFixture(options);
    roots.push(f.root);
    return f;
}

describe("metadata completion bound to actual shelf publication", () => {
    it("recovers frozen partial success through a distinct shelf checkpoint and terminal receipt", async () => {
        const f = await fixture();
        expect(f.store.get(f.root).pendingTargetOperation?.phase).toBe("ownershipPublished");
        const reopened = await openCompletionFixture(f.root);
        const result = await reopened.withLease(async (lease) =>
            reopened.store.recoverTargetOperation(
                lease,
                await reopened.observation(),
                reopened.shelf,
            ),
        );
        expect(
            result.pendingTargetOperation,
            "actual shelf publication must complete before clearing pending",
        ).toBeUndefined();
        expect(result.targetOperationReceipts?.[operationId].outcome).toBe("applied");
        const manifest = await reopened.shelf.readCurrentShelfManifest("source");
        expect(manifest.files.map((entry) => entry.lifecycle)).toEqual(["applied", "shelved"]);
        expect(manifest.metadata.selection).toEqual(f.source.metadata.selection);
        expect(result.lists.find((list) => list.name === "Destination")?.draft).toBe(
            "captured shelf draft",
        );
        expect(await readFile(path.join(f.root, "git-apply-count"), "utf8")).toBe("1");
        expect(await readFile(path.join(f.root, "one.txt"), "utf8")).toBe("operation\n");
    });

    it("refuses same-generation changed source on no-removal completion despite a matching caller observation", async () => {
        const f = await fixture({ remove: false });
        const file = path.join(
            f.paths.root,
            "shelves",
            "source",
            `gen-${f.source.generation}`,
            "manifest.json",
        );
        const source = JSON.parse(await readFile(file, "utf8"));
        source.metadata.name = "External replacement";
        source.checksum = createHash("sha256")
            .update(JSON.stringify({ ...source, checksum: "" }))
            .digest("hex");
        await writeFile(file, JSON.stringify(source));
        const result = await f.withLease(async (lease) =>
            f.store.finishTargetOperation(lease, await f.observation(), f.shelf),
        );
        expect(
            result.pendingTargetOperation?.phase,
            "actual source identity must fence terminal metadata",
        ).toBe("reviewRequired");
        expect(result.targetOperationReceipts?.[operationId]).toBeUndefined();
        expect(await readFile(file, "utf8")).toBe(JSON.stringify(source));
    });

    it("persists a distinct shelfPublished checkpoint before terminal metadata", async () => {
        const f = await fixture();
        const published = await f.withLease(async (lease) =>
            f.store.publishTargetShelf(lease, await f.observation(), f.shelf),
        );
        const current = await f.shelf.readCurrentShelfManifest("source");
        expect(published.pendingTargetOperation?.phase).toBe("shelfPublished");
        expect(published.pendingTargetOperation?.completion).toMatchObject({
            shelfPublication: "published",
            publishedGeneration: current.generation,
            publishedChecksum: current.checksum,
        });
        expect(published.targetOperationReceipts?.[operationId]).toBeUndefined();
        const reopened = await openCompletionFixture(f.root);
        const finished = await reopened.withLease(async (lease) =>
            reopened.store.finishTargetOperation(
                lease,
                await reopened.observation(),
                reopened.shelf,
            ),
        );
        expect(finished.pendingTargetOperation).toBeUndefined();
    });

    it.each(["ownership", "shelf", "terminal"] as const)(
        "retains pending after %s metadata failure and recovers without replay or draft recopy",
        async (boundary) => {
            const f = await fixture({ ownership: boundary !== "ownership" });
            const original = ChangelistPersistence.prototype.write;
            const spy = vi
                .spyOn(ChangelistPersistence.prototype, "write")
                .mockImplementation(async function (state) {
                    const phase = state.pendingTargetOperation?.phase;
                    if (
                        (boundary === "ownership" && phase === "ownershipPublished") ||
                        (boundary === "shelf" && phase === "shelfPublished") ||
                        (boundary === "terminal" &&
                            !state.pendingTargetOperation &&
                            state.targetOperationReceipts?.[operationId])
                    )
                        throw new Error(`fail-${boundary}`);
                    return original.call(this, state);
                });
            await expect(
                f.withLease(async (lease) =>
                    f.store.recoverTargetOperation(lease, await f.observation(), f.shelf),
                ),
            ).rejects.toThrow(`fail-${boundary}`);
            spy.mockRestore();
            const pending = f.store.get(f.root).pendingTargetOperation!;
            expect(pending.phase).toBe(
                boundary === "ownership"
                    ? "gitApplied"
                    : boundary === "shelf"
                      ? "ownershipPublished"
                      : "shelfPublished",
            );
            expect(f.store.get(f.root).targetOperationReceipts?.[operationId]).toBeUndefined();
            const generation = (await f.shelf.readCurrentShelfManifest("source")).generation;
            expect(generation).toBe(
                boundary === "ownership" ? f.source.generation : f.source.generation + 1,
            );
            if (boundary !== "ownership")
                await f.store.saveDraft(
                    f.root,
                    pending.destinationId,
                    "captured shelf draft",
                    "later user draft",
                );
            const reopened = await openCompletionFixture(f.root);
            const result = await reopened.withLease(async (lease) =>
                reopened.store.recoverTargetOperation(
                    lease,
                    await reopened.observation(),
                    reopened.shelf,
                ),
            );
            expect(result.pendingTargetOperation).toBeUndefined();
            expect(result.lists.find((list) => list.id === pending.destinationId)?.draft).toBe(
                boundary === "ownership" ? "captured shelf draft" : "later user draft",
            );
            expect((await reopened.shelf.readCurrentShelfManifest("source")).generation).toBe(
                f.source.generation + 1,
            );
            expect(await readFile(path.join(f.root, "git-apply-count"), "utf8")).toBe("1");
            expect(await readFile(path.join(f.root, "one.txt"), "utf8")).toBe("operation\n");
        },
    );

    it("completes no-removal with unchanged lifecycle generation and appliedAt", async () => {
        const f = await fixture({ remove: false });
        const publish = vi.spyOn(f.shelf, "publishTargetOperation");
        const result = await f.withLease(async (lease) =>
            f.store.recoverTargetOperation(lease, await f.observation(), f.shelf),
        );
        expect(result.pendingTargetOperation).toBeUndefined();
        expect(await f.shelf.readCurrentShelfManifest("source")).toEqual(f.source);
        expect(publish).not.toHaveBeenCalled();
        expect(await f.shelf.readJournals()).toEqual([]);
    });

    it("finishes zero successes as notApplied without a shelf receipt or destination", async () => {
        const f = await fixture({ successes: 0 });
        const result = await f.withLease(async (lease) =>
            f.store.recoverTargetOperation(lease, await f.observation(), f.shelf),
        );
        expect(result.pendingTargetOperation).toBeUndefined();
        expect(result.targetOperationReceipts?.[operationId].outcome).toBe("notApplied");
        expect(result.lists.map((list) => list.id)).toEqual(["default"]);
        expect(await f.shelf.readCurrentShelfManifest("source")).toEqual(f.source);
        expect(await f.shelf.readJournals()).toEqual([]);
    });

    it("preserves zero-success destination when changed shelf requires review", async () => {
        const f = await fixture({ successes: 0 });
        const lists = f.store.get(f.root).lists;
        await f.shelf.writeShelfGeneration("source", {
            ...f.source,
            metadata: { ...f.source.metadata, name: "Renamed" },
        });
        const result = await f.withLease(async (lease) =>
            f.store.recoverTargetOperation(lease, await f.observation(), f.shelf),
        );
        expect(result.pendingTargetOperation?.phase).toBe("reviewRequired");
        expect(result.lists).toEqual(lists);
        expect(result.targetOperationReceipts?.[operationId]).toBeUndefined();
    });

    it.each(["beforeShelf", "beforeTerminal", "zero"] as const)(
        "requires unchanged after observations at %s",
        async (boundary) => {
            const f = await fixture({ successes: boundary === "zero" ? 0 : 1 });
            if (boundary === "beforeTerminal")
                await f.withLease(async (lease) =>
                    f.store.publishTargetShelf(lease, await f.observation(), f.shelf),
                );
            const manifest = await f.shelf.readCurrentShelfManifest("source");
            await writeFile(path.join(f.root, "one.txt"), "external edit\n");
            const result = await f.withLease(async (lease) =>
                f.store.recoverTargetOperation(lease, await f.observation(), f.shelf),
            );
            expect(result.pendingTargetOperation?.phase).toBe("reviewRequired");
            expect(result.targetOperationReceipts?.[operationId]).toBeUndefined();
            expect(await f.shelf.readCurrentShelfManifest("source")).toEqual(manifest);
            expect(await readFile(path.join(f.root, "one.txt"), "utf8")).toBe("external edit\n");
        },
    );

    it("rejects a concrete store belonging to another canonical repository", async () => {
        const f = await fixture();
        const foreign = await fixture();
        const before = f.store.get(f.root);
        await expect(
            f.withLease(async (lease) =>
                f.store.publishTargetShelf(lease, await f.observation(), foreign.shelf),
            ),
        ).rejects.toThrow("another repository");
        expect(f.store.get(f.root)).toEqual(before);
        expect(await f.shelf.readCurrentShelfManifest("source")).toEqual(f.source);
        expect(await foreign.shelf.readCurrentShelfManifest("source")).toEqual(foreign.source);
    });

    it("rejects a foreign store before recovery publishes ownership or copies a draft", async () => {
        const f = await fixture({ ownership: false });
        const foreign = await fixture();
        const before = f.store.get(f.root);
        await expect(
            f.withLease(async (lease) =>
                f.store.recoverTargetOperation(lease, await f.observation(), foreign.shelf),
            ),
        ).rejects.toThrow("another repository");
        expect(f.store.get(f.root)).toEqual(before);
    });

    it("freezes shelf and successful IDs from pending instead of caller overrides", async () => {
        const f = await fixture();
        await f.withLease(async (lease) =>
            f.store.publishTargetShelf(
                lease,
                {
                    ...(await f.observation()),
                    shelf: { id: "ignored", generation: 999, checksum: "f".repeat(64) },
                },
                f.shelf,
            ),
        );
        expect(
            (await f.shelf.readCurrentShelfManifest("source")).metadata.targetOperationReceipt
                ?.appliedChangeIds,
        ).toEqual(["one.txt"]);
    });

    it("refuses a forged frozen set before publishing any shelf generation", async () => {
        const f = await fixture();
        const state = f.store.get(f.root);
        const forged = {
            ...state,
            pendingTargetOperation: {
                ...state.pendingTargetOperation!,
                completion: {
                    ...state.pendingTargetOperation!.completion!,
                    appliedChangeIds: ["two.txt"],
                },
            },
        };
        await f.withLease(() => f.persistence.write(forged));
        const result = await f.withLease(async (lease) =>
            f.store.publishTargetShelf(lease, await f.observation(), f.shelf),
        );
        expect(result.pendingTargetOperation?.phase).toBe("reviewRequired");
        expect(await f.shelf.readCurrentShelfManifest("source")).toEqual(f.source);
    });

    it.each(["pointer", "checksum", "journal", "operation", "checkpoint"] as const)(
        "retains pending for changed %s after shelfPublished",
        async (kind) => {
            const f = await fixture();
            const published = await f.withLease(async (lease) =>
                f.store.publishTargetShelf(lease, await f.observation(), f.shelf),
            );
            const current = await f.shelf.readCurrentShelfManifest("source");
            let changedFile: string;
            if (kind === "pointer") {
                changedFile = path.join(f.paths.root, "shelves", "source", "current");
                await rm(changedFile);
            } else if (kind === "journal") {
                const directory = path.join(f.paths.root, "journals");
                changedFile = path.join(directory, (await readdir(directory))[0]);
                await writeFile(changedFile, "{broken");
            } else if (kind === "checkpoint") {
                changedFile = f.persistence.filename;
                await f.withLease(() =>
                    f.persistence.write({
                        ...published,
                        pendingTargetOperation: {
                            ...published.pendingTargetOperation!,
                            completion: {
                                ...published.pendingTargetOperation!.completion!,
                                publishedChecksum: "f".repeat(64),
                            },
                        },
                    }),
                );
            } else {
                changedFile = path.join(
                    f.paths.root,
                    "shelves",
                    "source",
                    `gen-${current.generation}`,
                    "manifest.json",
                );
                const manifest = JSON.parse(await readFile(changedFile, "utf8"));
                if (kind === "operation")
                    manifest.metadata.targetOperationReceipt.targetOperationId =
                        "foreign-operation";
                else manifest.metadata.name = "External replacement";
                manifest.checksum = createHash("sha256")
                    .update(JSON.stringify({ ...manifest, checksum: "" }))
                    .digest("hex");
                await writeFile(changedFile, JSON.stringify(manifest));
            }
            const before = await readFile(changedFile).catch(() => undefined);
            const reopened = await openCompletionFixture(f.root);
            const result = await reopened.withLease(async (lease) =>
                reopened.store.finishTargetOperation(
                    lease,
                    await reopened.observation(),
                    reopened.shelf,
                ),
            );
            expect(result.pendingTargetOperation?.phase).toBe("reviewRequired");
            expect(result.targetOperationReceipts?.[operationId]).toBeUndefined();
            if (kind !== "checkpoint")
                expect(await readFile(changedFile).catch(() => undefined)).toEqual(before);
        },
    );

    it("refuses forged shelfPublished while the actual journal remains pending", async () => {
        const f = await fixture();
        const pendingShelf = new ShelfStore(f.paths, {
            publicationCheckpoint: async (phase) => {
                if (phase === "pointer") throw new Error("stop-pointer");
            },
        });
        await expect(
            f.withLease(async (lease) =>
                f.store.publishTargetShelf(lease, await f.observation(), pendingShelf),
            ),
        ).rejects.toThrow("stop-pointer");
        const current = await f.shelf.readCurrentShelfManifest("source");
        const state = f.store.get(f.root);
        await f.withLease(() =>
            f.persistence.write({
                ...state,
                pendingTargetOperation: {
                    ...state.pendingTargetOperation!,
                    phase: "shelfPublished",
                    completion: {
                        ...state.pendingTargetOperation!.completion!,
                        shelfPublication: "published",
                        publishedGeneration: current.generation,
                        publishedChecksum: current.checksum,
                    },
                },
            }),
        );
        const result = await f.withLease(async (lease) =>
            f.store.finishTargetOperation(lease, await f.observation(), f.shelf),
        );
        expect(result.pendingTargetOperation?.phase).toBe("reviewRequired");
        expect(result.targetOperationReceipts?.[operationId]).toBeUndefined();
        expect((await f.shelf.readJournals())[0].state).toBe("unshelvePending");
    });

    it("holds the shelf lock through the metadata shelf checkpoint", async () => {
        const f = await fixture();
        const contender = new ShelfStore(f.paths, { acquireTimeoutMs: 0 });
        const original = ChangelistPersistence.prototype.write;
        let attempted = false;
        const spy = vi
            .spyOn(ChangelistPersistence.prototype, "write")
            .mockImplementation(async function (state) {
                if (state.pendingTargetOperation?.phase === "shelfPublished") {
                    attempted = true;
                    await expect(
                        contender.writeShelfGeneration("source", f.source),
                    ).rejects.toThrow("already in progress");
                }
                return original.call(this, state);
            });
        await f.withLease(async (lease) =>
            f.store.publishTargetShelf(lease, await f.observation(), f.shelf),
        );
        spy.mockRestore();
        expect(attempted).toBe(true);
    });

    it("recovers a killed child after real Git apply and shelf pointer publication without replay or draft recopy", async () => {
        const root = await realpath(
            await mkdtemp(path.join(os.tmpdir(), "target-completion-process-")),
        );
        roots.push(root);
        const worker = async (mode: string) =>
            new Promise<{ pid: number; code: number | null; stderr: string }>((resolve, reject) => {
                const child = spawn(
                    "bun",
                    ["tests/integration/changes/targetShelfCompletionCrashWorker.ts", root, mode],
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
        const shelfPaths = await resolveShelfPaths({
            repositoryRoot: root,
            globalStoragePath: path.join(root, "storage"),
        });
        const statePath = path.join(root, ".git", "intelligit", "changelists", "state.json");
        const durable = JSON.parse(await readFile(statePath, "utf8"));
        expect(durable.state.pendingTargetOperation.phase).toBe("ownershipPublished");
        for (const lockFile of [
            path.join(shelfPaths.root, ".store-lock", "store.lock"),
            path.join(root, ".git", "intelligit", "repo.lock"),
            path.join(root, ".git", "intelligit", "changelists", "metadata.lock"),
        ]) {
            const owner = JSON.parse(await readFile(lockFile, "utf8"));
            expect(owner.pid).toBe(crashed.pid);
            await writeFile(lockFile, JSON.stringify({ ...owner, heartbeatAt: 0 }));
        }
        const reopened = await openCompletionFixture(root);
        const manifest = await reopened.shelf.readCurrentShelfManifest("source");
        const pending = reopened.store.get(root).pendingTargetOperation!;
        await reopened.store.saveDraft(
            root,
            pending.destinationId,
            "captured shelf draft",
            "later user draft",
        );
        const resumed = await worker("resume");
        expect(resumed.stderr).toBe("");
        expect(resumed.code).toBe(0);
        const result = JSON.parse(
            await readFile(path.join(root, "completion-result.json"), "utf8"),
        );
        expect(result.pendingTargetOperation).toBeUndefined();
        expect(
            result.lists.find((list: { id: string }) => list.id === pending.destinationId).draft,
        ).toBe("later user draft");
        expect(await reopened.shelf.readCurrentShelfManifest("source")).toEqual(manifest);
        expect(await readFile(path.join(root, "one.txt"), "utf8")).toBe("operation\n");
        expect(await readFile(path.join(root, "git-apply-count"), "utf8")).toBe("1");
    });
});
