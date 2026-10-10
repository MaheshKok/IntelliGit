// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
    drawRibbons,
    measureRibbonSpans,
    MERGE_PANES,
    requirePxVar,
    type ConnectorRenderSpec,
} from "../../../src/webviews/react/merge-editor/mergeRibbons";
import {
    buildVerticalLayout,
    LINE_HEIGHT_PX,
    ribbonOutlineD,
    ribbonPathD,
} from "../../../src/webviews/react/diff-core/mergeScrollLayout";

function columns() {
    return {
        left: { offsetLeft: 0, offsetWidth: 200 } as HTMLElement,
        middle: { offsetLeft: 228, offsetWidth: 240 } as HTMLElement,
        right: { offsetLeft: 496, offsetWidth: 220 } as HTMLElement,
    };
}

function spans() {
    return measureRibbonSpans(columns(), (_col, actions) => (actions ? 50 : 30))!;
}

function path() {
    return document.createElementNS("http://www.w3.org/2000/svg", "path");
}

describe("merge ribbons", () => {
    it("requirePxVar throws for a missing variable", () => {
        const element = document.createElement("div");
        document.body.append(element);
        try {
            const message = "merge-editor: CSS variable --x is missing or 0";
            expect(() => requirePxVar(element, "--x")).toThrow(new Error(message));
            element.style.setProperty("--x", "12px");
            expect(requirePxVar(element, "--x")).toBe(12);
            for (const invalid of ["0px", "-1px", "Infinity", "invalid"]) {
                element.style.setProperty("--x", invalid);
                expect(() => requirePxVar(element, "--x")).toThrow(new Error(message));
            }
        } finally {
            element.remove();
        }
    });
    it("measures main's band and contour spans and waits for all columns", () => {
        // Edges: 200, 468, 716. Content boundaries: 200-50, 228+30, 496+50.
        expect(spans()).toEqual({
            left: {
                band: { x0: 150, curveX0: 200, curveX1: 228, x1: 258 },
                contour: { x0: 0, curveX0: 150, curveX1: 258, x1: 468 },
            },
            right: {
                band: { x0: 468, curveX0: 468, curveX1: 496, x1: 546 },
                contour: { x0: 258, curveX0: 468, curveX1: 546, x1: 716 },
            },
        });
        for (const pane of MERGE_PANES) {
            expect(measureRibbonSpans({ ...columns(), [pane]: null }, () => 30)).toBeNull();
        }
    });
    it("draws pending bands and resolved contours at the applied offsets and culls offscreen hunks", () => {
        const layout = buildVerticalLayout(
            [
                { paneLines: { left: 2, middle: 3, right: 4 }, conflict: true, id: 7 },
                { paneLines: { left: 3, middle: 2, right: 2 }, conflict: true, id: 8 },
            ],
            MERGE_PANES,
        );
        const paths = new Map([
            ["7-left", path()],
            ["7-right", path()],
            ["8-left", path()],
        ]);
        const connectors: ConnectorRenderSpec[] = [
            {
                id: 7,
                index: 0,
                left: { colorClass: "change-conflict", resolved: false },
                right: {
                    colorClass: "change-conflict connector-resolved",
                    resolved: true,
                    midSlice: { top: 1, count: 2 },
                },
            },
            { id: 8, index: 1, left: { colorClass: "change-conflict", resolved: false } },
        ];
        const h = LINE_HEIGHT_PX;
        const measured = spans();
        drawRibbons(layout, { left: 5, middle: 7, right: 9 }, 10 * h, measured, connectors, paths);
        expect(paths.get("7-left")!.getAttribute("d")).toBe(
            ribbonPathD(measured.left.band, -5, 2 * h - 5, -7, 3 * h - 7),
        );
        expect(paths.get("7-right")!.getAttribute("d")).toBe(
            ribbonOutlineD(measured.right.contour, h - 7, 3 * h - 7, -9, 4 * h - 9),
        );
        expect(paths.get("7-left")!.style.display).toBe("");
        drawRibbons(
            layout,
            { left: 3 * h, middle: 4 * h, right: 5 * h },
            10 * h,
            measured,
            connectors,
            paths,
        );
        expect(paths.get("7-left")!.style.display).toBe("none");
        expect(paths.get("7-right")!.style.display).toBe("none");
        expect(paths.get("8-left")!.style.display).toBe("");
        drawRibbons(
            layout,
            { left: -2 * h, middle: -2 * h, right: -2 * h },
            h,
            measured,
            connectors,
            paths,
        );
        expect(paths.get("7-left")!.style.display).toBe("none");
    });
    it("extends an empty middle band and keeps zero-height targets three pixels tall", () => {
        const layout = buildVerticalLayout(
            [{ paneLines: { left: 2, middle: 0, right: 2 }, conflict: true, id: 7 }],
            MERGE_PANES,
        );
        const paths = new Map([["7-left", path()]]);
        const measured = spans();
        drawRibbons(
            layout,
            { left: 0, middle: 0, right: 0 },
            100,
            measured,
            [{ id: 7, index: 0, left: { colorClass: "change-conflict", resolved: false } }],
            paths,
        );
        expect(paths.get("7-left")!.getAttribute("d")).toBe(
            ribbonPathD(
                { ...measured.left.band, x1: measured.right.band.x0 },
                0,
                2 * LINE_HEIGHT_PX,
                0,
                3,
            ),
        );
    });
});
