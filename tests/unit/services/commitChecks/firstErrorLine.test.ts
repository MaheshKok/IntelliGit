import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({ l10n: { t: (message: string) => message } }));

import { CI_EXCERPT_MAX_BYTES, CI_EXCERPT_MAX_LINES } from "../../../../src/shared/ci/excerpt";
import {
    buildCiLogExcerpt,
    findFirstErrorLine,
} from "../../../../src/services/commitChecks/firstErrorLine";
import { GitHubProvider } from "../../../../src/services/commitChecks/githubProvider";
import { GitLabProvider } from "../../../../src/services/commitChecks/gitlabProvider";
import type { CredentialStore } from "../../../../src/services/commitChecks/credentialStore";

const LOGS = join(__dirname, "../../../fixtures/commitChecks/logs");

const GITHUB = { patterns: [/##\[error\]/], stepStart: "##[group]Run tests" };

describe("findFirstErrorLine", () => {
    it("pattern, then step fallback, then last line", () => {
        const withMarker = [
            "##[group]Set up job",
            "build failed earlier in a warning",
            "##[group]Run tests",
            "1 test failed",
            "##[error]Process completed with exit code 1.",
            "cleanup",
        ].join("\n");
        expect(findFirstErrorLine(withMarker, GITHUB)).toBe(4);

        // No provider marker: the first error word after the failing step's start line.
        const withoutMarker = [
            "##[group]Set up job",
            "an error in setup that is not the failure",
            "##[group]Run tests",
            "ok 1",
            "Tests FAILED: 2",
            "done",
        ].join("\n");
        expect(findFirstErrorLine(withoutMarker, GITHUB)).toBe(4);

        // Nothing matches: the last line, ignoring the trailing newline.
        expect(findFirstErrorLine("one\ntwo\nthree\n", GITHUB)).toBe(2);
    });

    it("never picks the failing step's own start line when its name holds an error word", () => {
        const text = [
            "##[group]Set up job",
            "##[group]Handle failed jobs",
            "ok 1",
            "Error: boom",
        ].join("\n");
        expect(
            findFirstErrorLine(text, { patterns: [], stepStart: "##[group]Handle failed jobs" }),
            "the step's output, not its name",
        ).toBe(3);
    });

    it("searches the whole log for the error word when the step start is unknown", () => {
        const text = "setup\nERROR in compile\nlater error";
        expect(findFirstErrorLine(text, { patterns: [] })).toBe(1);
    });

    it("matches a multiline-anchored pattern on its own line", () => {
        const text = "Running\nnot an ERROR: here\nERROR: Job failed: exit code 1\n";
        expect(findFirstErrorLine(text, { patterns: [/^ERROR: /m] })).toBe(2);
    });

    it("an empty log opens at line 0", () => {
        expect(findFirstErrorLine("", { patterns: [] }), "empty log").toBe(0);
        expect(findFirstErrorLine("\n", { patterns: [] }), "a lone newline").toBe(0);
    });

    it("a log ending in several blank lines opens on its last line with text", () => {
        expect(
            findFirstErrorLine("one\ntwo\n\n\n", { patterns: [] }),
            "trailing blank lines must not become the fallback line",
        ).toBe(1);
        expect(findFirstErrorLine("\n\n", { patterns: [] }), "only blank lines").toBe(0);
    });

    it("a global pattern does not skip lines through its lastIndex", () => {
        const text = "x ##[error]a\n##[error]b";
        const rules = { patterns: [/##\[error\]/g] };
        expect(findFirstErrorLine(text, rules)).toBe(0);
        expect(findFirstErrorLine(text, rules)).toBe(0);
    });
});

describe("provider error markers", () => {
    it("first error line from GitHub and GitLab fixtures", () => {
        // Each fixture has an earlier "failed" line the generic fallback would pick instead.
        const github = readFileSync(join(LOGS, "github-job.log"), "utf8");
        const githubRules = { patterns: new GitHubProvider().firstErrorPatterns };
        expect(github.split("\n")[13]).toContain("##[error]Process completed with exit code 1.");
        expect(findFirstErrorLine(github, githubRules), "GitHub ##[error] line").toBe(13);

        // GitLab writes the job's verdict after a section marker and a colour code on one line.
        const gitlab = readFileSync(join(LOGS, "gitlab-trace.log"), "utf8");
        const gitlabRules = {
            patterns: new GitLabProvider(vi.fn(), {} as CredentialStore).firstErrorPatterns,
        };
        expect(gitlab.split("\n")[13]).toContain("ERROR: Job failed: exit code 1");
        expect(findFirstErrorLine(gitlab, gitlabRules), "GitLab ERROR: line").toBe(13);
    });
});

describe("buildCiLogExcerpt", () => {
    it("shows the lines around the first error, bounded and sanitised", () => {
        const lines = Array.from({ length: 200 }, (_, index) => `line ${index}`);
        lines[120] = "\u001b[31m##[error]boom\u001b[0m";
        const excerpt = buildCiLogExcerpt(lines.join("\n"), 120);
        const shown = excerpt.split("\n");
        expect(shown.length).toBeLessThanOrEqual(CI_EXCERPT_MAX_LINES);
        expect(shown).toContain("##[error]boom");
        expect(shown[0]).toBe("line 115");
    });

    it("stays within 8 KB for huge lines and keeps the error line in view", () => {
        const text = `${"x".repeat(100_000)}\nerror here\n${"y".repeat(100_000)}`;
        const excerpt = buildCiLogExcerpt(text, 1);
        expect(Buffer.byteLength(excerpt, "utf8")).toBeLessThanOrEqual(CI_EXCERPT_MAX_BYTES);
        expect(excerpt.startsWith("error here")).toBe(true);
    });

    it("budgets the sanitised context, so control characters cannot push the error line out", () => {
        // 1-byte control characters become 3-byte U+FFFD: 2 x 2000 raw bytes fit, 2 x 6000 do not.
        const control = "\u0001".repeat(2000);
        const excerpt = buildCiLogExcerpt(`${control}\n${control}\nerror here`, 2);
        expect(Buffer.byteLength(excerpt, "utf8")).toBeLessThanOrEqual(CI_EXCERPT_MAX_BYTES);
        expect(excerpt, "the error line must stay in the excerpt").toContain("error here");
    });
});
