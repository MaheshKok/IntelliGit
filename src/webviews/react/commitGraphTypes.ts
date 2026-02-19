// Typed message protocol for communication between the commit graph webview
// and the extension host. Defines all inbound and outbound message shapes.

import type { Branch, Commit } from "../../types";

/** Messages sent FROM the webview TO the extension host. */
export type CommitGraphOutbound =
    | { type: "ready" }
    | { type: "selectCommit"; hash: string }
    | { type: "filterText"; text: string }
    | { type: "loadMore" }
    | { type: "filterBranch"; branch: string | null }
    | { type: "branchAction"; action: string; branchName: string }
    | { type: "commitAction"; action: string; hash: string; targetBranch?: string };

/** Messages sent FROM the extension host TO the webview. */
export type CommitGraphInbound =
    | {
          type: "loadCommits";
          commits: Commit[];
          hasMore: boolean;
          append: boolean;
          unpushedHashes: string[];
      }
    | { type: "setBranches"; branches: Branch[] }
    | { type: "setSelectedBranch"; branch: string | null };
