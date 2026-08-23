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

/** Mounts the app with the left pane document-backed. */
async function mountEditablePane(
    editableText: string,
    documentVersion: number,
    segments: unknown = diffFixture.segments,
): Promise<void> {
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
}

/** Opens one editable diff block and returns its block-local text input. */
function editBlock(index: number): HTMLTextAreaElement {
    const blocks = document.querySelectorAll<HTMLElement>(".diff-pane-left .diff-editable-block");
    const block = blocks[index];
    expect(block, `editable block ${index} must exist before it can enter edit mode`).toBeDefined();
    act(() => {
        block.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    const textarea = document.querySelector<HTMLTextAreaElement>(
        "[data-testid='diff-pane-left-editable']",
    );
    expect(textarea).not.toBeNull();
    return textarea as HTMLTextAreaElement;
}

/** Updates the controlled textarea through the same input event as a user edit. */
function setDraftText(textarea: HTMLTextAreaElement, next: string): void {
    const valueSetter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
    )?.set;
    act(() => {
        valueSetter?.call(textarea, next);
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
}

/** Leaves a block-local edit, which is the viewer's commit gesture. */
function commitDraft(textarea: HTMLTextAreaElement): void {
    act(() => {
        textarea.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
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

    it("renders the descriptor-selected pane with CodeBlock rows, line numbers, and scrollable code lines", async () => {
        installVsCodeMock();
        await mountEditablePane("shared();\nbefore();", 1);

        const editablePane = document.querySelector(".diff-pane-left");
        expect(editablePane?.querySelectorAll(".diff-editable-block")).toHaveLength(2);
        expect(editablePane?.querySelectorAll(".code-block")).toHaveLength(2);
        expect(editablePane?.querySelectorAll(".line-number")).toHaveLength(2);
        expect(editablePane?.querySelectorAll(".code-lines")).toHaveLength(2);
        expect(editablePane?.querySelector("textarea")).toBeNull();
    });

    it("enters only the double-clicked block while keeping its line number visible", async () => {
        installVsCodeMock();
        await mountEditablePane("shared();\nbefore();", 1);

        const textarea = editBlock(1);
        expect(textarea.value).toBe("before();");
        expect(
            document.querySelectorAll(".diff-pane-left .code-block.editing .line-number"),
        ).toHaveLength(1);
        expect(document.querySelectorAll(".diff-pane-left .diff-editable-block")).toHaveLength(1);
    });

    it("cancels a block draft on Escape without posting a document edit", async () => {
        const vscode = installVsCodeMock();
        await mountEditablePane("shared();\nbefore();", 1);

        const textarea = editBlock(1);
        setDraftText(textarea, "after();");
        act(() => {
            textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        });

        expect(sentDeltas(vscode)).toEqual([]);
        expect(document.querySelector("[data-testid='diff-pane-left-editable']")).toBeNull();
        expect(document.body.textContent).toContain("before();");
    });

    it("discards an active block draft when the host reports an external change", async () => {
        const vscode = installVsCodeMock();
        await mountEditablePane("shared();\nbefore();", 1);

        const textarea = editBlock(1);
        setDraftText(textarea, "localDraft();");
        dispatchHostMessage({
            type: "setDiffData",
            data: {
                ...diffFixture,
                segments: [
                    { type: "common" as const, left: ["shared();"], right: ["shared();"] },
                    { type: "changed" as const, left: ["hostText();"], right: ["after();"] },
                ],
                editablePane: "left" as const,
                editableText: "shared();\nhostText();",
                documentVersion: 2,
                editableReseedToken: 1,
            },
        });
        await flush();

        expect(document.querySelector("[data-testid='diff-pane-left-editable']")).toBeNull();
        expect(document.body.textContent).toContain("hostText();");
        expect(sentDeltas(vscode)).toEqual([]);
    });

    it("posts no delta when an unchanged block loses focus", async () => {
        const vscode = installVsCodeMock();
        await mountEditablePane("shared();\nbefore();", 1);

        commitDraft(editBlock(1));

        expect(sentDeltas(vscode)).toEqual([]);
    });

    it("commits one block as exactly one stamped document delta when editing ends", async () => {
        const vscode = installVsCodeMock();
        await mountEditablePane("shared();\nbefore();", 1);

        const textarea = editBlock(1);
        setDraftText(textarea, "after();");
        setDraftText(textarea, "afterAgain();");
        commitDraft(textarea);

        expect(sentDeltas(vscode)).toEqual([
            {
                baseVersion: 1,
                baseReseedToken: 0,
                startOffset: 10,
                endOffset: 16,
                text: "afterAgain",
            },
        ]);
    });

    it("spans the whole surrogate pair when a block changes one astral character to another", async () => {
        const vscode = installVsCodeMock();
        const grin = String.fromCodePoint(0x1f600);
        const smile = String.fromCodePoint(0x1f601);
        await mountEditablePane("a" + grin + "b", 1, [
            { type: "common" as const, left: ["a" + grin + "b"], right: ["a" + grin + "b"] },
        ]);

        const textarea = editBlock(0);
        setDraftText(textarea, "a" + smile + "b");
        commitDraft(textarea);

        expect(sentDeltas(vscode)).toEqual([
            { baseVersion: 1, baseReseedToken: 0, startOffset: 1, endOffset: 3, text: smile },
        ]);
    });

    it("spans the whole surrogate pair when block suffixes share a low surrogate", async () => {
        const vscode = installVsCodeMock();
        const grin = String.fromCodePoint(0x1f600);
        const chessKing = String.fromCodePoint(0x1fa00);
        expect(grin.charCodeAt(1)).toBe(chessKing.charCodeAt(1));
        await mountEditablePane("a" + grin + "b", 1, [
            { type: "common" as const, left: ["a" + grin + "b"], right: ["a" + grin + "b"] },
        ]);

        const textarea = editBlock(0);
        setDraftText(textarea, "a" + chessKing + "b");
        commitDraft(textarea);

        expect(sentDeltas(vscode)).toEqual([
            { baseVersion: 1, baseReseedToken: 0, startOffset: 1, endOffset: 3, text: chessKing },
        ]);
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
            document.querySelector(".diff-pane-left .diff-editable-block"),
            "a refresh failure must not unmount the document-backed block surface",
        ).not.toBeNull();
    });

    it("renders an added editable file through line-numbered CodeBlock rows", async () => {
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
        const editablePane = document.querySelector(".diff-pane-right");
        expect(editablePane?.querySelectorAll(".line-number-row")).toHaveLength(40);
        expect(editablePane?.querySelectorAll(".code-line")).toHaveLength(40);
        expect(editablePane?.querySelector(".code-lines")).not.toBeNull();
        expect(editablePane?.querySelector("textarea")).toBeNull();
        expect(spacer?.style.height, "the block rows own the canonical scroll range").toBe("800px");
    });

    it("keeps terminal-newline metadata out of the editable pane's aligned row count", async () => {
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

        const spacer = document.querySelector<HTMLElement>(".diff-vscroll-spacer");
        const editablePane = document.querySelector(".diff-pane-left");
        expect(editablePane?.querySelectorAll(".line-number-row")).toHaveLength(40);
        expect(editablePane?.querySelectorAll(".code-line")).toHaveLength(40);
        expect(spacer?.style.height).toBe("800px");
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

        expect(document.querySelector(".diff-pane-right")).not.toBeNull();
        expect(document.querySelector(".diff-pane-right textarea")).toBeNull();
    });

    it("feeds each editable block through the same intrinsic segment sizing as its immutable peer", async () => {
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
                editableText: [...block(20, "a"), ...block(10, "c")].join("\n"),
                documentVersion: 1,
                editableReseedToken: 0,
            },
        });
        await flush();

        const blocks = [
            ...document.querySelectorAll<HTMLElement>(".diff-pane-left .diff-editable-block"),
        ];
        expect(blocks.map((block) => block.style.containIntrinsicSize)).toEqual([
            "auto 400px",
            "auto 200px",
        ]);
        expect(blocks.map((block) => block.querySelectorAll(".code-line").length)).toEqual([
            20, 10,
        ]);
    });

    it("keeps a short editable block distinct from a taller immutable block", async () => {
        installVsCodeMock();
        createRootHost();
        await act(async () => {
            await import("../../../src/webviews/react/diff-viewer/DiffViewerApp");
        });
        await flush();

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

        const editableBlock = document.querySelector<HTMLElement>(
            ".diff-pane-right .diff-editable-block",
        );
        expect(editableBlock?.style.containIntrinsicSize).toBe("auto 20px");
        expect(editableBlock?.querySelectorAll(".code-line")).toHaveLength(1);
        expect(document.querySelectorAll(".diff-pane-left .code-line")).toHaveLength(40);
    });

    it("sizes an edit textarea from the selected block, not the whole document", async () => {
        installVsCodeMock();
        await mountEditablePane("first();\nsecond();\nthird();", 1, [
            {
                type: "common" as const,
                left: ["first();", "second();"],
                right: ["first();", "second();"],
            },
            { type: "common" as const, left: ["third();"], right: ["third();"] },
        ]);

        const textarea = editBlock(1);
        expect(textarea.value).toBe("third();");
        expect(textarea.rows).toBe(1);
    });

    it("keeps a composing draft mounted through a reseed, then discards it without posting", async () => {
        const vscode = installVsCodeMock();
        await mountEditablePane("shared();\nbefore();", 1);

        const textarea = editBlock(1);
        act(() => {
            textarea.dispatchEvent(new Event("compositionstart", { bubbles: true }));
        });
        setDraftText(textarea, "composed();");
        dispatchHostMessage({
            type: "setDiffData",
            data: {
                ...diffFixture,
                editablePane: "left" as const,
                editableText: "shared();\nhostText();",
                documentVersion: 2,
                editableReseedToken: 1,
            },
        });
        await flush();

        const composingTextarea = document.querySelector<HTMLTextAreaElement>(
            "[data-testid='diff-pane-left-editable']",
        );
        expect(composingTextarea?.value).toBe("composed();");
        act(() => {
            composingTextarea?.dispatchEvent(new Event("compositionend", { bubbles: true }));
        });
        await flush();

        expect(document.querySelector("[data-testid='diff-pane-left-editable']")).toBeNull();
        expect(sentDeltas(vscode)).toEqual([]);
    });

    it("does not commit a composing draft that loses focus after a reseed", async () => {
        const vscode = installVsCodeMock();
        await mountEditablePane("shared();\nbefore();", 1);

        const textarea = editBlock(1);
        act(() => {
            textarea.dispatchEvent(new Event("compositionstart", { bubbles: true }));
        });
        setDraftText(textarea, "composed();");
        dispatchHostMessage({
            type: "setDiffData",
            data: {
                ...diffFixture,
                editablePane: "left" as const,
                editableText: "shared();\nhostText();",
                documentVersion: 2,
                editableReseedToken: 1,
            },
        });
        await flush();

        commitDraft(textarea);

        expect(sentDeltas(vscode)).toEqual([]);
    });

    it("opens editable blocks from Enter and F2 with their editing announcements", async () => {
        installVsCodeMock();
        await mountEditablePane("shared();\nbefore();", 1);

        const block = document.querySelector<HTMLElement>(".diff-pane-left .diff-editable-block");
        expect(block?.getAttribute("role")).toBe("group");
        expect(block?.getAttribute("aria-label")).toBe("Double-click or press Enter to edit");
        expect(block?.title).toBe("Double-click or press Enter to edit");

        act(() => {
            block?.focus();
        });
        expect(document.activeElement).toBe(block);
        const enter = new KeyboardEvent("keydown", {
            key: "Enter",
            bubbles: true,
            cancelable: true,
        });
        act(() => {
            block?.dispatchEvent(enter);
        });
        expect(enter.defaultPrevented).toBe(true);
        const enterTextarea = document.querySelector<HTMLTextAreaElement>(
            "[data-testid='diff-pane-left-editable']",
        );
        expect(enterTextarea?.getAttribute("aria-label")).toBe("Edit working tree block");
        act(() => {
            enterTextarea?.dispatchEvent(
                new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
            );
        });

        const f2 = new KeyboardEvent("keydown", { key: "F2", bubbles: true, cancelable: true });
        act(() => {
            block?.focus();
            block?.dispatchEvent(f2);
        });
        expect(f2.defaultPrevented).toBe(true);
        expect(document.querySelector("[data-testid='diff-pane-left-editable']")).not.toBeNull();
    });

    it("synchronizes an edit textarea with peer code lines in both directions", async () => {
        installVsCodeMock();
        await mountEditablePane("shared();\nbefore();", 1);

        const textarea = editBlock(1);
        const counterpart = document.querySelector<HTMLElement>(".diff-pane-right .code-lines");
        const sharedBar = document.querySelector<HTMLElement>(".diff-horizontal-scroll");
        expect(counterpart).not.toBeNull();
        expect(sharedBar).not.toBeNull();
        Object.defineProperties(counterpart as HTMLElement, {
            clientWidth: { configurable: true, value: 20 },
            scrollWidth: { configurable: true, value: 100 },
        });
        Object.defineProperties(textarea, {
            clientWidth: { configurable: true, value: 20 },
            scrollWidth: { configurable: true, value: 100 },
        });
        const raf = vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation((callback) => {
            callback(0);
            return 0;
        });
        try {
            act(() => {
                textarea.scrollLeft = 37;
                textarea.dispatchEvent(new Event("scroll", { bubbles: true }));
            });
            expect(counterpart?.scrollLeft).toBe(37);
            expect(sharedBar?.scrollLeft).toBe(37);

            act(() => {
                (sharedBar as HTMLElement).scrollLeft = 19;
                sharedBar?.dispatchEvent(new Event("scroll", { bubbles: true }));
            });
            expect(textarea.scrollLeft).toBe(19);
        } finally {
            raf.mockRestore();
        }
    });

    it("extends the shared scroll range as an active draft grows", async () => {
        installVsCodeMock();
        await mountEditablePane("before();", 1, [
            { type: "changed" as const, left: ["before();"], right: ["after();"] },
        ]);

        const textarea = editBlock(0);
        const draftLines = Array.from({ length: 7 }, (_, index) => `draft${index}();`);
        setDraftText(textarea, draftLines.join("\n"));

        const spacer = document.querySelector<HTMLElement>(".diff-vscroll-spacer");
        const editingBlock = textarea.closest<HTMLElement>(".diff-editing-block");
        expect(textarea.rows).toBe(draftLines.length);
        expect(editingBlock?.style.containIntrinsicSize).toBe(
            `auto ${draftLines.length * LINE_HEIGHT_PX}px`,
        );
        expect(spacer?.style.height).toBe(`${draftLines.length * LINE_HEIGHT_PX}px`);
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

async function mountScrollFixture(editablePane?: "left" | "right"): Promise<{
    content: HTMLElement;
    ribbons: Element[];
}> {
    installVsCodeMock();
    createRootHost();
    await act(async () => {
        await import("../../../src/webviews/react/diff-viewer/DiffViewerApp");
    });
    await flush();
    dispatchHostMessage({
        type: "setDiffData",
        data: editablePane
            ? {
                  ...scrollFixture,
                  editablePane,
                  editableText: scrollFixture.segments
                      .flatMap((segment) => segment[editablePane])
                      .join("\n"),
                  documentVersion: 1,
                  editableReseedToken: 0,
              }
            : scrollFixture,
    });
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

    it("keeps editable CodeBlock rows at the immutable pane's canonical offsets and in horizontal sync", async () => {
        const { content } = await mountScrollFixture("left");
        const editableBlocks = document.querySelectorAll(".diff-pane-left .diff-editable-block");
        const editableLines = document.querySelector<HTMLElement>(".diff-pane-left .code-lines");
        const immutableLines = document.querySelector<HTMLElement>(".diff-pane-right .code-lines");

        expect(editableBlocks).toHaveLength(scrollFixture.segments.length);
        expect(editableLines).not.toBeNull();
        expect(immutableLines).not.toBeNull();

        scrollTo(content, MID_HUNK_SCROLL_PX);
        expect(document.querySelector<HTMLElement>(".diff-pane-left")?.style.transform).toBe(
            `translateY(-${LEFT_OFFSET_AT_MID_HUNK_PX}px)`,
        );
        expect(document.querySelector<HTMLElement>(".diff-pane-right")?.style.transform).toBe(
            `translateY(-${RIGHT_OFFSET_AT_MID_HUNK_PX}px)`,
        );

        Object.defineProperty(editableLines!, "scrollWidth", { configurable: true, value: 1200 });
        Object.defineProperty(immutableLines!, "scrollWidth", { configurable: true, value: 1200 });
        Object.defineProperty(editableLines!, "scrollLeft", {
            configurable: true,
            writable: true,
            value: 42,
        });
        act(() => {
            editableLines?.dispatchEvent(new Event("scroll", { bubbles: true }));
        });
        expect(immutableLines?.scrollLeft).toBe(42);
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
