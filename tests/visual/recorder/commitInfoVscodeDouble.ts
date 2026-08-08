/**
 * The `vscode` module double and fake `WebviewView` builders for recording resolved host
 * contexts. Originally built for "commit-info" (`CommitInfoViewProvider`,
 * `src/views/CommitInfoViewProvider.ts`) -- Phase 2c-i's one chosen context (see
 * `recordCommitInfoWebviewFixture.ts`'s own doc comment for why it was picked) -- and extended in
 * Phase 2c-iv-b to also build the fake webview view for `CommitGraphViewProvider`
 * (`src/views/CommitGraphViewProvider.ts`, contexts `commit-graph-card` / `commit-graph-compact`).
 * The commit-graph recorder test file imports `createCommitInfoVscodeDouble()` directly (kept
 * under its original name, not aliased) -- see that function's own doc comment for why its
 * existing surface needed no new member to cover the commit-graph happy path too.
 *
 * Built with {@link throwingDouble} throughout, not a plain object: the whole point of this
 * module is that production code runs against it, unmodified, so every member it reaches for that
 * this double did not explicitly implement fails loudly and by name instead of silently returning
 * `undefined` and sending production down a branch no real user would ever hit (see
 * `throwingDouble.ts`'s own doc comment).
 *
 * The exact surface implemented below was derived by reading the real call chains the "clean"
 * recordings exercise -- `CommitInfoViewProvider.resolveWebviewView` / `setCommitDetail`,
 * `CommitGraphViewProvider.resolveWebviewView`'s `ready` handler, through `IconThemeService` and
 * `FileIconThemeResolver` (`src/views/shared/IconThemeService.ts`, `src/utils/fileIconTheme.ts`),
 * through `buildWebviewShellHtml` (`src/views/webviewHtml.ts`) -- not guessed. Two things are
 * deliberately absent even though the classes above reference them:
 *
 *  - `vscode.workspace.getConfiguration`: every call site that reads it
 *    (`FileIconThemeResolver.resolveConfiguredThemeId`, `webviewHtml.ts`'s `readWebviewSettings`)
 *    wraps the read in its own `try`/`catch` and falls back to "no configured icon theme" /
 *    default settings. Leaving it unimplemented means those fallbacks are exercised for real
 *    (proving they exist and work), rather than this double having to fake a whole VS Code
 *    configuration store no scenario here needs.
 *  - `vscode.extensions`: `FileIconThemeResolver`'s constructor reads it inside its own
 *    `try`/`catch` too, for the same reason.
 *
 * If a future scenario recorded through this module needs either, the double will throw naming
 * exactly that member -- the signal to come back and implement it deliberately, not a bug.
 */

import type * as vscode from "vscode";
import { throwingDouble } from "./throwingDouble";

/** A disposable that never fires and does nothing on `dispose()` -- every listener registration
 * this double's `vscode` surface exposes is one no scenario here ever triggers. */
function inertDisposable(): vscode.Disposable {
    return { dispose(): void {} };
}

/**
 * Builds the `vscode` module double `vi.mock("vscode", ...)` returns for a commit-info OR
 * commit-graph recording. Wrapped in {@link throwingDouble} at the top level, so
 * `vscode.anythingElse` throws naming itself, exactly like every nested member below.
 *
 * Reused unchanged for `commit-graph-card` / `commit-graph-compact`
 * (`recordCommitGraphWebviewFixture.ts`): `CommitGraphViewProvider`'s own `ready`-then-history-
 * loads happy path reaches `EventEmitter` (nine field initializers), `Uri.joinPath` (its own
 * `:239`), and, through the same shared `IconThemeService` / `FileIconThemeResolver` collaborator
 * `CommitInfoViewProvider` already exercises, `env.language`, `l10n.t`,
 * `window.onDidChangeActiveColorTheme`, and `workspace.onDidChangeConfiguration` -- every member
 * already implemented below. `commands.executeCommand`, `window.showErrorMessage` + `l10n.t`'s
 * error-path calls, and `Uri.parse` + `env.openExternal` are real members of
 * `CommitGraphViewProvider.ts` too, but only on branches this "clean" scenario's `ready` message
 * never reaches (a webview action message, or a caught git/theme error) -- see
 * `recordCommitGraphWebviewFixture.ts`'s own doc comment.
 */
