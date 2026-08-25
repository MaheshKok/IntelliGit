/**
 * Behavioural test for the `no-restricted-syntax` guard that keeps recursive removals in `tests/`
 * on the retrying helpers.
 *
 * The guard exists because git keeps writing into `.git/objects/pack` after the command that
 * triggered it has returned, so a bare recursive `rm` can lose the race between its `readdir` and
 * its `rmdir` and fail whichever row happens to be executing. Routing 180 call sites through
 * `removeScratchDirectories` fixed the ones that existed; this rule is what stops the next one
 * being written by hand.
 *
 * Asserted behaviourally rather than by reading the selector back out of the config, because the
 * selector is the part that can be wrong. A test that re-derives the selector from the config it
 * is checking would agree with any selector, including one matching nothing at all -- which is the
 * exact failure this file exists to catch, since a rule that matches nothing lints green.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

// Deliberately absent from disk. `lintText` resolves configuration by path without reading the
// file, so this leaves no debris for the repository-wide scans to trip over.
const probePath = path.join(repositoryRoot, "tests", "unit", "recursiveRemovalProbe.ts");

async function reportedLines(body: string): Promise<readonly number[]> {
    const source = `async function probe(): Promise<void> {\n${body}\n}\nvoid probe;\n`;
    const results = await new ESLint({ cwd: repositoryRoot }).lintText(source, {
        filePath: probePath,
    });
    return results
        .flatMap((result) => result.messages)
        .filter((message) => message.ruleId === "no-restricted-syntax")
        .map((message) => message.line);
}

describe("recursive-removal lint guard", () => {
    it.each([
        ["a bare async recursive rm", "    await rm(dir, { recursive: true, force: true });"],
        ["a bare sync recursive rm", "    rmSync(dir, { recursive: true, force: true });"],
        [
            "a recursive rm reached through a namespace",
            "    await fs.rm(dir, { recursive: true });",
        ],
        [
            "a recursive flag this rule cannot read statically",
            "    await rm(dir, { recursive: deep, force: true });",
        ],
    ])("reports %s", async (_label, body) => {
        expect(await reportedLines(body)).toEqual([2]);
    });

    it.each([
        // The regression case: a non-recursive removal has no readdir step to lose, so requiring
        // retries of it would be noise -- and noise is what gets silenced with eslint-disable.
        ["an explicitly non-recursive rm", "    await rm(dir, { recursive: false });"],
        ["a single-file rm with no options", "    await rm(file);"],
        ["a single-file rm that only forces", "    await rm(file, { force: true });"],
        [
            "a recursive rm that already retries",
            "    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });",
        ],
        // `mkdir` carries a `recursive` option too, and shares nothing else with this hazard.
        ["a recursive mkdir", "    await mkdir(dir, { recursive: true });"],
    ])("leaves %s alone", async (_label, body) => {
        expect(await reportedLines(body)).toEqual([]);
    });

    it("reports every offending call rather than only the first", async () => {
        // Vacuity guard. Every "leaves alone" row above passes for a rule that matches nothing at
        // all, so at least one assertion has to pin a count that only a working selector produces.
        const lines = await reportedLines(
            [
                "    await rm(a, { recursive: true, force: true });",
                "    await rm(b, { recursive: false });",
                "    rmSync(c, { recursive: true, force: true });",
            ].join("\n"),
        );
        expect(lines).toEqual([2, 4]);
    });
});
