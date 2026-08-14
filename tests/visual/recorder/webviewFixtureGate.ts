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
 *
 * Phase 2c-iv-a: `WebviewFixtureRecorderEntry.record` now takes a scenario-specific
 * `ScenarioWorkspace` (`tests/fixtures/repo/scenarios.ts`) rather than one `FixtureTemplate` every
 * entry shared -- a fixture's committed path segment (its `scenario`) and the repository state it
 * was recorded against are the same typed field now, so a `clean.json` recorded against a dirty
 * workspace stops being representable. This gate is what turns that per-entry `scenario` id into an
 * actual workspace: it prepares each DISTINCT scenario id at most once (reused across every entry
 * that declares it -- preparing is a real `git`/`ShelfService` build, not free) and disposes every
 * one it prepared in a `finally`, so a recorder that throws still leaves no scratch directory
 * behind.
 */

import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
    REPOSITORY_SCENARIOS,
    type RepositoryScenarioId,
    type ScenarioWorkspace,
} from "../../fixtures/repo/scenarios";
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

// ---------------------------------------------------------------------------------------------
// Scenario preparation and disposal -- Phase 2c-iv-a.
// ---------------------------------------------------------------------------------------------

/**
 * Allocates a fresh scratch destination and runs `prepare` into it, removing the directory again if
 * `prepare` rejects.
 *
 * That failure path is the whole reason this is its own exported function rather than four lines
 * inside {@link prepareRealScenario}. `mkdtemp` creates the directory BEFORE `prepare` runs, and a
 * rejected `prepare` never returns a `ScenarioWorkspace`, so it never reaches `scenarios.prepared`
 * -- and `disposeAllScenarioWorkspaces` iterates only that map. Nothing else on any path would ever
 * remove the directory, so every failed preparation leaked one scratch tree for the rest of the
 * machine's uptime. Proving that from `runWebviewFixtureGate` is impossible: the gate's own
 * `prepareScenario` option REPLACES this allocation wholesale, so an injected rejecting scenario
 * exercises the caller's `mkdtemp`, not this one, and the real code path stays untested. Taking
 * `prepare` as a parameter is what makes the failure directly reachable.
 *
 * Removal is best-effort (`force: true`) so a cleanup failure cannot replace the real preparation
 * error with a misleading one -- the error the caller needs is always the one `prepare` threw. A
 * scratch `HOME` the builder may have created before failing is NOT recoverable from here (its path
 * is only ever reported through the `ScenarioWorkspace` that never got returned), so it is left to
 * the OS temp reaper; only the path this function itself allocated is its to remove.
 */
export async function prepareIntoScratchDestination(
    id: RepositoryScenarioId,
    prepare: (destination: string) => Promise<ScenarioWorkspace>,
): Promise<ScenarioWorkspace> {
    const destination = await mkdtemp(
        path.join(tmpdir(), `intelligit-webview-gate-scenario-${id}-`),
    );
    try {
        return await prepare(destination);
    } catch (error) {
        await rm(destination, { recursive: true, force: true });
        throw error;
    }
}

/**
 * The production `prepareScenario`: looks up `id` in `REPOSITORY_SCENARIOS` and builds it into a
 * fresh scratch directory. Not exported -- `runWebviewFixtureGate`'s `prepareScenario` option is
 * the only way a caller reaches (or replaces) this.
 */
async function prepareRealScenario(id: RepositoryScenarioId): Promise<ScenarioWorkspace> {
    const scenario = REPOSITORY_SCENARIOS.find((candidate) => candidate.id === id);
    if (scenario === undefined) {
        throw new Error(`webviewFixtureGate: no RepositoryScenario is registered for id "${id}".`);
    }
    return prepareIntoScratchDestination(id, (destination) => scenario.prepare(destination));
}

