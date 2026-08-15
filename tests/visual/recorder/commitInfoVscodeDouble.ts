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
 * through `buildWebviewShellHtml` (`src/views/webviewHtml.ts`) -- not guessed. `workspace` now
 * exposes `getConfiguration`, but its backing store is installed explicitly by the recorder that
 * owns a configuration-dependent scenario (`workspaceConfigurationDouble.ts`). When no store is
 * installed, `createFakeWorkspaceConfiguration` throws before returning an object, and an unpinned
 * key still throws from `get`; those are diagnostic policies. They are not what preserves the
 * committed clean fixture bytes: the existing guarded callers would take the same fallbacks if an
 * uninstalled object instead returned `undefined`. The new `merge-editor` recorder pins
 * `editor.fontSize` instead of accepting the guarded `MergeEditorPanel.ts:54-59` read's swallowed
 * `undefined`, and the returned configuration object throws by section name for unsupported
 * members.
 *
 * `vscode.extensions` remains deliberately absent: `FileIconThemeResolver`'s constructor reads it
 * inside its own `try`/`catch`, and `throwingDouble` should still announce any future unguarded use.
 *
 * If a future scenario recorded through this module needs `vscode.extensions`, the double will
 * throw naming that member -- the signal to come back and implement it deliberately, not a bug.
 *
 * **Phase 2c-iv-c added nothing here, and that is the finding.** `commit-panel`
 * (`recordCommitPanelWebviewFixture.ts`) was expected to force `vscode.RelativePattern` and
 * `vscode.workspace.createFileSystemWatcher` through `CommitPanelViewProvider`'s constructor. It
 * does not: `registerRuntimeWatcher` (`CommitPanelViewProvider.ts:746`) is only ever called for
 * roots in `desiredRoots`, and `syncRuntimeWatchers` (`:727-730`) filters the ACTIVE root out of
 * that set, while `setRepositoriesInternal` (`:308-313`) makes the single root active -- so a
 * single-repository recording constructs no watcher at all. Both members were briefly added here
 * and then removed: nothing in production reached them, and the only test that needed them was the
 * one written to justify them. If a future multi-repository scenario does reach that path,
 * `throwingDouble` will say so by name -- which is exactly the signal this module exists to give.
 *
 * **Phase 2c-v-a added `window.createWebviewPanel` and `ViewColumn`, both forced by
 * `MergeConflictSessionPanel.open()` (`recordMergeConflictSessionWebviewFixture.ts`).**
 * `MergeConflictSessionPanel` is a `vscode.WebviewPanel` host, the first of the four remaining
 * resolved host contexts to be recorded -- unlike every context above it, its OWN `open()` calls
 * `vscode.window.createWebviewPanel(...)` and `vscode.ViewColumn.Active`
 * (`MergeConflictSessionPanel.ts:111-114`) itself, so both had to be added here rather than only in
 * a recorder's own construction call. `window.createWebviewPanel` delegates to
 * `webviewPanelDouble.ts`'s `createFakeWebviewPanel()` -- see that module's own doc comment for why
 * a SEPARATE construction registry, not a value handed back to the recorder directly, is what makes
 * a panel production creates internally reachable at all. `ViewColumn.Active` is set to `-1`,
 * matching real VS Code's own enum value for it -- nothing here reads it as anything but an opaque
 * value passed straight to `reveal()` and `createWebviewPanel`'s third argument, both no-ops on this
 * double, but a wrong-shaped value would still be a needless divergence from the real API.
 * `window.showErrorMessage` now throws deliberately when production reaches an error path during
 * a recording. The exception names the member and includes the message production tried to show,
 * preserving the real failure as the diagnostic and preventing an accidental `loadError` payload
 * from being captured.
 */

import type * as vscode from "vscode";
import { throwingDouble } from "./throwingDouble";
import { createFakeWebviewPanel } from "./webviewPanelDouble";
import { createFakeWorkspaceConfiguration } from "./workspaceConfigurationDouble";

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
 * already implemented below. `commands.executeCommand`, `Uri.parse`, and `env.openExternal` are
 * real members of `CommitGraphViewProvider.ts` too, but only on branches this "clean" scenario's
 * `ready` message never reaches (a webview action message, or a caught git/theme error) -- see
 * `recordCommitGraphWebviewFixture.ts`'s own doc comment. `window.showErrorMessage` is implemented
 * explicitly below because `MergeEditorPanel` uses it on its error path, where the recorder must
 * preserve the production message by throwing.
 *
 * Phase 2c-iv-c's `commit-panel` recording reuses this surface unchanged -- it forced no new
 * member. See this module's own doc comment for why the filesystem-watcher members it was expected
 * to need are deliberately absent.
 *
 * Phase 2c-v-a added `window.createWebviewPanel` and `ViewColumn`; Phase 2c-v-b adds the explicit
 * workspace-configuration delegate and throwing `showErrorMessage` needed by `MergeEditorPanel`.
 */
