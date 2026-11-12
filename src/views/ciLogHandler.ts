// Host side of the Checks tab log messages, shared by every webview host that renders the
// commit details pane. Only the sanitised excerpt crosses to the webview; the full log opens in
// a read-only editor served from the window's log store.

import * as vscode from "vscode";
import { isE2eControlChannelActive } from "../e2e/activationState";
import type { CiOperationContext } from "../services/commitChecks/ciGenerations";
import { ciLogUri } from "../services/commitChecks/ciLogDocument";
import { HttpError } from "../services/commitChecks/http";
import { isValidGitHash } from "../services/gitHelpers";
import { getErrorMessage } from "../utils/errors";
import type {
    CiLogPreviewMessage,
    CiLogResultMessage,
} from "../webviews/protocol/commitCiMessages";
import type { CommitCiDetailSource } from "./ciDetailHandler";

/** What every log reply carries besides its own fields. */
type Failure = { outcome: "running" | "forbidden" } | { outcome: "failed"; message: string };

/**
 * Validates a `previewCiLog` or `openCiLog` message and answers it. The job must still be in
 * the commit's detail at the attempt the webview showed; an unfinished job is answered
 * `running` with no request. A preview fills the store and replies with the excerpt only; an
 * open loads (a hit after the preview) under a cancellable progress notification and opens the
 * log at its first error line. A reply is dropped when the repository, sign-in or CI settings
 * changed meanwhile; a cancelled or aborted load replies nothing.
 *
 * @param source - The host's repository, detail fetch and log access.
 * @param msg - Untrusted webview message.
 * @param post - Delivers the reply to the webview that asked.
 * @throws When a field of the message is malformed.
 */
export async function answerCiLogMessage(
    source: CommitCiDetailSource,
    msg: Record<string, unknown>,
    post: (reply: CiLogPreviewMessage | CiLogResultMessage) => void,
): Promise<void> {
    const request = parseLogMessage(msg);
    const { requestId, repoKey, hash, runId, jobId, attempt } = request;
    if (!isE2eControlChannelActive()) return;
    const logs = source.logs;
    if (!logs || repoKey !== source.repoKey()) return;
    const ctx: CiOperationContext = source.generations?.capture(repoKey) ?? {
        repoKey,
        authGeneration: 0,
        lifecycleGeneration: 0,
    };
    const isCurrent = (): boolean => {
        const currentRepoKey = source.repoKey();
        return source.generations
            ? source.generations.isCurrent(ctx, currentRepoKey)
            : repoKey === currentRepoKey;
    };
    const reply = (
        answer:
            | Failure
            | { outcome: "ready"; excerpt: string; truncated: boolean }
            | { outcome: "opened" },
    ): void => {
        if (!isCurrent()) return;
        if (request.selectionToken === undefined) {
            post({
                type: "ciLogResult",
                requestId,
                repoKey,
                hash,
                ...answer,
            } as CiLogResultMessage);
            return;
        }
        post({
            type: "ciLogPreview",
            requestId,
            repoKey,
            hash,
            runId,
            jobId,
            selectionToken: request.selectionToken,
            ...answer,
        } as CiLogPreviewMessage);
    };

    const detail = await source.getDetail(hash, { force: false }, ctx);
    if (!isCurrent()) return;
    const run = detail?.runs.find((candidate) => candidate.id === runId);
    const job = run?.jobs.find((candidate) => candidate.id === jobId);
    if (!run || !job || (job.attempt ?? run.attempt) !== attempt) {
        reply({
            outcome: "failed",
            message: vscode.l10n.t("Remote data changed. Reload and try again."),
        });
        return;
    }
    if (job.state === "queued" || job.state === "running") {
        reply({ outcome: "running" });
        return;
    }
    const failedStep = job.steps.find((step) => step.state === "failure")?.name;
    const target = await logs.target(hash, { runId, jobId, attempt, failedStep }, ctx);
    if (!isCurrent()) return;
    if (!target) {
        reply({
            outcome: "failed",
            message: vscode.l10n.t("This provider cannot show CI logs."),
        });
        return;
    }

    if (request.selectionToken !== undefined) {
        try {
            const preview = await logs.store.preview(target.key, target.source);
            reply({ outcome: "ready", excerpt: preview.excerpt, truncated: preview.truncated });
        } catch (error) {
            if (!isAbort(error)) reply(failureOf(error));
        }
        return;
    }

    let entry;
    try {
        entry = await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: vscode.l10n.t("Loading the log of {0}…", job.name),
                cancellable: true,
            },
            async (_progress, token) => {
                // Cancelling stops this waiter only; a download others share goes on.
                const controller = new AbortController();
                const cancelled = token.onCancellationRequested(() => controller.abort());
                // A token cancelled before this callback ran fires no event.
                if (token.isCancellationRequested) controller.abort();
                try {
                    return await logs.store.load(target.key, target.source, controller.signal);
                } finally {
                    cancelled.dispose();
                }
            },
        );
    } catch (error) {
        if (!isAbort(error)) reply(failureOf(error));
        return;
    }
    if (!isCurrent()) return;
    const shown = await showLog(
        ciLogUri(job.name, target.key),
        entry.firstErrorLine,
        isCurrent,
    ).catch((error: unknown) => {
        reply(failureOf(error));
        return false;
    });
    if (shown) reply({ outcome: "opened" });
}

