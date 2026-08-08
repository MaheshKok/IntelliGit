/**
 * The registry of every recorded webview payload fixture (PLAN.md step 13). Each entry names one
 * resolved host context + scenario a committed fixture under `tests/visual/fixtures/<contextId>/`
 * belongs to, and the function that reproduces it against a freshly seeded fixture-repo workspace
 * (`seedFixtureTemplate`, `tests/fixtures/repo/seed.ts`). `webviewFixtureGate.ts`'s repo-wide gate
 * iterates this list -- so registering a new context or scenario means adding a DATA entry here,
 * never writing another bespoke test file.
 *
 * Every entry's `record` function is handed the SAME seeded workspace the gate itself seeds once
 * (see `webviewFixtureGate.test.ts`'s `beforeAll`) -- one shared fixture repository backs every
 * registered recording, mirroring how `recordCommitInfoWebviewFixture.test.ts` already builds its
 * own workspaces from the same `seedFixtureTemplate`. An entry decides for itself which commit,
 * path roots, or other detail it needs out of that one workspace.
 */

import type { WebviewContextId } from "../../../src/e2e/webviewCapture";
import type { FixtureTemplate } from "../../fixtures/repo/seed";
import {
    COMMIT_INFO_CLEAN_SCENARIO,
    recordCommitInfoWebviewFixture,
} from "./recordCommitInfoWebviewFixture";
import type { WebviewFixture } from "./webviewFixtureTypes";

/** One registered recording: which committed fixture it produces, and how to reproduce it. */
export interface WebviewFixtureRecorderEntry {
    readonly contextId: WebviewContextId;
    readonly scenario: string;
    readonly record: (workspace: FixtureTemplate) => Promise<WebviewFixture>;
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
        record: (workspace) =>
            recordCommitInfoWebviewFixture({
                repoRoot: workspace.root,
                commitHash: workspace.commits.conflictBase,
                roots: { root: workspace.root, originRoot: workspace.originRoot, profileDir: "" },
            }),
    },
];
