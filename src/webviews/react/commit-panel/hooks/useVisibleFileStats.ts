import { useCallback, useEffect, useRef } from "react";
import type { WorkingFile } from "../../../../types";
import { getVsCodeApi } from "./useVsCodeApi";

/** Coalesces newly visible rows without retaining file contents or counting offscreen groups. */
export function useVisibleFileStats(repositoryRoot?: string): (file: WorkingFile) => void {
    const queued = useRef(new Map<string, Set<string>>());
    const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    useEffect(
        () => () => {
            if (timer.current !== undefined) clearTimeout(timer.current);
            timer.current = undefined;
            queued.current.clear();
        },
        [repositoryRoot],
    );
    return useCallback(
        (file: WorkingFile) => {
            if (!repositoryRoot || file.statsState !== "pending" || !file.statsRevision) return;
            const paths = queued.current.get(file.statsRevision) ?? new Set<string>();
            paths.add(file.path);
            queued.current.set(file.statsRevision, paths);
            if (timer.current !== undefined) return;
            timer.current = setTimeout(() => {
                timer.current = undefined;
                for (const [revision, queuedPaths] of queued.current) {
                    const values = [...queuedPaths];
                    for (let start = 0; start < values.length; start += 128)
                        getVsCodeApi().postMessage({
                            type: "requestWorkingFileStats",
                            repositoryRoot,
                            revision,
                            paths: values.slice(start, start + 128),
                        });
                }
                queued.current.clear();
            }, 24);
        },
        [repositoryRoot],
    );
}
