// Tests for bug fixes and security hardening identified during the
// full codebase audit. Each describe block maps to a specific audit
// finding ID and tests the fix from the spec/contract, not the
// implementation.

import { describe, it, expect, vi, beforeEach } from "vitest";

// --- SEC-H1 / Fix 5: Pure JS branch/tag name validation ---
// Contract: isValidBranchName/isValidTagName must match git check-ref-format
// rules without spawning a subprocess, with stricter branch-name rejection for
// command/refspec metacharacters used by IntelliGit Git operations. Rules documented at:
// https://git-scm.com/docs/git-check-ref-format

vi.mock("vscode", () => ({
    window: {
        showQuickPick: vi.fn(),
        showWarningMessage: vi.fn(),
        showInformationMessage: vi.fn(),
        showErrorMessage: vi.fn(),
    },
    commands: {
        executeCommand: vi.fn(),
    },
}));

import { isValidBranchName, isValidTagName, isHashMatch } from "../../src/services/gitHelpers";

describe("isValidBranchName — git check-ref-format rules (SEC-H1)", () => {
    // --- Valid names ---
    it("accepts simple alphanumeric names", () => {
        expect(isValidBranchName("main")).toBe(true);
        expect(isValidBranchName("develop")).toBe(true);
    });

    it("accepts names with slashes (hierarchical)", () => {
        expect(isValidBranchName("feature/auth")).toBe(true);
        expect(isValidBranchName("release/v1.0/hotfix")).toBe(true);
    });

    it("accepts names with dots, dashes, underscores", () => {
        expect(isValidBranchName("v1.0.0")).toBe(true);
        expect(isValidBranchName("my-branch")).toBe(true);
        expect(isValidBranchName("my_branch")).toBe(true);
    });

    it("accepts single character name", () => {
        expect(isValidBranchName("x")).toBe(true);
    });

    // --- git check-ref-format rule violations ---
    it("rejects empty string", () => {
        expect(isValidBranchName("")).toBe(false);
    });

    it("rejects names starting with a dash", () => {
        expect(isValidBranchName("-bad")).toBe(false);
    });

    it("rejects names starting with a plus to avoid refspec force semantics", () => {
        expect(isValidBranchName("+main")).toBe(false);
    });

    it("rejects names starting with a dot", () => {
        expect(isValidBranchName(".hidden")).toBe(false);
    });

    it("rejects names ending with a dot", () => {
        expect(isValidBranchName("bad.")).toBe(false);
    });

    it("rejects names ending with a slash", () => {
        expect(isValidBranchName("bad/")).toBe(false);
    });

    it("rejects names ending with .lock", () => {
        expect(isValidBranchName("branch.lock")).toBe(false);
    });

    it("rejects names containing double dots", () => {
        expect(isValidBranchName("a..b")).toBe(false);
    });

    it("rejects names containing double slashes", () => {
        expect(isValidBranchName("a//b")).toBe(false);
    });

    it("accepts the bare @ symbol (valid per git check-ref-format)", () => {
        expect(isValidBranchName("@")).toBe(true);
    });

    it("accepts @ within a ref component", () => {
        expect(isValidBranchName("feature/user@2")).toBe(true);
        expect(isValidBranchName("release/@team")).toBe(true);
    });

    it("rejects names containing space", () => {
        expect(isValidBranchName("my branch")).toBe(false);
    });

    it("rejects names containing tilde", () => {
        expect(isValidBranchName("branch~1")).toBe(false);
    });

    it("rejects names containing caret", () => {
        expect(isValidBranchName("branch^2")).toBe(false);
    });

    it("rejects names containing colon", () => {
        expect(isValidBranchName("branch:name")).toBe(false);
    });

    it("rejects names containing question mark", () => {
        expect(isValidBranchName("branch?")).toBe(false);
    });

    it("rejects names containing asterisk", () => {
        expect(isValidBranchName("branch*")).toBe(false);
    });

    it("rejects names containing open bracket", () => {
        expect(isValidBranchName("branch[0]")).toBe(false);
    });

    it("rejects names containing backslash", () => {
        expect(isValidBranchName("branch\\name")).toBe(false);
    });

    it("rejects names containing control characters (null byte)", () => {
        expect(isValidBranchName("branch\x00name")).toBe(false);
    });

    it("rejects names containing control characters (tab)", () => {
        expect(isValidBranchName("branch\tname")).toBe(false);
    });

    it("rejects names containing DEL character (0x7f)", () => {
        expect(isValidBranchName("branch\x7fname")).toBe(false);
    });

    it("rejects names containing @{ sequence", () => {
        expect(isValidBranchName("branch@{0}")).toBe(false);
    });

    it("rejects names exceeding 255 characters", () => {
        expect(isValidBranchName("a".repeat(256))).toBe(false);
    });

    it("accepts names at exactly 255 characters", () => {
        expect(isValidBranchName("a".repeat(255))).toBe(true);
    });

    it("rejects component starting with dot in hierarchical name", () => {
        expect(isValidBranchName("feature/.hidden")).toBe(false);
    });

    it("rejects component ending with .lock in hierarchical name", () => {
        expect(isValidBranchName("feature/name.lock")).toBe(false);
    });

    it("rejects empty component (double slash)", () => {
        expect(isValidBranchName("feature//name")).toBe(false);
    });
});

