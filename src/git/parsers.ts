import type {
    AmendBranchCommitSummary,
    Commit,
    CommitDetail,
    CommitFile,
    MergeConflictFile,
    StashEntry,
    WorkingFile,
} from "../types";

const COMMIT_FIELD_SEP = "\0";
const GIT_NUL = "%x00";
const COMMIT_LOG_FIELD_COUNT = 8;
const AMEND_FIELD_COUNT = 3;

/**
 * Pretty format used by `git log -z` for commit rows in graph and history views.
 *
 * Fields are NUL-delimited and include a trailing separator so subjects, authors,
 * and ref decorations can contain tabs without corrupting parser alignment.
 */
export const COMMIT_LOG_FORMAT =
    ["%H", "%h", "%s", "%an", "%ae", "%aI", "%P", "%D"].join(GIT_NUL) + GIT_NUL;

/**
 * Pretty format used by `git show --no-patch` when loading a single commit detail.
 *
 * The body is separated with NUL bytes rather than line-based parsing because commit
 * messages may contain blank lines, tabs, and arbitrary text from Git history.
 */
export const COMMIT_DETAIL_FORMAT = ["%H", "%h", "%s", "%b", "%an", "%ae", "%aI", "%P", "%D"].join(
    GIT_NUL,
);

/** Format used for compact amend-candidate rows, separated by NUL bytes. */
export const AMEND_BRANCH_COMMIT_FORMAT = `%h%x00%s%x00%cI%x00`;

/**
 * Parses NUL-delimited `git log` output into commit rows expected by webviews.
 *
 * Empty separators are skipped and incomplete trailing rows are ignored so an empty
 * repository or interrupted output yields the commits that were fully parsed.
 */
export function parseCommitLog(result: string): Commit[] {
    const commits: Commit[] = [];
    const fields = result.split(COMMIT_FIELD_SEP);

    for (let index = 0; index + COMMIT_LOG_FIELD_COUNT - 1 < fields.length; ) {
        if (!fields[index]) {
            index += 1;
            continue;
        }
        const parts = fields.slice(index, index + COMMIT_LOG_FIELD_COUNT);

        commits.push({
            hash: parts[0],
            shortHash: parts[1],
            message: parts[2],
            author: parts[3],
            email: parts[4],
            date: parts[5],
            parentHashes: splitCommitParents(parts[6]),
            refs: splitCommitRefs(parts[7]),
        });
        index += COMMIT_LOG_FIELD_COUNT;
    }

    return commits;
}

/**
 * Builds a commit-detail payload from `git show --no-patch` output and file stats.
 *
 * When Git omits hash fields, callers' selected hash is used as the stable fallback
 * so UI actions can still target the commit that was requested.
 */
export function parseCommitDetail(
    info: string,
    fallbackHash: string,
    files: CommitFile[],
): CommitDetail {
    const parts = info.trim().split(COMMIT_FIELD_SEP);

    return {
        hash: parts[0] || fallbackHash,
        shortHash: parts[1] || fallbackHash.slice(0, 7),
        message: parts[2] || "",
        body: parts[3] || "",
        author: parts[4] || "",
        email: parts[5] || "",
        date: parts[6] || "",
        parentHashes: splitCommitParents(parts[7]),
        refs: splitCommitRefs(parts[8]),
        files,
    };
}

/**
 * Parses compact amend-candidate rows emitted by `AMEND_BRANCH_COMMIT_FORMAT`.
 *
 * Rows without a short hash are discarded, and subjects are preserved verbatim so
 * tabs or punctuation in commit summaries are not normalized for display.
 */
export function parseAmendBranchCommitSummaries(output: string): AmendBranchCommitSummary[] {
    const rows: AmendBranchCommitSummary[] = [];
    const fields = output.split(COMMIT_FIELD_SEP);

    for (let index = 0; index + AMEND_FIELD_COUNT - 1 < fields.length; ) {
        if (!fields[index]) {
            index += 1;
            continue;
        }
        const parts = fields.slice(index, index + AMEND_FIELD_COUNT);
        const shortHash = parts[0]?.trim() ?? "";
        const subject = parts[1] ?? "";
        const date = parts[2]?.trim() ?? "";
        if (shortHash) {
            rows.push({ shortHash, subject, date });
        }
        index += AMEND_FIELD_COUNT;
    }

    return rows;
}

