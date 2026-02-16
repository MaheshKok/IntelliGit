export interface Branch {
    name: string;
    hash: string;
    isRemote: boolean;
    isCurrent: boolean;
    remote?: string;
    ahead: number;
    behind: number;
}

export interface Commit {
    hash: string;
    shortHash: string;
    message: string;
    author: string;
    email: string;
    date: string;
    parentHashes: string[];
    refs: string[];
}

export interface CommitFile {
    path: string;
    status: "A" | "M" | "D" | "R" | "C" | "T";
    additions: number;
    deletions: number;
}

export interface CommitDetail {
    hash: string;
    shortHash: string;
    message: string;
    body: string;
    author: string;
    email: string;
    date: string;
    parentHashes: string[];
    refs: string[];
    files: CommitFile[];
}

export interface WorkingFile {
    path: string;
    status: "M" | "A" | "D" | "U" | "?" | "R" | "C";
    staged: boolean;
    additions: number;
    deletions: number;
}

export interface StashEntry {
    index: number;
    message: string;
    date: string;
    hash: string;
}

export type GitLogRequest =
    | { type: "getInitialData" }
    | { type: "loadMore" }
    | { type: "selectCommit"; hash: string }
    | { type: "filterBranch"; branch: string | null }
    | { type: "filterText"; text: string }
    | { type: "checkoutBranch"; name: string }
    | { type: "refresh" };

export type GitLogResponse =
    | {
          type: "initialData";
          branches: Branch[];
          commits: Commit[];
          currentBranch: string;
          hasMore: boolean;
      }
    | { type: "moreCommits"; commits: Commit[]; hasMore: boolean }
    | { type: "commitDetails"; detail: CommitDetail }
    | { type: "error"; message: string };
