import * as path from "path";
import * as vscode from "vscode";
import { computeDiffSegments } from "../diff/diffSegments";
import { logGitOpsWarning } from "../git/operationSupport";
import type { EditableDiffDescriptor } from "../diff/editableDiffTypes";
import type {
    DiffViewerData,
    InboundMessage,
    TextEditDelta,
} from "../webviews/protocol/diffViewerTypes";
import { buildWebviewShellHtml } from "./webviewHtml";

const EDITABLE_DIFF_VIEW_TYPE = "intelligit.editableDiff";

let registeredProvider: EditableDiffEditorProvider | undefined;

/** Registers the VS Code document-owned editor used by every working-tree diff. */
export function registerEditableDiffEditorProvider(
    context: vscode.ExtensionContext,
): vscode.Disposable {
    const provider = new EditableDiffEditorProvider(context.extensionUri);
    const registration = vscode.window.registerCustomEditorProvider(
        EDITABLE_DIFF_VIEW_TYPE,
        provider,
        {
            webviewOptions: {
                // Enables webview Ctrl+F; VS Code find only searches DOM text, so do not virtualize away rows.
                enableFindWidget: true,
                retainContextWhenHidden: true,
            },
        },
    );
    const disposable = {
        dispose: () => {
            if (registeredProvider === provider) registeredProvider = undefined;
            registration.dispose();
            provider.dispose();
        },
    };
    registeredProvider = provider;
    context.subscriptions.push(registration, disposable);
    return disposable;
}

/** Opens the custom editor for a real file URI after the diff funnel has checked both sides. */
export async function openEditableDiffEditor(
    fileUri: vscode.Uri,
    descriptor: EditableDiffDescriptor,
): Promise<void> {
    if (!registeredProvider) throw new Error("Editable diff editor has not been initialized.");
    await registeredProvider.open(fileUri, descriptor);
}

/** Replaces the immutable snapshot of an already-open editable document without touching its text. */
export async function refreshEditableDiffEditor(
    fileUri: vscode.Uri,
    descriptor: EditableDiffDescriptor,
): Promise<void> {
    await registeredProvider?.refresh(fileUri, descriptor);
}

/** Binds one VS Code text document to a two-pane webview whose other side is immutable. */
export class EditableDiffEditorProvider implements vscode.CustomTextEditorProvider {
    /**
     * One entry per open that has not resolved yet. The entry is a box rather than the
     * descriptor itself because `refresh()` replaces the descriptor while the open is still
     * in flight: an identity check against the descriptor would stop matching in exactly the
     * window `open()`'s cleanup exists for. The box identifies the OPEN, which is what the
     * cleanup is actually about.
     */
    private readonly pending = new Map<string, { descriptor: EditableDiffDescriptor }>();
    private readonly sessions = new Map<string, EditableDiffSession>();

    /** Creates the provider with the installation URI used by its webview shell. */
    constructor(private readonly extensionUri: vscode.Uri) {}

    /** Opens or updates the one VS Code-managed custom editor for a file. */
    async open(fileUri: vscode.Uri, descriptor: EditableDiffDescriptor): Promise<void> {
        const key = fileUri.toString();
        const session = this.sessions.get(key);
        if (session) {
            try {
                await session.update(descriptor);
                await vscode.commands.executeCommand(
                    "vscode.openWith",
                    fileUri,
                    EDITABLE_DIFF_VIEW_TYPE,
                    {
                        preview: false,
                    },
                );
            } catch (error) {
                // A live editor already holds this file; this block only re-renders it with the
                // new descriptor and reveals its tab. Letting either step escape would send the
                // caller to the native fallback and leave a second diff for the same file open
                // beside an editor that is already showing it. `update()` belongs inside the
                // guard for the same reason the reveal does: it posts to the webview, so a
                // panel disposed a tick before `onDidDispose` cleared the map throws here.
                logGitOpsWarning("editableDiffEditorProvider.reveal", error);
            }
            return;
        }
        const entry = { descriptor };
        this.pending.set(key, entry);
        try {
            await vscode.commands.executeCommand(
                "vscode.openWith",
                fileUri,
                EDITABLE_DIFF_VIEW_TYPE,
                { preview: false },
            );
        } catch (error) {
            // Only `resolveCustomTextEditor` clears this map, so an open that never resolves
            // would strand the descriptor and bind it to whatever reopened the file later.
            // Guarded on the entry so a LATER open's slot is not evicted by this one's
            // failure, and so a refresh that rewrote this entry's descriptor still clears.
            if (this.pending.get(key) === entry) this.pending.delete(key);
            throw error;
        }
    }

