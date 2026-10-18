import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ChangelistStore } from "../../../src/changes/changelistStore";
import { removeScratchDirectories } from "../../helpers/scratchDirectories";
import { RepositoryLockBusyError } from "../../../src/git/repositoryLock";
import { ShelfRecoveryFullError } from "../../../src/shelf/recovery";
import { ShelfStoreCorruptionError } from "../../../src/shelf/store";
import { ShelfService, type ShelfServiceOptions } from "../../../src/services/shelfService";
import type { ShelfHealthWarning } from "../../../src/webviews/protocol/commitPanelMessages";

interface FakeJournal {
    readonly id: string;
    readonly state: string;
    readonly shelf?: { readonly id: string; readonly generation: number };
}

/** Real service over controllable fakes; only health-relevant collaborators are live. */
const directories: string[] = [];
afterEach(async () => removeScratchDirectories(...directories.splice(0)));

async function createHealthService(overrides?: {
    corruptShelfIds?: string[];
    gateError?: () => Error | undefined;
    lockError?: () => Error | undefined;
    journals?: () => FakeJournal[];
}) {
    const root = await mkdtemp(path.join(tmpdir(), "shelf-health-"));
    directories.push(root);
    const gitDir = path.join(root, ".git");
    await mkdir(gitDir);
    const changelists = new ChangelistStore();
    await changelists.connect(root, gitDir);
    const store = {
        migrateWithHeldLocks: async () => {},
        readCurrentManifest: async () => ({ generation: 1 }),
        withLock: async <T>(operation: () => Promise<T>): Promise<T> => {
            const error = overrides?.lockError?.();
            if (error) throw error;
            return operation();
        },
        listShelves: async () => ({
            shelfIds: [],
            corruptShelfIds: overrides?.corruptShelfIds ?? [],
            catalogGeneration: 4,
        }),
        readJournals: async () => overrides?.journals?.() ?? [],
        deleteShelf: async () => {},
    };
    const gate = {
        run: async <T>(_root: string, _commonDir: string, operation: () => Promise<T>) => {
            const error = overrides?.gateError?.();
            if (error) throw error;
            return operation();
        },
    };
    const gitOps = {
        getActiveOperation: async () => "none",
        getGitDirectories: async () => ({ gitDir, commonDir: gitDir }),
    };
    const reverter = { resumePendingWithHeldLocks: async () => ({ rolledBackIds: [] }) };
    return new ShelfService({
        repositoryRoot: root,
        changelists,
        executor: {},
        store,
        gate,
        gitOps,
        reverter,
    } as unknown as ShelfServiceOptions);
}

function kindsOf(service: ShelfService): string[] {
    return service.getHealthWarnings().map((warning) => warning.kind);
}

describe("ShelfService health", () => {
    it("exposes a fresh immutable health snapshot with the protocol warning kinds", () => {
        const service = Object.create(ShelfService.prototype) as ShelfService;
        const warnings = service.getHealthWarnings();
        expect(warnings).toEqual([]);
        expect(Object.isFrozen(warnings)).toBe(true);
        const kinds: ShelfHealthWarning["kind"][] = [
            "corruptShelf",
            "lockBusy",
            "checksumMismatch",
            "pendingRecovery",
            "recoveryFull",
        ];
        expect(kinds).toHaveLength(5);
    });

    it("surfaces every corrupt shelf id, not just the first", async () => {
        const service = await createHealthService({ corruptShelfIds: ["shelf-a", "shelf-b"] });
        await service.listShelves();
        const warnings = service.getHealthWarnings();
        expect(warnings.filter((warning) => warning.kind === "corruptShelf")).toHaveLength(2);
        expect(warnings.map((warning) => warning.detail)).toEqual(
            expect.arrayContaining(["shelf-a", "shelf-b"]),
        );
    });

    it("records lockBusy from a busy gate and clears it on the next successful mutation", async () => {
        let busy = true;
        const service = await createHealthService({
            gateError: () => (busy ? new RepositoryLockBusyError() : undefined),
        });
        await expect(service.cleanUpExpiredGhosts(30)).rejects.toBeInstanceOf(
            RepositoryLockBusyError,
        );
        expect(kindsOf(service)).toContain("lockBusy");
        busy = false;
        await service.cleanUpExpiredGhosts(30);
        expect(kindsOf(service)).not.toContain("lockBusy");
    });

    it("records recoveryFull from a failing mutation and clears it on the next success", async () => {
        let full = true;
        const service = await createHealthService({
            lockError: () => (full ? new ShelfRecoveryFullError() : undefined),
        });
        await expect(service.cleanUpExpiredGhosts(30)).rejects.toBeInstanceOf(
            ShelfRecoveryFullError,
        );
        expect(kindsOf(service)).toContain("recoveryFull");
        full = false;
        await service.cleanUpExpiredGhosts(30);
        expect(kindsOf(service)).not.toContain("recoveryFull");
    });

    it("records checksumMismatch from store corruption and keeps it across later successes", async () => {
        let corrupt = true;
        const service = await createHealthService({
            lockError: () =>
                corrupt ? new ShelfStoreCorruptionError("catalog checksum mismatch") : undefined,
        });
        await expect(service.cleanUpExpiredGhosts(30)).rejects.toBeInstanceOf(
            ShelfStoreCorruptionError,
        );
        expect(service.getHealthWarnings()).toContainEqual(
            expect.objectContaining({
                kind: "checksumMismatch",
                detail: "catalog checksum mismatch",
            }),
        );
        corrupt = false;
        await service.cleanUpExpiredGhosts(30);
        expect(kindsOf(service)).toContain("checksumMismatch");
    });

    it("sets pendingRecovery while journals remain and clears it when they drain", async () => {
        let journals: FakeJournal[] = [
            { id: "txn-1", state: "shelvePendingRevert", shelf: { id: "shelf-a", generation: 1 } },
        ];
        const service = await createHealthService({ journals: () => journals });
        await service.resumePendingRecovery();
        expect(service.getHealthWarnings()).toContainEqual(
            expect.objectContaining({
                kind: "pendingRecovery",
                detail: "1 pending recovery journal(s)",
            }),
        );
        journals = [];
        await service.resumePendingRecovery();
        expect(kindsOf(service)).not.toContain("pendingRecovery");
    });
});
