import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
    const commands = new Map<string, (...args: unknown[]) => unknown>();
    return {
        commands,
        registerCommand: vi.fn((id: string, handler: (...args: unknown[]) => unknown) => {
            commands.set(id, handler);
            return { dispose: vi.fn() };
        }),
        showQuickPick: vi.fn(),
        showInformationMessage: vi.fn(),
        showErrorMessage: vi.fn(),
    };
});

vi.mock("vscode", () => ({
    commands: { registerCommand: mocks.registerCommand },
    l10n: { t: (message: string) => message },
    window: {
        showQuickPick: mocks.showQuickPick,
        showInformationMessage: mocks.showInformationMessage,
        showErrorMessage: mocks.showErrorMessage,
    },
    workspace: { getConfiguration: vi.fn() },
}));

import * as vscode from "vscode";
import { registerShelfCommands } from "../../../src/activation/shelfCommands";

describe("unshelve palette configuration", () => {
    beforeEach(() => {
        mocks.commands.clear();
        vi.clearAllMocks();
    });

    it.each([true, false])("reads removeOnUnshelve fresh as %s", async (removeFromShelf) => {
        const service = {
            repositoryRoot: "/repo",
            listShelves: vi.fn(async () => ({
                shelves: [
                    { id: "one", generation: 1, metadata: { name: "One", lifecycle: "shelved" } },
                ],
            })),
            getShelfManifest: vi.fn(async () => ({
                generation: 1,
                checksum: "c".repeat(64),
                metadata: { name: "One", lifecycle: "shelved" },
                files: [],
            })),
            unshelve: vi.fn(async () => ({ status: "applied", entries: [], operationId: "x" })),
        };
        vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
            get: vi.fn(() => removeFromShelf),
        } as never);
        mocks.showQuickPick.mockResolvedValueOnce({
            label: "One",
            shelf: (await service.listShelves()).shelves[0],
        });
        mocks.showQuickPick.mockImplementationOnce(async (items: unknown[]) => items[0]);
        registerShelfCommands({
            context: { subscriptions: [] } as never,
            getRepositories: () => [{ root: "/repo", label: "Repo" }],
            shelfServiceForRepository: () => service as never,
            changelists: {
                get: () => ({
                    revision: 1,
                    activeId: "a",
                    lists: [{ id: "a", name: "A", description: "", draft: "" }],
                    allDraft: "",
                    files: {},
                    changes: {},
                }),
                settled: async () => undefined,
                holdObservers: async () => () => undefined,
            } as never,
            refreshAfterMutation: async () => undefined,
        });

        await mocks.commands.get("intelligit.unshelve")?.();

        expect(service.unshelve).toHaveBeenCalledWith(expect.objectContaining({ removeFromShelf }));
    });
});
