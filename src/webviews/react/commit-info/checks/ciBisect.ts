// The webview's one "Find where CI broke" run: started from the Git Log's row menu, shown by the
// Checks tab of the same repository. Only the newest run's replies count.

import { useSyncExternalStore } from "react";
import type {
    CancelCiBisectMessage,
    CiBisectProgressMessage,
    CiBisectResultMessage,
    CiLoadedCommit,
    StartCiBisectMessage,
} from "../../../protocol/commitCiMessages";
import { getVsCodeApi } from "../../shared/vscodeApi";
import { openChecksTab } from "./checksTabState";

/** The bisect on screen: still reading commits, or answered. */
export type CiBisectView =
    | { status: "running"; requestId: number; repoKey: string; done: number; total: number }
    | { status: "done"; requestId: number; repoKey: string; result: CiBisectResultMessage };

let lastRequestId = 0;
let view: CiBisectView | null = null;
/** The range of the newest run, kept so Retry can ask for it again. */
let lastRange: { repoKey: string; commits: readonly CiLoadedCommit[] } | null = null;
let listening = false;
const listeners = new Set<() => void>();

function publish(next: CiBisectView | null): void {
    view = next;
    for (const listener of listeners) listener();
}

function onMessage(event: MessageEvent<unknown>): void {
    const data = event.data as Partial<CiBisectProgressMessage | CiBisectResultMessage> | null;
    if (view?.status !== "running" || data?.requestId !== view.requestId) return;
    if (data.type === "ciBisectProgress") {
        const { done, total } = data as CiBisectProgressMessage;
        publish({ ...view, done, total });
    } else if (data.type === "ciBisectResult" && data.repoKey === view.repoKey) {
        publish({
            status: "done",
            requestId: view.requestId,
            repoKey: view.repoKey,
            result: data as CiBisectResultMessage,
        });
    }
}

/**
 * Asks the host to bisect the selected commits and shows the Checks tab. A newer bisect replaces
 * the running one; the host stops the older one when it starts the newer.
 *
 * @param repoKey - Repository of the Git Log.
 * @param commits - The selected rows, newest first, with their parents.
 */
export function startCiBisect(repoKey: string, commits: readonly CiLoadedCommit[]): void {
    if (!listening) {
        window.addEventListener("message", onMessage);
        listening = true;
    }
    const requestId = ++lastRequestId;
    lastRange = { repoKey, commits };
    publish({ status: "running", requestId, repoKey, done: 0, total: commits.length });
    getVsCodeApi<StartCiBisectMessage>().postMessage({
        type: "startCiBisect",
        requestId,
        repoKey,
        commits: [...commits],
    });
    openChecksTab();
}

/**
 * The Git Log's `onFindCiBreak`: starts a bisect in `repoKey`, or nothing (no row menu entry)
 * while CI checks are off or the repository is unknown.
 *
 * @param enabled - CI checks are on.
 * @param repoKey - Repository of the Git Log.
 */
export function findCiBreakHandler(
    enabled: boolean,
    repoKey: string | undefined,
): ((commits: CiLoadedCommit[]) => void) | undefined {
    if (!enabled || !repoKey) return undefined;
    return (commits) => startCiBisect(repoKey, commits);
}

/** Runs the newest bisect's range again, after some commits' checks could not be read. */
export function retryCiBisect(): void {
    if (lastRange) startCiBisect(lastRange.repoKey, lastRange.commits);
}

/** Closes the bisect view, telling the host to stop it first when it is still running. */
export function closeCiBisect(): void {
    if (view?.status === "running") {
        getVsCodeApi<CancelCiBisectMessage>().postMessage({
            type: "cancelCiBisect",
            requestId: view.requestId,
        });
    }
    if (view) publish(null);
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

/**
 * The bisect to show in a pane of `repoKey`, or `null`.
 *
 * @param repoKey - Repository the pane shows.
 */
export function useCiBisect(repoKey: string): CiBisectView | null {
    const current = useSyncExternalStore(subscribe, () => view);
    return current?.repoKey === repoKey ? current : null;
}