/**
 * Removes everything one prepared `ScenarioWorkspace` owns. `scenarios.ts` builds every
 * workspace's `root` at `<destination>/workspace` (see its `toWorkspace` helper and
 * `prepareEmptyRepo`), so `path.dirname(workspace.root)` recovers the destination directory the
 * gate itself passed to `prepare()`, without that path having to be threaded back separately.
 * `home`, though, is NOT nested under that destination: `seed.ts`'s `createSanitizedGitEnv`, called
 * with no `homeParent` override -- which is what every scenario builder does -- creates it directly
 * under the OS temp root, a SIBLING of `destination`, not a child. Removing only the destination
 * would therefore leave every scratch `HOME` behind; both paths are removed explicitly here.
 *
 * BOTH paths are guarded by {@link assertDisposableScenarioPath} -- see its own doc comment for why
 * the derivation is checked rather than trusted. `home` is guarded too, not just the derived
 * destination: it arrives verbatim from `prepare()`, so it is if anything less constrained than the
 * value this function computes itself, and it feeds the same recursive `rm`.
 */
async function disposeScenarioWorkspace(workspace: ScenarioWorkspace): Promise<void> {
    const destination = path.dirname(workspace.root);
    assertDisposableScenarioPath(destination, workspace.id, "destination");
    assertDisposableScenarioPath(workspace.home, workspace.id, "home");
    await rm(destination, { recursive: true, force: true });
    await rm(workspace.home, { recursive: true, force: true });
}

/**
 * Every path prefix a scenario's disposable paths may legitimately sit under. Both are the OS temp
 * root: `tmpdir()` as Node reports it, and its realpath. On macOS `tmpdir()` is `/var/folders/...`,
 * a symlink to `/private/var/folders/...`; `mkdtemp` returns the UNRESOLVED form (it just joins
 * onto `tmpdir()`) while anything that round-trips through the filesystem comes back resolved.
 * Accepting only one of the two would make this guard reject the gate's own real destinations on
 * that platform -- so both spellings of the one directory are accepted, and nothing else is.
 * Resolved once at module load: this is a fixed property of the machine, and keeping the check
 * itself free of filesystem access is what lets it be proven by direct call.
 */
const DISPOSABLE_TEMP_ROOTS: readonly string[] = Array.from(
    new Set([path.resolve(tmpdir()), path.resolve(realpathSync(tmpdir()))]),
);

/** True when `child` is strictly BENEATH `parent` -- equal paths are not contained, which is what
 * keeps the OS temp root itself from passing. Purely lexical on already-resolved paths: no `..`
 * segment survives `path.relative` between two resolved paths except as a leading escape, and a
 * relative result that is absolute (a different Windows drive) is not containment either. */
