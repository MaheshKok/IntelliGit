// @vitest-environment jsdom
import React, { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { App } from "../../../src/webviews/react/merge-editor/MergeEditorApp";
import { mount, unmount, initReactDomTestEnvironment } from "../../helpers/reactDomTestUtils";
import { installWebviewI18n } from "../../helpers/webviewI18nTestUtils";
import { t } from "../../../src/webviews/react/shared/i18n";

const api = vi.hoisted(() => ({
    postMessage: vi.fn(),
    getState: vi.fn<() => unknown>(() => null),
    setState: vi.fn(),
}));
vi.mock("../../../src/webviews/react/shared/vscodeApi", () => ({ getVsCodeApi: () => api }));
initReactDomTestEnvironment();
installWebviewI18n();

function buttonLabelsAfter(data: { type: "loadError"; message: string; nativeMerge?: boolean }) {
    const mounted = mount(<App />);
    try {
        act(() => window.dispatchEvent(new MessageEvent("message", { data })));
        expect(mounted.container.querySelector("[role=alert]")?.textContent).toBe(data.message);
        return [...mounted.container.querySelectorAll("button")].map((b) => b.textContent);
    } finally {
        unmount(mounted.root, mounted.container);
    }
}

describe("merge editor load error", () => {
    it("offers the native merge editor only when the host can open it", () => {
        expect(
            buttonLabelsAfter({ type: "loadError", message: "boom", nativeMerge: true }),
        ).toEqual([t("merge.error.retry"), t("merge.workbench.native")]);
    });

    it("omits the native merge editor for hosts that cannot open it, such as Shelf", () => {
        expect(buttonLabelsAfter({ type: "loadError", message: "boom" })).toEqual([
            t("merge.error.retry"),
        ]);
    });
});
