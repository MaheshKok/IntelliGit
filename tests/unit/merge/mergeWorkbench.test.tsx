// @vitest-environment jsdom
import React, { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorView } from "@codemirror/view";
import { workbenchHunks } from "../../../src/webviews/react/merge-editor/workbenchModel";
import { MergeWorkbench } from "../../../src/webviews/react/merge-editor/MergeWorkbench";
import { parseConflictVersions, detectEolMetadata } from "../../../src/mergeEditor/conflictParser";
import { mount, unmount, initReactDomTestEnvironment } from "../../helpers/reactDomTestUtils";
import { installWebviewI18n } from "../../helpers/webviewI18nTestUtils";
import { undo, undoDepth } from "@codemirror/commands";
import { t } from "../../../src/webviews/react/shared/i18n";
import { hunkView, ownedLines } from "../../../src/webviews/react/merge-editor/workbenchRows";
import {
    CHEVRON_PATH,
    CROSS_PATH,
    PLUS_PATH,
    MIRROR_TRANSFORM,
} from "../../../src/webviews/react/merge-editor/hunkActionGlyph";

const api = vi.hoisted(() => ({
    postMessage: vi.fn(),
    getState: vi.fn<() => unknown>(() => null),
    setState: vi.fn(),
}));
vi.mock("../../../src/webviews/react/shared/vscodeApi", () => ({ getVsCodeApi: () => api }));
initReactDomTestEnvironment();
const base = "head\nbase\ntail\n";
const ours = "head\nours\ntail\n";
const theirs = "head\ntheirs\ntail\n";
const data = {
    filePath: "file.ts",
    oursLabel: "ours",
    theirsLabel: "theirs",
    segments: parseConflictVersions(base, ours, theirs),
    ...detectEolMetadata(ours),
    workbench: {
        snapshotId: "b".repeat(64),
        draftKey: "mergeDraft.test",
        base,
        ours,
        theirs,
        operation: "merge",
    },
};

const actionVersions = {
    base: "head\nbase one\nbase two\ntail\n",
    ours: "head\nours one\nours two\ntail\n",
    theirs: "head\ntheirs one\ntheirs two\ntail\n",
};
const actionData = {
    ...data,
    segments: parseConflictVersions(
        actionVersions.base,
        actionVersions.ours,
        actionVersions.theirs,
    ),
    workbench: { ...data.workbench, ...actionVersions },
};

const twoActionVersions = {
    base: "head\nbase one\nbase two\nkeep\nbase three\nbase four\ntail\n",
    ours: "head\nours one\nours two\nkeep\nours three\nours four\ntail\n",
    theirs: "head\ntheirs one\ntheirs two\nkeep\ntheirs three\ntheirs four\ntail\n",
};
const twoActionData = {
    ...data,
    segments: parseConflictVersions(
        twoActionVersions.base,
        twoActionVersions.ours,
        twoActionVersions.theirs,
    ),
    workbench: { ...data.workbench, ...twoActionVersions },
};

function click(container: HTMLElement, label: string) {
    const button =
        container.querySelector<HTMLButtonElement>(`.mw-toolbar button[aria-label="${label}"]`) ??
        [...container.querySelectorAll<HTMLButtonElement>("button")].find(
            (element) => element.textContent === label,
        );
    if (!button) throw new Error(`Missing ${label}`);
    act(() => button.click());
}
function result(container: HTMLElement): EditorView {
    return EditorView.findFromDOM(
        container.querySelector('[data-testid="merge-editor-1"] .cm-editor') as HTMLElement,
    )!;
}
function receive(message: unknown) {
    act(() => window.dispatchEvent(new MessageEvent("message", { data: message })));
}

