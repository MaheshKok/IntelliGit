import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GitOps } from "../../../src/git/operations";

const mocks = vi.hoisted(() => ({
    resolved: undefined as unknown,
    openExternal: vi.fn(async () => true),
    executeCommand: vi.fn(async () => undefined),
    getSession: vi.fn(async () => ({ accessToken: "synthetic-token" })),
    fetch: vi.fn(async (_url?: string, _options?: RequestInit) => ({
        ok: true,
        json: async () => ({ html_url: `https://gist.github.com/o/${"a".repeat(32)}` }),
    })),
    openTextDocument: vi.fn(),
    showInputBox: vi.fn(async () => "description"),
    showInformationMessage: vi.fn(async () => undefined),
    showWarningMessage: vi.fn(
        async (_message: string, _options: unknown, action: string) => action,
    ),
    publishProject: vi.fn(async () => undefined),
    showErrorMessage: vi.fn(async () => undefined),
    showQuickPick: vi.fn(async (items: Array<{ label: string }>) => items[0]),
    activeEditor: undefined as unknown,
}));

vi.mock("../../../src/commands/fileContextCommands", () => ({
    resolveFileCommandContext: vi.fn(async () => mocks.resolved),
}));
vi.mock("../../../src/services/publishService", () => ({
    runPublishGitHubProjectFlow: mocks.publishProject,
}));
vi.mock("vscode", () => ({
    Uri: { parse: (value: string) => ({ toString: () => value }) },
    env: { openExternal: mocks.openExternal },
    commands: { executeCommand: mocks.executeCommand },
    window: {
        get activeTextEditor() {
            return mocks.activeEditor;
        },
        showErrorMessage: mocks.showErrorMessage,
        showQuickPick: mocks.showQuickPick,
        showInputBox: mocks.showInputBox,
        showInformationMessage: mocks.showInformationMessage,
        showWarningMessage: mocks.showWarningMessage,
    },
    workspace: { openTextDocument: mocks.openTextDocument },
    authentication: { getSession: mocks.getSession },
    l10n: {
        t: (message: string, args?: Record<string, string>) =>
            Object.entries(args ?? {}).reduce(
                (text, [key, value]) => text.replace(`{${key}}`, value),
                message,
            ),
    },
}));

import {
    createGitHubPullRequestFromContext,
    createGitHubGistFromContext,
    syncGitHubForkFromContext,
    shareGitHubProjectFromContext,
    manageGitHubAccounts,
    viewGitHubFileFromContext,
    viewGitHubPullRequestsFromContext,
} from "../../../src/commands/githubContextCommands";

