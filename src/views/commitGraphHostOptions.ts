/**
 * Host-registration options for the commit graph views.
 *
 * Deliberately NOT in `CommitGraphViewProvider.ts`: the integration suites mock that module
 * wholesale to swap in a stand-in provider class (`extension.integration.test.ts`,
 * `commit-message-generation-host-wiring.integration.test.ts`), so a registration constant living
 * there would vanish along with the class. This module holds only the data the production hosts and
 * the fixture recorder must agree on, so mocking the provider never shadows it.
 */

import * as vscode from "vscode";

/** The bundle the sidebar (compact) registration renders. */
const COMPACT_SCRIPT_FILE = "webview-compactcommitgraph.js";

/**
 * The bundle and title the sidebar (compact) registration of `CommitGraphViewProvider` is
 * constructed with. `showRepositoryLabel` stays at the call site because only it is dynamic.
 *
 * Shared by the production call site (`activation/repositoryMode.ts`) and the fixture recorder
 * (`tests/visual/recorder/recordCommitGraphWebviewFixture.ts`) instead of hand-copied into each.
 * Duplicating it made a production edit dropping `vscode.l10n.t` unobservable to every
 * recorder-backed oracle: the recorded bytes are identical with or without the call, so nothing
 * short of sharing the call itself can witness that regression.
 */
export function compactCommitGraphViewOptions(): {
    readonly scriptFile: string;
    readonly title: string;
} {
    return {
        scriptFile: COMPACT_SCRIPT_FILE,
        title: vscode.l10n.t("Graph"),
    };
}
