import type { MergeConflictFile } from "../../types";

/**
 * Snapshot sent by the host to render the merge-conflict session panel.
 *
 * Branch labels are display-only and may be fallback text when Git cannot name a
 * side. File entries come from `git status --porcelain -z`; their paths are
 * repository-relative action identifiers that the host revalidates when the
 * webview sends a command back.
 */
export interface MergeConflictSessionData {
    /** Display label for the incoming/theirs side of the conflict. */
    sourceBranch: string;
    /** Display label for the current/ours side of the conflict. */
    targetBranch: string;
    /** Sorted unresolved conflict files parsed from Git porcelain status output. */
    files: MergeConflictFile[];
}

/**
 * Merge-conflict session messages sent from the webview to the extension host.
 *
 * The webview sends only lifecycle events and user commands. `filePath` values
 * originate from `MergeConflictFile.path` but still cross an untrusted webview
 * boundary, so the host treats missing or blank paths as no-ops and validates
 * repository-relative paths before invoking Git or VS Code commands.
 */
export type OutboundMessage =
    | {
          /** Lifecycle event requesting the current unresolved conflict snapshot. */
          type: "ready";
      }
    | {
          /** User event requesting a fresh unresolved conflict snapshot. */
          type: "refresh";
      }
    | {
          /** Command opening the merge editor for one unresolved file. */
          type: "openMerge";
          /** Repository-relative path from `MergeConflictFile.path`. */
          filePath: string;
      }
    | {
          /** Command checking out and staging the current/ours side for one file. */
          type: "acceptYours";
          /** Repository-relative path from `MergeConflictFile.path`. */
          filePath: string;
      }
    | {
          /** Command checking out and staging the incoming/theirs side for one file. */
          type: "acceptTheirs";
          /** Repository-relative path from `MergeConflictFile.path`. */
          filePath: string;
      }
    | {
          /** Command closing the merge-conflict session panel. */
          type: "close";
      };

/**
 * Merge-conflict session messages sent from the extension host to the webview.
 *
 * `setSessionData` is both the initial response and the refresh result after an
 * accept/open action. The host may dispose the panel instead of sending another
 * payload when all conflicts resolve after a command.
 */
export type InboundMessage =
    | {
          /** State update containing the latest unresolved conflict snapshot. */
          type: "setSessionData";
          /** Display labels plus actionable conflict file paths from Git status output. */
          data: MergeConflictSessionData;
      }
    | {
          /** Error event emitted when the host cannot load or mutate conflict state. */
          type: "loadError";
          /** User-visible error text normalized by the host. */
          message: string;
      };