describe("View Pull Requests from clicked GitHub repository", () => {
    const activeA = { getRemotes: vi.fn(), getRemoteUrl: vi.fn() } as unknown as GitOps;
    const clickedB = {
        getRemotes: vi.fn(async () => ["origin"]),
        getRemoteUrl: vi.fn(async () => "git@github.com:owner/clicked-b.git"),
        getMergeTarget: vi.fn(async () => ({ head: "feature/slash", oid: "a".repeat(40) })),
        getBranches: vi.fn(async () => [
            { name: "origin/feature/slash", isRemote: true, isCurrent: false },
        ]),
        hasFileAtHead: vi.fn(async () => true),
    };

    beforeEach(() => {
        vi.clearAllMocks();
        mocks.resolved = { repoRoot: "/clicked-b", gitOps: clickedB };
        clickedB.getRemotes.mockResolvedValue(["origin"]);
        clickedB.getRemoteUrl.mockResolvedValue("git@github.com:owner/clicked-b.git");
        clickedB.getMergeTarget.mockResolvedValue({ head: "feature/slash", oid: "a".repeat(40) });
        clickedB.getBranches.mockResolvedValue([
            { name: "origin/feature/slash", isRemote: true, isCurrent: false },
        ]);
        clickedB.hasFileAtHead.mockResolvedValue(true);
        mocks.activeEditor = undefined;
    });

    it("opens clicked B while A remains active", async () => {
        await viewGitHubPullRequestsFromContext({ file: "B" }, activeA);
        expect(clickedB.getRemotes, "clicked B supplies remotes").toHaveBeenCalledOnce();
        expect(activeA.getRemotes, "active A remains untouched").not.toHaveBeenCalled();
        expect(mocks.openExternal, "clicked B Pull Requests page opens").toHaveBeenCalledWith(
            expect.objectContaining({ toString: expect.any(Function) }),
        );
        expect(mocks.openExternal.mock.calls[0][0].toString()).toBe(
            "https://github.com/owner/clicked-b/pulls",
        );
    });

    it("offers multiple eligible remotes with origin first and preserves the picked identity", async () => {
        clickedB.getRemotes.mockResolvedValue(["team", "origin"]);
        clickedB.getRemoteUrl.mockImplementation(async (name: string) =>
            name === "origin" ? "https://github.com/o/origin.git" : "https://github.com/o/team.git",
        );
        mocks.showQuickPick.mockImplementationOnce(
            async (items: Array<{ label: string }>) => items[1],
        );
        await viewGitHubPullRequestsFromContext({ file: "B" }, activeA);
        expect(
            mocks.showQuickPick.mock.calls[0][0].map((item: { label: string }) => item.label),
        ).toEqual(["origin", "team"]);
        expect(mocks.openExternal.mock.calls[0][0].toString()).toBe(
            "https://github.com/o/team/pulls",
        );
    });

    it("cancellation and unsupported remotes never navigate", async () => {
        clickedB.getRemotes.mockResolvedValueOnce(["origin", "team"]);
        clickedB.getRemoteUrl.mockResolvedValue("https://github.com/o/r.git");
        mocks.showQuickPick.mockResolvedValueOnce(undefined);
        await viewGitHubPullRequestsFromContext({ file: "B" }, activeA);
        expect(mocks.openExternal).not.toHaveBeenCalled();

        clickedB.getRemotes.mockResolvedValueOnce(["origin"]);
        clickedB.getRemoteUrl.mockResolvedValueOnce("https://github.com.evil.test/o/r.git");
        await viewGitHubPullRequestsFromContext({ file: "B" }, activeA);
        expect(mocks.openExternal).not.toHaveBeenCalled();
        expect(mocks.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining("GitHub"));
    });
});

