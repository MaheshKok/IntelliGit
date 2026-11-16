// Host side of "Changed since last green" in a failed job's detail (PLAN.md §14): the file list
// and the two-revision diff a file opens, shared by every host that renders the details pane.

import { isE2eControlChannelActive } from "../e2e/activationState";
import type { CiOperationContext } from "../services/commitChecks/ciGenerations";
import { isValidGitHash } from "../services/gitHelpers";
import type { CiRangeDiffFile } from "../types";
import { getErrorMessage } from "../utils/errors";
import type { ChangedSinceGreenMessage } from "../webviews/protocol/commitCiMessages";
import type { CommitCiDetailSource } from "./ciDetailHandler";
import { readLoadedCommits } from "./ciHistoryHandler";

const FILE_STATUSES: ReadonlySet<unknown> = new Set(["A", "M", "D", "R", "C", "T"]);

function readRequestId(value: unknown): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value)) {
        throw new Error("Invalid CI request id.");
    }
    return value;
}

function readHash(value: unknown, field: string): string {
    if (typeof value !== "string" || !isValidGitHash(value)) throw new Error(`Invalid ${field}.`);
    return value;
}

/**
 * Validates a `requestChangedSinceGreen` message and posts the last green commit and the files
 * changed since. A Git failure is posted as `error`; the reply is dropped when the repository,
 * sign-in or CI settings changed while it was read.
 *
 * @param source - The host's repository, generations and cache-only walk.
 * @param msg - Untrusted webview message.
 * @param post - Delivers the reply to the webview that asked.
 * @throws When a field of the message is malformed.
 */
export async function answerChangedSinceGreenRequest(
    source: CommitCiDetailSource,
    msg: Record<string, unknown>,
    post: (reply: ChangedSinceGreenMessage) => void,
): Promise<void> {
    const requestId = readRequestId(msg.requestId);
    const { repoKey, logicalCheckId, scopeName, checkName } = msg;
    if (typeof repoKey !== "string") throw new Error("Invalid CI repository.");
    const hash = readHash(msg.hash, "CI hash");
    if (typeof logicalCheckId !== "string" || typeof checkName !== "string") {
        throw new Error("Invalid CI check.");
    }
    if (scopeName !== null && typeof scopeName !== "string") throw new Error("Invalid CI scope.");
    const loaded = readLoadedCommits(msg.loaded);
    if (!isE2eControlChannelActive()) return;
    const walk = source.changedSinceGreen;
    if (!walk || repoKey !== source.repoKey()) return;
    const ctx: CiOperationContext = source.generations?.capture(repoKey) ?? {
        repoKey,
        authGeneration: 0,
        lifecycleGeneration: 0,
    };
    const request = { hash, logicalCheckId, scopeName, checkName, loaded };
    let answer: Pick<ChangedSinceGreenMessage, "lastGreen" | "unknownReason" | "error" | "files">;
    try {
        const found = await walk(request, repoKey);
        if (!found) return;
        answer = found;
    } catch (err) {
        answer = { lastGreen: null, error: getErrorMessage(err), files: [] };
    }
    const currentRepoKey = source.repoKey();
    const current = source.generations
        ? source.generations.isCurrent(ctx, currentRepoKey)
        : repoKey === currentRepoKey;
    if (!current) return;
    post({
        type: "changedSinceGreen",
        requestId,
        repoKey,
        hash,
        logicalCheckId,
        scopeName,
        checkName,
        ...answer,
    });
}

/**
 * The latest changed-since-green answer a host posted to its webview: the only revisions and
 * files that webview may open. Each host keeps one, records every answer it posts and clears it
 * when the webview reloads or closes. A record for another repository than the current one is
 * dropped when it is next checked; a switch away and back with no open in between keeps it, and
 * it then names only files the host listed for that same repository.
 */
export class CiRangeDiffGrant {
    private latest?: Pick<ChangedSinceGreenMessage, "repoKey" | "hash" | "lastGreen" | "files">;

    /** Replaces the record with the answer being posted. */
    record(reply: ChangedSinceGreenMessage): void {
        this.latest = reply;
    }

    /** Forgets the record: the webview it was posted to is gone. */
    clear(): void {
        this.latest = undefined;
    }

    /** Whether the latest answer for `repoKey` listed exactly this file between exactly these revisions. */
    allows(repoKey: string, fromRev: string, toRev: string, file: CiRangeDiffFile): boolean {
        const latest = this.latest;
        if (latest && latest.repoKey !== repoKey) this.latest = undefined;
        return (
            latest !== undefined &&
            latest.repoKey === repoKey &&
            latest.lastGreen === fromRev &&
            latest.hash === toRev &&
            latest.files.some(
                (listed) =>
                    listed.path === file.path &&
                    listed.oldPath === file.oldPath &&
                    listed.status === file.status,
            )
        );
    }
}

/**
 * Validates an `openCiRangeDiff` message and opens the file's diff between the two revisions,
 * only when the host's latest answer to this webview listed that file and those revisions.
 * The path is checked again by the diff opener, which reads it from Git only.
 *
 * @param source - The host's repository and diff opener.
 * @param msg - Untrusted webview message.
 * @param grant - The host's record of what it last sent this webview.
 * @throws When a field of the message is malformed, or the diff cannot be opened.
 */
export async function answerOpenCiRangeDiff(
    source: CommitCiDetailSource,
    msg: Record<string, unknown>,
    grant: CiRangeDiffGrant,
): Promise<void> {
    readRequestId(msg.requestId);
    const { repoKey, path, oldPath, status } = msg;
    if (typeof repoKey !== "string") throw new Error("Invalid CI repository.");
    const fromRev = readHash(msg.fromRev, "diff revision");
    const toRev = readHash(msg.toRev, "diff revision");
    if (typeof path !== "string" || path.length === 0) throw new Error("Invalid diff path.");
    if (oldPath !== undefined && (typeof oldPath !== "string" || oldPath.length === 0)) {
        throw new Error("Invalid diff path.");
    }
    if (!FILE_STATUSES.has(status)) throw new Error("Invalid diff status.");
    if (!isE2eControlChannelActive()) return;
    const open = source.openRangeDiff;
    if (!open || repoKey !== source.repoKey()) return;
    const file: CiRangeDiffFile = {
        path,
        status: status as CiRangeDiffFile["status"],
        ...(oldPath === undefined ? {} : { oldPath }),
    };
    if (!grant.allows(repoKey, fromRev, toRev, file)) return;
    await open(fromRev, toRev, file);
}
