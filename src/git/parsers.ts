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
const AMEND_FIELD_COUNT = 4;

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
export const AMEND_BRANCH_COMMIT_FORMAT = ["%H", "%h", "%s", "%cI"].join(GIT_NUL) + GIT_NUL;

/**
 * Parses NUL-delimited `git log` output into commit rows expected by webviews.
 *
 * Empty separators are skipped and incomplete trailing rows are ignored so an empty
 * repository or interrupted output yields the commits that were fully parsed.
 */
export function parseCommitLog(result: string): Commit[] {
    const commits: Commit[] = [];
    const fields = result.split(COMMIT_FIELD_SEP);

    for (let index = 0; index + COMMIT_LOG_FIELD_COUNT - 1 < fields.length;) {
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
 * Rows without full and short hashes are discarded, and subjects are preserved
 * verbatim so tabs or punctuation in commit summaries are not normalized for display.
 */
export function parseAmendBranchCommitSummaries(output: string): AmendBranchCommitSummary[] {
    const rows: AmendBranchCommitSummary[] = [];
    const fields = output.split(COMMIT_FIELD_SEP);

    for (let index = 0; index + AMEND_FIELD_COUNT - 1 < fields.length;) {
        if (!fields[index]) {
            index += 1;
            continue;
        }
        const parts = fields.slice(index, index + AMEND_FIELD_COUNT);
        const hash = parts[0]?.trim() ?? "";
        const shortHash = parts[1]?.trim() ?? "";
        const subject = parts[2] ?? "";
        const date = parts[3]?.trim() ?? "";
        if (hash && shortHash) {
            rows.push({ hash, shortHash, subject, date });
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
function mapCommitFileStatus(code: string): CommitFile["status"] {
    if (VALID_COMMIT_FILE_STATUSES.has(code as CommitFile["status"])) {
        return code as CommitFile["status"];
    }
    return "M";
}

/** One file record from `git diff-tree --name-status -z`. */
export interface CommitNameStatusRecord {
    /** Post-change path shown to the user. */
    path: string;
    /** Pre-change path for a rename or copy. */
    oldPath?: string;
    status: CommitFile["status"];
}

/**
 * Parses NUL-delimited `git diff-tree --name-status -z` output into file records.
 *
 * Status and paths are separate NUL fields, so tabs and newlines inside a path stay
 * literal. Rename and copy rows carry the source before the destination; every other
 * status carries one path. Truncated records are ignored rather than guessed at.
 */
export function parseCommitNameStatus(output: string): CommitNameStatusRecord[] {
    const records: CommitNameStatusRecord[] = [];
    const fields = output.split(COMMIT_FIELD_SEP);
    for (let index = 0; index < fields.length;) {
        const code = fields[index++];
        if (!code) continue;
        const firstPath = fields[index++];
        if (firstPath === undefined) break;
        const status = mapCommitFileStatus(code.charAt(0));
        if (status !== "R" && status !== "C") {
            records.push({ path: firstPath, status });
            continue;
        }
        const path = fields[index++];
        if (path) records.push({ path, oldPath: firstPath, status });
    }
    return records;
}

/** One file record from `git diff-tree --numstat -z`. */
export interface CommitNumstatRecord {
    /** Post-change path; rename and copy stats attach to the destination. */
    path: string;
    additions: number;
    deletions: number;
}

/**
 * Parses NUL-delimited `git diff-tree --numstat -z` output into line counts by path.
 *
 * A normal record is `<added>\t<deleted>\t<path>`. Rename and copy records leave the
 * path field empty and follow it with the source and destination as separate NUL
 * fields, so only the destination is returned. Binary counts (`-`) read as zero.
 */
export function parseCommitNumstat(output: string): CommitNumstatRecord[] {
    const records: CommitNumstatRecord[] = [];
    const fields = output.split(COMMIT_FIELD_SEP);
    for (let index = 0; index < fields.length; index++) {
        const record = fields[index];
        // These are string delimiter lookups, not repeated array scans.
        // react-doctor-disable-next-line react-doctor/js-set-map-lookups
        const firstTab = record.indexOf("\t");
        // react-doctor-disable-next-line react-doctor/js-set-map-lookups
        const secondTab = record.indexOf("\t", firstTab + 1);
        if (firstTab < 0 || secondTab < 0) continue;
        let path = record.slice(secondTab + 1);
        if (!path) {
            index += 2;
            path = fields[index] ?? "";
        }
        if (!path) continue;
        records.push({
            path,
            additions: parseNumstatCount(record.slice(0, firstTab)),
            deletions: parseNumstatCount(record.slice(firstTab + 1, secondTab)),
        });
    }
    return records;
}

/** Reads a numstat count, treating Git's binary marker and malformed text as zero. */
function parseNumstatCount(value: string): number {
    if (value === "-") return 0;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
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
        case "!":
            return "!";
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
