import type { GitExecutor } from "../executor";
import type {
    InteractiveRebaseRangeCommit,
    InteractiveRebaseRangeRejectionReason,
    InteractiveRebaseRangeResult,
} from "./types";

/** Product limit for commits offered in one interactive-rebase dialog. */
export const MAX_INTERACTIVE_REBASE_RANGE_COMMITS = 500;

/** Byte ceiling for one range load, so a pathological body cannot exhaust the extension host. */
export const MAX_INTERACTIVE_REBASE_RANGE_OUTPUT_BYTES = 4 * 1024 * 1024;

const FULL_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const RANGE_RECORD_ARITY = 4;
const RANGE_LOG_FORMAT = "--format=%H%x00%an%x00%aI%x00%B";
// Git only transcodes a commit to UTF-8 when `i18n.commitEncoding` is unset; with it set (say to
// ISO-8859-1) the object keeps its original bytes, an `encoding` header records them, and `git log`
// emits them raw — which `toString("utf8")` below would turn into U+FFFD. Asking for the output
// encoding explicitly makes Git convert via that header on every path. Verified by probing real
// commits under unset, set, and `logOutputEncoding` configurations.
const RANGE_LOG_ENCODING = "--encoding=UTF-8";

/** Overrides used by tests to exercise the real truncation boundary cheaply. */
export interface InteractiveRebaseRangeOptions {
    /** Byte ceiling for a range load; defaults to {@link MAX_INTERACTIVE_REBASE_RANGE_OUTPUT_BYTES}. */
    maxOutputBytes?: number;
}

/**
 * Loads the base-to-head rebase range with fixed-arity NUL framing and batched pushedness.
 *
 * Both endpoints are explicit object IDs rather than `HEAD`, so every query below observes the
 * same tip even if the branch moves mid-load. Resolving `HEAD` here instead would let the count
 * probe, the body load, and the caller's own `rev-parse` each see a different commit, and the
 * caller would then record a tip that no longer matches the range it was handed.
 *
 * This function is the boundary that spawns Git, so it owns object-ID validation: the revision
 * range is constructed here from validated hashes. A hash is rejected unless it is a bare
 * lowercase object ID, because Git parses a leading `-` as an option — an argument such as
 * `--output=<path>` is accepted by `git log` and writes an arbitrary file. Both read commands
 * additionally pass `--end-of-options` so no revision can be reparsed as a flag.
 *
 * A count probe runs before body loading, and every malformed, empty, or bounded-output case
 * rejects without returning a partial range.
 */
export async function loadInteractiveRebaseRange(
    executor: GitExecutor,
    baseHash: string,
    headHash: string,
    options: InteractiveRebaseRangeOptions = {},
): Promise<InteractiveRebaseRangeResult> {
    if (!FULL_OBJECT_ID.test(baseHash)) return rejected("invalid-base-hash");
    if (!FULL_OBJECT_ID.test(headHash)) return rejected("invalid-head-hash");
    const revisionRange = `${baseHash}^..${headHash}`;
    const maxOutputBytes = options.maxOutputBytes ?? MAX_INTERACTIVE_REBASE_RANGE_OUTPUT_BYTES;

    let countOutput: string;
    try {
        countOutput = (
            await executor.run(["rev-list", "--count", "--end-of-options", revisionRange])
        ).trim();
    } catch {
        return rejected("git-error");
    }
    if (countOutput.length === 0) return rejected("invalid-range-count");
    const count = Number(countOutput);
    if (!Number.isSafeInteger(count) || count < 0) return rejected("invalid-range-count");
    if (count === 0) return rejected("empty-range");
    if (count > MAX_INTERACTIVE_REBASE_RANGE_COMMITS) return rejected("range-too-large");

    try {
        const [rangeOutput, unpushedOutput] = await Promise.all([
            executor.runBinary(
                [
                    "log",
                    "--reverse",
                    "-z",
                    RANGE_LOG_ENCODING,
                    RANGE_LOG_FORMAT,
                    "--end-of-options",
                    revisionRange,
                ],
                { maxOutputBytes },
            ),
            // `--not` must precede non-option arguments, so this query cannot also carry
            // `--end-of-options`; the range is safe because it is built above from a validated
            // object ID. Scoping the query to the range keeps its output bounded by the
            // 500-commit cap instead of enumerating branch history repository-wide.
            executor.runBinary(["rev-list", revisionRange, "--not", "--remotes"], {
                maxOutputBytes,
            }),
        ]);
        if (rangeOutput.truncated || unpushedOutput.truncated) return rejected("output-truncated");
        return parseRangeOutput(rangeOutput.stdout, unpushedOutput.stdout.toString("utf8"), count);
    } catch {
        return rejected("git-error");
    }
}

/**
 * Splits one NUL-framed `git log` stream into records without ever resynchronizing on content.
 *
 * Grouping is strictly by arity, and the record count is cross-checked against the independent
 * count probe, so framing drift surfaces as a rejection rather than as a silently short range.
 */
function parseRangeOutput(
    stdout: Buffer,
    unpushedOutput: string,
    expectedCount: number,
): InteractiveRebaseRangeResult {
    if (stdout.length === 0) return rejected("missing-trailing-sentinel");

    const fields = stdout.toString("utf8").split("\0");
    if (fields.at(-1) !== "") return rejected("missing-trailing-sentinel");
    fields.pop();

    // A second sentinel and a genuine arity error are indistinguishable by remainder alone
    // (both leave `length % 4 === 1`), so both report the same honest reason.
    if (fields.length % RANGE_RECORD_ARITY !== 0) return rejected("malformed-arity");

    const unpushedHashes = new Set(
        unpushedOutput.split("\n").flatMap((line) => {
            const hash = line.trim().toLowerCase();
            return hash ? [hash] : [];
        }),
    );
    const commits: InteractiveRebaseRangeCommit[] = [];
    for (let index = 0; index < fields.length; index += RANGE_RECORD_ARITY) {
        const [hash, authorName, authoredAt, body] = fields.slice(
            index,
            index + RANGE_RECORD_ARITY,
        );
        commits.push({
            hash,
            authorName,
            authoredAt,
            body,
            isPushed: !unpushedHashes.has(hash.toLowerCase()),
        });
    }
    if (commits.length !== expectedCount) return rejected("count-mismatch");
    return { status: "ok", commits };
}

function rejected(reason: InteractiveRebaseRangeRejectionReason): InteractiveRebaseRangeResult {
    return { status: "rejected", reason };
}
