// @vitest-environment jsdom
import React, { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorView, gutterLineClass } from "@codemirror/view";
import * as codeEditor from "../../../src/webviews/react/merge-editor/codeEditor";
import {
    workbenchHunks,
    buildWorkbenchDocument,
    groupingField,
    regroupSpec,
    isPristineState,
} from "../../../src/webviews/react/merge-editor/workbenchModel";
import { paneChangeCount } from "../../../src/webviews/react/merge-editor/mergeState";
import { MergeWorkbench } from "../../../src/webviews/react/merge-editor/MergeWorkbench";
import { parseConflictVersions, detectEolMetadata } from "../../../src/mergeEditor/conflictParser";
import { mount, unmount, initReactDomTestEnvironment } from "../../helpers/reactDomTestUtils";
import { installWebviewI18n } from "../../helpers/webviewI18nTestUtils";
import { undo, redo, undoDepth } from "@codemirror/commands";
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

const scrollVersions = {
    base: "head\nbase one\nbase two\nkeep\nbase three\nbase four\ntail\n",
    ours: "head\nours one\nkeep\nours three\nours four\ntail\n",
    theirs: "head\ntheirs one\ntheirs two\ntheirs extra\nkeep\ntheirs three\ntheirs four\ntail\n",
};
const scrollData = {
    ...data,
    segments: parseConflictVersions(
        scrollVersions.base,
        scrollVersions.ours,
        scrollVersions.theirs,
    ),
    workbench: { ...data.workbench, ...scrollVersions },
};

describe("shared workbench layout", () => {
    it("reuses phantom gutter markers until the last line changes", () => {
        const editor = codeEditor.createMergeCodeEditor(
            document.createElement("div"),
            "head\ntail\n",
            {
                pane: "ours",
                readOnly: true,
                filePath: "file.txt",
                label: "ours",
                theme: "dark-plus",
            },
        );
        const markers = () => editor.view.state.facet(gutterLineClass)[0];
        try {
            const initial = markers();
            editor.view.dispatch({ changes: { from: 0, to: 4, insert: "HEAD" } });
            expect(markers(), "same last line reuses the phantom marker set").toBe(initial);
            editor.view.dispatch({
                changes: { from: editor.view.state.doc.length, insert: "last" },
            });
            expect(markers(), "editing the last line rebuilds the phantom marker set").not.toBe(
                initial,
            );
            expect(markers().size).toBe(0);
            editor.view.dispatch({ changes: { from: editor.view.state.doc.length, insert: "\n" } });
            expect(markers().size).toBe(1);
            const phantom = markers();
            editor.view.dispatch({ changes: { from: 0, insert: "prefix" } });
            expect(markers(), "moving the last line rebuilds its marker position").not.toBe(
                phantom,
            );
            expect(markers().iter().from).toBe(editor.view.state.doc.length);
        } finally {
            editor.view.destroy();
        }
    });

    it("renders one ribbon path per pending conflict side", () => {
        const mounted = mount(<MergeWorkbench data={twoActionData} />);
        try {
            const viewport = mounted.container.querySelector(".merge-viewport")!;
            const overlays = viewport.querySelectorAll(":scope > svg.merge-connectors");
            expect(overlays).toHaveLength(1);
            expect(viewport.lastElementChild).toBe(overlays[0]);
            const paths = overlays[0].querySelectorAll("path.merge-connector");
            expect(paths).toHaveLength(4);
            for (const path of paths) {
                expect(path.classList.contains("change-conflict")).toBe(true);
                expect(path.classList.contains("connector-resolved")).toBe(false);
            }
        } finally {
            unmount(mounted.root, mounted.container);
        }
    });
    it("accepting a side resolves its ribbon", () => {
        const mounted = mount(<MergeWorkbench data={twoActionData} />);
        try {
            const paths = () => [...mounted.container.querySelectorAll("path.merge-connector")];
            expect(paths()).toHaveLength(4);
            const secondHunk = paths().slice(2);
            const secondClasses = secondHunk.map((path) => path.getAttribute("class"));
            act(() =>
                mounted.container
                    .querySelector<HTMLButtonElement>(".pane-ours .accept-btn")!
                    .click(),
            );
            const after = paths();
            expect(after).toHaveLength(4);
            // ConnectorLayer emits each hunk's left path before its right path.
            expect(after.filter((path) => path.classList.contains("connector-resolved"))).toEqual([
                after[0],
            ]);
            expect(
                after
                    .filter((_path, index) => index % 2 === 0)
                    .filter((path) => path.classList.contains("connector-resolved")),
            ).toHaveLength(1);
            expect(after.slice(2)).toEqual(secondHunk);
            expect(after.slice(2).map((path) => path.getAttribute("class"))).toEqual(secondClasses);
        } finally {
            unmount(mounted.root, mounted.container);
        }
    });
    it("editing a hunk removes its ribbons", () => {
        const mounted = mount(<MergeWorkbench data={twoActionData} />);
        try {
            const paths = () => [...mounted.container.querySelectorAll("path.merge-connector")];
            expect(paths()).toHaveLength(4);
            const secondHunk = paths().slice(2);
            const view = result(mounted.container);
            const first = view.state.field(workbenchHunks)[0];
            act(() =>
                view.dispatch({
                    changes: { from: first.from + 1, insert: "typed" },
                    userEvent: "input.type",
                }),
            );
            expect(paths()).toHaveLength(2);
            expect(paths()).toEqual(secondHunk);
        } finally {
            unmount(mounted.root, mounted.container);
        }
    });
    it("a scroll request is answered by the workbench, not CodeMirror", async () => {
        const factory = vi.spyOn(codeEditor, "createMergeCodeEditor");
        const mounted = mount(<MergeWorkbench data={data} />);
        try {
            const view = result(mounted.container);
            const ref = factory.mock.calls.find(([, , options]) => options.pane === "result")![2]
                .scrollHandler;
            expect(ref?.current).toBeTypeOf("function");
            // CodeMirror only processes scroll requests for a nonzero editor height.
            // The workbench viewport deliberately retains jsdom's zero clientHeight.
            Object.defineProperty(view.scrollDOM, "clientHeight", { value: 80 });
            const handler = vi.fn(ref!.current!);
            Object.assign(ref!, { current: handler });
            act(() => view.dispatch({ effects: EditorView.scrollIntoView(view.state.doc.length) }));
            await act(async () => {
                await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
            });
            expect(handler.mock.calls[0][0]).toBe("result");
            expect(handler.mock.results[0].value).toBe(true);
            expect(mounted.container.querySelector(".merge-viewport")!.scrollTop).toBe(0);
        } finally {
            unmount(mounted.root, mounted.container);
        }
    });
    it("the find panel opens in the find host", () => {
        const mounted = mount(<MergeWorkbench data={data} />);
        try {
            click(mounted.container, "Find in result");
            expect(mounted.container.querySelector(".merge-find-host .cm-search")).not.toBeNull();
            expect(
                mounted.container.querySelector('[data-testid="merge-editor-1"] .cm-search'),
            ).toBeNull();
        } finally {
            unmount(mounted.root, mounted.container);
        }
    });
    it("rail marker click activates the hunk", () => {
        const mounted = mount(<MergeWorkbench data={twoActionData} />);
        try {
            const markers = mounted.container.querySelectorAll<HTMLButtonElement>(
                ".overview-marker.marker-conflict",
            );
            expect(markers).toHaveLength(2);
            act(() => markers[1].click());
            const hunks = result(mounted.container).state.field(workbenchHunks);
            for (const [pane, from, to] of [
                ["ours", "oursFrom", "oursTo"],
                ["result", "from", "to"],
                ["theirs", "theirsFrom", "theirsTo"],
            ] as const) {
                const host = mounted.container.querySelector(`.pane-${pane}`)!;
                const view = EditorView.findFromDOM(
                    host.querySelector<HTMLElement>(".cm-editor")!,
                )!;
                const lines = host.querySelectorAll(".cm-line");
                const rows = ownedLines(view.state.doc, hunks[1][from], hunks[1][to]);
                expect(rows.length).toBeGreaterThanOrEqual(2);
                expect(host.querySelectorAll(".cm-line.mrow-active")).toHaveLength(rows.length);
                for (const row of rows)
                    expect(lines[row - 1].classList.contains("mrow-active")).toBe(true);
                for (const row of ownedLines(view.state.doc, hunks[0][from], hunks[0][to]))
                    expect(lines[row - 1].classList.contains("mrow-active")).toBe(false);
            }
            expect(markers[1].getAttribute("aria-current")).toBe("true");
        } finally {
            unmount(mounted.root, mounted.container);
        }
    });
    it("has one vertical scroller", () => {
        const mounted = mount(<MergeWorkbench data={twoActionData} />);
        try {
            const container = mounted.container;
            expect(container.querySelectorAll(".merge-content")).toHaveLength(1);
            const columns = [
                ...container.querySelectorAll(".merge-content > .merge-viewport > .merge-col"),
            ];
            expect(columns).toHaveLength(3);
            expect(
                columns.map((col) =>
                    col.querySelector("[data-testid]")?.getAttribute("data-testid"),
                ),
            ).toEqual(["merge-editor-0", "merge-editor-1", "merge-editor-2"]);
            expect(
                columns.map((col) =>
                    col.firstElementChild?.classList.contains(
                        ["pane-ours", "pane-result", "pane-theirs"][columns.indexOf(col)],
                    ),
                ),
            ).toEqual([true, true, true]);
            for (const scroller of container.querySelectorAll(".cm-scroller")) {
                const style = getComputedStyle(scroller);
                expect(style.overflow).toBe("hidden");
                expect(["auto", "scroll"]).not.toContain(style.overflowY);
            }
            expect(container.querySelector(".mw-panes")).toBeNull();
            expect(container.querySelector(".mw-connectors")).toBeNull();
        } finally {
            unmount(mounted.root, mounted.container);
        }
    });
    it("translates the columns from the shared scroll position", async () => {
        const { buildVerticalLayout, paneOffsetForCanonical, LINE_HEIGHT_PX } =
            await import("../../../src/webviews/react/diff-core/mergeScrollLayout");
        const { layoutSegments } =
            await import("../../../src/webviews/react/merge-editor/workbenchLayout");
        const { groupingField } =
            await import("../../../src/webviews/react/merge-editor/workbenchModel");
        const { MERGE_PANES } =
            await import("../../../src/webviews/react/merge-editor/mergeRibbons");
        const frames = new Map<number, FrameRequestCallback>();
        let nextFrame = 0;
        vi.stubGlobal(
            "requestAnimationFrame",
            vi.fn((callback: FrameRequestCallback) => {
                frames.set(++nextFrame, callback);
                return nextFrame;
            }),
        );
        vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
        const flush = () => {
            const pending = [...frames.values()];
            frames.clear();
            act(() => pending.forEach((callback) => callback(0)));
        };
        const mounted = mount(<MergeWorkbench data={scrollData} />);
        try {
            const { state } = result(mounted.container);
            const info = layoutSegments(
                state.field(groupingField).segments,
                state.field(workbenchHunks),
                state.doc,
            );
            const layout = buildVerticalLayout(info.paneLines, MERGE_PANES);
            expect(MERGE_PANES.map((pane) => layout.paneHPx[pane][1])).toEqual(
                [1, 2, 3].map((rows) => rows * LINE_HEIGHT_PX),
            );
            flush();
            const content = mounted.container.querySelector<HTMLDivElement>(".merge-content")!;
            const viewport = mounted.container.querySelector<HTMLDivElement>(".merge-viewport")!;
            const columns = [...viewport.querySelectorAll<HTMLDivElement>(".merge-col")];
            viewport.scrollTop = 12;
            viewport.scrollLeft = 7;
            columns.forEach((col) => {
                col.scrollTop = 9;
                col.scrollLeft = 4;
            });
            content.scrollTop = layout.canonicalTopPx[1] + layout.canonicalHPx[1] / 2;
            const framesBeforeScroll = frames.size;
            act(() => content.dispatchEvent(new Event("scroll")));
            act(() => content.dispatchEvent(new Event("scroll")));
            expect(frames.size).toBe(framesBeforeScroll + 1);
            flush();
            MERGE_PANES.forEach((pane, index) => {
                expect(columns[index].style.transform).toBe(
                    `translateY(${-paneOffsetForCanonical(layout, pane, content.scrollTop)}px)`,
                );
                expect(columns[index].scrollTop).toBe(0);
                expect(columns[index].scrollLeft).toBe(0);
            });
            expect(viewport.scrollTop).toBe(0);
            expect(viewport.scrollLeft).toBe(0);
        } finally {
            unmount(mounted.root, mounted.container);
        }
    });
});

