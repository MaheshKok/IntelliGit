// @vitest-environment jsdom

import { act } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { LINE_HEIGHT_PX } from "../../../src/webviews/react/diff-core/mergeScrollLayout";
import { flush } from "../../helpers/reactDomTestUtils";
import { installWebviewI18n } from "../../helpers/webviewI18nTestUtils";

interface MockVsCodeApi {
    postMessage: ReturnType<typeof vi.fn>;
    getState: () => unknown;
    setState: ReturnType<typeof vi.fn>;
}

function createRootHost(): HTMLDivElement {
    const root = document.createElement("div");
    root.id = "root";
    document.body.appendChild(root);
    return root;
}

function installVsCodeMock(): MockVsCodeApi {
    const api: MockVsCodeApi = {
        postMessage: vi.fn(),
        getState: vi.fn(() => ({})),
        setState: vi.fn(),
    };
    Object.defineProperty(globalThis, "acquireVsCodeApi", {
        configurable: true,
        value: vi.fn(() => api),
    });
    installWebviewI18n();
    return api;
}

function dispatchHostMessage(data: unknown): void {
    act(() => {
        window.dispatchEvent(new MessageEvent("message", { data }));
    });
}

/** Mounts the app with the left pane document-backed and returns a keystroke driver. */
async function mountEditablePane(
    editableText: string,
    documentVersion: number,
    segments: unknown = diffFixture.segments,
): Promise<(next: string) => void> {
    createRootHost();
    await act(async () => {
        await import("../../../src/webviews/react/diff-viewer/DiffViewerApp");
    });
    await flush();
    dispatchHostMessage({
        type: "setDiffData",
        data: {
            ...diffFixture,
            segments,
            editablePane: "left" as const,
            editableText,
            documentVersion,
            editableReseedToken: 0,
        },
    });
    await flush();
    const textarea = document.querySelector<HTMLTextAreaElement>(
        "[data-testid='diff-pane-left-editable']",
    );
    const valueSetter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
    )?.set;
    return (next: string) => {
        act(() => {
            valueSetter?.call(textarea, next);
            textarea?.dispatchEvent(new Event("input", { bubbles: true }));
        });
    };
}

interface SentDelta {
    baseVersion: number;
    baseReseedToken: number;
    startOffset: number;
    endOffset: number;
    text: string;
}

/** Every edit delta posted to the host, in order. */
function sentDeltas(vscode: MockVsCodeApi): SentDelta[] {
    return vscode.postMessage.mock.calls
        .map((call) => call[0] as { type?: string; delta?: SentDelta })
        .filter((message) => message?.type === "editText")
        .map((message) => message.delta as SentDelta);
}

/** Base versions of every delta posted, in order — the host applies them in this order. */
function sentDeltaVersions(vscode: MockVsCodeApi): number[] {
    return sentDeltas(vscode).map((delta) => delta?.baseVersion ?? -1);
}

const diffFixture = {
    path: "src/example.ts",
    leftLabel: "HEAD",
    rightLabel: "Working tree",
    languageId: "typescript",
    left: { eol: "lf" as const, terminalNewline: true },
    right: { eol: "lf" as const, terminalNewline: true },
    newlineDifference: false,
    ignoreWhitespace: false,
    segments: [
        { type: "common" as const, left: ["shared();"], right: ["shared();"] },
        { type: "changed" as const, left: ["before();"], right: ["after();"] },
    ],
};

const conflictFixture = {
    filePath: "src/conflict.ts",
    oursLabel: "main",
    theirsLabel: "feature/incoming",
    eol: "\n",
    hasTrailingNewline: true,
    segments: [
        { type: "common" as const, lines: ["shared();"] },
        {
            type: "conflict" as const,
            id: 0,
            changeKind: "conflict" as const,
            oursLines: ["ours();"],
            theirsLines: ["theirs();"],
            baseLines: ["base();"],
        },
    ],
};

beforeAll(() => {
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
        value: true,
        configurable: true,
    });
});

afterEach(() => {
    document.body.replaceChildren();
    vi.clearAllMocks();
    vi.resetModules();
});

