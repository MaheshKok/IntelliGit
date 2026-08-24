import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

const FLAG = "INTELLIGIT_SKIP_TIMING_BUDGETS";

const REPOSITORY_ROOT = resolve(__dirname, "../../..");

/** Reads one file from the repository root, so the declaration is read rather than assumed. */
function readRepositoryFile(relativePath: string): string {
    return readFileSync(resolve(REPOSITORY_ROOT, relativePath), "utf8");
}

/**
 * Narrows a workflow to one step's own block, so a declaration on a different step -- or the
 * flag named in a comment -- cannot satisfy an assertion about this one.
 */
function stepBlock(workflow: string, stepName: string): string {
    const start = workflow.indexOf(`- name: ${stepName}\n`);
    if (start === -1) return "";
    const next = workflow.indexOf("\n            - name: ", start + 1);
    return next === -1 ? workflow.slice(start) : workflow.slice(start, next);
}

async function applyWith(flag: string | undefined): Promise<boolean> {
    const previous = process.env[FLAG];
    if (flag === undefined) {
        delete process.env[FLAG];
    } else {
        process.env[FLAG] = flag;
    }
    vi.resetModules();
    try {
        return (await import("../../helpers/timingBudgets")).timingBudgetsApply;
    } finally {
        if (previous === undefined) {
            delete process.env[FLAG];
        } else {
            process.env[FLAG] = previous;
        }
    }
}

describe("wall-clock budget gate", () => {
    it("asserts when the invoker says nothing, so a new run path keeps the gate", async () => {
        // The fail-safe direction is the whole point. A worker cannot see `--coverage`
        // (argv, env, and execArgv are identical either way), so an unset flag has to mean
        // "assert" -- otherwise a run path added later drops the gate with nothing red.
        expect(await applyWith(undefined), "unset must keep asserting").toBe(true);
    });

    it("suspends only for the exact value the coverage script exports", async () => {
        expect(await applyWith("1"), "`1` must suspend").toBe(false);
    });

    it("keeps asserting for every other value, including an empty export", async () => {
        for (const value of ["", "0", "true", "yes"]) {
            expect(await applyWith(value), `${JSON.stringify(value)} must keep asserting`).toBe(
                true,
            );
        }
    });
});

// The other half of the fail-safe direction above. `timingBudgetsApply` defaults to asserting,
// so every run path that is NOT the calibration host has to say so itself -- and a declaration
// that lives only in a YAML step or an npm script has nothing watching it. Both of these have
// already been at risk once: the `test:coverage` prefix sat on the exact line a `main` merge
// deleted as dead vitest thread pins, and the workflow declaration is a step-level `env:` block
// that any reordering edit can drop. Neither loss turns anything red on the calibration host --
// it turns CI red instead, one push later, against hardware the number was never measured on.
describe("wall-clock budget gate: the invokers that suspend it", () => {
    it("declares the flag on the compatibility workflow's own test step", () => {
        const workflow = readRepositoryFile(".github/workflows/compatibility.yml");
        const block = stepBlock(workflow, "Run tests");

        expect(block, "the compatibility workflow must still have a `Run tests` step").not.toBe("");
        expect(
            block,
            "this matrix runs on shared ubuntu/macos/windows runners, none of which is the host the budgets in `src/diff/diffBudgets.ts` were measured on -- the same commit read 6,555.914 ms against a 5,613 ms target here while the macOS leg passed",
        ).toContain(`${FLAG}: "1"`);
        expect(
            block,
            "the declaration has to sit on the step that actually runs the suite, not on a neighbour",
        ).toContain("bun run test");
    });

    it("declares the flag on the coverage script that cannot be detected from a worker", () => {
        const manifest = readRepositoryFile("package.json");
        const coverage = (JSON.parse(manifest) as { scripts: Record<string, string> }).scripts[
            "test:coverage"
        ];

        expect(
            coverage,
            "a v8-instrumented run is several times slower than the run the budgets were measured against, and a worker cannot see `--coverage` for itself: argv, env, and execArgv are identical either way, so the script is the only place that knows",
        ).toContain(`${FLAG}=1`);
    });
});
