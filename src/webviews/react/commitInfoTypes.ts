// Typed message protocol for communication between the commit info webview
// and the extension host. Defines all inbound and outbound message shapes.

import type { CommitDetail, ThemeFolderIconMap, ThemeIconFont, ThemeTreeIcon } from "../../types";

/** Messages sent FROM the webview TO the extension host. */
export type CommitInfoOutbound = { type: "ready" };

/** Messages sent FROM the extension host TO the webview. */
export type CommitInfoInbound =
    | {
          type: "setCommitDetail";
          detail: CommitDetail;
          folderIcon?: ThemeTreeIcon;
          folderExpandedIcon?: ThemeTreeIcon;
          folderIconsByName?: ThemeFolderIconMap;
          iconFonts?: ThemeIconFont[];
      }
    | { type: "clear" };
