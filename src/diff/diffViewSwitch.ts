import * as vscode from "vscode";

/** Which of the two surfaces a diff tab is drawn on. */
export type DiffViewKind = "intelligit" | "vscode";

/** Set while the active tab is a diff this module can reopen on the other surface. */
export const DIFF_SWITCHABLE_CONTEXT = "intelligit.diffSwitchable";

/** Title-bar button that moves the active diff onto IntelliGit's own viewer. */
export const SHOW_DIFF_IN_INTELLIGIT_COMMAND = "intelligit.diff.showInIntelliGit";

/** Title-bar button that moves the active diff onto VS Code's built-in diff editor. */
export const SHOW_DIFF_IN_VSCODE_COMMAND = "intelligit.diff.showInVsCode";

const EDITABLE_DIFF_VIEW_TYPE = "intelligit.editableDiff";
const DIFF_VIEWER_VIEW_TYPE = "intelligit.diffViewer";

/**
 * Reopens one diff on whichever surface it is handed.
 *
 * A thunk rather than the request-and-delegates struct it closes over, so this module imports no
 * opener at all. There are two of them -- `editableDiffOpener` for the working tree and
 * `diffService` for everything read-only -- and `diffService` already imports this file, so
 * naming either one here would close a cycle. Handing over the reopen keeps the arrows one-way.
 */
type ReopenDiff = (preferredView: DiffViewKind) => Promise<void>;

/**
 * One entry per open diff tab, keyed by the tab rather than by the file.
 *
 * Keyed by the tab because the three surfaces do not share a URI: the custom editor opens on the
 * real file, the viewer is a webview panel that owns no file at all, and the native fallback can
 * open two synthetic read-only URIs of which neither is the file. A tab key is the one identity
 * all three actually carry.
 */
const tracked = new Map<string, ReopenDiff>();

/**
 * Whether `registerDiffViewSwitch` has run.
 *
 * Until it has there are no buttons and no context key, so tracking a tab would record state
 * nothing can read. It also keeps the openers off the tab API entirely in that state, which is
 * what lets a caller that never registered -- a unit test, an activation that failed earlier --
 * open a diff without depending on window chrome it is not exercising.
 */
let registered = false;

/** Narrows against a constructor that a test double is allowed to omit entirely. */
function isInstanceOf(value: unknown, constructor: unknown): boolean {
    return (
        typeof constructor === "function" &&
        value instanceof (constructor as new (...args: never[]) => object)
    );
}

/**
 * The view type of a tab holding IntelliGit's diff viewer, or `undefined` for any other webview.
 *
 * Matched on the suffix because VS Code reports a panel's type as `mainThreadWebview-<viewType>`.
 * Narrowed to this one view type on purpose: every other webview the extension opens -- the
 * undocked commit panel above all -- is a tab, and a key that claimed those as diffs would put
 * the buttons on an editor they cannot reopen.
 */
function diffViewerWebviewType(input: unknown): string | undefined {
    if (!isInstanceOf(input, vscode.TabInputWebview)) return undefined;
    const { viewType } = input as vscode.TabInputWebview;
    return viewType.endsWith(DIFF_VIEWER_VIEW_TYPE) ? viewType : undefined;
}

/**
 * The stable key for a diff tab, or `undefined` for a tab that is not a diff at all.
 *
 * Exported for the test that pins the shapes apart -- a key that collapsed them would send the
 * button to the wrong document rather than fail.
 */
export function diffTabKey(tab: vscode.Tab | undefined): string | undefined {
    const input: unknown = tab?.input;
    if (input === undefined) return undefined;
    if (isInstanceOf(input, vscode.TabInputCustom)) {
        const custom = input as vscode.TabInputCustom;
        return `custom:${custom.viewType}:${custom.uri.toString()}`;
    }
    if (isInstanceOf(input, vscode.TabInputTextDiff)) {
        const diff = input as vscode.TabInputTextDiff;
        return `diff:${diff.original.toString()}:${diff.modified.toString()}`;
    }
    const webview = diffViewerWebviewType(input);
    // No file in the key, because the viewer is a single reused panel: opening a second diff
    // reveals the same tab with new content, so one key per view type is one key per tab.
    return webview === undefined ? undefined : `webview:${webview}`;
}

