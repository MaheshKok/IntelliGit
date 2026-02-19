import { describe, expect, it, vi, beforeEach } from "vitest";
import type { GitOps } from "../../src/git/operations";
import { computeGraph } from "../../src/webviews/react/graph";
import { formatDateTime } from "../../src/webviews/react/shared/date";
import { FILE_TYPE_BADGES, GIT_STATUS_COLORS, GIT_STATUS_LABELS } from "../../src/webviews/react/shared/tokens";
import { getErrorMessage, isBranchNotFullyMergedError, isUntrackedPathspecError } from "../../src/utils/errors";
import { getChevronIconStyle } from "../../src/webviews/react/branch-column/styles";
import { contentContainerStyle, headerRowStyle } from "../../src/webviews/react/commit-list/styles";

describe("core utilities", () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
    });

    it("GitExecutor delegates to simple-git raw", async () => {
        const raw = vi.fn(async () => "ok");
        const simpleGit = vi.fn(() => ({ raw }));
        vi.doMock("simple-git", () => ({ default: simpleGit }));
        const { GitExecutor } = await import("../../src/git/executor");

        const executor = new GitExecutor("/tmp/repo");
        const out = await executor.run(["status", "--short"]);

        expect(out).toBe("ok");
        expect(simpleGit).toHaveBeenCalledWith("/tmp/repo", { maxConcurrentProcesses: 6 });
        expect(raw).toHaveBeenCalledWith(["status", "--short"]);
    });

    it("deleteFileWithFallback uses git rm success path", async () => {
        const showErrorMessage = vi.fn();
        const fsDelete = vi.fn(async () => {});
        vi.doMock("vscode", () => ({
            window: { showErrorMessage },
            workspace: { fs: { delete: fsDelete } },
            Uri: { joinPath: (root: { fsPath: string }, filePath: string) => ({ fsPath: `${root.fsPath}/${filePath}` }) },
        }));
        const { deleteFileWithFallback } = await import("../../src/utils/fileOps");
        type GitDeleteMock = Pick<GitOps, "deleteFile">;

        const gitOps: GitDeleteMock = { deleteFile: vi.fn(async () => {}) };
        const workspaceRoot = { fsPath: "/repo" } as unknown as Parameters<
            typeof deleteFileWithFallback
        >[1];
        const ok = await deleteFileWithFallback(gitOps as GitOps, workspaceRoot, "a.txt");

        expect(ok).toBe(true);
        expect(gitOps.deleteFile).toHaveBeenCalledWith("a.txt", true);
        expect(fsDelete).not.toHaveBeenCalled();
        expect(showErrorMessage).not.toHaveBeenCalled();
    });

    it("deleteFileWithFallback falls back to fs delete for untracked files", async () => {
        const showErrorMessage = vi.fn();
        const fsDelete = vi.fn(async () => {});
        vi.doMock("vscode", () => ({
            window: { showErrorMessage },
            workspace: { fs: { delete: fsDelete } },
            Uri: { joinPath: (root: { fsPath: string }, filePath: string) => ({ fsPath: `${root.fsPath}/${filePath}` }) },
        }));
        const { deleteFileWithFallback } = await import("../../src/utils/fileOps");
        type GitDeleteMock = Pick<GitOps, "deleteFile">;

        const gitOps: GitDeleteMock = {
            deleteFile: vi.fn(async () => {
                throw new Error("pathspec 'a.txt' did not match any files");
            }),
        };
        const workspaceRoot = { fsPath: "/repo" } as unknown as Parameters<
            typeof deleteFileWithFallback
        >[1];
        const ok = await deleteFileWithFallback(gitOps as GitOps, workspaceRoot, "a.txt");

        expect(ok).toBe(true);
        expect(fsDelete).toHaveBeenCalledTimes(1);
        expect(showErrorMessage).not.toHaveBeenCalled();
    });

    it("deleteFileWithFallback surfaces unexpected git or fs errors", async () => {
        const showErrorMessage = vi.fn();
        const fsDelete = vi.fn(async () => {
            throw new Error("permission denied");
        });
        vi.doMock("vscode", () => ({
            window: { showErrorMessage },
            workspace: { fs: { delete: fsDelete } },
            Uri: { joinPath: (_root: { fsPath: string }, filePath: string) => ({ fsPath: `/repo/${filePath}` }) },
        }));
        const { deleteFileWithFallback } = await import("../../src/utils/fileOps");
        type GitDeleteMock = Pick<GitOps, "deleteFile">;

        const gitUnexpected: GitDeleteMock = {
            deleteFile: vi.fn(async () => {
                throw new Error("index lock");
            }),
        };
        const workspaceRoot = { fsPath: "/repo" } as unknown as Parameters<
            typeof deleteFileWithFallback
        >[1];
        const okUnexpected = await deleteFileWithFallback(
            gitUnexpected as GitOps,
            workspaceRoot,
            "a.txt",
        );
        expect(okUnexpected).toBe(false);

        const gitUntracked: GitDeleteMock = {
            deleteFile: vi.fn(async () => {
                throw new Error("pathspec did not match");
            }),
        };
        const okFsFail = await deleteFileWithFallback(gitUntracked as GitOps, workspaceRoot, "a.txt");
        expect(okFsFail).toBe(false);
        expect(showErrorMessage).toHaveBeenCalled();
    });

    it("buildWebviewShellHtml includes CSP, nonce, title and script URI", async () => {
        const joinPath = vi.fn((_base: any, ...parts: string[]) => ({ path: `/${parts.join("/")}` }));
        vi.doMock("vscode", () => ({
            Uri: { joinPath },
        }));
        const { buildWebviewShellHtml } = await import("../../src/views/webviewHtml");

        const html = buildWebviewShellHtml({
            extensionUri: { path: "/ext" } as any,
            webview: {
                cspSource: "vscode-resource:",
                asWebviewUri: (uri: { path: string }) => `webview://${uri.path}`,
            } as any,
            scriptFile: "webview-commitgraph.js",
            title: "Commit Graph",
            backgroundVar: "#123",
        });

        expect(html).toContain("<title>Commit Graph</title>");
        expect(html).toContain("Content-Security-Policy");
        expect(html).toContain("script-src 'nonce-");
        expect(html).toContain("src=\"webview:///dist/webview-commitgraph.js\"");
        expect(html).toContain("background: #123");
    });

    it("graph compute handles linear and merge histories", () => {
        const linear = computeGraph([
            { hash: "c3", parentHashes: ["c2"] },
            { hash: "c2", parentHashes: ["c1"] },
            { hash: "c1", parentHashes: [] },
        ]);
        expect(linear).toHaveLength(3);
        expect(linear[0].column).toBe(0);

        const merge = computeGraph([
            { hash: "m1", parentHashes: ["p1", "p2"] },
            { hash: "p1", parentHashes: ["base"] },
            { hash: "p2", parentHashes: ["base"] },
            { hash: "base", parentHashes: [] },
        ]);
        expect(merge[0].connectionsDown.length).toBeGreaterThan(1);
    });

    it("date formatting falls back safely on invalid date", () => {
        expect(formatDateTime("not-a-date")).toBe("not-a-date");
        expect(typeof formatDateTime("2026-02-19T08:00:00Z")).toBe("string");
    });

    it("error helpers classify and format errors", () => {
        expect(getErrorMessage(new Error("boom"))).toBe("boom");
        expect(getErrorMessage(42)).toBe("42");
        expect(isUntrackedPathspecError(new Error("pathspec did not match any files"))).toBe(true);
        expect(isUntrackedPathspecError({ code: "ENOENT" })).toBe(true);
        expect(isBranchNotFullyMergedError(new Error("branch is not fully merged"))).toBe(true);
    });

    it("shared style helpers and tokens expose expected values", () => {
        expect(getChevronIconStyle(true).transform).toContain("90deg");
        expect(getChevronIconStyle(false).transform).toContain("0deg");
        expect(headerRowStyle(120).paddingLeft).toBe(120);
        expect(contentContainerStyle(5).height).toBe(140);
        expect(FILE_TYPE_BADGES.json.label).toBe("JN");
        expect(GIT_STATUS_COLORS.M).toContain("--vscode-gitDecoration");
        expect(GIT_STATUS_LABELS["?"]).toBe("Unversioned");
    });

    it("vscode api getter caches acquireVsCodeApi result", async () => {
        const fakeApi = {
            postMessage: vi.fn(),
            getState: vi.fn(() => ({ x: 1 })),
            setState: vi.fn(),
        };
        const originalAcquire = (globalThis as Record<string, unknown>).acquireVsCodeApi;
        try {
            (globalThis as Record<string, unknown>).acquireVsCodeApi = vi.fn(() => fakeApi);
            const { getVsCodeApi } = await import("../../src/webviews/react/shared/vscodeApi");
            const api1 = getVsCodeApi();
            const api2 = getVsCodeApi();
            expect(api1).toBe(api2);
            const mockedAcquire = (globalThis as { acquireVsCodeApi: ReturnType<typeof vi.fn> })
                .acquireVsCodeApi;
            expect(mockedAcquire).toHaveBeenCalledTimes(1);
        } finally {
            if (typeof originalAcquire === "undefined") {
                delete (globalThis as Record<string, unknown>).acquireVsCodeApi;
            } else {
                (globalThis as Record<string, unknown>).acquireVsCodeApi = originalAcquire;
            }
        }
    });
});
