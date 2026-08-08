/**
 * The registry of every recorded webview payload fixture (PLAN.md step 13). Each entry names one
 * resolved host context + scenario a committed fixture under `tests/visual/fixtures/<contextId>/`
 * belongs to, and the function that reproduces it against a freshly prepared scenario workspace
 * (`tests/fixtures/repo/scenarios.ts`). `webviewFixtureGate.ts`'s repo-wide gate iterates this list
 * -- so registering a new context or scenario means adding a DATA entry here, never writing another
 * bespoke test file.
 *
 * Phase 2c-iv-a: `scenario` is typed `RepositoryScenarioId`, not a bare `string`. A fixture's
 * committed path segment IS the repository state it was recorded against, so making both one typed
 * field turns "a fixture named `clean` that was actually recorded against `dirty`" from a bug that
 * has to be found into a state that cannot be represented -- there is no second `scenarioId` field
 * left to disagree with it. `record` is handed the `ScenarioWorkspace` the gate prepared for that
 * exact `scenario` (`webviewFixtureGate.ts` prepares each distinct one at most once and reuses it
 * across every entry that declares it); an entry that needs seeded history (a commit hash, a
 * branch) reads it off `workspace.template`, which is only ever absent for `empty-repo` (see
 * `requireScenarioTemplate` below). `requireScenarioTemplate` itself is not exported: nothing
 * outside this module needs to reuse the guard directly -- `webviewFixtureGate.test.ts` exercises
 * it through the real `commit-info` entry's `record`, the way every consumer actually reaches it.
 */

import type { WebviewContextId } from "../../../src/e2e/webviewCapture";
import type { FixtureTemplate } from "../../fixtures/repo/seed";
import type { RepositoryScenarioId, ScenarioWorkspace } from "../../fixtures/repo/scenarios";
import {
    COMMIT_INFO_CLEAN_SCENARIO,
    recordCommitInfoWebviewFixture,
} from "./recordCommitInfoWebviewFixture";
import {
    COMMIT_GRAPH_CLEAN_SCENARIO,
    recordCommitGraphCardWebviewFixture,
    recordCommitGraphCompactWebviewFixture,
} from "./recordCommitGraphWebviewFixture";
import type { WebviewFixture } from "./webviewFixtureTypes";

/** One registered recording: which committed fixture it produces, and how to reproduce it. */
export interface WebviewFixtureRecorderEntry {
    readonly contextId: WebviewContextId;
    readonly scenario: RepositoryScenarioId;
    readonly record: (workspace: ScenarioWorkspace) => Promise<WebviewFixture>;
}

/**
 * Narrows `workspace.template`, throwing a clear, actionable error -- naming both the failing
 * context and the scenario -- instead of letting an entry's own field access (e.g.
 * `template.commits.conflictBase`) throw an opaque "Cannot read properties of undefined" for the
 * one scenario (`empty-repo`) that genuinely has none. Every entry below that needs seeded history
 * goes through this rather than dereferencing `workspace.template` directly.
 */
function requireScenarioTemplate(
    workspace: ScenarioWorkspace,
    contextId: WebviewContextId,
): FixtureTemplate {
    if (workspace.template === undefined) {
        throw new Error(
            `${contextId}/${workspace.id}: this recording needs a seeded template, but the ` +
                `"${workspace.id}" scenario has none (ScenarioWorkspace.template is undefined).`,
        );
    }
    return workspace.template;
}

/**
 * Every registered recording. Phase 2c-i's `commit-info` / `clean` recorder
 * (`recordCommitInfoWebviewFixture.ts`) is the first entry -- registered here, rather than
 * referenced directly by anything that needs to walk "every recorded fixture", so the repo-wide
 * gate (`webviewFixtureGate.ts`) has exactly one list to iterate. Adding the next context or
 * scenario is adding another object literal to this array.
 */
export const WEBVIEW_FIXTURE_RECORDERS: readonly WebviewFixtureRecorderEntry[] = [
    {
        contextId: "commit-info",
        scenario: COMMIT_INFO_CLEAN_SCENARIO,
        record: (workspace) => {
            const template = requireScenarioTemplate(workspace, "commit-info");
            return recordCommitInfoWebviewFixture({
                repoRoot: template.root,
                commitHash: template.commits.conflictBase,
                roots: { root: template.root, originRoot: template.originRoot, profileDir: "" },
            });
        },
    },
    // Phase 2c-iv-b: `commit-graph-card` and `commit-graph-compact` are the SAME
    // `CommitGraphViewProvider` class constructed with a different `scriptFile` (see
    // `recordCommitGraphWebviewFixture.ts`'s own doc comment) -- both declared here against the
    // same `clean` scenario this module's doc comment already prepares once and reuses.
    {
        contextId: "commit-graph-card",
        scenario: COMMIT_GRAPH_CLEAN_SCENARIO,
        record: (workspace) => {
            const template = requireScenarioTemplate(workspace, "commit-graph-card");
            return recordCommitGraphCardWebviewFixture({
                repoRoot: template.root,
                roots: { root: template.root, originRoot: template.originRoot, profileDir: "" },
            });
        },
    },
    {
        contextId: "commit-graph-compact",
        scenario: COMMIT_GRAPH_CLEAN_SCENARIO,
        record: (workspace) => {
            const template = requireScenarioTemplate(workspace, "commit-graph-compact");
            return recordCommitGraphCompactWebviewFixture({
                repoRoot: template.root,
                roots: { root: template.root, originRoot: template.originRoot, profileDir: "" },
            });
        },
    },
];
