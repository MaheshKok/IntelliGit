/**
 * Repo-wide regenerate-and-compare gate (PLAN.md step 13): for every entry in
 * `webviewFixtureRegistry.ts`, re-records the fixture and byte-compares it against the committed
 * file on disk, and separately walks every committed file under `tests/visual/fixtures/` looking
 * for one no registry entry reproduces any more. Both directions matter on their own --
 * `recordCommitInfoWebviewFixture.test.ts`'s own byte-comparison test already proved ONE recorder
 * reproduces its OWN committed fixture; a gate that only walked the registry would never notice a
 * fixture file nobody in the registry claims, and a gate that only walked the filesystem would
 * never notice a registered recording whose committed file went missing entirely.
 *
 * Regenerating, when a change to the extension legitimately moves a recorded payload:
 *
 *     UPDATE_WEBVIEW_FIXTURES=1 npx vitest run tests/unit/visual/recorder/
 *
 * which reruns this gate in update mode and rewrites the committed bytes. Review the resulting
 * `git diff` exactly as you would a new baseline image -- a regenerated fixture is an assertion
 * about what the UI now shows, not a formality.
 *
 * `tests/visual/fixtures/host/` is excluded by name (see {@link NON_WEBVIEW_FIXTURE_DIRS}): it
 * holds Phase 0's THEME fixtures (`dark-modern.json` etc.), captured by an unrelated recorder
 * (`tests/e2e/hostFixtures/`) that predates this registry and is out of this phase's scope.
 */

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { FixtureTemplate } from "../../fixtures/repo/seed";
import { serializeWebviewFixture, webviewFixtureFilePath } from "./webviewFixtureFile";
import type { WebviewFixtureRecorderEntry } from "./webviewFixtureRegistry";

/** Directory name directly under `tests/visual/fixtures/` that is NOT a webview-payload context
 * directory. See this module's own doc comment for why `host` specifically is excluded here.
 * Every other subdirectory is assumed to hold committed webview fixtures and is scanned for
 * orphans -- an unlisted, unregistered directory name is exactly the kind of drift this gate
 * exists to surface, not silently skip. */
const NON_WEBVIEW_FIXTURE_DIRS: ReadonlySet<string> = new Set(["host"]);

/** The environment variable that turns on the regeneration path. Exported so the test that reads
 * it and the findings that name it cannot drift apart into a message pointing at a variable
 * nothing honors -- which is exactly the state this gate shipped in before update mode existed. */
export const UPDATE_WEBVIEW_FIXTURES_ENV_VAR = "UPDATE_WEBVIEW_FIXTURES";

/** What kind of drift one gate finding reports. Not exported -- no consumer needs the union on its
 * own; every caller reaches it through {@link WebviewFixtureGateFinding.kind} instead. */
type WebviewFixtureGateFindingKind = "missing" | "mismatch" | "orphan";

/** One thing the gate found wrong, always naming the exact file on disk it concerns. */
export interface WebviewFixtureGateFinding {
    readonly kind: WebviewFixtureGateFindingKind;
    readonly contextId: string;
    readonly scenario: string;
    readonly path: string;
    readonly detail: string;
}

/**
 * Describes the first line two fixture byte-strings disagree on, so a "mismatch" finding's
 * `detail` points a developer at the actual drift instead of just asserting it exists. Falls back
 * to a line-count comparison when one string is a strict prefix of the other (e.g. a truncated
 * write).
 */
function describeFirstDifference(committed: string, fresh: string): string {
    const committedLines = committed.split("\n");
    const freshLines = fresh.split("\n");
    const sharedLineCount = Math.min(committedLines.length, freshLines.length);
    for (let index = 0; index < sharedLineCount; index += 1) {
        if (committedLines[index] !== freshLines[index]) {
            return (
                `first difference at line ${index + 1}: ` +
                `committed=${JSON.stringify(committedLines[index])} ` +
                `fresh=${JSON.stringify(freshLines[index])}`
            );
        }
    }
    return (
        `committed has ${committedLines.length} lines, a fresh recording has ${freshLines.length} ` +
        "lines -- one is a strict prefix of the other"
    );
}

function isEnoent(error: unknown): boolean {
    return (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "ENOENT"
    );
}

/** Every `<contextId, scenario>` pair backed by a committed `.json` file directly under
 * `tests/visual/fixtures/<contextId>/`, skipping {@link NON_WEBVIEW_FIXTURE_DIRS}. A missing
 * fixtures directory is treated as zero committed files rather than an error -- an isolated
 * caller (a test using a scratch `repoRoot`) may legitimately have none yet. */
