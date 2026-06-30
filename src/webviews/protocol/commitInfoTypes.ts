// Typed message protocol for communication between the commit info webview
// and the extension host. Defines all inbound and outbound message shapes.

import type { CommitDetail, ThemeFolderIconMap, ThemeIconFont, ThemeTreeIcon } from "../../types";

/**
 * Commit info messages sent from the standalone Changed Files webview to the host.
 *
 * The standalone pane is display-only except for diff-open commands. The host
 * validates both the commit hash and repository-relative file path before
 * routing to VS Code diff services.
 */
export type CommitInfoOutbound =
    | {
          /** Lifecycle event requesting the host's current commit detail snapshot. */
          type: "ready";
      }
    | {
          /** Command asking the host to open a committed file diff. */
          type: "openCommitFileDiff";
          /** Full Git object ID from the rendered `CommitDetail`. */
          commitHash: string;
          /** Repository-relative path from commit file Git output; host validates before use. */
          filePath: string;
      };

/**
 * Commit info messages sent from the extension host to the standalone webview.
 *
 * The detail payload comes from the selected graph commit. Optional icon theme
 * fields are present only when the host can serialize webview-safe resources or
 * glyph metadata for the active file icon theme.
 */
export type CommitInfoInbound =
    | {
          /** State update containing the commit detail currently selected elsewhere. */
          type: "setCommitDetail";
          /** Git `show`/`diff-tree` detail snapshot; `detail.hash` is the stable action ID. */
          detail: CommitDetail;
          /** Default collapsed folder icon for changed-file paths when available. */
          folderIcon?: ThemeTreeIcon;
          /** Default expanded folder icon for changed-file paths when available. */
          folderExpandedIcon?: ThemeTreeIcon;
          /** Folder icon overrides for paths inside `detail.files`, keyed by folder name. */
          folderIconsByName?: ThemeFolderIconMap;
          /** Webview-safe font-face payloads needed to render glyph-based file icons. */
          iconFonts?: ThemeIconFont[];
      }
    | {
          /** Event clearing the pane when no commit is selected or selection became stale. */
          type: "clear";
          /** True while the host expects an automatic replacement selection to arrive. */
          loading?: boolean;
      };
