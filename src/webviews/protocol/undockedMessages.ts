// Unified message protocol for the undocked webview.
// Combines message types from both the CommitGraph and CommitPanel
// webviews into a single channel.

import type { BranchAction, CommitAction } from "./commitGraphTypes";
import type { InboundMessage as CommitPanelInbound } from "./commitPanelMessages";
import type { CommitGraphInbound } from "./commitGraphTypes";

// --- Inbound (extension → webview) ---
// Union of all inbound message types from both views.
export type UnifiedInbound =
    | CommitGraphInbound
    | CommitPanelInbound
    | { type: "settings"; commitWindowPosition: "left" | "right" }
    // Extension-sent column widths (persisted across panel open/close)
    | {
          type: "columnWidths";
          branchWidth: number;
          graphWidth: number;
          infoWidth: number;
          commitPanelWidth: number;
      };

// --- Outbound (webview → extension) ---
export type UnifiedOutbound =
    // Graph-side messages
    | { type: "ready" }
    | { type: "selectCommit"; hash: string }
    | { type: "loadMore" }
    | { type: "filterText"; text: string }
    | { type: "filterBranch"; branch: string | null }
    | { type: "branchAction"; action: BranchAction; branchName: string }
    | { type: "commitAction"; action: CommitAction; hash: string }
    | {
          type: "openCommitFileDiff";
          commitHash: string;
          filePath: string;
      }
    | { type: "dock" }
    // Commit-panel-side messages
    | { type: "refresh" }
    | { type: "saveCommitDraft"; message: string }
    | { type: "stageFiles"; paths: string[] }
    | { type: "unstageFiles"; paths: string[] }
    | {
          type: "commitSelected";
          paths: string[];
          message: string;
          amend: boolean;
          push: boolean;
      }
    | { type: "commit"; message: string; amend: boolean }
    | { type: "commitAndPush"; message: string; amend: boolean }
    | { type: "publishBranch" }
    | { type: "getLastCommitMessage" }
    | { type: "getAmendBranchCommits" }
    | { type: "rollback"; paths: string[] }
    | { type: "showDiff"; path: string }
    | { type: "shelveSave"; name?: string; paths?: string[] }
    | { type: "shelfPop"; index: number }
    | { type: "shelfApply"; index: number }
    | { type: "shelfDelete"; index: number }
    | { type: "shelfSelect"; index: number }
    | { type: "showShelfDiff"; index: number; path: string }
    | { type: "openFile"; path: string }
    | { type: "deleteFile"; path: string }
    | { type: "showHistory"; path: string }
    // Column width persistence
    | {
          type: "columnWidths";
          branchWidth: number;
          graphWidth: number;
          infoWidth: number;
          commitPanelWidth: number;
      };
