import type { ChangelistState, ChangeFileView, SelectedFileChanges } from "./changeSelection";

/** New worktree commands always carry an exact host-issued repository root. */
export type ChangelistOutbound =
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
    | { type: "commitSelection"; selection: SelectedFileChanges; message: string; amend?: boolean }
    | {
          type: "selectedOperation";
          selection: SelectedFileChanges;
          operation: "export" | "save" | "shelve" | "rollback";
      }
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
          canShelf?: boolean;
          lastCommitMessage?: string;
          /** A refreshed snapshot can arrive before the host releases its action lease. */
          pending?: boolean;
      }
    | { type: "partialError"; message: string; reloadRequired?: boolean }
    | { type: "partialStaged" }
    | { type: "partialCanceled" }
    | { type: "partialReady" }
    | { type: "partialOperationCompleted"; operation: "export" | "save" | "shelve" | "rollback" }
    | { type: "partialCommitted"; commit: string };
