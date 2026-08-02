import type {
    RebaseAction,
    RebaseSubmissionEntry,
    RebaseSubmissionValidationReason,
    RebaseSubmissionValidationResult,
    RebaseTodoEntry,
} from "./types";
import { normalizeFullObjectId } from "./objectId";

/** Builds the fail-closed rejection result carrying the machine-readable reason code. */
function invalid(reason: RebaseSubmissionValidationReason): RebaseSubmissionValidationResult {
    return { status: "invalid", reason };
}

/** Byte ceiling for one reword/squash message, far beyond any real commit message. */
export const MAX_INTERACTIVE_REBASE_MESSAGE_BYTES = 1024 * 1024;

const ALLOWED_ACTIONS = new Set<RebaseAction>(["pick", "reword", "squash", "fixup", "drop"]);

/** Builds deterministic Git todo-file content in the supplied oldest-first dialog order. */
export function buildRebaseTodo(entries: readonly RebaseTodoEntry[]): string {
    const lines = entries.map((entry) => {
        const message =
            entry.message === undefined
                ? ""
                : ` ${entry.message.split(/[\r\n]/, 1)[0].replace(/[\r\n\0]/g, "")}`;
        return `${entry.action} ${entry.hash}${message}`;
    });
    return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

/**
 * Validates an untrusted dialog submission before any entry can reach a Git todo file.
 *
 * Offered hashes are host-recorded and may not be augmented, reordered, or replaced by
 * the submitted entries. Messages may be multi-line because the todo writer truncates and
 * sanitizes them independently. The returned valid entries are copied to prevent caller mutation.
 */
export function validateRebaseSubmission(
    entries: readonly RebaseSubmissionEntry[],
    offeredHashes: ReadonlySet<string>,
): RebaseSubmissionValidationResult {
    if (entries.length !== offeredHashes.size) return invalid("entry-count-mismatch");

    const offered = new Set(Array.from(offeredHashes, (hash) => hash.toLowerCase()));
    const seen = new Set<string>();
    const validated: RebaseTodoEntry[] = [];

    for (const entry of entries) {
        if (!isRebaseAction(entry.action)) return invalid("invalid-action");
        const normalizedHash = normalizeFullObjectId(entry.hash);
        if (!normalizedHash) {
            return invalid("invalid-hash");
        }
        if (
            entry.message !== undefined &&
            (typeof entry.message !== "string" ||
                /\0/.test(entry.message) ||
                Buffer.byteLength(entry.message, "utf8") > MAX_INTERACTIVE_REBASE_MESSAGE_BYTES)
        ) {
            return invalid("invalid-message");
        }
        if (!offered.has(normalizedHash)) return invalid("hash-not-offered");
        if (seen.has(normalizedHash)) return invalid("duplicate-hash");
        if (
            (entry.action === "reword" || entry.action === "squash") &&
            (typeof entry.message !== "string" || entry.message.trim().length === 0)
        ) {
            return invalid("missing-message");
        }
        seen.add(normalizedHash);
        validated.push({
            hash: normalizedHash,
            action: entry.action,
            ...(typeof entry.message === "string" ? { message: entry.message } : {}),
        });
    }

    const firstActive = validated.find((entry) => entry.action !== "drop");
    if (firstActive?.action === "squash" || firstActive?.action === "fixup") {
        return invalid("invalid-first-action");
    }
    return { status: "valid", entries: validated };
}

function isRebaseAction(action: unknown): action is RebaseAction {
    return typeof action === "string" && ALLOWED_ACTIONS.has(action as RebaseAction);
}
