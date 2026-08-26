// Captures extension -> webview `postMessage` traffic for the visual-harness drift guard and,
// eventually, Phase 2b's protocol recorder. See PLAN.md Phase 3 step 15 (the 9 resolved host
// contexts table) and step 16 (the exact set-equality drift guard). Capture happens by wrapping
// the *webview object* at the boundary where each host hands its webview to the code that
// renders into it -- never by editing an emitter's body (`postToWebview`, `resolveWebviewView`),
// which this module never touches and never needs to. Gated by the same three-gate predicate as
// the rest of the E2E control channel (`isE2eControlChannelActive`, see
// `src/e2e/activationState.ts`): when the gate is off, every host receives its original webview
// object back, unchanged and identity-equal, and nothing is allocated.

import type * as vscode from "vscode";
import { isE2eControlChannelActive } from "./activationState";

/**
 * The 9 resolved host contexts a bundled webview can be rendered into, exactly as enumerated in
 * PLAN.md Phase 3 step 15's table. Keyed by "resolved host context" rather than by bundle or by
 * call site because neither is 1:1 with a rendered shell: two contexts share the
 * `webview-mergeeditor.js` bundle (`merge-editor`, `shelf-conflict-editor`), and one call site
 * (`CommitGraphViewProvider`) is constructed twice into two different contexts
 * (`commit-graph-card`, `commit-graph-compact`).
 */
export const WEBVIEW_CONTEXT_IDS = [
    "commit-graph-card",
    "commit-graph-compact",
    "commit-panel",
    "commit-info",
    "undocked",
    "merge-editor",
    "shelf-conflict-editor",
    "merge-conflict-session",
    "diff-viewer",
] as const;

/** One of the 9 resolved host contexts. Assigning an unlisted string is a compile error. */
export type WebviewContextId = (typeof WEBVIEW_CONTEXT_IDS)[number];

/** One captured extension -\> webview message, tagged with the host context that sent it. */
export interface CapturedWebviewMessage {
    readonly contextId: WebviewContextId;
    readonly message: unknown;
}

/**
 * In-memory, append-only record of every `postMessage` a captured webview has sent, in call
 * order. Phase 2b will persist this to disk; this slice keeps it in memory only, and never logs
 * payload contents on its own -- a captured message can carry real repository data.
 */
export class WebviewCaptureSink {
    private readonly messages: CapturedWebviewMessage[] = [];

    /** Appends one captured message. Called synchronously from the wrapped `postMessage`. */
    record(contextId: WebviewContextId, message: unknown): void {
        this.messages.push({ contextId, message });
    }

    /** Returns every message captured so far, oldest first. */
    getMessages(): readonly CapturedWebviewMessage[] {
        return this.messages;
    }
}

/**
 * The handshake message types traced by {@link traceHandshake}, one per direction.
 *
 * Deliberately two names rather than every message: the flow suite's timeout dump prints a bounded
 * trail of the newest console lines, so a line per message would evict the handshake it exists to
 * show.
 */
const HANDSHAKE_TRACED_TYPES = new Set(["ready", "setRepositories"]);

/** Prefix every traced line carries, so the dump's reader can tell host lines from webview ones. */
const HANDSHAKE_TRACE_PREFIX = "[intelligit-e2e] handshake";

/**
 * Whether `message` is a document announcing itself for the first time.
 *
 * The webview's retry numbers its asks from 1 per DOCUMENT
 * (`src/webviews/react/commit-panel/hooks/useExtensionMessages.ts`), so a second `attempt: 1`
 * behind one wrapper is a document that was rebuilt, not a view that was re-resolved.
 *
 * Only a literal `1` counts. `isHydrationReAsk` reads unknown input the other way round because
 * its failure costs a redundant Git read; here the cost is inverted -- a missing or malformed
 * `attempt` reported as a fresh document would convict a reload that never happened, and this
 * field exists to convict. Undercounting leaves the next dump as mute as the last, which is
 * recoverable; a phantom generation sends the next investigation somewhere real evidence does not.
 */
function isOpeningAsk(message: unknown): boolean {
    if (typeof message !== "object" || message === null) return false;
    const { type, attempt } = message as { type?: unknown; attempt?: unknown };
    return type === "ready" && attempt === 1;
}