describe("Create Pull Request and View in Browser", () => {
    const scoped = {
        getRemotes: vi.fn(async () => ["origin"]),
        getRemoteUrl: vi.fn(async () => "https://github.com/o/repo.git"),
        getMergeTarget: vi.fn(async () => ({ head: "feature/slash", oid: "a".repeat(40) })),
        getBranches: vi.fn(async () => [{ name: "origin/feature/slash", isRemote: true }]),
        hasFileAtHead: vi.fn(async () => true),
    };
    const activeA = { getRemotes: vi.fn() } as unknown as GitOps;

    beforeEach(() => {
        vi.clearAllMocks();
        mocks.resolved = {
            repoRoot: "/clicked-b",
            repoRelativePath: "dir/sp ace#%?.é",
            selectedUri: { toString: () => "file:/clicked-b/dir/file.ts" },
            gitOps: scoped,
        };
        scoped.getMergeTarget.mockResolvedValue({ head: "feature/slash", oid: "a".repeat(40) });
        scoped.getBranches.mockResolvedValue([{ name: "origin/feature/slash", isRemote: true }]);
        scoped.hasFileAtHead.mockResolvedValue(true);
        mocks.activeEditor = undefined;
    });

    it("opens clicked B compare only when its branch is published to the selected remote", async () => {
        await createGitHubPullRequestFromContext({ file: "B" }, activeA);
        expect(mocks.openExternal.mock.calls[0][0].toString()).toBe(
            "https://github.com/o/repo/compare/feature%2Fslash?expand=1",
        );
        expect(activeA.getRemotes).not.toHaveBeenCalled();
    });

    it("refuses a branch published only on another remote", async () => {
        scoped.getBranches.mockResolvedValue([{ name: "other/feature/slash", isRemote: true }]);
        await createGitHubPullRequestFromContext({ file: "B" }, activeA);
        expect(mocks.openExternal).not.toHaveBeenCalled();
        expect(mocks.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining("published"));
    });

    it.each([
        { head: "(detached)", oid: "a".repeat(40) },
        { head: "main", oid: "(initial)" },
    ])("refuses a detached or unborn PR branch: $head/$oid", async (target) => {
        scoped.getMergeTarget.mockResolvedValueOnce(target);
        await createGitHubPullRequestFromContext({ file: "B" }, activeA);
        expect(mocks.openExternal, "invalid PR branch never navigates").not.toHaveBeenCalled();
        expect(mocks.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining("commit"));
    });

    it("opens the clicked tracked file at captured HEAD without editor A anchors", async () => {
        mocks.activeEditor = {
            document: { uri: { toString: () => "file:/active-a.ts" } },
            selection: { start: { line: 4 }, end: { line: 4, character: 2 }, isEmpty: false },
        };
        await viewGitHubFileFromContext({ file: "B" }, activeA);
        expect(mocks.openExternal.mock.calls[0][0].toString()).toBe(
            `https://github.com/o/repo/blob/${"a".repeat(40)}/dir/sp%20ace%23%25%3F.%C3%A9`,
        );
    });

    it("retains B's HEAD and exclusive-end line anchor while the remote picker changes editor state", async () => {
        mocks.activeEditor = {
            document: { uri: { toString: () => "file:/clicked-b/dir/file.ts" } },
            selection: {
                start: { line: 2, character: 3 },
                end: { line: 6, character: 0 },
                isEmpty: false,
            },
        };
        scoped.getRemotes.mockResolvedValueOnce(["origin", "team"]);
        mocks.showQuickPick.mockImplementationOnce(async (items: Array<unknown>) => {
            scoped.getMergeTarget.mockResolvedValue({ head: "other", oid: "b".repeat(40) });
            mocks.activeEditor = {
                document: { uri: { toString: () => "file:/active-a.ts" } },
                selection: { start: { line: 20 }, end: { line: 20, character: 5 } },
            };
            return items[0];
        });
        await viewGitHubFileFromContext({ file: "B" }, activeA);
        expect(mocks.openExternal.mock.calls[0][0].toString()).toBe(
            `https://github.com/o/repo/blob/${"a".repeat(40)}/dir/sp%20ace%23%25%3F.%C3%A9#L3-L6`,
        );
    });

    it("rejects an untracked clicked file and does not navigate", async () => {
        scoped.hasFileAtHead.mockResolvedValue(false);
        await viewGitHubFileFromContext({ file: "B" }, activeA);
        expect(mocks.openExternal).not.toHaveBeenCalled();
        expect(mocks.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining("tracked"));
    });
});

describe("Manage GitHub Accounts", () => {
    it("delegates to native VS Code account management", async () => {
        vi.clearAllMocks();
        await manageGitHubAccounts();
        expect(mocks.executeCommand).toHaveBeenCalledExactlyOnceWith(
            "workbench.action.manageAccounts",
        );
    });

    it("surfaces a native command failure", async () => {
        vi.clearAllMocks();
        mocks.executeCommand.mockRejectedValueOnce(new Error("unavailable"));
        await manageGitHubAccounts();
        expect(mocks.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining("unavailable"));
    });
});

