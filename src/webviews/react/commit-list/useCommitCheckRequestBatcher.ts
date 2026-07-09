import { useCallback, useEffect, useRef } from "react";

type CommitCheckRequest =
    | { type: "requestCommitChecks"; hash: string }
    | { type: "requestCommitChecks"; hashes: string[] };

/** Batches visible-row commit-check requests into one host message per tick. */
export function useCommitCheckRequestBatcher(
    postMessage: (message: CommitCheckRequest) => void,
): (hash: string) => void {
    const pending = useRef<Set<string>>();
    const timer = useRef<number | null>(null);

    const flush = useCallback(() => {
        timer.current = null;
        const pendingHashes = pending.current;
        if (!pendingHashes) return;
        const hashes = Array.from(pendingHashes);
        pendingHashes.clear();
        if (hashes.length === 0) return;
        const [hash] = hashes;
        if (hashes.length === 1 && hash) {
            postMessage({ type: "requestCommitChecks", hash });
            return;
        }
        postMessage({ type: "requestCommitChecks", hashes });
    }, [postMessage]);

    useEffect(
        () => () => {
            if (timer.current !== null) window.clearTimeout(timer.current);
            pending.current?.clear();
        },
        [flush],
    );

    return useCallback(
        (hash: string) => {
            (pending.current ??= new Set()).add(hash);
            if (timer.current === null) {
                timer.current = window.setTimeout(flush, 0);
            }
        },
        [flush],
    );
}