/**
 * Numbers each wrapped webview so the two legs of one handshake can be attributed to the same
 * boundary object -- or proven to belong to different ones.
 *
 * A boundary, not a document: `wrapWebviewForCapture` runs once per `resolveWebviewView`, so two
 * numbers mean VS Code built two `WebviewView`s, while one number across a reload means the
 * document was rebuilt behind a single view. That is exactly the distinction the trace could not
 * make before, and the reason it is a wrap-time counter rather than anything derived from the
 * message or the document.
 */
let webviewWrapperCount = 0;

/** Test-only: restarts wrapper numbering so one test's ids cannot leak into another's assertions. */
export function resetWebviewWrapperNumberingForTests(): void {
    webviewWrapperCount = 0;
}

/**
 * Records one leg of the hydration handshake where the E2E flow suite can read it.
 *
 * The webview's own counters (`src/webviews/react/shared/hydrationDiagnostics.ts`) can only ever
 * prove that the WEBVIEW asked: a host that never received the ask and a host that received it and
 * answered into a view nobody is looking at both leave `received:0` behind, and the blank-panel
 * failure this exists for has so far produced byte-identical dumps under both. The host's own count
 * is the half that separates them, and extension-host `console.error` is the one channel that
 * reaches Playwright's page console -- which is exactly where `IntelliGitView` reads its trail from.
 *
 * That host half has now been read once, and it moved the question rather than answering it: the
 * 2026-08-23 Insiders failure traced `in ready` and `out setRepositories` repeatedly beside a panel
 * still reporting `asks:18 received:0`, with no delivery failure logged by `postWebviewMessage`. So
 * the host receives the ask and calls `postMessage`, and the answer still does not arrive. What
 * remains is whether it was posted to the SAME webview that asked -- and `contextId` alone cannot
 * say, because both legs of both views print `commit-panel`. `instance` is that missing field:
 * differing numbers across a matched in/out pair convict the record-versus-sender split in
 * `CommitPanelViewProvider.postToWebview`.
 *
 * Identical numbers acquit that split -- and they used to be read as leaving "VS Code dropped a
 * post it acknowledged" as the sole survivor. They never did. `instance` counts WRAPS, one per
 * `resolveWebviewView`, and VS Code rebuilds a hidden view's document without re-running it; the
 * numbering comment above says exactly this, and the conclusion drawn from it did not. So a host
 * answering a document generation that no longer exists printed byte-identically to a host
 * answering the live one, and the 2026-08-25 runs (PR #232, 32881969364 and 32883412896) could not
 * separate them. `generation` is the field that does: it advances on each `attempt: 1` behind one
 * wrapper (see {@link isOpeningAsk}), so `#1.1 out` beside `#1.2 in` is an answer posted into a
 * dead document, and a matched pair convicts VS Code's own delivery instead.
 *
 * Message TYPE only, never a payload: a captured message can carry real repository data, and this
 * line ends up in a CI artifact. Both numbers are in-process counters and name nothing about the
 * workspace, so they are safe to print under the same rule.
 */
function traceHandshake(
    contextId: WebviewContextId,
    instance: number,
    generation: number,
    direction: "in" | "out",
    message: unknown,
): void {
    const type: unknown =
        typeof message === "object" && message !== null
            ? (message as { type?: unknown }).type
            : undefined;
    if (typeof type !== "string" || !HANDSHAKE_TRACED_TYPES.has(type)) return;
    console.error(
        `${HANDSHAKE_TRACE_PREFIX} ${contextId}#${instance}.${generation} ${direction} ${type}`,
    );
}

/**
 * Process-wide capture sink, allocated lazily and only along the gate-active path (see
 * {@link captureWebview}). A production install where the E2E gate never activates must never
 * hold one of these -- there is no other allocation site.
 */
let globalSink: WebviewCaptureSink | undefined;

/**
 * Returns the process-wide capture sink if one has been allocated, or `undefined` if capture has
 * never run. Never allocates itself: this is a pure read so callers can prove nothing was
 * recorded without accidentally causing an allocation by asking.
 */
