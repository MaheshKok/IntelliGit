// Tests for pure utility functions in src/services/gitHelpers.ts.

import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, it, expect, vi } from "vitest";

vi.mock("vscode", () => ({
    l10n: {
        t: (message: string) => message,
    },
    ProgressLocation: { Notification: 15 },
    window: {
        showQuickPick: vi.fn(),
        showWarningMessage: vi.fn(),
        showInformationMessage: vi.fn(),
        showErrorMessage: vi.fn(),
        withProgress: vi.fn(async (_options, task) => task({}, {})),
    },
}));

import * as vscode from "vscode";
import {
    isValidGitHash,
    isValidBranchName,
    isHashMatch,
    getLocalNameFromRemote,
    isRebaseablePushRejection,
    promptRebaseAfterPushRejection,
    resolveTrackedRemoteBranch,
    resolveRemoteDeleteTarget,
    checkoutBranch,
    buildCommitFilePatch,
} from "../../../src/services/gitHelpers";
import type { Branch } from "../../../src/types";
import type { GitOps } from "../../../src/git/operations";
import type { GitExecutor } from "../../../src/git/executor";

function makeBranch(overrides: Partial<Branch> = {}): Branch {
    return {
        name: "main",
        hash: "abc1234",
        isRemote: false,
        isCurrent: false,
        ahead: 0,
        behind: 0,
        ...overrides,
    };
}

beforeEach(() => {
    vi.clearAllMocks();
});

describe("isValidGitHash", () => {
    it("accepts 7-char hex hash", () => {
        expect(isValidGitHash("abc1234")).toBe(true);
    });

    it("accepts 40-char full hash", () => {
        expect(isValidGitHash("a".repeat(40))).toBe(true);
    });

    it("rejects shorter than 7 chars", () => {
        expect(isValidGitHash("abc12")).toBe(false);
    });

    it("rejects non-hex characters", () => {
        expect(isValidGitHash("ghijklm")).toBe(false);
    });

    it("rejects empty string", () => {
        expect(isValidGitHash("")).toBe(false);
    });

    it("rejects hash longer than 40 chars", () => {
        expect(isValidGitHash("a".repeat(41))).toBe(false);
    });
});

describe("isValidBranchName", () => {
    it("accepts standard branch names", () => {
        expect(isValidBranchName("feature/my-branch")).toBe(true);
        expect(isValidBranchName("main")).toBe(true);
        expect(isValidBranchName("v1.0.0")).toBe(true);
    });

    it("rejects names starting with dash", () => {
        expect(isValidBranchName("-bad")).toBe(false);
    });

    it("rejects names starting with plus to avoid refspec force semantics", () => {
        expect(isValidBranchName("+main")).toBe(false);
    });

    it("rejects empty string", () => {
        expect(isValidBranchName("")).toBe(false);
    });

    it("rejects names with spaces", () => {
        expect(isValidBranchName("my branch")).toBe(false);
    });

    it("allows underscores and dots", () => {
        expect(isValidBranchName("my_branch.test")).toBe(true);
    });
});

describe("isHashMatch", () => {
    it("matches when a is prefix of b", () => {
        expect(isHashMatch("abc1234", "abc1234567890")).toBe(true);
    });

    it("matches when b is prefix of a", () => {
        expect(isHashMatch("abc1234567890", "abc1234")).toBe(true);
    });

    it("matches identical hashes", () => {
        expect(isHashMatch("abc1234", "abc1234")).toBe(true);
    });

    it("does not match different hashes", () => {
        expect(isHashMatch("abc1234", "def5678")).toBe(false);
    });
});

describe("getLocalNameFromRemote", () => {
    it("strips single remote prefix", () => {
        expect(getLocalNameFromRemote("origin/main")).toBe("main");
    });

    it("preserves slashes in branch name", () => {
        expect(getLocalNameFromRemote("origin/feature/my-branch")).toBe("feature/my-branch");
    });
});