async function listCommittedFixtures(
    repoRoot: string,
): Promise<
    ReadonlyArray<{ readonly contextId: string; readonly scenario: string; readonly path: string }>
> {
    const fixturesRoot = path.join(repoRoot, "tests", "visual", "fixtures");
    let contextDirs: readonly string[];
    try {
        contextDirs = (await readdir(fixturesRoot, { withFileTypes: true }))
            .filter((entry) => entry.isDirectory() && !NON_WEBVIEW_FIXTURE_DIRS.has(entry.name))
            .map((entry) => entry.name);
    } catch (error) {
        if (isEnoent(error)) {
            return [];
        }
        throw error;
    }

    const perDir = await Promise.all(
        contextDirs.map(async (contextId) => {
            const contextDir = path.join(fixturesRoot, contextId);
            const files = (await readdir(contextDir)).filter((file) => file.endsWith(".json"));
            return files.map((file) => ({
                contextId,
                scenario: file.slice(0, -".json".length),
                path: path.join(contextDir, file),
            }));
        }),
    );
    return perDir.flat();
}

/**
 * Runs the full gate: registry-to-disk (a missing committed file, or a fresh recording that no
 * longer matches the committed bytes) followed by disk-to-registry (an orphaned committed file).
 * Never throws for a finding itself -- every drift is collected and returned so a caller can
 * assert on the complete list in one place, rather than catching one exception at a time.
 *
 * With `update`, the two registry-to-disk cases are REPAIRED instead of reported: the fresh
 * recording is written to the committed path (creating its directory if needed) and no finding is
 * raised. That is this gate's regeneration path -- the one its own "missing" message names -- and
 * it deliberately covers only those two. An orphan is still reported, never deleted: removing a
 * tracked file because an environment variable was set is not regeneration. Regenerated bytes are
 * reviewed the same way a baseline image is, in `git diff`.
 */
export async function runWebviewFixtureGate(options: {
    readonly repoRoot: string;
    readonly registry: readonly WebviewFixtureRecorderEntry[];
    readonly workspace: FixtureTemplate;
    readonly update?: boolean;
}): Promise<WebviewFixtureGateFinding[]> {
    const { repoRoot, registry, workspace, update = false } = options;
    const findings: WebviewFixtureGateFinding[] = [];

    for (const entry of registry) {
        const committedPath = webviewFixtureFilePath(repoRoot, entry.contextId, entry.scenario);
        let committedBytes: string | undefined;
        try {
            committedBytes = await readFile(committedPath, "utf8");
        } catch (error) {
            if (!isEnoent(error)) {
                throw error;
            }
            committedBytes = undefined;
        }

        if (committedBytes === undefined) {
            if (!update) {
                findings.push({
                    kind: "missing",
                    contextId: entry.contextId,
                    scenario: entry.scenario,
                    path: committedPath,
                    detail:
                        `no committed fixture at ${committedPath} -- rerun with ` +
                        `${UPDATE_WEBVIEW_FIXTURES_ENV_VAR}=1 to create it`,
                });
                continue;
            }
            await mkdir(path.dirname(committedPath), { recursive: true });
            await writeFile(
                committedPath,
                serializeWebviewFixture(await entry.record(workspace)),
                "utf8",
            );
            continue;
        }

        const freshBytes = serializeWebviewFixture(await entry.record(workspace));
        if (freshBytes === committedBytes) {
            continue;
        }
        if (update) {
            await writeFile(committedPath, freshBytes, "utf8");
            continue;
        }
        findings.push({
            kind: "mismatch",
            contextId: entry.contextId,
            scenario: entry.scenario,
            path: committedPath,
            detail:
                `${describeFirstDifference(committedBytes, freshBytes)} -- rerun with ` +
                `${UPDATE_WEBVIEW_FIXTURES_ENV_VAR}=1 to accept the fresh recording`,
        });
    }

    const registeredKeys = new Set(registry.map((entry) => `${entry.contextId}/${entry.scenario}`));
    const committedFixtures = await listCommittedFixtures(repoRoot);
    for (const fixture of committedFixtures) {
        const key = `${fixture.contextId}/${fixture.scenario}`;
        if (!registeredKeys.has(key)) {
            findings.push({
                kind: "orphan",
                contextId: fixture.contextId,
                scenario: fixture.scenario,
                path: fixture.path,
                detail:
                    `${fixture.path} has no matching entry in webviewFixtureRegistry.ts -- ` +
                    "either register it or delete the stale file",
            });
        }
    }

    return findings;
}
