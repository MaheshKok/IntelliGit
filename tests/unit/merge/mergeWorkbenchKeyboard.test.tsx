// @vitest-environment jsdom
import React, { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorView } from "@codemirror/view";
import { undoDepth } from "@codemirror/commands";
import { MergeWorkbench } from "../../../src/webviews/react/merge-editor/MergeWorkbench";
import { workbenchHunks } from "../../../src/webviews/react/merge-editor/workbenchModel";
import { ownedLines } from "../../../src/webviews/react/merge-editor/workbenchRows";
import { parseConflictVersions, detectEolMetadata } from "../../../src/mergeEditor/conflictParser";
import { mount, unmount, initReactDomTestEnvironment } from "../../helpers/reactDomTestUtils";
import { installWebviewI18n } from "../../helpers/webviewI18nTestUtils";

const api = vi.hoisted(() => ({
    postMessage: vi.fn(),
    getState: vi.fn(() => null),
    setState: vi.fn(),
}));
vi.mock("../../../src/webviews/react/shared/vscodeApi", () => ({ getVsCodeApi: () => api }));
initReactDomTestEnvironment();

function fixture(oneSided = false) {
    const version = (side: string) =>
        [
            "head",
            ...[1, 2, 3].flatMap((n) => [`${side} ${n}a`, `${side} ${n}b`, `keep ${n}`]),
            ...(oneSided ? [side === "ours" ? "ours only" : "unchanged", "tail"] : ["tail"]),
            "",
        ].join("\n");
    const base = version("base");
    const ours = version("ours");
    const theirs = version("theirs");
    return {
        filePath: "file.ts",
        oursLabel: "ours",
        theirsLabel: "theirs",
        segments: parseConflictVersions(base, ours, theirs),
        ...detectEolMetadata(ours),
        workbench: {
            snapshotId: "b".repeat(64),
            draftKey: "mergeDraft.keyboard",
            base,
            ours,
            theirs,
            operation: "merge",
        },
    };
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
afterEach(() => {
    Reflect.deleteProperty(Range.prototype, "getClientRects");
    Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
    vi.restoreAllMocks();
});

function setup(oneSided = false) {
    const mounted = mount(<MergeWorkbench data={fixture(oneSided)} />);
    const { container } = mounted;
    const view = EditorView.findFromDOM(
        container.querySelector<HTMLElement>(".pane-result .cm-editor")!,
    )!;
    const markers = () => [...container.querySelectorAll<HTMLButtonElement>(".overview-marker")];
    return {
        ...mounted,
        view,
        markers,
        active: () =>
            markers().findIndex((marker) => marker.getAttribute("aria-current") === "true"),
        activate: (index: number) => act(() => markers()[index].click()),
        accept: (index: number) =>
            act(() =>
                container
                    .querySelectorAll<HTMLButtonElement>(".pane-ours .accept-btn")
                    [index].click(),
            ),
    };
}

function key(keyName: string, init: KeyboardEventInit = {}, target: EventTarget = document.body) {
    let accepted = false;
    act(() => {
        accepted = target.dispatchEvent(
            new KeyboardEvent("keydown", {
                key: keyName,
                bubbles: true,
                cancelable: true,
                ...init,
            }),
        );
    });
    return accepted;
}
function hunkText(view: EditorView, index: number) {
    const hunk = view.state.field(workbenchHunks)[index];
    return view.state.doc.sliceString(hunk.from, hunk.to);
}
function applies() {
    return api.postMessage.mock.calls.filter(([message]) => message.type === "applyResolution");
}
function expectActiveRows(container: HTMLElement, index: number) {
    const result = EditorView.findFromDOM(
        container.querySelector<HTMLElement>(".pane-result .cm-editor")!,
    )!;
    const hunk = result.state.field(workbenchHunks)[index];
    for (const [pane, from, to] of [
        ["ours", "oursFrom", "oursTo"],
        ["result", "from", "to"],
        ["theirs", "theirsFrom", "theirsTo"],
    ] as const) {
        const host = container.querySelector(`.pane-${pane}`)!;
        const view = EditorView.findFromDOM(host.querySelector<HTMLElement>(".cm-editor")!)!;
        const rows = ownedLines(view.state.doc, hunk[from], hunk[to]);
        expect(rows.length).toBeGreaterThanOrEqual(2);
        expect(host.querySelectorAll(".cm-line.mrow-active")).toHaveLength(rows.length);
        const lines = host.querySelectorAll(".cm-line");
        for (const row of rows) expect(lines[row - 1].classList.contains("mrow-active")).toBe(true);
    }
}

describe("workbench keyboard", () => {
    it("no true conflicts leaves resolve and navigation keys inert with nothing active", () => {
        const versions = {
            base: "head\nbase\ntail\n",
            ours: "head\nours only\ntail\n",
            theirs: "head\nbase\ntail\n",
        };
        const input = fixture();
        const mounted = mount(
            <MergeWorkbench
                data={{
                    ...input,
                    segments: parseConflictVersions(versions.base, versions.ours, versions.theirs),
                    workbench: { ...input.workbench, ...versions },
                }}
            />,
        );
        const errors: unknown[] = [];
        const onError = (event: ErrorEvent) => {
            errors.push(event.error);
            event.preventDefault();
        };
        window.addEventListener("error", onError);
        try {
            const { container } = mounted;
            const view = EditorView.findFromDOM(
                container.querySelector<HTMLElement>(".pane-result .cm-editor")!,
            )!;
            expect(view.state.field(workbenchHunks)).toHaveLength(1);
            expect(view.state.field(workbenchHunks)[0].conflict).toBe(false);
            const before = view.state.doc.toString();
            const expectInactive = () => {
                expect(
                    container.querySelectorAll('.overview-marker[aria-current="true"]'),
                ).toHaveLength(0);
                expect(container.querySelectorAll(".mrow-active")).toHaveLength(0);
                expect(
                    container.querySelector<HTMLSelectElement>('[aria-label="Resolve change"]')!
                        .disabled,
                ).toBe(true);
            };
            expectInactive();
            for (const [name, modifiers] of [
                ["ArrowLeft", { ctrlKey: true }],
                ["ArrowRight", { ctrlKey: true }],
                ["x", {}],
                ["b", {}],
                ["n", {}],
                ["p", {}],
                ["F7", {}],
                ["F7", { shiftKey: true }],
            ] as const) {
                expect(() => key(name, modifiers)).not.toThrow();
                expect(errors, `${name} must not throw with no active conflict`).toEqual([]);
                expect(view.state.doc.toString()).toBe(before);
                expect(undoDepth(view.state)).toBe(0);
                expectInactive();
            }
        } finally {
            window.removeEventListener("error", onError);
            unmount(mounted.root, mounted.container);
        }
    });
    it("n from the initial conflict paints every row of the next true conflict", () => {
        const { container, active } = setup(true);
        expect(active()).toBe(0);
        expect(key("n")).toBe(false);
        expectActiveRows(container, 1);
    });
    it("p from the initial conflict paints every row of the last true conflict", () => {
        const { container } = setup(true);
        expect(key("p")).toBe(false);
        expectActiveRows(container, 2);
    });
    it("Ctrl-ArrowLeft accepts the first unresolved ours and jumps to the next", () => {
        const { view, container, active } = setup();
        expect(active()).toBe(0);
        key("ArrowLeft", { ctrlKey: true });
        expect(hunkText(view, 0)).toBe("ours 1a\nours 1b\n");
        expect(undoDepth(view.state)).toBe(1);
        expectActiveRows(container, 1);
    });
    it("Ctrl-ArrowRight accepts theirs and jumps to the next unresolved", () => {
        const { view, active } = setup();
        expect(active()).toBe(0);
        key("ArrowRight", { ctrlKey: true });
        expect(hunkText(view, 0)).toBe("theirs 1a\ntheirs 1b\n");
        expect(active()).toBe(1);
    });
    it("x wraps from conflict three to one, skipping resolved conflict two", () => {
        const { view, accept, activate, active } = setup();
        accept(1);
        expect(active()).toBe(1);
        activate(2);
        key("x");
        expect(hunkText(view, 2)).toBe("");
        expect(active()).toBe(0);
    });
    it("x on conflict one skips resolved conflict two and activates conflict three", () => {
        const { view, accept, activate, active } = setup();
        accept(1);
        expect(active()).toBe(1);
        activate(0);
        key("x");
        expect(hunkText(view, 0)).toBe("");
        expect(active()).toBe(2);
    });
    it("x removes both sides from the hunk range", () => {
        const { view } = setup();
        key("x");
        expect(hunkText(view, 0)).toBe("");
        expect(view.state.doc.toString()).not.toContain("ours 1");
        expect(view.state.doc.toString()).not.toContain("theirs 1");
    });
    it("b stacks ours then theirs for a true conflict", () => {
        const { view } = setup();
        key("b");
        expect(hunkText(view, 0)).toBe("ours 1a\nours 1b\ntheirs 1a\ntheirs 1b\n");
    });
    it("b refuses a one-sided rail selection without text, history or active changes", () => {
        const { view, activate, active } = setup(true);
        expect(view.state.field(workbenchHunks)[3].segment.changeKind).toBe("ours-only");
        activate(3);
        const before = view.state.doc.toString();
        const depth = undoDepth(view.state);
        key("b");
        expect(view.state.doc.toString()).toBe(before);
        expect(undoDepth(view.state)).toBe(depth);
        expect(active()).toBe(3);
    });
    it("ignores n from result content and toolbar select", () => {
        const { container, view, activate, active } = setup();
        activate(0);
        key("n", {}, view.contentDOM);
        expect(active()).toBe(0);
        key("n", {}, container.querySelector("select")!);
        expect(active()).toBe(0);
    });
    it("window Mod-Enter leaves unresolved events unprevented and applies once when clean", () => {
        const { view, accept } = setup();
        expect(key("Enter", { ctrlKey: true })).toBe(true);
        expect(applies()).toHaveLength(0);
        for (let index = 2; index >= 0; index--) accept(index);
        expect(view.state.field(workbenchHunks).every((hunk) => hunk.resolved)).toBe(true);
        expect(key("Enter", { ctrlKey: true })).toBe(false);
        expect(applies()).toHaveLength(1);
    });
    it("result F7 and Shift-F7 move exactly once; Mod-Enter inserts a line until clean", () => {
        const { view, activate, active, accept } = setup();
        activate(0);
        expect(key("F7", {}, view.contentDOM)).toBe(false);
        expect(active()).toBe(1);
        expect(key("F7", { shiftKey: true }, view.contentDOM)).toBe(false);
        expect(active()).toBe(0);
        const lines = view.state.doc.lines;
        key("Enter", { ctrlKey: true }, view.contentDOM);
        expect(applies()).toHaveLength(0);
        expect(view.state.doc.lines).toBe(lines + 1);
        for (let index = 2; index >= 0; index--) accept(index);
        key("Enter", { ctrlKey: true }, view.contentDOM);
        expect(applies()).toHaveLength(1);
    });
    it("window Ctrl-Z, Ctrl-Shift-Z and Ctrl-Y undo and redo gutter acceptance", () => {
        const { view, accept } = setup();
        const before = view.state.doc.toString();
        accept(0);
        const after = view.state.doc.toString();
        expect(after).not.toBe(before);
        expect(key("z", { ctrlKey: true })).toBe(false);
        expect(view.state.doc.toString()).toBe(before);
        key("Z", { ctrlKey: true, shiftKey: true });
        expect(view.state.doc.toString()).toBe(after);
        key("z", { ctrlKey: true });
        key("y", { ctrlKey: true });
        expect(view.state.doc.toString()).toBe(after);
    });
    it("Meta shortcuts resolve, undo and redo", () => {
        const { view } = setup();
        const before = view.state.doc.toString();
        key("ArrowRight", { metaKey: true });
        expect(hunkText(view, 0)).toBe("theirs 1a\ntheirs 1b\n");
        const after = view.state.doc.toString();
        key("z", { metaKey: true });
        expect(view.state.doc.toString()).toBe(before);
        key("z", { metaKey: true, shiftKey: true });
        expect(view.state.doc.toString()).toBe(after);
    });
    it("keyboard resolve retains external focus so the next n is handled", () => {
        const { active } = setup();
        key("ArrowLeft", { ctrlKey: true });
        expect(document.activeElement?.closest(".cm-content")).toBeNull();
        expect(active()).toBe(1);
        key("n", {}, document.activeElement ?? document.body);
        expect(active()).toBe(2);
    });
    it("gutter accept stays active on the clicked hunk and focuses the result", () => {
        const { accept, active, view } = setup();
        accept(0);
        expect(active()).toBe(0);
        expect(document.activeElement).toBe(view.contentDOM);
    });
    it("window F7, Shift-F7 and Shift-N use main's ordering and modifiers", () => {
        const { active } = setup();
        key("F7");
        expect(active()).toBe(1);
        key("N", { shiftKey: true });
        expect(active()).toBe(2);
        key("F7", { shiftKey: true });
        expect(active()).toBe(1);
        expect(key("n", { altKey: true })).toBe(true);
        expect(key("n", { ctrlKey: true })).toBe(true);
        expect(active()).toBe(1);
    });
    it("ignores all editor contents and form fields including descendant targets", () => {
        const { container, activate, active } = setup();
        activate(0);
        for (const target of container.querySelectorAll(".cm-content")) {
            key("n", {}, target);
            key("x", {}, target.firstElementChild!);
            expect(active()).toBe(0);
        }
        for (const tag of ["input", "textarea", "select"]) {
            const target = document.createElement(tag);
            container.appendChild(target);
            expect(key("n", {}, target)).toBe(true);
            expect(active()).toBe(0);
        }
    });
    it("handles non-Element targets and removes its listener on unmount", () => {
        const { root, container, active } = setup();
        key("n", {}, window);
        expect(active()).toBe(1);
        key("n", {}, document);
        expect(active()).toBe(2);
        unmount(root, container);
        expect(key("n")).toBe(true);
    });
});
