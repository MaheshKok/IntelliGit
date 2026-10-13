import type { Page } from "@playwright/test";
import { describe, expect, it, vi } from "vitest";
import {
    dismissStashSuccessNotifications,
    selectResetMode,
} from "../../e2e/pageObjects/nativeGitControls";

describe("selectResetMode", () => {
    it("waits for the mode prompt before clicking an exact mode, even while the target input survives", async () => {
        const ready = Promise.withResolvers<void>();
        const title = { waitFor: vi.fn(() => ready.promise) };
        const titleContainer = { getByText: vi.fn(() => title) };
        const modeText = {};
        const mode = { click: vi.fn() };
        const options = { filter: vi.fn(() => mode) };
        const picker = {
            locator: vi.fn(() => titleContainer),
            getByRole: vi.fn(() => options),
        };
        const page = {
            locator: vi.fn(() => picker),
            getByText: vi.fn(() => modeText),
        } as unknown as Page;
        const selection = selectResetMode(page, "merge");
        expect(title.waitFor).toHaveBeenCalledWith({ state: "visible" });
        expect(mode.click).not.toHaveBeenCalled();
        ready.resolve();
        await selection;
        expect(page.locator).toHaveBeenCalledWith(".quick-input-widget:visible");
        expect(picker.locator).toHaveBeenCalledWith(".quick-input-title");
        expect(titleContainer.getByText).toHaveBeenCalledWith("Reset", { exact: true });
        expect(page.getByText).toHaveBeenCalledWith("merge", { exact: true });
        expect(options.filter).toHaveBeenCalledWith({ has: modeText });
        expect(mode.click).toHaveBeenCalledExactlyOnceWith();
    });

    it("propagates a missing mode prompt without selecting the old input's default", async () => {
        const failure = new Error("Reset title did not appear");
        const picker = {
            locator: () => ({ getByText: () => ({ waitFor: () => Promise.reject(failure) }) }),
            getByRole: vi.fn(),
        };
        const page = { locator: () => picker } as unknown as Page;
        await expect(selectResetMode(page, "keep")).rejects.toBe(failure);
        expect(picker.getByRole).not.toHaveBeenCalled();
    });
});

describe("dismissStashSuccessNotifications", () => {
    it("clears retained success notifications through the host UI and leaves failures alone", async () => {
        const clear = { click: vi.fn() };
        const notification = { hover: vi.fn(), getByRole: vi.fn(() => clear) };
        const successes = {
            count: vi.fn().mockResolvedValueOnce(2).mockResolvedValueOnce(1).mockResolvedValue(0),
            first: vi.fn(() => notification),
        };
        const rows = { filter: vi.fn(() => successes) };
        const messages = { filter: vi.fn(() => ({})) };
        const center = { waitFor: vi.fn(), locator: vi.fn(() => rows) };
        const open = { click: vi.fn() };
        const page = {
            getByRole: vi.fn(() => open),
            locator: vi.fn((selector: string) =>
                selector === ".notifications-center" ? center : messages,
            ),
            keyboard: { press: vi.fn() },
        } as unknown as Page;
        await dismissStashSuccessNotifications(page);
        const pattern = messages.filter.mock.calls[0][0].hasText as RegExp;
        for (const message of [
            "IntelliGit: Stash applied. The stash was kept.",
            "IntelliGit: Stash applied and removed.",
            "IntelliGit: Stash applied on branch feature/native-unstash and removed.",
        ])
            expect(pattern.test(message)).toBe(true);
        expect(pattern.test("Stash failed: git stash push exited with 128")).toBe(false);
        expect(
            pattern.test(
                "IntelliGit: Stash applied, but the selected stash could not be safely removed: error",
            ),
        ).toBe(false);
        expect(open.click).toHaveBeenCalledOnce();
        expect(notification.getByRole).toHaveBeenCalledWith("button", {
            name: "Clear Notification",
            exact: true,
        });
        expect(clear.click).toHaveBeenCalledTimes(2);
        expect(clear.click.mock.calls).toEqual([[], []]);
        expect(page.keyboard.press).toHaveBeenCalledWith("Escape");
        expect(center.waitFor.mock.calls).toEqual([[{ state: "visible" }], [{ state: "hidden" }]]);
    });
});
