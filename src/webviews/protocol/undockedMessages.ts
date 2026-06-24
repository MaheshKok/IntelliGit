// Unified message protocol for the undocked webview.
// Combines message types from both the CommitGraph and CommitPanel
// webviews into a single channel.

import type { BranchAction, CommitAction, WorktreeAction } from "./commitGraphTypes";
import type { Branch } from "../../types";
import type {
    InboundMessage as CommitPanelInbound,
    OutboundMessage as CommitPanelOutbound,
} from "./commitPanelMessages";
import type { CommitGraphInbound } from "./commitGraphTypes";

/**
 * Messages sent from the extension host to the undocked editor-tab webview.
 *
 * The undocked view multiplexes graph and commit-panel protocols on one VS Code
 * webview channel, plus layout settings that only exist in the combined view.
 * When adding a discriminant, keep it distinct from the imported protocols or
 * update the undocked message switch to resolve the collision intentionally.
 */
export type UnifiedInbound =
    | CommitGraphInbound
    | CommitPanelInbound
    | {
          /** Layout setting event resolved from IntelliGit/workbench configuration. */
          type: "settings";
          /** Concrete display side after resolving `auto`; the webview does not write it back. */
          commitWindowPosition: "left" | "right";
      }
    | {
          /**
           * Layout-restore event sent before slow Git refreshes so equal startup
           * widths do not overwrite the user's persisted layout.
           */
          type: "columnWidths";
          /** Branch column width in CSS pixels from workspace-state persistence. */
          branchWidth: number;
          /** Commit graph column width in CSS pixels from workspace-state persistence. */
          graphWidth: number;
          /** Commit info column width in CSS pixels from workspace-state persistence. */
          infoWidth: number;
          /** Commit panel column width in CSS pixels from workspace-state persistence. */
          commitPanelWidth: number;
      };

/**
 * Graph-side messages sent from the undocked webview to the extension host.
 *
 * These mirror `CommitGraphOutbound` but add `dock`. The shared `ready`
 * discriminant initializes both graph and commit-panel state in the undocked
 * host, so the webview sends it once for the combined surface.
 */
type GraphOutbound =
    | {
          /** Lifecycle event requesting initial graph, commit-panel, layout, and draft state. */
          type: "ready";
      }
    | {
          /** Selection event for the commit whose detail panes should be loaded. */
          type: "selectCommit";
          /** Full Git object ID from the rendered commit row. */
          hash: string;
      }
    | {
          /** Pagination request for the next graph page using current filters. */
          type: "loadMore";
      }
    | {
          /** Search request that resets graph pagination. */
          type: "filterText";
          /** Literal grep text supplied by the UI. */
          text: string;
      }
    | {
          /** Branch-filter request that resets text search and graph pagination. */
          type: "filterBranch";
          /** Git branch display/action name, or `null` for all branches. */
          branch: string | null;
      }
    | {
          /** Command requesting a branch context-menu action on the host side. */
          type: "branchAction";
          /** Validated against shared branch action values before command dispatch. */
          action: BranchAction;
          /** Branch name from the latest graph branch snapshot. */
          branchName: string;
      }
    | {
          /** Command requesting deletion of command/ctrl-selected branch rows. */
          type: "deleteBranches";
          /** Selected branch rows from the latest graph branch snapshot. */
          branches?: Branch[];
          /** Legacy payload kept so older webviews fail closed through host validation. */
          branchNames?: string[];
      }
    | {
          /** Command requesting a worktree row action on the host side. */
          type: "worktreeAction";
          /** Validated against shared worktree action values before command dispatch. */
          action: WorktreeAction;
          /** Absolute worktree path from the latest trusted host snapshot. */
          path: string;
      }
    | {
          /** Command requesting a commit context-menu action on the host side. */
          type: "commitAction";
          /** Validated against shared commit action values before Git action dispatch. */
          action: CommitAction;
          /** Full Git object ID for the targeted commit. */
          hash: string;
      }
    | {
          /** Command asking the host to open a committed file diff. */
          type: "openCommitFileDiff";
          /** Full Git object ID from the rendered commit detail. */
          commitHash: string;
          /** Repository-relative file path from Git diff output. */
          filePath: string;
      }
    | {
          /** Request for GitHub check runs and commit statuses for one commit. */
          type: "requestCommitChecks";
          /** Full Git object ID from the rendered commit row. */
          hash: string;
      }
    | {
          /** Request to open a GitHub check/status target URL outside the webview. */
          type: "openCommitCheckUrl";
          /** HTTP(S) target URL returned by GitHub. */
          url: string;
      }
    | {
          /** Command requesting the controller to return IntelliGit to docked views. */
          type: "dock";
      };

/**
 * Messages sent from the undocked webview to the extension host.
 *
 * Commit-panel commands keep the semantics documented in `commitPanelMessages`;
 * graph commands keep the graph semantics above. The `columnWidths` discriminant
 * is intentionally bidirectional: outbound persists debounced user drag state,
 * while inbound restores workspace-state values on startup.
 */
export type UnifiedOutbound =
    | GraphOutbound
    | CommitPanelOutbound
    | {
          /** Layout persistence event sent after restored widths hydrate or a user drags. */
          type: "columnWidths";
          /** Branch column width in normalized CSS pixels. */
          branchWidth: number;
          /** Commit graph column width in normalized CSS pixels. */
          graphWidth: number;
          /** Commit info column width in normalized CSS pixels. */
          infoWidth: number;
          /** Commit panel column width in normalized CSS pixels. */
          commitPanelWidth: number;
      };
