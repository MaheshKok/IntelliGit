import { useEffect, useRef, useState } from "react";
import type { CiChangedFile, CommitCiDetail } from "../../../../types";
import type {
    ChangedSinceGreenMessage,
    CiLoadedCommit,
    OpenCiRangeDiffMessage,
    RequestChangedSinceGreenMessage,
} from "../../../protocol/commitCiMessages";
import { getVsCodeApi } from "../../shared/vscodeApi";

// One counter per webview, so a request id is never reused by another pane instance.
let lastRequestId = 0;

/** The selected failed job, as "Changed since last green" asks about it. */
export interface ChangedSinceGreenJob {
    repoKey: string;
    hash: string;
    logicalCheckId: string;
    /** The job's workflow or pipeline name; the logical id already carries it. */
    scopeName: string | null;
    checkName: string;
    /** The graph's loaded commits; empty where the host supplies them. */
    loaded: readonly CiLoadedCommit[];
    /** The detail the job was read from; a new one (Refresh, a re-poll) asks again. */
    detail: CommitCiDetail;
}

type JobIdentity = Pick<
    RequestChangedSinceGreenMessage,
    "repoKey" | "hash" | "logicalCheckId" | "scopeName" | "checkName"
>;

/** Whether two messages are about the same job of the same commit in the same repository. */
function isSameJob(a: JobIdentity, b: JobIdentity): boolean {
    return (
        a.repoKey === b.repoKey &&
        a.hash === b.hash &&
        a.logicalCheckId === b.logicalCheckId &&
        a.scopeName === b.scopeName &&
        a.checkName === b.checkName
    );
}

/** The answer on screen: loading, or the last green commit and the files changed since. */
export type ChangedSinceGreenView =
    | { status: "loading" }
    | (Pick<ChangedSinceGreenMessage, "lastGreen" | "unknownReason" | "error" | "files"> & {
          status: "ready";
      });

/**
 * Asks the host for the newest loaded first-parent ancestor where the job passed, and the files
 * changed since; only the reply to this hook's newest request is shown. `openDiff` opens one of
 * those files between that commit and the selected one.
 */
export function useChangedSinceGreen(job: ChangedSinceGreenJob): {
    view: ChangedSinceGreenView;
    openDiff: (file: CiChangedFile) => void;
} {
    const [view, setView] = useState<ChangedSinceGreenView>({ status: "loading" });
    const newest = useRef<RequestChangedSinceGreenMessage | null>(null);
    const { repoKey, hash, logicalCheckId, scopeName, checkName, loaded, detail } = job;

    // `detail` is a dependency on purpose: a Refresh or a re-poll replaces the detail the
    // comparison was read for, so a Git failure shown earlier is asked again.
    useEffect(() => {
        const request: RequestChangedSinceGreenMessage = {
            type: "requestChangedSinceGreen",
            requestId: ++lastRequestId,
            repoKey,
            hash,
            logicalCheckId,
            scopeName,
            checkName,
            loaded: [...loaded],
        };
        // The same job asked again keeps its answer on screen until the new reply replaces it.
        if (!newest.current || !isSameJob(newest.current, request)) setView({ status: "loading" });
        newest.current = request;
        getVsCodeApi<RequestChangedSinceGreenMessage>().postMessage(request);
    }, [repoKey, hash, logicalCheckId, scopeName, checkName, loaded, detail]);

    useEffect(() => {
        const onMessage = (event: MessageEvent<unknown>): void => {
            const data = event.data as Partial<ChangedSinceGreenMessage> | null;
            const asked = newest.current;
            if (
                data?.type !== "changedSinceGreen" ||
                !asked ||
                data.requestId !== asked.requestId ||
                !isSameJob(asked, data as ChangedSinceGreenMessage)
            ) {
                return;
            }
            const { lastGreen = null, unknownReason, error, files = [] } = data;
            setView({ status: "ready", lastGreen, unknownReason, error, files });
        };
        window.addEventListener("message", onMessage);
        return () => window.removeEventListener("message", onMessage);
    }, []);

    const lastGreen = view.status === "ready" ? view.lastGreen : null;
    const openDiff = (file: CiChangedFile): void => {
        if (!lastGreen) return;
        getVsCodeApi<OpenCiRangeDiffMessage>().postMessage({
            type: "openCiRangeDiff",
            requestId: ++lastRequestId,
            repoKey,
            fromRev: lastGreen,
            toRev: hash,
            path: file.path,
            ...(file.oldPath === undefined ? {} : { oldPath: file.oldPath }),
            status: file.status,
        });
    };
    return { view, openDiff };
}
