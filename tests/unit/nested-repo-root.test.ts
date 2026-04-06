// Tests for the nested subfolder commit fix: verifying correct git repository
// root discovery when VS Code workspace folder differs from the git repo root.

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock vscode before any imports that depend on it
vi.mock("vscode", () => ({
    Uri: {
        file: (fsPath: string) => ({ scheme: "file", fsPath, path: fsPath }),
        joinPath: (base: { fsPath: string }, ...segments: string[]) => {
            const joined = [base.fsPath, ...segments].join("/");
            return { scheme: "file", fsPath: joined, path: joined };
        },
    },
    window: {
        showQuickPick: vi.fn(),
        showWarningMessage: vi.fn(),
        showErrorMessage: vi.fn(),
        showInformationMessage: vi.fn(),
        showTextDocument: vi.fn(),
        showInputBox: vi.fn(),
        activeTextEditor: undefined,
        createOutputChannel: vi.fn(() => ({ appendLine: vi.fn() })),
        tabGroups: { all: [] },
    },
    workspace: {
        workspaceFolders: [{ uri: { fsPath: "/workspace", path: "/workspace" } }],
        openTextDocument: vi.fn(async () => ({ languageId: "typescript" })),
        fs: { delete: vi.fn() },
    },
    commands: {
        executeCommand: vi.fn(),
    },
}));

import { GitOps } from "../../src/git/operations";
import type { GitExecutor } from "../../src/git/executor";
import {
    getRepoRelativeFilePathFromUri,
    normalizeGitPath,
} from "../../src/services/diffService";
import { assertRepoRelativePath } from "../../src/utils/fileOps";
import * as path from "path";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockExecutor(responses: Record<string, string> = {}): GitExecutor {
    const run = vi.fn(async (args: string[]) => {
        const key = args.join(" ");
        for (const [pattern, response] of Object.entries(responses)) {
            if (key.includes(pattern)) return response;
        }
        return "";
    });
    return { run } as unknown as GitExecutor;
}

function createThrowingExecutor(): GitExecutor {
    return {
        run: vi.fn(async () => {
            throw new Error("not a git repository");
        }),
    } as unknown as GitExecutor;
}

// Minimal vscode.Uri stub for getRepoRelativeFilePathFromUri tests.
function fakeFileUri(fsPathValue: string): { scheme: string; fsPath: string } {
    return { scheme: "file", fsPath: fsPathValue };
}

// ---------------------------------------------------------------------------
// GitOps.getRepositoryRoot
// ---------------------------------------------------------------------------

describe("GitOps.getRepositoryRoot", () => {
    it("returns trimmed output of git rev-parse --show-toplevel", async () => {
        const executor = createMockExecutor({
            "rev-parse --show-toplevel": "/root/client\n",
        });
        const ops = new GitOps(executor);
        const root = await ops.getRepositoryRoot();
        expect(root).toBe("/root/client");
    });

    it("returns correct root when workspace is a subfolder", async () => {
        const executor = createMockExecutor({
            "rev-parse --show-toplevel": "/root/client\n",
        });
        const ops = new GitOps(executor);
        const root = await ops.getRepositoryRoot();
        expect(root).toBe("/root/client");
        expect(root).not.toBe("/root/client/project2");
    });

    it("handles trailing whitespace and newlines", async () => {
        const executor = createMockExecutor({
            "rev-parse --show-toplevel": "  /some/path  \n\n",
        });
        const ops = new GitOps(executor);
        const root = await ops.getRepositoryRoot();
        expect(root).toBe("/some/path");
    });

    it("propagates errors for non-git directories", async () => {
        const executor = createThrowingExecutor();
        const ops = new GitOps(executor);
        await expect(ops.getRepositoryRoot()).rejects.toThrow("not a git repository");
    });

    it("handles Windows-style paths", async () => {
        const executor = createMockExecutor({
            "rev-parse --show-toplevel": "C:/Users/dev/project\n",
        });
        const ops = new GitOps(executor);
        const root = await ops.getRepositoryRoot();
        expect(root).toBe("C:/Users/dev/project");
    });

    it("calls executor with correct arguments", async () => {
        const executor = createMockExecutor({
            "rev-parse --show-toplevel": "/repo\n",
        });
        const ops = new GitOps(executor);
        await ops.getRepositoryRoot();
        expect(executor.run).toHaveBeenCalledWith(["rev-parse", "--show-toplevel"]);
    });
});

