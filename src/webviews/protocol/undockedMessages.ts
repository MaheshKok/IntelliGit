// Unified message protocol for the undocked webview.
// Combines message types from both the CommitGraph and CommitPanel
// webviews into a single channel.

import type { BranchAction, CommitAction } from "./commitGraphTypes";
import type {
    InboundMessage as CommitPanelInbound,
    OutboundMessage as CommitPanelOutbound,
} from "./commitPanelMessages";
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
type GraphOutbound =
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
    | { type: "dock" };

export type UnifiedOutbound =
    | GraphOutbound
    | CommitPanelOutbound
    // Column width persistence
    | {
          type: "columnWidths";
          branchWidth: number;
          graphWidth: number;
          infoWidth: number;
          commitPanelWidth: number;
      };