describe("isValidTagName — git check-ref-format rules (SEC-H1)", () => {
    it("accepts standard tag names", () => {
        expect(isValidTagName("v1.0.0")).toBe(true);
        expect(isValidTagName("release-2024")).toBe(true);
    });

    it("rejects empty string", () => {
        expect(isValidTagName("")).toBe(false);
    });

    it("rejects names with invalid characters (same rules as branch)", () => {
        expect(isValidTagName("tag name")).toBe(false);
        expect(isValidTagName("tag..name")).toBe(false);
        expect(isValidTagName(".tag")).toBe(false);
    });
});

// --- SEC-L1 / Fix 15: isHashMatch prefix collision safety ---

describe("isHashMatch — full-length hash exact equality (SEC-L1)", () => {
    it("returns true for identical full-length hashes", () => {
        const hash = "a".repeat(40);
        expect(isHashMatch(hash, hash)).toBe(true);
    });

    it("returns false for different full-length hashes", () => {
        const a = "a".repeat(40);
        const b = "a".repeat(39) + "b";
        expect(isHashMatch(a, b)).toBe(false);
    });

    it("still uses prefix matching when one hash is short", () => {
        const full = "abc1234567890abcdef1234567890abcdef123456";
        expect(isHashMatch("abc1234", full)).toBe(true);
    });

    it("does not match short hashes with different prefixes", () => {
        expect(isHashMatch("abc1234", "def5678")).toBe(false);
    });

    // Mutation test: if we removed the length===40 guard, this test
    // would still pass because prefix matching handles it. But the
    // full-length guard prevents O(n) prefix scan for the common case.
    it("returns true for two identical 7-char short hashes", () => {
        expect(isHashMatch("abc1234", "abc1234")).toBe(true);
    });
});

// --- SEC-M1 / Fix 7: assertRepoRelativePath null byte rejection ---

describe("assertRepoRelativePath — control character rejection (SEC-M1)", () => {
    let assertRepoRelativePath: (filePath: string) => string;

    beforeEach(async () => {
        vi.resetModules();
        vi.doMock("vscode", () => ({
            window: { showErrorMessage: vi.fn() },
            workspace: { fs: { delete: vi.fn() } },
            Uri: {
                joinPath: (_root: unknown, filePath: string) => ({
                    fsPath: `/repo/${filePath}`,
                }),
            },
        }));
        vi.doMock("../../src/git/operations", () => ({}));
        const mod = await import("../../src/utils/fileOps");
        assertRepoRelativePath = mod.assertRepoRelativePath;
    });

    it("rejects paths containing null byte", () => {
        expect(() => assertRepoRelativePath("foo\x00bar")).toThrow("control characters");
    });

    it("rejects paths containing carriage return", () => {
        expect(() => assertRepoRelativePath("foo\rbar")).toThrow("control characters");
    });

    it("rejects paths containing newline", () => {
        expect(() => assertRepoRelativePath("foo\nbar")).toThrow("control characters");
    });

    it("still rejects path traversal with ..", () => {
        expect(() => assertRepoRelativePath("../secret")).toThrow("escaping repo root");
    });

    it("still rejects absolute paths", () => {
        expect(() => assertRepoRelativePath("/etc/passwd")).toThrow("non-relative path");
    });

    it("accepts valid relative paths", () => {
        expect(assertRepoRelativePath("src/index.ts")).toBe("src/index.ts");
    });

    it("rejects empty string", () => {
        expect(() => assertRepoRelativePath("")).toThrow("non-relative path");
    });
});

// --- SEC-M3 / Fix 14: Error message credential sanitization ---

describe("getErrorMessage — credential sanitization (SEC-M3)", () => {
    let getErrorMessage: (error: unknown) => string;

    beforeEach(async () => {
        vi.resetModules();
        const mod = await import("../../src/utils/errors");
        getErrorMessage = mod.getErrorMessage;
    });

    it("strips user:password credentials from error messages", () => {
        const err = new Error("fatal: https://user:s3cret@github.com/repo.git not found");
        const result = getErrorMessage(err);
        expect(result).not.toContain("s3cret");
        expect(result).not.toContain("user:");
        expect(result).toContain("***@github.com");
    });

    it("strips token-only credentials (e.g. GitHub PAT)", () => {
        const msg = "fatal: https://ghp_abc123token@github.com/repo.git not found";
        const result = getErrorMessage(new Error(msg));
        expect(result).not.toContain("ghp_abc123token");
        expect(result).toContain("***@github.com");
    });

    it("strips empty-password credentials (user:@host)", () => {
        const msg = "failed: https://admin:@gitlab.com/project.git";
        const result = getErrorMessage(new Error(msg));
        expect(result).not.toContain("admin:");
        expect(result).toContain("***@gitlab.com");
    });

    it("preserves messages without credentials", () => {
        const msg = "fatal: repository not found";
        expect(getErrorMessage(new Error(msg))).toBe(msg);
    });

    it("preserves URLs without user-info", () => {
        const msg = "fatal: https://github.com/repo.git not found";
        expect(getErrorMessage(new Error(msg))).toBe(msg);
    });

    it("handles non-Error values", () => {
        expect(getErrorMessage("string error")).toBe("string error");
        expect(getErrorMessage(42)).toBe("42");
        expect(getErrorMessage(null)).toBe("null");
    });

    it("handles multiple credential URLs in one message", () => {
        const msg = "fetch https://a:b@host1.com and push https://c:d@host2.com failed";
        const result = getErrorMessage(new Error(msg));
        expect(result).not.toContain("a:b@");
        expect(result).not.toContain("c:d@");
    });
});

