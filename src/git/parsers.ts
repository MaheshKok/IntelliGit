import type {
    AmendBranchCommitSummary,
    Commit,
    CommitDetail,
    CommitFile,
    MergeConflictFile,
    StashEntry,
    WorkingFile,
} from "../types";

const COMMIT_FIELD_SEP = "\x1f";
const COMMIT_RECORD_SEP = "\x1e";
const AMEND_FIELD_SEP = "\x1f";
const AMEND_RECORD_SEP = "\x1e";

export const COMMIT_LOG_FORMAT =
    ["%H", "%h", "%s", "%an", "%ae", "%aI", "%P", "%D"].join(COMMIT_FIELD_SEP) + COMMIT_RECORD_SEP;

export const COMMIT_DETAIL_FORMAT = ["%H", "%h", "%s", "%b", "%an", "%ae", "%aI", "%P", "%D"].join(
    COMMIT_FIELD_SEP,
);

export const AMEND_BRANCH_COMMIT_FORMAT = `%h%x1f%s%x1f%cI%x1e`;

export function parseCommitLog(result: string): Commit[] {
    const commits: Commit[] = [];

    for (const record of result.split(COMMIT_RECORD_SEP)) {
        const trimmed = record.trim();
        if (!trimmed) continue;

        const parts = trimmed.split(COMMIT_FIELD_SEP);
        if (parts.length < 7) continue;

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
    }

    return commits;
}

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

export function parseAmendBranchCommitSummaries(output: string): AmendBranchCommitSummary[] {
    const rows: AmendBranchCommitSummary[] = [];

    for (const record of output.split(AMEND_RECORD_SEP)) {
        const trimmed = record.trim();
        if (!trimmed) continue;

        const parts = trimmed.split(AMEND_FIELD_SEP);
        if (parts.length < 3) continue;

        const shortHash = parts[0]?.trim() ?? "";
        const date = parts[parts.length - 1]?.trim() ?? "";
        const subject = parts.slice(1, -1).join(AMEND_FIELD_SEP);
        if (shortHash) {
            rows.push({ shortHash, subject, date });
        }
    }

    return rows;
}

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

export function parseFileHistoryEntries(
    raw: string,
): Array<{ hash: string; shortHash: string; author: string; date: string; subject: string }> {
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

export function mapCommitFileStatus(code: string): CommitFile["status"] {
    if (VALID_COMMIT_FILE_STATUSES.has(code as CommitFile["status"])) {
        return code as CommitFile["status"];
    }
    return "M";
}

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

export function isUnmergedConflictCode(code: string): boolean {
    return UNMERGED_CONFLICT_CODES.has(code);
}

export function mapConflictSideState(code: string): MergeConflictFile["ours"] {
    if (code === "A") return "Added";
    if (code === "D") return "Deleted";
    return "Modified";
}

function splitCommitParents(raw: string | undefined): string[] {
    return raw ? raw.split(" ").filter(Boolean) : [];
}

function splitCommitRefs(raw: string | undefined): string[] {
    return raw
        ? raw
              .split(",")
              .map((ref) => ref.trim())
              .filter(Boolean)
        : [];
}

const VALID_COMMIT_FILE_STATUSES = new Set<CommitFile["status"]>(["A", "M", "D", "R", "C", "T"]);

const UNMERGED_CONFLICT_CODES = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);
