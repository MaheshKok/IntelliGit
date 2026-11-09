// The commit details pane's Files | Checks tab choice, kept in the webview's saved state the
// same way the Group by Directory choice is, plus the signal "Open in Checks" sends.

import { getVsCodeApi } from "../../shared/vscodeApi";

/** Tabs of the commit details pane. */
export type CommitInfoTab = "files" | "checks";

interface CommitInfoTabViewState {
    commitInfoTab?: CommitInfoTab;
}

/** Window event that switches every mounted commit details pane to its Checks tab. */
export const OPEN_CHECKS_TAB_EVENT = "intelligit:openChecksTab";

/** The saved tab; Files when nothing is saved or the state cannot be read. */
export function readCommitInfoTab(): CommitInfoTab {
    try {
        const saved = getVsCodeApi<unknown, CommitInfoTabViewState>().getState()?.commitInfoTab;
        return saved === "checks" ? "checks" : "files";
    } catch {
        return "files";
    }
}

/**
 * Saves the tab into the webview's shared state, keeping what other views saved there.
 *
 * @param tab - The tab the user chose.
 */
export function persistCommitInfoTab(tab: CommitInfoTab): void {
    try {
        const api = getVsCodeApi<unknown, CommitInfoTabViewState>();
        api.setState({ ...api.getState(), commitInfoTab: tab });
    } catch {
        // Ignore persistence errors and keep the tab working for this session.
    }
}

/** Saves the Checks tab and tells a mounted details pane to show it now. */
export function openChecksTab(): void {
    persistCommitInfoTab("checks");
    window.dispatchEvent(new Event(OPEN_CHECKS_TAB_EVENT));
}
