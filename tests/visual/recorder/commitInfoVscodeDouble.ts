/**
 * The `vscode` module double and fake `WebviewView` for recording the "commit-info" context
 * (`CommitInfoViewProvider`, `src/views/CommitInfoViewProvider.ts`) -- Phase 2c-i's one chosen
 * context (see `recordCommitInfoWebviewFixture.ts`'s own doc comment for why it was picked).
 *
 * Built with {@link throwingDouble} throughout, not a plain object: the whole point of this
 * module is that `CommitInfoViewProvider`'s REAL production code runs against it, unmodified, so
 * every member it reaches for that this double did not explicitly implement fails loudly and by
 * name instead of silently returning `undefined` and sending production down a branch no real
 * user would ever hit (see `throwingDouble.ts`'s own doc comment).
 *
 * The exact surface implemented below was derived by reading the real call chain the "clean"
 * recording exercises -- `CommitInfoViewProvider.resolveWebviewView` / `setCommitDetail`, through
 * `IconThemeService` and `FileIconThemeResolver` (`src/views/shared/IconThemeService.ts`,
 * `src/utils/fileIconTheme.ts`), through `buildWebviewShellHtml` (`src/views/webviewHtml.ts`) --
 * not guessed. Two things are deliberately absent even though the classes above reference them:
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
 * Builds the `vscode` module double `vi.mock("vscode", ...)` returns for a commit-info
 * recording. Wrapped in {@link throwingDouble} at the top level, so `vscode.anythingElse` throws
 * naming itself, exactly like every nested member below.
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
 * `onOpenCommitFileDiff` event and disposes it, but the "clean" scenario never fires or listens
 * to it. Implemented for real (not stubbed) since it is trivial and constructing it wrong would
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

/** A stable, arbitrary extension-installation URI. Never captured: `wrapWebviewForCapture` only
 * records `postMessage` payloads, and `extensionUri` only ever reaches `webview.html` (a plain
 * property SET, never posted) in the flow this recorder drives. Any fixed value is therefore
 * safe here -- it is not a leak vector -- and this one is deliberately not a real filesystem
 * path so it can never be mistaken for one. */
export function createFakeExtensionUri(): vscode.Uri {
    return fakeUriFile("fake-extension-root") as unknown as vscode.Uri;
}
