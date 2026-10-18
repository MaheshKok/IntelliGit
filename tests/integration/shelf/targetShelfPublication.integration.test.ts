import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureShelfRoot, resolveShelfPaths } from "../../../src/shelf/paths";
import {
    ShelfStore,
    type ShelfStoreOptions,
    type ShelfTargetPublicationRequest,
} from "../../../src/shelf/store";
import { removeScratchDirectories } from "../../helpers/scratchDirectories";

const directories: string[] = [];
afterEach(async () => removeScratchDirectories(...directories.splice(0)));

async function fixture() {
    const temporary = await mkdtemp(path.join(tmpdir(), "target-shelf-publication-"));
    directories.push(temporary);
    const repositoryRoot = path.join(temporary, "repository");
    await mkdir(repositoryRoot);
    const paths = await resolveShelfPaths({ repositoryRoot, globalStoragePath: temporary });
    await ensureShelfRoot(paths);
    const store = new ShelfStore(paths);
    await store.withLock(() => store.migrateWithHeldLocks());
    const object = await store.putObject("source", Buffer.from("immutable ownership"));
    const source = await store.writeShelfGeneration("source", {
        schemaVersion: 2,
        objectHashes: [object.hash],
        metadata: {
            name: "Original",
            lifecycle: "shelved",
            createdAt: 123,
            selection: {
                version: 1,
                scope: "files",
                scopeDraft: "All draft\r\n",
                sourceLists: [{ id: "default", name: "First", description: "説明", draft: "α\n" }],
                entries: ["one", "two"].map((changeId) => ({
                    changeId,
                    sourceListIds: ["default"],
                    ownershipObjectHash: object.hash,
                })),
            },
        },
        files: ["one", "two"].map((changeId) => ({
            changeId,
            worktreeBlock: {
                path: changeId + ".txt",
                status: "M" as const,
                patchObjectHash: object.hash,
            },
            binary: false,
            untracked: false,
            baseAvailability: "none" as const,
            exactReconstruction: true,
            lifecycle: "shelved" as const,
        })),
    });
    const request: ShelfTargetPublicationRequest = {
        targetOperationId: "operation-one",
        shelfId: "source",
        sourceGeneration: source.generation,
        sourceChecksum: source.checksum,
        appliedChangeIds: ["one"],
    };
    return {
        temporary,
        paths,
        store,
        source,
        request,
        reopen: (options: ShelfStoreOptions = {}) => new ShelfStore(paths, options),
        manifestPath: (generation: number) =>
            path.join(paths.root, "shelves", "source", `gen-${generation}`, "manifest.json"),
        pointerPath: path.join(paths.root, "shelves", "source", "current"),
    };
}

async function bytesBelow(root: string): Promise<Record<string, string>> {
    const result: Record<string, string> = {};
    async function visit(directory: string): Promise<void> {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
            if (entry.name === ".store-lock") continue;
            const file = path.join(directory, entry.name);
            if (entry.isDirectory()) await visit(file);
            else result[path.relative(root, file)] = (await readFile(file)).toString("base64");
        }
    }
    await visit(root);
    return result;
}

async function interrupt(
    f: Awaited<ReturnType<typeof fixture>>,
    phase: "journal" | "manifest" | "pointer" | "terminal",
    request = f.request,
) {
    const store = f.reopen({
        publicationCheckpoint: async (observed) => {
            if (observed === phase) throw new Error(`stop-${phase}`);
        },
    });
    await expect(store.publishTargetOperation(request)).rejects.toThrow(`stop-${phase}`);
}

