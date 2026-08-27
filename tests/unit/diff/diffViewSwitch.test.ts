import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    executeCommand: vi.fn(async () => undefined),
    registerCommand: vi.fn((id: string, handler: () => Promise<void>) => ({ id, handler })),
    close: vi.fn(async () => true),
    onDidChangeTabs: vi.fn((listener: (event: { closed: unknown[] }) => void) => ({ listener })),
    onDidChangeTabGroups: vi.fn((listener: () => void) => ({ listener })),
    activeTab: { current: undefined as unknown },
}));

vi.mock("vscode", () => {
    class TabInputCustom {
        constructor(
            readonly uri: { toString(): string },
            readonly viewType: string,
        ) {}
    }
    class TabInputTextDiff {
        constructor(
            readonly original: { toString(): string },
            readonly modified: { toString(): string },
        ) {}
    }
    class TabInputWebview {
        constructor(readonly viewType: string) {}
    }
    return {
        TabInputCustom,
        TabInputTextDiff,
        TabInputWebview,
        commands: {
            executeCommand: mocks.executeCommand,
            registerCommand: mocks.registerCommand,
        },
        window: {
            tabGroups: {
                get activeTabGroup() {
                    return { activeTab: mocks.activeTab.current };
                },
                close: mocks.close,
                onDidChangeTabs: mocks.onDidChangeTabs,
                onDidChangeTabGroups: mocks.onDidChangeTabGroups,
            },
        },
    };
});

import * as vscode from "vscode";
import {
    DIFF_SWITCHABLE_CONTEXT,
    diffTabKey,
    registerDiffViewSwitch,
    resetTrackedDiffsForTests,
    SHOW_DIFF_IN_INTELLIGIT_COMMAND,
    SHOW_DIFF_IN_VSCODE_COMMAND,
    trackDiffTab,
    type DiffViewKind,
} from "../../../src/diff/diffViewSwitch";

const FILE_URI = "file:///repo/src/app.ts";

function uri(value: string): { toString(): string } {
    return { toString: () => value };
}

/** A custom-editor tab for our own view type -- what the editable surface leaves behind. */
function intelliGitTab(): { input: unknown } {
    return { input: new vscode.TabInputCustom(uri(FILE_URI), "intelligit.editableDiff") };
}

/** A native diff tab -- what the fallback leaves behind, over two synthetic URIs. */
function nativeTab(): { input: unknown } {
    return {
        input: new vscode.TabInputTextDiff(
            uri("intelligit-diff:/src/app.ts?ref=HEAD"),
            uri(FILE_URI),
        ),
    };
}

/**
 * The read-only viewer's tab -- what a commit-file diff leaves behind.
 *
 * Spelled with VS Code's own `mainThreadWebview-` prefix, because that is what the API reports
 * and a key that compared for equality with our view type would never match a real tab.
 */
function viewerTab(): { input: unknown } {
    return { input: new vscode.TabInputWebview("mainThreadWebview-intelligit.diffViewer") };
}

/** Another of the extension's webviews, which is a tab but is not a diff. */
function commitPanelTab(): { input: unknown } {
    return { input: new vscode.TabInputWebview("mainThreadWebview-intelligit.commitPanel") };
}

const reopen = vi.fn(async (_view: DiffViewKind) => undefined);

/** Registers the commands and hands back the two handlers plus the tab-change listener. */
function register(): {
    showInIntelliGit: () => Promise<void>;
    showInVsCode: () => Promise<void>;
    tabsChanged: (event: { closed: unknown[] }) => void;
} {
    const context = { subscriptions: [] as Array<{ dispose(): void }> };
    registerDiffViewSwitch(context as never);
    const handlerFor = (id: string): (() => Promise<void>) => {
        const call = mocks.registerCommand.mock.calls.find((entry) => entry[0] === id);
        if (!call) throw new Error(`command ${id} was never registered`);
        return call[1] as () => Promise<void>;
    };
    return {
        showInIntelliGit: handlerFor(SHOW_DIFF_IN_INTELLIGIT_COMMAND),
        showInVsCode: handlerFor(SHOW_DIFF_IN_VSCODE_COMMAND),
        tabsChanged: mocks.onDidChangeTabs.mock.calls[0][0],
    };
}

/** Stands in for an opener that landed on `tab`: put the tab in front, then record it. */
async function landOn(tab: unknown): Promise<void> {
    mocks.activeTab.current = tab;
    await trackDiffTab(reopen);
}

/** The value of the last `setContext` for the switch key, or `undefined` if it never ran. */
function lastSwitchableContext(): unknown {
    const calls = mocks.executeCommand.mock.calls.filter(
        (call) => call[0] === "setContext" && call[1] === DIFF_SWITCHABLE_CONTEXT,
    );
    return calls.at(-1)?.[2];
}

/** The surface the last reopen asked for -- the whole payload of a switch. */
function lastPreferredView(): unknown {
    return reopen.mock.calls.at(-1)?.[0];
}

