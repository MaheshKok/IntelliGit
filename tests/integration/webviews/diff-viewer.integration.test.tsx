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
