import { beforeEach, describe, expect, it, vi } from "vitest";

const vscodeMock = vi.hoisted(() => {
    class FileSystemError extends Error {
        constructor(
            message: string,
            readonly code: string,
        ) {
            super(message);
        }
    }

    return {
        commands: { executeCommand: vi.fn(async () => undefined) },
        FileSystemError,
        Uri: { joinPath: vi.fn((root: unknown, path: string) => ({ root, path })) },
        l10n: {
            t: vi.fn((message: string, values?: Record<string, string>) =>
                message.replace(/\{(\w+)\}/g, (match, key: string) => values?.[key] ?? match),
            ),
        },
        workspace: {
            openTextDocument: vi.fn(async () => ({ getText: () => "local file contents" })),
        },
    };
});
const createReadonlyDiffUri = vi.hoisted(() =>
    vi.fn((filePath: string, content: string, ref: string) => ({ filePath, content, ref })),
);

vi.mock("vscode", () => vscodeMock);
vi.mock("../../../src/services/diffService", () => ({ createReadonlyDiffUri }));

import { showStashDiffFromPanel } from "../../../src/views/panelFileActions";
import type { GitOps } from "../../../src/git/operations";

function makeGitOps(): GitOps {
    return {
        getStashFileContents: vi.fn(async () => ({ before: "base", after: "stash" })),
        getStashFiles: vi.fn(async () => [
            { path: "src/a.ts", status: "M", staged: false, additions: 1, deletions: 1 },
            { path: "new.txt", status: "?", staged: false, additions: 1, deletions: 0 },
        ]),
    } as unknown as GitOps;
}

function fileActionDeps(gitOps: GitOps) {
    return { gitOps, getWorkspaceRoot: () => ({ scheme: "file", path: "/repo" }) };
}

