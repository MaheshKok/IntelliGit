import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "../../..");

/**
 * Converts one `.vscodeignore` line into a matcher for repo-root basenames.
 *
 * A leading globstar segment is stripped first. vsce matches these lines with minimatch, where a
 * globstar spans zero or more path segments, so the entry that excludes every `.config.ts` at any
 * depth also excludes a root-level `vitest.config.ts`. Treating every pattern containing a slash
 * as a directory reference would make this test blind to the entry that actually does the
 * excluding, and would report a correct `.vscodeignore` as a packaging hole. Any remaining slash
 * does address a directory rather than a root file and never matches here. Beyond that only the
 * `*` wildcard is interpreted.
 */
function rootPatternMatcher(pattern: string): (basename: string) => boolean {
    const rootScoped = pattern.startsWith("**/") ? pattern.slice(3) : pattern;
    if (rootScoped.includes("/")) return () => false;
    const source = `^${rootScoped
        .split("*")
        .map((literal) => literal.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
        .join("[^/]*")}$`;
    const expression = new RegExp(source);
    return (basename) => expression.test(basename);
}

function ignorePatterns(): readonly string[] {
    return readFileSync(path.join(REPO_ROOT, ".vscodeignore"), "utf8")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith("#"));
}

function rootConfigFiles(): readonly string[] {
    return readdirSync(REPO_ROOT, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith(".config.ts"))
        .map((entry) => entry.name)
        .sort();
}

describe("published package excludes root test-runner configuration", () => {
    // Without this the suite below is vacuous the day the configs move or are renamed away.
    it("finds root-level .config.ts files to check", () => {
        expect(rootConfigFiles().length).toBeGreaterThan(0);
    });

    // Deliberately every `*.config.ts`, not an enumeration of `vitest`/`playwright`. The literal
    // entry `vitest.config.ts` already shipped `vitest.flow-negative.config.ts` into the .vsix once
    // -- an enumerated pattern gates only the names someone remembered, and the sibling Playwright
    // entry had already been widened to a glob for exactly this reason (see .vscodeignore).
    it.each(rootConfigFiles())("excludes %s from the published extension", (basename) => {
        const matched = ignorePatterns().filter((pattern) => rootPatternMatcher(pattern)(basename));
        expect(
            matched,
            `${basename} is at the repository root and would be packaged into the .vsix; ` +
                `no .vscodeignore pattern matches it`,
        ).not.toEqual([]);
    });
});