// ---------------------------------------------------------------------------
// Path resolution: repo root vs workspace folder
// ---------------------------------------------------------------------------

describe("path resolution with nested repo structure", () => {
    const gitRoot = "/root/client";
    const workspaceFolder = "/root/client/project2";

    describe("getRepoRelativeFilePathFromUri", () => {
        it("computes correct relative path when using git root", () => {
            const uri = fakeFileUri("/root/client/project2/src/file.ts");
            const result = getRepoRelativeFilePathFromUri(
                uri as Parameters<typeof getRepoRelativeFilePathFromUri>[0],
                gitRoot,
            );
            expect(result).toBe("project2/src/file.ts");
        });

        it("returns null when file is outside the repo root", () => {
            const uri = fakeFileUri("/other/project/file.ts");
            const result = getRepoRelativeFilePathFromUri(
                uri as Parameters<typeof getRepoRelativeFilePathFromUri>[0],
                gitRoot,
            );
            expect(result).toBeNull();
        });

        it("returns null for non-file scheme URIs", () => {
            const uri = { scheme: "untitled", fsPath: "/root/client/file.ts" };
            const result = getRepoRelativeFilePathFromUri(
                uri as Parameters<typeof getRepoRelativeFilePathFromUri>[0],
                gitRoot,
            );
            expect(result).toBeNull();
        });

        it("returns file at repo root level correctly", () => {
            const uri = fakeFileUri("/root/client/README.md");
            const result = getRepoRelativeFilePathFromUri(
                uri as Parameters<typeof getRepoRelativeFilePathFromUri>[0],
                gitRoot,
            );
            expect(result).toBe("README.md");
        });

        it("handles deeply nested files", () => {
            const uri = fakeFileUri("/root/client/project2/src/lib/deep/file.ts");
            const result = getRepoRelativeFilePathFromUri(
                uri as Parameters<typeof getRepoRelativeFilePathFromUri>[0],
                gitRoot,
            );
            expect(result).toBe("project2/src/lib/deep/file.ts");
        });
    });

    describe("path.join with correct git root vs wrong workspace root", () => {
        it("constructs correct disk path from git-relative path using git root", () => {
            const gitRelativePath = "project2/src/file.ts";
            const correctDiskPath = path.join(gitRoot, gitRelativePath);
            expect(correctDiskPath).toBe("/root/client/project2/src/file.ts");
        });

        it("produces doubled path when using workspace folder (the bug)", () => {
            const gitRelativePath = "project2/src/file.ts";
            const wrongDiskPath = path.join(workspaceFolder, gitRelativePath);
            // The doubled path is the exact bug: /root/client/project2/project2/src/file.ts
            expect(wrongDiskPath).toBe("/root/client/project2/project2/src/file.ts");
            expect(wrongDiskPath).not.toBe("/root/client/project2/src/file.ts");
        });

        it("constructs correct path for files in a different subproject", () => {
            // When working from project2 but a file in project5 is changed
            const gitRelativePath = "project5/src/utils.ts";
            const correctDiskPath = path.join(gitRoot, gitRelativePath);
            expect(correctDiskPath).toBe("/root/client/project5/src/utils.ts");
        });
    });
});

// ---------------------------------------------------------------------------
// assertRepoRelativePath validation
// ---------------------------------------------------------------------------

describe("assertRepoRelativePath with nested paths", () => {
    it("accepts paths with subfolder prefixes", () => {
        expect(assertRepoRelativePath("project2/src/file.ts")).toBe("project2/src/file.ts");
    });

    it("accepts simple filenames", () => {
        expect(assertRepoRelativePath("file.ts")).toBe("file.ts");
    });

    it("rejects absolute paths", () => {
        expect(() => assertRepoRelativePath("/root/client/file.ts")).toThrow(
            "Rejected non-relative path",
        );
    });

    it("rejects path traversal", () => {
        expect(() => assertRepoRelativePath("../outside/file.ts")).toThrow(
            "Rejected path escaping repo root",
        );
    });

    it("rejects empty string", () => {
        expect(() => assertRepoRelativePath("")).toThrow("Rejected non-relative path");
    });

    it("rejects paths with null bytes", () => {
        expect(() => assertRepoRelativePath("file\0.ts")).toThrow(
            "Rejected path containing control characters",
        );
    });

    it("rejects paths with newlines", () => {
        expect(() => assertRepoRelativePath("file\n.ts")).toThrow(
            "Rejected path containing control characters",
        );
    });

    it("rejects dot-only path (repo root reference)", () => {
        expect(() => assertRepoRelativePath(".")).toThrow("Rejected repo root path");
    });
});

