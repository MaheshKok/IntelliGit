import { describe, expect, it, vi } from "vitest";

const FLAG = "INTELLIGIT_SKIP_TIMING_BUDGETS";

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
