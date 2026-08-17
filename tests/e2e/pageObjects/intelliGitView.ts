import type { FrameLocator, Locator, Page } from "@playwright/test";

/** A marker that appears in exactly one IntelliGit webview document, used to tell the surfaces
 * apart by what they render rather than by where they sit in the DOM. */
const SIDEBAR_MARKER = '[data-testid="commit-panel-tab-row"]';
const GRAPH_PANEL_MARKER = '[data-testid="commit-list-viewport"]';

/** How long a surface may take to render its marker before `reveal`/`revealPanel` give up. */
const DEFAULT_REVEAL_TIMEOUT_MS = 30_000;

/** Gap between retries while a surface is still rendering. */
const REVEAL_POLL_INTERVAL_MS = 250;

/**
 * The activity-bar entry as a whole, rather than the labelled anchor inside it.
 *
 * VS Code renders a view's `badge` as a `<div class="badge">` that is a SIBLING of that anchor and
 * overlaps it, so once IntelliGit reports a changed-file count the badge owns the anchor's centre
 * point. Playwright then refuses to click -- the hit element is neither the target nor a descendant
 * of it -- and retries until the timeout:
 *
 *     <div class="badge" aria-label="IntelliGit - 5 changed files">…</div> intercepts pointer events
 *
 * The badge appears only once the extension has finished counting, so an anchor-targeted click is a
 * race against startup that reads as a dead activity-bar item when it loses. Clicking the item makes
 * the badge a descendant of the target, which both satisfies the check and matches what a user does
 * -- the badge is decoration inside the button, and clicking it has always opened the view.
 */
const ACTIVITY_BAR_ITEM = ".activitybar .action-item";

/** How many console lines the timeout message may carry. The workbench is chatty, so keeping every
 * message would evict the interesting one long before the failure; the trail keeps errors and
 * warnings only, and `consoleSeen` accounts for the rest. */
const CONSOLE_TRAIL_LIMIT = 25;

/** How much of one console line survives into the message. A stack trace pasted whole would push
 * every other line out of a bounded trail. */
const CONSOLE_LINE_LIMIT = 300;

/** Webview documents are served from this scheme, so a console message's source URL says whether it
 * came from a webview or from the workbench shell around it. */
const WEBVIEW_URL_SCHEME = "vscode-webview://";

/** Locates IntelliGit's webview surfaces: the activity-bar view and the full-width graph panel. */
export class IntelliGitView {
    /** Errors and warnings the page emitted, newest last. See `describeConsole`. */
    private consoleTrail: readonly string[] = [];

    /** How many console messages arrived at all, and how many of those came from a webview
     * document. These are the instrument's own proof -- see `describeConsole`. */
    private consoleSeen = 0;
    private webviewConsoleSeen = 0;

    public constructor(private readonly page: Page) {
        page.on("console", (message) => {
            const fromWebview = message.location().url.startsWith(WEBVIEW_URL_SCHEME);
            this.consoleSeen += 1;
            if (fromWebview) this.webviewConsoleSeen += 1;
            const type = message.type();
            if (type !== "error" && type !== "warning") return;
            this.record(`${type}${fromWebview ? "(webview)" : ""}: ${message.text()}`);
        });
        page.on("pageerror", (error) => this.record(`pageerror: ${error.message}`));
    }

    /** Appends `line` to the trail, keeping the newest `CONSOLE_TRAIL_LIMIT` entries. */
    private record(line: string): void {
        const bounded =
            line.length > CONSOLE_LINE_LIMIT ? `${line.slice(0, CONSOLE_LINE_LIMIT)}…` : line;
        this.consoleTrail = [...this.consoleTrail, bounded].slice(-CONSOLE_TRAIL_LIMIT);
    }

