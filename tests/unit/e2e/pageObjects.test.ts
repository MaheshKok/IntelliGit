import type { FrameLocator, Locator, Page } from "@playwright/test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ChangesPanel } from "../../e2e/pageObjects/changesPanel";
import { IntelliGitView } from "../../e2e/pageObjects/intelliGitView";
import { Workbench } from "../../e2e/pageObjects/workbench";

/** Captured at import time, before any test has had a chance to spy on the getter. */
const REAL_PLATFORM = process.platform;

// `process` belongs to the whole worker, not to this file, so a `vi.spyOn(process, "platform")`
// left standing decides what every later file sees -- and only when the run order happens to put
// one downstream. Restored here rather than through the config's `restoreMocks`, which the webview
// suites cannot take: they install their DOM spies once per file and share them across cases.
afterEach(() => {
    vi.restoreAllMocks();
});

describe("Workbench", () => {
    it.each([
        ["darwin", "Meta+Shift+P"],
        ["linux", "Control+Shift+P"],
    ])("uses the %s command-palette modifier", async (platform, expectedShortcut) => {
        vi.spyOn(process, "platform", "get").mockReturnValue(platform as NodeJS.Platform);
        const keyboard = { press: vi.fn() };
        const commandInput = {
            fill: vi.fn(),
            // The behaviour measured in the pinned Linux container: chord #1 is dropped, #2 lands.
            waitFor: vi
                .fn()
                .mockRejectedValueOnce(new Error("locator.waitFor: Timeout 3000ms exceeded"))
                .mockResolvedValue(undefined),
        };
        const option = { click: vi.fn() };
        const alerts = { allTextContents: vi.fn().mockResolvedValue(["Committed"]) };
        const getByRole = vi.fn((role: string) => {
            if (role === "textbox") return commandInput;
            if (role === "option") return option;
            return alerts;
        });
        const page = { keyboard, getByRole } as unknown as Page;
        const workbench = new Workbench(page);

        await workbench.runCommand("View: Show IntelliGit");
        // Two presses, not one. A `runCommand` that sends the chord once and then waits gives up on
        // exactly the dropped first chord that took four flow rows red on Linux, so counting the
        // presses is the assertion -- checking only that *a* press happened stays green through it.
        expect(keyboard.press).toHaveBeenCalledTimes(2);
        expect(keyboard.press).toHaveBeenCalledWith(expectedShortcut);
        expect(commandInput.fill).toHaveBeenCalledWith(">View: Show IntelliGit");
        expect(option.click).toHaveBeenCalledOnce();
        await expect(workbench.readVisibleNotifications()).resolves.toEqual(["Committed"]);
    });

    it("gives up after a bounded number of chords and rethrows Playwright's own error", async () => {
        // Retrying is only safe if it still fails loudly: an unbounded loop would burn the test's
        // whole budget and report a timeout naming nothing.
        const timeout = new Error("locator.waitFor: Timeout 3000ms exceeded");
        const keyboard = { press: vi.fn() };
        const commandInput = { fill: vi.fn(), waitFor: vi.fn().mockRejectedValue(timeout) };
        const page = { keyboard, getByRole: () => commandInput } as unknown as Page;

        await expect(new Workbench(page).runCommand("View: Show IntelliGit")).rejects.toBe(timeout);
        expect(keyboard.press).toHaveBeenCalledTimes(5);
        expect(commandInput.fill).not.toHaveBeenCalled();
    });

    // Declared after the tests that mock the platform getter, which is the only position from
    // which it can observe a spy outliving its own test. `process` is shared by every file a
    // worker runs, so an unrestored getter is not confined to this suite -- it decides what a
    // later, unrelated file sees, and only when the run order happens to place it downstream.
    it("leaves the real platform in place for the tests that follow", () => {
        expect(process.platform).toBe(REAL_PLATFORM);
    });

    describe("checkoutBranch", () => {
        /** A branch menu that answers only the names a `folder/leaf` checkout is allowed to ask for. */
        function branchMenu(): {
            frame: FrameLocator;
            folder: { click: ReturnType<typeof vi.fn> };
            leaf: { click: ReturnType<typeof vi.fn> };
            menuItem: { click: ReturnType<typeof vi.fn> };
        } {
            const folder = { click: vi.fn(), getAttribute: vi.fn().mockResolvedValue("true") };
            const leaf = { click: vi.fn() };
            const menuItem = { click: vi.fn() };
            const getByRole = vi.fn((role: string, options: { name: string }) => {
                if (role === "menuitem") return menuItem;
                if (options.name === "folder") return folder;
                if (options.name === "leaf") return leaf;
                throw new Error(
                    `the page object asked for an unmodelled branch item: ${options.name}`,
                );
            });
            return { frame: { getByRole } as unknown as FrameLocator, folder, leaf, menuItem };
        }

        it("opens the checkout menu on the leaf of a folder-qualified branch", async () => {
            const { frame, leaf, menuItem } = branchMenu();

            await new Workbench({} as unknown as Page).checkoutBranch(frame, "folder/leaf");

            expect(leaf.click).toHaveBeenCalledWith({ button: "right" });
            expect(menuItem.click).toHaveBeenCalledOnce();
        });

        // "a/b/c" is the case that motivates this: a plain destructure takes folder "a" and leaf
        // "b", the guard sees two defined strings, and the flow right-clicks a branch the caller
        // never named. Every rejection is asserted to have driven no UI at all, because throwing
        // after the wrong branch was already clicked is the same defect wearing an error message.
        it.each([["a/b/c"], ["leaf"], ["/leaf"], ["folder/"], [""]])(
            "refuses %o rather than checking out a truncation of it",
            async (branchName) => {
                const { frame, folder, leaf, menuItem } = branchMenu();

                await expect(
                    new Workbench({} as unknown as Page).checkoutBranch(frame, branchName),
                ).rejects.toThrow(/folder\/leaf/);

                expect(folder.click).not.toHaveBeenCalled();
                expect(leaf.click).not.toHaveBeenCalled();
                expect(menuItem.click).not.toHaveBeenCalled();
            },
        );
    });
});

