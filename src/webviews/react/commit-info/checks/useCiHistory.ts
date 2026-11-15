import { useEffect, useRef, useState } from "react";
import type { CiHistory } from "../../../../shared/ci/history";
import type { CommitCiDetail } from "../../../../types";
import type { CiHistoryMessage, RequestCiHistoryMessage } from "../../../protocol/commitCiMessages";
import { getVsCodeApi } from "../../shared/vscodeApi";

// One counter per webview, so a request id is never reused by another pane instance.
let lastRequestId = 0;

/**
 * The parent's and default branch tip's snapshots the history tags compare with. Asked again
 * for every detail answer, so a parent that finishes later or a moved tip shows up; only the
 * reply to the newest request for the detail on screen is returned, with whether it found no
 * `origin/HEAD` (undefined until a reply is shown).
 *
 * @param repoKey - Repository the pane shows.
 * @param hash - The commit whose detail is shown.
 * @param parents - The commit's parents from the row the pane holds.
 * @param detail - The shown detail; nothing is asked before it renders.
 */
export function useCiHistory(
    repoKey: string,
    hash: string,
    parents: readonly string[],
    detail: CommitCiDetail | undefined,
): { history: CiHistory | undefined; defaultBranchUnknown: boolean | undefined } {
    // Each answer keeps the detail it was asked for, so a replacement detail's first render,
    // before the effect below retires the answer, never shows the previous answer's tags.
    const [answer, setAnswer] = useState<{
        message: CiHistoryMessage;
        detail: CommitCiDetail;
    } | null>(null);
    const newest = useRef<{ requestId: number; detail: CommitCiDetail } | null>(null);
    const parentsKey = parents.join(",");

    useEffect(() => {
        // A new request, or a detail that went away, retires the stored answer: it may hold the
        // previous account's or a previous visit's tags.
        setAnswer(null);
        newest.current = null;
        if (!detail) return;
        const requestId = ++lastRequestId;
        newest.current = { requestId, detail };
        getVsCodeApi<RequestCiHistoryMessage>().postMessage({
            type: "requestCiHistory",
            requestId,
            repoKey,
            hash,
            parents: parentsKey ? parentsKey.split(",") : [],
        });
    }, [repoKey, hash, parentsKey, detail]);

    useEffect(() => {
        const onMessage = (event: MessageEvent<unknown>): void => {
            const data = event.data as Partial<CiHistoryMessage> | null;
            const request = newest.current;
            if (data?.type !== "ciHistory" || !request || data.requestId !== request.requestId) {
                return;
            }
            setAnswer({ message: data as CiHistoryMessage, detail: request.detail });
        };
        window.addEventListener("message", onMessage);
        return () => window.removeEventListener("message", onMessage);
    }, []);

    const history =
        answer &&
        answer.detail === detail &&
        answer.message.requestId === newest.current?.requestId &&
        answer.message.repoKey === repoKey &&
        answer.message.hash === hash
            ? answer.message
            : undefined;
    return { history, defaultBranchUnknown: history ? history.defaultBranch === null : undefined };
}
