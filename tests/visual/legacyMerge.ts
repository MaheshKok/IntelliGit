import type { Page } from "@playwright/test";
import conflict from "./fixtures/merge-editor/conflicted.json";

/** Exercises the retained Shelf renderer with the established multi-hunk merge corpus. */
export async function mountLegacyMerge(
    mountHarness: (
        context: "shelf-conflict-editor",
        options?: { webviewFixture?: string; locale?: string },
    ) => Promise<unknown>,
    page: Page,
    locale = "en",
): Promise<void> {
    await mountHarness("shelf-conflict-editor", { locale });
    const { workbench: _workbench, ...data } = conflict.messages[0].message.data;
    await page.evaluate(
        (payload) =>
            window.dispatchEvent(
                new MessageEvent("message", {
                    data: { type: "setConflictData", data: { ...payload, sessionKind: "shelf" } },
                }),
            ),
        data,
    );
    await page.locator(".merge-editor").waitFor();
}