    /** Reveals IntelliGit in the sidebar and returns its webview document. */
    public async reveal(timeoutMs = DEFAULT_REVEAL_TIMEOUT_MS): Promise<FrameLocator> {
        await this.page
            .locator(ACTIVITY_BAR_ITEM)
            .filter({ has: this.page.getByLabel("IntelliGit", { exact: true }) })
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
                    `No IntelliGit webview rendered "${marker}" within ${timeoutMs}ms.\n` +
                        `  webviews present:\n  ${await this.describeWebviews()}\n` +
                        `  console: ${this.describeConsole()}`,
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

    /**
     * Summarizes every attached webview, for the timeout message only.
     *
     * "No webview rendered the marker" is true of a workbench that opened no webview at all, of
     * one whose document is still loading, and of one that mounted and rendered an empty state --
     * three different bugs that a bare not-found message reports identically. A CI-only failure
     * with no local reproduction is diagnosed from this line or not at all, so it names what each
     * webview actually is: whether the inner document exists, how much it rendered, and the test
     * ids it does carry.
     *
     * `bodyChars` alone could not separate the two failures that matter most here. The shell HTML
     * is ~31KB of inline i18n bootstrap on its own, so "the bundle never executed" and "the bundle
     * mounted and rendered nothing identifiable" both report a five-digit `bodyChars` and an empty
     * `testIds`, and telling them apart took measuring the empty shell in a separate unit test.
     * `root` and `bootstrap` answer it in the failure message itself: `bootstrap` is the inline
     * script the shell always emits, and `root` is what the React bundle put under `#root`, so
     * `bootstrap=yes root=<children:0 …>` is a bundle that never ran while `children:2` with no
     * test ids is an app that mounted and was never given anything to show.
     */
    private async describeWebviews(): Promise<string> {
        const outerFrames: Locator[] = await this.page.locator("iframe.webview").all();
        if (outerFrames.length === 0) return "(none attached)";
        const described = await Promise.all(
            outerFrames.map(async (outerFrame, index) => {
                const outer = outerFrame.contentFrame();
                const activeFrames = await outer
                    .locator("iframe#active-frame")
                    .count()
                    .catch(() => -1);
                const summary = await outer
                    .locator("iframe#active-frame")
                    .contentFrame()
                    .locator("body")
                    .evaluate((body: HTMLElement) => {
                        const document = body.ownerDocument;
                        const shellGlobals = document.defaultView as
                            | (Window & { intelligitI18n?: unknown })
                            | null;
                        const root = document.getElementById("root");
                        return {
                            title: document.title,
                            bodyChars: body.innerHTML.length,
                            rootChildren: root?.childElementCount ?? -1,
                            rootChars: root?.innerHTML.length ?? -1,
                            bootstrapped: shellGlobals?.intelligitI18n !== undefined,
                            testIds: Array.from(body.querySelectorAll("[data-testid]"))
                                .slice(0, 8)
                                .map((element) => element.getAttribute("data-testid")),
                        };
                    })
                    .catch(() => undefined);
                return summary === undefined
                    ? `#${index}: active-frame=${activeFrames} document=<unreachable>`
                    : `#${index}: active-frame=${activeFrames} title=${JSON.stringify(summary.title)} ` +
                          `bodyChars=${summary.bodyChars} ` +
                          `bootstrap=${summary.bootstrapped ? "yes" : "no"} ` +
                          `root=<children:${summary.rootChildren} chars:${summary.rootChars}> ` +
                          `testIds=${JSON.stringify(summary.testIds)}`;
            }),
        );
        return described.join("\n  ");
    }

    /**
     * Reports what the page logged, for the timeout message only.
     *
     * The commit panel fails this way while its document renders `commit-panel-awaiting-hydration`,
     * which is React's FIRST render -- so React mounted, and what did not finish is the effect that
     * acquires the VS Code API and posts `ready`. If that effect threw, the reason is a console
     * error and nothing else in the harness can see it: the retained Playwright trace carries action
     * events only, with no console stream at all.
     *
     * The counts are here because a blind listener and a quiet page produce the same empty list, and
     * a clean console is the finding that would send the next instrument elsewhere -- so it has to
     * be worth believing. `seen` proves the listener was attached and receiving; `from webviews`
     * proves it was receiving from webview documents specifically, rather than only from the
     * workbench shell around them. `from webviews: 0` means this line answers nothing.
     */
    private describeConsole(): string {
        const counts = `${this.consoleSeen} seen (${this.webviewConsoleSeen} from webviews)`;
        return this.consoleTrail.length === 0
            ? `${counts}; no errors or warnings`
            : `${counts}; ${this.consoleTrail.length} error/warning:\n    ` +
                  this.consoleTrail.join("\n    ");
    }
}
