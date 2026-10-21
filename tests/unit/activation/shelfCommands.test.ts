import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
    const commands = new Map<string, (...args: unknown[]) => unknown>();
    return {
        commands,
        registerCommand: vi.fn((id: string, handler: (...args: unknown[]) => unknown) => {
            commands.set(id, handler);
            return { dispose: vi.fn() };
        }),
        showErrorMessage: vi.fn(),
        showInformationMessage: vi.fn(),
        showInputBox: vi.fn(),
        showOpenDialog: vi.fn(),
        showQuickPick: vi.fn(),
        showWarningMessage: vi.fn(),
    };
});

vi.mock("vscode", () => ({
    commands: { registerCommand: mocks.registerCommand },
    l10n: { t: (message: string) => message },
    window: {
        showErrorMessage: mocks.showErrorMessage,
        showInformationMessage: mocks.showInformationMessage,
        showInputBox: mocks.showInputBox,
        showOpenDialog: mocks.showOpenDialog,
        showQuickPick: mocks.showQuickPick,
        showWarningMessage: mocks.showWarningMessage,
    },
    workspace: {
        getConfiguration: () => ({
            get: (_section: string, defaultValue?: unknown) => defaultValue,
        }),
    },
}));

import { registerShelfCommands, SHELF_COMMAND_IDS } from "../../../src/activation/shelfCommands";
import { RepositoryLockBusyError } from "../../../src/git/repositoryLock";
import { REPOSITORY_GATE_ACQUIRE_TIMEOUT_MS } from "../../../src/git/repositoryMutationGate";

const successfulMutation = { status: "ok" as const, entries: [] };
const CHECKSUM = "c".repeat(64);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

type TargetStatus =
    "applied" | "notApplied" | "appliedNeedsReview" | "conflicted" | "stale" | "busy";

const targetResult = (status: TargetStatus = "applied") => ({
    status,
    entries: [],
    shelfId: "new",
    operationId: "00000000-0000-4000-8000-000000000000",
});

const changelistState = {
    revision: 7,
    activeId: "list-c",
    lists: [
        { id: "list-c", name: "C", description: "", draft: "" },
        { id: "list-d", name: "D", description: "", draft: "destination draft" },
    ],
    allDraft: "",
    files: {},
    changes: {},
};

const makeChangelists = () => ({
    get: vi.fn(() => structuredClone(changelistState)),
    settled: async () => undefined,
    holdObservers: async () => () => undefined,
});

/** Answers the shelf picker, then the destination picker with the named existing list. */
const pickShelfThenTarget = (shelfId: string, listName: string | undefined) => {
    mocks.showQuickPick.mockImplementationOnce(async (items: { shelf: { id: string } }[]) =>
        items.find((item) => item.shelf.id === shelfId),
    );
    mocks.showQuickPick.mockImplementationOnce(async (items: { label: string }[]) =>
        listName === undefined ? undefined : items.find((item) => item.label === listName),
    );
};

const makeService = (root = "/one") => ({
    repositoryRoot: root,
    shelve: vi.fn(async () => successfulMutation),
    unshelve: vi.fn(async () => targetResult()),
    getShelfManifest: vi.fn(async (id: string) => ({
        generation: id === "old" ? 1 : 2,
        checksum: CHECKSUM,
        metadata: { name: id === "old" ? "Old" : "New", lifecycle: "shelved" },
        files: [{ changeId: "change-1" }],
    })),
    importPatch: vi.fn(async () => successfulMutation),
    cleanUp: vi.fn(async () => successfulMutation),
    purgeRecovery: vi.fn(async () => []),
    listShelves: vi.fn(async () => ({
        shelfIds: ["old", "new", "ghost"],
        corruptShelfIds: [],
        catalogGeneration: 4,
        shelves: [
            { id: "old", generation: 1, metadata: { name: "Old", lifecycle: "shelved" } },
            { id: "new", generation: 2, metadata: { name: "New", lifecycle: "shelved" } },
            { id: "ghost", generation: 3, metadata: { name: "Ghost", lifecycle: "applied" } },
        ],
    })),
});

const register = (
    services = new Map([["/one", makeService()]]),
    changelists = makeChangelists(),
) => {
    const refresh = vi.fn(async () => undefined);
    const repositories = {
        current: [...services.keys()].map((root) => ({
            root,
            label: root === "/one" ? "One" : "Two",
        })),
    };
    registerShelfCommands({
        context: { subscriptions: [] } as never,
        getRepositories: () => repositories.current,
        shelfServiceForRepository: (root) => services.get(root) as never,
        changelists: changelists as never,
        refreshAfterMutation: refresh,
    });
    return { refresh, service: services.get("/one")!, changelists, repositories };
};