function click(container: HTMLElement, label: string) {
    const button =
        container.querySelector<HTMLButtonElement>(
            `.merge-toolbar button[aria-label="${label}"]`,
        ) ??
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

const regroupVersions = {
    base: "head\nb\nkeep\nbase one\nbase two\ntail\n",
    ours: "head\n  b\nkeep\nours one\nours two\ntail\n",
    theirs: "head\nb\nkeep\ntheirs one\ntheirs two\ntail\n",
};
const regroupData = {
    ...data,
    segments: parseConflictVersions(
        regroupVersions.base,
        regroupVersions.ours,
        regroupVersions.theirs,
    ),
    workbench: { ...data.workbench, ...regroupVersions },
};
function expectActiveRows(container: HTMLElement, index: number | null, minRows = 2) {
    const hunk = index === null ? undefined : result(container).state.field(workbenchHunks)[index];
    for (const [pane, from, to] of [
        ["ours", "oursFrom", "oursTo"],
        ["result", "from", "to"],
        ["theirs", "theirsFrom", "theirsTo"],
    ] as const) {
        const host = container.querySelector(`.pane-${pane}`)!;
        if (!hunk) {
            expect(host.querySelectorAll(".mrow-active").length, `${pane} clears active rows`).toBe(
                0,
            );
            continue;
        }
        const view = EditorView.findFromDOM(host.querySelector<HTMLElement>(".cm-editor")!)!;
        const rows = ownedLines(view.state.doc, hunk[from], hunk[to]);
        expect(rows.length).toBeGreaterThanOrEqual(pane === "result" ? minRows : 2);
        expect(
            host.querySelectorAll(".cm-line.mrow-active").length,
            `${pane} active owned row count for hunk ${index}`,
        ).toBe(rows.length);
        const lines = [...host.querySelectorAll(".cm-line")];
        expect(lines.filter((line) => line.classList.contains("mrow-active"))).toEqual(
            rows.map((row) => lines[row - 1]),
        );
    }
    expect(
        container.querySelector<HTMLButtonElement>('[aria-label="Confirm manual resolution"]')!
            .disabled,
    ).toBe(index === null);
    expect(
        container.querySelector<HTMLSelectElement>('[aria-label="Resolve change"]')!.disabled,
    ).toBe(index === null);
}

function ignoreSelect(container: HTMLElement) {
    return container.querySelector<HTMLSelectElement>(
        `[aria-label="${t("merge.toolbar.ignoreMode.title")}"]`,
    )!;
}
function changeIgnoreMode(container: HTMLElement, mode: "none" | "whitespace") {
    const select = ignoreSelect(container);
    act(() => {
        select.value = mode;
        select.dispatchEvent(new Event("change", { bubbles: true }));
    });
}
function whitespaceSegments(input = regroupData) {
    const { base, ours, theirs } = input.workbench;
    return parseConflictVersions(base, ours, theirs, { ignoreWhitespace: true });
}

describe("live whitespace toolbar", () => {
    it("whitespace mode regroups a pristine result in one undo step", () => {
        const fresh = buildWorkbenchDocument({ ...regroupData, segments: whitespaceSegments() });
        const mounted = mount(<MergeWorkbench data={regroupData} />);
        try {
            const view = result(mounted.container);
            expect(view.state.field(workbenchHunks)).toHaveLength(2);
            expect(fresh.hunks).toHaveLength(1);
            changeIgnoreMode(mounted.container, "whitespace");
            expect(view.state.field(workbenchHunks)).toHaveLength(fresh.hunks.length);
            expect(view.state.doc.toString()).toBe(fresh.content);
            expect(undoDepth(view.state)).toBe(1);
            expect(ignoreSelect(mounted.container).value).toBe("whitespace");
        } finally {
            unmount(mounted.root, mounted.container);
        }
    });
    it("whitespace mode asks before replacing an edited result", () => {
        const mounted = mount(<MergeWorkbench data={regroupData} />);
        try {
            const view = result(mounted.container);
            act(() =>
                view.dispatch({
                    changes: { from: 1, insert: "typed edit" },
                    userEvent: "input.type",
                }),
            );
            const edited = view.state.doc.toString();
            changeIgnoreMode(mounted.container, "whitespace");
            const notice = mounted.container.querySelector(".merge-notice-regroup");
            expect(notice, "edited result requires a regroup notice").not.toBeNull();
            expect(notice!.getAttribute("role")).toBe("alert");
            expect(notice!.textContent).toContain(
                "Changing whitespace handling rebuilds the result. Your edits and decisions are replaced (Undo restores them).",
            );
            expect(view.state.doc.toString()).toBe(edited);
            expect(ignoreSelect(mounted.container).value).toBe("none");
            click(mounted.container, "Keep current result");
            expect(mounted.container.querySelector(".merge-notice-regroup")).toBeNull();
            expect(ignoreSelect(mounted.container).value).toBe("none");
            expect(view.state.doc.toString()).toBe(edited);
            changeIgnoreMode(mounted.container, "whitespace");
            click(mounted.container, "Rebuild result");
            expect(view.state.doc.toString()).toBe(
                buildWorkbenchDocument({ ...regroupData, segments: whitespaceSegments() }).content,
            );
            expect(view.state.field(workbenchHunks)).toHaveLength(1);
            expect(mounted.container.querySelector(".merge-notice-regroup")).toBeNull();
            expect(ignoreSelect(mounted.container).value).toBe("whitespace");
            click(mounted.container, "Undo");
            expect(view.state.doc.toString()).toBe(edited);
            expect(ignoreSelect(mounted.container).value).toBe("none");
        } finally {
            unmount(mounted.root, mounted.container);
        }
    });
    it("undo after a regroup snaps the select back", () => {
        const mounted = mount(<MergeWorkbench data={regroupData} />);
        try {
            changeIgnoreMode(mounted.container, "whitespace");
            expect(ignoreSelect(mounted.container).value).toBe("whitespace");
            click(mounted.container, "Undo");
            expect(ignoreSelect(mounted.container).value, "Undo restores the select to none").toBe(
                "none",
            );
            click(mounted.container, "Redo");
            expect(ignoreSelect(mounted.container).value).toBe("whitespace");
        } finally {
            unmount(mounted.root, mounted.container);
        }
    });
    it("details counts follow the regrouped segments", () => {
        const versions = {
            ...regroupVersions,
            theirs: regroupVersions.theirs.replace("\nb\n", "\n b\n"),
        };
        const input = {
            ...regroupData,
            workbench: { ...regroupData.workbench, ...versions },
            segments: parseConflictVersions(versions.base, versions.ours, versions.theirs),
        };
        const segments = whitespaceSegments(input);
        const mounted = mount(<MergeWorkbench data={input} />);
        try {
            click(mounted.container, t("merge.toolbar.showDetails"));
            for (const side of ["ours", "theirs"] as const)
                expect(paneChangeCount(segments, side)).not.toBe(
                    paneChangeCount(input.segments, side),
                );
            changeIgnoreMode(mounted.container, "whitespace");
            const counts = mounted.container.querySelectorAll(".pane-meta-counts");
            for (const [index, side] of (["ours", "theirs"] as const).entries()) {
                expect(counts[index].parentElement!.hidden).toBe(false);
                expect(counts[index].textContent, `${side} uses regrouped pane counts`).toBe(
                    `${t("merge.count.changes", { count: paneChangeCount(segments, side) })}, ${t("merge.count.conflicts", { count: 1 })}`,
                );
            }
        } finally {
            unmount(mounted.root, mounted.container);
        }
    });
    it("save after undo of a regroup writes the restored mode", () => {
        const mounted = mount(<MergeWorkbench data={regroupData} />);
        try {
            const view = result(mounted.container);
            const ids = view.state.field(workbenchHunks).map(({ id }) => id);
            changeIgnoreMode(mounted.container, "whitespace");
            expect(ignoreSelect(mounted.container).value).toBe("whitespace");
            click(mounted.container, "Undo");
            act(() => window.dispatchEvent(new Event("pagehide")));
            const saved = api.postMessage.mock.calls
                .filter(([message]) => message.type === "saveMergeDraft")
                .at(-1)![0];
            expect(saved.draft.ignoreWhitespace).toBe(false);
            expect(saved.draft.hunks.map(({ id }: { id: string }) => id)).toEqual(ids);
        } finally {
            unmount(mounted.root, mounted.container);
        }
    });
    it("restoring a draft in the other whitespace mode activates its first conflict", () => {
        const versions = {
            base: "base one\nbase two\nkeep\nb",
            ours: "ours one\nours two\nkeep\n  b",
            theirs: "theirs one\ntheirs two\nkeep\nb",
        };
        const input = {
            ...regroupData,
            ...detectEolMetadata(versions.ours),
            workbench: { ...regroupData.workbench, ...versions },
            segments: parseConflictVersions(versions.base, versions.ours, versions.theirs),
        };
        const built = buildWorkbenchDocument({ ...input, segments: whitespaceSegments(input) });
        expect(buildWorkbenchDocument(input).hunks[0].from).toBe(0);
        expect(built.hunks[0].from).toBe(0);
        api.getState.mockReturnValue({
            snapshotId: input.workbench.snapshotId,
            ignoreWhitespace: true,
            content: built.content,
            hunks: built.hunks.map(({ id, from, to, resolved }) => ({ id, from, to, resolved })),
        });
        const mounted = mount(<MergeWorkbench data={input} />);
        try {
            expect(ignoreSelect(mounted.container).value).toBe("whitespace");
            expect(result(mounted.container).state.doc.toString()).toBe(built.content);
            expectActiveRows(mounted.container, 0);
        } finally {
            unmount(mounted.root, mounted.container);
        }
    });
    it("whitespace-mode draft restore selects the first unresolved unedited conflict", () => {
        const versions = {
            base: "head\nbase one\nbase two\nkeep\nbase three\nbase four\ntail\nb\n",
            ours: "head\nours one\nours two\nkeep\nours three\nours four\ntail\n  b\n",
            theirs: "head\ntheirs one\ntheirs two\nkeep\ntheirs three\ntheirs four\ntail\nb\n",
        };
        const input = {
            ...data,
            segments: parseConflictVersions(versions.base, versions.ours, versions.theirs),
            workbench: { ...data.workbench, ...versions },
        };
        const built = buildWorkbenchDocument({ ...input, segments: whitespaceSegments(input) });
        expect(built.hunks).toHaveLength(2);
        api.getState.mockReturnValue({
            snapshotId: input.workbench.snapshotId,
            ignoreWhitespace: true,
            content: built.content,
            hunks: built.hunks.map(({ id, from, to, resolved }, index) => ({
                id,
                from,
                to,
                resolved,
                edited: index === 0,
            })),
        });
        const mounted = mount(<MergeWorkbench data={input} />);
        try {
            expect(ignoreSelect(mounted.container).value).toBe("whitespace");
            expectActiveRows(mounted.container, 1);
        } finally {
            unmount(mounted.root, mounted.container);
        }
    });
    it("same-mode draft restore keeps a later user-selected conflict active", () => {
        const built = buildWorkbenchDocument(twoActionData);
        const mounted = mount(<MergeWorkbench data={twoActionData} />);
        try {
            const markers = () =>
                mounted.container.querySelectorAll<HTMLButtonElement>(".overview-marker");
            act(() => markers()[1].click());
            expectActiveRows(mounted.container, 1);
            act(() =>
                window.dispatchEvent(
                    new MessageEvent("message", {
                        data: {
                            type: "mergeDraft",
                            draft: {
                                snapshotId: twoActionData.workbench.snapshotId,
                                ignoreWhitespace: false,
                                content: built.content,
                                hunks: built.hunks.map(({ id, from, to, resolved }, index) => ({
                                    id,
                                    from,
                                    to,
                                    resolved,
                                    edited: index === 1,
                                })),
                            },
                        },
                    }),
                ),
            );
            expect(result(mounted.container).state.field(workbenchHunks)[1].edited).toBe(true);
            expectActiveRows(mounted.container, 1);
            expect(markers()[1].getAttribute("aria-current")).toBe("true");
        } finally {
            unmount(mounted.root, mounted.container);
        }
    });
    it("first conflict is active at load in the rail, rows and toolbar", () => {
        const mounted = mount(<MergeWorkbench data={twoActionData} />);
        try {
            expectActiveRows(mounted.container, 0);
            expect(
                mounted.container
                    .querySelectorAll(".overview-marker")[0]
                    .getAttribute("aria-current"),
            ).toBe("true");
        } finally {
            unmount(mounted.root, mounted.container);
        }
    });
    it("the regroup notice is frozen while Apply is in flight", () => {
        const mounted = mount(<MergeWorkbench data={regroupData} />);
        try {
            const view = result(mounted.container);
            click(mounted.container, "Accept All Yours");
            changeIgnoreMode(mounted.container, "whitespace");
            expect(mounted.container.querySelector(".merge-notice-regroup")).not.toBeNull();
            click(mounted.container, "Apply");
            expect(view.contentDOM.getAttribute("contenteditable")).toBe("false");
            const posted = view.state.doc.toString();
            const buttons = [
                ...mounted.container.querySelectorAll<HTMLButtonElement>(
                    ".merge-notice-regroup button",
                ),
            ];
            for (const label of ["Rebuild result", "Keep current result"])
                expect(
                    buttons.find((button) => button.textContent === label)!.disabled,
                    `${label} is disabled during Apply`,
                ).toBe(true);
            click(mounted.container, "Rebuild result");
            expect(view.state.doc.toString(), "Rebuild during Apply leaves the result").toBe(
                posted,
            );
        } finally {
            unmount(mounted.root, mounted.container);
        }
    });
    it("undo back to the pending mode closes the regroup notice", () => {
        const mounted = mount(<MergeWorkbench data={regroupData} />);
        try {
            const view = result(mounted.container);
            act(() =>
                view.dispatch({ changes: { from: 1, insert: "E1" }, userEvent: "input.type" }),
            );
            const e1 = view.state.doc.toString();
            changeIgnoreMode(mounted.container, "whitespace");
            click(mounted.container, "Rebuild result");
            act(() =>
                view.dispatch({ changes: { from: 0, insert: "E2" }, userEvent: "input.type" }),
            );
            changeIgnoreMode(mounted.container, "none");
            expect(mounted.container.querySelector(".merge-notice-regroup")).not.toBeNull();
            click(mounted.container, "Undo");
            click(mounted.container, "Undo");
            expect(ignoreSelect(mounted.container).value).toBe("none");
            expect(view.state.doc.toString()).toBe(e1);
            expect(
                mounted.container.querySelector(".merge-notice-regroup"),
                "the notice closes once the mode matches the pending choice",
            ).toBeNull();
            click(mounted.container, "Redo");
            expect(ignoreSelect(mounted.container).value).toBe("whitespace");
            expect(
                mounted.container.querySelector(".merge-notice-regroup"),
                "Redo does not bring back a stale notice",
            ).toBeNull();
        } finally {
            unmount(mounted.root, mounted.container);
        }
    });
    it("redo to the pending whitespace mode closes the regroup notice", () => {
        const mounted = mount(<MergeWorkbench data={regroupData} />);
        try {
            const view = result(mounted.container);
            act(() =>
                view.dispatch({ changes: { from: 1, insert: "E1" }, userEvent: "input.type" }),
            );
            const e1 = view.state.doc.toString();
            changeIgnoreMode(mounted.container, "whitespace");
            click(mounted.container, "Rebuild result");
            const rebuilt = view.state.doc.toString();
            click(mounted.container, "Undo");
            expect(view.state.doc.toString()).toBe(e1);
            changeIgnoreMode(mounted.container, "whitespace");
            expect(mounted.container.querySelector(".merge-notice-regroup")).not.toBeNull();
            click(mounted.container, "Redo");
            expect(ignoreSelect(mounted.container).value).toBe("whitespace");
            expect(view.state.doc.toString()).toBe(rebuilt);
            expect(
                mounted.container.querySelector(".merge-notice-regroup"),
                "the notice closes once Redo reaches the pending whitespace mode",
            ).toBeNull();
            click(mounted.container, "Undo");
            expect(view.state.doc.toString(), "the typed edit is intact").toBe(e1);
        } finally {
            unmount(mounted.root, mounted.container);
        }
    });
    it("a late draft in the other whitespace mode activates its first conflict", () => {
        const built = buildWorkbenchDocument({ ...regroupData, segments: whitespaceSegments() });
        const mounted = mount(<MergeWorkbench data={regroupData} />);
        try {
            const view = result(mounted.container);
            act(() =>
                view.dispatch({ selection: { anchor: view.state.field(workbenchHunks)[0].from } }),
            );
            expect(
                mounted.container.querySelector<HTMLButtonElement>(
                    '[aria-label="Confirm manual resolution"]',
                )!.disabled,
                "the caret activates hunk 0 before the late draft",
            ).toBe(false);
            receive({
                type: "mergeDraft",
                draft: {
                    snapshotId: regroupData.workbench.snapshotId,
                    ignoreWhitespace: true,
                    content: built.content,
                    hunks: built.hunks.map(({ id, from, to, resolved }) => ({
                        id,
                        from,
                        to,
                        resolved,
                    })),
                },
            });
            expect(ignoreSelect(mounted.container).value).toBe("whitespace");
            expect(view.state.doc.toString()).toBe(built.content);
            expectActiveRows(mounted.container, 0);
        } finally {
            unmount(mounted.root, mounted.container);
        }
    });
});

describe("reversible grouping and caret activation", () => {
    it("a draft carries its whitespace mode", () => {
        const segments = parseConflictVersions(
            regroupVersions.base,
            regroupVersions.ours,
            regroupVersions.theirs,
            { ignoreWhitespace: true },
        );
        const built = buildWorkbenchDocument({ ...regroupData, segments });
        expect(built.hunks).toHaveLength(1);
        expect(buildWorkbenchDocument(regroupData).hunks).toHaveLength(2);
        const draft = {
            snapshotId: data.workbench.snapshotId,
            ignoreWhitespace: true,
            content: built.content + "draft text\n",
            hunks: built.hunks.map(({ id, from, to, resolved }) => ({ id, from, to, resolved })),
        };
        api.getState.mockReturnValue(draft);
        const mounted = mount(<MergeWorkbench data={regroupData} />);
        try {
            const view = result(mounted.container);
            expect(
                mounted.container.querySelector<HTMLSelectElement>(
                    `[aria-label="${t("merge.toolbar.ignoreMode.title")}"]`,
                )!.value,
            ).toBe("whitespace");
            expect(view.state.field(workbenchHunks).map(({ id }) => id)).toEqual(
                built.hunks.map(({ id }) => id),
            );
            expect(view.state.doc.toString()).toBe(draft.content);
            expect(view.state.field(groupingField)).toEqual({ ignoreWhitespace: true, segments });
            expect(undoDepth(view.state)).toBe(0);
            expect(api.setState).toHaveBeenCalledExactlyOnceWith(draft);
            expect(
                api.postMessage.mock.calls.filter(([message]) => message.type === "saveMergeDraft"),
            ).toHaveLength(0);
        } finally {
            unmount(mounted.root, mounted.container);
        }
    });
    it("a draft in the other whitespace mode with stale hunk ids is not applied", () => {
        const initial = buildWorkbenchDocument(regroupData);
        api.getState.mockReturnValue({
            snapshotId: data.workbench.snapshotId,
            ignoreWhitespace: true,
            content: initial.content + "stale draft\n",
            hunks: initial.hunks.map(({ id, from, to, resolved }) => ({ id, from, to, resolved })),
        });
        const mounted = mount(<MergeWorkbench data={regroupData} />);
        try {
            const view = result(mounted.container);
            expect(view.state.doc.toString()).toBe(initial.content);
            expect(
                mounted.container.querySelector<HTMLSelectElement>(
                    `[aria-label="${t("merge.toolbar.ignoreMode.title")}"]`,
                )!.value,
            ).toBe("none");
            expect(view.state.field(workbenchHunks)).toEqual(initial.hunks);
            expect(view.state.field(groupingField).segments).toBe(regroupData.segments);
            expect(api.setState).not.toHaveBeenCalled();
        } finally {
            unmount(mounted.root, mounted.container);
        }
    });
    it("pristine reports false after an edit, a decision or a dismissal", () => {
        const mounted = mount(<MergeWorkbench data={actionData} />);
        try {
            const view = result(mounted.container);
            const pristine = () => isPristineState(view.state, actionData);
            expect(pristine()).toBe(true);
            act(() =>
                view.dispatch({
                    changes: { from: 1, insert: "common edit" },
                    userEvent: "input.type",
                }),
            );
            expect(view.state.field(workbenchHunks).every((hunk) => !hunk.edited)).toBe(true);
            expect(pristine()).toBe(false);
            act(() => {
                expect(undo(view)).toBe(true);
            });
            expect(pristine()).toBe(true);
            act(() =>
                mounted.container
                    .querySelector<HTMLButtonElement>(".pane-ours .accept-btn")!
                    .click(),
            );
            expect(pristine()).toBe(false);
            act(() => {
                expect(undo(view)).toBe(true);
            });
            expect(pristine()).toBe(true);
            act(() =>
                mounted.container
                    .querySelector<HTMLButtonElement>(".pane-theirs .discard-btn")!
                    .click(),
            );
            expect(view.state.field(workbenchHunks)[0].dismissed.theirs).toBe(true);
            expect(pristine()).toBe(false);
            act(() => {
                expect(undo(view)).toBe(true);
            });
            expect(pristine()).toBe(true);
        } finally {
            unmount(mounted.root, mounted.container);
        }
    });
    it("pristine compares with the current grouping after a regroup", () => {
        const mounted = mount(<MergeWorkbench data={regroupData} />);
        try {
            const view = result(mounted.container);
            act(() => view.dispatch(regroupSpec(view.state, regroupData, true, { history: true })));
            expect(isPristineState(view.state, regroupData)).toBe(true);
        } finally {
            unmount(mounted.root, mounted.container);
        }
    });
    it("placing the caret inside a hunk activates it in all three panes", () => {
        const mounted = mount(<MergeWorkbench data={twoActionData} />);
        try {
            const view = result(mounted.container);
            const second = view.state.field(workbenchHunks)[1];
            expect(second.conflict).toBe(true);
            act(() =>
                view.dispatch({ selection: { anchor: view.state.doc.lineAt(second.from).to + 2 } }),
            );
            expectActiveRows(mounted.container, 1);
        } finally {
            unmount(mounted.root, mounted.container);
        }
    });
    it("moving the caret into common text keeps the previous active hunk", () => {
        const mounted = mount(<MergeWorkbench data={twoActionData} />);
        try {
            const view = result(mounted.container);
            act(() =>
                mounted.container
                    .querySelectorAll<HTMLButtonElement>(".overview-marker")[1]
                    .click(),
            );
            expectActiveRows(mounted.container, 1);
            act(() => view.dispatch({ selection: { anchor: 1 } }));
            expectActiveRows(mounted.container, 1);
        } finally {
            unmount(mounted.root, mounted.container);
        }
    });
    it("an activation is not undone by its own selection change", () => {
        const third = {
            base: twoActionVersions.base + "base five\nbase six\nend\n",
            ours: twoActionVersions.ours + "ours five\nours six\nend\n",
            theirs: twoActionVersions.theirs + "theirs five\ntheirs six\nend\n",
        };
        const input = {
            ...data,
            segments: parseConflictVersions(third.base, third.ours, third.theirs),
            workbench: { ...data.workbench, ...third },
        };
        const mounted = mount(<MergeWorkbench data={input} />);
        try {
            const view = result(mounted.container);
            expect(view.state.field(workbenchHunks)).toHaveLength(3);
            act(() =>
                view.dispatch({
                    selection: { anchor: view.state.field(workbenchHunks)[0].from + 1 },
                }),
            );
            expectActiveRows(mounted.container, 0);
            act(() =>
                mounted.container
                    .querySelectorAll<HTMLButtonElement>(".pane-ours .accept-btn")[1]
                    .click(),
            );
            expectActiveRows(mounted.container, 1);
            const caret = view.state.selection.main.head;
            act(() =>
                mounted.container
                    .querySelectorAll<HTMLButtonElement>(".overview-marker")[2]
                    .click(),
            );
            expectActiveRows(mounted.container, 2);
            expect(view.state.selection.main.head).toBe(caret);
            act(() => {
                expect(undo(view)).toBe(true);
            });
            act(() =>
                mounted.container
                    .querySelectorAll<HTMLButtonElement>(".overview-marker")[0]
                    .click(),
            );
            act(() =>
                document.body.dispatchEvent(
                    new KeyboardEvent("keydown", {
                        key: "ArrowLeft",
                        ctrlKey: true,
                        bubbles: true,
                        cancelable: true,
                    }),
                ),
            );
            expect(view.state.field(workbenchHunks)[0].decision).toBe("ours");
            expectActiveRows(mounted.container, 1);
        } finally {
            unmount(mounted.root, mounted.container);
        }
    });
    it("a regroup recomputes the active hunk from the caret", () => {
        const versions = {
            base: regroupVersions.base.replace("\ntail\n", ""),
            ours: regroupVersions.ours.replace("\ntail\n", ""),
            theirs: regroupVersions.theirs.replace("\ntail\n", ""),
        };
        const input = {
            ...regroupData,
            hasTrailingNewline: false,
            segments: parseConflictVersions(versions.base, versions.ours, versions.theirs),
            workbench: { ...data.workbench, ...versions },
        };
        const mounted = mount(<MergeWorkbench data={input} />);
        try {
            const view = result(mounted.container);
            const original = view.state.field(workbenchHunks)[1];
            act(() => view.dispatch({ selection: { anchor: original.to } }));
            expectActiveRows(mounted.container, 1);
            // A whole-document replacement maps the caret to EOF, inside this last hunk.
            // No explicit selection: the grouping-change trigger must recompute the index.
            const transaction = view.state.update(
                regroupSpec(view.state, input, true, { history: true }),
            );
            expect(transaction.selection).toBeUndefined();
            act(() => view.dispatch(transaction));
            expect(view.state.field(workbenchHunks)).toHaveLength(1);
            expectActiveRows(mounted.container, 0);
            act(() => {
                expect(undo(view)).toBe(true);
            });
            expectActiveRows(mounted.container, 1);
        } finally {
            unmount(mounted.root, mounted.container);
        }
    });
    it("regroup drops an in-range index naming a different hunk through toggle undo and redo", () => {
        const versions = {
            base: "head\nb\nkeep\nbase one\nbase two\nkeep two\nbase three\nbase four\ntail\n",
            ours: "head\n  b\nkeep\nours one\nours two\nkeep two\nours three\nours four\ntail\n",
            theirs: "head\nb\nkeep\ntheirs one\ntheirs two\nkeep two\ntheirs three\ntheirs four\ntail\n",
        };
        const input = {
            ...data,
            segments: parseConflictVersions(versions.base, versions.ours, versions.theirs),
            workbench: { ...data.workbench, ...versions },
        };
        const mounted = mount(<MergeWorkbench data={input} />);
        try {
            const view = result(mounted.container);
            const markers = () =>
                mounted.container.querySelectorAll<HTMLButtonElement>(".overview-marker");
            expect(view.state.field(workbenchHunks)).toHaveLength(3);
            const oldSecond = view.state.field(workbenchHunks)[1].segment.oursLines;
            act(() => markers()[1].click());
            act(() => view.dispatch({ selection: { anchor: 1 } }));
            expectActiveRows(mounted.container, 1);
            changeIgnoreMode(mounted.container, "whitespace");
            expect(view.state.field(workbenchHunks)).toHaveLength(2);
            expect(view.state.field(workbenchHunks)[1].segment.oursLines).not.toEqual(oldSecond);
            expectActiveRows(mounted.container, 0);
            expect(markers()[0].getAttribute("aria-current")).toBe("true");
            click(mounted.container, "Undo");
            expect(view.state.field(workbenchHunks)).toHaveLength(3);
            expectActiveRows(mounted.container, 1);
            expect(markers()[1].getAttribute("aria-current")).toBe("true");
            click(mounted.container, "Redo");
            expect(view.state.field(workbenchHunks)).toHaveLength(2);
            expectActiveRows(mounted.container, 0);
            expect(markers()[0].getAttribute("aria-current")).toBe("true");
        } finally {
            unmount(mounted.root, mounted.container);
        }
    });
    it("regroup and redo replace a stale active index while the caret is in common text", () => {
        const mounted = mount(<MergeWorkbench data={regroupData} />);
        try {
            const view = result(mounted.container);
            const markers = () =>
                mounted.container.querySelectorAll<HTMLButtonElement>(".overview-marker");
            act(() => markers()[1].click());
            act(() => view.dispatch({ selection: { anchor: 1 } }));
            expectActiveRows(mounted.container, 1);
            act(() => view.dispatch(regroupSpec(view.state, regroupData, true, { history: true })));
            expect(view.state.field(workbenchHunks)).toHaveLength(1);
            expectActiveRows(mounted.container, 0);
            act(() => {
                expect(undo(view)).toBe(true);
            });
            expect(view.state.field(workbenchHunks)).toHaveLength(2);
            // Undo regroups too: index 0 is one-sided, so main's pick is conflict 1.
            expect(markers()[1].getAttribute("aria-current")).toBe("true");
            expectActiveRows(mounted.container, 1);
            act(() => markers()[1].click());
            act(() => {
                expect(redo(view)).toBe(true);
            });
            expectActiveRows(mounted.container, 0);
        } finally {
            unmount(mounted.root, mounted.container);
        }
    });
    it("caret leaving a one-sided hunk keeps that previous hunk active", () => {
        const mounted = mount(<MergeWorkbench data={regroupData} />);
        try {
            const view = result(mounted.container);
            const oneSided = view.state.field(workbenchHunks)[0];
            expect(oneSided.conflict).toBe(false);
            act(() => view.dispatch({ selection: { anchor: oneSided.from } }));
            act(() => view.dispatch({ selection: { anchor: 1 } }));
            expect(
                mounted.container
                    .querySelectorAll(".overview-marker")[0]
                    .getAttribute("aria-current"),
            ).toBe("true");
            expect(
                mounted.container.querySelector<HTMLButtonElement>(
                    '[aria-label="Confirm manual resolution"]',
                )!.disabled,
            ).toBe(false);
        } finally {
            unmount(mounted.root, mounted.container);
        }
    });
    it("a resolve at a mid-line hunk boundary keeps the resolved hunk active", () => {
        const mounted = mount(<MergeWorkbench data={actionData} />);
        try {
            const view = result(mounted.container);
            const from = view.state.field(workbenchHunks)[0].from;
            act(() =>
                view.dispatch({
                    changes: { from: from - 1, to: from },
                    userEvent: "delete.backward",
                }),
            );
            act(() =>
                mounted.container
                    .querySelector<HTMLButtonElement>(".pane-ours .accept-btn")!
                    .click(),
            );
            const target = view.state.field(workbenchHunks)[0];
            expect(target.decision).toBe("ours");
            expect(view.state.selection.main.head).toBe(target.from);
            expect(view.state.doc.lineAt(target.from).from).toBeLessThan(target.from);
            // The accept's own caret sits on the preceding common row; it must not undo the activation.
            // The glued first line leaves the result one owned row, so only that pane drops to 1.
            expectActiveRows(mounted.container, 0, 1);
        } finally {
            unmount(mounted.root, mounted.container);
        }
    });
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
            act(() => actionButton(mounted.container, ".overview-marker").click());
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
    it("unifies side choices, manual editing and confirmations in undo/redo", () => {
        const mounted = mount(<MergeWorkbench data={data} />);
        const view = result(mounted.container);
        act(() => actionButton(mounted.container, ".pane-ours .accept-btn").click());
        expect(view.state.doc.toString()).toContain("ours");
        click(mounted.container, "Undo");
        expect(view.state.doc.toString()).toContain("base");
        click(mounted.container, "Redo");
        expect(view.state.doc.toString()).toContain("ours");
        act(() => view.dispatch({ changes: { from: 0, insert: "manual\n" } }));
        click(mounted.container, "Confirm manual resolution");
        click(mounted.container, "Undo");
        click(mounted.container, "Base");
        expect(mounted.container.querySelector(".merge-base")?.hasAttribute("hidden")).toBe(false);
        click(mounted.container, "Find in result");
        expect(mounted.container.querySelector(".cm-search")).not.toBeNull();
        act(() => actionButton(mounted.container, ".pane-theirs .accept-btn").click());
        expect(view.state.doc.toString()).toContain("theirs");
        unmount(mounted.root, mounted.container);
    });
    it.each(["both", "both-reversed", "base", "none"])(
        "applies the %s decision and allows undo",
        (choice) => {
            const mounted = mount(<MergeWorkbench data={data} />);
            act(() => actionButton(mounted.container, ".overview-marker").click());
            const select = mounted.container.querySelector<HTMLSelectElement>(
                'select[aria-label="Resolve change"]',
            )!;
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
        act(() => actionButton(mounted.container, ".pane-ours .accept-btn").click());
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
        click(mounted.container, "Conflicts");
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
            act(() => actionButton(mounted.container, ".overview-marker").click());
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
                mounted.container.querySelectorAll<HTMLButtonElement>(".overview-marker");
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
            act(() => actionButton(mounted.container, ".pane-ours .accept-btn").click());
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

describe("classic workbench chrome", () => {
    it("footer Use File Ours posts acceptYours", () => {
        const mounted = mount(<MergeWorkbench data={data} />);
        try {
            click(mounted.container, "Use File Ours");
            expect(api.postMessage).toHaveBeenCalledWith({ type: "acceptYours" });
            click(mounted.container, "Use File Theirs");
            expect(api.postMessage).toHaveBeenCalledWith({ type: "acceptTheirs" });
            click(mounted.container, t("merge.action.abortMerge"));
            expect(api.postMessage).toHaveBeenCalledWith({ type: "abortMerge" });
        } finally {
            unmount(mounted.root, mounted.container);
        }
    });

    it("accept all ours is one undo step", () => {
        const mounted = mount(<MergeWorkbench data={twoActionData} />);
        try {
            const view = result(mounted.container);
            const before = view.state.doc.toString();
            click(mounted.container, "Accept All Yours");
            expect(view.state.doc.toString()).toBe(twoActionVersions.ours);
            expect(view.state.field(workbenchHunks).every((hunk) => hunk.resolved)).toBe(true);
            expect(undoDepth(view.state), "accept all must be a single history entry").toBe(1);
            click(mounted.container, "Undo");
            expect(view.state.doc.toString()).toBe(before);
            expect(view.state.field(workbenchHunks).every((hunk) => !hunk.resolved)).toBe(true);
            click(mounted.container, "Accept All Theirs");
            click(mounted.container, "Accept All Yours");
            expect(view.state.doc.toString()).toBe(twoActionVersions.ours);
        } finally {
            unmount(mounted.root, mounted.container);
        }
    });

    it("apply non-conflicting is one undo step", () => {
        const versions = { base: "a\nb\n", ours: "a\nB\n", theirs: "a\nb\n" };
        const segments = parseConflictVersions(versions.base, versions.ours, versions.theirs);
        expect(segments.filter((segment) => segment.type === "conflict")).toMatchObject([
            { changeKind: "ours-only" },
        ]);
        const mounted = mount(
            <MergeWorkbench
                data={{ ...data, segments, workbench: { ...data.workbench, ...versions } }}
            />,
        );
        try {
            const view = result(mounted.container);
            const before = view.state.doc.toString();
            const hunks = view.state.field(workbenchHunks);
            click(mounted.container, t("merge.toolbar.applyNonConflicting"));
            expect(view.state.doc.toString()).toBe(versions.ours);
            expect(view.state.field(workbenchHunks)[0].decision).toBe("ours");
            expect(undoDepth(view.state)).toBe(1);
            click(mounted.container, "Undo");
            expect(view.state.doc.toString()).toBe(before);
            expect(view.state.field(workbenchHunks)).toEqual(hunks);
            expect(actionButton(mounted.container, '[aria-label="Next conflict"]').disabled).toBe(
                true,
            );
            expect(
                actionButton(mounted.container, '[aria-label="Previous conflict"]').disabled,
            ).toBe(true);
        } finally {
            unmount(mounted.root, mounted.container);
        }
    });

    it("the wand adds no empty undo step when nothing is left to apply", () => {
        const versions = { base: "a\nb\n", ours: "a\nB\n", theirs: "a\nb\n" };
        const segments = parseConflictVersions(versions.base, versions.ours, versions.theirs);
        const mounted = mount(
            <MergeWorkbench
                data={{ ...data, segments, workbench: { ...data.workbench, ...versions } }}
            />,
        );
        try {
            const view = result(mounted.container);
            const wand = actionButton(
                mounted.container,
                `[aria-label="${t("merge.toolbar.applyNonConflicting")}"]`,
            );
            act(() => wand.click());
            expect(undoDepth(view.state)).toBe(1);
            const applied = view.state.doc.toString();
            expect(wand.disabled, "wand must disable after the last non-conflicting decision").toBe(
                true,
            );
            act(() => wand.click());
            expect(undoDepth(view.state), "disabled wand must not add an empty undo step").toBe(1);
            expect(view.state.doc.toString()).toBe(applied);
        } finally {
            unmount(mounted.root, mounted.container);
        }
    });

    it("show details reveals #merge-details with counts", () => {
        const mounted = mount(<MergeWorkbench data={twoActionData} />);
        try {
            const details = mounted.container.querySelector<HTMLElement>("#merge-details");
            expect(details).not.toBeNull();
            expect(details!.hidden).toBe(true);
            click(mounted.container, "Show Details");
            expect(details!.hidden).toBe(false);
            expect(details!.textContent).toContain(
                t("merge.header.conflictsResolved", { resolved: 0, total: 2 }),
            );
            const counts = mounted.container.querySelectorAll(".pane-meta-counts");
            expect(counts).toHaveLength(2);
            for (const count of counts)
                expect(count.textContent).toBe(
                    `${t("merge.count.changes", { count: 2 })}, ${t("merge.count.conflicts", { count: 2 })}`,
                );
            click(mounted.container, "Hide Details");
            expect(details!.hidden).toBe(true);
        } finally {
            unmount(mounted.root, mounted.container);
        }
    });

    it("status reads all conflicts resolved after the last decision", () => {
        const mounted = mount(<MergeWorkbench data={data} />);
        try {
            const status = () => mounted.container.querySelector("#merge-remaining-status");
            expect(status()?.textContent).toContain(t("merge.count.conflicts", { count: 1 }));
            act(() => actionButton(mounted.container, ".pane-ours .accept-btn").click());
            expect(status()?.textContent).toBe(t("merge.status.allConflictsResolved"));
            expect(status()?.classList.contains("resolved")).toBe(true);
            expect(
                actionButton(
                    mounted.container,
                    '[aria-label="Confirm manual resolution"]',
                ).getAttribute("aria-pressed"),
            ).toBe("true");
        } finally {
            unmount(mounted.root, mounted.container);
        }
    });

    it("toolbar order", () => {
        const mounted = mount(
            <MergeWorkbench data={{ ...data, diffOptions: { ignoreWhitespace: true } }} />,
        );
        try {
            const children = [...mounted.container.querySelectorAll(".toolbar-left > *")];
            expect(
                children.map((child) => [
                    child.className,
                    child.getAttribute("aria-label") ?? child.textContent,
                ]),
            ).toEqual([
                ["toolbar-nav-group", ""],
                ["toolbar-icon-btn", "Undo"],
                ["toolbar-icon-btn", "Redo"],
                ["toolbar-icon-btn", "Find in result"],
                ["toolbar-icon-btn", "Base"],
                ["toolbar-icon-btn", "Confirm manual resolution"],
                ["toolbar-separator", ""],
                ["toolbar-select", t("merge.toolbar.ignoreMode.title")],
                ["toolbar-btn subtle active", "Highlight words"],
                ["toolbar-btn subtle ", "Show Details"],
                ["toolbar-separator", ""],
                ["toolbar-icon-btn", t("merge.toolbar.applyNonConflicting")],
                ["toolbar-icon-btn", "Accept All Yours"],
                ["toolbar-icon-btn", "Accept All Theirs"],
                ["toolbar-select", "Resolve change"],
            ]);
            expect(
                [...children[0].querySelectorAll("button")].map((button) =>
                    button.getAttribute("aria-label"),
                ),
            ).toEqual(["Previous conflict", "Next conflict"]);
            expect((children[7] as HTMLSelectElement).disabled).toBe(false);
            expect((children[7] as HTMLSelectElement).value).toBe("whitespace");
            expect((children[5] as HTMLButtonElement).disabled).toBe(false);
            expect((children[14] as HTMLSelectElement).disabled).toBe(false);
            expect(mounted.container.querySelector(".mrow-active")).not.toBeNull();
        } finally {
            unmount(mounted.root, mounted.container);
        }
    });

    it("no .mw-hunks or mw- class remains", () => {
        const mounted = mount(<MergeWorkbench data={data} />);
        try {
            expect(mounted.container.querySelector(".mw-hunks")).toBeNull();
            const classes = [...mounted.container.querySelectorAll("[class]")].flatMap((node) => [
                ...node.classList,
            ]);
            expect(classes.filter((name) => name.startsWith("mw-"))).toEqual([]);
        } finally {
            unmount(mounted.root, mounted.container);
        }
    });

    it("the root carries merge-editor workbench and the gutter variable", () => {
        const mounted = mount(<MergeWorkbench data={{ ...data, editorFontSize: 15 }} />);
        try {
            const root = mounted.container.firstElementChild as HTMLElement;
            expect(root.className).toBe("merge-editor workbench words-highlighted");
            const maxLines = Math.max(
                ...[0, 1, 2].map(
                    (pane) =>
                        EditorView.findFromDOM(
                            mounted.container.querySelector<HTMLElement>(
                                `[data-testid="merge-editor-${pane}"] .cm-editor`,
                            )!,
                        )!.state.doc.lines,
                ),
            );
            expect(root.style.getPropertyValue("--merge-line-number-gutter")).toBe(
                `max(33px, calc(${Math.max(2, String(maxLines).length)}ch + 12px))`,
            );
            expect(root.style.getPropertyValue("--merge-code-font-size")).toBe("15px");
            act(() =>
                result(mounted.container).dispatch({
                    changes: { from: 0, insert: "line\n".repeat(100) },
                }),
            );
            expect(root.style.getPropertyValue("--merge-line-number-gutter")).toBe(
                "max(33px, calc(3ch + 12px))",
            );
            click(mounted.container, "Highlight words");
            expect(root.classList.contains("words-highlighted")).toBe(false);
        } finally {
            unmount(mounted.root, mounted.container);
        }
    });

    it("prev/next cycle true conflicts only", () => {
        const versions = {
            base: "first\nkeep1\nsolo\nkeep2\nlast\n",
            ours: "ours first\nkeep1\nOURS\nkeep2\nours last\n",
            theirs: "theirs first\nkeep1\nsolo\nkeep2\ntheirs last\n",
        };
        const mounted = mount(
            <MergeWorkbench
                data={{
                    ...data,
                    segments: parseConflictVersions(versions.base, versions.ours, versions.theirs),
                    workbench: { ...data.workbench, ...versions },
                }}
            />,
        );
        try {
            expect(
                result(mounted.container)
                    .state.field(workbenchHunks)
                    .map((hunk) => hunk.conflict),
            ).toEqual([true, false, true]);
            const activeText = () =>
                mounted.container.querySelector(".pane-result .cm-line.mrow-active")?.textContent;
            expect(activeText()).toBe("first");
            click(mounted.container, "Next conflict");
            expect(activeText(), "next must skip the one-sided middle hunk").toBe("last");
            click(mounted.container, "Next conflict");
            expect(activeText()).toBe("first");
            click(mounted.container, "Previous conflict");
            expect(activeText()).toBe("last");
            act(() =>
                mounted.container
                    .querySelectorAll<HTMLButtonElement>(".overview-marker")[1]
                    .click(),
            );
            expect(activeText()).toBe("OURS");
            click(mounted.container, "Next conflict");
            expect(activeText()).toBe("first");
            act(() => actionButton(mounted.container, ".pane-ours .accept-btn").click());
            expect(activeText()).toBe("ours first");
        } finally {
            unmount(mounted.root, mounted.container);
        }
    });

    it("flushes the draft before opening Conflicts and shows saved status only after acknowledgement", () => {
        const mounted = mount(<MergeWorkbench data={data} />);
        try {
            expect(mounted.container.querySelector(".footer-draft-status")).toBeNull();
            act(() =>
                result(mounted.container).dispatch({ changes: { from: 0, insert: "edit\n" } }),
            );
            api.postMessage.mockClear();
            click(mounted.container, "Conflicts");
            expect(api.postMessage.mock.calls.map(([message]) => message.type)).toEqual([
                "saveMergeDraft",
                "openConflictSession",
            ]);
            receive({ type: "mergeDraftSaved", revision: 1 });
            expect(
                mounted.container.querySelector('.footer-left .footer-draft-status[role="status"]')
                    ?.textContent,
            ).toBe("Draft saved");
        } finally {
            unmount(mounted.root, mounted.container);
        }
    });

    it("hides Abort and Conflicts for shelf sessions", () => {
        const mounted = mount(<MergeWorkbench data={{ ...data, sessionKind: "shelf" }} />);
        try {
            const labels = [...mounted.container.querySelectorAll(".footer-left button")].map(
                (button) => button.textContent,
            );
            expect(labels).not.toContain(t("merge.action.abortMerge"));
            expect(labels).not.toContain("Conflicts");
            const right = [...mounted.container.querySelectorAll(".footer-right button")].map(
                (button) => button.textContent,
            );
            expect(right).toContain(t("common.cancel"));
            expect(right).toContain(t("common.apply"));
        } finally {
            unmount(mounted.root, mounted.container);
        }
    });
});