export function createCommitInfoVscodeDouble(): typeof vscode {
    const implementation: Partial<typeof vscode> = {
        EventEmitter: FakeEventEmitter as unknown as typeof vscode.EventEmitter,
        Uri: {
            file: fakeUriFile,
            joinPath: fakeUriJoinPath,
        } as unknown as typeof vscode.Uri,
        env: { language: "en" } as typeof vscode.env,
        l10n: { t: (message: string) => message } as typeof vscode.l10n,
        window: {
            onDidChangeActiveColorTheme: () => inertDisposable(),
        } as unknown as typeof vscode.window,
        workspace: {
            onDidChangeConfiguration: () => inertDisposable(),
        } as unknown as typeof vscode.workspace,
    };
    return throwingDouble<typeof vscode>("vscode", implementation);
}

/** Minimal `vscode.EventEmitter` stand-in: `CommitInfoViewProvider` constructs one for its own
 * `onOpenCommitFileDiff` event and disposes it, and `CommitGraphViewProvider` constructs nine
 * (one per field initializer) the same way -- neither "clean" scenario fires or listens to any of
 * them. Implemented for real (not stubbed) since it is trivial and constructing it wrong would
 * throw inside the provider's own field initializer, before any capture happens. */
class FakeEventEmitter<T> {
    private readonly listeners: Array<(value: T) => void> = [];

    readonly event = (listener: (value: T) => void): vscode.Disposable => {
        this.listeners.push(listener);
        return inertDisposable();
    };

    fire(value: T): void {
        for (const listener of this.listeners) listener(value);
    }

    dispose(): void {
        this.listeners.length = 0;
    }
}

/** Uri shape mirrored from this repository's other hand-rolled `vscode` mocks (see
 * `tests/integration/extension/view-providers.integration.test.ts`), reused here rather than
 * reinvented -- `fsPath`/`path`/`toString()` is the exact minimum every call site below reads. */
interface FakeUri {
    readonly fsPath: string;
    readonly path: string;
    toString(): string;
}

function fakeUriFile(value: string): FakeUri {
    return { fsPath: value, path: value, toString: () => value };
}

function fakeUriJoinPath(base: FakeUri, ...segments: string[]): FakeUri {
    const joined = [base.path, ...segments].join("/").replace(/\/+/g, "/");
    return fakeUriFile(joined);
}

/** The raw (pre-capture-wrap) `vscode.Webview` half of the fake view. Kept separate from
 * {@link FakeCommitInfoWebviewView} so `createFakeCommitInfoWebviewView` can close over it while
 * also exposing it through the returned `webviewView.webview` field. */
interface RawWebview {
    options: vscode.WebviewOptions;
    html: string;
    readonly cspSource: string;
    asWebviewUri(uri: vscode.Uri): vscode.Uri;
    onDidReceiveMessage(listener: (message: unknown) => unknown): vscode.Disposable;
    postMessage(message: unknown): Thenable<boolean>;
}

/** What {@link createFakeCommitInfoWebviewView} returns: the double to resolve the real provider
 * against, plus a driver hook to simulate the webview's own `ready` (and any other) message
 * without reaching through the capture-wrapping layers to find the handler. */
export interface FakeCommitInfoWebviewView {
    readonly webviewView: vscode.WebviewView;
    /** Invokes whatever handler `onDidReceiveMessage` most recently registered, awaiting it --
     * `CommitInfoViewProvider`'s own handler is `async`, and awaiting here is what makes the
     * driver's later steps able to rely on the handler having fully run. Throws if no handler was
     * registered yet (`resolveWebviewView` must run first). */
    receiveMessage(message: unknown): Promise<void>;
}

/**
 * Builds one fake `vscode.WebviewView` -- wrapped in {@link throwingDouble} exactly like the
 * `vscode` module double above, and for the identical reason: `CommitInfoViewProvider` runs its
 * real `resolveWebviewView`/`setCommitDetail` bodies against this object, and any member it
 * reaches for beyond `webview.{options,html,cspSource,asWebviewUri,onDidReceiveMessage,
 * postMessage}` and the view's own `onDidDispose` must fail loudly rather than silently.
 */
