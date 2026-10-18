import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const notice = vi.hoisted(() => vi.fn());
const clipboard = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("vscode", () => ({
    env: { clipboard: { writeText: clipboard } },
    l10n: { t: (message: string) => message },
    window: { showInformationMessage: notice, showWarningMessage: vi.fn() },
    commands: { executeCommand: vi.fn() },
}));

import { executeShelfMutationRequest } from "../../../src/views/commitPanelActions";

import { removeScratchDirectories } from "../../helpers/scratchDirectories";

const directories: string[] = [];
beforeEach(() => vi.clearAllMocks());
afterEach(async () => {
    await Promise.all(
        directories.splice(0).map((directory) => removeScratchDirectories(directory)),
    );
});

describe("plain patch export boundary", () => {
    it.each([
        ["shelfExportPatch", true],
        ["shelfExportPatch", false],
        ["shelfCopyPatchToClipboard", true],
        ["shelfCopyPatchToClipboard", false],
    ] as const)(
        "%s keeps shelf provenance and requires its content-only notice: accepted=%s",
        async (type, accepted) => {
            const directory = await mkdtemp(path.join(tmpdir(), "shelf-export-notice-"));
            directories.push(directory);
            const destination = path.join(directory, "changes.patch");
            await writeFile(destination, "existing destination");
            const manifest = {
                generation: 7,
                checksum: "a".repeat(64),
                metadata: {
                    name: "saved",
                    selection: {
                        version: 1,
                        sourceLists: [{ id: "one", name: "名前", draft: "private draft" }],
                    },
                },
                files: [{ changeId: "change-one" }],
            };
            const before = structuredClone(manifest);
            const readSnapshot = vi.fn(async () => manifest);
            const exportPatch = vi.fn(async () => Buffer.from("exact plain patch\n"));
            const listShelves = vi.fn(async () => ({
                catalogGeneration: 1,
                shelves: [{ id: "saved", ...manifest }],
                shelfIds: ["saved"],
                corruptShelfIds: [],
            }));
            const refreshData = vi.fn(async () => undefined);
            const changed = vi.fn();
            const completed = vi.fn();
            const action = type === "shelfExportPatch" ? "Export Patch" : "Copy Patch";
            notice.mockResolvedValueOnce(accepted ? action : undefined);
            await executeShelfMutationRequest(
                {
                    shelfService: {
                        repositoryRoot: directory,
                        getShelfManifest: readSnapshot,
                        exportPatch,
                        listShelves,
                        getShelfFiles: async () => manifest.files,
                    },
                    refreshData,
                    fireWorkingTreeChanged: changed,
                    selectExportDestination: async () => destination,
                } as never,
                {
                    type,
                    requestId: "export-1",
                    shelfId: "saved",
                    expectedGeneration: 7,
                    changeIds: ["change-one"],
                },
                completed,
            );
            expect(notice).toHaveBeenCalledWith(
                "Plain patches include file changes only. Changelist names and draft messages stay in the shelf.",
                { modal: true },
                action,
            );
            expect(manifest).toEqual(before);
            expect(listShelves).not.toHaveBeenCalled();
            expect(refreshData).not.toHaveBeenCalled();
            expect(changed).not.toHaveBeenCalled();
            expect(completed).toHaveBeenCalledTimes(1);
            expect(completed).toHaveBeenCalledWith(
                expect.objectContaining({ requestId: "export-1", status: "ok" }),
            );
            if (accepted)
                expect(exportPatch).toHaveBeenCalledWith({
                    id: "saved",
                    changeIds: ["change-one"],
                    expectedShelfGeneration: 7,
                    expectedShelfChecksum: before.checksum,
                });
            else expect(exportPatch).not.toHaveBeenCalled();
            expect(await readFile(destination, "utf8")).toBe(
                accepted && type === "shelfExportPatch"
                    ? "exact plain patch\n"
                    : "existing destination",
            );
            if (accepted && type === "shelfCopyPatchToClipboard")
                expect(clipboard).toHaveBeenCalledWith("exact plain patch\n");
            else expect(clipboard).not.toHaveBeenCalled();
        },
    );

    it("legacy content-only shelves need no provenance confirmation", async () => {
        const exportPatch = vi.fn(async () => Buffer.from("legacy patch"));
        await executeShelfMutationRequest(
            {
                shelfService: {
                    getShelfManifest: async () => ({
                        generation: 2,
                        checksum: "b".repeat(64),
                        metadata: { name: "legacy" },
                        files: [],
                    }),
                    exportPatch,
                    listShelves: async () => ({
                        catalogGeneration: 1,
                        shelves: [{ id: "legacy", generation: 2 }],
                    }),
                },
                refreshData: async () => undefined,
                fireWorkingTreeChanged: vi.fn(),
            } as never,
            {
                type: "shelfCopyPatchToClipboard",
                requestId: "legacy",
                shelfId: "legacy",
                expectedGeneration: 2,
            },
            vi.fn(),
        );
        expect(notice).not.toHaveBeenCalled();
        expect(clipboard).toHaveBeenCalledWith("legacy patch");
    });

    it("stale source generation refuses before the notice or any export", async () => {
        const exportPatch = vi.fn(async () => Buffer.from("stale patch"));
        const completed = vi.fn();
        await expect(
            executeShelfMutationRequest(
                {
                    shelfService: {
                        getShelfManifest: async () => ({
                            generation: 3,
                            checksum: "b".repeat(64),
                            metadata: { selection: {} },
                            files: [],
                        }),
                        exportPatch,
                        listShelves: async () => ({
                            catalogGeneration: 1,
                            shelves: [{ id: "saved", generation: 3 }],
                        }),
                    },
                    refreshData: async () => undefined,
                    fireWorkingTreeChanged: vi.fn(),
                } as never,
                {
                    type: "shelfCopyPatchToClipboard",
                    requestId: "stale",
                    shelfId: "saved",
                    expectedGeneration: 2,
                },
                completed,
            ),
        ).rejects.toThrow("stale");
        expect(notice).not.toHaveBeenCalled();
        expect(exportPatch).not.toHaveBeenCalled();
        expect(clipboard).not.toHaveBeenCalled();
        expect(completed).toHaveBeenCalledWith(expect.objectContaining({ status: "staleShelf" }));
    });
});