function isStrictlyContainedIn(parent: string, child: string): boolean {
    const relative = path.relative(parent, child);
    return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/**
 * Throws unless `candidate` is a path this gate may recursively delete: it must live strictly
 * beneath the OS temp root.
 *
 * Two different unsafe values reach `disposeScenarioWorkspace`, and containment is what covers
 * both. The derived one: it recovers a workspace's destination as `path.dirname(workspace.root)`,
 * correct only because every scenario builder places its root at `<destination>/workspace`
 * (`seed.ts:150`, and `scenarios.ts`'s `toWorkspace` / `prepareEmptyRepo`). That is a convention,
 * not something the type system enforces -- a future builder returning a root sitting directly AT
 * its destination makes the derivation resolve one level too high, to the OS temp root, and the
 * `rm(..., { recursive: true })` stops being a cleanup and becomes an unrecoverable delete of every
 * other process's scratch state. The supplied one: `runWebviewFixtureGate`'s `prepareScenario`
 * option is injectable, so `workspace.root` and `workspace.home` are whatever a scenario returns.
 * A scenario rooted anywhere in the repository -- `<repoRoot>/tests/workspace`, say -- yielded a
 * `path.dirname` of `<repoRoot>/tests`, which the earlier "is it the temp root or a filesystem
 * root?" check waved through and the `rm` below then deleted, tracked files and all. Rejecting
 * exactly two named paths is a denylist; what the `rm` needs is the allowlist, so the check is
 * containment, not inequality.
 *
 * `role` names which of the two paths failed, because they are recovered differently and the fix
 * differs accordingly -- a bad `destination` means the `<destination>/workspace` convention broke,
 * while a bad `home` means a scenario builder returned a `HOME` it did not create under `tmpdir()`.
 *
 * The decision lives here, split out from the removal, for a specific testing reason: a test that
 * proved this guard by handing the real `disposeScenarioWorkspace` a dangerous path would, on the
 * RED run where the guard is absent, actually perform that delete. A guard whose failing test is
 * catastrophic cannot be honestly proven. Split out, it is proven by calling it directly -- it
 * either throws or it does not, and nothing is ever removed to find out.
 */
export function assertDisposableScenarioPath(
    candidate: string,
    scenarioId: RepositoryScenarioId,
    role: "destination" | "home",
): void {
    const resolved = path.resolve(candidate);
    if (DISPOSABLE_TEMP_ROOTS.some((root) => isStrictlyContainedIn(root, resolved))) {
        return;
    }
    throw new Error(
        `webviewFixtureGate: refusing to recursively remove ${role} "${candidate}" while disposing ` +
            `the "${scenarioId}" scenario -- it does not resolve to a path strictly beneath the OS ` +
            `temp root (${DISPOSABLE_TEMP_ROOTS.join(" or ")}). A scenario must build its ` +
            'destination and its scratch HOME under `tmpdir()`, and must place its root at ' +
            '"<destination>/workspace" so `path.dirname(workspace.root)` recovers that destination; ' +
            "if either changed, thread the real path through explicitly instead of deriving it.",
    );
}

/** Disposes every workspace this run prepared, best-effort: one failed removal does not stop the
 * rest from being attempted, so a single bad `rm` cannot silently leave every workspace after it on
 * disk. Collected failures are re-thrown together afterward so a caller still finds out. */
async function disposeAllScenarioWorkspaces(
    workspaces: ReadonlyMap<RepositoryScenarioId, ScenarioWorkspace>,
): Promise<void> {
    const failures: unknown[] = [];
    for (const workspace of workspaces.values()) {
        try {
            await disposeScenarioWorkspace(workspace);
        } catch (error) {
            failures.push(error);
        }
    }
    if (failures.length > 0) {
        throw new Error(
            `webviewFixtureGate: failed to dispose ${failures.length} of ${workspaces.size} ` +
                `prepared scenario workspace(s): ${failures.map(String).join("; ")}`,
        );
    }
}

/** Lazily prepares and memoizes one `ScenarioWorkspace` per distinct id: the first entry that
 * declares `id` triggers `prepareScenario(id)`, and every later entry sharing `id` reuses that same
 * result instead of preparing again. A registry entry whose committed fixture is simply missing
 * (and `update` is off) never calls `.get` at all -- see the loop in `runWebviewFixtureGate` below
 * -- so a scenario nothing actually needs to record against is never built, preserving the existing
 * "a missing-fixture finding must never call record()" contract `throwingRegistryEntry`-style tests
 * rely on. */
function scenarioWorkspaceCache(
    prepareScenario: (id: RepositoryScenarioId) => Promise<ScenarioWorkspace>,
): {
    readonly get: (id: RepositoryScenarioId) => Promise<ScenarioWorkspace>;
    readonly prepared: Map<RepositoryScenarioId, ScenarioWorkspace>;
} {
    const prepared = new Map<RepositoryScenarioId, ScenarioWorkspace>();
    const pending = new Map<RepositoryScenarioId, Promise<ScenarioWorkspace>>();
    return {
        prepared,
        get: (id: RepositoryScenarioId): Promise<ScenarioWorkspace> => {
            let promise = pending.get(id);
            if (promise === undefined) {
                promise = prepareScenario(id).then((workspace) => {
                    prepared.set(id, workspace);
                    return workspace;
                });
                pending.set(id, promise);
            }
            return promise;
        },
    };
}

/** One entry's registry-to-disk half: reads the committed bytes (if any), decides
 * missing/mismatch/clean, and -- only when it actually needs to compare or repair, never for a
 * plain "missing, not updating" report -- prepares (or reuses, via `scenarios`) that entry's
 * scenario workspace to call `entry.record`. Returns the finding to report, or `undefined` when
 * the entry is already clean or was just repaired in `update` mode. */
async function reconcileRegistryEntry(
    entry: WebviewFixtureRecorderEntry,
    repoRoot: string,
    update: boolean,
    scenarios: ScenarioWorkspaceCache,
): Promise<WebviewFixtureGateFinding | undefined> {
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
            return {
                kind: "missing",
                contextId: entry.contextId,
                scenario: entry.scenario,
                path: committedPath,
                detail:
                    `no committed fixture at ${committedPath} -- rerun with ` +
                    `${UPDATE_WEBVIEW_FIXTURES_ENV_VAR}=1 to create it`,
            };
        }
        const workspace = await scenarios.get(entry.scenario);
        await mkdir(path.dirname(committedPath), { recursive: true });
        await writeFile(
            committedPath,
            serializeWebviewFixture(await entry.record(workspace)),
            "utf8",
        );
        return undefined;
    }

    const workspace = await scenarios.get(entry.scenario);
    const freshBytes = serializeWebviewFixture(await entry.record(workspace));
    if (freshBytes === committedBytes) {
        return undefined;
    }
    if (update) {
        await writeFile(committedPath, freshBytes, "utf8");
        return undefined;
    }
    return {
        kind: "mismatch",
        contextId: entry.contextId,
        scenario: entry.scenario,
        path: committedPath,
        detail:
            `${describeFirstDifference(committedBytes, freshBytes)} -- rerun with ` +
            `${UPDATE_WEBVIEW_FIXTURES_ENV_VAR}=1 to accept the fresh recording`,
    };
}

