import type { Page } from "@playwright/test";

export type ResetMode = "soft" | "mixed" | "hard" | "merge" | "keep";

/** Waits for the reset-mode prompt, rather than VS Code's reused target input. */
export async function selectResetMode(page: Page, mode: ResetMode): Promise<void> {
    const picker = page.locator(".quick-input-widget:visible");
    await picker.locator(".quick-input-title").getByText("Reset", { exact: true }).waitFor({
        state: "visible",
    });
    // Target validation is asynchronous. Never type into the old input or accept the default
    // selection while it is closing: the requested mode must exist in this prompt before clicking.
    await picker
        .getByRole("option")
        .filter({ has: page.getByText(mode, { exact: true }) })
        .click();
}

/** Clears only observed stash-success messages through VS Code's ordinary notification UI. */
export async function dismissStashSuccessNotifications(page: Page): Promise<void> {
    await page.getByRole("button", { name: "Notifications", exact: true }).click();
    const center = page.locator(".notifications-center");
    await center.waitFor({ state: "visible" });
    // The center retains notifications without the toast's auto-hide race. Leave errors and
    // warnings intact so clearing a success from an earlier operation cannot hide a new failure.
    const successes = center.locator(".notification-list-item").filter({
        has: page.locator(".notification-list-item-message").filter({
            hasText:
                /^IntelliGit: Stash applied(?:\. The stash was kept\.| and removed\.| on branch .+ and removed\.)$/,
        }),
    });
    while ((await successes.count()) > 0) {
        const notification = successes.first();
        await notification.hover();
        await notification.getByRole("button", { name: "Clear Notification", exact: true }).click();
    }
    await page.keyboard.press("Escape");
    await center.waitFor({ state: "hidden" });
}
