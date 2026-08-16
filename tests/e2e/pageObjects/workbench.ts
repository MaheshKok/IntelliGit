import type { FrameLocator, Page } from "@playwright/test";

import enCatalog from "../../../src/webviews/i18n/en.json";

/** How many times the command-palette chord is sent before giving up, and how long each wait is. */
const PALETTE_ATTEMPTS = 5;
const PALETTE_TIMEOUT_MS = 3_000;

/** How many quick-pick entries a failure message lists before summarising the rest as a count. */
const QUICK_PICK_REPORT_LIMIT = 8;

/** Workbench-level actions shared by the flow page objects. */
export class Workbench {
    public constructor(private readonly page: Page) {}

    /**
     * Opens the keyboard-driven command palette and executes the item with the given label.
     *
     * The chord is re-sent until the palette answers, because VS Code drops the very first one on a
     * cold window. Measured in the pinned Linux container: the palette does not open on press #1 and
     * does on press #2, while `document.hasFocus()` already reports `true` before press #1 -- so
     * this is the workbench's keybinding dispatch not being live yet, not the window lacking focus,
     * and neither `page.bringToFront()` nor a main-process `win.focus()` changes it. macOS is fast
     * enough to hide the window entirely; under Xvfb on emulated amd64 it cost four flow rows.
     * Re-sending is safe: the chord runs "Show All Commands", which re-opens an open palette rather
     * than toggling it shut.
     */
    public async runCommand(label: string): Promise<void> {
        const modifier = process.platform === "darwin" ? "Meta" : "Control";
        const commandInput = this.page.getByRole("textbox", {
            name: "Type the name of a command to run.",
        });

        for (let attempt = 1; ; attempt++) {
            await this.page.keyboard.press(`${modifier}+Shift+P`);
            try {
                await commandInput.waitFor({ state: "visible", timeout: PALETTE_TIMEOUT_MS });
                break;
            } catch (error) {
                // Rethrow Playwright's own error on the last attempt: it names the locator it was
                // waiting for, which a hand-written message would throw away.
                if (attempt === PALETTE_ATTEMPTS) throw error;
            }
        }

        await commandInput.fill(`>${label}`);
        await this.pickQuickPick(label);
    }

    /** Selects a visible command-palette quick-pick item by its accessible name. */
    public async pickQuickPick(label: string): Promise<void> {
        try {
            await this.page.getByRole("option", { name: label }).click();
        } catch (error) {
            // A bare `waiting for getByRole('option')` timeout cannot separate the two causes,
            // and they have opposite fixes: a label this page object spelled wrong, versus a
            // command VS Code does not know yet. What the palette IS offering says which --
            // its own entries mean the label is wrong, while VS Code's zero-match "similar
            // commands" fallback means the contribution has not registered. Measured on CI run
            // 31942358546, where the bare timeout named only the locator and cost two
            // diagnosis passes that had to go to the screenshot for what this line now says.
            throw new Error(
                `Command palette never offered "${label}". It offered: ` +
                    `${await this.describeQuickPickOptions()}. Original failure: ` +
                    `${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }

    /**
     * Lists the quick-pick entries currently on screen, for a failure message.
     *
     * Never throws: this runs only on a path that is already failing, and a second failure here
     * would replace the timeout that is the actual finding with an unrelated one.
     */
    private async describeQuickPickOptions(): Promise<string> {
        try {
            const labels = await this.page.getByRole("option").allTextContents();
            if (labels.length === 0) return "<no options>";
            const shown = labels
                .slice(0, QUICK_PICK_REPORT_LIMIT)
                .map((text) => `"${text.trim()}"`);
            const omitted = labels.length - shown.length;
            return omitted > 0 ? `${shown.join(", ")} (+${omitted} more)` : shown.join(", ");
        } catch (error) {
            return `<unreadable: ${error instanceof Error ? error.message : String(error)}>`;
        }
    }

    /** Checks out a visible local branch through IntelliGit's branch webview menu. */
    public async checkoutBranch(frame: FrameLocator, branchName: string): Promise<void> {
        // Split at the first separator only. `"a/b/c".split("/")` destructures to folder `a` and
        // leaf `b`, which satisfies a presence check and then right-clicks a branch nobody named --
        // a wrong checkout reported as a passing flow. The menu this drives renders exactly one
        // folder level, so a deeper name is unsupported and has to say so rather than be truncated
        // into a name that happens to exist.
        const separatorIndex = branchName.indexOf("/");
        const folderName = branchName.slice(0, separatorIndex);
        const leafName = branchName.slice(separatorIndex + 1);
        if (separatorIndex <= 0 || leafName === "" || leafName.includes("/")) {
            throw new Error(
                `Expected a branch name of the form "folder/leaf", got "${branchName}".`,
            );
        }

        const folder = frame.getByRole("button", { name: folderName, exact: true });
        if ((await folder.getAttribute("aria-expanded")) !== "true") {
            await folder.click();
        }
        await frame.getByRole("button", { name: leafName, exact: true }).click({ button: "right" });
        // Named, never `.first()`: the checkout entry only happens to top this menu while the
        // worktree items above it are empty (`branch-column/menu.ts`). Should one ever appear and
        // also check the branch out, `.first()` would go green without exercising checkout at all.
        await frame
            .getByRole("menuitem", { name: enCatalog["branch.menu.checkout"], exact: true })
            .click();
    }

    /** Returns the currently visible workbench notification messages. */
    public async readVisibleNotifications(): Promise<readonly string[]> {
        return this.page.getByRole("alert").allTextContents();
    }
}