// ---------------------------------------------------------------------------
// normalizeGitPath
// ---------------------------------------------------------------------------

describe("normalizeGitPath", () => {
    it("leaves forward-slash paths unchanged on Unix", () => {
        if (path.sep === "/") {
            expect(normalizeGitPath("project2/src/file.ts")).toBe("project2/src/file.ts");
        }
    });

    it("handles nested subfolder paths", () => {
        if (path.sep === "/") {
            expect(normalizeGitPath("project2/packages/core/index.ts")).toBe(
                "project2/packages/core/index.ts",
            );
        }
    });
});

// ---------------------------------------------------------------------------
// Bootstrap flow: isRepository + getRepositoryRoot
// ---------------------------------------------------------------------------

describe("bootstrap flow for nested subfolder", () => {
    it("discovers repo root after confirming it is a repository", async () => {
        const executor = createMockExecutor({
            "rev-parse --is-inside-work-tree": "true",
            "rev-parse --show-toplevel": "/root/client\n",
        });
        const ops = new GitOps(executor);

        const isRepo = await ops.isRepository();
        expect(isRepo).toBe(true);

        const root = await ops.getRepositoryRoot();
        expect(root).toBe("/root/client");
    });

    it("isRepository returns true even from a subfolder", async () => {
        const executor = createMockExecutor({
            "rev-parse --is-inside-work-tree": "true",
        });
        const ops = new GitOps(executor);
        expect(await ops.isRepository()).toBe(true);
    });

    it("two-phase bootstrap uses discovered root, not workspace folder", async () => {
        const bootstrapExecutor = createMockExecutor({
            "rev-parse --is-inside-work-tree": "true",
            "rev-parse --show-toplevel": "/root/client\n",
        });
        const bootstrapOps = new GitOps(bootstrapExecutor);

        const repoRoot = await bootstrapOps.getRepositoryRoot();
        expect(repoRoot).toBe("/root/client");
        expect(repoRoot).not.toBe("/root/client/project2");
    });

    it("isRepository returns false for non-git directories", async () => {
        const executor = createThrowingExecutor();
        const ops = new GitOps(executor);
        expect(await ops.isRepository()).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// Edge cases for repo root discovery
// ---------------------------------------------------------------------------

describe("repo root discovery edge cases", () => {
    it("handles repo root same as workspace folder (no nesting)", async () => {
        const executor = createMockExecutor({
            "rev-parse --show-toplevel": "/myproject\n",
        });
        const ops = new GitOps(executor);
        const root = await ops.getRepositoryRoot();
        expect(root).toBe("/myproject");
    });

    it("handles repo root that is parent of workspace by multiple levels", async () => {
        const executor = createMockExecutor({
            "rev-parse --show-toplevel": "/root/client\n",
        });
        const ops = new GitOps(executor);
        const root = await ops.getRepositoryRoot();
        expect(root).toBe("/root/client");

        const gitRelativePath = "project2/packages/core/index.ts";
        const diskPath = path.join(root, gitRelativePath);
        expect(diskPath).toBe("/root/client/project2/packages/core/index.ts");
    });

    it("handles paths with spaces", async () => {
        const executor = createMockExecutor({
            "rev-parse --show-toplevel": "/Users/dev/My Projects/client\n",
        });
        const ops = new GitOps(executor);
        const root = await ops.getRepositoryRoot();
        expect(root).toBe("/Users/dev/My Projects/client");
    });

    it("handles bare repo root at filesystem root", async () => {
        const executor = createMockExecutor({
            "rev-parse --show-toplevel": "/\n",
        });
        const ops = new GitOps(executor);
        const root = await ops.getRepositoryRoot();
        expect(root).toBe("/");
    });
});
