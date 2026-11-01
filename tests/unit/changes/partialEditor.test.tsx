// @vitest-environment jsdom
import React, { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EditorView } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { PartialChangesApp } from "../../../src/webviews/react/partial-changes/PartialChangesApp";
import { mount, unmount, initReactDomTestEnvironment } from "../../helpers/reactDomTestUtils";
import { installWebviewI18n } from "../../helpers/webviewI18nTestUtils";
import type { PartialEditorReply } from "../../../src/webviews/protocol/changelists";
import { parseChangeDiff } from "../../../src/changes/parseDiff";

const api = vi.hoisted(() => ({
    postMessage: vi.fn(),
    getState: vi.fn(() => ({})),
    setState: vi.fn(),
}));
vi.mock("../../../src/webviews/react/shared/vscodeApi", () => ({ getVsCodeApi: () => api }));
initReactDomTestEnvironment();

const base = "one\ntwo\nthree\n";
const target = "one\nchanged\nthree\n";
const blocks = parseChangeDiff("@@ -1,3 +1,3 @@\n one\n-two\n+changed\n three\n", base, target);
const data: Extract<PartialEditorReply, { type: "partialFile" }> = {
    type: "partialFile",
    file: { snapshotId: "session", path: "test.txt", side: "working", base, blocks },
    contentId: "content",
    listId: "all",
    lists: {
        revision: 1,
        activeId: "default",
        lists: [{ id: "default", name: "Default" }],
        files: { "test.txt": "default" },
        changes: {},
    },
};

function receive(message: PartialEditorReply) {
    act(() => window.dispatchEvent(new MessageEvent("message", { data: message })));
}

beforeEach(() => {
    installWebviewI18n();
    vi.clearAllMocks();
    Object.defineProperty(Range.prototype, "getClientRects", {
        configurable: true,
        value: () => [],
    });
    Object.defineProperty(Range.prototype, "getBoundingClientRect", {
        configurable: true,
        value: () => new DOMRect(),
    });
});

