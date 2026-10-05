import type { Page } from "@playwright/test";
import conflict from "./fixtures/merge-editor/conflicted.json";
import type { MergeEditorData } from "../../src/webviews/react/merge-editor/types";

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

/** Exercises the workbench through the same host context as the retained Shelf renderer. */
export async function mountWorkbenchMerge(
    mountHarness: Parameters<typeof mountLegacyMerge>[0],
    page: Page,
    data: MergeEditorData = conflict.messages[0].message.data as MergeEditorData,
): Promise<void> {
    await mountHarness("shelf-conflict-editor", { locale: "en" });
    await page.evaluate(
        (payload) =>
            window.dispatchEvent(
                new MessageEvent("message", {
                    data: { type: "setConflictData", data: payload },
                }),
            ),
        data,
    );
    await page.waitForFunction(
        () => document.querySelectorAll(".merge-content .cm-editor").length === 3,
    );
}
