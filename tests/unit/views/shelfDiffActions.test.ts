import { beforeEach, describe, expect, it, vi } from "vitest";

const vscodeMock = vi.hoisted(() => ({
    commands: { executeCommand: vi.fn(async () => undefined) },
    Uri: {
        joinPath: vi.fn((root: { scheme?: string; path?: string }, path: string) => ({
            root,
            path,
            toString: () => `${root.scheme ?? "file"}://${root.path ?? ""}/${path}`,
        })),
    },
    workspace: {
        fs: { stat: vi.fn(async () => undefined) },
        openTextDocument: vi.fn(async () => ({ getText: () => "local file contents" })),
        textDocuments: [],
    },
}));
const createReadonlyDiffUri = vi.hoisted(() =>
    vi.fn((filePath: string, content: string, ref: string) => ({ filePath, content, ref })),
);

vi.mock("vscode", () => vscodeMock);
vi.mock("../../../src/services/diffService", () => ({ createReadonlyDiffUri }));

import { showShelfDiffFromPanel, type ShelfDiffReader } from "../../../src/views/shelfDiffActions";
import type { ShelfFileEntry } from "../../../src/shelf/model";

const shelfFiles = [
    {
        changeId: "change-1",
        worktreeBlock: { path: "src/a.ts", status: "M" },
        binary: false,
        untracked: false,
        baseAvailability: "full",
        exactReconstruction: true,
        lifecycle: "shelved",
    },
] as ShelfFileEntry[];

function reader(overrides: Partial<ShelfDiffReader> = {}): ShelfDiffReader {
    return {
        getShelfFiles: vi.fn(async () => shelfFiles),
        getShelfDiffContents: vi.fn(async () => ({
            path: "src/a.ts",
            binary: false,
            base: Buffer.from("base contents"),
            shelved: Buffer.from("shelved contents"),
        })),
        ...overrides,
    };
}

function deps(source: ShelfDiffReader) {
    return { shelfReader: source, getWorkspaceRoot: () => ({ scheme: "file", path: "/repo" }) };
}

