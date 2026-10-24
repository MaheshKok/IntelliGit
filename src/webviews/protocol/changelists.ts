import type { ChangelistState, ChangeFileView, SelectedFileChanges } from "./changeSelection";

/** Host-owned destination choice captured before a list-targeted operation starts. */
export type ChangelistTarget =
    | { readonly kind: "existing"; readonly id: string; readonly revision: number }
    | { readonly kind: "new"; readonly name: string; readonly revision: number };

export type { ShelfDraftChoice } from "./targetOperation";

/** New worktree commands always carry an exact host-issued repository root. */
export type ChangelistOutbound =
    | {
          type: "saveChangelistShelf";
          repositoryRoot: string;
          requestId: string;
          revision: number;
          scope: "list" | "files";
          listId: string;
          paths?: string[];
          /** Omitted means Save alone; removal and rollback are separate, explicitly confirmed intents. */
          operation?: "save" | "saveAndRemove" | "rollback";
      }
    | { type: "loadChangelists"; repositoryRoot: string }
    | {
          type: "changelistDraft";
          repositoryRoot: string;
          listId: string;
          action: "select" | "save";
          requestId?: string;
          expected?: string;
          message?: string;
      }
    | {
          type: "changelistAction";
          repositoryRoot: string;
          revision: number;
          action:
              | "create"
              | "rename"
              | "remove"
              | "activate"
              | "move"
              | "resetSelection"
              | "reviewRecovery";
          listId?: string;
          paths?: string[];
          sourceListId?: string;
      }
    | { type: "openPartialChanges"; repositoryRoot: string; path: string; listId?: string }
    | {
          type: "commitChangelist";
          repositoryRoot: string;
          revision: number;
          listId: string;
          paths: string[];
          message: string;
          amend: boolean;
          push: boolean;
      };

/** Lists are metadata snapshots, not browser-owned Git state. */
export type ChangelistReply =
    | {
          type: "changelistShelfResult";
          repositoryRoot: string;
          requestId: string;
          message: string;
          shelfId?: string;
          error?: string;
      }
    | {
          type: "setChangelists";
          repositoryRoot: string;
          state: ChangelistState;
          busy?: boolean;
          hasRecoveryIssues?: boolean;
      }
    | {
          type: "changelistDraftResult";
          repositoryRoot: string;
          listId: string;
          requestId: string;
          message: string;
          error?: string;
      };

/** The standalone partial editor cannot choose another repository or filesystem target. */
export type PartialEditorOutbound =
    | { type: "ready"; side?: "working" | "index" }
    | { type: "stageSelection"; selection: SelectedFileChanges }
    | { type: "useSelection"; selection: SelectedFileChanges }
    | {
          type: "saveSelection" | "shelveSelection" | "rollbackSelection" | "exportSelection";
          selection: SelectedFileChanges;
      }
    | { type: "commitSelection"; selection: SelectedFileChanges; message: string }
    | {
          type: "assignSelection";
          selection: SelectedFileChanges;
          listId: string;
          revision: number;
      }
    | { type: "openNative" };

/** Successful mutations remain terminal even if the editor closes during delivery. */
export type PartialEditorReply =
    | {
          type: "partialFile";
          file: ChangeFileView;
          contentId: string;
          lists: ChangelistState;
          listId: string;
          selectedOperations?: boolean;
      }
    | { type: "partialOperationCompleted"; message: string; removed: boolean }
    | { type: "partialError"; message: string }
    | { type: "partialStaged" }
    | { type: "partialCommitted"; commit: string };