export function getE2eWebviewCaptureSink(): WebviewCaptureSink | undefined {
    return globalSink;
}

/** Test-only: clears the process-wide sink so tests do not leak captured state into each other. */
export function resetE2eWebviewCaptureSinkForTests(): void {
    globalSink = undefined;
}

function ensureGlobalSink(): WebviewCaptureSink {
    globalSink ??= new WebviewCaptureSink();
    return globalSink;
}

/**
 * Wraps a `vscode.Webview` so every `postMessage` call is recorded into `sink`, tagged with
 * `contextId`, before being delivered unchanged to the real webview. Delivery and the returned
 * `Thenable<boolean>` are never altered: the real webview's own promise is returned as-is (not
 * re-wrapped in a `.then()`), so a rejected or `false`-resolving call still behaves and compares
 * identically for the caller. Unconditional -- callers gate on
 * {@link isE2eControlChannelActive} themselves (see {@link captureWebview}), so this function
 * always wraps when called.
 */
export function wrapWebviewForCapture(
    webview: vscode.Webview,
    contextId: WebviewContextId,
    sink: WebviewCaptureSink,
): vscode.Webview {
    // Allocated per wrap rather than per message, so every line this wrapper ever emits carries the
    // same number and a pair that disagrees is a genuinely different boundary object.
    const instance = ++webviewWrapperCount;
    // How many documents have announced themselves behind this one wrapper. Read through
    // `documentGeneration` rather than directly: a post traced before any `ready` belongs to the
    // first document, not to a zeroth one that never existed.
    let announcedDocuments = 0;
    const documentGeneration = (): number => Math.max(announcedDocuments, 1);
    return {
        get options() {
            return webview.options;
        },
        set options(value: vscode.WebviewOptions) {
            webview.options = value;
        },
        get html() {
            return webview.html;
        },
        set html(value: string) {
            webview.html = value;
        },
        get cspSource() {
            return webview.cspSource;
        },
        // Wrapped rather than merely bound, so the INBOUND leg is observable too. The listener is
        // invoked unchanged and its return value passed straight back: this must stay a tap on the
        // wire, never a filter on it.
        onDidReceiveMessage: (
            listener: (message: unknown) => unknown,
            thisArgs?: unknown,
            disposables?: vscode.Disposable[],
        ): vscode.Disposable =>
            webview.onDidReceiveMessage(
                (message: unknown) => {
                    // Counted before the line is emitted, so the reload's own `ready` prints under
                    // the generation it opens rather than under the one it replaced.
                    if (isOpeningAsk(message)) announcedDocuments += 1;
                    traceHandshake(contextId, instance, documentGeneration(), "in", message);
                    return listener.call(thisArgs, message);
                },
                undefined,
                disposables,
            ),
        asWebviewUri: (localResource: vscode.Uri) => webview.asWebviewUri(localResource),
        postMessage: (message: unknown): Thenable<boolean> => {
            sink.record(contextId, message);
            traceHandshake(contextId, instance, documentGeneration(), "out", message);
            return webview.postMessage(message);
        },
    };
}

/**
 * Wraps any boundary object exposing a `webview` field (`vscode.WebviewView` or
 * `vscode.WebviewPanel`) so that field alone is replaced by the captured webview from
 * {@link wrapWebviewForCapture}; every other property and method -- `title`, `reveal()`,
 * `onDidDispose`, `show()`, `dispose()`, and anything else either interface carries -- is
 * forwarded to the real object, bound to it so implementations that close over internal state
 * still see a correct `this`. This is the boundary-wrapping primitive the provider decorator and
 * the panel-creation call sites both build on: neither `resolveWebviewView` nor a panel class's
 * own methods are edited, because neither ever sees anything but the object this function hands
 * them.
 */
/**
 * Builds a proxy that is indistinguishable from `target` except for the members named in
 * `substitutions`. Everything else is forwarded, with functions bound to the real object so
 * implementations that close over internal state still see a correct `this`.
 *
 * Both capture boundaries need exactly this, and both need it to be TOTAL: a wrapper that
 * implements only the member it wanted to intercept is transparent while the E2E gate is off
 * and lossy the moment it is on, which turns every other member into a `TypeError` in precisely
 * the mode this module exists to serve. Own-property lookup (rather than `in`) is deliberate --
 * `in` reaches `Object.prototype`, so a plain object literal would claim to substitute
 * `toString`, `constructor`, and friends, and those would stop being forwarded.
 */