describe("registerShelfCommands", () => {
    beforeEach(() => {
        mocks.commands.clear();
        vi.clearAllMocks();
    });

    it("registers the eight direct shelf command-palette IDs", () => {
        register();
        expect([...mocks.commands.keys()]).toEqual([...SHELF_COMMAND_IDS]);
        expect(SHELF_COMMAND_IDS).toContain("intelligit.applyPatchToChangelist");
    });

    it("shelves all changes, saves locally, imports host-selected patches, and unshelves the newest live shelf", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-07-23T10:11:12Z"));
        const { refresh, service } = register();
        mocks.showInputBox.mockResolvedValue("Prompted shelf");
        mocks.showOpenDialog.mockResolvedValue([{ fsPath: "/tmp/one.patch" }]);
        pickShelfThenTarget("new", "D");
        mocks.showWarningMessage.mockResolvedValue("Purge Shelf Recovery");

        await mocks.commands.get("intelligit.shelveChanges")?.();
        await mocks.commands.get("intelligit.shelveSilently")?.();
        await mocks.commands.get("intelligit.saveToShelf")?.();
        await mocks.commands.get("intelligit.importPatch")?.();
        await mocks.commands.get("intelligit.unshelve")?.();
        await mocks.commands.get("intelligit.purgeShelfRecovery")?.();

        const defaultName = mocks.showInputBox.mock.calls[0]?.[0]?.value;
        expect(defaultName).toBe("Uncommitted changes");
        expect(service.shelve).toHaveBeenNthCalledWith(1, {
            name: "Prompted shelf",
            paths: [],
            silent: false,
            keepLocal: false,
        });
        expect(service.shelve).toHaveBeenNthCalledWith(2, {
            name: defaultName,
            paths: [],
            silent: true,
            keepLocal: false,
        });
        expect(service.shelve).toHaveBeenNthCalledWith(3, {
            name: defaultName,
            paths: [],
            silent: true,
            keepLocal: true,
        });
        expect(service.importPatch).toHaveBeenCalledWith({ fileUris: ["/tmp/one.patch"] });
        expect(service.unshelve).toHaveBeenCalledWith({
            id: "new",
            expectedShelfGeneration: 2,
            removeFromShelf: true,
            mode: "flattened",
            targetOperation: {
                id: expect.stringMatching(UUID),
                root: "/one",
                target: { kind: "existing", id: "list-d", revision: 7 },
                sourceChecksum: CHECKSUM,
            },
        });
        expect(service.purgeRecovery).toHaveBeenCalledTimes(1);
        expect(mocks.showQuickPick).toHaveBeenCalledWith(
            [
                expect.objectContaining({ shelf: expect.objectContaining({ id: "new" }) }),
                expect.objectContaining({ shelf: expect.objectContaining({ id: "old" }) }),
            ],
            expect.any(Object),
        );
        expect(refresh).toHaveBeenCalledTimes(6);
        vi.useRealTimers();
    });

    it("orders unshelve picks by creation time with legacy shelves last", async () => {
        const service = makeService();
        service.listShelves.mockResolvedValue({
            shelfIds: ["latest", "legacy", "earlier"],
            corruptShelfIds: [],
            catalogGeneration: 4,
            shelves: [
                {
                    id: "latest",
                    generation: 3,
                    metadata: { name: "Latest", lifecycle: "shelved", createdAt: 300 },
                },
                {
                    id: "legacy",
                    generation: 1,
                    metadata: { name: "Legacy", lifecycle: "shelved" },
                },
                {
                    id: "earlier",
                    generation: 2,
                    metadata: { name: "Earlier", lifecycle: "shelved", createdAt: 100 },
                },
            ],
        });
        register(new Map([["/one", service]]));
        mocks.showQuickPick.mockResolvedValue(undefined);

        await mocks.commands.get("intelligit.unshelve")?.();

        expect(mocks.showQuickPick.mock.calls[0]?.[0]).toEqual([
            expect.objectContaining({ shelf: expect.objectContaining({ id: "latest" }) }),
            expect.objectContaining({ shelf: expect.objectContaining({ id: "earlier" }) }),
            expect.objectContaining({ shelf: expect.objectContaining({ id: "legacy" }) }),
        ]);
    });

    it("waits for a briefly busy shelf lock before listing shelves to unshelve", async () => {
        const service = makeService();
        const listed = await service.listShelves();
        service.listShelves
            .mockRejectedValueOnce(new RepositoryLockBusyError())
            .mockRejectedValueOnce(new RepositoryLockBusyError())
            .mockResolvedValueOnce(listed);
        register(new Map([["/one", service]]));
        mocks.showQuickPick.mockResolvedValue(undefined);

        await mocks.commands.get("intelligit.unshelve")?.();

        expect(mocks.showErrorMessage).not.toHaveBeenCalled();
        expect(mocks.showQuickPick).toHaveBeenCalledTimes(1);
    });

    it("reports a shelf lock still busy only after the repository gate's wait", async () => {
        vi.useFakeTimers();
        try {
            const service = makeService();
            service.listShelves.mockRejectedValue(new RepositoryLockBusyError());
            register(new Map([["/one", service]]));

            const done = mocks.commands.get("intelligit.unshelve")?.() as Promise<void>;
            await vi.advanceTimersByTimeAsync(REPOSITORY_GATE_ACQUIRE_TIMEOUT_MS - 100);
            expect(
                mocks.showErrorMessage,
                "still waiting inside the gate window",
            ).not.toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(200);

            // Asserted before awaiting the command, so a wait that never ends fails here, not as a hang.
            expect(
                mocks.showErrorMessage,
                "busy reported once the gate window is spent",
            ).toHaveBeenCalledWith(`Unshelve failed: ${new RepositoryLockBusyError().message}`);
            await done;
            expect(mocks.showQuickPick).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });

    it("picks a repository only when ambiguous and stops before service work when a picker is cancelled", async () => {
        const one = makeService();
        const two = makeService();
        const services = new Map([
            ["/one", one],
            ["/two", two],
        ]);
        register(services);
        mocks.showQuickPick.mockResolvedValue(undefined);

        await mocks.commands.get("intelligit.shelveSilently")?.();

        expect(mocks.showQuickPick).toHaveBeenCalledTimes(1);
        expect(one.shelve).not.toHaveBeenCalled();
        expect(two.shelve).not.toHaveBeenCalled();
    });

    it("cleans all ghosts after confirmation, reports an empty cleanup, and reports service errors", async () => {
        const { service, refresh } = register();
        mocks.showWarningMessage.mockResolvedValue("Clean Up Shelf");
        await mocks.commands.get("intelligit.cleanUpShelf")?.();
        expect(service.cleanUp).toHaveBeenCalledWith({
            shelfIds: ["ghost"],
            expectedCatalogGeneration: 4,
        });

        service.listShelves.mockResolvedValueOnce({
            shelfIds: [],
            corruptShelfIds: [],
            catalogGeneration: 5,
            shelves: [],
        });
        await mocks.commands.get("intelligit.cleanUpShelf")?.();
        expect(mocks.showInformationMessage).toHaveBeenCalledWith(
            "No already unshelved shelves to clean up.",
        );

        service.purgeRecovery.mockRejectedValueOnce(new Error("locked"));
        mocks.showWarningMessage.mockResolvedValue("Purge Shelf Recovery");
        await mocks.commands.get("intelligit.purgeShelfRecovery")?.();
        expect(mocks.showErrorMessage).toHaveBeenCalledWith("Purge shelf recovery failed: locked");
        expect(refresh).toHaveBeenCalledTimes(1);
    });
});

