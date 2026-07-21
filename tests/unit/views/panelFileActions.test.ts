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
        workspace: { fs: { stat: vi.fn(async () => ({})) } },
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
        vi.mocked(vscodeMock.workspace.fs.stat).mockResolvedValue({});
    });

    it("opens one stash file from the stashed revision to the current local file", async () => {
        const gitOps = makeGitOps();

        await showStashDiffFromPanel(fileActionDeps(gitOps), 2, "src/a.ts", false);

        expect(gitOps.getStashFileContents).toHaveBeenCalledWith(2, "src/a.ts");
        expect(createReadonlyDiffUri).toHaveBeenCalledWith("src/a.ts", "stash", "stash@{2}");
        expect(createReadonlyDiffUri).not.toHaveBeenCalledWith(
            "src/a.ts",
            "base",
            expect.any(String),
        );
        expect(vscodeMock.commands.executeCommand).toHaveBeenCalledWith(
            "vscode.diff",
            { filePath: "src/a.ts", content: "stash", ref: "stash@{2}" },
            { root: { scheme: "file", path: "/repo" }, path: "src/a.ts" },
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
            { root: { scheme: "file", path: "/repo" }, path: "src/a.ts" },
            "src/a.ts (Stashed: stash@{2}) <-> Local File",
            { preview: true },
        );
    });

    it("uses an explicitly labeled empty virtual document only when the local file is missing", async () => {
        const gitOps = makeGitOps();
        vi.mocked(vscodeMock.workspace.fs.stat).mockRejectedValueOnce({ code: "FileNotFound" });

        await showStashDiffFromPanel(fileActionDeps(gitOps), 2, "src/a.ts");

        expect(vscodeMock.commands.executeCommand).toHaveBeenCalledWith(
            "vscode.diff",
            { filePath: "src/a.ts", content: "stash", ref: "stash@{2}" },
            { filePath: "src/a.ts", content: "", ref: "Empty local file (missing)" },
            "src/a.ts (Stashed: stash@{2}) <-> Local File",
            { preview: true },
        );
    });

    it("propagates unrelated local-file errors", async () => {
        const gitOps = makeGitOps();
        const permissionError = new vscodeMock.FileSystemError("Permission denied", "NoPermissions");
        vi.mocked(vscodeMock.workspace.fs.stat).mockRejectedValueOnce(permissionError);

        await expect(
            showStashDiffFromPanel(fileActionDeps(gitOps), 2, "src/a.ts"),
        ).rejects.toBe(permissionError);
        expect(vscodeMock.commands.executeCommand).not.toHaveBeenCalled();
    });

    it("opens every stash file in VS Code changes and keeps only a new tab", async () => {
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
                    { filePath: "src/a.ts", content: "stash", ref: "stash@{2}" },
                    { filePath: "src/a.ts", content: "base", ref: "stash@{2}^1" },
                    { filePath: "src/a.ts", content: "stash", ref: "stash@{2}" },
                ],
                [
                    { filePath: "new.txt", content: "new", ref: "stash@{2}" },
                    undefined,
                    { filePath: "new.txt", content: "new", ref: "stash@{2}" },
                ],
            ],
        );
        expect(vscodeMock.commands.executeCommand).toHaveBeenCalledWith(
            "workbench.action.keepEditor",
        );
    });
});