    /** Updates a resolved editor or its pending descriptor without reopening the document. */
    async refresh(fileUri: vscode.Uri, descriptor: EditableDiffDescriptor): Promise<void> {
        const key = fileUri.toString();
        const session = this.sessions.get(key);
        if (session) {
            await session.update(descriptor);
            return;
        }
        const entry = this.pending.get(key);
        if (entry) entry.descriptor = descriptor;
    }

    /** Attaches VS Code's resolved document to the pending immutable diff descriptor. */
    async resolveCustomTextEditor(
        document: vscode.TextDocument,
        webviewPanel: vscode.WebviewPanel,
        _token: vscode.CancellationToken,
    ): Promise<void> {
        const key = document.uri.toString();
        const entry = this.pending.get(key);
        if (!entry) {
            // The dispose has to happen even if the handoff fails. This branch never assigns
            // `webview.html`, so a rejected `vscode.open` — a window restore of a stale custom
            // editor whose file is gone — would otherwise strand a blank, permanent tab.
            try {
                await vscode.commands.executeCommand("vscode.open", document.uri, {
                    preview: false,
                });
            } finally {
                webviewPanel.dispose();
            }
            return;
        }

        const session = new EditableDiffSession(
            document,
            webviewPanel,
            this.extensionUri,
            entry.descriptor,
        );
        this.sessions.set(key, session);
        this.pending.delete(key);
        webviewPanel.onDidDispose(() => {
            if (this.sessions.get(key) === session) this.sessions.delete(key);
            session.dispose();
        });
        // Deliberately no render here. VS Code delivers nothing to a webview until this method
        // returns, so a publish awaited from inside it can never settle: the open hangs forever,
        // and the tab sits blank with its title already applied and no error raised anywhere.
        // The webview asks for its own first payload instead -- `DiffViewerApp` posts `ready`
        // once it mounts, and `handleMessage` renders in response.
    }

    /** Releases every document session when extension activation is disposed. */
    dispose(): void {
        this.pending.clear();
        for (const session of this.sessions.values()) session.dispose();
        this.sessions.clear();
    }
}

/** Keeps the webview as a pure projection of a VS Code-owned text document. */
class EditableDiffSession {
    private descriptor: EditableDiffDescriptor;
    private ignoreWhitespace = false;
    private disposed = false;
    private editQueue: Promise<void> = Promise.resolve();
    private autoSaveTimer: ReturnType<typeof setTimeout> | undefined;
    private renderScheduled = false;
    /**
     * Whether the last payload this session tried to publish failed to reach the webview.
     *
     * The drop branch in `applyEdit` refuses a superseded delta on the stated grounds that
     * every token this session mints does get published. Two places mint one — `reseed` and
     * the document-change handler — and a post that failed breaks the premise for both: the
     * webview keeps stamping the last token it saw, and every keystroke from then on is
     * dropped, silently and permanently, because the user's own typing is what would have
     * produced the next event.
     */
    private deliveryFailed = false;
    /**
     * Texts this session's own edits are expected to produce, oldest first. A change event
     * whose document text matches the head is our own echo coming back; anything else moved
     * the document out from under the webview and has to reseed it.
     *
     * A flag held across `applyEdit` cannot decide this. The change event is delivered by the
     * main thread and may land on either side of the RPC reply, so a time window both
     * misattributes a foreign write that lands inside it and misattributes our own echo when
     * it lands outside — and the second one silently rolls the user's draft back.
     */
    private readonly pendingEdits: string[] = [];
    private reseedToken = 0;
    /** The document revision this editor has already accounted for. */
    private lastSeenVersion: number;
    private readonly disposables: vscode.Disposable[];

