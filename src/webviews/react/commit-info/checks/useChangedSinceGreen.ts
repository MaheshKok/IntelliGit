import { useEffect, useRef, useState } from "react";
import type { CiChangedFile } from "../../../../types";
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
    const newest = useRef(0);
    const { repoKey, hash, logicalCheckId, scopeName, checkName, loaded } = job;

    useEffect(() => {
        setView({ status: "loading" });
        const requestId = ++lastRequestId;
        newest.current = requestId;
        getVsCodeApi<RequestChangedSinceGreenMessage>().postMessage({
            type: "requestChangedSinceGreen",
            requestId,
            repoKey,
            hash,
            logicalCheckId,
            scopeName,
            checkName,
            loaded: [...loaded],
        });
    }, [repoKey, hash, logicalCheckId, scopeName, checkName, loaded]);

    useEffect(() => {
        const onMessage = (event: MessageEvent<unknown>): void => {
            const data = event.data as Partial<ChangedSinceGreenMessage> | null;
            if (data?.type !== "changedSinceGreen" || data.requestId !== newest.current) return;
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
