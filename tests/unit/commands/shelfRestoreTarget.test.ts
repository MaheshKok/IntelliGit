import { readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import {
    createCommitInfoVscodeDouble,
    createFakeExtensionUri,
} from "../../visual/recorder/commitInfoVscodeDouble";
vi.mock("vscode", () => {
    const double = createCommitInfoVscodeDouble();
    Object.defineProperty(double.window, "showQuickPick", { value: vi.fn(), configurable: true });
    Object.defineProperty(double.l10n, "t", {
        value: (message: string, values: Record<string, string> = {}) =>
            message.replace(/\{([^}]+)\}/g, (match, key: string) => values[key] ?? match),
    });
    return double;
});
import * as vscode from "vscode";
import { ChangelistStore } from "../../../src/changes/changelistStore";
import { prepareShelfRestore } from "../../../src/commands/shelfRestoreTarget";
import { GitExecutor } from "../../../src/git/executor";
import { RepositoryMutationCoordinator } from "../../../src/git/mutationCoordinator";
import { GitOps } from "../../../src/git/operations";
import type { PartialChanges } from "../../../src/git/partialChanges";
import { RepositoryLock } from "../../../src/git/repositoryLock";
import { RepositoryMutationGate } from "../../../src/git/repositoryMutationGate";
import { ShelfService } from "../../../src/services/shelfService";
import { ChangeWorkflowHost } from "../../../src/views/ChangeWorkflowHost";
import { executeShelfMutationRequest } from "../../../src/views/commitPanelActions";
import {
    cleanTemporaryRepositories,
    createShelfFixture,
    git,
} from "../../integration/shelf/shelfTestHarness";

const showQuickPick = vscode.window.showQuickPick as unknown as Mock;
let host: ChangeWorkflowHost | undefined;

afterEach(async () => {
    host?.dispose();
    host = undefined;
    vi.restoreAllMocks();
    showQuickPick.mockReset();
    await cleanTemporaryRepositories();
});

/** One shelved change, destination list D, and working-tree edits no host has observed yet. */
async function startup() {
    const raw = await createShelfFixture({
        initialFiles: { "shared.txt": "base\n", "mutable.txt": "mutable\n" },
    });
    const root = await realpath(raw.root);
    const values = new Map<string, unknown>();
    const storage = {
        get: <T>(key: string) => values.get(key) as T | undefined,
        update: async (key: string, value: unknown) => {
            values.set(key, structuredClone(value));
        },
    };
    const changelists = ChangelistStore.forStorage(storage);
    const gitOps = new GitOps(new GitExecutor(root));
    await changelists.connect(root, (await gitOps.getGitDirectories()).gitDir);
    const service = new ShelfService({
        repositoryRoot: root,
        executor: raw.executor,
        store: raw.store,
        changelists,
        gate: new RepositoryMutationGate(new RepositoryMutationCoordinator(), new RepositoryLock()),
    });
    await writeFile(path.join(root, "shared.txt"), "incoming\n");
    const saved = await service.shelve({
        name: "Incoming",
        paths: ["shared.txt"],
        silent: true,
        keepLocal: true,
    });
    await git(root, ["checkout", "--", "shared.txt"]);
    await changelists.create(root, changelists.revision(root), "D");
    await writeFile(path.join(root, "mutable.txt"), "edited\n");
    await writeFile(path.join(root, "fresh.txt"), "fresh\n");
    const manifest = await raw.store.readCurrentShelfManifest(saved.shelfId!);
    return {
        root,
        storage,
        changelists,
        gitOps,
        service,
        shelfId: saved.shelfId!,
        generation: manifest.generation,
    };
}

function startHost(f: Awaited<ReturnType<typeof startup>>, gitOps: GitOps): ChangeWorkflowHost {
    host = new ChangeWorkflowHost({
        root: f.root,
        extensionUri: createFakeExtensionUri(),
        gitOps,
        workspaceState: f.storage,
        files: () => [],
        post: () => undefined,
        actions: {
            gitOps,
            refreshData: async () => undefined,
            postCommitted: () => undefined,
            fireWorkingTreeChanged: () => undefined,
            maybeOfferPublishBranch: async () => undefined,
        },
        runCommit: (operation) => operation(),
    });
    return host;
}

type Open = ReturnType<PartialChanges["open"]>;