describe("checkoutBranch", () => {
    it("checks out local branches normally", async () => {
        const executor = { run: vi.fn(async () => "") } as unknown as GitExecutor;

        await expect(
            checkoutBranch(makeBranch({ name: "feature/x" }), [], executor),
        ).resolves.toEqual({
            kind: "checkedOut",
            branch: "feature/x",
        });

        expect(executor.run).toHaveBeenCalledWith(["checkout", "feature/x"]);
    });

    it("returns an open-worktree signal instead of checking out a branch from another worktree", async () => {
        const executor = { run: vi.fn(async () => "") } as unknown as GitExecutor;

        await expect(
            checkoutBranch(
                makeBranch({
                    name: "feature/x",
                    isCheckedOutInWorktree: true,
                    isCurrentWorktree: false,
                    worktreePath: "/repo-feature",
                }),
                [],
                executor,
            ),
        ).resolves.toEqual({
            kind: "openWorktree",
            branch: "feature/x",
            path: "/repo-feature",
        });

        expect(executor.run).not.toHaveBeenCalled();
    });

    it("returns an open-worktree signal for remote branches with an existing local checkout elsewhere", async () => {
        const executor = { run: vi.fn(async () => "") } as unknown as GitExecutor;
        const currentBranches = [
            makeBranch({
                name: "feature/x",
                isCheckedOutInWorktree: true,
                isCurrentWorktree: false,
                worktreePath: "/repo-feature",
            }),
        ];

        await expect(
            checkoutBranch(
                makeBranch({ name: "origin/feature/x", isRemote: true }),
                currentBranches,
                executor,
            ),
        ).resolves.toEqual({
            kind: "openWorktree",
            branch: "feature/x",
            path: "/repo-feature",
        });

        expect(executor.run).not.toHaveBeenCalled();
    });

    it("rejects option-like local branch names before invoking git", async () => {
        const executor = { run: vi.fn(async () => "") } as unknown as GitExecutor;

        await expect(
            checkoutBranch(makeBranch({ name: "--upload-pack=/tmp/pwn" }), [], executor),
        ).rejects.toThrow("Invalid branch name");

        expect(executor.run).not.toHaveBeenCalled();
    });

    it("rejects option-like remote branch local names before invoking git", async () => {
        const executor = { run: vi.fn(async () => "") } as unknown as GitExecutor;

        await expect(
            checkoutBranch(
                makeBranch({ name: "origin/--upload-pack=/tmp/pwn", isRemote: true }),
                [],
                executor,
            ),
        ).rejects.toThrow("Invalid local branch name");

        expect(executor.run).not.toHaveBeenCalled();
    });
});

describe("push rejection rebase prompt", () => {
    const rejection = new Error(
        [
            "! [rejected] main -> main (fetch first)",
            "error: failed to push some refs to 'https://example.com/repo.git'",
            "hint: Updates were rejected because the remote contains work that you do not have locally.",
        ].join("\n"),
    );

    it("detects non-fast-forward push rejections", () => {
        expect(isRebaseablePushRejection(rejection)).toBe(true);
    });

    it("does not detect hook or permission push failures", () => {
        expect(
            isRebaseablePushRejection(
                new Error("remote: pre-receive hook declined\nerror: failed to push some refs"),
            ),
        ).toBe(false);
    });

    it("runs pull --rebase and retries push when the user selects Rebase and Push", async () => {
        vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce(
            "Rebase and Push" as never,
        );
        const gitOps = {
            pullRebase: vi.fn(async () => "ok"),
        } as unknown as GitOps;
        const retryPush = vi.fn(async () => undefined);

        await expect(promptRebaseAfterPushRejection(rejection, gitOps, retryPush)).resolves.toBe(
            true,
        );

        expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
            expect.stringContaining("Push rejected"),
            { modal: true },
            "Rebase and Push",
        );
        expect(gitOps.pullRebase).toHaveBeenCalledTimes(1);
        expect(retryPush).toHaveBeenCalledTimes(1);
        expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
            expect.stringContaining("Rebased and pushed"),
        );
    });

    it("returns false without rebasing when the user dismisses the prompt", async () => {
        vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce(undefined as never);
        const gitOps = {
            pullRebase: vi.fn(async () => "ok"),
        } as unknown as GitOps;
        const retryPush = vi.fn(async () => undefined);

        await expect(promptRebaseAfterPushRejection(rejection, gitOps, retryPush)).resolves.toBe(
            false,
        );

        expect(gitOps.pullRebase).not.toHaveBeenCalled();
        expect(retryPush).not.toHaveBeenCalled();
    });

    it("returns false and reports an error when push retry fails after rebase", async () => {
        vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce(
            "Rebase and Push" as never,
        );
        const gitOps = {
            pullRebase: vi.fn(async () => "ok"),
        } as unknown as GitOps;
        const retryPush = vi.fn(async () => {
            throw new Error("push failed");
        });

        await expect(promptRebaseAfterPushRejection(rejection, gitOps, retryPush)).resolves.toBe(
            false,
        );

        expect(gitOps.pullRebase).toHaveBeenCalledTimes(1);
        expect(retryPush).toHaveBeenCalledTimes(1);
        expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
        expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
            expect.stringContaining("push failed"),
        );
    });

    it("returns false without prompting for unrelated errors", async () => {
        const gitOps = {
            pullRebase: vi.fn(async () => "ok"),
        } as unknown as GitOps;
        const retryPush = vi.fn(async () => undefined);

        await expect(
            promptRebaseAfterPushRejection(new Error("permission denied"), gitOps, retryPush),
        ).resolves.toBe(false);

        expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
        expect(gitOps.pullRebase).not.toHaveBeenCalled();
        expect(retryPush).not.toHaveBeenCalled();
    });
});