// --- BUG-M2 / Fix 12: buildResultContent empty file fix ---

describe("buildResultContent — empty file edge case (BUG-M2)", () => {
    let buildResultContent: typeof import("../../src/webviews/react/merge-editor/mergeState").buildResultContent;

    beforeEach(async () => {
        vi.resetModules();
        const mod = await import("../../src/webviews/react/merge-editor/mergeState");
        buildResultContent = mod.buildResultContent;
    });

    it("returns empty string when all segments resolve to empty lines", () => {
        const data = {
            filePath: "test.ts",
            oursLabel: "HEAD",
            theirsLabel: "feature",
            segments: [
                {
                    type: "conflict" as const,
                    id: 0,
                    changeKind: "conflict" as const,
                    oursLines: [],
                    theirsLines: [],
                    baseLines: [],
                },
            ],
            eol: "\n" as const,
            hasTrailingNewline: true,
        };
        // With hasTrailingNewline=true and all empty segments, should get ""
        // not "\n" (which would be a spurious trailing newline)
        expect(buildResultContent(data, { 0: "none" })).toBe("");
    });

    it("returns empty string when no segments exist", () => {
        const data = {
            filePath: "empty.ts",
            oursLabel: "HEAD",
            theirsLabel: "feature",
            segments: [],
            eol: "\n" as const,
            hasTrailingNewline: true,
        };
        expect(buildResultContent(data, {})).toBe("");
    });

    it("still adds trailing newline when lines exist", () => {
        const data = {
            filePath: "test.ts",
            oursLabel: "HEAD",
            theirsLabel: "feature",
            segments: [{ type: "common" as const, lines: ["hello"] }],
            eol: "\n" as const,
            hasTrailingNewline: true,
        };
        expect(buildResultContent(data, {})).toBe("hello\n");
    });

    it("uses CRLF eol when specified", () => {
        const data = {
            filePath: "test.ts",
            oursLabel: "HEAD",
            theirsLabel: "feature",
            segments: [{ type: "common" as const, lines: ["a", "b"] }],
            eol: "\r\n" as const,
            hasTrailingNewline: true,
        };
        expect(buildResultContent(data, {})).toBe("a\r\nb\r\n");
    });
});

// --- BUG-C1 / Fix 2: conflictParser loop guard ---

describe("parseConflictVersions — pure insertion hunks on both sides (BUG-C1)", () => {
    let parseConflictVersions: typeof import("../../src/mergeEditor/conflictParser").parseConflictVersions;

    beforeEach(async () => {
        vi.resetModules();
        const mod = await import("../../src/mergeEditor/conflictParser");
        parseConflictVersions = mod.parseConflictVersions;
    });

    it("does not hang on both-sides pure insertion at same position", () => {
        // base: "line1\nline2"
        // ours: "line1\nINSERTED_OURS\nline2"
        // theirs: "line1\nINSERTED_THEIRS\nline2"
        // This triggers the pure-insertion (baseStart===baseEnd) codepath
        // for both sides at the same base line.
        const base = "line1\nline2";
        const ours = "line1\nINSERTED_OURS\nline2";
        const theirs = "line1\nINSERTED_THEIRS\nline2";

        // Should complete without infinite loop (timeout would catch it)
        const segments = parseConflictVersions(base, ours, theirs);
        expect(segments.length).toBeGreaterThan(0);

        // The insertions should create a conflict segment
        const conflicts = segments.filter((s) => s.type === "conflict");
        expect(conflicts.length).toBeGreaterThanOrEqual(1);
    });

    it("handles empty base with insertions on both sides", () => {
        const base = "";
        const ours = "new-ours";
        const theirs = "new-theirs";

        const segments = parseConflictVersions(base, ours, theirs);
        expect(segments.length).toBeGreaterThan(0);
    });

    it("handles identical insertions on both sides as common", () => {
        const base = "line1\nline2";
        const ours = "line1\nSAME\nline2";
        const theirs = "line1\nSAME\nline2";

        const segments = parseConflictVersions(base, ours, theirs);
        // When both sides insert the same text, it should be treated as common
        const conflicts = segments.filter((s) => s.type === "conflict");
        expect(conflicts.length).toBe(0);
    });
});

// --- SEC-M2 / Fix 6: --fixed-strings in getLog --grep ---
// Tests for this fix are in gitops.test.ts alongside the existing getLog tests.