/** Opens the stored log at `line`; false when the context went stale before it was shown. */
async function showLog(uri: vscode.Uri, line: number, isCurrent: () => boolean): Promise<boolean> {
    const document = await vscode.workspace.openTextDocument(uri);
    if (!isCurrent()) return false;
    await vscode.window.showTextDocument(document, {
        preview: false,
        selection: new vscode.Range(line, 0, line, 0),
    });
    return true;
}

interface LogRequest {
    requestId: number;
    repoKey: string;
    hash: string;
    runId: string;
    jobId: string;
    attempt: number | undefined;
    /** Present only on a preview. */
    selectionToken: number | undefined;
}

function parseLogMessage(msg: Record<string, unknown>): LogRequest {
    const { type, requestId, repoKey, hash, runId, jobId, attempt, selectionToken } = msg;
    if (!isSafeInteger(requestId)) throw new Error("Invalid CI log request id.");
    if (typeof repoKey !== "string") throw new Error("Invalid CI log repository.");
    if (typeof hash !== "string" || !isValidGitHash(hash)) throw new Error("Invalid CI log hash.");
    if (!isId(runId) || !isId(jobId)) throw new Error("Invalid CI log job.");
    if (attempt !== undefined && !isSafeInteger(attempt)) {
        throw new Error("Invalid CI log attempt.");
    }
    if (type === "previewCiLog" && !isSafeInteger(selectionToken)) {
        throw new Error("Invalid CI log selection token.");
    }
    return {
        requestId,
        repoKey,
        hash,
        runId,
        jobId,
        attempt,
        selectionToken: type === "previewCiLog" ? (selectionToken as number) : undefined,
    };
}

function isSafeInteger(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value);
}

function isId(value: unknown): value is string {
    return typeof value === "string" && value.length > 0 && value.length <= 200;
}

function isAbort(error: unknown): boolean {
    return error instanceof Error && error.name === "AbortError";
}

/**
 * A refused credential is `forbidden`. A rate limit is a 403 too: a primary one has no
 * requests left, a secondary one carries `Retry-After`. A request a redirect stripped of the
 * credential (a signed log link on another host) never carried it, so its refusal means the link
 * expired. Signing in again cannot help in these cases, so they are failures with their message.
 */
function failureOf(error: unknown): Failure {
    if (error instanceof HttpError && (error.statusCode === 401 || error.statusCode === 403)) {
        const remaining = error.headers["x-ratelimit-remaining"];
        const rateLimited =
            (Array.isArray(remaining) ? remaining[0] : remaining) === "0" ||
            error.headers["retry-after"] !== undefined;
        if (!rateLimited && sawCredential(error)) return { outcome: "forbidden" };
    }
    return { outcome: "failed", message: getErrorMessage(error) };
}

/**
 * Whether the refused request carried the credential: an API request answered where it was sent,
 * or a download whose answering request still had it. A download that does not say is not
 * blamed on the token.
 */
function sawCredential(error: HttpError): boolean {
    return error.url === undefined || error.credentialSent === true;
}
