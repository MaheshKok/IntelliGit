import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FileHistoryState, HistoryInbound, HistoryOutbound } from "../../protocol/fileHistory";
import type { DiffViewerData } from "../../protocol/diffViewerTypes";
import type { DiffViewerHost } from "../diff-viewer/diffViewerHost";
import { getVsCodeApi } from "../shared/vscodeApi";

/** History never owns a writable document, including comparisons against local content. */
function ignoreEdit(): void {}

/** Owns history messaging and invalidates every preview before a new selection can resolve. */
export function useFileHistory() {
    const api = useMemo(() => getVsCodeApi<HistoryOutbound>(), []);
    const [state, setState] = useState<FileHistoryState | null>(null);
    const [selected, setSelected] = useState<string[]>([]);
    const [data, setData] = useState<DiffViewerData | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [ignoreWhitespace, setIgnoreWhitespace] = useState(false);
    const snapshot = useRef<FileHistoryState | null>(null);
    const selection = useRef<string[]>([]);
    const requestId = useRef(0);
    const local = useRef(false);
    const whitespace = useRef(false);

    /** Invalidates in-flight data synchronously, before React renders the cleared surface. */
    const clearPreview = useCallback(() => {
        requestId.current += 1;
        setData(null);
        setError(null);
    }, []);

    /** Preserves all highlighted rows but compares only their newest and oldest endpoints. */
    const select = useCallback(
        (hashes: string[], compareLocal = false) => {
            clearPreview();
            selection.current = hashes;
            local.current = compareLocal;
            setSelected(hashes);
            if (!hashes.length) return;
            const endpoints = hashes.length > 1 ? [hashes[0], hashes[hashes.length - 1]] : hashes;
            api.postMessage({
                type: "historySelect",
                hashes: endpoints,
                requestId: requestId.current,
                local: compareLocal,
                ignoreWhitespace: whitespace.current,
            });
        },
        [api, clearPreview],
    );

    // One host event commits its related snapshot and selection together.
    // react-doctor-disable-next-line react-doctor/no-cascading-set-state
    useEffect(() => {
        /** Accepts only the current preview; history snapshots retain selection during pagination. */
        const receive = (event: MessageEvent<HistoryInbound>) => {
            const message = event.data;
            if (message.type === "historyState") {
                const previous = snapshot.current;
                snapshot.current = message.state;
                setState(message.state);
                setLoading(false);
                setError(null);
                const sameHistory =
                    previous?.path === message.state.path && previous.ref === message.state.ref;
                const retained = sameHistory
                    ? selection.current.filter((hash) =>
                          message.state.entries.some((entry) => entry.hash === hash),
                      )
                    : [];
                const first = message.state.entries[0];
                select(
                    sameHistory ? retained : first ? [first.hash] : [],
                    retained.length > 0 && local.current,
                );
            } else if (message.type === "historyError") {
                setError(message.message);
                setLoading(false);
            } else if (message.type === "historyDiff" && message.requestId === requestId.current) {
                setError(message.error ?? message.data?.loadError ?? null);
                // Strip edit ownership at the embedding boundary: the existing renderer stays read-only.
                setData(message.data ? { ...message.data, editablePane: undefined } : null);
            }
        };
        window.addEventListener("message", receive);
        api.postMessage({ type: "historyReady" });
        return () => window.removeEventListener("message", receive);
    }, [api, select]);

    /** Clears stale rows' selection before asking the host for a new branch or refreshed history. */
    const refresh = (ref: string) => {
        select([]);
        setLoading(true);
        api.postMessage({ type: "historyRefresh", ref });
    };
    /** Reissues the current immutable comparison with the viewer's whitespace preference. */
    const handleIgnoreMode = () => {
        whitespace.current = !whitespace.current;
        setIgnoreWhitespace(whitespace.current);
        select(selection.current, local.current);
    };
    const host: DiffViewerHost = {
        data,
        error,
        ignoreMode: ignoreWhitespace ? "whitespace" : "none",
        handleIgnoreMode,
        handleEdit: ignoreEdit,
    };
    return {
        state,
        selected,
        loading,
        error,
        host,
        select,
        refresh,
        postMessage: api.postMessage.bind(api),
    };
}
