/**
 * The shared `vscode.WebviewPanel` double, plus the construction registry that lets a recorder
 * reach a panel production code creates INTERNALLY through `vscode.window.createWebviewPanel`.
 *
 * Every context recorded through Phase 2c-iv resolves against a `vscode.WebviewView` a recorder
 * hands directly to production (`createFakeCommitPanelWebviewView` and friends,
 * `commitInfoVscodeDouble.ts`) -- `captureWebviewViewProvider` wraps the PROVIDER, and the recorder
 * itself calls `resolveWebviewView(webviewView, ...)`, so the fake view is always right there in the
 * recorder's own hands. `MergeConflictSessionPanel` (Phase 2c-v-a) is different: `open()` calls
 * `vscode.window.createWebviewPanel(...)` and `captureWebview(rawPanel, ...)` itself
 * (`src/views/MergeConflictSessionPanel.ts:111-121`), so the recorder never constructs a panel at
 * all -- it can only reach one AFTER production created it. `window.createWebviewPanel` therefore has
 * to be doubled to build a `FakeWebviewPanel` AND remember it somewhere the recorder can look it up
 * afterward; {@link getCreatedWebviewPanels} is that lookup, and `commitInfoVscodeDouble.ts`'s own
 * `window.createWebviewPanel` member is what calls {@link createFakeWebviewPanel} to populate it.
 *
 * **Why `dispose()` firing every `onDidDispose` listener is load-bearing, not tidiness.**
 * `MergeConflictSessionPanel` keeps a PROCESS-WIDE static singleton, `currentPanel`
 * (`src/views/MergeConflictSessionPanel.ts:43`), cleared ONLY from an `onDidDispose` callback
 * registered in its own constructor (`:82-87`, clearing at `:84-85`). A double whose `dispose()`
 * never invokes its own `onDidDispose` listeners leaves `currentPanel` set forever. The SECOND
 * `MergeConflictSessionPanel.open()` call in the same vitest process then takes the reuse branch
 * (`:102-109`), which skips `createWebviewPanel` and `captureWebview` entirely -- no new panel is
 * ever registered here, and the reused panel's `postMessage` closure still writes into the
 * capture-sink INSTANCE it closed over at the FIRST recording's wrap time, which
 * `resetE2eWebviewCaptureSinkForTests()` has since orphaned. `recordMergeConflictSessionWebviewFixture.ts`
 * disposes the panel it creates as its own last step for exactly this reason -- see that module's
 * own doc comment.
 */

import type * as vscode from "vscode";
import { throwingDouble } from "./throwingDouble";

/** A disposable that never fires and does nothing on `dispose()`. Duplicated from
 * `commitInfoVscodeDouble.ts`'s own `inertDisposable` rather than imported: that module imports
 * {@link createFakeWebviewPanel} to wire its `window.createWebviewPanel` member, so an import the
 * other direction would be circular. */
function inertDisposable(): vscode.Disposable {
    return { dispose(): void {} };
}

/** Minimal fake `vscode.Uri`, duplicated from `commitInfoVscodeDouble.ts`'s own `FakeUri` for the
 * identical no-circular-import reason as {@link inertDisposable}. */
interface FakePanelUri {
    readonly fsPath: string;
    readonly path: string;
    toString(): string;
}

function fakePanelUriFile(value: string): FakePanelUri {
    return { fsPath: value, path: value, toString: () => value };
}

/** The raw (pre-capture-wrap) `vscode.Webview` half of the fake panel -- the same minimal member
 * set `commitInfoVscodeDouble.ts`'s `RawWebview` implements, for the identical reason:
 * `captureWebview` (`src/e2e/webviewCapture.ts`'s `withCapturedWebview`) only ever substitutes this
 * field wholesale, so every OTHER member production reads through it must be implemented here
 * explicitly. */
interface RawPanelWebview {
    options: vscode.WebviewOptions;
    html: string;
    readonly cspSource: string;
    asWebviewUri(uri: vscode.Uri): vscode.Uri;
    onDidReceiveMessage(listener: (message: unknown) => unknown): vscode.Disposable;
    postMessage(message: unknown): Thenable<boolean>;
}

/**
 * One fake `vscode.WebviewPanel`, built by {@link createFakeWebviewPanel}. Every member exists for
 * a specific, named reason.
 */
