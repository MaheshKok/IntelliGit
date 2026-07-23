// @vitest-environment jsdom

import React, { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../../../src/webviews/react/merge-editor/MergeEditorApp";
import { t } from "../../../src/webviews/react/shared/i18n";
import type { MergeEditorData } from "../../../src/webviews/react/merge-editor/types";
import { initReactDomTestEnvironment, mount, unmount } from "../../helpers/reactDomTestUtils";
import { installWebviewI18n } from "../../helpers/webviewI18nTestUtils";

const vscode = vi.hoisted(() => ({
    postMessage: vi.fn(),
    getState: vi.fn(() => undefined),
    setState: vi.fn(),
}));

vi.mock("../../../src/webviews/react/shared/vscodeApi", () => ({
    getVsCodeApi: () => vscode,
}));

initReactDomTestEnvironment();

function mergeData(sessionKind?: "gitMerge" | "shelf"): MergeEditorData {
    return {
        filePath: "src/example.ts",
        segments: [],
        oursLabel: "Ours",
        theirsLabel: "Theirs",
        ...(sessionKind ? { sessionKind } : {}),
    };
}

function sendConflictData(data: MergeEditorData): void {
    act(() =>
        window.dispatchEvent(
            new MessageEvent("message", { data: { type: "setConflictData", data } }),
        ),
    );
}

function button(container: ParentNode, label: string): HTMLButtonElement {
    const found = Array.from(container.querySelectorAll("button")).find(
        (candidate) => candidate.textContent?.trim() === label,
    );
    if (!found) throw new Error(`Missing button: ${label}`);
    return found;
}

function click(element: Element): void {
    act(() => element.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

describe("MergeEditorApp session kind", () => {
    beforeEach(() => installWebviewI18n());

    it("hides git-only controls for a shelf session and closes without aborting", () => {
        const { root, container } = mount(<App />);
        sendConflictData(mergeData("shelf"));

        expect(container.textContent).not.toContain(t("mergeSession.title"));
        expect(container.textContent).not.toContain(t("merge.action.abortMerge"));

        click(button(container, t("merge.footer.useFileOurs")));
        click(button(container, t("merge.footer.apply", { resolved: 0, total: 0 })));
        click(button(container, t("common.cancel")));
        expect(vscode.postMessage).toHaveBeenCalledWith({ type: "acceptYours" });
        expect(vscode.postMessage).toHaveBeenCalledWith({ type: "applyResolution", content: "" });
        expect(vscode.postMessage).toHaveBeenCalledWith({ type: "close" });
        expect(vscode.postMessage).not.toHaveBeenCalledWith({ type: "abortMerge" });

        unmount(root, container);
    });

    it("keeps git merge controls and actions when session kind is absent", () => {
        const { root, container } = mount(<App />);
        sendConflictData(mergeData());

        click(button(container, t("mergeSession.title")));
        click(button(container, t("merge.action.abortMerge")));
        expect(vscode.postMessage).toHaveBeenCalledWith({ type: "openConflictSession" });
        expect(vscode.postMessage).toHaveBeenCalledWith({ type: "abortMerge" });

        unmount(root, container);
    });
});
