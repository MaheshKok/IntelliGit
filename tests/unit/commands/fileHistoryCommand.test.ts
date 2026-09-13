import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    run: vi.fn(),
    open: vi.fn(),
    error: vi.fn(),
    realpath: vi.fn(async (value: string) => value),
    active: { uri: { scheme: "file", fsPath: "/active/other.txt" } },
}));
vi.mock("node:fs/promises", () => ({ realpath: mocks.realpath }));
vi.mock("vscode", () => ({
    window: {
        get activeTextEditor() {
            return { document: mocks.active };
        },
        showErrorMessage: mocks.error,
    },
    l10n: { t: (value: string) => value },
}));
vi.mock("../../../src/git/executor", () => ({
    GitExecutor: class {
        run = mocks.run;
    },
}));
vi.mock("../../../src/views/FileHistoryPanel", () => ({ FileHistoryPanel: { open: mocks.open } }));
import { showFileHistory } from "../../../src/commands/fileHistoryCommand";
afterEach(() => vi.clearAllMocks());

describe("file history command target", () => {
    it("normalizes a symlinked parent directory without resolving the file itself", async () => {
        mocks.realpath.mockResolvedValueOnce("/private/tmp/repo/src");
        mocks.run.mockResolvedValue("/private/tmp/repo\n");
        await showFileHistory(
            {} as never,
            { scheme: "file", fsPath: "/tmp/repo/src/file.ts" } as never,
        );
        expect(mocks.open).toHaveBeenCalledWith(
            expect.objectContaining({ repoRoot: "/private/tmp/repo", filePath: "src/file.ts" }),
        );
    });
    it("uses the clicked inactive tab URI and its own repository root", async () => {
        mocks.run.mockResolvedValue("/nested/repo\n");
        await showFileHistory(
            {} as never,
            { scheme: "file", fsPath: "/nested/repo/src/file.ts" } as never,
        );
        expect(mocks.open).toHaveBeenCalledWith({
            extensionUri: {},
            repoRoot: "/nested/repo",
            filePath: "src/file.ts",
        });
    });
    it("falls back to active editor only when no explicit URI is supplied", async () => {
        mocks.run.mockResolvedValue("/active\n");
        await showFileHistory({} as never);
        expect(mocks.open).toHaveBeenCalledWith(
            expect.objectContaining({ repoRoot: "/active", filePath: "other.txt" }),
        );
    });
    it("rejects an explicit unsupported URI instead of opening active editor history", async () => {
        await showFileHistory({} as never, { scheme: "untitled", fsPath: "scratch" } as never);
        expect(mocks.run).not.toHaveBeenCalled();
        expect(mocks.open).not.toHaveBeenCalled();
        expect(mocks.error).toHaveBeenCalled();
    });
});