export interface FakeWebviewPanel {
    readonly webview: vscode.Webview;
    /** `ShelfConflictEditorPanel.ts:202` assigns this. No context recorded through Phase 2c-v-a
     * reads it back, but a plain, readable/writable field costs nothing and keeps the double ready
     * for the panel that does -- a property WRITE always falls through to the underlying object
     * (see `throwingDouble.ts`'s own doc comment on why there is no `set` trap), so this stays a
     * genuine mutable field even wrapped in `throwingDouble`. */
    title: string;
    /** `UndockedViewProvider.ts:701` reads this synchronously. Starts `true`: a panel being created
     * and recorded from is the visible one in every real invocation this double models -- the same
     * reasoning `createFakeCommitPanelWebviewView`'s own `visible: true` already uses. */
    visible: boolean;
    /** Reached on `MergeConflictSessionPanel`'s reuse branch (`:106`). No scenario recorded through
     * Phase 2c-v-a takes that branch on purpose (every recording disposes the panel it drove before
     * returning -- see `recordMergeConflictSessionWebviewFixture.ts`), so a no-op is correct here. */
    reveal(viewColumn?: vscode.ViewColumn): void;
    /** Registers `callback` to be invoked by {@link dispose}. See {@link dispose}'s own doc comment
     * for the exact firing semantics. */
    onDidDispose(callback: () => void): vscode.Disposable;
    /** `UndockedViewProvider.ts:698` registers one. No scenario recorded through Phase 2c-v-a
     * toggles view state, so an inert disposable that never fires is correct here -- the same
     * reasoning every other never-triggered registration in `commitInfoVscodeDouble.ts`
     * (`onDidChangeActiveColorTheme`, `onDidChangeConfiguration`) already uses. */
    onDidChangeViewState(
        callback: (event: vscode.WebviewPanelOnDidChangeViewStateEvent) => void,
    ): vscode.Disposable;
    /**
     * Synchronously invokes every listener registered through {@link onDidDispose}, in registration
     * order, each EXACTLY once -- including across repeated `dispose()` calls, which are idempotent
     * (matching real VS Code panels: a second `dispose()` never re-fires the event). A listener
     * registered AFTER `dispose()` already ran is never fired retroactively -- it is simply added to
     * a listener list `dispose()` will not iterate again. This is the mechanism this module's own
     * top doc comment explains is load-bearing, not tidiness.
     */
    dispose(): void;
    /** The recorder's handle to drive the webview -> host direction, exactly as
     * `createFakeCommitPanelWebviewView.receiveMessage` does for a `WebviewView`. Invokes and awaits
     * whatever handler `webview.onDidReceiveMessage` most recently registered. Throws if no handler
     * was registered yet -- production always registers one from its own constructor before this
     * could ever be called first. */
    receiveMessage(message: unknown): Promise<void>;
}

let createdPanels: FakeWebviewPanel[] = [];

/**
 * Every {@link FakeWebviewPanel} built by {@link createFakeWebviewPanel} since the last
 * {@link resetCreatedWebviewPanelsForTests} call, in construction order. This is the only way a
 * recorder reaches a panel `vscode.window.createWebviewPanel` built internally -- see this module's
 * own top doc comment.
 */
export function getCreatedWebviewPanels(): readonly FakeWebviewPanel[] {
    return createdPanels;
}

/**
 * Empties the construction registry so a later call to {@link getCreatedWebviewPanels} cannot see a
 * panel an earlier, unrelated recording (or test) built -- the identical "leaks captured state into
 * the next test" reasoning `resetE2eWebviewCaptureSinkForTests` already documents for the capture
 * sink.
 */
export function resetCreatedWebviewPanelsForTests(): void {
    createdPanels = [];
}

/**
 * Builds one fake `vscode.WebviewPanel` and appends it to the construction registry. Called by
 * `commitInfoVscodeDouble.ts`'s `window.createWebviewPanel` member -- never directly by a recorder,
 * since production code (not the recorder) decides when `createWebviewPanel` runs; a recorder
 * reaches the result through {@link getCreatedWebviewPanels} instead.
 *
 * Wrapped in {@link throwingDouble} for the identical reason every other fake in
 * `commitInfoVscodeDouble.ts` is: production runs its real methods against this object, so any
 * member it reaches for beyond what is implemented here must fail loudly, by name, rather than
 * silently resolving to `undefined` and sending production down a branch no real user would hit.
 */
export function createFakeWebviewPanel(): FakeWebviewPanel {
    let messageHandler: ((message: unknown) => unknown) | undefined;
    const disposeListeners: Array<() => void> = [];
    let disposed = false;

    const rawWebview: RawPanelWebview = {
        options: {},
        html: "",
        cspSource: "vscode-webview://fake-webview-panel",
        asWebviewUri: (uri: vscode.Uri) =>
            fakePanelUriFile(`vscode-resource://fake${uri.toString()}`) as unknown as vscode.Uri,
        onDidReceiveMessage: (listener) => {
            messageHandler = listener;
            return inertDisposable();
        },
        postMessage: () => Promise.resolve(true),
    };

    const rawPanel = {
        webview: rawWebview,
        title: "",
        visible: true,
        reveal: (): void => {},
        onDidDispose: (callback: () => void): vscode.Disposable => {
            disposeListeners.push(callback);
            return inertDisposable();
        },
        onDidChangeViewState: (): vscode.Disposable => inertDisposable(),
        dispose: (): void => {
            if (disposed) return;
            disposed = true;
            // A fixed snapshot of the listeners registered up to this point -- a listener added by
            // (or after) one of these callbacks, or by any later `onDidDispose` call, must never be
            // fired by THIS invocation of the loop. `disposed` already being `true` is what stops it
            // being fired by a future `dispose()` call either -- see this interface's own `dispose()`
            // doc comment.
            for (const listener of [...disposeListeners]) listener();
        },
        receiveMessage: async (message: unknown): Promise<void> => {
            if (!messageHandler) {
                throw new Error(
                    "createFakeWebviewPanel.receiveMessage: no message handler was registered " +
                        "yet -- production must call webview.onDidReceiveMessage first.",
                );
            }
            await messageHandler(message);
        },
    };

    const panel = throwingDouble<FakeWebviewPanel>("webviewPanel", rawPanel);
    createdPanels.push(panel);
    return panel;
}
