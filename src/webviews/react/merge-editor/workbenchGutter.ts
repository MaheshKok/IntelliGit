import { RangeSet, type EditorState } from "@codemirror/state";
import { gutter, GutterMarker } from "@codemirror/view";
import type { RefObject } from "react";
import { t } from "../shared/i18n";
import { CHEVRON_PATH, CROSS_PATH, PLUS_PATH, MIRROR_TRANSFORM } from "./hunkActionGlyph";
import type { WorkbenchHunk } from "./workbenchModel";
import { hunkView, isPhantomLine } from "./workbenchRows";

type Side = "ours" | "theirs";

/** Routes gutter actions through the current workbench callbacks. */
export interface HunkActionCallbacks {
    accept: (index: number, side: Side) => void;
    dismiss: (index: number, side: Side) => void;
}

function glyphSvg(path: string, size: number, mirror = false) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    for (const [name, value] of Object.entries({
        width: String(size),
        height: String(size),
        viewBox: `0 0 ${size} ${size}`,
        fill: "none",
        stroke: "currentColor",
        "stroke-width": "1",
    }))
        svg.setAttribute(name, value);
    const shape = document.createElementNS("http://www.w3.org/2000/svg", "path");
    shape.setAttribute("d", path);
    if (mirror) shape.setAttribute("transform", MIRROR_TRANSFORM);
    svg.append(shape);
    return svg;
}

function actionButton(label: string, classes: string, onClick: () => void) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `action-btn ${classes}`;
    button.title = label;
    button.setAttribute("aria-label", label);
    button.addEventListener("mousedown", (event) => event.preventDefault());
    button.addEventListener("click", onClick);
    const glyph = document.createElement("span");
    glyph.className = "hunk-action-glyph";
    glyph.setAttribute("aria-hidden", "true");
    button.append(glyph);
    return { button, glyph };
}

function discardButton(label: string, onClick: () => void) {
    const { button, glyph } = actionButton(label, "discard-btn", onClick);
    glyph.append(glyphSvg(CROSS_PATH, 12));
    return button;
}

function acceptButton(label: string, marker: ActionMarker) {
    const classes = ["accept-btn", marker.append ? "append-btn" : "", marker.active ? "active" : ""]
        .filter(Boolean)
        .join(" ");
    const { button, glyph } = actionButton(label, classes, () =>
        marker.callbacks.current?.accept(marker.index, marker.side),
    );
    if (marker.active) button.setAttribute("aria-current", "true");
    glyph.append(glyphSvg(CHEVRON_PATH, 12, marker.side === "ours"));
    if (marker.append) glyph.append(glyphSvg(PLUS_PATH, 6));
    return button;
}

function leftActions(marker: ActionMarker) {
    return [
        discardButton(t("merge.hunk.ignoreLeft"), () =>
            marker.callbacks.current?.dismiss(marker.index, marker.side),
        ),
        acceptButton(t(marker.append ? "merge.hunk.appendLeft" : "merge.hunk.acceptLeft"), marker),
    ];
}

function rightActions(marker: ActionMarker) {
    return [
        acceptButton(
            t(marker.append ? "merge.hunk.appendRight" : "merge.hunk.acceptRight"),
            marker,
        ),
        discardButton(t("merge.hunk.ignoreRight"), () =>
            marker.callbacks.current?.dismiss(marker.index, marker.side),
        ),
    ];
}

class ActionMarker extends GutterMarker {
    readonly flags: string;

    constructor(
        readonly index: number,
        readonly side: Side,
        readonly append: boolean,
        readonly active: boolean,
        readonly callbacks: RefObject<HunkActionCallbacks | null>,
    ) {
        super();
        this.flags = `${index}:${side}:${append}:${active}`;
    }

    eq(other: ActionMarker) {
        return this.flags === other.flags;
    }

    toDOM() {
        const container = document.createElement("div");
        container.className =
            this.side === "ours" ? "conflict-actions-left" : "conflict-actions-right";
        container.addEventListener("click", (event) => event.stopPropagation());
        container.append(...(this.side === "ours" ? leftActions(this) : rightActions(this)));
        return container;
    }
}

/** Places main's side actions at each actionable hunk's first non-phantom line. */
export function actionGutter(
    side: Side,
    callbacks: RefObject<HunkActionCallbacks | null>,
    readHunks: (state: EditorState) => readonly WorkbenchHunk[],
    gutterSide: "before" | "after" = "before",
) {
    return gutter({
        class: "merge-action-gutter",
        side: gutterSide,
        renderEmptyElements: true,
        markers: ({ state }) =>
            RangeSet.of(
                readHunks(state).flatMap((hunk, index) => {
                    const view = hunkView(hunk);
                    const show = side === "ours" ? view.showLeftActions : view.showRightActions;
                    const line = state.doc.lineAt(Math.min(hunk.from, state.doc.length));
                    if (!show || isPhantomLine(state.doc, line)) return [];
                    return [
                        new ActionMarker(
                            index,
                            side,
                            side === "ours" ? view.leftAppend : view.rightAppend,
                            side === "ours" ? view.isOurs : view.isTheirs,
                            callbacks,
                        ).range(line.from),
                    ];
                }),
                true,
            ),
    });
}
