import { watch, type FSWatcher } from "node:fs";
import { resolveGitDir } from "./gitDirectory";

const wholeIndexOperationMarkers = new Set([
    "MERGE_HEAD",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
    "rebase-merge",
    "rebase-apply",
]);

/** Idempotently stops one request-scoped whole-index operation watcher. */
export interface WholeIndexOperationWatcher {
    dispose(): void;
}

/**
 * Watches one repository's Git metadata for whole-index operation state changes.
 *
 * The watcher is deliberately request-scoped: callers own and dispose it with the request that
 * initiated it. Setup errors from `fs.watch` are not swallowed, letting the request boundary map
 * them to its established error result. Asynchronous watcher failures stop the watcher before an
 * optional request boundary callback receives the original error. Events without a filename are
 * treated as relevant because Node does not guarantee that filename is supplied on every platform.
 */
export function watchWholeIndexOperation(
    repoRoot: string,
    onDidChange: () => void,
    onDidError: (error: unknown) => void = () => undefined,
): WholeIndexOperationWatcher {
    const gitDir = resolveGitDir(repoRoot);
    let disposed = false;
    const watcher: FSWatcher = watch(gitDir, (_eventType, filename) => {
        if (disposed) return;
        const name = filename?.toString();
        if (!name || wholeIndexOperationMarkers.has(name)) onDidChange();
    });
    const dispose = (): void => {
        if (disposed) return;
        disposed = true;
        watcher.close();
    };
    watcher.on("error", (error) => {
        if (disposed) return;
        dispose();
        onDidError(error);
    });

    return {
        dispose,
    };
}