describe("native targeted unshelve", () => {
    beforeEach(() => {
        mocks.commands.clear();
        vi.resetAllMocks();
        mocks.registerCommand.mockImplementation(
            (id: string, handler: (...args: unknown[]) => unknown) => {
                mocks.commands.set(id, handler);
                return { dispose: vi.fn() };
            },
        );
    });

    it("cancel target picker runs zero Git commands", async () => {
        const { service, refresh } = register();
        pickShelfThenTarget("new", undefined);

        await mocks.commands.get("intelligit.unshelve")?.();

        expect(
            service.unshelve,
            "cancelled destination must not reach the service",
        ).not.toHaveBeenCalled();
        expect(refresh).not.toHaveBeenCalled();
        expect(mocks.showInformationMessage).not.toHaveBeenCalled();
        expect(mocks.showErrorMessage).not.toHaveBeenCalled();
    });

    it("repository switch during prompt cannot redirect apply", async () => {
        const one = makeService("/one");
        const two = makeService("/two");
        const { repositories } = register(
            new Map([
                ["/one", one],
                ["/two", two],
            ]),
        );
        mocks.showQuickPick.mockImplementationOnce(
            async (items: { repository: { root: string } }[]) =>
                items.find((item) => item.repository.root === "/one"),
        );
        mocks.showQuickPick.mockImplementationOnce(async (items: { shelf: { id: string } }[]) =>
            items.find((item) => item.shelf.id === "new"),
        );
        mocks.showQuickPick.mockImplementationOnce(async (items: { label: string }[]) => {
            repositories.current = [{ root: "/two", label: "Two" }];
            return items.find((item) => item.label === "D");
        });

        await mocks.commands.get("intelligit.unshelve")?.();

        expect(
            two.unshelve,
            "a later active repository must never receive the restore",
        ).not.toHaveBeenCalled();
        expect(one.unshelve).toHaveBeenCalledWith(
            expect.objectContaining({
                targetOperation: expect.objectContaining({ root: "/one" }),
            }),
        );
    });

    it("passes current source generation, checksum, target and chosen source draft", async () => {
        const service = makeService();
        service.getShelfManifest.mockResolvedValue({
            generation: 2,
            checksum: CHECKSUM,
            metadata: {
                name: "New",
                lifecycle: "shelved",
                selection: {
                    version: 1,
                    scope: "list",
                    sourceLists: [
                        { id: "src-a", name: "A", description: "", draft: "draft A" },
                        { id: "src-z", name: "Z", description: "", draft: "unrelated" },
                    ],
                    entries: [{ changeId: "change-1", sourceListIds: ["src-a"] }],
                },
            },
            files: [{ changeId: "change-1" }],
        } as never);
        register(new Map([["/one", service]]));
        pickShelfThenTarget("new", "D");
        mocks.showQuickPick.mockImplementationOnce(
            async (items: { label: string; choice: unknown }[]) => {
                expect(items.map((item) => item.label)).toEqual([
                    "Keep Destination Draft",
                    "Copy Draft from {name}",
                ]);
                return items[1];
            },
        );

        await mocks.commands.get("intelligit.unshelve")?.();

        expect(service.unshelve).toHaveBeenCalledWith({
            id: "new",
            expectedShelfGeneration: 2,
            removeFromShelf: true,
            mode: "flattened",
            targetOperation: {
                id: expect.stringMatching(UUID),
                root: "/one",
                target: { kind: "existing", id: "list-d", revision: 7 },
                sourceChecksum: CHECKSUM,
                draftChoice: {
                    kind: "copySource",
                    sourceListId: "src-a",
                    expectedDestinationDraft: "destination draft",
                },
            },
        });
    });

    it("rejects a shelf that changed before the prompt without asking for a target", async () => {
        const service = makeService();
        service.getShelfManifest.mockResolvedValue({
            generation: 3,
            checksum: CHECKSUM,
            metadata: { name: "New", lifecycle: "shelved" },
            files: [],
        } as never);
        register(new Map([["/one", service]]));
        pickShelfThenTarget("new", "D");

        await mocks.commands.get("intelligit.unshelve")?.();

        expect(mocks.showQuickPick).toHaveBeenCalledTimes(1);
        expect(service.unshelve).not.toHaveBeenCalled();
        expect(mocks.showWarningMessage).toHaveBeenCalledWith(
            "The shelf or changelists changed. Nothing was unshelved; try again.",
        );
    });

    it.each([
        ["notApplied", "No shelf changes were applied."],
        ["conflicted", "Unshelve stopped with conflicts. Resolve them from the Shelf tab."],
        ["stale", "The shelf or changelists changed. Nothing was unshelved; try again."],
        [
            "busy",
            "Another repository operation is running or awaiting review. Nothing was unshelved.",
        ],
        ["appliedNeedsReview", "Unshelve changed files but needs review before it can finish."],
    ] as const)("reports %s distinctly instead of generic success", async (status, text) => {
        const { service } = register();
        service.unshelve.mockResolvedValue(targetResult(status));
        pickShelfThenTarget("new", "D");

        await mocks.commands.get("intelligit.unshelve")?.();

        expect(mocks.showWarningMessage, `${status} message`).toHaveBeenCalledWith(text);
        expect(mocks.showInformationMessage).not.toHaveBeenCalledWith("Shelf unshelved.");
    });

    it("refresh failure after applied Git keeps the success result", async () => {
        const { service, refresh } = register();
        refresh.mockRejectedValueOnce(new Error("refresh down"));
        pickShelfThenTarget("new", "D");

        await mocks.commands.get("intelligit.unshelve")?.();

        expect(service.unshelve).toHaveBeenCalledOnce();
        expect(mocks.showInformationMessage).toHaveBeenCalledWith("Shelf unshelved.");
        expect(
            mocks.showErrorMessage,
            "refresh must not relabel applied Git",
        ).not.toHaveBeenCalled();
    });

    it("issues a fresh host operation ID for every native request", async () => {
        const { service } = register();
        pickShelfThenTarget("new", "D");
        await mocks.commands.get("intelligit.unshelve")?.();
        pickShelfThenTarget("new", "D");
        await mocks.commands.get("intelligit.unshelve")?.();

        const ids = service.unshelve.mock.calls.map(
            (call) =>
                (call as unknown as [{ targetOperation: { id: string } }])[0].targetOperation.id,
        );
        expect(ids).toHaveLength(2);
        expect(new Set(ids).size).toBe(2);
    });
});