describe("IntelliGitView", () => {
    const SIDEBAR_MARKER = '[data-testid="commit-panel-tab-row"]';
    const GRAPH_PANEL_MARKER = '[data-testid="commit-list-viewport"]';

    /** `[data-testid="x"]` -> `x`, so a fake body can carry the ids its selectors ask for. */
    function testIdOf(selector: string): string {
        return selector.replace('[data-testid="', "").replace('"]', "");
    }

    /** One fake webview whose document answers `count()` only for the markers it renders.
     * `undefined` markers model a frame whose document is unreachable (still loading, or already
     * disposed), which makes `count()` and `evaluate()` reject exactly as Playwright's do. */
    function webview(
        markers: readonly string[] | undefined,
        title = "IntelliGit",
    ): {
        outer: unknown;
        inner: unknown;
    } {
        const detached = (): Promise<never> => Promise.reject(new Error("frame was detached"));
        const inner = {
            locator: (selector: string) => ({
                count: () =>
                    markers === undefined
                        ? detached()
                        : Promise.resolve(markers.includes(selector) ? 1 : 0),
                // The timeout report's page-side callback runs here against a body built from the
                // same markers, rather than against a canned result. A callback that reads a
                // property the real body does not have then fails in this suite instead of only in
                // the CI failure it is the sole diagnosis of.
                evaluate: (extract: (body: never) => unknown) =>
                    markers === undefined
                        ? detached()
                        : Promise.resolve(
                              extract({
                                  ownerDocument: { title },
                                  innerHTML: markers
                                      .map((marker) => `<div ${marker.slice(1, -1)}></div>`)
                                      .join(""),
                                  querySelectorAll: () =>
                                      markers.map((marker) => ({
                                          getAttribute: () => testIdOf(marker),
                                      })),
                              } as never),
                          ),
            }),
        };
        return {
            inner,
            outer: {
                contentFrame: () => ({
                    // Playwright's `Locator` answers `count()` on the outer frame too, and the
                    // timeout report uses it to tell "the webview shell has no content iframe yet"
                    // from "the iframe is there and its document is unreachable". A fake missing
                    // the method turns that report into a TypeError.
                    locator: (selector: string) => ({
                        count: () => Promise.resolve(selector === "iframe#active-frame" ? 1 : 0),
                        contentFrame: () =>
                            selector === "iframe#active-frame" ? inner : undefined,
                    }),
                }),
            },
        };
    }

    /**
     * A workbench holding the given webviews in DOM order, plus the activity-bar item.
     *
     * Only the two selectors the page object is supposed to use are served, and only the exact
     * "IntelliGit" label is accepted as the filter. A page object that goes back to clicking the
     * labelled anchor asks for a selector this fake does not model and gets a named failure --
     * a fake that clicked whatever it was handed would stay green through exactly the regression
     * the click target exists to prevent.
     */
    function workbenchPage(webviews: readonly { outer: unknown }[]): {
        page: Page;
        click: ReturnType<typeof vi.fn>;
    } {
        const click = vi.fn();
        const intelliGitLabel = Symbol("getByLabel(IntelliGit, { exact: true })");
        const page = {
            locator: (selector: string) => {
                if (selector === "iframe.webview") {
                    return { all: () => Promise.resolve(webviews.map((view) => view.outer)) };
                }
                if (selector === ".activitybar .action-item") {
                    return {
                        filter: ({ has }: { has: unknown }) => {
                            expect(has, "activity-bar item filtered by something else").toBe(
                                intelliGitLabel,
                            );
                            return { first: () => ({ click }) };
                        },
                    };
                }
                throw new Error(`page object asked for an unmodelled locator: ${selector}`);
            },
            getByLabel: (name: string, options?: { exact?: boolean }) => {
                expect([name, options?.exact]).toEqual(["IntelliGit", true]);
                return intelliGitLabel;
            },
            waitForTimeout: vi.fn().mockResolvedValue(undefined),
        } as unknown as Page;
        return { page, click };
    }

    // VS Code renders a view's badge as a sibling of the labelled anchor, overlapping it, so an
    // anchor-targeted click dies as `<div class="badge" ...> intercepts pointer events` and burns
    // the full timeout -- but only on a launch where the changed-file count lands before the click,
    // which is why it read as a rare dead activity-bar item rather than a selector fault.
    it("clicks the activity-bar item, so the view's own badge cannot intercept it", async () => {
        const { page, click } = workbenchPage([webview([SIDEBAR_MARKER])]);

        await new IntelliGitView(page).reveal();

        expect(click).toHaveBeenCalledOnce();
    });

    // The regression this exists for: `iframe.webview` elements are ordered by creation, so the
    // graph panel can precede the sidebar. A positional page object returns the graph document for
    // `reveal()` and the sidebar document for `revealPanel()` -- both silently, both wrong.
    it("resolves each surface by what it renders, not by DOM order", async () => {
        const graphPanel = webview([GRAPH_PANEL_MARKER]);
        const sidebar = webview([SIDEBAR_MARKER]);
        const { page, click } = workbenchPage([graphPanel, sidebar]);
        const view = new IntelliGitView(page);

        await expect(view.reveal()).resolves.toBe(sidebar.inner);
        await expect(view.revealPanel()).resolves.toBe(graphPanel.inner);
        expect(click).toHaveBeenCalledOnce();
    });

    it("skips a webview whose document is unreachable instead of failing on it", async () => {
        const detached = webview(undefined);
        const sidebar = webview([SIDEBAR_MARKER]);
        const { page } = workbenchPage([detached, sidebar]);

        await expect(new IntelliGitView(page).reveal()).resolves.toBe(sidebar.inner);
    });

    // The marker alone was the whole message once, and it is the half that cannot tell "no webview
    // opened" from "a webview opened and rendered a different surface" -- distinct CI failures this
    // message is the only diagnosis of, since none of them reproduce in the pinned container. Each
    // case below pins the distinction it has to draw, so a report that degrades back to the marker
    // goes red here rather than on the next unreproducible run.
    it("names the marker it wanted and what the attached webview rendered instead", async () => {
        const { page } = workbenchPage([webview([SIDEBAR_MARKER])]);

        await expect(new IntelliGitView(page).revealPanel(50)).rejects.toThrow(
            /commit-list-viewport[\s\S]*active-frame=1[\s\S]*testIds=\["commit-panel-tab-row"\]/,
        );
    });

    it("distinguishes a webview whose document never became reachable", async () => {
        const { page } = workbenchPage([webview(undefined)]);

        await expect(new IntelliGitView(page).revealPanel(50)).rejects.toThrow(
            /active-frame=1 document=<unreachable>/,
        );
    });

    it("distinguishes a workbench that attached no webview at all", async () => {
        const { page } = workbenchPage([]);

        await expect(new IntelliGitView(page).revealPanel(50)).rejects.toThrow("(none attached)");
    });
});

describe("ChangesPanel", () => {
    it("anchors rows to accessible checkboxes and drives the commit form", async () => {
        const row = {} as Locator;
        const titledRows = { first: vi.fn().mockReturnValue(row) };
        const checkbox = {
            first: vi.fn().mockReturnValue({ check: vi.fn().mockResolvedValue(undefined) }),
        };
        const textbox = { fill: vi.fn().mockResolvedValue(undefined) };
        const button = { click: vi.fn().mockResolvedValue(undefined) };
        const frame = {
            getByTitle: vi.fn().mockReturnValue(titledRows),
            getByRole: vi.fn((role: string) => {
                if (role === "checkbox") return checkbox;
                if (role === "textbox") return textbox;
                return button;
            }),
        } as unknown as FrameLocator;
        const panel = new ChangesPanel(frame);

        expect(panel.changedFileRow("mutable.txt")).toBe(row);
        await panel.stagePath("mutable.txt");
        await panel.typeCommitMessage("commit message");
        await panel.commit();

        expect(titledRows.first).toHaveBeenCalledOnce();
        expect(checkbox.first).toHaveBeenCalledOnce();
        expect(textbox.fill).toHaveBeenCalledWith("commit message");
        expect(button.click).toHaveBeenCalledOnce();
    });
});
