import { useCallback, useEffect, useRef, useState } from "react";
import type { CiAction } from "../../../../types";
import type { CiActionResultMessage, RunCiActionMessage } from "../../../protocol/commitCiMessages";
import { getVsCodeApi } from "../../shared/vscodeApi";

/** The last action's outcome as the Checks tab shows it; `idle` shows nothing. */
export type CiActionView =
    | { status: "idle" }
    | { status: "uncertain" }
    | { status: "forbidden"; helpUrl?: string }
    | { status: "failed"; message: string };

/** One action button's target: a run, or one job of it for `rerunJob`. */
export interface CiActionTarget {
    action: CiAction;
    runId: string;
    jobId?: string;
}

// One counter per webview, so a request id is never reused by another pane instance.
let lastRequestId = 0;

/**
 * Sends the Checks tab's write actions. While one is in flight every action button is busy, so
 * a second click sends nothing; `ok` and `uncertain` ask for the detail again.
 *
 * @param repoKey - Repository the pane shows.
 * @param hash - The commit shown.
 * @param onSent - Asks for the detail again once the host refetched it.
 */
export function useCiAction(
    repoKey: string,
    hash: string,
    onSent: () => void,
): {
    busy: CiActionTarget | null;
    view: CiActionView;
    run: (target: CiActionTarget) => void;
} {
    const [busy, setBusy] = useState<CiActionTarget | null>(null);
    const [view, setView] = useState<CiActionView>({ status: "idle" });
    // A ref, not the state: two clicks in one frame both see the state from before.
    const inFlight = useRef<{ requestId: number; repoKey: string; hash: string } | null>(null);
    const latestOnSent = useRef(onSent);
    useEffect(() => {
        latestOnSent.current = onSent;
    }, [onSent]);

    // Another commit shows nothing of the last one's action; its late reply is dropped below.
    const [shownFor, setShownFor] = useState({ repoKey, hash });
    if (shownFor.repoKey !== repoKey || shownFor.hash !== hash) {
        setShownFor({ repoKey, hash });
        setView({ status: "idle" });
    }

    useEffect(() => {
        const onMessage = (event: MessageEvent<unknown>): void => {
            const data = event.data as Partial<CiActionResultMessage> | null;
            if (data?.type !== "ciActionResult") return;
            const expected = inFlight.current;
            if (!expected || data.requestId !== expected.requestId) return;
            inFlight.current = null;
            setBusy(null);
            if (data.repoKey !== repoKey || data.hash !== hash) return;
            if (data.outcome === "ok" || data.outcome === "uncertain") latestOnSent.current();
            setView(viewOf(data));
        };
        window.addEventListener("message", onMessage);
        return () => window.removeEventListener("message", onMessage);
    }, [repoKey, hash]);

    const run = useCallback(
        (target: CiActionTarget) => {
            if (inFlight.current) return;
            const requestId = ++lastRequestId;
            inFlight.current = { requestId, repoKey, hash };
            setBusy(target);
            setView({ status: "idle" });
            getVsCodeApi<RunCiActionMessage>().postMessage({
                type: "runCiAction",
                requestId,
                repoKey,
                hash,
                action: target.action,
                runId: target.runId,
                ...(target.jobId === undefined ? {} : { jobId: target.jobId }),
            });
        },
        [repoKey, hash],
    );

    return { busy, view, run };
}

function viewOf(reply: Partial<CiActionResultMessage>): CiActionView {
    switch (reply.outcome) {
        case "ok":
            return { status: "idle" };
        case "uncertain":
            return { status: "uncertain" };
        case "forbidden":
            return {
                status: "forbidden",
                ...(typeof reply.helpUrl === "string" ? { helpUrl: reply.helpUrl } : {}),
            };
        default:
            return { status: "failed", message: reply.message ?? "" };
    }
}
