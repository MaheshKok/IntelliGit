import type { FrameLocator, Locator, Page } from "@playwright/test";
import { describe, expect, it, vi } from "vitest";

import { ChangesPanel } from "../../e2e/pageObjects/changesPanel";
import { IntelliGitView } from "../../e2e/pageObjects/intelliGitView";
import { Workbench } from "../../e2e/pageObjects/workbench";

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
});

describe("IntelliGitView", () => {
    const SIDEBAR_MARKER = '[data-testid="commit-panel-tab-row"]';
    const GRAPH_PANEL_MARKER = '[data-testid="commit-list-viewport"]';

    /** One fake webview whose document answers `count()` only for the markers it renders.
     * `undefined` markers model a frame whose document is unreachable (still loading, or already
     * disposed), which makes `count()` reject exactly as Playwright's does. */
    function webview(markers: readonly string[] | undefined): {
        outer: unknown;
        inner: unknown;
    } {
        const inner = {
            locator: (selector: string) => ({
                count: () =>
                    markers === undefined
                        ? Promise.reject(new Error("frame was detached"))
                        : Promise.resolve(markers.includes(selector) ? 1 : 0),
            }),
        };
        return {
            inner,
            outer: {
                contentFrame: () => ({
                    locator: (selector: string) => ({
                        contentFrame: () =>
                            selector === "iframe#active-frame" ? inner : undefined,
                    }),
                }),
            },
        };
    }

    /** A workbench holding the given webviews in DOM order, plus the activity-bar item. */
    function workbenchPage(webviews: readonly { outer: unknown }[]): {
        page: Page;
        click: ReturnType<typeof vi.fn>;
    } {
        const click = vi.fn();
        const page = {
            locator: (selector: string) =>
                selector === "iframe.webview"
                    ? { all: () => Promise.resolve(webviews.map((view) => view.outer)) }
                    : {
                          getByLabel: vi.fn().mockReturnValue({
                              first: vi.fn().mockReturnValue({ click }),
                          }),
                      },
            waitForTimeout: vi.fn().mockResolvedValue(undefined),
        } as unknown as Page;
        return { page, click };
    }

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

    it("reports the marker it was waiting for when no webview ever renders it", async () => {
        const { page } = workbenchPage([webview([SIDEBAR_MARKER])]);

        await expect(new IntelliGitView(page).revealPanel(50)).rejects.toThrow(GRAPH_PANEL_MARKER);
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