describe("Create Gist from clicked text", () => {
    const activeA = {} as GitOps;
    let buffer = "whole B content";
    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubGlobal("fetch", mocks.fetch);
        buffer = "whole B content";
        mocks.resolved = {
            selectedUri: { fsPath: "/clicked-b.ts", toString: () => "file:/clicked-b.ts" },
        };
        mocks.openTextDocument.mockImplementation(async () => ({
            isDirty: true,
            getText: (selection?: unknown) => (selection ? "selected B" : buffer),
        }));
        mocks.showQuickPick.mockImplementation(async (items: Array<{ value: string }>) => items[0]);
        mocks.showWarningMessage.mockImplementation(
            async (_message: string, _options: unknown, action: string) => action,
        );
        mocks.showInputBox.mockResolvedValue("description");
        mocks.activeEditor = undefined;
    });

    it("confirms clicked B's dirty whole-buffer snapshot before any POST while A is active", async () => {
        mocks.activeEditor = {
            document: { uri: { toString: () => "file:/active-a.ts" } },
            selection: { isEmpty: false },
        };
        mocks.showWarningMessage.mockImplementationOnce(
            async (_message: string, _options: unknown, action: string) => {
                expect(
                    mocks.fetch,
                    "confirmation precedes content transmission",
                ).not.toHaveBeenCalled();
                buffer = "later edit";
                return action;
            },
        );
        await createGitHubGistFromContext({ file: "B" }, activeA);
        expect(mocks.showWarningMessage.mock.calls[0][0]).toContain("clicked-b.ts");
        expect(mocks.showWarningMessage.mock.calls[0][0]).toContain("dirty");
        expect(mocks.fetch).toHaveBeenCalledOnce();
        expect(JSON.parse(mocks.fetch.mock.calls[0][1].body)).toMatchObject({
            public: false,
            files: { "clicked-b.ts": { content: "whole B content" } },
        });
    });

    it("uses a non-empty selection only when clicked URI matches the editor", async () => {
        mocks.activeEditor = {
            document: { uri: { toString: () => "file:/clicked-b.ts" } },
            selection: { isEmpty: false },
        };
        await createGitHubGistFromContext({ file: "B" }, activeA);
        expect(JSON.parse(mocks.fetch.mock.calls[0][1].body).files["clicked-b.ts"].content).toBe(
            "selected B",
        );
    });

    it("cancellation at final confirmation publishes nothing", async () => {
        mocks.showWarningMessage.mockResolvedValueOnce(undefined);
        await createGitHubGistFromContext({ file: "B" }, activeA);
        expect(mocks.fetch, "cancel means no Gist POST").not.toHaveBeenCalled();
    });

    it.each(["description", "visibility"])(
        "%s cancellation sends no Gist content",
        async (stage) => {
            if (stage === "description") mocks.showInputBox.mockResolvedValueOnce(undefined);
            else mocks.showQuickPick.mockResolvedValueOnce(undefined);
            await createGitHubGistFromContext({ file: "B" }, activeA);
            expect(mocks.fetch, "cancelled Gist never POSTs").not.toHaveBeenCalled();
        },
    );

    it("reports Gist authentication and API failures without a success action", async () => {
        mocks.getSession.mockRejectedValueOnce(new Error("synthetic auth failure"));
        await createGitHubGistFromContext({ file: "B" }, activeA);
        expect(mocks.fetch).not.toHaveBeenCalled();
        expect(mocks.showInformationMessage).not.toHaveBeenCalled();
        expect(mocks.showErrorMessage).toHaveBeenCalled();

        vi.clearAllMocks();
        mocks.fetch.mockResolvedValueOnce({ ok: false, status: 403 });
        await createGitHubGistFromContext({ file: "B" }, activeA);
        expect(mocks.fetch).toHaveBeenCalledOnce();
        expect(
            mocks.showInformationMessage,
            "failed Gist POST is not success",
        ).not.toHaveBeenCalled();
        expect(mocks.openExternal).not.toHaveBeenCalled();
    });

    it("rejects an unsafe API response destination", async () => {
        mocks.fetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                html_url: `https://gist.github.com.evil.test/o/${"a".repeat(32)}`,
            }),
        });
        mocks.showInformationMessage.mockResolvedValueOnce("Open Gist");
        await createGitHubGistFromContext({ file: "B" }, activeA);
        expect(mocks.openExternal, "unsafe Gist URL never opens").not.toHaveBeenCalled();
        expect(mocks.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining("unsafe"));
    });

    it("aborts a slow Gist POST and reports failure without claiming publication", async () => {
        const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => {
            const controller = new AbortController();
            queueMicrotask(() => controller.abort(new Error("synthetic request timeout")));
            return controller.signal;
        });
        try {
            mocks.fetch.mockImplementationOnce(async (_url, options) => {
                await new Promise<void>((resolve, reject) => {
                    options?.signal?.addEventListener(
                        "abort",
                        () => reject(options.signal?.reason),
                        { once: true },
                    );
                    setTimeout(resolve, 10);
                });
                return {
                    ok: true,
                    json: async () => ({ html_url: `https://gist.github.com/o/${"a".repeat(32)}` }),
                };
            });
            await createGitHubGistFromContext({ file: "B" }, activeA);
            expect(
                mocks.showInformationMessage,
                "aborted Gist is not published",
            ).not.toHaveBeenCalled();
            expect(mocks.showErrorMessage, "aborted Gist reports failure").toHaveBeenCalled();
            expect(timeout).toHaveBeenCalledWith(30_000);
        } finally {
            timeout.mockRestore();
        }
    });
});

