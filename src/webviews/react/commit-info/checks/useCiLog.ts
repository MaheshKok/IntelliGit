import { useCallback, useEffect, useRef, useState } from "react";
import type {
    CiLogPreviewMessage,
    CiLogResultMessage,
    OpenCiLogMessage,
    PreviewCiLogMessage,
} from "../../../protocol/commitCiMessages";
import { getVsCodeApi } from "../../shared/vscodeApi";

/** The job whose log the detail shows. */
export interface CiLogJobRef {
    repoKey: string;
    hash: string;
    runId: string;
    jobId: string;
    attempt?: number;
}

/** What the log part of the job detail shows. The excerpt lives in component state only. */
export type CiLogView =
    | { status: "idle" }
    | { status: "loading" }
    | { status: "ready"; excerpt: string; truncated: boolean }
    | { status: "running" }
    | { status: "forbidden" }
    | { status: "failed"; message: string };

// One counter each per webview, so an id or token is never reused by another pane instance.
let lastRequestId = 0;
let lastSelectionToken = 0;

/**
 * Asks the host for the excerpt of `job`'s log when `preview` is set, and offers opening the
 * full log in an editor. A preview reply renders only when it carries the selection token and
 * request id of the newest preview and names the job still shown, so a late reply for an
 * earlier pick, even of the same job, is dropped. An open reply renders only for the newest
 * open request.
 *
 * The caller mounts a new instance per selected job (a React `key`), so nothing of the last
 * job's log is ever shown for the next one.
 *
 * @param job - The selected job.
 * @param preview - Whether to ask for the excerpt (a complete failed job with logs).
 */
export function useCiLog(
    job: CiLogJobRef,
    preview: boolean,
): { log: CiLogView; openFullLog: () => void; openError: CiLogView } {
    const [log, setLog] = useState<CiLogView>({ status: preview ? "loading" : "idle" });
    const [openError, setOpenError] = useState<CiLogView>({ status: "idle" });
    const newestToken = useRef<number | null>(null);
    const newestPreview = useRef<number | null>(null);
    const newestOpen = useRef<number | null>(null);
    const { repoKey, hash, runId, jobId, attempt } = job;

    useEffect(() => {
        if (!preview) return;
        const requestId = ++lastRequestId;
        const selectionToken = ++lastSelectionToken;
        newestToken.current = selectionToken;
        newestPreview.current = requestId;
        // A job that finished while selected keeps this instance, which started idle.
        setLog({ status: "loading" });
        getVsCodeApi<PreviewCiLogMessage>().postMessage({
            type: "previewCiLog",
            requestId,
            repoKey,
            hash,
            runId,
            jobId,
            ...(attempt === undefined ? {} : { attempt }),
            selectionToken,
        });
    }, [preview, repoKey, hash, runId, jobId, attempt]);

    useEffect(() => {
        const onMessage = (event: MessageEvent<unknown>): void => {
            const data = event.data as
                Partial<CiLogPreviewMessage> | Partial<CiLogResultMessage> | null;
            if (data?.repoKey !== repoKey || data.hash !== hash) return;
            if (data.type === "ciLogPreview") {
                if (
                    newestToken.current === null ||
                    data.selectionToken !== newestToken.current ||
                    data.requestId !== newestPreview.current ||
                    data.runId !== runId ||
                    data.jobId !== jobId
                ) {
                    return;
                }
                setLog(viewOf(data));
            } else if (data.type === "ciLogResult") {
                if (newestOpen.current === null || data.requestId !== newestOpen.current) return;
                setOpenError(data.outcome === "opened" ? { status: "idle" } : viewOf(data));
            }
        };
        window.addEventListener("message", onMessage);
        return () => window.removeEventListener("message", onMessage);
    }, [repoKey, hash, runId, jobId]);

    const openFullLog = useCallback(() => {
        const requestId = ++lastRequestId;
        newestOpen.current = requestId;
        setOpenError({ status: "idle" });
        getVsCodeApi<OpenCiLogMessage>().postMessage({
            type: "openCiLog",
            requestId,
            repoKey,
            hash,
            runId,
            jobId,
            ...(attempt === undefined ? {} : { attempt }),
        });
    }, [repoKey, hash, runId, jobId, attempt]);

    return { log, openFullLog, openError };
}

function viewOf(reply: Partial<CiLogPreviewMessage> | Partial<CiLogResultMessage>): CiLogView {
    switch (reply.outcome) {
        case "ready":
            return {
                status: "ready",
                excerpt: typeof reply.excerpt === "string" ? reply.excerpt : "",
                truncated: reply.truncated === true,
            };
        case "running":
            return { status: "running" };
        case "forbidden":
            return { status: "forbidden" };
        default:
            return { status: "failed", message: reply.message ?? "" };
    }
}
