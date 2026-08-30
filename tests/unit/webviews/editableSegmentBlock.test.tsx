// @vitest-environment jsdom

import React, { act, useState } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mount, unmount } from "../../helpers/reactDomTestUtils";
import type { DiffPane } from "../../../src/webviews/react/diff-viewer/segmentMarkers";
import type { LineNumberSpec } from "../../../src/webviews/react/diff-core/segments";
import {
    EditableSegmentBlock,
    type EditableSegmentItem,
} from "../../../src/webviews/react/diff-viewer/EditableSegmentBlock";

const intrinsicSizeStyle = vi.hoisted(() => vi.fn());
const unequalLengthAlignmentCalls = vi.hoisted(() => vi.fn());

vi.mock("../../../src/diff/wordDiff", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../../src/diff/wordDiff")>();
    return {
        ...actual,
        alignCompareLinesForWordDiff: (
            ...args: Parameters<typeof actual.alignCompareLinesForWordDiff>
        ) => {
            if (args[0].length !== args[1].length) unequalLengthAlignmentCalls();
            return actual.alignCompareLinesForWordDiff(...args);
        },
    };
});

vi.mock("../../../src/webviews/react/diff-core/segments", async (importOriginal) => {
    const actual =
        await importOriginal<typeof import("../../../src/webviews/react/diff-core/segments")>();
    return {
        ...actual,
        intrinsicSizeStyle: (...args: Parameters<typeof actual.intrinsicSizeStyle>) => {
            intrinsicSizeStyle(...args);
            return actual.intrinsicSizeStyle(...args);
        },
    };
});

function item(right: string | string[]): EditableSegmentItem {
    const rightLines = typeof right === "string" ? [right] : right;
    const lineNumbers: LineNumberSpec = { primary: rightLines.map((_, index) => index + 1) };
    return {
        segment: {
            type: "changed",
            left: rightLines.map(() => "before"),
            right: rightLines,
        },
        index: 0,
        paneLines: { left: rightLines.length, right: rightLines.length },
        lineNumbers: { left: lineNumbers, right: lineNumbers },
        canonicalLineCount: rightLines.length,
    };
}

function Parent({ renderedItem }: { renderedItem: EditableSegmentItem }): React.ReactElement {
    const [unrelated, setUnrelated] = useState(0);
    const onStartEditing = React.useCallback(() => undefined, []);
    return (
        <>
            <button type="button" onClick={() => setUnrelated((value) => value + 1)}>
                {unrelated}
            </button>
            <EditableSegmentBlock
                item={renderedItem}
                side="right"
                lineNumberSide="left"
                highlightWords
                onStartEditing={onStartEditing}
            />
        </>
    );
}

beforeAll(() => {
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
        value: true,
        configurable: true,
    });
});

afterEach(() => {
    Reflect.deleteProperty(document, "caretPositionFromPoint");
    vi.clearAllMocks();
});

describe("EditableSegmentBlock render isolation", () => {
    it("renders an asymmetric block from its cached aligned counterparts", () => {
        const lineNumbers: LineNumberSpec = { primary: [1, 2, 3] };
        const renderedItem: EditableSegmentItem = {
            segment: {
                type: "changed",
                left: ["left 0", "left 1"],
                right: ["right 0", "right 1", "right 2"],
            },
            index: 0,
            alignedCompareLines: {
                left: ["right 0", "right 2"],
                right: ["left 0", "", "left 1"],
            },
            paneLines: { left: 2, right: 3 },
            lineNumbers: { left: lineNumbers, right: lineNumbers },
            canonicalLineCount: 3,
        };
        const mounted = mount(
            <EditableSegmentBlock
                item={renderedItem}
                side="right"
                lineNumberSide="left"
                highlightWords
                onStartEditing={() => undefined}
            />,
        );

        expect(
            unequalLengthAlignmentCalls,
            "the inactive editable block must not repeat unequal-length alignment",
        ).not.toHaveBeenCalled();
        unmount(mounted.root, mounted.container);
    });

    it("counts an empty preceding source line as zero caret positions", () => {
        const renderedItem = item(["", "plain"]);
        const onStartEditing = vi.fn();
        const mounted = mount(
            <EditableSegmentBlock
                item={renderedItem}
                side="right"
                lineNumberSide="left"
                highlightWords
                onStartEditing={onStartEditing}
            />,
        );
        const rows = mounted.container.querySelectorAll<HTMLElement>(
            ".code-lines > .real-code-line",
        );
        const textNode = document
            .createTreeWalker(rows[1], NodeFilter.SHOW_TEXT)
            .nextNode() as Text;
        Object.defineProperty(document, "caretPositionFromPoint", {
            configurable: true,
            value: () => ({ offsetNode: textNode, offset: 2 }),
        });

        act(() => {
            mounted.container
                .querySelector<HTMLElement>(".diff-editable-block")
                ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        });

        expect(onStartEditing).toHaveBeenCalledWith(renderedItem, 3);
        unmount(mounted.root, mounted.container);
    });

    it("does not render for an unrelated parent update but does render when the item changes", () => {
        const initialItem = item("after");
        const changedItem = item("rendered");
        const mounted = mount(<Parent renderedItem={initialItem} />);

        expect(
            intrinsicSizeStyle,
            "initial mount must size the editable segment exactly once",
        ).toHaveBeenCalledTimes(1);

        act(() => {
            mounted.container
                .querySelector("button")
                ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        });

        expect(
            intrinsicSizeStyle,
            "unrelated parent updates must not re-render the editable segment",
        ).toHaveBeenCalledTimes(1);

        act(() => {
            mounted.root.render(<Parent renderedItem={changedItem} />);
        });

        expect(
            intrinsicSizeStyle,
            "changed RenderedSegment props must re-render the editable segment",
        ).toHaveBeenCalledTimes(2);

        unmount(mounted.root, mounted.container);
    });
});
