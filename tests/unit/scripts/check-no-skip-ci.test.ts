/**
 * Spec-derived tests for the CI-skip guard script. Expected behavior is derived
 * from GitHub's documented skip-token contract -- the bracketed `[skip ci]`,
 * `[ci skip]`, `[no ci]`, `[skip actions]`, and `[actions skip]` family, matched
 * case-insensitively -- not from the implementation. These tests exist to catch
 * regressions in the guard that prevents a squash merge from carrying a skip
 * token into main and silently suppressing the deploy.
 *
 * If GitHub's matching is ever found to be more lenient than the exact documented
 * tokens (e.g. tolerating inner whitespace), both the guard regex and the
 * non-match cases below must widen together.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
    containsSkipDirective,
    findOffenders,
    getCommitMessages,
} from "../../../scripts/check-no-skip-ci.js";

describe("containsSkipDirective: recognized GitHub skip tokens", () => {
    it.each(["[skip ci]", "[ci skip]", "[no ci]", "[skip actions]", "[actions skip]"])(
        "flags the canonical token %s",
        (token) => {
            expect(containsSkipDirective(token)).toBe(true);
        },
    );

    it.each(["[SKIP CI]", "[Skip Ci]", "[Ci Skip]", "[NO CI]", "[Skip Actions]"])(
        "is case-insensitive for %s",
        (token) => {
            expect(containsSkipDirective(token)).toBe(true);
        },
    );

    it("flags a token embedded in a longer single-line message", () => {
        expect(containsSkipDirective("chore: tidy things up [skip ci] before release")).toBe(true);
    });

    it("flags a token that appears only on a later line of a multi-line body", () => {
        const message =
            "feat: add widget\n\nLong description spanning\nseveral lines.\n\n[ci skip]";
        expect(containsSkipDirective(message)).toBe(true);
    });

    it("flags a token directly adjacent to other characters", () => {
        // GitHub matches the bracketed token as a substring regardless of neighbors.
        expect(containsSkipDirective("wip[skip ci]done")).toBe(true);
    });
});

describe("containsSkipDirective: text that must NOT be flagged", () => {
    it.each(["skip ci", "ci skip", "no ci", "skip actions"])(
        "does not flag the unbracketed phrase %s",
        (phrase) => {
            expect(containsSkipDirective(phrase)).toBe(false);
        },
    );

    it.each([
        "fix flaky ci pipeline",
        "skip the broken cache step",
        "feat(ci): add workflow_dispatch trigger",
        "refactor: continuous integration cleanup",
    ])("does not flag normal prose containing the words: %s", (message) => {
        expect(containsSkipDirective(message)).toBe(false);
    });

    it.each(["[skip-ci]", "[ci-skip]", "[ skip ci ]", "[skip  ci]", "[skipci]"])(
        "does not flag near-miss formatting %s (not a GitHub token)",
        (nearMiss) => {
            expect(containsSkipDirective(nearMiss)).toBe(false);
        },
    );

    it.each(["[skip tests]", "[ci]", "[skip]", "[actions]"])(
        "does not flag unrelated bracketed tokens %s",
        (bracketed) => {
            expect(containsSkipDirective(bracketed)).toBe(false);
        },
    );

    it("does not flag an unbalanced bracket fragment", () => {
        expect(containsSkipDirective("note: [skip ci is not closed")).toBe(false);
        expect(containsSkipDirective("note: skip ci] is not opened")).toBe(false);
    });
});

describe("containsSkipDirective: empty / non-string inputs", () => {
    it("returns false for an empty string", () => {
        expect(containsSkipDirective("")).toBe(false);
    });

    it("returns false for a whitespace-only string", () => {
        expect(containsSkipDirective("   \n\t  ")).toBe(false);
    });

    it.each([null, undefined, 0, 42, true, {}, [], ["[skip ci]"]])(
        "returns false for the non-string input %s",
        (value) => {
            expect(containsSkipDirective(value as unknown as string)).toBe(false);
        },
    );
});

describe("findOffenders", () => {
    it("returns an empty array when title, body, and all commits are clean", () => {
        const offenders = findOffenders({
            prTitle: "feat: add manual dispatch",
            prBody: "Adds a workflow_dispatch trigger.",
            commitMessages: ["feat: a", "fix: b", "chore: c"],
        });
        expect(offenders).toEqual([]);
    });

    it("flags a token in the PR title (the default squash subject)", () => {
        const offenders = findOffenders({
            prTitle: "feat: ship it [skip ci]",
            prBody: "clean body",
            commitMessages: ["feat: a"],
        });
        expect(offenders).toEqual(["PR title: feat: ship it [skip ci]"]);
    });

    it("flags a token in the PR body", () => {
        const offenders = findOffenders({
            prTitle: "clean title",
            prBody: "please [ci skip] for now",
            commitMessages: ["feat: a"],
        });
        expect(offenders).toEqual(["PR body"]);
    });

    it("flags a token that appears only in an intermediate commit (the bug this guard prevents)", () => {
        const offenders = findOffenders({
            prTitle: "clean title",
            prBody: "clean body",
            commitMessages: ["feat: a", "fix: b [skip ci]", "chore: c"],
        });
        expect(offenders).toEqual(["commit: fix: b [skip ci]"]);
    });

    it("identifies an offending commit by its subject when the token is in the body", () => {
        const offenders = findOffenders({
            prTitle: "clean title",
            prBody: "clean body",
            commitMessages: ["feat: add thing\n\ndetails here\n[no ci]"],
        });
        expect(offenders).toEqual(["commit: feat: add thing"]);
    });

    it("collects every offender in title, body, then commit order", () => {
        const offenders = findOffenders({
            prTitle: "release [skip ci]",
            prBody: "and [ci skip] too",
            commitMessages: ["feat: clean", "fix: dirty [no ci]"],
        });
        expect(offenders).toEqual([
            "PR title: release [skip ci]",
            "PR body",
            "commit: fix: dirty [no ci]",
        ]);
    });

    it("returns an empty array when there are no commits and clean metadata", () => {
        const offenders = findOffenders({
            prTitle: "clean title",
            prBody: "clean body",
            commitMessages: [],
        });
        expect(offenders).toEqual([]);
    });
});

describe("getCommitMessages: integration against a real repository", () => {
    // Exercises the actual git boundary (no mocking) so a regression in the
    // `--format=%B%x00` string or the NUL split is caught -- the parsing that a
    // prior space-based separator got wrong by fragmenting multi-line messages.
    let repoDir: string;
    let baseSha: string;

    const git = (args: string[]): string =>
        execFileSync("git", args, { cwd: repoDir, encoding: "utf8" }).trim();

    beforeAll(() => {
        repoDir = mkdtempSync(join(tmpdir(), "skip-ci-guard-"));
        git(["init", "-q", "-b", "main"]);
        git(["config", "user.email", "guard@test.local"]);
        git(["config", "user.name", "Guard Test"]);
        git(["config", "commit.gpgsign", "false"]);

        git(["commit", "-q", "--allow-empty", "-m", "chore: init base"]);
        baseSha = git(["rev-parse", "HEAD"]);

        git(["commit", "-q", "--allow-empty", "-m", "feat: alpha feature"]);
        // Intermediate commit with a multi-line body whose token sits on a later
        // line -- the real-world shape of the bug this guard exists to catch.
        git([
            "commit",
            "-q",
            "--allow-empty",
            "-m",
            "fix: bravo bug",
            "-m",
            "Body paragraph one.",
            "-m",
            "[skip ci]",
        ]);
        git(["commit", "-q", "--allow-empty", "-m", "chore: charlie  with  wide  spaces"]);
    });

    afterAll(() => {
        rmSync(repoDir, { recursive: true, force: true });
    });

    it("returns exactly one entry per commit in the exclusive base..head range", () => {
        const messages = getCommitMessages(baseSha, "HEAD", repoDir);
        expect(messages).toHaveLength(3);
    });

    it("keeps a multi-line commit body as a single entry (NUL split, not whitespace)", () => {
        const messages = getCommitMessages(baseSha, "HEAD", repoDir);
        const bravo = messages.find((message) => message.startsWith("fix: bravo bug"));
        expect(bravo).toBeDefined();
        expect(bravo).toContain("Body paragraph one.");
        expect(bravo).toContain("[skip ci]");
    });

    it("does not fragment a subject that contains runs of multiple spaces", () => {
        const messages = getCommitMessages(baseSha, "HEAD", repoDir);
        expect(messages).toContain("chore: charlie  with  wide  spaces");
    });

    it("flags an intermediate offending commit end to end via findOffenders", () => {
        const messages = getCommitMessages(baseSha, "HEAD", repoDir);
        const offenders = findOffenders({
            prTitle: "feat: clean title",
            prBody: "clean body",
            commitMessages: messages,
        });
        expect(offenders).toEqual(["commit: fix: bravo bug"]);
    });

    it("returns an empty array for an empty (base..base) range", () => {
        const messages = getCommitMessages(baseSha, baseSha, repoDir);
        expect(messages).toEqual([]);
    });
});
