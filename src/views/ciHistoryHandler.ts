// Host side of the Checks tab's "new" / "still" / "fixed" / "also red" tags: it reads the
// snapshots the webview compares with, shared by every host that renders the details pane.

import { isE2eControlChannelActive } from "../e2e/activationState";
import type { CiOperationContext } from "../services/commitChecks/ciGenerations";
import { isValidGitHash } from "../services/gitHelpers";
import type { CiHistoryMessage } from "../webviews/protocol/commitCiMessages";
import type { CommitCiDetailSource } from "./ciDetailHandler";

/**
 * Validates a `requestCiHistory` message and posts the first parent's and the default branch
 * tip's snapshots. The reply is dropped when the repository, sign-in or CI settings changed
 * while they were read.
 *
 * @param source - The host's repository, generations and history read.
 * @param msg - Untrusted webview message.
 * @param post - Delivers the reply to the webview that asked.
 * @throws When a field of the message is malformed.
 */
export async function answerCiHistoryRequest(
    source: CommitCiDetailSource,
    msg: Record<string, unknown>,
    post: (reply: CiHistoryMessage) => void,
): Promise<void> {
    const { requestId, repoKey, hash, parents } = msg;
    if (typeof requestId !== "number" || !Number.isSafeInteger(requestId)) {
        throw new Error("Invalid CI history request id.");
    }
    if (typeof repoKey !== "string") throw new Error("Invalid CI history repository.");
    if (typeof hash !== "string" || !isValidGitHash(hash))
        throw new Error("Invalid CI history hash.");
    if (
        !Array.isArray(parents) ||
        !parents.every((p) => typeof p === "string" && isValidGitHash(p))
    ) {
        throw new Error("Invalid CI history parents.");
    }
    if (!isE2eControlChannelActive()) return;
    const history = source.history;
    if (!history || repoKey !== source.repoKey()) return;
    const ctx: CiOperationContext = source.generations?.capture(repoKey) ?? {
        repoKey,
        authGeneration: 0,
        lifecycleGeneration: 0,
    };
    const answer = await history(parents);
    const currentRepoKey = source.repoKey();
    const current = source.generations
        ? source.generations.isCurrent(ctx, currentRepoKey)
        : repoKey === currentRepoKey;
    if (!current) return;
    post({ type: "ciHistory", requestId, repoKey, hash, ...answer });
}
