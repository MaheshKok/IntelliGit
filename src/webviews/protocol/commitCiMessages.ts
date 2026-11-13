// Checks tab messages shared by every webview that renders the commit details pane
// (the Git Log panel, the standalone Changed Files view and the undocked window).

import type { CiAction, CommitCiDetail } from "../../types";

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
 * Host's reply to {@link PreviewCiLogMessage}: the sanitised excerpt around the first error
 * line, never the log. `running` = the job has not finished, so there is no log yet;
 * `forbidden` = the credential cannot read the log.
 */
export interface CiLogPreviewMessage {
    type: "ciLogPreview";
    requestId: number;
    repoKey: string;
    hash: string;
    runId: string;
    jobId: string;
    selectionToken: number;
    outcome: "ready" | "running" | "forbidden" | "failed";
    excerpt?: string;
    /** The log was cut at 50 MB; the rest is only in the browser. */
    truncated?: boolean;
    /** Why a `failed` preview failed. */
    message?: string;
}

/** Host's reply to {@link OpenCiLogMessage}; a cancelled open gets none. */
export interface CiLogResultMessage {
    type: "ciLogResult";
    requestId: number;
    repoKey: string;
    hash: string;
    outcome: "opened" | "running" | "forbidden" | "failed";
    /** Why a `failed` open failed. */
    message?: string;
}

/**
 * Host's reply to {@link RunCiActionMessage}. `uncertain` = the request may have reached the
 * provider; `forbidden` = the credential may not write, explained by the provider's
 * `writeScopeHelp` with a link to `helpUrl`.
 */
export interface CiActionResultMessage {
    type: "ciActionResult";
    requestId: number;
    repoKey: string;
    hash: string;
    outcome: "ok" | "uncertain" | "forbidden" | "failed";
    /** Why a `failed` action failed. */
    message?: string;
    /** The docs page on tokens that can re-run or cancel; absent when it cannot be named. */
    helpUrl?: string;
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
      }
    | {
          /** Checks tab asks for the excerpt of a selected failed job's log; opens no editor. */
          type: "previewCiLog";
          /** Monotonic per webview; only the reply to the newest one renders. */
          requestId: number;
          repoKey: string;
          hash: string;
          runId: string;
          jobId: string;
          attempt?: number;
          /** New on every job selection; a reply for an earlier selection is dropped. */
          selectionToken: number;
      }
    | {
          /** Checks tab asks its host to open a job's full log in a read-only editor. */
          type: "openCiLog";
          requestId: number;
          repoKey: string;
          hash: string;
          runId: string;
          jobId: string;
          attempt?: number;
      }
    | {
          /** Checks tab asks its host to re-run failed jobs, re-run one job or cancel a run. */
          type: "runCiAction";
          requestId: number;
          repoKey: string;
          hash: string;
          action: CiAction;
          runId: string;
          /** Set for `rerunJob` only. */
          jobId?: string;
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
/** Checks tab asks for a failed job's log excerpt. */
export type PreviewCiLogMessage = Extract<CommitCiOutbound, { type: "previewCiLog" }>;
/** Checks tab asks to open a job's full log in an editor. */
export type OpenCiLogMessage = Extract<CommitCiOutbound, { type: "openCiLog" }>;
/** Checks tab asks to run a CI write action. */
export type RunCiActionMessage = Extract<CommitCiOutbound, { type: "runCiAction" }>;