beforeEach(() => {
    installWebviewI18n();
    vi.clearAllMocks();
    api.getState.mockReturnValue(null);
    vi.stubGlobal(
        "ResizeObserver",
        class {
            observe() {}
            disconnect() {}
        },
    );
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
    vi.useRealTimers();
    Reflect.deleteProperty(Range.prototype, "getClientRects");
    Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

function expectActionRows(
    container: HTMLElement,
    pane: "ours" | "theirs" | "result",
    state: string,
) {
    const hunk = result(container).state.field(workbenchHunks)[0];
    const host = container.querySelector(`.pane-${pane}`)!;
    const view = EditorView.findFromDOM(host.querySelector<HTMLElement>(".cm-editor")!)!;
    const from = pane === "ours" ? hunk.oursFrom : pane === "theirs" ? hunk.theirsFrom : hunk.from;
    const to = pane === "ours" ? hunk.oursTo : pane === "theirs" ? hunk.theirsTo : hunk.to;
    const rows = ownedLines(view.state.doc, from, to);
    expect(host.querySelectorAll(`.cm-line.mrow-${state}`)).toHaveLength(rows.length);
    const lines = host.querySelectorAll(".cm-line");
    for (const row of rows) expect(lines[row - 1].classList.contains(`mrow-${state}`)).toBe(true);
    return rows.length;
}

function expectPendingActionRows(container: HTMLElement) {
    for (const pane of ["ours", "theirs", "result"] as const)
        expect(expectActionRows(container, pane, "pending")).toBe(2);
}

function actionButton(container: HTMLElement, selector: string) {
    const button = container.querySelector<HTMLButtonElement>(selector);
    expect(button, selector).not.toBeNull();
    return button!;
}

describe("merge workbench action gutters", () => {
    it("left gutter accept resolves ours, then shows the right accept in append mode", () => {
        const mounted = mount(<MergeWorkbench data={actionData} />);
        try {
            expectPendingActionRows(mounted.container);
            const view = result(mounted.container);
            act(() => actionButton(mounted.container, ".pane-ours .accept-btn").click());
            const hunk = view.state.field(workbenchHunks)[0];
            expect(view.state.doc.sliceString(hunk.from, hunk.to)).toBe("ours one\nours two\n");
            expectActionRows(mounted.container, "ours", "accepted");
            const append = actionButton(mounted.container, ".pane-theirs .accept-btn.append-btn");
            expect(append.getAttribute("aria-label")).toBe(t("merge.hunk.appendRight"));
            expect(append.querySelectorAll("path")[1].getAttribute("d")).toBe(PLUS_PATH);
            act(() => append.click());
            expect(view.state.doc.toString()).toBe(
                "head\nours one\nours two\ntheirs one\ntheirs two\ntail\n",
            );
            expectActionRows(mounted.container, "theirs", "accepted");
            expectActionRows(mounted.container, "result", "plain");
            expect(undoDepth(view.state)).toBe(2);
        } finally {
            unmount(mounted.root, mounted.container);
        }
    });

    it("right gutter accept resolves theirs, then the left append puts theirs before ours", () => {
        const mounted = mount(<MergeWorkbench data={actionData} />);
        try {
            expectPendingActionRows(mounted.container);
            const view = result(mounted.container);
            act(() => actionButton(mounted.container, ".pane-theirs .accept-btn").click());
            const hunk = view.state.field(workbenchHunks)[0];
            expect(view.state.doc.sliceString(hunk.from, hunk.to)).toBe("theirs one\ntheirs two\n");
            expectActionRows(mounted.container, "theirs", "accepted");
            const append = actionButton(mounted.container, ".pane-ours .accept-btn.append-btn");
            expect(append.getAttribute("aria-label")).toBe(t("merge.hunk.appendLeft"));
            act(() => append.click());
            expect(view.state.field(workbenchHunks)[0].decision).toBe("both-reversed");
            expect(view.state.doc.toString()).toBe(
                "head\ntheirs one\ntheirs two\nours one\nours two\ntail\n",
            );
            expectActionRows(mounted.container, "ours", "accepted");
            expect(undoDepth(view.state)).toBe(2);
        } finally {
            unmount(mounted.root, mounted.container);
        }
    });

    it("discard on both sides settles the hunk", () => {
        const mounted = mount(<MergeWorkbench data={actionData} />);
        try {
            expectPendingActionRows(mounted.container);
            const view = result(mounted.container);
            act(() => actionButton(mounted.container, ".pane-ours .discard-btn").click());
            act(() => actionButton(mounted.container, ".pane-theirs .discard-btn").click());
            expect(view.state.field(workbenchHunks)[0].decision).toBe("none");
            const hunk = view.state.field(workbenchHunks)[0];
            expect(hunk.from).toBe(hunk.to);
            expectActionRows(mounted.container, "ours", "dismissed");
            expectActionRows(mounted.container, "theirs", "dismissed");
            expect(expectActionRows(mounted.container, "result", "plain")).toBe(0);
            expect(view.state.doc.toString()).toBe("head\ntail\n");
            expect(undoDepth(view.state)).toBe(2);
        } finally {
            unmount(mounted.root, mounted.container);
        }
    });

    it("a single discard dismisses one side and is one undo step", () => {
        const mounted = mount(<MergeWorkbench data={actionData} />);
        try {
            expectPendingActionRows(mounted.container);
            const view = result(mounted.container);
            const before = view.state.doc.toString();
            act(() => actionButton(mounted.container, ".pane-ours .discard-btn").click());
            expectActionRows(mounted.container, "ours", "dismissed");
            expect(view.state.doc.toString()).toBe(before);
            expect(undoDepth(view.state)).toBe(1);
            act(() => {
                expect(undo(view)).toBe(true);
            });
            expectPendingActionRows(mounted.container);
        } finally {
            unmount(mounted.root, mounted.container);
        }
    });

    it("discarding the second hunk activates every owned ours row", () => {
        const mounted = mount(<MergeWorkbench data={twoActionData} />);
        try {
            const hunks = result(mounted.container).state.field(workbenchHunks);
            expect(hunks).toHaveLength(2);
            for (const pane of ["ours", "theirs", "result"] as const) {
                const host = mounted.container.querySelector(`.pane-${pane}`)!;
                const view = EditorView.findFromDOM(
                    host.querySelector<HTMLElement>(".cm-editor")!,
                )!;
                const lines = host.querySelectorAll(".cm-line");
                expect(host.querySelectorAll(".cm-line.mrow-pending")).toHaveLength(4);
                for (const hunk of hunks) {
                    const from =
                        pane === "ours"
                            ? hunk.oursFrom
                            : pane === "theirs"
                              ? hunk.theirsFrom
                              : hunk.from;
                    const to =
                        pane === "ours" ? hunk.oursTo : pane === "theirs" ? hunk.theirsTo : hunk.to;
                    const rows = ownedLines(view.state.doc, from, to);
                    expect(rows).toHaveLength(2);
                    for (const row of rows)
                        expect(lines[row - 1].classList.contains("mrow-pending")).toBe(true);
                }
            }
            const host = mounted.container.querySelector(".pane-ours")!;
            const view = EditorView.findFromDOM(host.querySelector<HTMLElement>(".cm-editor")!)!;
            const firstRows = ownedLines(view.state.doc, hunks[0].oursFrom, hunks[0].oursTo);
            const secondRows = ownedLines(view.state.doc, hunks[1].oursFrom, hunks[1].oursTo);
            const lines = host.querySelectorAll(".cm-line");
            expect(host.querySelectorAll(".cm-line.mrow-active")).toHaveLength(firstRows.length);
            for (const row of firstRows)
                expect(lines[row - 1].classList.contains("mrow-active")).toBe(true);
            for (const row of secondRows)
                expect(lines[row - 1].classList.contains("mrow-active")).toBe(false);
            const actions = host.querySelectorAll(".conflict-actions-left");
            expect(actions).toHaveLength(2);
            act(() => actions[1].querySelector<HTMLButtonElement>(".discard-btn")!.click());
            const updatedLines = host.querySelectorAll(".cm-line");
            for (const row of secondRows)
                expect(updatedLines[row - 1].classList.contains("mrow-active")).toBe(true);
            expect(host.querySelectorAll(".cm-line.mrow-active")).toHaveLength(secondRows.length);
            for (const row of firstRows)
                expect(updatedLines[row - 1].classList.contains("mrow-active")).toBe(false);
        } finally {
            unmount(mounted.root, mounted.container);
        }
    });

    it("no action marker sits on the phantom row", () => {
        const versions = { base: "a\nx\n", ours: "a\n", theirs: "a\ny\n" };
        const input = {
            ...data,
            segments: parseConflictVersions(versions.base, versions.ours, versions.theirs),
            workbench: { ...data.workbench, ...versions },
        };
        const mounted = mount(<MergeWorkbench data={input} />);
        try {
            const hunks = result(mounted.container).state.field(workbenchHunks);
            expect(hunks).toHaveLength(1);
            expect(hunkView(hunks[0]).showLeftActions).toBe(true);
            expect(hunks[0].oursFrom).toBe(versions.ours.length);
            expect(hunks[0].oursTo).toBe(hunks[0].oursFrom);
            const cells = mounted.container.querySelectorAll(
                ".pane-ours .merge-action-gutter .cm-gutterElement",
            );
            expect(cells.length).toBeGreaterThan(0);
            expect(cells[cells.length - 1].childElementCount).toBe(0);
            expect(
                mounted.container.querySelectorAll(".pane-ours .conflict-actions-left"),
            ).toHaveLength(0);
        } finally {
            unmount(mounted.root, mounted.container);
        }
    });

    it("action gutters sit between code and numbers", () => {
        const mounted = mount(<MergeWorkbench data={actionData} />);
        try {
            expectPendingActionRows(mounted.container);
            for (const pane of ["ours", "theirs"]) {
                const host = mounted.container.querySelector(`.pane-${pane}`)!;
                const order =
                    pane === "ours"
                        ? [".cm-content", ".merge-action-gutter", ".cm-lineNumbers"]
                        : [".cm-lineNumbers", ".merge-action-gutter", ".cm-content"];
                const nodes = order.map((selector) => host.querySelector(selector));
                for (const node of nodes) expect(node).not.toBeNull();
                for (let index = 0; index < nodes.length - 1; index++)
                    expect(
                        nodes[index]!.compareDocumentPosition(nodes[index + 1]!) &
                            Node.DOCUMENT_POSITION_FOLLOWING,
                    ).not.toBe(0);
            }
            expect(
                mounted.container.querySelector(
                    ".pane-result .merge-action-gutter, .pane-base .merge-action-gutter",
                ),
            ).toBeNull();
        } finally {
            unmount(mounted.root, mounted.container);
        }
    });

    it("gutter buttons carry main's labels and glyphs", () => {
        const mounted = mount(<MergeWorkbench data={actionData} />);
        try {
            expectPendingActionRows(mounted.container);
            for (const [pane, side, suffix] of [
                ["ours", "left", "Left"],
                ["theirs", "right", "Right"],
            ]) {
                const host = mounted.container.querySelector(`.pane-${pane}`)!;
                const discard = actionButton(
                    mounted.container,
                    `.pane-${pane} .conflict-actions-${side} .discard-btn`,
                );
                const accept = actionButton(
                    mounted.container,
                    `.pane-${pane} .conflict-actions-${side} .accept-btn`,
                );
                for (const [button, key] of [
                    [discard, `merge.hunk.ignore${suffix}`],
                    [accept, `merge.hunk.accept${suffix}`],
                ] as const) {
                    expect(button.getAttribute("aria-label")).toBe(t(key));
                    expect(button.title).toBe(t(key));
                    expect(button.type).toBe("button");
                    const glyph = button.querySelector(".hunk-action-glyph")!;
                    expect(glyph.getAttribute("aria-hidden")).toBe("true");
                    const svg = glyph.querySelector("svg")!;
                    for (const [attr, value] of Object.entries({
                        width: "12",
                        height: "12",
                        viewBox: "0 0 12 12",
                        fill: "none",
                        stroke: "currentColor",
                        "stroke-width": "1",
                    }))
                        expect(svg.getAttribute(attr)).toBe(value);
                    const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
                    act(() => button.dispatchEvent(down));
                    expect(down.defaultPrevented).toBe(true);
                }
                expect(discard.querySelector("path")?.getAttribute("d")).toBe(CROSS_PATH);
                expect(accept.querySelector("path")?.getAttribute("d")).toBe(CHEVRON_PATH);
                expect(accept.querySelector("path")?.getAttribute("transform")).toBe(
                    pane === "ours" ? MIRROR_TRANSFORM : null,
                );
                const bubbled = vi.fn();
                host.addEventListener("click", bubbled);
                act(() => discard.click());
                expect(bubbled).not.toHaveBeenCalled();
            }
        } finally {
            unmount(mounted.root, mounted.container);
        }
    });
});

describe("merge workbench state and commands", () => {
    it("serialises the current whitespace mode", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        for (const ignoreWhitespace of [false, true]) {
            api.postMessage.mockClear();
            const input = ignoreWhitespace ? { ...data, diffOptions: { ignoreWhitespace } } : data;
            const mounted = mount(<MergeWorkbench data={input} />);
            try {
                const view = result(mounted.container);
                const hunk = view.state.field(workbenchHunks)[0];
                act(() => view.dispatch({ changes: { from: hunk.from, insert: "edit" } }));
                await act(async () => vi.advanceTimersByTimeAsync(250));
                const messages = api.postMessage.mock.calls.filter(
                    ([msg]) => msg.type === "saveMergeDraft",
                );
                expect(messages).toHaveLength(1);
                const draft = messages[0][0].draft;
                expect(draft.ignoreWhitespace).toBe(ignoreWhitespace);
                expect(draft.hunks).toEqual([
                    {
                        id: hunk.id,
                        from: hunk.from,
                        to: hunk.to + 4,
                        resolved: false,
                        edited: true,
                        dismissedOurs: false,
                        dismissedTheirs: false,
                    },
                ]);
                expect(Object.hasOwn(draft.hunks[0], "decision")).toBe(false);
            } finally {
                unmount(mounted.root, mounted.container);
            }
        }
    });

    it("restores per-hunk state from a matching local draft", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const draft = {
            snapshotId: data.workbench.snapshotId,
            content: "local draft\n",
            hunks: [
                {
                    id: 0,
                    from: 0,
                    to: 12,
                    resolved: true,
                    decision: "ours",
                    edited: true,
                    dismissedOurs: true,
                    dismissedTheirs: false,
                },
            ],
        };
        api.getState.mockReturnValue(draft);
        const mounted = mount(<MergeWorkbench data={data} />);
        try {
            const view = result(mounted.container);
            expect(view.state.field(workbenchHunks)[0]).toMatchObject({
                decision: "ours",
                edited: true,
                dismissed: { ours: true, theirs: false },
            });
            act(() => view.dispatch({ changes: { from: view.state.doc.length, insert: "tail" } }));
            await act(async () => vi.advanceTimersByTimeAsync(250));
            expect(api.postMessage).toHaveBeenCalledWith(
                expect.objectContaining({
                    type: "saveMergeDraft",
                    draft: expect.objectContaining({ hunks: draft.hunks }),
                }),
            );
        } finally {
            unmount(mounted.root, mounted.container);
        }
    });

    it("debounces local and durable draft serialization until typing settles", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const mounted = mount(<MergeWorkbench data={data} />);
        const view = result(mounted.container);
        act(() => view.dispatch({ changes: { from: 0, insert: "first\n" } }));
        await act(async () => vi.advanceTimersByTimeAsync(200));
        act(() => view.dispatch({ changes: { from: 0, insert: "latest\n" } }));
        await act(async () => vi.advanceTimersByTimeAsync(249));
        expect(api.setState).not.toHaveBeenCalled();
        expect(api.postMessage.mock.calls.filter(([msg]) => msg.type === "saveMergeDraft")).toEqual(
            [],
        );
        await act(async () => vi.advanceTimersByTimeAsync(1));
        expect(api.setState).toHaveBeenCalledTimes(1);
        expect(api.setState).toHaveBeenCalledWith(
            expect.objectContaining({ content: "latest\nfirst\n" + base }),
        );
        expect(api.postMessage).toHaveBeenCalledWith({
            type: "saveMergeDraft",
            draft: api.setState.mock.calls[0][0],
            revision: 2,
        });
        unmount(mounted.root, mounted.container);
    });
    it.each(["pagehide", "unmount", "cancel"])(
        "flushes the last edit before debounce on %s",
        (event) => {
            vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
            const mounted = mount(<MergeWorkbench data={data} />);
            const view = result(mounted.container);
            act(() => view.dispatch({ changes: { from: 0, insert: "last edit\n" } }));
            expect(api.setState).not.toHaveBeenCalled();
            if (event === "pagehide") act(() => window.dispatchEvent(new Event("pagehide")));
            if (event === "cancel") click(mounted.container, "Cancel");
            if (event === "unmount") unmount(mounted.root, mounted.container);
            expect(api.setState).toHaveBeenCalledWith(
                expect.objectContaining({ content: "last edit\n" + base }),
            );
            expect(api.postMessage).toHaveBeenCalledWith(
                expect.objectContaining({
                    type: "saveMergeDraft",
                    draft: expect.objectContaining({ content: "last edit\n" + base }),
                    revision: 1,
                }),
            );
            if (event !== "unmount") unmount(mounted.root, mounted.container);
        },
    );
    it("keeps local edits while preserving the prior operation's durable draft", () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const mounted = mount(<MergeWorkbench data={data} />);
        receive({
            type: "mergeDraft",
            draft: { snapshotId: "a".repeat(64), content: "old", hunks: [] },
        });
        act(() => result(mounted.container).dispatch({ changes: { from: 0, insert: "new\n" } }));
        act(() => window.dispatchEvent(new Event("pagehide")));
        expect(api.setState).toHaveBeenCalledWith(
            expect.objectContaining({ content: "new\n" + base }),
        );
        expect(api.postMessage.mock.calls.filter(([msg]) => msg.type === "saveMergeDraft")).toEqual(
            [],
        );
        click(mounted.container, "Discard previous draft");
        expect(api.postMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                type: "saveMergeDraft",
                draft: expect.objectContaining({ content: "new\n" + base }),
            }),
        );
        unmount(mounted.root, mounted.container);
    });
    it("opens the native fallback without dropping the current draft", () => {
        const mounted = mount(<MergeWorkbench data={data} />);
        click(mounted.container, "Accept left change");
        const button = mounted.container.querySelector<HTMLButtonElement>(
            '.mw-footer button[aria-label="Open in VS Code"]',
        )!;
        act(() => button.click());
        expect(api.postMessage).toHaveBeenCalledWith(
            expect.objectContaining({ type: "saveMergeDraft" }),
        );
        expect(api.postMessage).toHaveBeenCalledWith({ type: "openNativeMerge" });
        expect(result(mounted.container).state.doc.toString()).toBe(ours);
        unmount(mounted.root, mounted.container);
    });
    it("unifies side choices, manual editing and confirmations in undo/redo", () => {
        const mounted = mount(<MergeWorkbench data={data} />);
        const view = result(mounted.container);
        click(mounted.container, "Accept left change");
        expect(view.state.doc.toString()).toContain("ours");
        click(mounted.container, "Undo");
        expect(view.state.doc.toString()).toContain("base");
        click(mounted.container, "Redo");
        expect(view.state.doc.toString()).toContain("ours");
        act(() => view.dispatch({ changes: { from: 0, insert: "manual\n" } }));
        click(mounted.container, "Confirm manual resolution");
        click(mounted.container, "Undo");
        click(mounted.container, "Base");
        expect(mounted.container.querySelector(".mw-base")?.hasAttribute("hidden")).toBe(false);
        click(mounted.container, "Find in result");
        expect(mounted.container.querySelector(".cm-search")).not.toBeNull();
        click(mounted.container, "Synchronize scrolling");
        click(mounted.container, "Accept right change");
        expect(view.state.doc.toString()).toContain("theirs");
        unmount(mounted.root, mounted.container);
    });
    it.each(["both", "both-reversed", "base", "none"])(
        "applies the %s decision and allows undo",
        (choice) => {
            const mounted = mount(<MergeWorkbench data={data} />);
            const select = mounted.container.querySelector("select")!;
            act(() => {
                select.value = choice;
                select.dispatchEvent(new Event("change", { bubbles: true }));
            });
            const text = result(mounted.container).state.doc.toString();
            if (choice === "both") expect(text).toContain("ours\ntheirs");
            if (choice === "both-reversed") expect(text).toContain("theirs\nours");
            if (choice === "base") expect(text).toContain("base");
            if (choice === "none") expect(text).toBe("head\ntail\n");
            click(mounted.container, "Undo");
            expect(result(mounted.container).state.doc.toString()).toBe(base);
            unmount(mounted.root, mounted.container);
        },
    );
    it("freezes editing during Apply and restores it after a recoverable failure", () => {
        const mounted = mount(<MergeWorkbench data={data} />);
        click(mounted.container, "Accept left change");
        click(mounted.container, "Apply");
        expect(api.postMessage).toHaveBeenCalledWith({
            type: "applyResolution",
            snapshotId: data.workbench.snapshotId,
            content: ours,
        });
        expect(result(mounted.container).contentDOM.getAttribute("contenteditable")).toBe("false");
        receive({ type: "resolutionError", message: "changed" });
        expect(mounted.container.querySelector('[role="alert"]')?.textContent).toBe("changed");
        expect(result(mounted.container).contentDOM.getAttribute("contenteditable")).toBe("true");
        receive({ type: "resolutionApplied" });
        expect(api.setState).toHaveBeenCalledWith(null);
        unmount(mounted.root, mounted.container);
    });
    it("restores matching local drafts before late durable loads and preserves stale drafts", () => {
        const draft = {
            snapshotId: data.workbench.snapshotId,
            content: "local draft\n",
            hunks: [{ id: 0, from: 0, to: 12, resolved: true }],
        };
        api.getState.mockReturnValue(draft);
        const mounted = mount(<MergeWorkbench data={data} />);
        expect(result(mounted.container).state.doc.toString()).toBe(draft.content);
        receive({ type: "mergeDraft", draft: { ...draft, content: "late draft\n" } });
        expect(result(mounted.container).state.doc.toString()).toBe(draft.content);
        receive({ type: "mergeDraft", draft: { ...draft, snapshotId: "a".repeat(64) } });
        expect(mounted.container.querySelector("details pre")?.textContent).toBe(draft.content);
        click(mounted.container, "Discard previous draft");
        expect(api.postMessage).toHaveBeenCalledWith({
            type: "discardMergeDraft",
            snapshotId: "a".repeat(64),
        });
        click(mounted.container, "Conflicted files");
        expect(api.postMessage).toHaveBeenCalledWith({ type: "openConflictSession" });
        click(mounted.container, "Cancel");
        expect(api.postMessage).toHaveBeenCalledWith({ type: "close" });
        unmount(mounted.root, mounted.container);
    });
});

