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
}));

import { registerShelfCommands, SHELF_COMMAND_IDS } from "../../../src/activation/shelfCommands";

const successfulMutation = { status: "ok" as const, entries: [] };

const makeService = () => ({
    shelve: vi.fn(async () => successfulMutation),
    unshelve: vi.fn(async () => successfulMutation),
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

const register = (services = new Map([["/one", makeService()]])) => {
    const refresh = vi.fn(async () => undefined);
    registerShelfCommands({
        context: { subscriptions: [] } as never,
        getRepositories: () =>
            [...services.keys()].map((root) => ({ root, label: root === "/one" ? "One" : "Two" })),
        shelfServiceForRepository: (root) => services.get(root) as never,
        refreshAfterMutation: refresh,
    });
    return { refresh, service: services.get("/one")! };
};

describe("registerShelfCommands", () => {
    beforeEach(() => {
        mocks.commands.clear();
        vi.clearAllMocks();
    });

    it("registers the seven direct shelf command-palette IDs", () => {
        register();
        expect([...mocks.commands.keys()]).toEqual([...SHELF_COMMAND_IDS]);
    });

    it("shelves all changes, saves locally, imports host-selected patches, and unshelves the newest live shelf", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-07-23T10:11:12Z"));
        const { refresh, service } = register();
        mocks.showInputBox.mockResolvedValue("Prompted shelf");
        mocks.showOpenDialog.mockResolvedValue([{ fsPath: "/tmp/one.patch" }]);
        mocks.showQuickPick.mockResolvedValueOnce({
            label: "New",
            shelf: { id: "new", generation: 2, metadata: { name: "New", lifecycle: "shelved" } },
        });
        mocks.showWarningMessage.mockResolvedValue("Purge Shelf Recovery");

        await mocks.commands.get("intelligit.shelveChanges")?.();
        await mocks.commands.get("intelligit.shelveSilently")?.();
        await mocks.commands.get("intelligit.saveToShelf")?.();
        await mocks.commands.get("intelligit.importPatch")?.();
        await mocks.commands.get("intelligit.unshelve")?.();
        await mocks.commands.get("intelligit.purgeShelfRecovery")?.();

        const defaultName = mocks.showInputBox.mock.calls[0]?.[0]?.value;
        expect(defaultName).toMatch(/^Uncommitted changes \[/);
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