    constructor(
        private readonly document: vscode.TextDocument,
        private readonly panel: vscode.WebviewPanel,
        extensionUri: vscode.Uri,
        descriptor: EditableDiffDescriptor,
    ) {
        this.descriptor = descriptor;
        this.lastSeenVersion = document.version;
        // `update()` already assigns this on every later descriptor, so without it here the
        // first open is the one render that never applies the descriptor's own title. Whether
        // a custom editor's tab honours it is VS Code's call; the two paths agreeing is ours.
        panel.title = descriptor.title;
        panel.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(extensionUri, "dist")],
        };
        panel.webview.html = buildWebviewShellHtml({
            extensionUri,
            webview: panel.webview,
            scriptFile: "webview-diffviewer.js",
            styleFiles: ["webview-diffviewer.css"],
            title:
                descriptor.title ||
                vscode.l10n.t("Diff: {file}", { file: path.posix.basename(descriptor.path) }),
            e2eViewId: "diff-viewer",
        });
        this.disposables = [
            panel.webview.onDidReceiveMessage((message: unknown) => {
                // `void` would turn any escaping rejection into an unhandled one in the
                // extension host, where it is attributed to no feature at all.
                void this.handleMessage(message).catch((error: unknown) => {
                    logGitOpsWarning("editableDiffEditorProvider.handleMessage", error);
                });
            }),
            vscode.workspace.onDidChangeTextDocument((event) => {
                if (event.document.uri.toString() !== document.uri.toString()) return;
                // This event fires for dirty-state flips too, which change nothing we render;
                // the queue head is already gone by then, so one would read as a foreign write
                // and reseed the pane, discarding every delta still in flight. The version is
                // the oracle rather than an empty `contentChanges`, because it is the
                // documented one — "strictly increase after each change" — and because an EOL
                // switch rewrites every terminator while reporting no content changes at all.
                if (document.version === this.lastSeenVersion) return;
                this.lastSeenVersion = document.version;
                if (this.pendingEdits[0] === document.getText()) {
                    this.pendingEdits.shift();
                } else {
                    // Someone else holds the document now, so every expectation we were still
                    // waiting on is unreachable and the webview's draft is stale.
                    this.pendingEdits.length = 0;
                    this.reseedToken++;
                }
                this.scheduleRender();
            }),
        ];
    }

    async update(descriptor: EditableDiffDescriptor): Promise<void> {
        this.descriptor = descriptor;
        this.panel.title = descriptor.title;
        await this.render();
    }

    async render(): Promise<void> {
        if (this.disposed) return;
        // Captured before the await. `render` has six call sites and nothing serializes them,
        // so two payloads can be outstanding at once, while `deliveryFailed` is a single
        // last-writer-wins boolean. Without this an older post resolving after a newer one
        // that was dropped would clear the newer one's failure, and the drop branch — the
        // only reader — would then find nothing to recover from and leave the pane rejecting
        // every keystroke for good.
        const token = this.reseedToken;
        try {
            // Built INSIDE the try, not before it. `reseed` mints the token before calling
            // here, and the whole protocol rests on "this session publishes every token it
            // mints" — so a payload that throws while being BUILT strands that mint exactly as
            // completely as one that fails to post. There are three ways a publish can fail,
            // not two: the post rejects, the post resolves `false`, or the payload never
            // exists. `buildData` runs `computeDiffSegments`, whose LCS pass allocates an
            // `Int32Array` of up to `MAX_LCS_CELLS` cells (~40MB) and does so once per gap; an
            // allocation failure there is a throw, and outside this block it would leave
            // `deliveryFailed` false, `reseed`'s re-arm unreached, and the webview stamping
            // every later keystroke with a token this session has already moved past —
            // accepted by the textarea, written nowhere, in silence and for good.
            const message: InboundMessage = { type: "setDiffData", data: this.buildData() };
            // The token guard below asks whether a reseed landed while this post was in
            // flight, so it is only answerable after the await; and `delivered` is what the
            // lines under it record. Neither can be reordered.
            // react-doctor-disable-next-line react-doctor/async-defer-await
            const delivered = await this.panel.webview.postMessage(message);
            // `postMessage` reports a DROPPED message by resolving `false`, not by rejecting.
            // Rejection is the disposed-panel case, where there is nothing left to recover;
            // `false` is the live-panel case, which is the one this flag exists for. Awaiting
            // and discarding the boolean would clear the flag on exactly the failure it
            // records — and clear it even when a previous attempt had already set it, so two
            // consecutive failed deliveries would leave this session believing it delivered.
            //
            // `=== false` rather than `!delivered` because the contract is a boolean and this
            // means "the host reported a drop", not "anything falsy". A value outside the
            // contract is not a reported drop, and latching the flag on one would put a
            // whole-file republish on the wire for every dropped delta from then on.
            if (token !== this.reseedToken) return;
            this.deliveryFailed = delivered === false;
            if (this.deliveryFailed) {
                // Reported here rather than at each call site, because this is the only place
                // that can observe it: a dropped payload RESOLVES, so no caller's `catch` will
                // ever run for it. Without this the pane silently stops matching the document
                // and the output channel never names the moment it stopped.
                logGitOpsWarning(
                    "editableDiffEditorProvider.render",
                    "The webview reported that a payload was not delivered.",
                );
            }
        } catch (error) {
            // Recorded rather than only thrown, because the caller that observes this
            // rejection is not the one that can recover from it. Every payload carries the
            // current reseed token, so one that never arrived leaves the webview stamping
            // deltas with a token this session has already moved past — see the drop branch
            // in `applyEdit`, which is where the flag is read.
            //
            // Deliberately NOT guarded by the supersession check above: the two directions do
            // not cost the same. A stale success clearing a live failure strands the pane
            // permanently and unrecoverably, which is why that one is guarded. A stale failure
            // sets a flag the live payload has already earned, and costs redundant republishes
            // that the next delivered render clears — bounded, but not by one: `scheduleRender`
            // coalesces only within a microtask, so for the length of a single post round-trip
            // each keystroke reaching the drop branch schedules a whole-file republish of its
            // own. Bounded and self-clearing still beats permanent and unrecoverable, so this
            // stays the simpler branch.
            this.deliveryFailed = true;
            throw error;
        }
    }

    private scheduleRender(): void {
        if (this.renderScheduled) return;
        this.renderScheduled = true;
        queueMicrotask(() => {
            this.renderScheduled = false;
            // `void` alone would make a failed post an unhandled rejection in the extension
            // host, attributed to no feature at all. This is the document-change path, so it
            // fires on every foreign write to a file the viewer is showing.
            void this.render().catch((error: unknown) => {
                logGitOpsWarning("editableDiffEditorProvider.scheduleRender", error);
            });
        });
    }

    dispose(): void {
        // Two owners call this: the panel's own `onDidDispose` and the provider's teardown
        // over every live session. Both fire when the window closes with an editor open, so
        // the second call would hand `onSessionDisposed` a second time -- harmless today only
        // because the diff service's `onPanelDisposed` happens to be idempotent, which is not
        // a property this side gets to assume.
        if (this.disposed) return;
        this.disposed = true;
        if (this.autoSaveTimer !== undefined) clearTimeout(this.autoSaveTimer);
        for (const disposable of this.disposables) disposable.dispose();
        this.descriptor.onSessionDisposed?.();
    }

    private buildData(): DiffViewerData {
        const editableText = this.document.getText();
        const { editablePane, immutableText } = this.descriptor;
        const leftText = editablePane === "left" ? editableText : immutableText;
        const rightText = editablePane === "right" ? editableText : immutableText;
        return {
            path: this.descriptor.path,
            leftLabel: this.descriptor.leftLabel,
            rightLabel: this.descriptor.rightLabel,
            languageId: this.descriptor.languageId,
            documentId: this.descriptor.documentId,
            ...computeDiffSegments(leftText, rightText, {
                ignoreWhitespace: this.ignoreWhitespace,
            }),
            editablePane,
            // The webview edits inside a `<textarea>`, whose API value has every CRLF and
            // lone CR normalized to LF. Sending the raw text would leave the webview
            // measuring its own edits against a string the host never holds, so from the
            // first `\r` onward every delta would carry offsets into the wrong space.
            editableText: toLfText(editableText),
            documentVersion: this.document.version,
            editableReseedToken: this.reseedToken,
            ignoreWhitespace: this.ignoreWhitespace,
            loadError: this.descriptor.loadError,
        };
    }

    private async handleMessage(raw: unknown): Promise<void> {
        const message = raw as { type?: unknown; mode?: unknown; delta?: unknown };
        if (message.type === "ready") {
            await this.render();
            return;
        }
        if (message.type === "setIgnoreMode") {
            if (message.mode !== "none" && message.mode !== "whitespace") return;
            this.ignoreWhitespace = message.mode === "whitespace";
            await this.render();
            return;
        }
        if (message.type === "editText" && isTextEditDelta(message.delta)) {
            const delta = message.delta;
            // The chain must never be left rejected: `.then` on a rejected promise skips its
            // callback for good, so one failure would drop every later keystroke while the
            // webview kept showing a draft the document never received.
            const link = this.editQueue.then(() =>
                this.applyEdit(delta).catch(async (error: unknown) => {
                    logGitOpsWarning("editableDiffEditorProvider.applyEdit", error);
                    await this.reseed();
                }),
            );
            // Two expressions because they have two different jobs. The STORED chain is
            // terminated so it can never be left rejected — that is the invariant above, and
            // it now holds locally instead of resting on facts outside this file. The local
            // `await` keeps the rejection, so nothing is swallowed that anyone could have
            // reported: the caller at `onDidReceiveMessage` catches and logs it.
            //
            // Guarding the handler's body instead was rejected. It defends exactly one trigger
            // (`logGitOpsWarning` throwing) while the invariant would still depend on
            // `getOutputChannel` caching a module-level singleton and on nothing ever disposing
            // it. Both are true today; neither is this class's to guarantee. Terminating the
            // link closes every way a handler can reject, including the ones not enumerated.
            this.editQueue = link.catch(() => {});
            await link;
        }
    }

    private async applyEdit(delta: TextEditDelta): Promise<void> {
        const text = this.document.getText();
        if (delta.baseReseedToken !== this.reseedToken) {
            // Measured against a draft this session has ALREADY declared void. The webview
            // stamps each delta with the token it has adopted so far, so every keystroke
            // typed while that reseed is still in flight arrives here by construction — this
            // is the normal case, not an anomaly. It is DROPPED rather than reseeded: a
            // reseed here would publish a token the webview has had no chance to see yet,
            // moving the target it is trying to reach, and one foreign write plus typing
            // faster than the payload round trip would then reject every keystroke for as
            // long as the user kept typing. Dropping is safe because this session publishes
            // every token it mints, so the payload that resolves this draft is already sent.
            // A string, not an `Error`: the comment above says this path is the normal case,
            // and `logGitOpsWarning` appends `err.stack` for anything that is an `Error` — so
            // constructing one here would put a full stack trace in the user's output channel
            // for every keystroke typed during a reseed, burying the failures worth reading.
            logGitOpsWarning(
                "editableDiffEditorProvider.staleDelta",
                "Dropped an edit measured against a superseded draft.",
            );
            // Republish the CURRENT token, and only when a payload actually failed to land.
            // This is the recovery for both minting sites: dropping is safe exactly as long
            // as the token that resolves this draft has been sent, and if it has not, nothing
            // else will send it — the keystrokes that would drive the next render are the
            // ones being dropped. Republishing cannot cascade the way a reseed here would,
            // because the token does not move: the webview's adopt effect keys on the token,
            // so a payload carrying one it has already adopted is a no-op for its draft.
            // Gated on the flag so the normal case — typing through a reseed that IS in
            // flight — still costs nothing.
            if (this.deliveryFailed) this.scheduleRender();
            return;
        }
        if (
            // Reached only at the current reseed, so the webview still believes this draft
            // is live and has to be told otherwise. The version alone could not carry that
            // judgement: the webview counts its optimistic edits in the document's own
            // numeric space, so a foreign write (+1 here) and a rejected delta (+1 there)
            // re-align the two counters over texts that differ — which is what the token
            // checked above, and why it is checked first.
            delta.baseVersion !== this.document.version ||
            delta.startOffset < 0 ||
            delta.endOffset < delta.startOffset ||
            delta.endOffset > toLfText(text).length
        ) {
            await this.reseed();
            return;
        }
        // The delta is measured in the LF space the textarea handed the webview; the
        // document may not be in that space, and an inserted `\n` would otherwise leave a
        // lone LF inside a CRLF file.
        const startOffset = documentOffsetForLfOffset(text, delta.startOffset);
        const endOffset = documentOffsetForLfOffset(text, delta.endOffset);
        const insertedText = delta.text.split("\n").join(this.documentEol());
        const edit = new vscode.WorkspaceEdit();
        edit.replace(
            this.document.uri,
            new vscode.Range(
                this.document.positionAt(startOffset),
                this.document.positionAt(endOffset),
            ),
            insertedText,
        );
        const expected = text.slice(0, startOffset) + insertedText + text.slice(endOffset);
        this.pendingEdits.push(expected);
        let applied: boolean;
        try {
            applied = await vscode.workspace.applyEdit(edit);
        } catch (error) {
            this.dropPendingEdit(expected);
            throw error;
        }
        if (!applied) {
            this.dropPendingEdit(expected);
            logGitOpsWarning(
                "editableDiffEditorProvider.applyEdit",
                new Error("VS Code rejected the document edit."),
            );
            await this.reseed();
            return;
        }
        this.scheduleAutoSave();
    }

    private scheduleAutoSave(): void {
        if (this.autoSaveTimer !== undefined) clearTimeout(this.autoSaveTimer);
        this.autoSaveTimer = setTimeout(() => {
            this.autoSaveTimer = undefined;
            void this.saveIfDirty();
        }, 2000);
    }

    private async saveIfDirty(): Promise<void> {
        if (this.disposed || !this.document.isDirty) return;
        try {
            // `save` reports a refused save by RESOLVING false — a read-only file, a full disk, a
            // folder that vanished — and rejects only for an exceptional fault, so the ordinary
            // failure surface never reaches the `catch`. Nothing retries afterwards: the timer has
            // already cleared itself and the next arm needs another landed edit, so an unread
            // `false` leaves the user believing an edit is on disk that is not.
            if (!(await this.document.save())) {
                throw new Error("VS Code reported the document save as failed.");
            }
        } catch (error) {
            logGitOpsWarning("editableDiffEditorProvider.autoSave", error);
        }
    }

    /** Forgets an expectation whose edit never landed, so it cannot swallow a later echo. */
    private dropPendingEdit(expected: string): void {
        const index = this.pendingEdits.lastIndexOf(expected);
        if (index >= 0) this.pendingEdits.splice(index, 1);
    }

    /** The document's own line terminator, so an inserted newline cannot mix EOL styles. */
    private documentEol(): string {
        return this.document.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n";
    }

    /** Re-renders and tells the webview to discard its local draft. */
    private async reseed(): Promise<void> {
        this.reseedToken++;
        try {
            await this.render();
        } catch (error) {
            // Handled here rather than rethrown, because no caller has a better answer than
            // "try again" and this is the only place that can.
            logGitOpsWarning("editableDiffEditorProvider.reseed", error);
        }
        // Tested rather than done inside the `catch`, because a throw is not the only way the
        // payload fails to arrive: the host reports a dropped message by RESOLVING `false`,
        // which returns here perfectly normally and would leave this re-arm unreached. The
        // flag is what `render` records both shapes in, precisely so this decision does not
        // have to read control flow to learn which one happened.
        //
        // The re-arm matters because the token is already minted, and `applyEdit` drops a
        // superseded delta instead of reseeding it on the grounds that "this session publishes
        // every token it mints" — a payload that never landed breaks that: the webview would
        // keep stamping deltas with the token it last saw and the host would drop every one of
        // them, in silence and forever. `scheduleRender` does its own catching and returns
        // immediately once disposed, so this cannot spin.
        if (this.deliveryFailed) this.scheduleRender();
    }
}