export function createFakeCommitInfoWebviewView(): FakeCommitInfoWebviewView {
    let messageHandler: ((message: unknown) => unknown) | undefined;

    const rawWebview: RawWebview = {
        options: {},
        html: "",
        cspSource: "vscode-webview://fake-commit-info",
        asWebviewUri: (uri: vscode.Uri) =>
            fakeUriFile(`vscode-resource://fake${uri.toString()}`) as unknown as vscode.Uri,
        onDidReceiveMessage: (listener) => {
            messageHandler = listener;
            return inertDisposable();
        },
        postMessage: () => Promise.resolve(true),
    };

    const rawWebviewView = {
        webview: rawWebview,
        onDidDispose: () => inertDisposable(),
    };

    const webviewView = throwingDouble<vscode.WebviewView>("webviewView", rawWebviewView);

    return {
        webviewView,
        receiveMessage: async (message: unknown): Promise<void> => {
            if (!messageHandler) {
                throw new Error(
                    "createFakeCommitInfoWebviewView.receiveMessage: no message handler was " +
                        "registered yet -- resolveWebviewView() must run first.",
                );
            }
            await messageHandler(message);
        },
    };
}

/** What {@link createFakeCommitGraphWebviewView} returns -- same shape as
 * {@link FakeCommitInfoWebviewView}, kept as its own named type rather than reused because the two
 * underlying `webviewView` doubles implement different member sets (see that function's own doc
 * comment for exactly which). */
export interface FakeCommitGraphWebviewView {
    readonly webviewView: vscode.WebviewView;
    /** Same contract as {@link FakeCommitInfoWebviewView.receiveMessage}: invokes and awaits
     * whatever handler `onDidReceiveMessage` most recently registered. Throws if no handler was
     * registered yet (`resolveWebviewView` must run first). */
    receiveMessage(message: unknown): Promise<void>;
}

/**
 * Builds one fake `vscode.WebviewView` for `CommitGraphViewProvider`
 * (`recordCommitGraphWebviewFixture.ts`) -- wrapped in {@link throwingDouble} for the identical
 * reason as {@link createFakeCommitInfoWebviewView}. Two members beyond that function's set are
 * needed here, both forced by `CommitGraphViewProvider.resolveWebviewView` itself (not guessed):
 *
 *  - `onDidChangeVisibility` (`CommitGraphViewProvider.ts:265`): registered unconditionally on
 *    every resolution, to forward real host visibility into the webview. The "clean" scenario
 *    never toggles visibility, so this only needs to accept a registration and hand back a
 *    disposable, exactly like `onDidDispose`.
 *  - `visible` (`CommitGraphViewProvider.ts:275`): read once, synchronously, inside the `ready`
 *    handler to post the webview's own initial `setViewVisibility` message. `CommitInfoViewProvider`
 *    never reads this, so `FakeCommitInfoWebviewView`'s double has no need to define it -- but a
 *    plain property read (not a `throwingDouble`-recursed plain object) needs a real value here or
 *    the `ready` recording throws before reaching branch/commit data. `true`, since a view being
 *    resolved and recorded from is the visible one in every real invocation this scenario models.
 */
export function createFakeCommitGraphWebviewView(): FakeCommitGraphWebviewView {
    let messageHandler: ((message: unknown) => unknown) | undefined;

    const rawWebview: RawWebview = {
        options: {},
        html: "",
        cspSource: "vscode-webview://fake-commit-graph",
        asWebviewUri: (uri: vscode.Uri) =>
            fakeUriFile(`vscode-resource://fake${uri.toString()}`) as unknown as vscode.Uri,
        onDidReceiveMessage: (listener) => {
            messageHandler = listener;
            return inertDisposable();
        },
        postMessage: () => Promise.resolve(true),
    };

    const rawWebviewView = {
        webview: rawWebview,
        visible: true,
        onDidDispose: () => inertDisposable(),
        onDidChangeVisibility: () => inertDisposable(),
    };

    const webviewView = throwingDouble<vscode.WebviewView>("webviewView", rawWebviewView);

    return {
        webviewView,
        receiveMessage: async (message: unknown): Promise<void> => {
            if (!messageHandler) {
                throw new Error(
                    "createFakeCommitGraphWebviewView.receiveMessage: no message handler was " +
                        "registered yet -- resolveWebviewView() must run first.",
                );
            }
            await messageHandler(message);
        },
    };
}

/** A stable, arbitrary extension-installation URI. Never captured: `wrapWebviewForCapture` only
 * records `postMessage` payloads, and `extensionUri` only ever reaches `webview.html` (a plain
 * property SET, never posted) in the flow this recorder drives. Any fixed value is therefore
 * safe here -- it is not a leak vector -- and this one is deliberately not a real filesystem
 * path so it can never be mistaken for one. */
export function createFakeExtensionUri(): vscode.Uri {
    return fakeUriFile("fake-extension-root") as unknown as vscode.Uri;
}
