import { beforeEach, describe, expect, it, vi } from "vitest";

const vscodeMock = vi.hoisted(() => ({
    commands: { executeCommand: vi.fn(async () => undefined) },
}));
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

describe("showStashDiffFromPanel", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("opens one stash file with real before/after resources and requested preview state", async () => {
        const gitOps = makeGitOps();

        await showStashDiffFromPanel({ gitOps }, 2, "src/a.ts", false);

        expect(gitOps.getStashFileContents).toHaveBeenCalledWith(2, "src/a.ts");
        expect(vscodeMock.commands.executeCommand).toHaveBeenCalledWith(
            "vscode.diff",
            { filePath: "src/a.ts", content: "base", ref: "stash@{2}^1" },
            { filePath: "src/a.ts", content: "stash", ref: "stash@{2}" },
            "src/a.ts (stash@{2})",
            { preview: false },
        );
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

        const showDiff = showStashDiffFromPanel({ gitOps }, 2, undefined, false);

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