export function createCommitInfoVscodeDouble(): typeof vscode {
    const activeColorThemeChanges = new FakeEventEmitter<vscode.ColorTheme>();
    const configurationChanges = new FakeEventEmitter<vscode.ConfigurationChangeEvent>();
    const implementation: Partial<typeof vscode> = {
        EventEmitter: FakeEventEmitter as unknown as typeof vscode.EventEmitter,
        Uri: {
            file: fakeUriFile,
            joinPath: fakeUriJoinPath,
        } as unknown as typeof vscode.Uri,
        env: { language: "en" } as typeof vscode.env,
        l10n: { t: (message: string) => message } as typeof vscode.l10n,
        // `ViewColumn.Active` matches real VS Code's own enum value -- see this module's own doc
        // comment on why Phase 2c-v-a added this and `window.createWebviewPanel` together.
        ViewColumn: { Active: -1, One: 1 } as unknown as typeof vscode.ViewColumn,
        window: {
            onDidChangeActiveColorTheme: activeColorThemeChanges.event,
            createWebviewPanel: (
                ..._args: unknown[]
            ): ReturnType<typeof vscode.window.createWebviewPanel> =>
                createFakeWebviewPanel() as unknown as ReturnType<
                    typeof vscode.window.createWebviewPanel
                >,
            // `MergeEditorPanel.ts:88-105` must not turn an error into a captured `loadError`:
            // throwing here preserves the underlying failure and names the production message.
            showErrorMessage: (message: string): never => {
                throw new Error(
                    "vscode.window.showErrorMessage was called during a recording — production " +
                        "reached an error path a recording must never reach. The message it tried " +
                        `to show was: ${message}`,
                );
            },
        } as unknown as typeof vscode.window,
        workspace: {
            onDidChangeConfiguration: configurationChanges.event,
            // `MergeEditorPanel.ts:54-59` uses the sectioned form and `webviewHtml.ts:166` uses
            // the section-less form; the recorder-installed store keeps both explicit while its
            // default-throwing behavior preserves earlier guarded fallback paths.
            getConfiguration: (section?: string) => createFakeWorkspaceConfiguration(section),
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

/** Builds a fake `vscode.Uri` from an arbitrary path string. `createFakeExtensionUri()`'s fixed,
 * deliberately-not-a-real-path value is right for `extensionUri` (never captured, see that
 * function's own doc comment) but wrong for `repoRootUri`: `CommitPanelViewProvider`'s constructor
 * threads `repoRootUri.fsPath` into `setRepositoriesInternal` to build its one runtime, so
 * `recordCommitPanelWebviewFixture.ts` needs a `vscode.Uri` wrapping the REAL seeded workspace
 * root, not a fixed placeholder. Exported so that recorder module never needs a genuine value
 * import of `vscode` -- it stays typed against `vscode` only, exactly like
 * `recordCommitGraphWebviewFixture.ts`. */
export function createFakeUriFromPath(pathValue: string): vscode.Uri {
    return fakeUriFile(pathValue) as unknown as vscode.Uri;
}

/** What {@link createFakeCommitPanelWebviewView} returns -- same contract as
 * {@link FakeCommitGraphWebviewView}, kept as its own named type since the underlying
 * `webviewView` double may end up implementing a different member set once a real recording run
 * names what `CommitPanelViewProvider.resolveWebviewView` actually reaches (see that function's
 * own doc comment). */
export interface FakeCommitPanelWebviewView {
    readonly webviewView: vscode.WebviewView;
    /** Same contract as {@link FakeCommitInfoWebviewView.receiveMessage}: invokes and awaits
     * whatever handler `onDidReceiveMessage` most recently registered. Throws if no handler was
     * registered yet (`resolveWebviewView` must run first). */
    receiveMessage(message: unknown): Promise<void>;
}

/**
 * Builds one fake `vscode.WebviewView` for `CommitPanelViewProvider`
 * (`recordCommitPanelWebviewFixture.ts`) -- wrapped in {@link throwingDouble} for the identical
 * reason as {@link createFakeCommitInfoWebviewView}: production's real `resolveWebviewView` runs
 * against this object, so any member it reaches for beyond what is implemented here must fail
 * loudly rather than silently. Starts from the same member set
 * {@link createFakeCommitGraphWebviewView} needed (`webview.*`, `onDidDispose`, `visible`,
 * `onDidChangeVisibility`) since `CommitPanelViewProvider` is, like `CommitGraphViewProvider`, a
 * `vscode.WebviewViewProvider` whose `ready` handler is reached the same way; a member beyond this
 * set is added only once a real recording run throws naming it.
 */
export function createFakeCommitPanelWebviewView(): FakeCommitPanelWebviewView {
    let messageHandler: ((message: unknown) => unknown) | undefined;

    const rawWebview: RawWebview = {
        options: {},
        html: "",
        cspSource: "vscode-webview://fake-commit-panel",
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
                    "createFakeCommitPanelWebviewView.receiveMessage: no message handler was " +
                        "registered yet -- resolveWebviewView() must run first.",
                );
            }
            await messageHandler(message);
        },
    };
}
