import { useCallback, useEffect, useRef, useState } from "react";
import type { CommitCiDetail } from "../../../../types";
import { isCompleteDetail } from "../../../../shared/ci/completion";
import {
    MAX_COMMIT_CHECK_RETRIES_PER_HASH,
    PENDING_CHECK_RETRY_DELAYS_MS,
} from "../../../../shared/ci/pollSchedule";
import type {
    CancelCommitCiDetailMessage,
    CommitCiDetailInvalidatedMessage,
    CommitCiDetailMessage,
    RequestCommitCiDetailMessage,
} from "../../../protocol/commitCiMessages";
import { getVsCodeApi } from "../../shared/vscodeApi";

interface Selection {
    repoKey: string;
    hash: string;
}

interface Answer extends Selection {
    detail: CommitCiDetail | null;
}

/** What the Checks tab shows: `undefined` while loading, `null` when no provider serves the repository. */
export interface CommitCiDetailState {
    detail: CommitCiDetail | null | undefined;
    /** Asks the host again, bypassing its caches. */
    refresh: () => void;
    /** Asks the host again through its caches (after a write action refilled them). */
    reload: () => void;
}

// One counter per webview, so a request id is never reused by another pane instance.
let lastRequestId = 0;

function isFor(
    answer: Selection | null,
    repoKey: string | undefined,
    hash: string | null,
): boolean {
    return answer !== null && answer.repoKey === repoKey && answer.hash === hash;
}

/**
 * Fetches the CI detail of the selected commit while the Checks tab is active. A reply
 * renders only when it answers the newest request and still matches the repository and
 * commit on screen; incomplete detail is polled on the pending ladder, a failed fetch never.
 *
 * @param repoKey - Repository the pane shows; undefined when the host offers no Checks tab.
 * @param hash - Selected commit, or null.
 * @param active - Whether the Checks tab is the visible one.
 */
export function useCommitCiDetail(
    repoKey: string | undefined,
    hash: string | null,
    active: boolean,
): CommitCiDetailState {
    const [answer, setAnswer] = useState<Answer | null>(null);
    // A new selection drops the saved answer, so returning to a commit waits for its newest
    // reply; a Refresh keeps the selection and so keeps showing the answer meanwhile.
    const [shownFor, setShownFor] = useState({ repoKey, hash });
    if (shownFor.repoKey !== repoKey || shownFor.hash !== hash) {
        setShownFor({ repoKey, hash });
        setAnswer(null);
    }
    const newest = useRef<(Selection & { requestId: number }) | null>(null);
    const polls = useRef(0);
    const pollTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

    const send = useCallback(
        (force: boolean) => {
            if (repoKey === undefined || hash === null) return;
            const requestId = ++lastRequestId;
            newest.current = { requestId, repoKey, hash };
            const message: RequestCommitCiDetailMessage = {
                type: "requestCommitCiDetail",
                requestId,
                repoKey,
                hash,
                ...(force ? { force: true } : {}),
            };
            getVsCodeApi<RequestCommitCiDetailMessage>().postMessage(message);
        },
        [repoKey, hash],
    );

    useEffect(() => {
        if (!active) return;
        polls.current = 0;
        send(false);
        return () => {
            // The host keeps re-posting a running scan until told nobody shows it.
            if (newest.current) {
                getVsCodeApi<CancelCommitCiDetailMessage>().postMessage({
                    type: "cancelCommitCiDetail",
                    requestId: newest.current.requestId,
                });
            }
            newest.current = null;
        };
    }, [active, send]);

    useEffect(() => {
        const onMessage = (event: MessageEvent<unknown>): void => {
            const data = event.data as Partial<CommitCiDetailMessage> | null;
            if (data?.type !== "commitCiDetail") return;
            const expected = newest.current;
            if (!expected || data.requestId !== expected.requestId) return;
            if (!isFor(expected, data.repoKey, data.hash ?? null)) return;
            setAnswer({
                repoKey: expected.repoKey,
                hash: expected.hash,
                detail: data.detail ?? null,
            });
        };
        window.addEventListener("message", onMessage);
        return () => window.removeEventListener("message", onMessage);
    }, []);

    useEffect(() => {
        // A sign-in or sign-out makes the shown detail another account's: drop it and ask again.
        const onMessage = (event: MessageEvent<unknown>): void => {
            const data = event.data as Partial<CommitCiDetailInvalidatedMessage> | null;
            if (data?.type !== "commitCiDetailInvalidated") return;
            setAnswer(null);
            if (!active) return;
            polls.current = 0;
            send(false);
        };
        window.addEventListener("message", onMessage);
        return () => window.removeEventListener("message", onMessage);
    }, [active, send]);

    const detail = isFor(answer, repoKey, hash) ? answer!.detail : undefined;

    useEffect(() => {
        // A re-run or cancel the provider has not shown yet keeps the ladder going even when
        // the shown detail is complete: only a fetch can show the action took effect.
        if (!active || !detail || (isCompleteDetail(detail) && !detail.actionFence)) return;
        // Pending work is re-polled; a failed fetch and "no checks" are not. A failed forced
        // Refresh comes back as the previous pending detail carrying `refreshError`.
        if (
            detail.outcome === "unavailable" ||
            detail.outcome === "none" ||
            detail.refreshError !== undefined
        ) {
            return;
        }
        const delay = PENDING_CHECK_RETRY_DELAYS_MS[polls.current];
        if (delay === undefined || polls.current >= MAX_COMMIT_CHECK_RETRIES_PER_HASH) return;
        const timer = setTimeout(() => {
            polls.current += 1;
            send(false);
        }, delay);
        pollTimer.current = timer;
        return () => clearTimeout(timer);
    }, [active, detail, send]);

    const refresh = useCallback(() => {
        // A re-poll firing during the forced fetch would take a newer id and drop its answer.
        clearTimeout(pollTimer.current);
        polls.current = 0;
        send(true);
    }, [send]);
    const reload = useCallback(() => {
        clearTimeout(pollTimer.current);
        polls.current = 0;
        send(false);
    }, [send]);
    return { detail, refresh, reload };
}