describe("merge workbench rows", () => {
    it("paints pending conflict rows and gutter cells", () => {
        const mounted = mount(<MergeWorkbench data={data} />);
        try {
            const host = mounted.container.querySelector('[data-testid="merge-editor-1"]')!;
            expect(host.querySelectorAll(".cm-line.mrow-pending.mrow-conflict")).toHaveLength(1);
            expect(
                host.querySelectorAll(".cm-gutterElement.mrow-pending.mrow-conflict"),
            ).toHaveLength(1);
        } finally {
            unmount(mounted.root, mounted.container);
        }
    });

    it("ours pane orders code, then gutters", () => {
        const mounted = mount(<MergeWorkbench data={data} />);
        try {
            const scroller = mounted.container.querySelector(".pane-ours .cm-scroller");
            expect(scroller).not.toBeNull();
            const content = scroller!.querySelector(".cm-content")!;
            const gutters = scroller!.querySelector(".cm-gutters-after")!;
            expect(scroller!.querySelector(".cm-gutters-before")?.childElementCount).toBe(0);
            expect(
                content.compareDocumentPosition(gutters) & Node.DOCUMENT_POSITION_FOLLOWING,
            ).not.toBe(0);
            expect(gutters.lastElementChild?.classList.contains("cm-lineNumbers")).toBe(true);
        } finally {
            unmount(mounted.root, mounted.container);
        }
    });

    it("the phantom row has an empty number cell and no row class", () => {
        const mounted = mount(<MergeWorkbench data={data} />);
        try {
            for (const pane of [0, 1, 2]) {
                const host = mounted.container.querySelector(
                    `[data-testid="merge-editor-${pane}"]`,
                )!;
                const view = EditorView.findFromDOM(
                    host.querySelector(".cm-editor") as HTMLElement,
                )!;
                const cells = [
                    ...host.querySelectorAll(".cm-lineNumbers .cm-gutterElement"),
                ].filter((cell) => (cell as HTMLElement).style.visibility !== "hidden");
                expect(cells.at(-1)?.textContent).toBe("");
                expect(cells.filter((cell) => cell.textContent)).toHaveLength(
                    view.state.doc.lines - 1,
                );
                const line = [...host.querySelectorAll(".cm-line")].at(-1)!;
                expect([...line.classList].some((name) => name.startsWith("mrow"))).toBe(false);
                expect([...cells.at(-1)!.classList].some((name) => name.startsWith("mrow"))).toBe(
                    false,
                );
            }
        } finally {
            unmount(mounted.root, mounted.container);
        }
    });

    it("a result without a final newline numbers every line", () => {
        const mounted = mount(<MergeWorkbench data={{ ...data, hasTrailingNewline: false }} />);
        try {
            const view = result(mounted.container);
            const cells = [
                ...view.dom.querySelectorAll(".cm-lineNumbers .cm-gutterElement"),
            ].filter(
                (cell) => (cell as HTMLElement).style.visibility !== "hidden" && cell.textContent,
            );
            expect(view.state.doc.toString().endsWith("\n")).toBe(false);
            expect(cells).toHaveLength(view.state.doc.lines);
        } finally {
            unmount(mounted.root, mounted.container);
        }
    });

    it("marks the active hunk's rows in all three panes", () => {
        const mounted = mount(<MergeWorkbench data={data} />);
        try {
            for (const pane of [0, 1, 2]) {
                const host = mounted.container.querySelector(
                    `[data-testid="merge-editor-${pane}"]`,
                )!;
                expect(host.querySelectorAll(".cm-line.mrow-active")).toHaveLength(1);
                expect(host.querySelector(".cm-line.mrow-active")?.textContent).toBe(
                    ["ours", "base", "theirs"][pane],
                );
                for (const gutter of host.querySelectorAll(".cm-gutter"))
                    expect(gutter.querySelectorAll(".cm-gutterElement.mrow-active")).toHaveLength(
                        1,
                    );
                const actions = host.querySelector(".merge-action-gutter");
                if (pane === 1) expect(actions).toBeNull();
                else {
                    expect(actions).not.toBeNull();
                    expect(actions!.querySelectorAll(".cm-gutterElement.mrow-active")).toHaveLength(
                        1,
                    );
                }
            }
        } finally {
            unmount(mounted.root, mounted.container);
        }
    });
});