describe("DiffViewerApp read-only contract", () => {
    it("has no editable or per-hunk action surface", async () => {
        installVsCodeMock();
        createRootHost();

        await act(async () => {
            await import("../../../src/webviews/react/diff-viewer/DiffViewerApp");
        });
        await flush();
        dispatchHostMessage({ type: "setDiffData", data: diffFixture });
        await flush();

        expect(document.querySelectorAll(".diff-pane .code-block").length).toBeGreaterThan(0);
        expect(document.body.textContent).toContain("before();");
        expect(document.body.textContent).toContain("after();");
        expect(document.querySelectorAll('[data-conflict-id="0"] .action-btn')).toHaveLength(0);
        expect(document.querySelector(".result-edit-textarea")).toBeNull();
        expect(document.querySelector(".result-editable")).toBeNull();
        expect(document.querySelector("textarea")).toBeNull();
    });

    it("renders the descriptor-selected pane as a document-backed editor and posts a delta", async () => {
        const vscode = installVsCodeMock();
        createRootHost();

        await act(async () => {
            await import("../../../src/webviews/react/diff-viewer/DiffViewerApp");
        });
        await flush();
        dispatchHostMessage({
            type: "setDiffData",
            data: {
                ...diffFixture,
                editablePane: "left" as const,
                editableText: "shared();\nbefore();",
                documentVersion: 1,
            },
        });
        await flush();

        const textarea = document.querySelector<HTMLTextAreaElement>(
            "[data-testid='diff-pane-left-editable']",
        );
        expect(textarea).not.toBeNull();
        expect(document.querySelector("[data-testid='diff-pane-right-editable']")).toBeNull();
        const valueSetter = Object.getOwnPropertyDescriptor(
            HTMLTextAreaElement.prototype,
            "value",
        )?.set;
        act(() => {
            valueSetter?.call(textarea, "shared();\nafter();");
            textarea!.dispatchEvent(new Event("input", { bubbles: true }));
        });

        expect(textarea?.value).toContain("after();");
        expect(vscode.postMessage).toHaveBeenLastCalledWith({
            type: "editText",
            delta: {
                baseVersion: 1,
                baseReseedToken: 0,
                startOffset: 10,
                endOffset: 16,
                text: "after",
            },
        });

        act(() => {
            valueSetter?.call(textarea, textarea!.value + String.fromCharCode(10) + "again();");
            textarea!.dispatchEvent(new Event("input", { bubbles: true }));
        });

        expect(textarea?.value).toContain("again();");
        expect(vscode.postMessage).toHaveBeenLastCalledWith({
            type: "editText",
            delta: {
                baseVersion: 2,
                baseReseedToken: 0,
                startOffset: 18,
                endOffset: 18,
                text: String.fromCharCode(10) + "again();",
            },
        });
    });

    it("keeps typing when the host echoes an in-flight edit without a new reseed token", async () => {
        const vscode = installVsCodeMock();
        const type = await mountEditablePane("AB", 1);
        const textarea = document.querySelector<HTMLTextAreaElement>(
            "[data-testid='diff-pane-left-editable']",
        );

        type("AXB");
        type("AXYB");
        // The host finished applying only the FIRST delta and echoed it back. Its version
        // advanced by one while the draft advanced by two, and the token did not move —
        // reseeding here would roll the pane back to "AXB" and cost the next keystroke.
        dispatchHostMessage({
            type: "setDiffData",
            data: {
                ...diffFixture,
                editablePane: "left" as const,
                editableText: "AXB",
                documentVersion: 2,
                editableReseedToken: 0,
            },
        });
        await flush();
        type("AXYZB");

        expect(textarea?.value).toBe("AXYZB");
        // The host applies these in order: 1->2, 2->3, 3->4. A repeated base version means
        // the host drops that delta and the character is lost with no error anywhere.
        expect(sentDeltaVersions(vscode)).toEqual([1, 2, 3]);
    });

    it("discards the local draft when the host reports an external change", async () => {
        const vscode = installVsCodeMock();
        const type = await mountEditablePane("AB", 1);
        const textarea = document.querySelector<HTMLTextAreaElement>(
            "[data-testid='diff-pane-left-editable']",
        );

        type("AXB");
        dispatchHostMessage({
            type: "setDiffData",
            data: {
                ...diffFixture,
                editablePane: "left" as const,
                editableText: "EXTERNAL",
                documentVersion: 9,
                editableReseedToken: 1,
            },
        });
        await flush();

        expect(textarea?.value).toBe("EXTERNAL");
        type("EXTERNAL!");
        expect(sentDeltaVersions(vscode)).toEqual([1, 9]);
        // Each delta is stamped with the reseed its measured text came from. A pane that
        // reported a fixed token, or the one it held at mount, would look current to the host
        // forever — and the host's staleness guard is exactly that comparison.
        expect(sentDeltas(vscode).map((delta) => delta.baseReseedToken)).toEqual([0, 1]);
    });

    it("spans the whole surrogate pair when one astral character replaces another", async () => {
        const vscode = installVsCodeMock();
        // Both emoji sit in the same 1024-code-point block, so they share a high surrogate
        // and differ only in the low one. A scan comparing UTF-16 code units therefore stops
        // BETWEEN the halves, and the delta it emits replaces half of one character with half
        // of another — a range VS Code has to resolve to a position that does not exist.
        const grin = String.fromCodePoint(0x1f600);
        const smile = String.fromCodePoint(0x1f601);
        const type = await mountEditablePane("a" + grin + "b", 1);

        type("a" + smile + "b");

        expect(sentDeltas(vscode)).toEqual([
            { baseVersion: 1, baseReseedToken: 0, startOffset: 1, endOffset: 3, text: smile },
        ]);
    });

    it("spans the whole surrogate pair when the two characters share their LOW surrogate", async () => {
        const vscode = installVsCodeMock();
        // The mirror image of the case above, and the one the leading-boundary step-back
        // cannot reach: U+1F600 and U+1FA00 differ in the HIGH surrogate and share the low
        // one, so it is the SUFFIX scan that stops between the halves. Without the trailing
        // step-forward the delta ends mid-character and emits a lone high surrogate.
        const grin = String.fromCodePoint(0x1f600);
        const chessKing = String.fromCodePoint(0x1fa00);
        expect(grin.charCodeAt(1)).toBe(chessKing.charCodeAt(1));
        const type = await mountEditablePane("a" + grin + "b", 1);

        type("a" + chessKing + "b");

        expect(sentDeltas(vscode)).toEqual([
            { baseVersion: 1, baseReseedToken: 0, startOffset: 1, endOffset: 3, text: chessKing },
        ]);
    });

    it("keeps the caret in place when the host reseeds the pane", async () => {
        installVsCodeMock();
        await mountEditablePane("abcdef", 1);
        const textarea = document.querySelector<HTMLTextAreaElement>(
            "[data-testid='diff-pane-left-editable']",
        );
        textarea?.setSelectionRange(2, 2);

        dispatchHostMessage({
            type: "setDiffData",
            data: {
                ...diffFixture,
                editablePane: "left" as const,
                editableText: "abcXef",
                documentVersion: 2,
                editableReseedToken: 1,
            },
        });
        await flush();

        // Rewriting a controlled textarea's value drops the cursor at the end of the new
        // text, so an external write anywhere in the file would silently relocate the user
        // to EOF and land their next keystroke there.
        expect(textarea?.value).toBe("abcXef");
        expect(textarea?.selectionStart).toBe(2);
        expect(textarea?.selectionEnd).toBe(2);
    });

    it("reconciles the ignore mode from a host payload after a fresh mount", async () => {
        installVsCodeMock();
        createRootHost();

        await act(async () => {
            await import("../../../src/webviews/react/diff-viewer/DiffViewerApp");
        });
        await flush();
        dispatchHostMessage({
            type: "setDiffData",
            data: { ...diffFixture, ignoreWhitespace: true },
        });
        await flush();

        const ignoreModeButton = document.querySelector<HTMLButtonElement>(
            ".toolbar-left .toolbar-btn",
        );
        expect(ignoreModeButton?.textContent).toContain("Ignore whitespace");
        expect(ignoreModeButton?.textContent).not.toContain("Do not ignore");
    });

    // The host carries a refresh failure inside the payload rather than as a second message, so
    // one render shows the error and the next clears it. Asserting the host side alone would not
    // notice a viewer that never reads the field.
    it("renders a payload-carried load error and clears it on the next clean payload", async () => {
        installVsCodeMock();
        createRootHost();

        await act(async () => {
            await import("../../../src/webviews/react/diff-viewer/DiffViewerApp");
        });
        await flush();
        dispatchHostMessage({
            type: "setDiffData",
            data: { ...diffFixture, loadError: "Permission denied" },
        });
        await flush();

        const banner = document.querySelector(".error-message");
        expect(banner, "a payload-carried loadError must render the error banner").not.toBeNull();
        expect(banner?.textContent).toContain("Permission denied");

        // The host reports a refresh failure while deliberately retaining the snapshot it
        // already posted (`DiffViewerPanel.postLoadError`), so the diff on screen is still
        // valid and still the best available answer. A viewer that replaces the whole
        // surface throws that away and leaves the reader with an error and nothing else --
        // and `.diff-viewer` cannot witness it, because the full-screen error carries that
        // class too. Only the rendered root and its panes separate the two.
        expect(
            document.querySelector("[data-testid='diff-viewer-root']"),
            "the refresh error replaced the whole viewer; the still-valid diff it was reported against is gone",
        ).not.toBeNull();
        expect(
            document.querySelector("[data-testid='diff-pane-left']"),
            "the left pane was unmounted by a refresh error, so previously loaded content is no longer readable",
        ).not.toBeNull();
        expect(
            document.querySelector("[data-testid='diff-pane-right']"),
            "the right pane was unmounted by a refresh error, so previously loaded content is no longer readable",
        ).not.toBeNull();

        dispatchHostMessage({ type: "setDiffData", data: diffFixture });
        await flush();

        expect(document.querySelector(".error-message")).toBeNull();
        expect(document.querySelector(".diff-viewer")).not.toBeNull();
    });

    it("keeps the document-backed pane mounted when a refresh reports a load error", async () => {
        // A failed refresh must be reported, not staged as a replacement for the viewer. The
        // editable pane IS the user's editing surface: unmounting it takes typing away for as
        // long as the error stands, and nothing guarantees a later repository event arrives to
        // clear it. A background rebuild that briefly pushes the immutable side over the
        // viewer budget is enough to trigger this.
        installVsCodeMock();
        await mountEditablePane("shared();\nbefore();", 1);

        dispatchHostMessage({
            type: "setDiffData",
            data: {
                ...diffFixture,
                editablePane: "left" as const,
                editableText: "shared();\nbefore();",
                documentVersion: 1,
                editableReseedToken: 0,
                loadError: "The refreshed diff exceeds the viewer budget.",
            },
        });
        await flush();

        const banner = document.querySelector(".error-message");
        expect(banner?.textContent).toContain("exceeds the viewer budget");
        expect(
            document.querySelector("[data-testid='diff-pane-left-editable']"),
            "a refresh failure must not unmount the pane the user is typing in",
        ).not.toBeNull();
    });

    it("gives the editable pane a height of its own when the immutable side is empty", async () => {
        // An added file has no HEAD side, so its one segment is one-sided and the immutable pane
        // renders no rows at all. The editable pane REPLACES the segment stack rather than
        // sitting on top of it, so with a zero-row counterpart the grid row has nothing left to
        // size against — and a textarea carries no `rows` here and never grows with its value,
        // so it would collapse to its default two rows while the spacer still declares the full
        // scroll range. The editing surface has to declare the canonical extent itself.
        installVsCodeMock();
        createRootHost();
        await act(async () => {
            await import("../../../src/webviews/react/diff-viewer/DiffViewerApp");
        });
        await flush();

        const added = Array.from({ length: 40 }, (_, index) => `line ${index};`);
        dispatchHostMessage({
            type: "setDiffData",
            data: {
                ...diffFixture,
                segments: [{ type: "changed" as const, left: [], right: added }],
                editablePane: "right" as const,
                editableText: added.join("\n"),
                documentVersion: 1,
                editableReseedToken: 0,
            },
        });
        await flush();

        expect(
            document.querySelectorAll(".diff-pane-left .code-line"),
            "the premise: an added file's immutable pane renders no rows",
        ).toHaveLength(0);

        const spacer = document.querySelector<HTMLElement>(".diff-vscroll-spacer");
        const textarea = document.querySelector<HTMLTextAreaElement>(
            "[data-testid='diff-pane-right-editable']",
        );
        // An absolute number, not the spacer's own value: both are rendered from the same
        // expression in the same render, so comparing them to each other would hold just as
        // well at "0px" — which is exactly the collapsed pane this asserts against.
        expect(
            textarea?.style.height,
            "nothing else sizes this row, so the pane must carry the canonical extent itself",
        ).toBe("800px");
        expect(spacer?.style.height, "and the scroll range agrees with it").toBe("800px");
    });

    it("never renders the editable pane shorter than the text it is showing", async () => {
        // `splitText` treats a terminal newline as metadata and emits no row for it, but a
        // textarea renders one line box per "\n"-separated element — so a file ending in a
        // newline, which is nearly all of them, needs one line more than the segment model
        // reports. Left short, the textarea becomes a scroll container of its own, and the
        // scroll driver translates the COLUMN and never the textarea, so that scroll is
        // invisible to it: one wheel tick over this pane shifts every row against the opposite
        // pane, its line numbers, and the ribbons, and nothing puts them back.
        installVsCodeMock();
        createRootHost();
        await act(async () => {
            await import("../../../src/webviews/react/diff-viewer/DiffViewerApp");
        });
        await flush();

        const lines = Array.from({ length: 40 }, (_, index) => `line ${index};`);
        dispatchHostMessage({
            type: "setDiffData",
            data: {
                ...diffFixture,
                segments: [{ type: "common" as const, left: lines, right: lines }],
                editablePane: "left" as const,
                editableText: lines.join("\n") + "\n",
                documentVersion: 1,
                editableReseedToken: 0,
            },
        });
        await flush();

        const textarea = document.querySelector<HTMLTextAreaElement>(
            "[data-testid='diff-pane-left-editable']",
        );
        const spacer = document.querySelector<HTMLElement>(".diff-vscroll-spacer");
        expect(
            textarea?.style.height,
            "the value has 41 line boxes, and a pane shorter than its own text scrolls itself",
        ).toBe("820px");
        // The scroll range has to agree, or the fix just moves the problem: the extra box
        // would sit past `paneTotalPx - viewport`, where the clamp stops the column and the
        // viewport clips it, and no scroll position could ever bring it on screen.
        expect(spacer?.style.height, "and the row it added has to be reachable").toBe("820px");
    });

    it("renders an editable pane over a zero-segment payload without crashing", async () => {
        // A file that is empty in HEAD and empty on disk produces no segments at all, and the
        // deficit arithmetic still runs over that: one line box against zero counted rows. The
        // early return is the only thing standing between that payload and reading `paneLines`
        // off an `undefined` last row, which throws during render and takes the whole app with
        // it — a blank panel, not a degraded one. `touch newfile.txt` and open its diff.
        installVsCodeMock();
        createRootHost();
        await act(async () => {
            await import("../../../src/webviews/react/diff-viewer/DiffViewerApp");
        });
        await flush();

        dispatchHostMessage({
            type: "setDiffData",
            data: {
                ...diffFixture,
                segments: [],
                editablePane: "right" as const,
                editableText: "",
                documentVersion: 1,
                editableReseedToken: 0,
            },
        });
        await flush();

        expect(
            document.querySelector("[data-testid='diff-pane-right-editable']"),
            "an empty file on both sides still has a pane to type into",
        ).not.toBeNull();
    });

    it("puts the deficit on the editable pane of the last segment, and nowhere else", async () => {
        // The fixture above is a single segment with both panes the same height, which makes
        // two wrong implementations indistinguishable from the right one: `rows[0]` and
        // `rows[rows.length - 1]` are the same object there, and widening both panes reads
        // exactly like widening the editable one. This is the shape that separates them — two
        // segments, with the editable side the TALLER one in the first and the SHORTER one in
        // the last.
        //
        // Placed correctly, the row lands where that pane is already the shorter of the two,
        // so the canonical space absorbs it and does not move. Placed on the first segment, or
        // on both panes, it lands where the pane is the taller one and drags the shared scroll
        // range 20px with it — putting every row below out of step with the opposite pane,
        // its line numbers, and the ribbons.
        installVsCodeMock();
        createRootHost();
        await act(async () => {
            await import("../../../src/webviews/react/diff-viewer/DiffViewerApp");
        });
        await flush();

        const block = (count: number, tag: string) =>
            Array.from({ length: count }, (_, index) => `${tag} ${index};`);
        dispatchHostMessage({
            type: "setDiffData",
            data: {
                ...diffFixture,
                segments: [
                    { type: "changed" as const, left: block(20, "a"), right: block(10, "b") },
                    { type: "changed" as const, left: block(10, "c"), right: block(20, "d") },
                ],
                editablePane: "left" as const,
                // 30 counted rows, so a terminal newline is 31 line boxes and a deficit of 1.
                editableText: block(30, "x").join("\n") + "\n",
                documentVersion: 1,
                editableReseedToken: 0,
            },
        });
        await flush();

        const spacer = document.querySelector<HTMLElement>(".diff-vscroll-spacer");
        // Two segments of 20 canonical rows each — the per-segment maximum, untouched by a row
        // added to the pane that is already the shorter one. This assertion is also green if
        // the deficit is dropped entirely; that case belongs to the test above. This one exists
        // only to say WHERE the row goes once there is one.
        expect(
            spacer?.style.height,
            "the row belongs to the editable pane of the last segment, which absorbs it",
        ).toBe("800px");
    });

    it("keeps the editable pane as tall as the immutable side it is aligned against", async () => {
        installVsCodeMock();
        createRootHost();
        await act(async () => {
            await import("../../../src/webviews/react/diff-viewer/DiffViewerApp");
        });
        await flush();

        // The height is the larger of the segment model's extent and the draft's own, and
        // every other height test here uses a fixture where the draft wins or the two are
        // equal — which makes the segment-model half of that comparison inert in all of them,
        // and green whether it is there or not. This is the inverse: an editable side one line
        // long against forty immutable ones. Without the canonical half the pane collapses to
        // 20px inside an 800px row, and the ribbons land on nothing.
        const rows = Array.from({ length: 40 }, (_, index) => `line ${index};`);
        dispatchHostMessage({
            type: "setDiffData",
            data: {
                ...diffFixture,
                segments: [{ type: "changed" as const, left: rows, right: ["only();"] }],
                editablePane: "right" as const,
                editableText: "only();",
                documentVersion: 1,
                editableReseedToken: 0,
            },
        });
        await flush();

        const textarea = document.querySelector<HTMLTextAreaElement>(
            "[data-testid='diff-pane-right-editable']",
        );
        expect(textarea?.style.height, "the segment the pane occupies is 40 rows tall").toBe(
            "800px",
        );
    });

    it("grows the editable pane as the draft outgrows the payload it was seeded from", async () => {
        installVsCodeMock();
        // One line in the segments, so the segment model contributes exactly one row and the
        // draft is the taller of the two the moment a second line exists.
        const type = await mountEditablePane("AB", 1, [
            { type: "common" as const, left: ["AB"], right: ["AB"] },
        ]);
        const textarea = document.querySelector<HTMLTextAreaElement>(
            "[data-testid='diff-pane-left-editable']",
        );
        expect(textarea?.style.height, "one row before anything is typed").toBe("20px");

        // Pressing Enter adds a line box now; the host's echo — and the recomputed segments
        // that come with it — are a full round trip away. Sized from the `text` prop instead
        // of the draft, the pane spends that whole window one line short of its own value,
        // which is the same self-scrolling pane as above reached by typing rather than by a
        // terminal newline. The window is every keystroke, so it is not a corner case.
        type("A" + String.fromCharCode(10) + "B");

        expect(
            textarea?.style.height,
            "the pane has to hold the draft, not the payload it was seeded from",
        ).toBe("40px");
    });

    it("keeps the anti-vacuity selectors present in the merge app", async () => {
        installVsCodeMock();
        createRootHost();

        await act(async () => {
            await import("../../../src/webviews/react/merge-editor/MergeEditorApp");
        });
        await flush();
        dispatchHostMessage({ type: "setConflictData", data: conflictFixture });
        await flush();

        expect(document.querySelectorAll('[data-conflict-id="0"] .action-btn')).toHaveLength(4);
        expect(document.querySelector(".result-editable")).not.toBeNull();
    });
});