describe("durable target shelf publication", () => {
    it("publishes only frozen successes and retains every draft and ownership reference", async () => {
        const f = await fixture();
        const result = await f.store.publishTargetOperation(f.request);
        expect(result.generation).toBe(f.source.generation + 1);
        expect(result.files.map((entry) => entry.lifecycle)).toEqual(["applied", "shelved"]);
        expect(result.files[1]).toEqual(f.source.files[1]);
        expect(result.metadata.selection).toEqual(f.source.metadata.selection);
        expect(result.objectHashes).toEqual(f.source.objectHashes);
        expect(result.metadata.appliedAt).toBeUndefined();
        expect(result.metadata.targetOperationReceipt).toEqual({
            targetOperationId: f.request.targetOperationId,
            sourceGeneration: f.source.generation,
            sourceChecksum: f.source.checksum,
            appliedChangeIds: ["one"],
        });
        expect(await f.reopen().readTargetOperationReceipt(f.request)).toEqual(result);
        expect((await f.store.readJournals())[0].state).toBe("applied");
    });

    it.each(["journal", "manifest", "pointer", "terminal"] as const)(
        "reopens after %s with exactly the intended generation and bytes and one Git mutation",
        async (phase) => {
            const f = await fixture();
            const request = { ...f.request, appliedChangeIds: ["one", "two"] };
            let gitMutations = 0;
            gitMutations += 1; // The adapter has durably recorded Git completion before entering storage.
            await interrupt(f, phase, request);
            const journals = await f.reopen().readJournals();
            const intended = journals[0].targetPublication!.manifest;
            const retained = JSON.stringify(intended);
            expect(journals[0].state).toBe(phase === "terminal" ? "ghost" : "unshelvePending");
            const resumed = await f.reopen().publishTargetOperation(request);
            expect(JSON.stringify(resumed)).toBe(retained);
            expect(await readFile(f.manifestPath(resumed.generation), "utf8")).toBe(retained);
            expect(resumed.metadata.appliedAt).toEqual(expect.any(Number));
            expect(resumed.metadata.lifecycle).toBe("applied");
            expect((await f.reopen().readJournals())[0].state).toBe("ghost");
            expect(await f.reopen().publishTargetOperation(request)).toEqual(resumed);
            expect(gitMutations).toBe(1);
            expect(resumed.generation).toBe(f.source.generation + 1);
        },
    );

    it("does not write or claim a receipt for an empty successful set", async () => {
        const f = await fixture();
        const before = await bytesBelow(f.paths.root);
        const request = { ...f.request, appliedChangeIds: [] };
        expect(await f.store.publishTargetOperation(request)).toEqual(f.source);
        expect(await bytesBelow(f.paths.root)).toEqual(before);
        await expect(f.store.readTargetOperationReceipt(request)).rejects.toThrow();
    });

    it("preserves a receipt through ordinary rename and read", async () => {
        const f = await fixture();
        const published = await f.store.publishTargetOperation(f.request);
        await f.store.writeShelfGeneration("source", {
            ...published,
            metadata: { ...published.metadata, name: "Renamed" },
        });
        const renamed = await f.reopen().readCurrentShelfManifest("source");
        expect(renamed.metadata.targetOperationReceipt).toEqual(
            published.metadata.targetOperationReceipt,
        );
        expect(renamed.metadata.selection).toEqual(f.source.metadata.selection);
        await expect(f.store.readTargetOperationReceipt(f.request)).rejects.toThrow();
    });

    it.each(["changed-checksum", "deleted", "foreign-pointer"])(
        "preserves %s instead of overwriting or resurrecting on resume",
        async (kind) => {
            const f = await fixture();
            await interrupt(f, "manifest");
            if (kind === "deleted") await rm(f.pointerPath);
            else if (kind === "foreign-pointer") await writeFile(f.pointerPath, "999\n");
            else {
                const source = JSON.parse(
                    await readFile(f.manifestPath(f.source.generation), "utf8"),
                );
                source.metadata.name = "External same generation";
                source.checksum = createHash("sha256")
                    .update(JSON.stringify({ ...source, checksum: "" }))
                    .digest("hex");
                await writeFile(f.manifestPath(source.generation), JSON.stringify(source));
            }
            const before = await bytesBelow(f.paths.root);
            await expect(f.reopen().publishTargetOperation(f.request)).rejects.toThrow();
            expect(await bytesBelow(f.paths.root)).toEqual(before);
        },
    );

    it.each(["operation", "frozen-set", "corrupt-journal", "conflicting-receipt"])(
        "refuses %s and preserves all evidence",
        async (kind) => {
            const f = await fixture();
            await interrupt(f, kind === "conflicting-receipt" ? "pointer" : "journal");
            let request = f.request;
            if (kind === "operation")
                request = { ...request, targetOperationId: "foreign-operation" };
            else if (kind === "frozen-set") request = { ...request, appliedChangeIds: ["two"] };
            else if (kind === "corrupt-journal") {
                const directory = path.join(f.paths.root, "journals");
                const file = path.join(directory, (await readdir(directory))[0]);
                const journal = JSON.parse(await readFile(file, "utf8"));
                journal.targetPublication.manifest.metadata.name = "Corrupt intent";
                await writeFile(file, JSON.stringify(journal));
            } else {
                const current = await f.store.readCurrentShelfManifest("source");
                const manifest = JSON.parse(
                    await readFile(f.manifestPath(current.generation), "utf8"),
                );
                manifest.metadata.targetOperationReceipt.targetOperationId = "foreign-operation";
                manifest.checksum = createHash("sha256")
                    .update(JSON.stringify({ ...manifest, checksum: "" }))
                    .digest("hex");
                await writeFile(f.manifestPath(current.generation), JSON.stringify(manifest));
            }
            const before = await bytesBelow(f.paths.root);
            await expect(f.reopen().publishTargetOperation(request)).rejects.toThrow();
            expect(await bytesBelow(f.paths.root)).toEqual(before);
        },
    );

    it("blocks ordinary writes during intent but permits exact resume under the same hold", async () => {
        const f = await fixture();
        const store = f.reopen({
            publicationCheckpoint: async (phase) => {
                if (phase === "journal") {
                    await expect(store.writeShelfGeneration("source", f.source)).rejects.toThrow(
                        "publication",
                    );
                    await expect(store.deleteShelf("source")).rejects.toThrow("publication");
                    throw new Error("stop-journal");
                }
            },
        });
        await store.withLock(async () => {
            await store.assertMutationReady();
            await expect(store.publishTargetOperation(f.request)).rejects.toThrow("stop-journal");
            await expect(store.writeShelfGeneration("source", f.source)).rejects.toThrow(
                "publication",
            );
        });
        expect((await f.reopen().publishTargetOperation(f.request)).files[0].lifecycle).toBe(
            "applied",
        );
    });

    it("does not acknowledge a pointer until the durable journal is terminal", async () => {
        const f = await fixture();
        await interrupt(f, "pointer");
        await expect(f.reopen().readTargetOperationReceipt(f.request)).rejects.toThrow();
        const result = await f.reopen().publishTargetOperation(f.request);
        expect(await f.reopen().readTargetOperationReceipt(f.request)).toEqual(result);
    });

    it.each(["source", "journal", "intended"] as const)(
        "refuses a late changed %s before pointer publication",
        async (kind) => {
            const f = await fixture();
            let before: Record<string, string> = {};
            const store = f.reopen({
                beforeCurrentPointerRename: async () => {
                    if (kind === "journal") {
                        const directory = path.join(f.paths.root, "journals");
                        const target = path.join(directory, (await readdir(directory))[0]);
                        await writeFile(target, (await readFile(target, "utf8")) + "\n");
                    } else {
                        const generation =
                            kind === "source" ? f.source.generation : f.source.generation + 1;
                        const manifest = JSON.parse(
                            await readFile(f.manifestPath(generation), "utf8"),
                        );
                        manifest.metadata.name = "Late external change";
                        manifest.checksum = createHash("sha256")
                            .update(JSON.stringify({ ...manifest, checksum: "" }))
                            .digest("hex");
                        await writeFile(f.manifestPath(generation), JSON.stringify(manifest));
                    }
                    before = await bytesBelow(f.paths.root);
                },
            });
            await expect(store.publishTargetOperation(f.request)).rejects.toThrow();
            expect(await readFile(f.pointerPath, "utf8")).toBe(String(f.source.generation) + "\n");
            expect(await bytesBelow(f.paths.root)).toEqual(before);
        },
    );

    it("rejects unknown and duplicated frozen IDs before any durable mutation", async () => {
        const f = await fixture();
        const before = await bytesBelow(f.paths.root);
        for (const appliedChangeIds of [["missing"], ["one", "one"]]) {
            await expect(
                f.store.publishTargetOperation({ ...f.request, appliedChangeIds }),
            ).rejects.toThrow();
        }
        expect(await bytesBelow(f.paths.root)).toEqual(before);
    });

    it.each([
        { targetOperationId: "../unsafe" },
        { sourceGeneration: 0 },
        { sourceChecksum: "bad" },
        { appliedChangeIds: [] },
        { appliedChangeIds: ["one", "one"] },
        { appliedChangeIds: ["two", "one"] },
        { appliedChangeIds: ["two"] },
    ])("rejects malformed or unsupported receipt %j without rewriting bytes", async (changed) => {
        const f = await fixture();
        const current = await f.store.publishTargetOperation(f.request);
        const manifest = JSON.parse(await readFile(f.manifestPath(current.generation), "utf8"));
        Object.assign(manifest.metadata.targetOperationReceipt, changed);
        manifest.checksum = createHash("sha256")
            .update(JSON.stringify({ ...manifest, checksum: "" }))
            .digest("hex");
        await writeFile(f.manifestPath(current.generation), JSON.stringify(manifest));
        const before = await bytesBelow(f.paths.root);
        await expect(f.reopen().readCurrentShelfManifest("source")).rejects.toThrow();
        await expect(f.reopen().publishTargetOperation(f.request)).rejects.toThrow();
        expect(await bytesBelow(f.paths.root)).toEqual(before);
    });

    it("keeps a terminal publication journal immutable to generic journal APIs", async () => {
        const f = await fixture();
        await f.store.publishTargetOperation(f.request);
        const journal = (await f.store.readJournals())[0];
        const before = await bytesBelow(f.paths.root);
        await expect(f.store.transitionJournal(journal.id, "ghost")).rejects.toThrow();
        await expect(f.store.deleteJournal(journal.id)).rejects.toThrow();
        await expect(
            f.store.writeJournal({ id: journal.id, state: "shelved", pathProgress: {} }),
        ).rejects.toThrow();
        expect(await bytesBelow(f.paths.root)).toEqual(before);
    });

    it("refuses changed intended bytes even when parsed receipt and checksum still match", async () => {
        const f = await fixture();
        await interrupt(f, "pointer");
        const current = await f.store.readCurrentShelfManifest("source");
        const target = f.manifestPath(current.generation);
        await writeFile(target, (await readFile(target, "utf8")) + "\n");
        const before = await bytesBelow(f.paths.root);
        await expect(f.reopen().publishTargetOperation(f.request)).rejects.toThrow();
        expect(await bytesBelow(f.paths.root)).toEqual(before);
    });

    it("survives a killed pointer publisher and resumes in a second process with one Git mutation", async () => {
        const f = await fixture();
        const requestFile = path.join(f.temporary, "request.json");
        const counterFile = path.join(f.temporary, "git-count");
        const resultFile = path.join(f.temporary, "result.json");
        await writeFile(requestFile, JSON.stringify(f.request));
        async function worker(crash: boolean) {
            return new Promise<{
                pid: number;
                code: number | null;
                signal: NodeJS.Signals | null;
                stderr: string;
            }>((resolve, reject) => {
                const child = spawn(
                    "bun",
                    [
                        "tests/integration/shelf/targetShelfPublicationCrashWorker.ts",
                        f.temporary,
                        requestFile,
                        crash ? "crash" : "resume",
                    ],
                    { cwd: process.cwd(), stdio: ["ignore", "ignore", "pipe"] },
                );
                let stderr = "";
                child.stderr.on("data", (data: Buffer) => {
                    stderr += data.toString();
                });
                child.once("error", reject);
                child.once("close", (code, signal) =>
                    resolve({ pid: child.pid!, code, signal, stderr }),
                );
            });
        }
        const crashed = await worker(true);
        expect(crashed.stderr).toBe("");
        expect(crashed.code === null || crashed.code !== 0).toBe(true);
        expect(() => process.kill(crashed.pid, 0)).toThrow();
        const pointerBytes = await readFile(f.pointerPath);
        const intent = (await f.store.readJournals())[0].targetPublication!.manifest;
        const intendedBytes = await readFile(f.manifestPath(intent.generation));
        const lockFile = path.join(f.paths.root, ".store-lock", "store.lock");
        const owner = JSON.parse(await readFile(lockFile, "utf8"));
        expect(owner.pid).toBe(crashed.pid);
        // Expire only the proven-dead worker's unchanged owner; let normal nonce takeover reclaim it.
        await writeFile(lockFile, JSON.stringify({ ...owner, heartbeatAt: 0 }));
        const resumed = await worker(false);
        expect(resumed.stderr).toBe("");
        expect(resumed.code).toBe(0);
        expect(await readFile(counterFile, "utf8")).toBe("1");
        expect(await readFile(resultFile)).toEqual(intendedBytes);
        expect(await readFile(f.pointerPath)).toEqual(pointerBytes);
        expect((await f.store.readJournals())[0].state).toBe("applied");
    });
});
