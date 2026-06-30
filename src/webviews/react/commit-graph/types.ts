// Shared commit graph React types that must not depend on component modules.
// Keeping reducer actions here avoids import cycles between CommitGraphPanel and extracted hooks.
// The types mirror the existing extension-host message payloads used by the root panel reducer.

import type {
    Branch,
    Commit,
    CommitChecksSnapshot,
    CommitDetail,
    GitWorktree,
    ThemeFolderIconMap,
    ThemeIconFont,
    ThemeTreeIcon,
} from "../../../types";

/** Actions that update the commit graph panel reducer state. */
export type CommitGraphPanelAction =
    | {
          type: "loadCommits";
          commits: Commit[];
          append: boolean;
          hasMore: boolean;
          selectedHash: string | null;
          unpushedHashes?: string[];
      }
    | {
          type: "setBranches";
          branches: Branch[];
          worktrees?: GitWorktree[];
          folderIcon?: ThemeTreeIcon;
          folderExpandedIcon?: ThemeTreeIcon;
          folderIconsByName?: ThemeFolderIconMap;
          iconFonts?: ThemeIconFont[];
          commitChecksEnabled?: boolean;
      }
    | { type: "setSelectedBranch"; branch: string | null }
    | {
          type: "setCommitDetail";
          detail: CommitDetail;
          folderIcon?: ThemeTreeIcon;
          folderExpandedIcon?: ThemeTreeIcon;
          folderIconsByName?: ThemeFolderIconMap;
          iconFonts?: ThemeIconFont[];
      }
    | { type: "clearCommitDetail"; loading?: boolean }
    | { type: "setCommitChecks"; snapshot: CommitChecksSnapshot }
    | { type: "markCommitChecksLoading"; hash: string }
    | { type: "loadError"; clearCommits: boolean }
    | { type: "selectCommit"; hash: string }
    | { type: "selectBranch"; branch: string | null }
    | { type: "setFilterText"; text: string };