describe("showStashDiffFromPanel", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(vscodeMock.workspace.openTextDocument).mockResolvedValue({
            getText: () => "local file contents",
        });
    });

    it("opens one stash file from the stashed revision to the current local file", async () => {
        const gitOps = makeGitOps();

        await showStashDiffFromPanel(fileActionDeps(gitOps), 2, "src/a.ts", false);

        expect(gitOps.getStashFileContents).toHaveBeenCalledWith(2, "src/a.ts");
        expect(createReadonlyDiffUri).toHaveBeenCalledWith(
            "src/a.ts",
            "stash",
            "Stashed: stash@{2}",
        );
        expect(createReadonlyDiffUri).toHaveBeenCalledWith(
            "src/a.ts",
            "local file contents",
            "Local File",
        );
        expect(createReadonlyDiffUri).not.toHaveBeenCalledWith(
            "src/a.ts",
            "base",
            expect.any(String),
        );
        expect(vscodeMock.workspace.openTextDocument).toHaveBeenCalledWith({
            root: { scheme: "file", path: "/repo" },
            path: "src/a.ts",
        });
        expect(vscodeMock.commands.executeCommand).toHaveBeenCalledWith(
            "vscode.diff",
            { filePath: "src/a.ts", content: "stash", ref: "Stashed: stash@{2}" },
            { filePath: "src/a.ts", content: "local file contents", ref: "Local File" },
            "src/a.ts (Stashed: stash@{2}) <-> Local File",
            { preview: false },
        );
    });

    it("uses an explicitly labeled empty virtual document when the stashed side is absent", async () => {
        const gitOps = makeGitOps();
        vi.mocked(gitOps.getStashFileContents).mockResolvedValueOnce({
            before: "must not be used",
            after: undefined,
        });

        await showStashDiffFromPanel(fileActionDeps(gitOps), 2, "src/a.ts");

        expect(vscodeMock.commands.executeCommand).toHaveBeenCalledWith(
            "vscode.diff",
            {
                filePath: "src/a.ts",
                content: "",
                ref: "Empty stashed file (missing: stash@{2})",
            },
            { filePath: "src/a.ts", content: "local file contents", ref: "Local File" },
            "src/a.ts (Stashed: stash@{2}) <-> Local File",
            { preview: true },
        );
    });

    it("uses an explicitly labeled empty virtual document only when the local file is missing", async () => {
        const gitOps = makeGitOps();
        vi.mocked(vscodeMock.workspace.openTextDocument).mockRejectedValueOnce({
            code: "FileNotFound",
        });

        await showStashDiffFromPanel(fileActionDeps(gitOps), 2, "src/a.ts");

        expect(vscodeMock.commands.executeCommand).toHaveBeenCalledWith(
            "vscode.diff",
            { filePath: "src/a.ts", content: "stash", ref: "Stashed: stash@{2}" },
            { filePath: "src/a.ts", content: "", ref: "Empty local file (missing)" },
            "src/a.ts (Stashed: stash@{2}) <-> Local File",
            { preview: true },
        );
    });

    it("propagates unrelated local-file errors", async () => {
        const gitOps = makeGitOps();
        const permissionError = new vscodeMock.FileSystemError(
            "Permission denied",
            "NoPermissions",
        );
        vi.mocked(vscodeMock.workspace.openTextDocument).mockRejectedValueOnce(permissionError);

        await expect(showStashDiffFromPanel(fileActionDeps(gitOps), 2, "src/a.ts")).rejects.toBe(
            permissionError,
        );
        expect(vscodeMock.commands.executeCommand).not.toHaveBeenCalled();
    });

    it("opens every stash file from its snapshot to the current local document and keeps only a new tab", async () => {
        const gitOps = makeGitOps();
        const started: string[] = [];
        const resolvers = new Map<
            string,
            (contents: { before: string | undefined; after: string | undefined }) => void
        >();
        vi.mocked(gitOps.getStashFileContents).mockImplementation(
            async (_index, filePath) =>
                new Promise((resolve) => {
                    started.push(filePath);
                    resolvers.set(filePath, resolve);
                }),
        );

        const showDiff = showStashDiffFromPanel(fileActionDeps(gitOps), 2, undefined, false);

        await vi.waitFor(() => expect(started).toEqual(["src/a.ts", "new.txt"]));
        resolvers.get("new.txt")?.({ before: undefined, after: "new" });
        resolvers.get("src/a.ts")?.({ before: "base", after: "stash" });
        await showDiff;

        expect(gitOps.getStashFiles).toHaveBeenCalledWith(2);
        expect(vscodeMock.commands.executeCommand).toHaveBeenCalledWith(
            "vscode.changes",
            "Stash stash@{2}",
            [
                [
                    { filePath: "src/a.ts", content: "stash", ref: "Stashed: stash@{2}" },
                    { filePath: "src/a.ts", content: "stash", ref: "Stashed: stash@{2}" },
                    { filePath: "src/a.ts", content: "local file contents", ref: "Local File" },
                ],
                [
                    { filePath: "new.txt", content: "new", ref: "Stashed: stash@{2}" },
                    { filePath: "new.txt", content: "new", ref: "Stashed: stash@{2}" },
                    { filePath: "new.txt", content: "local file contents", ref: "Local File" },
                ],
            ],
        );
        expect(vscodeMock.commands.executeCommand).toHaveBeenCalledWith(
            "workbench.action.keepEditor",
        );
    });

    it("uses labeled empty documents for missing stash and local sides in stash-wide diffs", async () => {
        const gitOps = makeGitOps();
        vi.mocked(gitOps.getStashFiles).mockResolvedValueOnce([
            { path: "gone.txt", status: "D", staged: false, additions: 0, deletions: 1 },
        ]);
        vi.mocked(gitOps.getStashFileContents).mockResolvedValueOnce({
            before: "must not be used",
            after: undefined,
        });
        vi.mocked(vscodeMock.workspace.openTextDocument).mockRejectedValueOnce({
            code: "FileNotFound",
        });

        await showStashDiffFromPanel(fileActionDeps(gitOps), 2, undefined);

        expect(vscodeMock.commands.executeCommand).toHaveBeenCalledWith(
            "vscode.changes",
            "Stash stash@{2}",
            [
                [
                    {
                        filePath: "gone.txt",
                        content: "",
                        ref: "Empty stashed file (missing: stash@{2})",
                    },
                    {
                        filePath: "gone.txt",
                        content: "",
                        ref: "Empty stashed file (missing: stash@{2})",
                    },
                    { filePath: "gone.txt", content: "", ref: "Empty local file (missing)" },
                ],
            ],
        );
        expect(vscodeMock.commands.executeCommand).not.toHaveBeenCalledWith(
            "workbench.action.keepEditor",
        );
    });

    it("uses dirty local document text for stash-wide diffs", async () => {
        const gitOps = makeGitOps();
        vi.mocked(gitOps.getStashFiles).mockResolvedValueOnce([
            { path: "src/a.ts", status: "M", staged: false, additions: 1, deletions: 1 },
        ]);
        vi.mocked(vscodeMock.workspace.openTextDocument).mockResolvedValueOnce({
            getText: () => "unsaved local content",
        });

        await showStashDiffFromPanel(fileActionDeps(gitOps), 2, undefined);

        expect(vscodeMock.commands.executeCommand).toHaveBeenCalledWith(
            "vscode.changes",
            "Stash stash@{2}",
            [
                [
                    { filePath: "src/a.ts", content: "stash", ref: "Stashed: stash@{2}" },
                    { filePath: "src/a.ts", content: "stash", ref: "Stashed: stash@{2}" },
                    { filePath: "src/a.ts", content: "unsaved local content", ref: "Local File" },
                ],
            ],
        );
        expect(vscodeMock.commands.executeCommand).not.toHaveBeenCalledWith(
            "workbench.action.keepEditor",
        );
    });

    it("propagates unrelated local-file errors without opening stash-wide changes", async () => {
        const gitOps = makeGitOps();
        vi.mocked(gitOps.getStashFiles).mockResolvedValueOnce([
            { path: "src/a.ts", status: "M", staged: false, additions: 1, deletions: 1 },
        ]);
        const permissionError = new vscodeMock.FileSystemError(
            "Permission denied",
            "NoPermissions",
        );
        vi.mocked(vscodeMock.workspace.openTextDocument).mockRejectedValueOnce(permissionError);

        await expect(showStashDiffFromPanel(fileActionDeps(gitOps), 2, undefined)).rejects.toBe(
            permissionError,
        );
        expect(createReadonlyDiffUri).not.toHaveBeenCalled();
        expect(vscodeMock.commands.executeCommand).not.toHaveBeenCalled();
    });

    it("does not register wide diff URIs when a later local read fails", async () => {
        const gitOps = makeGitOps();
        let finishFirstRead!: () => void;
        const firstRead = new Promise<void>((resolve) => {
            finishFirstRead = resolve;
        });
        let rejectSecondRead!: (error: unknown) => void;
        const secondRead = new Promise<never>((_resolve, reject) => {
            rejectSecondRead = reject;
        });
        vi.mocked(vscodeMock.workspace.openTextDocument)
            .mockResolvedValueOnce({
                getText: () => {
                    finishFirstRead();
                    return "first local content";
                },
            })
            .mockReturnValueOnce(secondRead);
        const permissionError = new vscodeMock.FileSystemError(
            "Permission denied",
            "NoPermissions",
        );

        const showDiff = showStashDiffFromPanel(fileActionDeps(gitOps), 2, undefined);
        await firstRead;
        rejectSecondRead(permissionError);

        await expect(showDiff).rejects.toBe(permissionError);
        expect(createReadonlyDiffUri).not.toHaveBeenCalled();
        expect(vscodeMock.commands.executeCommand).not.toHaveBeenCalled();
    });
});