// --- Scroll viewport and ribbon geometry ---

const VIEWPORT_H = 300;
const VIEWPORT_W = 1000;

/** Distinct filler rows; only their count affects the geometry under test. */
function rows(prefix: string, count: number): string[] {
    return Array.from({ length: count }, (_, index) => `${prefix}${index};`);
}

/**
 * A payload whose two panes swap which one is taller between hunks: a
 * deletion-only hunk (3 rows against 0) is followed by an insertion-only one
 * (0 rows against 6). A fixture that keeps one side monotonically taller cannot
 * tell a ribbon drawn from each pane's own extent apart from one drawn from the
 * shared canonical (tallest-side) extent, because the two agree everywhere.
 *
 * Segment geometry at 20px per row, canonical = max(left, right):
 *
 *   idx  kind     left rows  right rows  canonicalTop  left top  right top
 *   0    common   5          5           0             0         0
 *   1    changed  3          0           100           100       100
 *   2    common   5          5           160           160       100
 *   3    changed  0          6           260           260       200
 *   4    common   20         20          380           260       320
 *
 * canonicalTotal 780, left total 660, right total 720.
 */
const scrollFixture = {
    ...diffFixture,
    segments: [
        { type: "common" as const, left: rows("head", 5), right: rows("head", 5) },
        { type: "changed" as const, left: rows("removed", 3), right: [] },
        { type: "common" as const, left: rows("middle", 5), right: rows("middle", 5) },
        { type: "changed" as const, left: [], right: rows("added", 6) },
        { type: "common" as const, left: rows("tail", 20), right: rows("tail", 20) },
    ],
};