describe("diff view switch", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        resetTrackedDiffsForTests();
        mocks.activeTab.current = undefined;
        // `clearAllMocks` wipes recorded calls but keeps implementations, so a case that made
        // the close refuse would otherwise make every later case's close refuse too.
        mocks.close.mockImplementation(async () => true);
        reopen.mockImplementation(async () => undefined);
    });

    // The surfaces do not share a URI, and the one URI two of them DO have in common is the
    // file itself. A key built from the file alone would make an open native tab look like the
    // custom editor's tab, so a switch would refuse as "already there" and do nothing. The
    // viewer has no file in its key at all -- it is a single reused panel.
    it("keys the three diff surfaces apart, and keys nothing else", () => {
        const keys = [intelliGitTab(), nativeTab(), viewerTab()].map((tab) =>
            diffTabKey(tab as never),
        );
        for (const key of keys) expect(key, "a diff surface produced no key at all").toBeTruthy();
        expect(new Set(keys).size, "two surfaces collapsed onto one key").toBe(3);
        // The undocked commit panel is a webview tab too. Keying it would put the buttons on an
        // editor they cannot reopen, and the reader would click them into nothing.
        expect(diffTabKey(commitPanelTab() as never)).toBeUndefined();
        expect(diffTabKey({ input: { uri: uri(FILE_URI) } } as never)).toBeUndefined();
        expect(diffTabKey(undefined)).toBeUndefined();
    });

    it("offers the switch on whichever tab the open actually landed in", async () => {
        register();

        await landOn(intelliGitTab());

        expect(lastSwitchableContext()).toBe(true);
    });

    // A decline that ends in the NATIVE diff is tracked exactly like a successful open.
    // Otherwise the button would be missing on precisely the diffs a reader most wants to move
    // back into the viewer.
    it("offers the switch after an open that fell back to the native diff", async () => {
        register();

        await landOn(nativeTab());

        expect(lastSwitchableContext()).toBe(true);
    });

    // The commit-file view is the one that opened this whole complaint: it is a webview panel,
    // not a custom editor, so every tab-shape assumption built around the editable diff has to
    // hold for it too or the buttons appear on one view and not the other.
    it("offers the switch on the read-only viewer's own tab", async () => {
        const { showInVsCode } = register();
        const tab = viewerTab();
        await landOn(tab);
        expect(lastSwitchableContext()).toBe(true);

        await showInVsCode();

        expect(mocks.close).toHaveBeenCalledWith(tab);
        expect(lastPreferredView(), "the reopen did not ask for the native surface").toBe("vscode");
    });

    it("treats the read-only viewer as already being the IntelliGit surface", async () => {
        const { showInIntelliGit } = register();
        await landOn(viewerTab());

        await showInIntelliGit();

        expect(mocks.close).not.toHaveBeenCalled();
        expect(reopen).not.toHaveBeenCalled();
    });

    it("reopens an IntelliGit diff natively and closes the tab it came from", async () => {
        const { showInVsCode } = register();
        const tab = intelliGitTab();
        await landOn(tab);

        await showInVsCode();

        expect(mocks.close).toHaveBeenCalledWith(tab);
        expect(lastPreferredView(), "the reopen did not ask for the native surface").toBe("vscode");
    });

    // The other direction must NOT force a surface: the viewer still gets to decline a file it
    // cannot render. Forcing "intelligit" here would be a promise the opener cannot keep.
    it("reopens a native diff through the viewer's own routing", async () => {
        const { showInIntelliGit } = register();
        const tab = nativeTab();
        await landOn(tab);

        await showInIntelliGit();

        expect(mocks.close).toHaveBeenCalledWith(tab);
        expect(lastPreferredView()).not.toBe("vscode");
    });

    // The close is a question, not a command: an edited pane makes VS Code ask about saving,
    // and `false` is the reader saying "leave it". Reopening past that answer would put the
    // same diff on screen twice.
    it("leaves the diff where it is when the close is refused", async () => {
        const { showInVsCode } = register();
        await landOn(intelliGitTab());
        mocks.close.mockImplementation(async () => false);

        await showInVsCode();
        expect(reopen).not.toHaveBeenCalled();

        // The tab is still on screen, so the button must still work on it. Asserting only that
        // nothing happened above would also pass if the refusal had dropped the entry.
        mocks.close.mockImplementation(async () => true);
        await showInVsCode();
        expect(reopen).toHaveBeenCalledTimes(1);
        expect(lastPreferredView()).toBe("vscode");
    });

    it("does nothing when the button names the surface already on screen", async () => {
        const { showInIntelliGit } = register();
        await landOn(intelliGitTab());

        await showInIntelliGit();

        expect(mocks.close).not.toHaveBeenCalled();
        expect(reopen).not.toHaveBeenCalled();
    });

    // Two things at once: the buttons disappear with the tab, and the entry behind them is
    // dropped. Without the drop, a session that opens diffs all day keeps every reopen closure
    // -- and the request and delegates it captured -- alive for as long as the window is open.
    it("stops offering the switch once the tracked tab is closed", async () => {
        const { tabsChanged } = register();
        const tab = intelliGitTab();
        await landOn(tab);
        expect(lastSwitchableContext()).toBe(true);

        tabsChanged({ closed: [tab] });

        expect(lastSwitchableContext()).toBe(false);
    });

    it("offers nothing on a tab it never opened", async () => {
        register();
        await landOn(intelliGitTab());

        mocks.activeTab.current = { input: { uri: uri("file:///repo/README.md") } };
        mocks.onDidChangeTabGroups.mock.calls[0][0]();
        await Promise.resolve();

        expect(lastSwitchableContext()).toBe(false);
    });

    // Both openers call `trackDiffTab` on every diff they land, including in tests and during a
    // failed activation. Before registration there is no button and no context key, so the call
    // has to stay off the tab API entirely rather than record state nothing can read.
    it("records nothing until the buttons are registered", async () => {
        mocks.activeTab.current = intelliGitTab();
        await trackDiffTab(reopen);
        expect(mocks.executeCommand).not.toHaveBeenCalled();

        const { showInVsCode } = register();
        await showInVsCode();

        expect(lastSwitchableContext()).toBe(false);
        expect(reopen).not.toHaveBeenCalled();
    });
});