/**
 * Parses tab-delimited `git stash list` output into current stash-stack entries.
 *
 * The numeric index is extracted from Git's `stash@{n}` decoration and falls back to
 * display order when the decoration is missing, matching how stash actions address it.
 */
export function parseStashEntries(result: string): StashEntry[] {
    const entries: StashEntry[] = [];

    for (const line of result.trim().split("\n")) {
        if (!line.trim()) continue;

        const [hash, ref, message, date] = line.split("\t");
        const indexMatch = (ref ?? "").match(/\{(\d+)\}/);
        entries.push({
            index: indexMatch ? parseInt(indexMatch[1]) : entries.length,
            message: message || "",
            date: date || "",
            hash: hash || "",
        });
    }

    return entries;
}

/**
 * Parses structured file-history rows for one repository-relative path.
 *
 * The subject is reconstructed from all remaining tab-delimited fields so commit
 * subjects containing tabs do not lose information; rows missing either hash are ignored.
 */
export function parseFileHistoryEntries(
    raw: string,
): Array<{ hash: string; shortHash: string; author: string; date: string; subject: string }> {
    // File-history parser favors readable normalization over fusing tiny string loops.
    // react-doctor-disable-next-line react-doctor/js-flatmap-filter
    return raw
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
            const [hash = "", shortHash = "", author = "", date = "", ...subjectParts] =
                line.split("\t");
            return {
                hash,
                shortHash,
                author,
                date,
                subject: subjectParts.join("\t"),
            };
        })
        .filter((entry) => entry.hash && entry.shortHash);
}

/**
 * Maps `git diff-tree --name-status` status letters into commit-file statuses.
 *
 * Unknown or score-suffixed status letters fall back to modified so the UI keeps the
 * file visible instead of dropping a row whose Git code was not anticipated.
 */
export function mapCommitFileStatus(code: string): CommitFile["status"] {
    if (VALID_COMMIT_FILE_STATUSES.has(code as CommitFile["status"])) {
        return code as CommitFile["status"];
    }
    return "M";
}

/**
 * Maps one column of porcelain status into the working-file status model.
 *
 * A blank status returns `null` to distinguish no change from an unknown Git code;
 * unknown non-blank values fall back to modified so affected paths remain visible.
 */
export function mapStatusCode(code: string): WorkingFile["status"] | null {
    switch (code) {
        case "M":
            return "M";
        case "A":
            return "A";
        case "D":
            return "D";
        case "R":
            return "R";
        case "C":
            return "C";
        case "?":
            return "?";
        case "U":
            return "U";
        case " ":
            return null;
        default:
            return "M";
    }
}

/** Returns whether a two-character porcelain status represents an unmerged conflict. */
export function isUnmergedConflictCode(code: string): boolean {
    return UNMERGED_CONFLICT_CODES.has(code);
}

/**
 * Converts a conflict-side status letter into the label shown in merge-conflict UI.
 *
 * Git reports additions and deletions explicitly; all other unmerged side codes are
 * treated as modified so the action label remains conservative.
 */
export function mapConflictSideState(code: string): MergeConflictFile["ours"] {
    if (code === "A") return "Added";
    if (code === "D") return "Deleted";
    return "Modified";
}

function splitCommitParents(raw: string | undefined): string[] {
    return raw ? raw.split(" ").filter(Boolean) : [];
}

function splitCommitRefs(raw: string | undefined): string[] {
    if (!raw) return [];
    const refs: string[] = [];
    for (const ref of raw.split(",")) {
        const trimmed = ref.trim();
        if (trimmed) refs.push(trimmed);
    }
    return refs;
}

const VALID_COMMIT_FILE_STATUSES = new Set<CommitFile["status"]>(["A", "M", "D", "R", "C", "T"]);

const UNMERGED_CONFLICT_CODES = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);
