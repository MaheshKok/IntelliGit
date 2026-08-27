import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    loadDiffSide: vi.fn(),
    openEditableDiffEditor: vi.fn(),
    executeCommand: vi.fn(),
    logGitOpsWarning: vi.fn(),
    trackDiffTab: vi.fn(async () => undefined),
}));

vi.mock("vscode", () => ({ commands: { executeCommand: mocks.executeCommand } }));
vi.mock("../../../src/diff/sideLoader", () => ({
    loadDiffSide: mocks.loadDiffSide,
    toViewerSide: (side: { status: string }) =>
        side.status === "missing"
            ? { status: "loaded", text: "", bytes: Buffer.from(""), lineCount: 0, mode: undefined }
            : side,
}));
vi.mock("../../../src/views/EditableDiffEditorProvider", () => ({
    openEditableDiffEditor: mocks.openEditableDiffEditor,
}));
vi.mock("../../../src/git/executor", () => ({
    GitExecutor: class {
        constructor(_repoRoot: string) {}
    },
}));
vi.mock("../../../src/git/operationSupport", () => ({
    logGitOpsWarning: mocks.logGitOpsWarning,
}));
vi.mock("../../../src/diff/diffViewSwitch", () => ({
    trackDiffTab: mocks.trackDiffTab,
}));
vi.mock("../../../src/services/repositoryChangeEvents", () => ({
    subscribeToRepositoryWorkingTreeChanges: () => ({
        dispose: vi.fn(),
        rebind: vi.fn(),
    }),
}));

import { openEditableDiff } from "../../../src/diff/editableDiffOpener";
import { beginEditableDiffSession } from "../../../src/services/diffService";

const fileUri = { toString: () => "file:///repo/src/a.ts", fsPath: "/repo/src/a.ts" } as never;
const loaded = (text: string) => ({
    status: "loaded" as const,
    text,
    bytes: Buffer.from(text),
    lineCount: text
        ? text
              .split(/\r?\n/)
              .filter((_, index, lines) => index < lines.length - 1 || !text.endsWith("\n")).length
        : 0,
    mode: undefined,
});
const missing = { status: "missing" as const };