const CANONICAL_TOTAL_PX = 39 * LINE_HEIGHT_PX;
/** Canonical scroll position halfway through the deletion-only hunk. */
const MID_HUNK_SCROLL_PX = 130;
/** Left advances by its own 3 rows at that point; right, having none, does not. */
const LEFT_OFFSET_AT_MID_HUNK_PX = 130;
const RIGHT_OFFSET_AT_MID_HUNK_PX = 100;

interface RibbonExtents {
    leftTop: number;
    leftBottom: number;
    rightTop: number;
    rightBottom: number;
}

/**
 * Reads the four pane extents back out of a ribbon's rendered path data. The
 * path visits, in order: (x0,leftTop) (curveX0,leftTop) (cA,leftTop)
 * (cB,rightTop) (curveX1,rightTop) (x1,rightTop) (x1,rightBottom)
 * (curveX1,rightBottom) (cB,rightBottom) (cA,leftBottom) (curveX0,leftBottom)
 * (x0,leftBottom).
 */
function ribbonExtents(path: Element): RibbonExtents {
    const data = path.getAttribute("d");
    expect(data, "the scroll driver never wrote this ribbon's geometry").toBeTruthy();
    const ys = [...(data ?? "").matchAll(/-?[\d.]+,(-?[\d.]+)/g)].map((match) => Number(match[1]));
    expect(ys, `unexpected ribbon path shape: ${data}`).toHaveLength(12);
    return { leftTop: ys[0], rightTop: ys[5], rightBottom: ys[6], leftBottom: ys[11] };
}