/** Which surface a tab is already showing, so a button that changes nothing can do nothing. */
function viewKindOf(tab: vscode.Tab | undefined): DiffViewKind | undefined {
    const input: unknown = tab?.input;
    if (isInstanceOf(input, vscode.TabInputCustom)) {
        return (input as vscode.TabInputCustom).viewType === EDITABLE_DIFF_VIEW_TYPE
            ? "intelligit"
            : undefined;
    }
    if (diffViewerWebviewType(input)) return "intelligit";
    return isInstanceOf(input, vscode.TabInputTextDiff) ? "vscode" : undefined;
}

function activeTab(): vscode.Tab | undefined {
    return vscode.window.tabGroups?.activeTabGroup?.activeTab ?? undefined;
}

/** Shows or hides both title-bar buttons together, so they only appear on a diff we can reopen. */
async function syncSwitchContext(): Promise<void> {
    const key = diffTabKey(activeTab());
    await vscode.commands.executeCommand(
        "setContext",
        DIFF_SWITCHABLE_CONTEXT,
        Boolean(key && tracked.has(key)),
    );
}

/**
 * Records that the tab now in front is `reopen`'s diff, so the title-bar buttons can move it.
 *
 * The openers call this at each point where a tab actually reaches the screen, and never on the
 * paths where a newer request superseded this one. Those land nothing, so recording them would
 * bind whichever tab happened to be in front to a diff the reader never asked to see -- the
 * button would then open the wrong file, which is worse than not being offered at all.
 */
export async function trackDiffTab(reopen: ReopenDiff): Promise<void> {
    if (!registered) return;
    const key = diffTabKey(activeTab());
    if (key) tracked.set(key, reopen);
    await syncSwitchContext();
}

/** Reopens the diff in the active tab on the other surface, closing the tab it came from. */
async function switchActiveDiff(target: DiffViewKind): Promise<void> {
    const tab = activeTab();
    const key = diffTabKey(tab);
    const reopen = key ? tracked.get(key) : undefined;
    if (!tab || !key || !reopen || viewKindOf(tab) === target) return;
    // A dirty custom editor answers the close with a save prompt, and `false` when the reader
    // cancels it. Opening the other surface anyway would leave them looking at the same diff
    // twice after asking for it to stay where it was, so the switch ends here instead.
    if (!(await vscode.window.tabGroups.close(tab))) return;
    tracked.delete(key);
    await reopen(target);
}

/** Registers the two editor title-bar commands and keeps their visibility context current. */
export function registerDiffViewSwitch(context: vscode.ExtensionContext): vscode.Disposable {
    const disposables = [
        vscode.commands.registerCommand(SHOW_DIFF_IN_INTELLIGIT_COMMAND, () =>
            switchActiveDiff("intelligit"),
        ),
        vscode.commands.registerCommand(SHOW_DIFF_IN_VSCODE_COMMAND, () =>
            switchActiveDiff("vscode"),
        ),
        vscode.window.tabGroups.onDidChangeTabs((event) => {
            for (const tab of event.closed) {
                const key = diffTabKey(tab);
                if (key) tracked.delete(key);
            }
            void syncSwitchContext();
        }),
        vscode.window.tabGroups.onDidChangeTabGroups(() => void syncSwitchContext()),
    ];
    const disposable = {
        dispose: () => {
            for (const entry of disposables) entry.dispose();
            // Every entry points at buttons that are gone, so it survives only as a way to
            // reopen a diff nothing can ask for.
            registered = false;
            tracked.clear();
        },
    };
    context.subscriptions.push(disposable);
    registered = true;
    void syncSwitchContext();
    return disposable;
}

/** Drops every tracked tab and the registration flag. Test-only: both outlive a single case. */
export function resetTrackedDiffsForTests(): void {
    registered = false;
    tracked.clear();
}