describe("workbench row updates", () => {
    it("moves the active row classes in every pane without changing text", () => {
        const versions = {
            base: "a\nkeep\nb\n",
            ours: "ours\nkeep\nours2\n",
            theirs: "theirs\nkeep\ntheirs2\n",
        };
        const input = {
            ...data,
            segments: parseConflictVersions(versions.base, versions.ours, versions.theirs),
            workbench: { ...data.workbench, ...versions },
        };
        const mounted = mount(<MergeWorkbench data={input} />);
        try {
            const before = result(mounted.container).state.doc.toString();
            const buttons =
                mounted.container.querySelectorAll<HTMLButtonElement>(".mw-hunks button");
            act(() => buttons[1].click());
            for (const pane of [0, 1, 2]) {
                const host = mounted.container.querySelector(
                    `[data-testid="merge-editor-${pane}"]`,
                )!;
                expect(host.querySelectorAll(".cm-line.mrow-active")).toHaveLength(1);
                expect(host.querySelector(".cm-line.mrow-active")?.textContent).toBe(
                    ["ours2", "b", "theirs2"][pane],
                );
            }
            expect(result(mounted.container).state.doc.toString()).toBe(before);
        } finally {
            unmount(mounted.root, mounted.container);
        }
    });

    it("drops accepted-pane word marks and paints live result edits including whitespace", () => {
        const versions = {
            base: "const value = old;\n",
            ours: "const value = new;\n",
            theirs: "const value = other;\n",
        };
        const input = {
            ...data,
            segments: parseConflictVersions(versions.base, versions.ours, versions.theirs),
            workbench: { ...data.workbench, ...versions },
        };
        const mounted = mount(<MergeWorkbench data={input} />);
        try {
            const oursHost = mounted.container.querySelector('[data-testid="merge-editor-0"]')!;
            expect(oursHost.querySelector(".word-diff-change")?.textContent).toBe("new");
            click(mounted.container, "Accept left change");
            expect(oursHost.querySelector(".word-diff-change")).toBeNull();
            expect(result(mounted.container).dom.querySelector(".word-diff-change")).toBeNull();
            const view = result(mounted.container);
            act(() => view.dispatch({ changes: { from: 5, insert: " " } }));
            expect(view.dom.querySelector(".mrow-edited .word-diff-change")).not.toBeNull();
            expect(
                view.dom.querySelector(".word-diff-change.word-diff-whitespace")?.textContent,
            ).toMatch(/^\s+$/);
            expect(
                mounted.container.querySelector(
                    ".merge-word-change, .merge-range-pending, .merge-range-resolved",
                ),
            ).toBeNull();
        } finally {
            unmount(mounted.root, mounted.container);
        }
    });

    it.each([false, true])(
        "suppresses empty EOF hunk classes only on a phantom row: %s",
        (atEnd) => {
            const versions = atEnd
                ? { base: "head\n", ours: "head\nours\n", theirs: "head\ntheirs\n" }
                : {
                      base: "head\ntail\n",
                      ours: "head\nours\ntail\n",
                      theirs: "head\ntheirs\ntail\n",
                  };
            const input = {
                ...data,
                segments: parseConflictVersions(versions.base, versions.ours, versions.theirs),
                workbench: { ...data.workbench, ...versions },
            };
            const mounted = mount(<MergeWorkbench data={input} />);
            try {
                const view = result(mounted.container);
                expect(view.state.field(workbenchHunks)[0].from).toBe(
                    view.state.field(workbenchHunks)[0].to,
                );
                expect(view.dom.querySelectorAll(".cm-line.mrow-empty")).toHaveLength(
                    atEnd ? 0 : 1,
                );
                expect(view.dom.querySelectorAll(".cm-gutterElement.mrow-empty")).toHaveLength(
                    atEnd ? 0 : 1,
                );
                const baseHost = mounted.container.querySelector(".pane-base")!;
                expect(baseHost.querySelector(".mrow, .word-diff-change")).toBeNull();
                expect(
                    baseHost.querySelector(".cm-lineNumbers .cm-gutterElement:last-child")
                        ?.textContent,
                ).toBe("");
            } finally {
                unmount(mounted.root, mounted.container);
            }
        },
    );
});
