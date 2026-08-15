import type { FrameLocator, Page } from "@playwright/test";

import enCatalog from "../../../src/webviews/i18n/en.json";

/** How many times the command-palette chord is sent before giving up, and how long each wait is. */
const PALETTE_ATTEMPTS = 5;
const PALETTE_TIMEOUT_MS = 3_000;

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
        await this.page.getByRole("option", { name: label }).click();
    }

    /** Checks out a visible local branch through IntelliGit's branch webview menu. */
    public async checkoutBranch(frame: FrameLocator, branchName: string): Promise<void> {
        const [folderName, leafName] = branchName.split("/");
        if (folderName === undefined || leafName === undefined) {
            throw new Error(`Expected a folder-qualified branch name, got "${branchName}".`);
        }

        const folder = frame.getByRole("button", { name: folderName, exact: true });
        if ((await folder.getAttribute("aria-expanded")) !== "true") {
            await folder.click();
        }
        await frame
            .getByRole("button", { name: leafName, exact: true })
            .click({ button: "right" });
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
