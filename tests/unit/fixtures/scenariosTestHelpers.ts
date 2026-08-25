/**
 * Shared read-back seam for the `scenarios.*.test.ts` trio -- spec-derived tests for
 * `tests/fixtures/repo/scenarios.ts` (PLAN.md:101, Phase 2c-iii). Every scenario's defining
 * postcondition is checked with a real `git` command (or, for `shelf-populated`, a fresh
 * `ShelfStore` read) run against the built workspace -- never by trusting `prepare()`'s own return
 * value alone -- for the same reason `seed.test.ts` does this: a bug in a scenario builder would
 * otherwise produce a silent false-green fixture for a screen no real user would see
 * (`scenarios.ts`'s own "Governing principle" doc comment).
 *
 * The `git()` helper below is deliberately re-declared rather than imported from
 * `tests/fixtures/repo/gitRun.ts`, mirroring `tests/unit/fixtures/gitTestHelpers.ts`'s own
 * documented reasoning: driving the fixture and reading it back through the SAME internal
 * git-runner the module under test also uses would let a bug in that shared seam hide from every
 * test built on top of it.
 *
 * The suite used to be one file; it is split into three (local states / remote-and-shelf /
 * independence) so the Windows CI shards can spread its git-heavy builds (422s as one file on run
 * 32863905788). The scratch registries below are per test file under vitest's default per-file
 * module isolation; every `scenarios.*.test.ts` registers `afterAll(removeTrackedScratchDirectories)`.
 */

import { execFile } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { expect } from "vitest";

import { removeScratchDirectories } from "../../helpers/scratchDirectories";
import {
    REPOSITORY_SCENARIOS,
    type RepositoryScenarioId,
    type ScenarioWorkspace,
} from "../../fixtures/repo/scenarios";

const execFileAsync = promisify(execFile);

/** Runs one git process and returns trimmed UTF-8 stdout -- the test suite's own independent seam,
 * not `scenarios.ts`'s. */
export async function git(
    cwd: string,
    args: readonly string[],
    env: NodeJS.ProcessEnv,
): Promise<string> {
    const result = await execFileAsync("git", [...args], { cwd, env, encoding: "buffer" });
    return result.stdout.toString("utf8").trim();
}

/** Like `git`, but resolves `false` on a non-zero exit instead of rejecting -- used only for
 * assertions that check whether a git subcommand fails (e.g. `symbolic-ref` on a detached HEAD). */
export async function gitFails(
    cwd: string,
    args: readonly string[],
    env: NodeJS.ProcessEnv,
): Promise<boolean> {
    try {
        await git(cwd, args, env);
        return false;
    } catch {
        return true;
    }
}

const scratchRoots: string[] = [];
const scratchHomes: string[] = [];

/** Allocates a fresh, empty destination under this test file's own scratch root, registered for
 * `afterAll` cleanup. */
export async function allocateDestination(): Promise<string> {
    const parent = await mkdtemp(join(tmpdir(), "intelligit-scenarios-test-"));
    scratchRoots.push(parent);
    return join(parent, "destination");
}

/** Registers scratch HOME directories (one per prepared workspace) for `afterAll` cleanup. */
export function trackScratchHome(...homes: string[]): void {
    scratchHomes.push(...homes);
}

export async function removeTrackedScratchDirectories(): Promise<void> {
    await removeScratchDirectories(...scratchRoots, ...scratchHomes);
}

export function scenarioFor(id: RepositoryScenarioId) {
    const scenario = REPOSITORY_SCENARIOS.find((candidate) => candidate.id === id);
    if (!scenario)
        throw new Error(
            `no REPOSITORY_SCENARIOS entry for "${id}" -- fix the test, not the fixture`,
        );
    return scenario;
}

/** Every scenario's `env`/`home` shape, asserted against the frozen `ScenarioWorkspace` contract
 * rather than inline per test -- typed explicitly so a future scenario that forgets to route
 * through `createSanitizedGitEnv` fails here instead of only in whichever test happens to run
 * first. */
export async function assertNoIdentityLeakage(workspace: ScenarioWorkspace): Promise<void> {
    // The config paths are asserted by CONTENT, not by literal value: `/dev/null` was the literal
    // here for years and is unreadable on Windows (`\\.\nul`), which no equality check could see.
    for (const key of ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM"] as const) {
        const configPath = workspace.env[key];
        expect(configPath, `${key} must be set`).toBeTruthy();
        expect(
            await readFile(configPath as string, "utf8"),
            `${key} must point at a real, EMPTY config file`,
        ).toBe("");
    }
    expect(workspace.env.HOME).toBe(workspace.home);
    expect(workspace.home).not.toBe(process.env.HOME);
}