describe("showShelfDiffFromPanel", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vscodeMock.workspace.textDocuments = [];
        vi.mocked(vscodeMock.workspace.fs.stat).mockResolvedValue(undefined);
        vi.mocked(vscodeMock.workspace.openTextDocument).mockResolvedValue({
            getText: () => "local file contents",
        });
    });

    it("shows the immutable base-to-shelved view with exact side labels", async () => {
        const source = reader();

        await showShelfDiffFromPanel(deps(source), "shelf-1", "change-1", "baseToShelved");

        expect(createReadonlyDiffUri).toHaveBeenCalledWith(
            "src/a.ts",
            "base contents",
            "Base (HEAD at shelve)",
        );
        expect(createReadonlyDiffUri).toHaveBeenCalledWith("src/a.ts", "shelved contents", "Shelved");
        expect(vscodeMock.workspace.openTextDocument).not.toHaveBeenCalled();
        expect(vscodeMock.commands.executeCommand).toHaveBeenCalledWith(
            "vscode.diff",
            { filePath: "src/a.ts", content: "base contents", ref: "Base (HEAD at shelve)" },
            { filePath: "src/a.ts", content: "shelved contents", ref: "Shelved" },
            "src/a.ts (Base (HEAD at shelve) <-> Shelved)",
        );
    });

    it("opens a selected shelf diff in a non-preview editor tab when requested", async () => {
        const source = reader();

        await showShelfDiffFromPanel(deps(source), "shelf-1", "change-1", "baseToShelved", true);

        expect(vscodeMock.commands.executeCommand).toHaveBeenCalledWith(
            "vscode.diff",
            { filePath: "src/a.ts", content: "base contents", ref: "Base (HEAD at shelve)" },
            { filePath: "src/a.ts", content: "shelved contents", ref: "Shelved" },
            "src/a.ts (Base (HEAD at shelve) <-> Shelved)",
            { preview: false },
        );
    });

    it("uses an explicit unavailable-base document instead of current file history", async () => {
        const source = reader({
            getShelfDiffContents: vi.fn(async () => ({
                path: "src/a.ts",
                binary: false,
                base: undefined,
                shelved: Buffer.from("shelved contents"),
            })),
        });

        await showShelfDiffFromPanel(deps(source), "shelf-1", "change-1", "baseToShelved");

        expect(createReadonlyDiffUri).toHaveBeenCalledWith(
            "src/a.ts",
            "Base content is unavailable for this shelf entry.",
            "Base unavailable",
        );
        expect(createReadonlyDiffUri).not.toHaveBeenCalledWith(
            "src/a.ts",
            "local file contents",
            expect.any(String),
        );
        expect(vscodeMock.workspace.openTextDocument).not.toHaveBeenCalled();
    });

    it.each([
        ["baseToShelved", "Base (HEAD at shelve)", "Shelved"],
        ["shelvedToLocal", "Shelved", "Local"],
    ] as const)("shows a placeholder on both sides for binary shelf entries without decoding bytes", async (
        mode,
        leftLabel,
        rightLabel,
    ) => {
        const base = Buffer.from([0, 255]);
        const shelved = Buffer.from([255, 0]);
        const source = reader({
            getShelfDiffContents: vi.fn(async () => ({
                path: "images/logo.png",
                binary: true,
                base,
                shelved,
            })),
        });
        const baseToString = vi.spyOn(base, "toString");
        const shelvedToString = vi.spyOn(shelved, "toString");

        await showShelfDiffFromPanel(deps(source), "shelf-1", "change-1", mode);

        expect(createReadonlyDiffUri).toHaveBeenNthCalledWith(
            1,
            "images/logo.png",
            "Binary file — text diff is unavailable.",
            leftLabel,
        );
        expect(createReadonlyDiffUri).toHaveBeenNthCalledWith(
            2,
            "images/logo.png",
            "Binary file — text diff is unavailable.",
            rightLabel,
        );
        expect(baseToString).not.toHaveBeenCalled();
        expect(shelvedToString).not.toHaveBeenCalled();
        expect(vscodeMock.workspace.openTextDocument).not.toHaveBeenCalled();
    });

    it("compares shelved content with the current local file using read-only documents", async () => {
        const source = reader();

        await showShelfDiffFromPanel(deps(source), "shelf-1", "change-1", "shelvedToLocal");

        expect(createReadonlyDiffUri).toHaveBeenCalledWith("src/a.ts", "shelved contents", "Shelved");
        expect(createReadonlyDiffUri).toHaveBeenCalledWith(
            "src/a.ts",
            "local file contents",
            "Local",
        );
        expect(vscodeMock.commands.executeCommand).toHaveBeenCalledWith(
            "vscode.diff",
            { filePath: "src/a.ts", content: "shelved contents", ref: "Shelved" },
            { filePath: "src/a.ts", content: "local file contents", ref: "Local" },
            "src/a.ts (Shelved <-> Local)",
        );
    });

    it("opens one pinned whole-shelf changes session when requested", async () => {
        const source = reader({
            getShelfFiles: vi.fn(async () => [
                ...shelfFiles,
                {
                    ...shelfFiles[0],
                    changeId: "change-2",
                    worktreeBlock: { path: "src/b.ts", status: "M" as const },
                },
            ]),
            getShelfDiffContents: vi.fn(async (_id, changeId) => ({
                path: changeId === "change-1" ? "src/a.ts" : "src/b.ts",
                binary: false,
                base: Buffer.from("base"),
                shelved: Buffer.from("shelved"),
            })),
        });

        await showShelfDiffFromPanel(deps(source), "shelf-1", undefined, "baseToShelved", true);

        expect(vscodeMock.commands.executeCommand).toHaveBeenCalledTimes(2);
        expect(vscodeMock.commands.executeCommand).toHaveBeenNthCalledWith(
            1,
            "vscode.changes",
            "Shelf shelf-1",
            expect.arrayContaining([
                [
                    { filePath: "src/a.ts", content: "base", ref: "Base (HEAD at shelve)" },
                    { filePath: "src/a.ts", content: "base", ref: "Base (HEAD at shelve)" },
                    { filePath: "src/a.ts", content: "shelved", ref: "Shelved" },
                ],
                [
                    { filePath: "src/b.ts", content: "base", ref: "Base (HEAD at shelve)" },
                    { filePath: "src/b.ts", content: "base", ref: "Base (HEAD at shelve)" },
                    { filePath: "src/b.ts", content: "shelved", ref: "Shelved" },
                ],
            ]),
        );
        expect(vscodeMock.commands.executeCommand).toHaveBeenNthCalledWith(
            2,
            "workbench.action.keepEditor",
        );
    });

    it("opens a whole-shelf changes session with every shelf entry", async () => {
        const source = reader({
            getShelfFiles: vi.fn(async () => [
                ...shelfFiles,
                { ...shelfFiles[0], changeId: "change-2", worktreeBlock: { path: "src/b.ts", status: "M" } },
            ]),
            getShelfDiffContents: vi.fn(async (_id, changeId) => ({
                path: changeId === "change-1" ? "src/a.ts" : "src/b.ts",
                binary: false,
                base: Buffer.from("base"),
                shelved: Buffer.from("shelved"),
            })),
        });

        await showShelfDiffFromPanel(deps(source), "shelf-1", undefined, "baseToShelved");

        expect(vscodeMock.commands.executeCommand).toHaveBeenCalledWith(
            "vscode.changes",
            "Shelf shelf-1",
            expect.arrayContaining([
                [
                    { filePath: "src/a.ts", content: "base", ref: "Base (HEAD at shelve)" },
                    { filePath: "src/a.ts", content: "base", ref: "Base (HEAD at shelve)" },
                    { filePath: "src/a.ts", content: "shelved", ref: "Shelved" },
                ],
                [
                    { filePath: "src/b.ts", content: "base", ref: "Base (HEAD at shelve)" },
                    { filePath: "src/b.ts", content: "base", ref: "Base (HEAD at shelve)" },
                    { filePath: "src/b.ts", content: "shelved", ref: "Shelved" },
                ],
            ]),
        );
    });
});
