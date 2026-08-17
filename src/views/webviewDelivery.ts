import type * as vscode from "vscode";

import { getErrorMessage } from "../utils/errors";

/**
 * The shape every host-to-webview message shares: a discriminator the report can name. Widening it
 * to the individual protocol unions would tie the helper to four of them for no gain -- the only
 * field it reads is the one they all agree on.
 */
interface TypedWebviewMessage {
    readonly type: string;
}

function reportFailedPost(source: string, type: string, error: unknown): void {
    console.error(
        `[IntelliGit] ${source} failed to post a "${type}" message:`,
        getErrorMessage(error),
    );
}

/**
 * Sends a message to a webview and reports a send that does not land.
 *
 * VS Code answers `postMessage` three ways -- delivered, accepted-but-not-delivered (a resolved
 * `false`), and rejected -- and every view provider used to drop the returned promise, which
 * collapsed all three into "success". A view that never received its hydration then looks, from the
 * host's side, exactly like one that did; that is how a blank commit panel reaches CI carrying no
 * host-side evidence at all. Dropping the promise also turned a rejecting `postMessage` into an
 * unhandled rejection in the extension host.
 *
 * The report goes to `console.error` because that is the channel the E2E harness reads:
 * `tests/e2e/pageObjects/intelliGitView.ts` folds the host's console into its failure message, so a
 * message that never arrives names itself rather than only surfacing as an empty view.
 *
 * Nothing here retries, and nothing here throws -- including when `postMessage` fails synchronously
 * rather than by rejecting. A webview that refused one message is not made healthier by a second,
 * and callers post status updates from disposal and finally paths, where turning a lost message
 * into a thrown error would break an operation that had otherwise succeeded.
 *
 * @param webview - Destination webview. Callers hold the "is there a view at all" check, because a
 *   closed panel is an ordinary state rather than a fault worth logging.
 * @param message - The payload; its `type` is what the report names.
 * @param source - Human-readable name of the sending view, e.g. `"Commit panel"`. It is the only
 *   way a reader can tell which of the four providers dropped the message.
 */
export function postWebviewMessage(
    webview: Pick<vscode.Webview, "postMessage">,
    message: TypedWebviewMessage,
    source: string,
): void {
    let sent: Thenable<boolean>;
    try {
        sent = webview.postMessage(message);
    } catch (error: unknown) {
        reportFailedPost(source, message.type, error);
        return;
    }
    void Promise.resolve(sent).then(
        (delivered) => {
            if (delivered) return;
            console.error(
                `[IntelliGit] ${source} webview did not receive a "${message.type}" message.`,
            );
        },
        (error: unknown) => reportFailedPost(source, message.type, error),
    );
}