describe("Sync Fork from clicked repository", () => {
    let upstreamUrl: string | null = null;
    const scoped = {
        getRemoteUrl: vi.fn(async (name: string) =>
            name === "origin" ? "git@github.com:me/fork.git" : upstreamUrl,
        ),
        getMergeTarget: vi.fn(async () => ({ head: "feature/x", oid: "a".repeat(40) })),
        hasUncommittedChanges: vi.fn(async () => false),
        getActiveOperation: vi.fn(async () => "none"),
        addRemote: vi.fn(async (_name: string, url: string) => {
            upstreamUrl = url;
        }),
        fetchRemoteBranch: vi.fn(async () => "b".repeat(40)),
        rebase: vi.fn(async () => undefined),
        getConflictFilesDetailed: vi.fn(async () => [] as Array<{ path: string }>),
    };
    const activeA = {} as GitOps;

    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubGlobal("fetch", mocks.fetch);
        upstreamUrl = null;
        mocks.resolved = { repoRoot: "/clicked-b", gitOps: scoped };
        scoped.getRemoteUrl.mockImplementation(async (name: string) =>
            name === "origin" ? "git@github.com:me/fork.git" : upstreamUrl,
        );
        scoped.addRemote.mockImplementation(async (_name: string, url: string) => {
            upstreamUrl = url;
        });
        scoped.getMergeTarget.mockResolvedValue({ head: "feature/x", oid: "a".repeat(40) });
        scoped.hasUncommittedChanges.mockResolvedValue(false);
        scoped.getActiveOperation.mockResolvedValue("none");
        mocks.getSession.mockResolvedValue({ accessToken: "synthetic-token" });
        mocks.fetch.mockResolvedValue({
            ok: true,
            json: async () => ({
                full_name: "me/fork",
                fork: true,
                parent: { full_name: "source/project", default_branch: "develop" },
            }),
        });
        mocks.showWarningMessage.mockImplementation(
            async (_message: string, _options: unknown, action: string) => action,
        );
    });

    it("confirms parent/default branch and rebases clicked B only after scoped rechecks", async () => {
        await syncGitHubForkFromContext({ file: "B" }, activeA);
        expect(mocks.showWarningMessage.mock.calls[0][0]).toContain("develop");
        expect(scoped.addRemote).toHaveBeenCalledWith(
            "upstream",
            "https://github.com/source/project.git",
        );
        expect(scoped.fetchRemoteBranch).toHaveBeenCalledWith("upstream", "develop");
        expect(scoped.rebase, "approved fetched commit stays immutable").toHaveBeenCalledWith(
            "b".repeat(40),
        );
    });

    it.each([
        { kind: "lowercase", url: "git@github.com:source/project.git" },
        { kind: "mixed-case", url: "git@github.com:Source/Project.git" },
    ])(
        "accepts an equivalent effective upstream rewrite ($kind) and rebases clicked B",
        async ({ url }) => {
            scoped.getRemoteUrl.mockImplementation(async (name: string) =>
                name === "origin" ? "git@github.com:me/fork.git" : upstreamUrl ? url : null,
            );
            await syncGitHubForkFromContext({ file: "B" }, activeA);
            expect(scoped.addRemote).toHaveBeenCalledOnce();
            expect(
                scoped.fetchRemoteBranch,
                "equivalent effective upstream must fetch B",
            ).toHaveBeenCalledWith("upstream", "develop");
            expect(
                scoped.rebase,
                "equivalent effective upstream must rebase B",
            ).toHaveBeenCalledWith("b".repeat(40));
        },
    );

    it.each([
        { kind: "hostile host", url: "https://github.com.evil.test/source/project.git" },
        { kind: "wrong owner", url: "https://github.com/wrong/project.git" },
        { kind: "wrong repo", url: "https://github.com/source/wrong.git" },
    ])(
        "rejects an effective upstream rewrite with $kind before fetching",
        async ({ kind, url }) => {
            scoped.getRemoteUrl.mockImplementation(async (name: string) =>
                name === "origin" ? "git@github.com:me/fork.git" : upstreamUrl ? url : null,
            );
            await syncGitHubForkFromContext({ file: "B" }, activeA);
            expect(scoped.addRemote).toHaveBeenCalledOnce();
            expect(
                scoped.fetchRemoteBranch,
                `unsafe effective upstream (${kind}) never fetched`,
            ).not.toHaveBeenCalled();
            expect(scoped.rebase).not.toHaveBeenCalled();
            expect(mocks.showErrorMessage).toHaveBeenCalled();
        },
    );

    it("aborts a slow fork-metadata GET before adding upstream or fetching", async () => {
        const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => {
            const controller = new AbortController();
            queueMicrotask(() => controller.abort(new Error("synthetic request timeout")));
            return controller.signal;
        });
        try {
            mocks.fetch.mockImplementationOnce(async (_url, options) => {
                await new Promise<void>((resolve, reject) => {
                    options?.signal?.addEventListener(
                        "abort",
                        () => reject(options.signal?.reason),
                        { once: true },
                    );
                    setTimeout(resolve, 10);
                });
                return {
                    ok: true,
                    json: async () => ({
                        html_url: "",
                        full_name: "me/fork",
                        fork: true,
                        parent: { full_name: "source/project", default_branch: "develop" },
                    }),
                };
            });
            await syncGitHubForkFromContext({ file: "B" }, activeA);
            expect(
                scoped.addRemote,
                "timed-out metadata never adds upstream",
            ).not.toHaveBeenCalled();
            expect(
                scoped.fetchRemoteBranch,
                "timed-out metadata never fetches",
            ).not.toHaveBeenCalled();
            expect(mocks.showErrorMessage).toHaveBeenCalled();
            expect(timeout).toHaveBeenCalledWith(30_000);
        } finally {
            timeout.mockRestore();
        }
    });

    it("cancellation before mutation adds no remote and fetches nothing", async () => {
        mocks.showWarningMessage.mockResolvedValueOnce(undefined);
        await syncGitHubForkFromContext({ file: "B" }, activeA);
        expect(scoped.addRemote, "cancel before upstream add").not.toHaveBeenCalled();
        expect(scoped.fetchRemoteBranch).not.toHaveBeenCalled();
        expect(scoped.rebase).not.toHaveBeenCalled();
    });

    it("refuses stale confirmation if clicked B changes branch", async () => {
        mocks.showWarningMessage.mockImplementationOnce(
            async (_message: string, _options: unknown, action: string) => {
                scoped.getMergeTarget.mockResolvedValue({ head: "other", oid: "b".repeat(40) });
                return action;
            },
        );
        await syncGitHubForkFromContext({ file: "B" }, activeA);
        expect(scoped.addRemote, "stale approval never mutates").not.toHaveBeenCalled();
        expect(scoped.fetchRemoteBranch).not.toHaveBeenCalled();
        expect(mocks.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining("changed"));
    });

    it("refuses invalid GitHub parent metadata before adding upstream", async () => {
        mocks.fetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                full_name: "me/fork",
                fork: true,
                parent: { full_name: "source/project/evil", default_branch: "develop" },
            }),
        });
        await syncGitHubForkFromContext({ file: "B" }, activeA);
        expect(scoped.addRemote, "unsafe destination never reaches Git").not.toHaveBeenCalled();
        expect(scoped.fetchRemoteBranch).not.toHaveBeenCalled();
    });

    it("refuses a conflicting upstream without changing any remote", async () => {
        upstreamUrl = "https://github.com/wrong/project.git";
        await syncGitHubForkFromContext({ file: "B" }, activeA);
        expect(scoped.addRemote).not.toHaveBeenCalled();
        expect(
            scoped.fetchRemoteBranch,
            "conflicting upstream is never fetched",
        ).not.toHaveBeenCalled();
        expect(mocks.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining("upstream"));
    });

    it("does not rebase when B's HEAD changes while fetching", async () => {
        scoped.fetchRemoteBranch.mockImplementationOnce(async () => {
            scoped.getMergeTarget.mockResolvedValue({ head: "feature/x", oid: "c".repeat(40) });
            return "b".repeat(40);
        });
        await syncGitHubForkFromContext({ file: "B" }, activeA);
        expect(scoped.rebase, "changed B HEAD blocks stale rebase").not.toHaveBeenCalled();
        expect(mocks.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining("changed"));
    });

    it("reports a failed fetch and leaves the newly added upstream visible", async () => {
        scoped.fetchRemoteBranch.mockRejectedValueOnce(new Error("synthetic fetch failure"));
        await syncGitHubForkFromContext({ file: "B" }, activeA);
        expect(scoped.addRemote).toHaveBeenCalledOnce();
        expect(scoped.rebase, "failed fetch never rebases").not.toHaveBeenCalled();
        expect(mocks.showErrorMessage).toHaveBeenCalledWith(
            expect.stringContaining("upstream may have been added"),
        );
    });

    it("opens the captured B conflict session if its rebase conflicts", async () => {
        const callbacks = {
            refresh: vi.fn(() => Promise.resolve()),
            refreshConflicts: vi.fn(() => Promise.resolve()),
            openConflictSession: vi.fn(() => Promise.resolve()),
        };
        scoped.rebase.mockRejectedValueOnce(new Error("synthetic conflict"));
        scoped.getConflictFilesDetailed.mockResolvedValueOnce([{ path: "conflict.txt" }]);
        await syncGitHubForkFromContext({ file: "B" }, activeA, callbacks);
        expect(callbacks.openConflictSession, "conflict UI stays scoped to B").toHaveBeenCalledWith(
            scoped,
            "/clicked-b",
        );
        expect(callbacks.refreshConflicts).toHaveBeenCalledWith("/clicked-b");
    });
});

describe("Share Project on GitHub from clicked repository", () => {
    it("captures B's branch and root before entering the publish flow", async () => {
        vi.clearAllMocks();
        const scoped = {
            getMergeTarget: vi.fn(async () => ({ head: "feature/x", oid: "a".repeat(40) })),
        };
        mocks.resolved = { repoRoot: "/clicked-b", gitOps: scoped };
        await shareGitHubProjectFromContext({ file: "B" }, {} as GitOps);
        expect(mocks.publishProject, "share targets captured B").toHaveBeenCalledWith(
            scoped,
            "feature/x",
            "/clicked-b",
        );
    });
});