describe("apply patch to changelist", () => {
    const APPLY = "intelligit.applyPatchToChangelist";
    const IMPORTED_NOTICE = "Patch imported to shelf. Nothing was applied.";

    beforeEach(() => {
        mocks.commands.clear();
        vi.resetAllMocks();
        mocks.registerCommand.mockImplementation(
            (id: string, handler: (...args: unknown[]) => unknown) => {
                mocks.commands.set(id, handler);
                return { dispose: vi.fn() };
            },
        );
    });

    const importedService = (root = "/one") => {
        const service = makeService(root);
        service.importPatch.mockResolvedValue({
            ...successfulMutation,
            shelfId: "imported",
            newGeneration: 1,
        } as never);
        service.getShelfManifest.mockResolvedValue({
            generation: 1,
            checksum: CHECKSUM,
            metadata: { name: "fix.patch", lifecycle: "shelved" },
            files: [
                { changeId: "change-1", worktreeBlock: { path: "src/a.ts" } },
                { changeId: "change-2", indexBlock: { path: "src/b.ts" } },
            ],
        } as never);
        return service;
    };

    const pickTarget = (listName: string | undefined) =>
        mocks.showQuickPick.mockImplementationOnce(async (items: { label: string }[]) =>
            listName === undefined ? undefined : items.find((item) => item.label === listName),
        );

    it("cancel at the patch picker imports nothing and runs zero Git commands", async () => {
        const { service, refresh } = register(new Map([["/one", importedService()]]));
        mocks.showOpenDialog.mockResolvedValue(undefined);

        await mocks.commands.get(APPLY)?.();

        expect(service.importPatch, "no patch chosen must not import").not.toHaveBeenCalled();
        expect(service.unshelve).not.toHaveBeenCalled();
        expect(refresh).not.toHaveBeenCalled();
    });

    it("imports the exact patch, previews files and destination, then applies to the chosen list", async () => {
        const { service } = register(new Map([["/one", importedService()]]));
        mocks.showOpenDialog.mockResolvedValue([{ fsPath: "/tmp/fix.patch" }]);
        pickTarget("D");
        mocks.showInformationMessage.mockImplementationOnce(
            async (_message: string, options: { modal: boolean; detail: string }) => {
                expect(options.modal, "preview must be modal").toBe(true);
                expect(options.detail).toContain("src/a.ts");
                expect(options.detail).toContain("src/b.ts");
                expect(
                    service.unshelve,
                    "preview must come before any apply",
                ).not.toHaveBeenCalled();
                return "Apply Patch";
            },
        );

        await mocks.commands.get(APPLY)?.();

        expect(service.importPatch).toHaveBeenCalledWith({ fileUris: ["/tmp/fix.patch"] });
        expect(service.unshelve).toHaveBeenCalledWith({
            id: "imported",
            expectedShelfGeneration: 1,
            removeFromShelf: true,
            mode: "flattened",
            targetOperation: {
                id: expect.stringMatching(UUID),
                root: "/one",
                target: { kind: "existing", id: "list-d", revision: 7 },
                sourceChecksum: CHECKSUM,
            },
        });
        expect(mocks.showInformationMessage).toHaveBeenCalledWith("Shelf unshelved.");
    });

    it.each([
        ["destination", () => pickTarget(undefined)],
        [
            "preview",
            () => {
                pickTarget("D");
                mocks.showInformationMessage.mockResolvedValueOnce(undefined);
            },
        ],
    ] as const)(
        "cancel at the %s after the durable import reports the import separately",
        async (_step, answer) => {
            const { service, refresh } = register(new Map([["/one", importedService()]]));
            mocks.showOpenDialog.mockResolvedValue([{ fsPath: "/tmp/fix.patch" }]);
            answer();

            await mocks.commands.get(APPLY)?.();

            expect(service.importPatch).toHaveBeenCalledOnce();
            expect(
                service.unshelve,
                "a cancelled apply must run zero Git commands",
            ).not.toHaveBeenCalled();
            expect(
                mocks.showInformationMessage,
                "the durable import must be reported",
            ).toHaveBeenCalledWith(IMPORTED_NOTICE);
            expect(mocks.showInformationMessage).not.toHaveBeenCalledWith("Shelf unshelved.");
            expect(refresh, "the new shelf must appear in the Shelf tab").toHaveBeenCalledOnce();
        },
    );

    it("repository switch during the prompts cannot redirect the apply", async () => {
        const one = importedService("/one");
        const two = importedService("/two");
        const { repositories } = register(
            new Map([
                ["/one", one],
                ["/two", two],
            ]),
        );
        mocks.showQuickPick.mockImplementationOnce(
            async (items: { repository: { root: string } }[]) =>
                items.find((item) => item.repository.root === "/one"),
        );
        mocks.showOpenDialog.mockResolvedValue([{ fsPath: "/tmp/fix.patch" }]);
        mocks.showQuickPick.mockImplementationOnce(async (items: { label: string }[]) => {
            repositories.current = [{ root: "/two", label: "Two" }];
            return items.find((item) => item.label === "D");
        });
        mocks.showInformationMessage.mockResolvedValueOnce("Apply Patch");

        await mocks.commands.get(APPLY)?.();

        expect(two.importPatch).not.toHaveBeenCalled();
        expect(
            two.unshelve,
            "a later active repository must never receive the patch",
        ).not.toHaveBeenCalled();
        expect(one.unshelve).toHaveBeenCalledWith(
            expect.objectContaining({ targetOperation: expect.objectContaining({ root: "/one" }) }),
        );
    });

    it("an invalid patch fails the import and never prompts for a destination", async () => {
        const { service } = register(new Map([["/one", importedService()]]));
        service.importPatch.mockRejectedValueOnce(new Error("hostile path"));
        mocks.showOpenDialog.mockResolvedValue([{ fsPath: "/tmp/bad.patch" }]);

        await mocks.commands.get(APPLY)?.();

        expect(mocks.showQuickPick).not.toHaveBeenCalled();
        expect(service.unshelve).not.toHaveBeenCalled();
        expect(mocks.showErrorMessage).toHaveBeenCalledWith("Import patch failed: hostile path");
    });

    it("reports a non-applied outcome distinctly after the import", async () => {
        const { service } = register(new Map([["/one", importedService()]]));
        service.unshelve.mockResolvedValue(targetResult("conflicted"));
        mocks.showOpenDialog.mockResolvedValue([{ fsPath: "/tmp/fix.patch" }]);
        pickTarget("D");
        mocks.showInformationMessage.mockResolvedValueOnce("Apply Patch");

        await mocks.commands.get(APPLY)?.();

        expect(mocks.showWarningMessage).toHaveBeenCalledWith(
            "Unshelve stopped with conflicts. Resolve them from the Shelf tab.",
        );
        expect(mocks.showInformationMessage).not.toHaveBeenCalledWith("Shelf unshelved.");
    });

    it("keeps Import Patches import-only", async () => {
        const { service } = register(new Map([["/one", importedService()]]));
        mocks.showOpenDialog.mockResolvedValue([{ fsPath: "/tmp/fix.patch" }]);

        await mocks.commands.get("intelligit.importPatch")?.();

        expect(service.importPatch).toHaveBeenCalledWith({ fileUris: ["/tmp/fix.patch"] });
        expect(mocks.showQuickPick).not.toHaveBeenCalled();
        expect(service.unshelve).not.toHaveBeenCalled();
        expect(mocks.showInformationMessage).toHaveBeenCalledWith("Patch imported to shelf.");
    });
});