describe("selected change editor protocol", () => {
    it("offers separate host-approved save export and removal actions without browser paths or bytes", () => {
        const mounted = mount(<PartialChangesApp />);
        try {
            receive({ ...data, selectedOperations: true });
            for (const [label, type] of [
                ["Save to Shelf", "saveSelection"],
                ["Save and Remove", "shelveSelection"],
                ["Rollback Selected Changes", "rollbackSelection"],
                ["Export Patch", "exportSelection"],
            ]) {
                const button = [...mounted.container.querySelectorAll("button")].find(
                    (item) => item.textContent === label,
                );
                expect(button, `${label} is a separate action`).toBeDefined();
                act(() => button!.click());
                expect(api.postMessage).toHaveBeenLastCalledWith({
                    type,
                    selection: { snapshotId: "session", lineIds: expect.any(Array) },
                });
                receive({
                    type: "partialOperationCompleted",
                    message: "Saved shelf identity",
                    removed: false,
                });
            }
            receive({
                type: "partialOperationCompleted",
                message: "Removal completed. Do not repeat.",
                removed: true,
            });
            expect(
                [...mounted.container.querySelectorAll(".partial-actions button")].every(
                    (button) => (button as HTMLButtonElement).disabled,
                ),
            ).toBe(true);
        } finally {
            unmount(mounted.root, mounted.container);
        }
    });

    it("fences a deletion-merged selection even when a pane retains the same content snapshot", () => {
        const mounted = mount(<PartialChangesApp />);
        try {
            receive(data);
            const boxes = () => [
                ...mounted.container.querySelectorAll<HTMLInputElement>(
                    ".partial-line input[type=checkbox]",
                ),
            ];
            expect(boxes().some((box) => box.checked)).toBe(true);
            receive({
                ...data,
                lists: {
                    ...data.lists,
                    changes: {
                        "test.txt": {
                            contentId: "content",
                            lines: {},
                            selections: {
                                all: {
                                    contentId: "content",
                                    lineIds: ["0:1"],
                                    total: 2,
                                    reviewRequired: true,
                                },
                            },
                        },
                    },
                },
            });
            expect(boxes()).not.toHaveLength(0);
            expect(boxes().every((box) => !box.checked)).toBe(true);
            expect(mounted.container.textContent).toContain("Partial selection needs review");
        } finally {
            unmount(mounted.root, mounted.container);
        }
    });

    it("does not apply working inclusion to a different index snapshot", () => {
        const mounted = mount(<PartialChangesApp />);
        try {
            receive({
                ...data,
                file: { ...data.file, side: "index" },
                lists: {
                    ...data.lists,
                    changes: {
                        "test.txt": {
                            contentId: "working",
                            lines: {},
                            selections: { all: { contentId: "working", lineIds: [], total: 2 } },
                        },
                    },
                },
            });
            expect(
                mounted.container.querySelector<HTMLInputElement>(
                    'input[aria-label="Include line 0:1"]',
                )!.checked,
            ).toBe(true);
            expect(mounted.container.textContent).not.toContain("Partial selection needs review");
        } finally {
            unmount(mounted.root, mounted.container);
        }
    });
    it("shows a read-only full-document preview and submits IDs rather than a browser patch", () => {
        const mounted = mount(<PartialChangesApp />);
        try {
            receive(data);
            const toggle = mounted.container.querySelector<HTMLButtonElement>(
                'button[aria-label="Show selection preview"]',
            )!;
            expect(mounted.container.querySelector(".cm-editor")).toBeNull();
            expect(toggle.getAttribute("aria-pressed")).toBe("false");
            act(() => toggle.click());
            expect(toggle.getAttribute("aria-pressed")).toBe("true");
            const editor = EditorView.findFromDOM(
                mounted.container.querySelector<HTMLElement>(".cm-editor")!,
            )!;
            expect(editor.state.facet(EditorState.readOnly)).toBe(true);
            expect(editor.state.doc.toString()).toBe(target);
            const button = [
                ...mounted.container.querySelectorAll<HTMLButtonElement>("button"),
            ].find((element) => element.textContent === "Stage selected")!;
            act(() => button.click());
            expect(api.postMessage).toHaveBeenLastCalledWith({
                type: "stageSelection",
                selection: { snapshotId: "session", lineIds: ["0:1", "0:2"] },
            });
        } finally {
            unmount(mounted.root, mounted.container);
        }
    });

    it("reopens with the preview shown when the pane last left it open", () => {
        api.getState.mockReturnValue({ showPreview: true });
        const mounted = mount(<PartialChangesApp />);
        try {
            receive(data);
            expect(mounted.container.querySelector(".cm-editor")).not.toBeNull();
        } finally {
            unmount(mounted.root, mounted.container);
            api.getState.mockReturnValue({});
        }
    });

    it("keeps the shown preview rendering when a reload drops previously selected IDs", () => {
        api.getState.mockReturnValue({ showPreview: true });
        const mounted = mount(<PartialChangesApp />);
        try {
            receive(data);
            // Staging reloads the same file with a new snapshot whose only change is a pure addition.
            const added = "one\ntwo\nthree\nfour\n";
            receive({
                ...data,
                file: {
                    ...data.file,
                    blocks: parseChangeDiff("@@ -3,0 +4 @@\n+four\n", base, added),
                },
                contentId: "reloaded",
            });
            const editor = mounted.container.querySelector<HTMLElement>(".cm-editor");
            expect(editor, "the preview survives the reload").not.toBeNull();
            expect(EditorView.findFromDOM(editor!)!.state.doc.toString()).toBe(added);
        } finally {
            unmount(mounted.root, mounted.container);
            api.getState.mockReturnValue({});
        }
    });

    // A failed reply leaves the status to operationMessage alone, so it isolates the reset at operation start.
    it.each([
        ["Stage selected", "stageSelection"],
        ["Save to Shelf", "saveSelection"],
    ])("drops the previous result from the status when %s starts", (label, type) => {
        const mounted = mount(<PartialChangesApp />);
        const status = () => mounted.container.querySelector('[role="status"]')?.textContent;
        try {
            receive({ ...data, selectedOperations: true });
            receive({ type: "partialOperationCompleted", message: "Shelved A", removed: false });
            expect(status()).toBe("Shelved A");
            const button = [...mounted.container.querySelectorAll("button")].find(
                (item) => item.textContent === label,
            )!;
            act(() => button.click());
            expect(api.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ type }));
            receive({ type: "partialError", message: "failed" });
            expect(status(), "the earlier result is not announced again").toBe("");
        } finally {
            unmount(mounted.root, mounted.container);
        }
    });

    it("does not carry the previous result over to a newly loaded file", () => {
        const mounted = mount(<PartialChangesApp />);
        const status = () => mounted.container.querySelector('[role="status"]')?.textContent;
        try {
            receive({ ...data, selectedOperations: true });
            receive({ type: "partialOperationCompleted", message: "Shelved A", removed: false });
            expect(status()).toBe("Shelved A");
            receive({ ...data, contentId: "reloaded" });
            expect(status(), "the earlier result is not announced again").toBe("");
        } finally {
            unmount(mounted.root, mounted.container);
        }
    });

    // A failed load answers with partialError instead of partialFile, so only the reset at load start can clear it.
    it.each([
        [
            "switching the source",
            (container: HTMLElement) => {
                const select = container.querySelector<HTMLSelectElement>(
                    'select[aria-label="Change source"]',
                )!;
                select.value = "index";
                select.dispatchEvent(new Event("change", { bubbles: true }));
            },
            "index",
        ],
        [
            "reloading",
            (container: HTMLElement) =>
                container
                    .querySelector<HTMLButtonElement>('button[aria-label="Reload changes"]')!
                    .click(),
            "working",
        ],
    ])("drops the previous result from the status when %s fails", (_label, start, side) => {
        const mounted = mount(<PartialChangesApp />);
        const status = () => mounted.container.querySelector('[role="status"]')?.textContent;
        try {
            receive({ ...data, selectedOperations: true });
            receive({ type: "partialOperationCompleted", message: "Shelved A", removed: false });
            expect(status()).toBe("Shelved A");
            act(() => start(mounted.container));
            expect(api.postMessage).toHaveBeenLastCalledWith({ type: "ready", side });
            receive({ type: "partialError", message: "failed" });
            expect(status(), "the earlier result is not announced again").toBe("");
        } finally {
            unmount(mounted.root, mounted.container);
        }
    });

    it("retains selection after an error and initializes an expired persisted inclusion as empty", () => {
        const mounted = mount(<PartialChangesApp />);
        try {
            receive({
                ...data,
                lists: {
                    ...data.lists,
                    changes: {
                        "test.txt": {
                            contentId: "content",
                            lines: {},
                            selections: { all: { contentId: "older", lineIds: ["0:1"], total: 2 } },
                        },
                    },
                },
            });
            expect(
                mounted.container.querySelector<HTMLInputElement>(
                    'input[aria-label="Include line 0:1"]',
                )!.checked,
            ).toBe(false);
            receive({ type: "partialError", message: "stale index" });
            expect(mounted.container.querySelector('[role="alert"]')?.textContent).toBe(
                "stale index",
            );
            expect(
                mounted.container.querySelector<HTMLInputElement>(
                    'input[aria-label="Include line 0:1"]',
                )!.checked,
            ).toBe(false);
        } finally {
            unmount(mounted.root, mounted.container);
        }
    });
});
