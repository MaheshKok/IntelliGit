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