/** The `<textarea>` API value's own normalization, applied host-side so both ends agree. */
function toLfText(raw: string): string {
    return raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/**
 * Maps an offset in the LF-normalized text back onto the document's own offsets. Every
 * `\r\n` and lone `\r` in the document collapsed to one character on the way out, so the
 * two spaces drift apart by one per line terminator consumed.
 */
function documentOffsetForLfOffset(raw: string, lfOffset: number): number {
    let index = 0;
    for (let seen = 0; seen < lfOffset && index < raw.length; seen++) {
        index += raw[index] === "\r" && raw[index + 1] === "\n" ? 2 : 1;
    }
    return index;
}

function isTextEditDelta(value: unknown): value is TextEditDelta {
    return (
        typeof value === "object" &&
        value !== null &&
        // `Number.isInteger`, not `typeof === "number"`: NaN is a number, and every range check
        // downstream compares against it, so `NaN < 0`, `NaN < start` and `NaN > length` are all
        // false. A NaN offset would clear validation and then land the replacement at offset 0.
        "startOffset" in value &&
        Number.isInteger(value.startOffset) &&
        "baseVersion" in value &&
        Number.isInteger(value.baseVersion) &&
        "baseReseedToken" in value &&
        Number.isInteger(value.baseReseedToken) &&
        "endOffset" in value &&
        Number.isInteger(value.endOffset) &&
        "text" in value &&
        typeof value.text === "string"
    );
}