function forwardingProxy<T extends object>(
    target: T,
    substitutions: Readonly<Record<string, unknown>>,
): T {
    return new Proxy(target, {
        get(obj, prop, _receiver) {
            if (
                typeof prop === "string" &&
                Object.prototype.hasOwnProperty.call(substitutions, prop)
            ) {
                return substitutions[prop];
            }
            const value: unknown = Reflect.get(obj, prop, obj);
            if (typeof value === "function") {
                const bound: unknown = value.bind(obj);
                return bound;
            }
            return value;
        },
        set(obj, prop, value) {
            return Reflect.set(obj, prop, value, obj);
        },
    });
}

function withCapturedWebview<T extends { readonly webview: vscode.Webview }>(
    target: T,
    contextId: WebviewContextId,
    sink: WebviewCaptureSink,
): T {
    return forwardingProxy(target, {
        webview: wrapWebviewForCapture(target.webview, contextId, sink),
    });
}

/**
 * Applies E2E capture to any `webview`-bearing boundary object -- a `vscode.WebviewPanel`
 * returned by `createWebviewPanel`, or a `vscode.WebviewView` handed to `resolveWebviewView` --
 * gated on the same three-gate predicate as the rest of the control channel. When the gate is
 * off this returns `target` itself, identity-equal, and allocates no sink: production installs
 * never pay for capture they never asked for. Pass an explicit `sink` in tests; production call
 * sites omit it and share the lazily-allocated process-wide sink.
 */
export function captureWebview<T extends { readonly webview: vscode.Webview }>(
    target: T,
    contextId: WebviewContextId,
    sink?: WebviewCaptureSink,
): T {
    if (!isE2eControlChannelActive()) {
        return target;
    }
    return withCapturedWebview(target, contextId, sink ?? ensureGlobalSink());
}

/**
 * Production entry point for wiring a `vscode.WebviewViewProvider` for E2E capture --
 * `registerWebviewViewProvider(...)` and `SwitchableWebviewViewProvider.setProvider(...)` both
 * take whatever this returns directly. It substitutes the ARGUMENT `resolveWebviewView`
 * receives, never the provider's own body, which this module does not touch: the same shape of
 * indirection `SwitchableWebviewViewProvider` (`src/activation/common.ts`) already uses to
 * substitute which provider receives a view.
 *
 * Gate off: returns `provider` itself, identity-equal, allocating nothing, so VS Code registers
 * the real instance. Gate on: returns a TOTAL forwarding proxy (see {@link forwardingProxy})
 * that intercepts `resolveWebviewView` alone and forwards every other member -- `dispose()`,
 * `viewType`, and anything else the concrete provider carries beyond the `WebviewViewProvider`
 * interface -- to the real provider. Totality is load-bearing rather than tidy: this
 * repository's `view-providers.integration.test.ts` calls `dispose()` on the registered
 * provider, so a decorator implementing `resolveWebviewView` alone would behave correctly with
 * the gate off and throw `TypeError: dispose is not a function` with it on, breaking exactly the
 * E2E runs this capture boundary is built for. The return type stays `T` for the same reason --
 * widening it to `vscode.WebviewViewProvider` would hide such a call from the type checker.
 *
 * The proxy allocates no sink of its own; the sink is allocated lazily, only once a webview is
 * actually resolved (see {@link captureWebview}).
 */
export function captureWebviewViewProvider<T extends vscode.WebviewViewProvider>(
    provider: T,
    contextId: WebviewContextId,
): T {
    if (!isE2eControlChannelActive()) {
        return provider;
    }
    return forwardingProxy(provider, {
        resolveWebviewView: (
            webviewView: vscode.WebviewView,
            context: vscode.WebviewViewResolveContext,
            token: vscode.CancellationToken,
        ): void | Thenable<void> =>
            provider.resolveWebviewView(captureWebview(webviewView, contextId), context, token),
    });
}
