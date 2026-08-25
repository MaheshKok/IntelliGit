import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ShelfFileEntry } from "../../../src/shelf/model";
import { ShelfStaleShelfError } from "../../../src/shelf/store";
import { WRITABLE_FILE_MODE_OCTAL } from "../../helpers/platformCapabilities";
import {
    ShelfConflictSessionService,
    extractOursFromConflictMarkers,
    type ShelfConflictSessionDependencies,
} from "../../../src/services/shelfConflictSession";
import { removeScratchDirectories } from "../../helpers/scratchDirectories";

const directories: string[] = [];

afterEach(async () => {
    await Promise.all(
        directories.splice(0).map((directory) => removeScratchDirectories(directory)),
    );
});

const entry: ShelfFileEntry = {
    changeId: "change-a",
    worktreeBlock: {
        path: "tracked.txt",
        status: "M",
        patchObjectHash: "patch",
        baseObjectHash: "base",
    },
    binary: false,
    untracked: false,
    baseAvailability: "full",
    exactReconstruction: true,
    lifecycle: "shelved",
};

async function makeService(overrides: Partial<ShelfConflictSessionDependencies> = {}) {
    const root = await mkdtemp(path.join(tmpdir(), "intelligit-shelf-conflict-session-"));
    directories.push(root);
    const target = path.join(root, "tracked.txt");
    await writeFile(
        target,
        [
            "before",
            "<<<<<<< current",
            "local",
            "=======",
            "shelved",
            ">>>>>>> shelved",
            "after",
            "",
        ].join("\n"),
    );
    const manifest = {
        generation: 1,
        schemaVersion: 1,
        objectHashes: ["patch", "base"],
        metadata: { name: "session", lifecycle: "shelved" as const },
        files: [entry],
    };
    const store = {
        readCurrentShelfManifest: vi.fn(async () => manifest),
        withGenerationCas: vi.fn(async (_input, operation) => operation()),
        writeJournal: vi.fn(async () => undefined),
        transitionJournal: vi.fn(async () => undefined),
        writeShelfGeneration: vi.fn(async (_id, next) => ({ ...next, generation: 2 })),
    };
    const withMutation = vi.fn(async (operation) => operation());
    const parkCurrent = vi.fn(async () => undefined);
    const service = new ShelfConflictSessionService({
        repositoryRoot: root,
        store: store as never,
        withMutation,
        readBase: async () => Buffer.from("base\n"),
        materializePatchedBase: async () => Buffer.from("shelved\n"),
        parkCurrent,
        ...overrides,
    });
    return { root, target, manifest, store, withMutation, parkCurrent, service };
}

describe("extractOursFromConflictMarkers", () => {
    it("keeps leading and trailing text plus each ours region", () => {
        expect(
            extractOursFromConflictMarkers(
                [
                    "leading",
                    "<<<<<<<",
                    "ours one",
                    "=======",
                    "theirs one",
                    ">>>>>>>",
                    "middle",
                    "<<<<<<<",
                    "ours two",
                    "=======",
                    "theirs two",
                    ">>>>>>>",
                    "trailing",
                    "",
                ].join("\n"),
            ),
        ).toBe(["leading", "ours one", "middle", "ours two", "trailing", ""].join("\n"));
    });

    it("returns a non-marker file unchanged", () => {
        expect(extractOursFromConflictMarkers("hand edited\n")).toBe("hand edited\n");
    });

    it("returns malformed marker content unchanged", () => {
        const malformed = "before\n<<<<<<<\nours\n";
        expect(extractOursFromConflictMarkers(malformed)).toBe(malformed);
    });
});

