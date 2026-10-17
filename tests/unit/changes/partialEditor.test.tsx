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
    it("keeps actions locked until the host finishes its post-operation snapshot reload", () => {
        const mounted = mount(<PartialChangesApp />);
        try {
            receive({ ...data, canShelf: true });
            const more = mounted.container.querySelector<HTMLButtonElement>(
                '[aria-label="Selected-change actions"]',
            )!;
            act(() => more.click());
            const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
                (element) => element.textContent === "Save to Shelf",
            )!;
            act(() => item.click());
            receive({ type: "partialOperationCompleted", operation: "save" });
            expect(more.disabled).toBe(true);
            receive({ ...data, canShelf: true, pending: true });
            expect(more.disabled).toBe(true);
            receive({ type: "partialReady" });
            expect(more.disabled).toBe(false);
        } finally {
            unmount(mounted.root, mounted.container);
        }
    });
    it("does not take focus back from a host picker opened by a menu action", () => {
        const mounted = mount(<PartialChangesApp />);
        const picker = document.createElement("input");
        document.body.appendChild(picker);
        try {
            receive({ ...data, canShelf: true });
            act(() =>
                mounted.container
                    .querySelector<HTMLButtonElement>('[aria-label="Selected-change actions"]')!
                    .click(),
            );
            api.postMessage.mockImplementationOnce(() => picker.focus());
            const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
                (element) => element.textContent === "Save to Shelf",
            )!;
            act(() => item.click());
            expect(document.activeElement).toBe(picker);
        } finally {
            picker.remove();
            unmount(mounted.root, mounted.container);
        }
    });

    it("requires a fresh snapshot after a successful operation whose view reload failed", () => {
        const mounted = mount(<PartialChangesApp />);
        try {
            receive({ ...data, canShelf: true });
            receive({ type: "partialOperationCompleted", operation: "rollback" });
            receive({
                type: "partialError",
                message: "Operation completed; reload required.",
                reloadRequired: true,
            });
            receive({ type: "partialReady" });
            expect(
                mounted.container.querySelector<HTMLButtonElement>(
                    '[aria-label="Selected-change actions"]',
                )!.disabled,
            ).toBe(true);
            const reload = mounted.container.querySelector<HTMLButtonElement>(
                '[aria-label="Reload changes"]',
            )!;
            expect(reload.disabled).toBe(false);
            receive({ ...data, file: { ...data.file, snapshotId: "fresh" } });
            expect(
                mounted.container.querySelector<HTMLButtonElement>(
                    '[aria-label="Selected-change actions"]',
                )!.disabled,
            ).toBe(false);
        } finally {
            unmount(mounted.root, mounted.container);
        }
    });
    it.each([
        ["export", "Export selected patch..."],
        ["save", "Save to Shelf"],
        ["shelve", "Shelve selected changes..."],
        ["rollback", "Rollback selected changes..."],
    ])(
        "sends only host identities for %s and retains the selection after native cancellation",
        (operation, label) => {
            const mounted = mount(<PartialChangesApp />);
            try {
                receive({ ...data, canShelf: true });
                act(() =>
                    mounted.container
                        .querySelector<HTMLButtonElement>('[aria-label="Selected-change actions"]')!
                        .click(),
                );
                const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
                    (element) => element.textContent === label,
                )!;
                expect(item).toBeDefined();
                act(() => item.click());
                expect(api.postMessage).toHaveBeenLastCalledWith({
                    type: "selectedOperation",
                    operation,
                    selection: { snapshotId: "session", lineIds: ["0:1", "0:2"] },
                });
                receive({ type: "partialCanceled" });
                receive({ type: "partialReady" });
                expect(
                    mounted.container.querySelector<HTMLButtonElement>(
                        '[aria-label="Selected-change actions"]',
                    )!.disabled,
                ).toBe(false);
                expect(
                    [
                        ...mounted.container.querySelectorAll<HTMLInputElement>(
                            ".partial-line input",
                        ),
                    ].every((box) => box.checked),
                ).toBe(true);
            } finally {
                unmount(mounted.root, mounted.container);
            }
        },
    );

    it("disables working-tree removal for an index-side selection", () => {
        const mounted = mount(<PartialChangesApp />);
        try {
            receive({ ...data, canShelf: true, file: { ...data.file, side: "index" } });
            act(() =>
                mounted.container
                    .querySelector<HTMLButtonElement>('[aria-label="Selected-change actions"]')!
                    .click(),
            );
            for (const item of [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]) {
                const removes =
                    item.textContent?.startsWith("Shelve selected") ||
                    item.textContent?.startsWith("Rollback selected");
                expect(item.getAttribute("aria-disabled")).toBe(removes ? "true" : "false");
            }
        } finally {
            unmount(mounted.root, mounted.container);
        }
    });

    it("requires explicit amend, preloads the last message and sends no push instruction", () => {
        const mounted = mount(<PartialChangesApp />);
        try {
            receive({ ...data, lastCommitMessage: "Original message" });
            const amend = mounted.container.querySelector<HTMLInputElement>(
                'input[aria-label="Amend latest commit"]',
            )!;
            expect(amend.checked).toBe(false);
            act(() => amend.click());
            expect(mounted.container.querySelector("textarea")!.value).toBe("Original message");
            const action = [
                ...mounted.container.querySelectorAll<HTMLButtonElement>("button"),
            ].find((element) => element.textContent === "Amend selected changes")!;
            act(() => action.click());
            expect(api.postMessage).toHaveBeenLastCalledWith({
                type: "commitSelection",
                message: "Original message",
                amend: true,
                selection: { snapshotId: "session", lineIds: ["0:1", "0:2"] },
            });
            receive({ type: "partialCanceled" });
            receive({ type: "partialReady" });
            expect(amend.checked).toBe(true);
            expect(action.disabled).toBe(false);
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
