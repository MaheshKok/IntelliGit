import type { FrameLocator, Locator, Page } from "@playwright/test";

/** A marker that appears in exactly one IntelliGit webview document, used to tell the surfaces
 * apart by what they render rather than by where they sit in the DOM. */
const SIDEBAR_MARKER = '[data-testid="commit-panel-tab-row"]';
const GRAPH_PANEL_MARKER = '[data-testid="commit-list-viewport"]';

/** How long a surface may take to render its marker before `reveal`/`revealPanel` give up. */
const DEFAULT_REVEAL_TIMEOUT_MS = 30_000;

/** Gap between retries while a surface is still rendering. */
const REVEAL_POLL_INTERVAL_MS = 250;

/** Locates IntelliGit's webview surfaces: the activity-bar view and the full-width graph panel. */
export class IntelliGitView {
    public constructor(private readonly page: Page) {}

    /** Reveals IntelliGit in the sidebar and returns its webview document. */
    public async reveal(timeoutMs = DEFAULT_REVEAL_TIMEOUT_MS): Promise<FrameLocator> {
        await this.page
            .locator(".activitybar")
            .getByLabel("IntelliGit", { exact: true })
            .first()
            .click();
        return this.frameOwning(SIDEBAR_MARKER, timeoutMs);
    }

    /** Returns the full-width commit-graph panel's webview document. The caller opens the panel
     * first (`IntelliGit: Show Git Log`). */
    public async revealPanel(timeoutMs = DEFAULT_REVEAL_TIMEOUT_MS): Promise<FrameLocator> {
        return this.frameOwning(GRAPH_PANEL_MARKER, timeoutMs);
    }

    /**
     * Resolves the IntelliGit webview whose document renders `marker`, retrying while the workbench
     * finishes rendering it.
     *
     * Positional selectors are deliberately absent. `iframe.webview` elements are ordered by when
     * VS Code created them, not by which surface they host, so `.first()` meant "the sidebar" only
     * while the sidebar was the sole open webview: a row that opens the graph panel before revealing
     * the sidebar silently swaps the two, and every locator then resolves against the wrong document
     * while still reading as a correct page object.
     */
    private async frameOwning(marker: string, timeoutMs: number): Promise<FrameLocator> {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
            const match = await this.findFrame(marker);
            if (match) return match;
            if (Date.now() > deadline) {
                throw new Error(
                    `No IntelliGit webview rendered "${marker}" within ${timeoutMs}ms.`,
                );
            }
            await this.page.waitForTimeout(REVEAL_POLL_INTERVAL_MS);
        }
    }

    /** Returns the first currently-attached webview document containing `marker`, if any. */
    private async findFrame(marker: string): Promise<FrameLocator | undefined> {
        const outerFrames: Locator[] = await this.page.locator("iframe.webview").all();
        for (const outerFrame of outerFrames) {
            const inner = outerFrame.contentFrame().locator("iframe#active-frame").contentFrame();
            // A webview still loading (or already disposed) makes its document unreachable rather
            // than empty, so an unreachable frame is "not this one", never a hard failure.
            const count = await inner
                .locator(marker)
                .count()
                .catch(() => 0);
            if (count > 0) return inner;
        }
        return undefined;
    }
}
