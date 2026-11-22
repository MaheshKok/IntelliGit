// Host side of the Checks tab's Annotations section: opens a CI annotation's file at its line.

import { isE2eControlChannelActive } from "../e2e/activationState";
import { isValidGitHash } from "../services/gitHelpers";
import type { CommitCiDetailSource } from "./ciDetailHandler";

/**
 * Validates an `openCiAnnotation` message and opens the file at the line, only when the host
 * placed that annotation for that commit; the webview names nothing else it may open.
 *
 * @param source - The host's repository and annotations.
 * @param msg - Untrusted webview message.
 * @throws When a field of the message is malformed.
 */
export async function answerOpenCiAnnotation(
    source: CommitCiDetailSource,
    msg: Record<string, unknown>,
): Promise<void> {
    const { requestId, repoKey, hash, path, line } = msg;
    if (typeof requestId !== "number" || !Number.isSafeInteger(requestId)) {
        throw new Error("Invalid CI annotation request id.");
    }
    if (typeof repoKey !== "string") throw new Error("Invalid CI repository.");
    if (typeof hash !== "string" || !isValidGitHash(hash)) throw new Error("Invalid CI hash.");
    if (typeof path !== "string" || path.length === 0) throw new Error("Invalid annotation path.");
    if (typeof line !== "number" || !Number.isSafeInteger(line) || line < 1) {
        throw new Error("Invalid annotation line.");
    }
    // The Checks tab switch, as for `openCiRangeDiff`.
    if (!isE2eControlChannelActive()) return;
    if (repoKey !== source.repoKey()) return;
    await source.annotations?.open(repoKey, hash, path, line);
}