/** The disk-to-registry half: every committed fixture no registry entry claims any more. */
async function findOrphanFindings(
    repoRoot: string,
    registry: readonly WebviewFixtureRecorderEntry[],
): Promise<WebviewFixtureGateFinding[]> {
    const registeredKeys = new Set(registry.map((entry) => `${entry.contextId}/${entry.scenario}`));
    const committedFixtures = await listCommittedFixtures(repoRoot);
    return committedFixtures
        .filter((fixture) => !registeredKeys.has(`${fixture.contextId}/${fixture.scenario}`))
        .map((fixture) => ({
            kind: "orphan" as const,
            contextId: fixture.contextId,
            scenario: fixture.scenario,
            path: fixture.path,
            detail:
                `${fixture.path} has no matching entry in webviewFixtureRegistry.ts -- ` +
                "either register it or delete the stale file",
        }));
}

type ScenarioWorkspaceCache = ReturnType<typeof scenarioWorkspaceCache>;

// ---------------------------------------------------------------------------------------------

/**
 * Runs the full gate: registry-to-disk (a missing committed file, or a fresh recording that no
 * longer matches the committed bytes) followed by disk-to-registry (an orphaned committed file).
 * Never throws for a finding itself -- every drift is collected and returned so a caller can
 * assert on the complete list in one place, rather than catching one exception at a time. A
 * recorder that itself throws is not a finding, though: it propagates out of this call, same as
 * before this phase's scenario-aware rework.
 *
 * With `update`, the two registry-to-disk cases are REPAIRED instead of reported: the fresh
 * recording is written to the committed path (creating its directory if needed) and no finding is
 * raised. That is this gate's regeneration path -- the one its own "missing" message names -- and
 * it deliberately covers only those two. An orphan is still reported, never deleted: removing a
 * tracked file because an environment variable was set is not regeneration. Regenerated bytes are
 * reviewed the same way a baseline image is, in `git diff`.
 *
 * `prepareScenario` defaults to the real `REPOSITORY_SCENARIOS` lookup (`prepareRealScenario`). It
 * is an injectable seam for tests -- to count preparations, or to hand back a workspace built
 * without a real `git` history -- not a production knob; nothing outside the test tree passes it.
 */
export async function runWebviewFixtureGate(options: {
    readonly repoRoot: string;
    readonly registry: readonly WebviewFixtureRecorderEntry[];
    readonly update?: boolean;
    readonly prepareScenario?: (id: RepositoryScenarioId) => Promise<ScenarioWorkspace>;
}): Promise<WebviewFixtureGateFinding[]> {
    const { repoRoot, registry, update = false, prepareScenario = prepareRealScenario } = options;
    const scenarios = scenarioWorkspaceCache(prepareScenario);

    try {
        const registryFindings: WebviewFixtureGateFinding[] = [];
        for (const entry of registry) {
            const finding = await reconcileRegistryEntry(entry, repoRoot, update, scenarios);
            if (finding !== undefined) {
                registryFindings.push(finding);
            }
        }
        const orphanFindings = await findOrphanFindings(repoRoot, registry);
        return [...registryFindings, ...orphanFindings];
    } finally {
        await disposeAllScenarioWorkspaces(scenarios.prepared);
    }
}