describe("resolveTrackedRemoteBranch", () => {
    it("resolves from upstream field", () => {
        const branch = makeBranch({ upstream: "origin/main" });
        const result = resolveTrackedRemoteBranch(branch, []);
        expect(result).toEqual({ remote: "origin", remoteBranch: "main" });
    });

    it("resolves from remote field with matching remote branch", () => {
        const branch = makeBranch({ name: "feature", remote: "origin" });
        const remoteBranch = makeBranch({
            name: "origin/feature",
            isRemote: true,
        });
        const result = resolveTrackedRemoteBranch(branch, [remoteBranch]);
        expect(result).toEqual({ remote: "origin", remoteBranch: "feature" });
    });

    it("resolves via suffix match when exactly one match", () => {
        const branch = makeBranch({ name: "feature" });
        const remoteBranch = makeBranch({
            name: "origin/feature",
            isRemote: true,
        });
        const result = resolveTrackedRemoteBranch(branch, [remoteBranch]);
        expect(result).toEqual({ remote: "origin", remoteBranch: "feature" });
    });

    it("returns null when multiple suffix matches exist", () => {
        const branch = makeBranch({ name: "feature" });
        const remotes = [
            makeBranch({ name: "origin/feature", isRemote: true }),
            makeBranch({ name: "upstream/feature", isRemote: true }),
        ];
        const result = resolveTrackedRemoteBranch(branch, remotes);
        expect(result).toBeNull();
    });

    it("returns null when no match found", () => {
        const branch = makeBranch({ name: "feature" });
        const result = resolveTrackedRemoteBranch(branch, []);
        expect(result).toBeNull();
    });

    it("returns null for unsafe upstream remote or branch names", () => {
        expect(
            resolveTrackedRemoteBranch(makeBranch({ upstream: "--receive-pack/main" }), []),
        ).toBeNull();
        expect(
            resolveTrackedRemoteBranch(
                makeBranch({ upstream: "origin/--upload-pack=/tmp/pwn" }),
                [],
            ),
        ).toBeNull();
        expect(resolveTrackedRemoteBranch(makeBranch({ upstream: "origin/+main" }), [])).toBeNull();
    });
});

