// Host side of "Find where CI broke" (PLAN.md §13), shared by every host whose Git Log row menu
// offers it. Off while the Checks tab switch is off: no bisect starts and none is cancelled.

import { isE2eControlChannelActive } from "../e2e/activationState";
import { runCiBisect } from "../services/commitChecks/ciBisect";
import type { CiOperationContext } from "../services/commitChecks/ciGenerations";
import type {
    CiBisectProgressMessage,
    CiBisectResultMessage,
} from "../webviews/protocol/commitCiMessages";
import type { CommitCiDetailLoops, CommitCiDetailSource } from "./ciDetailHandler";
import { readLoadedCommits } from "./ciHistoryHandler";

/**
 * Validates a `startCiBisect` message, runs the bisect and posts its progress and result. A newer
 * bisect, a cancel or the host's disposal stops it (`runs`) and posts nothing more; a sign-in or
 * CI settings change stops it with one final progress reply marked `stopped`.
 *
 * @param source - The host's repository, generations and bisect access.
 * @param msg - Untrusted webview message.
 * @param post - Delivers a reply to the webview that asked.
 * @param runs - The host's running bisect, one at a time.
 * @throws When a field of the message is malformed.
 */
export async function answerStartCiBisect(
    source: CommitCiDetailSource,
    msg: Record<string, unknown>,
    post: (reply: CiBisectProgressMessage | CiBisectResultMessage) => void,
    runs: CommitCiDetailLoops,
): Promise<void> {
    // First, so a disabled bisect posts nothing back, not even an error for a malformed message.
    if (!isE2eControlChannelActive()) return;
    const { requestId, repoKey, commits } = msg;
    if (typeof requestId !== "number" || !Number.isSafeInteger(requestId)) {
        throw new Error("Invalid CI bisect request id.");
    }
    if (typeof repoKey !== "string") throw new Error("Invalid CI bisect repository.");
    const selected = readLoadedCommits(commits);
    const bisect = source.bisect;
    if (!bisect || repoKey !== source.repoKey()) return;
    const ctx: CiOperationContext = source.generations?.capture(repoKey) ?? {
        repoKey,
        authGeneration: 0,
        lifecycleGeneration: 0,
    };
    const current = (): boolean => {
        const currentRepoKey = source.repoKey();
        return source.generations
            ? source.generations.isCurrent(ctx, currentRepoKey)
            : repoKey === currentRepoKey;
    };
    const signal = runs.start(requestId);
    const progress = { done: 0, total: selected.length };
    const result = await runCiBisect(
        bisect.source,
        selected,
        bisect.loaded(),
        signal,
        (done, total) => {
            progress.done = done;
            progress.total = total;
            post({ type: "ciBisectProgress", requestId, repoKey, done, total });
        },
        current,
        msg.retry === true,
    );
    if (signal.aborted) return;
    if (!current()) {
        // Sign-in or CI settings changed (the generation fence): one final reply, so the view
        // leaves "k / N commits". A repository change has no view of that repository left to tell.
        if (repoKey === source.repoKey()) {
            post({ type: "ciBisectProgress", requestId, repoKey, ...progress, stopped: true });
        }
        return;
    }
    if (result) post({ type: "ciBisectResult", requestId, repoKey, ...result });
}

/**
 * Stops the bisect of a `cancelCiBisect` message if it is still the running one.
 *
 * @param msg - Untrusted webview message.
 * @param runs - The host's running bisect.
 * @throws When the request id is malformed.
 */
export function answerCancelCiBisect(
    msg: Record<string, unknown>,
    runs: CommitCiDetailLoops,
): void {
    if (!isE2eControlChannelActive()) return;
    runs.cancel(msg.requestId);
}