describe("openEditableDiff", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // `clearAllMocks` wipes the call log but NOT the queued one-shot results (verified on
        // vitest 4.1.10). The history cases below return before loading a side at all, so
        // without this reset their two unused values would sit at the head of the next test's
        // queue and be read as its own.
        mocks.loadDiffSide.mockReset();
        mocks.loadDiffSide
            .mockResolvedValueOnce(loaded("historical\n"))
            .mockResolvedValueOnce(loaded("saved\n"));
    });

    it.each([
        ["row 1", { kind: "ref", ref: "HEAD" }, { kind: "worktree" }, "right", "historical\n"],
        [
            "row 2",
            { kind: "ref", ref: "revision-oid" },
            { kind: "worktree" },
            "right",
            "historical\n",
        ],
        [
            "synthetic left pane",
            { kind: "worktree" },
            { kind: "ref", ref: "stash-oid" },
            "left",
            "saved\n",
        ],
    ] as const)(
        "derives the editable pane for %s",
        async (_surface, left, right, editablePane, immutableText) => {
            await openEditableDiff(
                {
                    repoRoot: "/repo",
                    path: "src/a.ts",
                    left,
                    right,
                    languageId: "typescript",
                    title: "Diff",
                    fileUri,
                },
                vi.fn(),
                beginEditableDiffSession,
            );

            expect(mocks.openEditableDiffEditor).toHaveBeenCalledWith(
                fileUri,
                expect.objectContaining({
                    editablePane,
                    immutableText,
                }),
            );
            // The tab is on screen, so the title-bar buttons have somewhere to send it. The
            // superseded case below asserts the other direction of the same rule.
            expect(mocks.trackDiffTab, "a landed diff was never recorded").toHaveBeenCalledOnce();
        },
    );

    it.each([
        ["commit history", { kind: "ref", ref: "parent" }, { kind: "ref", ref: "commit" }],
        [
            "shelf history",
            { kind: "ref", ref: "base" },
            {
                kind: "provider",
                label: "Shelved",
                identity: "shelf-oid",
                load: async () => ({ status: "missing" as const }),
            },
        ],
    ] as const)("keeps %s out of the editable surface", async (_surface, left, right) => {
        const nativeDelegate = vi.fn();

        await openEditableDiff(
            {
                repoRoot: "/repo",
                path: "src/a.ts",
                left,
                right,
                languageId: "typescript",
                title: "Diff",
                fileUri,
            },
            nativeDelegate,
            beginEditableDiffSession,
        );

        expect(mocks.openEditableDiffEditor).not.toHaveBeenCalled();
        expect(nativeDelegate).toHaveBeenCalledOnce();
    });

    // The title-bar switch, not a capability check: this diff is one the viewer would happily
    // render, and it still has to end up native because the reader asked for that. Asserted
    // together with the load count, because honouring the request only after both sides have
    // been read would look identical from the delegate alone.
    it("sends a diff the viewer could render to the native editor when the reader asks for it", async () => {
        const nativeDelegate = vi.fn(async () => undefined);

        await openEditableDiff(
            {
                repoRoot: "/repo",
                path: "src/a.ts",
                left: { kind: "ref", ref: "HEAD" },
                right: { kind: "worktree" },
                languageId: "typescript",
                title: "Diff",
                fileUri,
            },
            nativeDelegate,
            beginEditableDiffSession,
            "vscode",
        );

        expect(nativeDelegate).toHaveBeenCalledOnce();
        expect(mocks.openEditableDiffEditor).not.toHaveBeenCalled();
        expect(
            mocks.loadDiffSide,
            "both sides were read for a diff that was always going somewhere else",
        ).not.toHaveBeenCalled();
    });

    it("still opens the viewer when no surface is forced", async () => {
        const nativeDelegate = vi.fn(async () => undefined);

        await openEditableDiff(
            {
                repoRoot: "/repo",
                path: "src/a.ts",
                left: { kind: "ref", ref: "HEAD" },
                right: { kind: "worktree" },
                languageId: "typescript",
                title: "Diff",
                fileUri,
            },
            nativeDelegate,
            beginEditableDiffSession,
        );

        expect(mocks.openEditableDiffEditor).toHaveBeenCalledOnce();
        expect(nativeDelegate).not.toHaveBeenCalled();
    });

    it("keeps an added file in the editable editor when only the immutable side is missing", async () => {
        mocks.loadDiffSide.mockReset();
        mocks.loadDiffSide.mockResolvedValueOnce(missing).mockResolvedValueOnce(loaded("added\n"));
        const nativeDelegate = vi.fn(async () => undefined);

        await openEditableDiff(
            {
                repoRoot: "/repo",
                path: "src/added.ts",
                left: { kind: "ref", ref: "HEAD" },
                right: { kind: "worktree" },
                languageId: "typescript",
                title: "Added file",
                fileUri,
            },
            nativeDelegate,
            beginEditableDiffSession,
        );

        expect(mocks.openEditableDiffEditor).toHaveBeenCalledWith(
            fileUri,
            expect.objectContaining({ immutableText: "" }),
        );
        expect(nativeDelegate).not.toHaveBeenCalled();
    });

    it("opens the read-only viewer when the working-tree side is missing", async () => {
        mocks.loadDiffSide.mockReset();
        mocks.loadDiffSide
            .mockResolvedValueOnce(loaded("historical\n"))
            .mockResolvedValueOnce(missing);
        const session = {
            isCurrent: () => true,
            setInitialSides: vi.fn(() => true),
            refreshIfPending: vi.fn(),
            fallback: vi.fn(async () => undefined),
            openReadOnly: vi.fn(async () => undefined),
            dispose: vi.fn(),
        };
        const nativeDelegate = vi.fn(async () => undefined);

        await openEditableDiff(
            {
                repoRoot: "/repo",
                path: "src/deleted.ts",
                left: { kind: "ref", ref: "HEAD" },
                right: { kind: "worktree" },
                languageId: "typescript",
                title: "Deleted file",
                fileUri,
            },
            nativeDelegate,
            vi.fn(() => session) as never,
        );

        expect(mocks.openEditableDiffEditor).not.toHaveBeenCalled();
        expect(session.openReadOnly).toHaveBeenCalledOnce();
        expect(session.fallback).not.toHaveBeenCalled();
        expect(nativeDelegate).not.toHaveBeenCalled();
    });

    it("logs a load failure before falling back to the native diff", async () => {
        const failure = new Error("cannot load side");
        mocks.loadDiffSide.mockReset();
        mocks.loadDiffSide.mockRejectedValue(failure);
        const nativeDelegate = vi.fn(async () => undefined);

        await openEditableDiff(
            {
                repoRoot: "/repo",
                path: "src/a.ts",
                left: { kind: "ref", ref: "HEAD" },
                right: { kind: "worktree" },
                languageId: "typescript",
                title: "Diff",
                fileUri,
            },
            nativeDelegate,
            beginEditableDiffSession,
        );

        expect(mocks.logGitOpsWarning).toHaveBeenCalledWith(
            "editableDiffOpener.openEditableDiff.resolve",
            failure,
        );
        expect(nativeDelegate).toHaveBeenCalledOnce();
    });

    it("does not open a superseded native fallback", async () => {
        let resolveFirst: ((value: ReturnType<typeof loaded>) => void) | undefined;
        const firstLoad = new Promise<ReturnType<typeof loaded>>((resolve) => {
            resolveFirst = resolve;
        });
        mocks.loadDiffSide.mockReset();
        mocks.loadDiffSide
            .mockReturnValueOnce(firstLoad)
            .mockResolvedValueOnce({ status: "ineligible", reason: "binary" })
            .mockResolvedValueOnce(loaded("working tree\n"))
            .mockResolvedValueOnce({ status: "ineligible", reason: "binary" });
        const firstDelegate = vi.fn(async () => undefined);
        const secondDelegate = vi.fn(async () => undefined);
        const request = {
            repoRoot: "/repo",
            path: "src/a.ts",
            left: { kind: "ref" as const, ref: "HEAD" },
            right: { kind: "worktree" as const },
            languageId: "typescript",
            title: "Diff",
            fileUri,
        };

        const first = openEditableDiff(request, firstDelegate, beginEditableDiffSession);
        await openEditableDiff(request, secondDelegate, beginEditableDiffSession);
        resolveFirst?.(loaded("historical\n"));
        await first;

        expect(secondDelegate).toHaveBeenCalledOnce();
        expect(firstDelegate).not.toHaveBeenCalled();
        // Only the second open put a tab on screen. Recording the first as well would bind the
        // tab now in front -- the file the reader actually clicked -- to the diff they clicked
        // away from, so its title-bar button would reopen the wrong file.
        expect(
            mocks.trackDiffTab,
            "the superseded open was recorded as though it had landed a tab",
        ).toHaveBeenCalledOnce();
    });
});
