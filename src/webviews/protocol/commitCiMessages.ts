// Checks tab messages shared by every webview that renders the commit details pane
// (the Git Log panel, the standalone Changed Files view and the undocked window).

import type { CommitCiDetail } from "../../types";

/** Host's reply to {@link RequestCommitCiDetailMessage}. */
export interface CommitCiDetailMessage {
    type: "commitCiDetail";
    requestId: number;
    repoKey: string;
    hash: string;
    /** `null` when no enabled CI provider serves this repository. */
    detail: CommitCiDetail | null;
}

/** Host tells the Checks tab its shown detail is stale (sign-in or sign-out): drop it and ask again. */
export interface CommitCiDetailInvalidatedMessage {
    type: "commitCiDetailInvalidated";
}

/** Host asks the webview to show the Checks tab for a commit. */
export interface OpenChecksTabMessage {
    type: "openChecksTab";
    repoKey: string;
    hash: string;
}

/**
 * Checks tab messages a webview sends to its host. Declared inline so the E2E coverage
 * manifest test, which reads outbound unions from source, sees every discriminant.
 */
type CommitCiOutbound =
    | {
          /** Webview asks its host for the CI detail of one commit. */
          type: "requestCommitCiDetail";
          /** Monotonic per webview; the reply echoes it and only the newest one renders. */
          requestId: number;
          /** Repository the webview shows; the host drops a request for another one. */
          repoKey: string;
          hash: string;
          /** Bypasses the host caches (the Refresh button). */
          force?: boolean;
      }
    | {
          /** The Checks tab was hidden: the host stops re-posting scan progress for this request. */
          type: "cancelCommitCiDetail";
          requestId: number;
      }
    | {
          /** Webview asks its host to open the commit-checks settings. */
          type: "openCommitChecksSettings";
      }
    | {
          /** Sidebar graph asks its host to show a commit in the Changed Files view's Checks tab. */
          type: "openCommitInChecks";
          hash: string;
      };

/** Checks tab asks its host for a commit's CI detail. */
export type RequestCommitCiDetailMessage = Extract<
    CommitCiOutbound,
    { type: "requestCommitCiDetail" }
>;
/** Checks tab tells its host it no longer shows a request's answer. */
export type CancelCommitCiDetailMessage = Extract<
    CommitCiOutbound,
    { type: "cancelCommitCiDetail" }
>;
/** Checks tab asks its host to open the commit-checks settings. */
export type OpenCommitChecksSettingsMessage = Extract<
    CommitCiOutbound,
    { type: "openCommitChecksSettings" }
>;
/** Sidebar graph asks its host to show a commit in the Checks tab. */
export type OpenCommitInChecksMessage = Extract<CommitCiOutbound, { type: "openCommitInChecks" }>;