async function mountScrollFixture(): Promise<{
    content: HTMLElement;
    ribbons: Element[];
}> {
    installVsCodeMock();
    createRootHost();
    await act(async () => {
        await import("../../../src/webviews/react/diff-viewer/DiffViewerApp");
    });
    await flush();
    dispatchHostMessage({ type: "setDiffData", data: scrollFixture });
    await flush();

    const content = document.querySelector<HTMLElement>(".diff-content");
    expect(content).not.toBeNull();
    return {
        content: content as HTMLElement,
        ribbons: [...document.querySelectorAll(".diff-ribbon-layer .diff-ribbon")],
    };
}

function scrollTo(content: HTMLElement, top: number): void {
    Object.defineProperty(content, "scrollTop", { configurable: true, value: top });
    act(() => {
        content.dispatchEvent(new Event("scroll", { bubbles: false }));
    });
}

describe("DiffViewerApp scroll viewport and ribbons", () => {
    beforeEach(() => {
        // jsdom performs no layout, so the driver would measure a zero-sized
        // viewport, clamp every offset to nothing and cull every ribbon. Give the
        // tree a fixed box so the geometry under test runs at real numbers.
        Object.defineProperty(HTMLElement.prototype, "clientHeight", {
            configurable: true,
            get: () => VIEWPORT_H,
        });
        Object.defineProperty(HTMLElement.prototype, "clientWidth", {
            configurable: true,
            get: () => VIEWPORT_W,
        });
        vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation((callback) => {
            callback(0);
            return 0;
        });
    });

    afterEach(() => {
        Reflect.deleteProperty(HTMLElement.prototype, "clientHeight");
        Reflect.deleteProperty(HTMLElement.prototype, "clientWidth");
        vi.restoreAllMocks();
    });

    it("gives the scroller a spacer of its own so the sticky viewport can pin", async () => {
        const { content } = await mountScrollFixture();

        const spacer = document.querySelector<HTMLElement>(".diff-vscroll-spacer");
        expect(spacer).not.toBeNull();
        expect(
            spacer?.parentElement?.className,
            "the spacer is the scroller's whole scroll range; nested inside the clipped, fixed-height viewport it contributes none",
        ).toContain("diff-content");
        expect(spacer?.parentElement?.className).not.toContain("diff-viewport");
        expect(spacer?.style.height).toBe(`${CANONICAL_TOTAL_PX}px`);
        expect(
            content.style.getPropertyValue("--diff-viewport-h"),
            "without the measured height the viewport cannot cancel itself out of flow in pixels",
        ).toBe(`${VIEWPORT_H}px`);
    });

    it("gives the counterpart of a one-sided hunk no rows and no intrinsic height", async () => {
        // What licenses `diff-viewer.css` to style `.diff-segment-empty` with nothing at
        // all. Each pane is sized from its own line count, so this block is zero pixels
        // tall and any background declared on it is paint that can never render. Switch
        // the panes back to filler rows and this fails here, before a blank band appears
        // in a screenshot nobody reads as wrong.
        await mountScrollFixture();

        const empties = [...document.querySelectorAll<HTMLElement>(".diff-segment-empty")];
        expect(
            empties.length,
            "the fixture's one-sided hunks produced no empty counterpart block, so this test asserts nothing",
        ).toBe(2);

        for (const empty of empties) {
            expect(
                empty.querySelectorAll(".code-line-content"),
                "an empty counterpart rendered code rows, so it now occupies height and an unpainted block reads as a gap",
            ).toHaveLength(0);
            expect(
                empty.style.containIntrinsicSize,
                "the empty counterpart reserves intrinsic height, so content-visibility gives it a box the pane opposite has no rows to fill",
            ).toBe("auto 0px");
        }
    });

    it("draws each ribbon side from that pane's own extent, never the canonical one", async () => {
        const { ribbons } = await mountScrollFixture();
        expect(ribbons).toHaveLength(2);

        const deletionOnly = ribbonExtents(ribbons[0]);
        expect(deletionOnly.leftBottom - deletionOnly.leftTop).toBe(3 * LINE_HEIGHT_PX);
        expect(
            deletionOnly.rightBottom - deletionOnly.rightTop,
            "the right pane contributes no rows to this hunk, so its side of the ribbon has no height",
        ).toBe(0);

        const insertionOnly = ribbonExtents(ribbons[1]);
        expect(insertionOnly.leftBottom - insertionOnly.leftTop).toBe(0);
        expect(insertionOnly.rightBottom - insertionOnly.rightTop).toBe(6 * LINE_HEIGHT_PX);
        expect(
            insertionOnly.rightTop,
            "the right pane skipped the 3 deleted rows, so its hunk starts 3 rows above the canonical position",
        ).toBe(insertionOnly.leftTop - 3 * LINE_HEIGHT_PX);
    });

    it("moves each ribbon side by its own pane's scroll offset", async () => {
        const { content, ribbons } = await mountScrollFixture();
        const before = ribbonExtents(ribbons[1]);

        scrollTo(content, MID_HUNK_SCROLL_PX);
        const after = ribbonExtents(ribbons[1]);

        expect(
            after.leftTop,
            "a ribbon whose geometry is fixed at render time stays behind while the columns translate",
        ).toBe(before.leftTop - LEFT_OFFSET_AT_MID_HUNK_PX);
        expect(after.rightTop).toBe(before.rightTop - RIGHT_OFFSET_AT_MID_HUNK_PX);
        expect(
            before.leftTop - after.leftTop,
            "the two panes advance by different amounts through a one-sided hunk; a single shared offset cannot produce both",
        ).not.toBe(before.rightTop - after.rightTop);
    });
});