/** Routes the host tracker's per-file snapshot reads through `intercept`; `open` continues the real read. */
function interceptOpen(gitOps: GitOps, intercept: (open: () => Open) => Open): void {
    const partialFor = gitOps.partialChangesFor.bind(gitOps);
    vi.spyOn(gitOps, "partialChangesFor").mockImplementation((root) => {
        const partial = partialFor(root);
        const open = partial.open.bind(partial);
        vi.spyOn(partial, "open").mockImplementation((...args) => intercept(() => open(...args)));
        return partial;
    });
}

/** The whole-shelf restore every test requests; only its destination prompt varies. */
const request = (f: Awaited<ReturnType<typeof startup>>) => ({
    shelfId: f.shelfId,
    expectedShelfGeneration: f.generation,
    removeFromShelf: false,
    mode: "flattened" as const,
});

const chooseD = () =>
    showQuickPick.mockImplementation(async (items: readonly { label: string }[]) =>
        items.find((item) => item.label === "D"),
    );

/** Names how a promise ended within a bound, so a wait parked on a lease fails by assertion. */
async function within(promise: Promise<unknown>, ms = 10_000): Promise<string> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            promise.then(
                () => "resolved",
                (error: unknown) =>
                    `rejected: ${error instanceof Error ? error.message : String(error)}`,
            ),
            new Promise<string>((resolve) => {
                timer = setTimeout(() => resolve("still pending"), ms);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

describe("targeted restore destination prompt", () => {
    it("the startup reconcile cannot make the first restore stale; its writes land after the restore", async () => {
        const f = await startup();
        const hostGit = new GitOps(new GitExecutor(f.root));
        let release!: () => void;
        const held = new Promise<void>((resolve) => (release = resolve));
        const directories = hostGit.getGitDirectories.bind(hostGit);
        // The startup reconcile stays in its first step until the restore has read its source
        // shelf, so the destination prompt deterministically opens while it is still in flight.
        vi.spyOn(hostGit, "getGitDirectories").mockImplementationOnce(async () => {
            await held;
            return directories();
        });
        const manifest = f.service.getShelfManifest.bind(f.service);
        vi.spyOn(f.service, "getShelfManifest").mockImplementation(async (id) => {
            const read = await manifest(id);
            release();
            return read;
        });
        chooseD();
        const before = f.changelists.revision(f.root);
        const reconciling = startHost(f, hostGit).reconcile(
            await f.gitOps.getStatus({ withStats: false }),
        );

        const result = await prepareShelfRestore(f.service, f.changelists, request(f), (input) =>
            f.service.unshelve(input),
        );
        await reconciling;

        expect(result?.status, "a startup observation must not make the first restore stale").toBe(
            "applied",
        );
        expect(await readFile(path.join(f.root, "shared.txt"), "utf8")).toBe("incoming\n");
        await vi.waitFor(
            () =>
                expect(
                    f.changelists.get(f.root).files["fresh.txt"],
                    "the startup reconcile's first-observation metadata is written",
                ).toBeDefined(),
            { timeout: 10_000 },
        );
        expect(f.changelists.revision(f.root)).toBeGreaterThan(before);
    });

    it("the panel's initial load cannot make the first restore stale; its writes land after the restore", async () => {
        const f = await startup();
        const hostGit = new GitOps(new GitExecutor(f.root));
        let entered!: () => void;
        const reached = new Promise<void>((resolve) => (entered = resolve));
        let release!: () => void;
        const held = new Promise<void>((resolve) => (release = resolve));
        const status = hostGit.getStatus.bind(hostGit);
        // The panel's first load is parked in its status read, before it starts reconciling, while
        // the restore reads its source shelf and opens the destination prompt.
        vi.spyOn(hostGit, "getStatus").mockImplementationOnce(
            async (...args: Parameters<GitOps["getStatus"]>) => {
                entered();
                await held;
                return status(...args);
            },
        );
        const manifest = f.service.getShelfManifest.bind(f.service);
        vi.spyOn(f.service, "getShelfManifest").mockImplementation(async (id) => {
            const read = await manifest(id);
            await reached;
            release();
            return read;
        });
        chooseD();
        const before = f.changelists.revision(f.root);
        const loading = startHost(f, hostGit).handle({
            type: "loadChangelists",
            repositoryRoot: f.root,
        });

        const result = await prepareShelfRestore(f.service, f.changelists, request(f), (input) =>
            f.service.unshelve(input),
        );
        await loading;

        expect(
            result?.status,
            "the panel's initial load must not make the first restore stale",
        ).toBe("applied");
        await vi.waitFor(
            () =>
                expect(
                    f.changelists.get(f.root).files["fresh.txt"],
                    "the initial load's first-observation metadata is written",
                ).toBeDefined(),
            { timeout: 10_000 },
        );
        expect(f.changelists.revision(f.root)).toBeGreaterThan(before);
    });

    it("a reconcile during an unshelve's lease never surfaces the lease error and re-observes after release", async () => {
        const f = await startup();
        const workflow = startHost(f, f.gitOps);
        await workflow.reconcile(await f.gitOps.getStatus({ withStats: false }));
        chooseD();
        let during: string | undefined;
        let settledDuring: string | undefined;
        const prepare = f.changelists.prepareTargetOperation.bind(f.changelists);
        // A worktree change and its reconcile land while the unshelve owns the metadata lease.
        vi.spyOn(f.changelists, "prepareTargetOperation").mockImplementationOnce(
            async (...args) => {
                await writeFile(path.join(f.root, "during.txt"), "during\n");
                during = await within(
                    workflow.reconcile(await f.gitOps.getStatus({ withStats: false })),
                );
                settledDuring = await within(f.changelists.settled(f.root));
                return prepare(...args);
            },
        );

        const result = await prepareShelfRestore(f.service, f.changelists, request(f), (input) =>
            f.service.unshelve(input),
        );

        expect(result?.status).toBe("applied");
        expect(
            during,
            "a reconcile during a targeted operation must neither surface nor wait on the lease",
        ).toBe("resolved");
        expect(settledDuring, "a target prompt must never wait on a held lease").toBe("resolved");
        await vi.waitFor(
            () =>
                expect(
                    f.changelists.get(f.root).files["during.txt"],
                    "the reconcile is retried once the lease is released",
                ).toBeDefined(),
            { timeout: 10_000 },
        );
    }, 60_000);

    it("a destination renamed between pick and apply is still refused with the changelist message", async () => {
        const f = await startup();
        await startHost(f, f.gitOps).reconcile(await f.gitOps.getStatus({ withStats: false }));
        showQuickPick.mockImplementation(async (items: readonly { label: string }[]) => {
            const d = f.changelists.get(f.root).lists.find((list) => list.name === "D")!;
            await f.changelists.rename(f.root, f.changelists.revision(f.root), d.id, "Renamed");
            return items.find((item) => item.label === "D");
        });
        const postCompleted = vi.fn();

        await executeShelfMutationRequest(
            {
                shelfService: f.service,
                changelists: f.changelists,
                refreshData: async () => undefined,
                fireWorkingTreeChanged: () => undefined,
            },
            {
                type: "unshelve",
                requestId: "restore-renamed",
                shelfId: f.shelfId,
                expectedGeneration: f.generation,
                removeFromShelf: false,
                mode: "flattened",
            },
            postCompleted,
        );

        expect(postCompleted).toHaveBeenCalledWith(
            expect.objectContaining({
                requestId: "restore-renamed",
                status: "staleShelf",
                message: "The shelf or changelists changed. Nothing was unshelved; try again.",
            }),
        );
        expect(await readFile(path.join(f.root, "shared.txt"), "utf8")).toBe("base\n");
    });

    it("the history prompt waits for an in-flight observation and a failed one never blocks it", async () => {
        const f = await createShelfFixture();
        const root = await realpath(f.root);
        const changelists = new ChangelistStore();
        let fail!: (error: Error) => void;
        changelists.observe(
            root,
            new Promise<void>((_, reject) => {
                fail = reject;
            }),
        );
        let connected!: () => void;
        const ready = new Promise<void>((resolve) => (connected = resolve));
        const connect = changelists.connect.bind(changelists);
        vi.spyOn(changelists, "connect").mockImplementation(async (...args) => {
            await connect(...args);
            connected();
        });
        const prompt = vi.fn(async () => undefined);

        const applying = new GitOps(new GitExecutor(root)).applyTargetHistory(
            root,
            changelists,
            prompt,
        );
        await ready;
        await new Promise((resolve) => setImmediate(resolve));

        expect(prompt, "the prompt must not read state while an observation runs").not.toBeCalled();
        fail(new Error("observation failed"));
        await expect(applying).resolves.toEqual({ status: "cancelled" });
        expect(prompt).toHaveBeenCalledTimes(1);
    });
});

describe("observer hold during a targeted prompt", () => {
    it("the destination prompt opens while a slow tracker pass is in flight, and that pass cannot stale the restore", async () => {
        const f = await startup();
        const hostGit = new GitOps(new GitExecutor(f.root));
        let entered!: () => void;
        const inFlight = new Promise<void>((resolve) => (entered = resolve));
        let unpark!: () => void;
        const parked = new Promise<void>((resolve) => (unpark = resolve));
        // The host's range snapshot read stalls, as a ~300 ms-per-file pass does on a large repository.
        interceptOpen(hostGit, async (open) => {
            entered();
            await parked;
            return open();
        });
        const workflow = startHost(f, hostGit);
        const reconciling = workflow.reconcile(await f.gitOps.getStatus({ withStats: false }));
        await inFlight;
        let opened!: () => void;
        const prompted = new Promise<void>((resolve) => (opened = resolve));
        let during: string | undefined;
        let atPrompt = -1;
        let afterWrite = -1;
        showQuickPick.mockImplementation(async (items: readonly { label: string }[]) => {
            opened();
            atPrompt = f.changelists.revision(f.root);
            // The tracker resumes and reaches its metadata write while the prompt is open.
            unpark();
            during = await within(reconciling);
            afterWrite = f.changelists.revision(f.root);
            return items.find((item) => item.label === "D");
        });

        const restoring = prepareShelfRestore(f.service, f.changelists, request(f), (input) =>
            f.service.unshelve(input),
        );
        restoring.catch(() => undefined);
        const opening = await within(prompted);
        unpark();

        expect(opening, "the destination prompt must not wait for an in-flight tracker pass").toBe(
            "resolved",
        );
        const result = await restoring;
        expect(during, "a held tracker write resolves its observation instead of waiting").toBe(
            "resolved",
        );
        expect(afterWrite, "a tracker write during the prompt is deferred").toBe(atPrompt);
        expect(result?.status, "the restore applies at the revision its prompt stamped").toBe(
            "applied",
        );
    }, 60_000);

    it("an observer write during the hold is deferred, never queued, and re-observed from fresh status", async () => {
        const f = await startup();
        const workflow = startHost(f, f.gitOps);
        await workflow.reconcile(await f.gitOps.getStatus({ withStats: false }));
        let during: string | undefined;
        let atPrompt = -1;
        let afterWrite = -1;
        showQuickPick.mockImplementation(async (items: readonly { label: string }[]) => {
            atPrompt = f.changelists.revision(f.root);
            await writeFile(path.join(f.root, "during.txt"), "during\n");
            during = await within(
                workflow.reconcile(await f.gitOps.getStatus({ withStats: false })),
                5_000,
            );
            afterWrite = f.changelists.revision(f.root);
            // The deferred snapshot goes stale: a replay would record during.txt and miss later.txt.
            await rm(path.join(f.root, "during.txt"));
            await writeFile(path.join(f.root, "later.txt"), "later\n");
            return items.find((item) => item.label === "D");
        });

        const restoring = prepareShelfRestore(f.service, f.changelists, request(f), (input) =>
            f.service.unshelve(input),
        );
        restoring.catch(() => undefined);

        expect(
            await within(restoring, 20_000),
            "the target operation must never queue behind its own hold",
        ).toBe("resolved");
        expect(during, "an observer write during the hold is deferred, not awaited").toBe(
            "resolved",
        );
        expect(afterWrite, "the deferred write did not advance the stamped revision").toBe(
            atPrompt,
        );
        expect((await restoring)?.status).toBe("applied");
        await vi.waitFor(
            () =>
                expect(
                    f.changelists.get(f.root).files["later.txt"],
                    "after release the host re-observes from a fresh status read",
                ).toBeDefined(),
            { timeout: 10_000 },
        );
        expect(
            f.changelists.get(f.root).files["during.txt"],
            "the deferred snapshot is discarded, not replayed",
        ).toBeUndefined();
    }, 60_000);

    it("observer writes refused during one hold share a single fresh re-observation after release", async () => {
        const f = await startup();
        const workflow = startHost(f, f.gitOps);
        await workflow.reconcile(await f.gitOps.getStatus({ withStats: false }));
        const status = vi.spyOn(f.gitOps, "getStatus");
        let refused: string[] = [];
        showQuickPick.mockImplementation(async (items: readonly { label: string }[]) => {
            const files = await f.gitOps.getStatus({ withStats: false });
            status.mockClear();
            refused = await Promise.all(
                [1, 2, 3].map(() => within(workflow.reconcile(files), 5_000)),
            );
            await writeFile(path.join(f.root, "later.txt"), "later\n");
            return items.find((item) => item.label === "D");
        });

        const outcome = await within(
            prepareShelfRestore(f.service, f.changelists, request(f), (input) =>
                f.service.unshelve(input),
            ),
            20_000,
        );
        await vi.waitFor(() => expect(f.changelists.get(f.root).files["later.txt"]).toBeDefined(), {
            timeout: 10_000,
        });
        await new Promise((resolve) => setTimeout(resolve, 500));

        expect(outcome).toBe("resolved");
        expect(refused, "observer writes during the hold are refused, not awaited").toEqual([
            "resolved",
            "resolved",
            "resolved",
        ]);
        expect(
            status.mock.calls.length,
            "three refused observations must share one status re-read after release",
        ).toBe(1);
    }, 60_000);

    it("a re-observation refused by a later hold schedules its own once that hold ends", async () => {
        const f = await startup();
        const workflow = startHost(f, f.gitOps);
        await workflow.reconcile(await f.gitOps.getStatus({ withStats: false }));
        const first = await f.changelists.holdObservers(f.root);
        await workflow.reconcile(await f.gitOps.getStatus({ withStats: false }));
        let second: (() => void) | undefined;
        const status = f.gitOps.getStatus.bind(f.gitOps);
        // The shared retry's status read starts a new hold, so its re-observation is refused too.
        vi.spyOn(f.gitOps, "getStatus").mockImplementationOnce(
            async (...args: Parameters<GitOps["getStatus"]>) => {
                second = await f.changelists.holdObservers(f.root);
                return status(...args);
            },
        );

        first();
        await vi.waitFor(() => expect(second, "the retry started a second hold").toBeDefined(), {
            timeout: 10_000,
        });
        await writeFile(path.join(f.root, "later.txt"), "later\n");
        second!();

        await vi.waitFor(
            () =>
                expect(
                    f.changelists.get(f.root).files["later.txt"],
                    "a retry refused by a later hold re-observes after that hold ends",
                ).toBeDefined(),
            { timeout: 10_000 },
        );
    }, 60_000);

    it("an observation parked across a whole restore is discarded, not resumed with its stale snapshot", async () => {
        const f = await startup();
        const hostGit = new GitOps(new GitExecutor(f.root));
        let parking = false;
        let entered!: () => void;
        const inFlight = new Promise<void>((resolve) => (entered = resolve));
        let unpark!: () => void;
        const parked = new Promise<void>((resolve) => (unpark = resolve));
        interceptOpen(hostGit, async (open) => {
            if (parking) {
                parking = false;
                entered();
                await parked;
            }
            return open();
        });
        const workflow = startHost(f, hostGit);
        await workflow.reconcile(await f.gitOps.getStatus({ withStats: false }));
        await writeFile(path.join(f.root, "during.txt"), "during\n");
        // New bytes defeat the tracker cache, so this pass parks in its snapshot read.
        await writeFile(path.join(f.root, "mutable.txt"), "edited again\n");
        parking = true;
        const reconciling = workflow.reconcile(await f.gitOps.getStatus({ withStats: false }));
        await inFlight;
        chooseD();

        const restoring = prepareShelfRestore(f.service, f.changelists, request(f), (input) =>
            f.service.unshelve(input),
        );
        restoring.catch(() => undefined);
        expect(
            await within(restoring),
            "the restore completes while the tracker pass is parked",
        ).toBe("resolved");
        expect((await restoring)?.status).toBe("applied");
        const restored = f.changelists.get(f.root);
        const d = restored.lists.find((list) => list.name === "D")!.id;
        const restoredLines = restored.changes["shared.txt"]?.lines ?? {};
        expect(Object.values(restoredLines).length).toBeGreaterThan(0);
        expect(new Set(Object.values(restoredLines))).toEqual(new Set([d]));
        await rm(path.join(f.root, "during.txt"));
        await writeFile(path.join(f.root, "later.txt"), "later\n");
        unpark();
        await reconciling;

        // New files are listed before the range scan, so during.txt was admitted before the hold.
        expect(
            f.changelists.get(f.root).changes,
            "an observation interrupted by a hold must not resume with its pre-restore snapshot",
        ).toEqual(restored.changes);
        await vi.waitFor(
            () =>
                expect(
                    f.changelists.get(f.root).files["later.txt"],
                    "the interrupted observation is re-run from a fresh status read",
                ).toBeDefined(),
            { timeout: 10_000 },
        );
        expect(
            f.changelists.get(f.root).files["during.txt"],
            "the re-run drops a file deleted during the restore",
        ).toBeUndefined();
        expect(
            f.changelists.get(f.root).changes["shared.txt"]?.lines,
            "the restored lines keep their destination list",
        ).toEqual(restoredLines);
    }, 60_000);

    it("a file cleaned after the host saw it edited restores into the destination while that observation is held", async () => {
        const f = await startup();
        const hostGit = new GitOps(new GitExecutor(f.root));
        let parking = false;
        let entered!: () => void;
        const inFlight = new Promise<void>((resolve) => (entered = resolve));
        let unpark!: () => void;
        const parked = new Promise<void>((resolve) => (unpark = resolve));
        interceptOpen(hostGit, async (open) => {
            if (parking) {
                parking = false;
                entered();
                await parked;
            }
            return open();
        });
        const workflow = startHost(f, hostGit);
        // The host records the shelved edit, then the file is cleaned outside the UI.
        await writeFile(path.join(f.root, "shared.txt"), "incoming\n");
        await workflow.reconcile(await f.gitOps.getStatus({ withStats: false }));
        expect(f.changelists.get(f.root).changes["shared.txt"]).toBeDefined();
        await git(f.root, ["checkout", "--", "shared.txt"]);
        // The observation of the clean file is still in flight when the restore holds observers.
        parking = true;
        const reconciling = workflow.reconcile(await f.gitOps.getStatus({ withStats: false }));
        await inFlight;
        chooseD();

        const result = await prepareShelfRestore(f.service, f.changelists, request(f), (input) =>
            f.service.unshelve(input),
        );
        const d = f.changelists.get(f.root).lists.find((list) => list.name === "D")!.id;
        const owners = () =>
            new Set(Object.values(f.changelists.get(f.root).changes["shared.txt"]?.lines ?? {}));

        expect(
            result?.status,
            "ownership recorded for older bytes must not send the restore to review",
        ).toBe("applied");
        expect(owners(), "the restored lines belong to the destination").toEqual(new Set([d]));
        await writeFile(path.join(f.root, "later.txt"), "later\n");
        unpark();
        await reconciling;
        await vi.waitFor(
            () =>
                expect(
                    f.changelists.get(f.root).files["later.txt"],
                    "the held observation is re-run after release",
                ).toBeDefined(),
            { timeout: 10_000 },
        );
        expect(owners(), "the host's re-observation after release keeps the destination").toEqual(
            new Set([d]),
        );
    }, 60_000);

    it("a tracker failure during the hold defers its review marker too", async () => {
        const f = await startup();
        const hostGit = new GitOps(new GitExecutor(f.root));
        let failing = false;
        interceptOpen(hostGit, (open) =>
            failing ? Promise.reject(new Error("injected snapshot failure")) : open(),
        );
        const workflow = startHost(f, hostGit);
        await workflow.reconcile(await f.gitOps.getStatus({ withStats: false }));
        let during: string | undefined;
        let atPrompt = -1;
        let afterReview = -1;
        showQuickPick.mockImplementation(async (items: readonly { label: string }[]) => {
            atPrompt = f.changelists.revision(f.root);
            failing = true;
            // New bytes defeat the tracker cache, so its failed snapshot read asks for review.
            await writeFile(path.join(f.root, "mutable.txt"), "edited again\n");
            during = await within(
                workflow.reconcile(await f.gitOps.getStatus({ withStats: false })),
            );
            afterReview = f.changelists.revision(f.root);
            failing = false;
            return items.find((item) => item.label === "D");
        });

        const result = await prepareShelfRestore(f.service, f.changelists, request(f), (input) =>
            f.service.unshelve(input),
        );

        expect(during).toBe("resolved");
        expect(afterReview, "a review marker requested during the hold is deferred").toBe(atPrompt);
        expect(result?.status).toBe("applied");
    }, 60_000);

    it("a cancelled or failed restore releases the hold so observer writes go through", async () => {
        const f = await startup();
        const workflow = startHost(f, f.gitOps);
        await workflow.reconcile(await f.gitOps.getStatus({ withStats: false }));
        showQuickPick.mockResolvedValue(undefined);

        const cancelled = await prepareShelfRestore(f.service, f.changelists, request(f), (input) =>
            f.service.unshelve(input),
        );

        expect(cancelled, "cancelling the prompt applies nothing").toBeUndefined();
        expect(
            await within(f.changelists.targetOperationReleased(f.root)),
            "a cancelled prompt releases its observer hold",
        ).toBe("resolved");
        await writeFile(path.join(f.root, "after.txt"), "after\n");
        await workflow.reconcile(await f.gitOps.getStatus({ withStats: false }));
        expect(
            f.changelists.get(f.root).files["after.txt"],
            "observer writes after a cancelled prompt go through at once",
        ).toBeDefined();

        chooseD();
        await expect(
            prepareShelfRestore(f.service, f.changelists, request(f), async () => {
                throw new Error("injected apply failure");
            }),
        ).rejects.toThrow("injected apply failure");
        expect(
            await within(f.changelists.targetOperationReleased(f.root)),
            "a failed apply releases its observer hold",
        ).toBe("resolved");
    }, 60_000);

    it("a write from another window during the hold still refuses the restore as stale", async () => {
        const f = await startup();
        const other = new ChangelistStore();
        await other.connect(f.root, (await f.gitOps.getGitDirectories()).gitDir);
        let otherWrite: string | undefined;
        showQuickPick.mockImplementation(async (items: readonly { label: string }[]) => {
            otherWrite = await within(other.create(f.root, other.revision(f.root), "Elsewhere"));
            return items.find((item) => item.label === "D");
        });

        const result = await prepareShelfRestore(f.service, f.changelists, request(f), (input) =>
            f.service.unshelve(input),
        );

        expect(otherWrite, "this window's hold never defers another window's write").toBe(
            "resolved",
        );
        expect(result?.status, "the exact revision fence still refuses the restore").toBe("stale");
        expect(await readFile(path.join(f.root, "shared.txt"), "utf8")).toBe("base\n");
    }, 60_000);

    it("the history prompt opens while a tracker pass is in flight and holds observer writes until it ends", async () => {
        const f = await startup();
        const hostGit = new GitOps(new GitExecutor(f.root));
        let entered!: () => void;
        const inFlight = new Promise<void>((resolve) => (entered = resolve));
        let unpark!: () => void;
        const parked = new Promise<void>((resolve) => (unpark = resolve));
        interceptOpen(hostGit, async (open) => {
            entered();
            await parked;
            return open();
        });
        const workflow = startHost(f, hostGit);
        const reconciling = workflow.reconcile(await f.gitOps.getStatus({ withStats: false }));
        await inFlight;
        let held: string | undefined;
        const prompt = vi.fn(async () => {
            held = await within(f.changelists.reconcileFiles(f.root, ["late.txt"]));
            return undefined;
        });

        const applying = f.gitOps.applyTargetHistory(f.root, f.changelists, prompt);
        applying.catch(() => undefined);
        const outcome = await within(applying);
        unpark();

        expect(outcome, "the history prompt must not wait for an in-flight tracker pass").toBe(
            "resolved",
        );
        expect(held, "an observer write during the history prompt is deferred").toBe(
            "rejected: A targeted operation requires its owning metadata lease.",
        );
        await reconciling;
        expect(
            (await f.changelists.reconcileFiles(f.root, ["late.txt"])).files["late.txt"],
            "a cancelled history prompt releases its hold",
        ).toBeDefined();
    }, 60_000);
});
