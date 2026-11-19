import { useEffect, useRef, useState } from "react";
import type { CiHistory } from "../../../../shared/ci/history";
import type { CommitCiDetail } from "../../../../types";
import type {
    CiHistoryMessage,
    CiLoadedCommit,
    RequestCiHistoryMessage,
} from "../../../protocol/commitCiMessages";
import { getVsCodeApi } from "../../shared/vscodeApi";

// One counter per webview, so a request id is never reused by another pane instance.
let lastRequestId = 0;

/**
 * The parent's and default branch tip's snapshots the history tags compare with. Asked again
 * for every detail answer, so a parent that finishes later or a moved tip shows up; only the
 * reply to the newest request for the detail on screen is returned, with whether it found no
 * `origin/HEAD`, or one naming another branch than the detail's (undefined until a reply is shown).
 *
 * @param repoKey - Repository the pane shows.
 * @param hash - The commit whose detail is shown.
 * @param parents - The commit's parents from the row the pane holds.
 * @param detail - The shown detail; nothing is asked before it renders.
 * @param loaded - The commits the graph loaded, for the "flaky" line; absent where the host
 *   supplies them. A new page of commits asks again, so the line grows with the graph.
 */
export function useCiHistory(
    repoKey: string,
    hash: string,
    parents: readonly string[],
    detail: CommitCiDetail | undefined,
    loaded?: readonly CiLoadedCommit[],
): { history: CiHistory | undefined; defaultBranchUnknown: boolean | undefined } {
    // Each answer keeps the detail it was asked for, so a replacement detail's first render,
    // before the effect below retires the answer, never shows the previous answer's tags.
    const [answer, setAnswer] = useState<{
        message: CiHistoryMessage;
        detail: CommitCiDetail;
    } | null>(null);
    const newest = useRef<{
        requestId: number;
        repoKey: string;
        hash: string;
        detail: CommitCiDetail;
    } | null>(null);
    const parentsKey = parents.join(",");

    useEffect(() => {
        // A new request, or a detail that went away, retires the stored answer: it may hold the
        // previous account's or a previous visit's tags.
        setAnswer(null);
        newest.current = null;
        if (!detail) return;
        const requestId = ++lastRequestId;
        newest.current = { requestId, repoKey, hash, detail };
        getVsCodeApi<RequestCiHistoryMessage>().postMessage({
            type: "requestCiHistory",
            requestId,
            repoKey,
            hash,
            parents: parentsKey ? parentsKey.split(",") : [],
            ...(loaded && { loaded: [...loaded] }),
        });
    }, [repoKey, hash, parentsKey, detail, loaded]);

    useEffect(() => {
        const onMessage = (event: MessageEvent<unknown>): void => {
            const data = event.data as Partial<CiHistoryMessage> | null;
            const request = newest.current;
            // The whole identity of the request must match before the stored answer is replaced.
            if (
                data?.type !== "ciHistory" ||
                !request ||
                data.requestId !== request.requestId ||
                data.repoKey !== request.repoKey ||
                data.hash !== request.hash
            ) {
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
    // A tip read for another branch than the detail's required rule (origin/HEAD moved between
    // the two reads) leaves required status as unknown as a missing origin/HEAD does.
    const branch = history?.defaultBranch;
    const defaultBranchUnknown =
        history &&
        (branch === null ||
            (detail?.defaultBranch !== undefined && branch?.name !== detail.defaultBranch));
    return { history, defaultBranchUnknown };
}
