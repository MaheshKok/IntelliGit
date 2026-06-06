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

export const COMMIT_LOG_FORMAT =
    ["%H", "%h", "%s", "%an", "%ae", "%aI", "%P", "%D"].join(GIT_NUL) + GIT_NUL;

export const COMMIT_DETAIL_FORMAT = ["%H", "%h", "%s", "%b", "%an", "%ae", "%aI", "%P", "%D"].join(
    GIT_NUL,
);

export const AMEND_BRANCH_COMMIT_FORMAT = `%h%x00%s%x00%cI%x00`;

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