describe("resolveRemoteDeleteTarget", () => {
    it("resolves remote branch from remote branch object", () => {
        const branch = makeBranch({
            name: "origin/feature",
            isRemote: true,
            remote: "origin",
        });
        const result = resolveRemoteDeleteTarget(branch);
        expect(result).toEqual({ remote: "origin", remoteBranch: "feature" });
    });

    it("falls back to parsing name when remote not set", () => {
        const branch = makeBranch({
            name: "upstream/release/v2",
            isRemote: true,
        });
        const result = resolveRemoteDeleteTarget(branch);
        expect(result).toEqual({ remote: "upstream", remoteBranch: "release/v2" });
    });

    it("returns null for local branches", () => {
        const branch = makeBranch({ isRemote: false });
        const result = resolveRemoteDeleteTarget(branch);
        expect(result).toBeNull();
    });

    it("returns null for single-part name", () => {
        const branch = makeBranch({ name: "main", isRemote: true });
        const result = resolveRemoteDeleteTarget(branch);
        expect(result).toBeNull();
    });

    it("returns null for unsafe remote delete targets", () => {
        expect(
            resolveRemoteDeleteTarget(
                makeBranch({ name: "--receive-pack/feature", isRemote: true }),
            ),
        ).toBeNull();
        expect(
            resolveRemoteDeleteTarget(
                makeBranch({ name: "origin/--upload-pack=/tmp/pwn", isRemote: true }),
            ),
        ).toBeNull();
    });
});

describe("buildCommitFilePatch", () => {
    it("uses literal pathspec mode and -- before validated option-like file paths", async () => {
        const executor = {
            run: vi.fn(async (args: string[]) => {
                if (args[0] === "rev-list") return "abc1234 parent123\n";
                if (args[0] === "--literal-pathspecs" && args[1] === "diff") {
                    return "diff --git a/--weird.txt b/--weird.txt";
                }
                return "";
            }),
        } as unknown as GitExecutor;

        await expect(
            buildCommitFilePatch("abc1234", "--weird.txt", "Apply selected change", executor),
        ).resolves.toContain("--weird.txt");

        expect(executor.run).toHaveBeenCalledWith([
            "--literal-pathspecs",
            "diff",
            "--binary",
            "--full-index",
            "--no-color",
            "parent123",
            "abc1234",
            "--",
            "--weird.txt",
        ]);
    });

    it("treats pathspec magic syntax as a literal commit-file path", async () => {
        if (process.platform === "win32") return;

        const repo = await mkdtemp(path.join(os.tmpdir(), "intelligit-patch-"));
        const git = async (args: string[]): Promise<string> =>
            new Promise((resolve, reject) => {
                execFile("git", args, { cwd: repo, encoding: "utf8" }, (error, stdout, stderr) => {
                    if (error) {
                        reject(new Error(stderr || error.message));
                        return;
                    }
                    resolve(stdout);
                });
            });

        try {
            await git(["init"]);
            await git(["config", "user.email", "test@example.com"]);
            await git(["config", "user.name", "Test User"]);
            await writeFile(path.join(repo, ":(glob)*"), "base magic\n", "utf8");
            await writeFile(path.join(repo, "victim.txt"), "base victim\n", "utf8");
            await git(["add", "."]);
            await git(["commit", "-m", "base"]);
            await writeFile(path.join(repo, ":(glob)*"), "changed magic\n", "utf8");
            await writeFile(path.join(repo, "victim.txt"), "changed victim\n", "utf8");
            await git(["add", "."]);
            await git(["commit", "-m", "change both"]);
            const commitHash = (await git(["rev-parse", "HEAD"])).trim();
            const executor = { run: git } as unknown as GitExecutor;

            const patch = await buildCommitFilePatch(
                commitHash,
                ":(glob)*",
                "Apply selected change",
                executor,
            );

            expect(patch).toContain(":(glob)*");
            expect(patch).not.toContain("victim.txt");
        } finally {
            await rm(repo, { recursive: true, force: true });
        }
    });

    it("rejects invalid commit hashes and traversal file paths before diffing", async () => {
        const executor = {
            run: vi.fn(async () => ""),
        } as unknown as GitExecutor;

        await expect(
            buildCommitFilePatch("not-a-hash", "src/a.ts", "Apply selected change", executor),
        ).rejects.toThrow("Invalid commit hash");
        await expect(
            buildCommitFilePatch("abc1234", "../secret.txt", "Apply selected change", executor),
        ).rejects.toThrow("escaping repo root");

        expect(executor.run).not.toHaveBeenCalled();
    });
});
