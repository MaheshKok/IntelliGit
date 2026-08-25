/**
 * Shared fixtures for the `webviewFixtureGate.*.test.ts` trio -- spec-derived tests for
 * `tests/visual/recorder/webviewFixtureGate.ts`, PLAN.md step 13's repo-wide regenerate-and-compare
 * gate. Where `recordCommitInfoWebviewFixture.test.ts` proves ONE recorder reproduces its OWN
 * committed fixture, the trio proves the generalization: every entry in
 * `webviewFixtureRegistry.ts`, checked in both directions.
 *
 * One file became three (core / update / disposal) so the Windows CI shards can spread its
 * real-scenario builds (294s as one file on run 32863905788). Each test file keeps its own
 * `vi.mock("vscode", ...)` block: vitest hoists mocks per test file, so a mock declared here would
 * cover nobody.
 */

import { copyFile, mkdir, mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { RepositoryScenarioId, ScenarioWorkspace } from "../../../fixtures/repo/scenarios";
import { COMMIT_INFO_CLEAN_SCENARIO } from "../../../visual/recorder/recordCommitInfoWebviewFixture";
import {
    buildWebviewFixture,
    webviewFixtureFilePath,
} from "../../../visual/recorder/webviewFixtureFile";
import type { WebviewFixtureRecorderEntry } from "../../../visual/recorder/webviewFixtureRegistry";
import type { WebviewFixture } from "../../../visual/recorder/webviewFixtureTypes";

export const REPO_ROOT = path.resolve(__dirname, "../../../..");
export const REAL_FIXTURES_DIR = path.join(REPO_ROOT, "tests", "visual", "fixtures");

/** A real scenario build (`seedFixtureTemplate` plus, for most scenarios, a handful more `git`
 * calls) takes long enough that vitest's default 5s-per-test timeout is not generous enough --
 * this mirrors the 60s the old shared `beforeAll` used for exactly one such build. Every test
 * that lets the gate prepare a REAL "clean" scenario (i.e. does not inject its own
 * `prepareScenario`) passes this as its own timeout.
 *
 * The 60s it used to be was inherited from that `beforeAll` and never measured against the slowest
 * supported platform. Windows runs this work 2-5x slower -- many small `git` calls over many small
 * files -- and `rewrites a drifted fixture` needed 53,835ms of the 60,000 there on run
 * 32654169455, then 60,012ms on the next one, where it timed out (#223). A 10% margin on the
 * slowest leg is a red waiting for an ordinary bad minute, not a budget. What a timeout is for
 * here is catching a HANG, and 180s still does that against a file whose Windows leg totals ~220s
 * either way. */
export const REAL_SCENARIO_TIMEOUT_MS = 180_000;

/** Recursive directory copy, used to mirror the real fixtures tree into a scratch `repoRoot`.
 * Hand-rolled rather than `fs.cp`, which is still flagged experimental on the Node versions this
 * repository supports and would print a warning into every run's output. */
async function copyDirectory(from: string, to: string): Promise<void> {
    await mkdir(to, { recursive: true });
    for (const entry of await readdir(from, { withFileTypes: true })) {
        const source = path.join(from, entry.name);
        const destination = path.join(to, entry.name);
        if (entry.isDirectory()) {
            await copyDirectory(source, destination);
        } else if (entry.isFile()) {
            await copyFile(source, destination);
        }
    }
}

/** A scratch `repoRoot` holding a byte-identical copy of the real fixtures tree. Every test that
 * mutates a fixture, or that lets the gate WRITE one, runs against one of these -- never against
 * the tracked tree. */
export async function scratchRepoRootWithFixtures(label: string): Promise<string> {
    const root = await mkdtemp(path.join(tmpdir(), `intelligit-webview-gate-${label}-`));
    await copyDirectory(REAL_FIXTURES_DIR, path.join(root, "tests", "visual", "fixtures"));
    return root;
}

export function committedBytesInRepo(): Promise<string> {
    return readFile(
        webviewFixtureFilePath(REPO_ROOT, "commit-info", COMMIT_INFO_CLEAN_SCENARIO),
        "utf8",
    );
}

/** A registry entry whose `record` throws if ever invoked -- used by the "missing" test, where a
 * gate that (incorrectly) tried to record before checking the committed file exists would call
 * this and fail for the wrong reason. `scenario` must be a real `RepositoryScenarioId` that has no
 * committed `commit-info` fixture on disk (only "clean.json" is committed -- see the `ls` this
 * phase's own report cites), so the "missing" branch is genuinely exercised rather than
 * short-circuited by a file that happens to already be there. */
export function throwingRegistryEntry(scenario: RepositoryScenarioId): WebviewFixtureRecorderEntry {
    return {
        contextId: "commit-info",
        scenario,
        record: (): Promise<WebviewFixture> => {
            throw new Error(
                `record() must not be called for "${scenario}" -- its committed fixture is ` +
                    "missing, so the gate should report that without ever recording.",
            );
        },
    };
}

/** A registry entry that never touches real `git`, `vscode`, or `workspace.template` -- its
 * `record` returns a trivial, empty-message fixture keyed on `scenario` alone. Used by the
 * scenario-preparation tests, which are about the GATE's prepare-once/dispose-always contract, not
 * about what any one recorder actually captures (`recordCommitInfoWebviewFixture` already covers
 * that, and the `scenarios.*.test.ts` suites cover what a real scenario looks like). */
export function fakeEntry(scenario: RepositoryScenarioId): WebviewFixtureRecorderEntry {
    return {
        contextId: "commit-info",
        scenario,
        record: async () => buildWebviewFixture("commit-info", scenario, []),
    };
}

/** One call an instrumented `prepareScenario` made: real scratch directories (so a disposal
 * assertion has something real to `existsSync` against) without paying for an actual `git` history
 * build. */
export interface FakeScenarioPreparation {
    readonly id: RepositoryScenarioId;
    readonly destination: string;
    readonly home: string;
}

/**
 * Builds a `prepareScenario` that records every call it receives and, for each one, creates real
 * scratch directories shaped exactly like a real `ScenarioWorkspace` -- `root` at
 * `<destination>/workspace`, `home` a SEPARATE scratch directory, matching what `scenarios.ts`'s
 * own builders produce (see `webviewFixtureGate.ts`'s `disposeScenarioWorkspace` doc comment for
 * why `home` is deliberately not nested under `destination`). `template` is always `undefined`:
 * nothing here needs seeded history, and the one test that DOES care about an absent template
 * relies on exactly this.
 */
export function instrumentedPrepareScenario(): {
    readonly prepareScenario: (id: RepositoryScenarioId) => Promise<ScenarioWorkspace>;
    readonly calls: RepositoryScenarioId[];
    readonly preparations: FakeScenarioPreparation[];
} {
    const calls: RepositoryScenarioId[] = [];
    const preparations: FakeScenarioPreparation[] = [];
    const prepareScenario = async (id: RepositoryScenarioId): Promise<ScenarioWorkspace> => {
        calls.push(id);
        const destination = await mkdtemp(
            path.join(tmpdir(), `intelligit-webview-gate-fake-${id}-`),
        );
        const root = path.join(destination, "workspace");
        await mkdir(root, { recursive: true });
        const home = await mkdtemp(path.join(tmpdir(), `intelligit-webview-gate-fake-home-${id}-`));
        preparations.push({ id, destination, home });
        return { id, root, env: process.env, home, template: undefined };
    };
    return { prepareScenario, calls, preparations };
}