describe("ShelfConflictSessionService", () => {
    it("opens immutable regular-text conflict payload without holding mutation serialization", async () => {
        const { service, target, withMutation } = await makeService();

        const opened = await service.open({ id: "shelf-a", changeId: "change-a" });

        expect(opened).toEqual({
            path: "tracked.txt",
            base: "base\n",
            current: "before\nlocal\nafter\n",
            patchedBase: "shelved\n",
            worktreeFingerprint: `${WRITABLE_FILE_MODE_OCTAL}:${createHash("sha256")
                .update(await readFile(target))
                .digest("hex")}`,
            shelfGeneration: 1,
        });
        expect(withMutation).not.toHaveBeenCalled();
    });

    it("writes a fresh resolution, marks the entry applied, and ghosts a fully applied shelf", async () => {
        const { service, target, store, withMutation } = await makeService();
        const opened = await service.open({ id: "shelf-a", changeId: "change-a" });

        await expect(
            service.apply({
                id: "shelf-a",
                changeId: "change-a",
                content: "resolved\n",
                expectedShelfGeneration: opened.shelfGeneration,
                expectedPathFingerprint: opened.worktreeFingerprint,
            }),
        ).resolves.toEqual({ status: "applied", newGeneration: 2 });

        await expect(readFile(target, "utf8")).resolves.toBe("resolved\n");
        expect(withMutation).toHaveBeenCalledOnce();
        expect(store.writeShelfGeneration).toHaveBeenCalledWith(
            "shelf-a",
            expect.objectContaining({
                metadata: expect.objectContaining({
                    lifecycle: "applied",
                    appliedAt: expect.any(Number),
                }),
                files: [expect.objectContaining({ lifecycle: "applied" })],
            }),
        );
        expect(store.transitionJournal).toHaveBeenCalledWith(expect.any(String), "ghost");
    });

    it("refuses a stale working-tree fingerprint without writing or parking", async () => {
        const { service, target, store, parkCurrent } = await makeService();
        const opened = await service.open({ id: "shelf-a", changeId: "change-a" });
        await writeFile(target, "changed after open\n");

        await expect(
            service.apply({
                id: "shelf-a",
                changeId: "change-a",
                content: "resolved\n",
                expectedShelfGeneration: opened.shelfGeneration,
                expectedPathFingerprint: opened.worktreeFingerprint,
            }),
        ).resolves.toEqual({ status: "stale", reason: "path" });

        await expect(readFile(target, "utf8")).resolves.toBe("changed after open\n");
        expect(parkCurrent).not.toHaveBeenCalled();
        expect(store.writeShelfGeneration).not.toHaveBeenCalled();
    });

    it("parks stale current bytes before overwriting with the explicit override", async () => {
        const { service, target, parkCurrent } = await makeService();
        const opened = await service.open({ id: "shelf-a", changeId: "change-a" });
        await writeFile(target, "changed after open\n");

        await expect(
            service.apply({
                id: "shelf-a",
                changeId: "change-a",
                content: "resolved\n",
                expectedShelfGeneration: opened.shelfGeneration,
                expectedPathFingerprint: opened.worktreeFingerprint,
                staleOverride: "overwriteParkingCurrent",
            }),
        ).resolves.toEqual({ status: "applied", newGeneration: 2 });

        expect(parkCurrent).toHaveBeenCalledWith(
            expect.objectContaining({
                path: "tracked.txt",
                bytes: Buffer.from("changed after open\n"),
            }),
        );
        await expect(readFile(target, "utf8")).resolves.toBe("resolved\n");
    });

    it("stores overridden bytes in the recovery area before writing the resolution", async () => {
        const { root, service, target } = await makeService({
            parkCurrent: undefined,
            getGitDirectories: async () => ({ gitDir: path.join(root, ".git") }),
        });
        await mkdir(path.join(root, ".git"), { recursive: true });
        const opened = await service.open({ id: "shelf-a", changeId: "change-a" });
        await writeFile(target, "changed after open\n");

        await expect(
            service.apply({
                id: "shelf-a",
                changeId: "change-a",
                content: "resolved\n",
                expectedShelfGeneration: opened.shelfGeneration,
                expectedPathFingerprint: opened.worktreeFingerprint,
                staleOverride: "overwriteParkingCurrent",
            }),
        ).resolves.toEqual({ status: "applied", newGeneration: 2 });

        const recoveryRoot = path.join(root, ".git", "intelligit", "recovery");
        const [snapshot] = await readdir(recoveryRoot);
        await expect(
            readFile(path.join(recoveryRoot, snapshot!, "tracked.txt"), "utf8"),
        ).resolves.toBe("changed after open\n");
        await expect(readFile(target, "utf8")).resolves.toBe("resolved\n");
    });

    it("refuses an override when parking fails and leaves the working tree untouched", async () => {
        const { service, target } = await makeService({
            parkCurrent: async () => Promise.reject(new Error("recovery full")),
        });
        const opened = await service.open({ id: "shelf-a", changeId: "change-a" });
        await writeFile(target, "changed after open\n");

        await expect(
            service.apply({
                id: "shelf-a",
                changeId: "change-a",
                content: "resolved\n",
                expectedShelfGeneration: opened.shelfGeneration,
                expectedPathFingerprint: opened.worktreeFingerprint,
                staleOverride: "overwriteParkingCurrent",
            }),
        ).resolves.toEqual({ status: "refused", reason: "recovery full" });

        await expect(readFile(target, "utf8")).resolves.toBe("changed after open\n");
    });

    it("refuses a stale shelf generation without writing", async () => {
        const { service, target, manifest, store } = await makeService();
        const opened = await service.open({ id: "shelf-a", changeId: "change-a" });
        manifest.generation = 2;

        await expect(
            service.apply({
                id: "shelf-a",
                changeId: "change-a",
                content: "resolved\n",
                expectedShelfGeneration: opened.shelfGeneration,
                expectedPathFingerprint: opened.worktreeFingerprint,
            }),
        ).resolves.toEqual({ status: "stale", reason: "shelf" });

        await expect(readFile(target, "utf8")).resolves.toContain("<<<<<<<");
        expect(store.writeShelfGeneration).not.toHaveBeenCalled();
    });

    it("turns a generation CAS failure into a typed stale refusal without writing", async () => {
        const { service, target } = await makeService({
            store: {
                readCurrentShelfManifest: vi.fn(async () => ({
                    generation: 1,
                    schemaVersion: 1,
                    objectHashes: ["patch", "base"],
                    metadata: { name: "session", lifecycle: "shelved" },
                    files: [entry],
                })),
                withGenerationCas: vi.fn(async () => {
                    throw new ShelfStaleShelfError(1, 2);
                }),
                writeJournal: vi.fn(),
                transitionJournal: vi.fn(),
                writeShelfGeneration: vi.fn(),
            } as never,
        });
        const opened = await service.open({ id: "shelf-a", changeId: "change-a" });

        await expect(
            service.apply({
                id: "shelf-a",
                changeId: "change-a",
                content: "resolved\n",
                expectedShelfGeneration: opened.shelfGeneration,
                expectedPathFingerprint: opened.worktreeFingerprint,
            }),
        ).resolves.toEqual({ status: "stale", reason: "shelf" });

        await expect(readFile(target, "utf8")).resolves.toContain("<<<<<<<");
    });

    it("parks and applies when an override observes a generation CAS race", async () => {
        const freshManifest = {
            generation: 1,
            schemaVersion: 1,
            objectHashes: ["patch", "base"],
            metadata: { name: "session", lifecycle: "shelved" as const },
            files: [entry],
        };
        const currentManifest = { ...freshManifest, generation: 2 };
        const { service, target, parkCurrent } = await makeService({
            store: {
                readCurrentShelfManifest: vi
                    .fn()
                    .mockResolvedValueOnce(freshManifest)
                    .mockResolvedValueOnce(currentManifest),
                withGenerationCas: vi.fn(async () => {
                    throw new ShelfStaleShelfError(1, 2);
                }),
                writeJournal: vi.fn(async () => undefined),
                transitionJournal: vi.fn(async () => undefined),
                writeShelfGeneration: vi.fn(async (_id, next) => ({ ...next, generation: 3 })),
            } as never,
        });
        const fingerprint = `${WRITABLE_FILE_MODE_OCTAL}:${createHash("sha256")
            .update(await readFile(target))
            .digest("hex")}`;

        await expect(
            service.apply({
                id: "shelf-a",
                changeId: "change-a",
                content: "resolved after race\n",
                expectedShelfGeneration: 1,
                expectedPathFingerprint: fingerprint,
                staleOverride: "overwriteParkingCurrent",
            }),
        ).resolves.toEqual({ status: "applied", newGeneration: 3 });

        expect(parkCurrent).toHaveBeenCalledWith(
            expect.objectContaining({ bytes: expect.any(Buffer) }),
        );
        expect(parkCurrent.mock.calls[0]?.[0].bytes.toString()).toContain("<<<<<<<");
        await expect(readFile(target, "utf8")).resolves.toBe("resolved after race\n");
    });
});
