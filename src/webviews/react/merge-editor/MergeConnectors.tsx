import React, { useLayoutEffect, useRef, type RefObject } from "react";
import type { EditorView } from "@codemirror/view";
import { VscChevronLeft, VscChevronRight, VscClose } from "react-icons/vsc";
import { workbenchChangeClass, type WorkbenchHunk } from "./workbenchModel";
import { t } from "../shared/i18n";

/** Links visible input changes to their live result ranges with inline accept controls. */
export function MergeConnectors({
    editors,
    hunks,
    side,
    busy,
    accept,
    discard,
}: {
    editors: RefObject<Array<{ view: EditorView }>>;
    hunks: readonly WorkbenchHunk[];
    side: "ours" | "theirs";
    busy: boolean;
    accept: (index: number) => void;
    discard: (index: number) => void;
}) {
    const host = useRef<HTMLDivElement | null>(null);
    // react-doctor-disable-next-line react-doctor/effect-needs-cleanup -- Every pane listener, ResizeObserver and pending animation frame is released by the returned cleanup.
    useLayoutEffect(() => {
        const node = host.current;
        const views = editors.current;
        if (!node || !views || views.length < 3) return;
        const pane = side === "ours" ? 0 : 2;
        let frame = 0;
        const draw = () => {
            frame = 0;
            const box = node.getBoundingClientRect();
            const extent = (view: EditorView, from: number, to: number): [number, number] => {
                const start = view.lineBlockAt(Math.min(from, view.state.doc.length));
                const last = view.lineBlockAt(
                    Math.min(Math.max(from, to - 1), view.state.doc.length),
                );
                const top = view.documentTop - box.top;
                return [start.top + top, Math.max(start.top + 3, last.bottom) + top];
            };
            hunks.forEach((hunk, index) => {
                const input = extent(
                    views[pane].view,
                    pane === 0 ? hunk.oursFrom : hunk.theirsFrom,
                    pane === 0 ? hunk.oursTo : hunk.theirsTo,
                );
                const result = extent(views[1].view, hunk.from, hunk.to);
                const [left, right] = side === "ours" ? [input, result] : [result, input];
                const path = node.querySelector<SVGPathElement>(`[data-ribbon="${index}"]`);
                if (path) {
                    path.style.display =
                        Math.max(left[1], right[1]) < 0 || Math.min(left[0], right[0]) > box.height
                            ? "none"
                            : "";
                    path.setAttribute(
                        "d",
                        `M0 ${left[0]} C14 ${left[0]} 14 ${right[0]} 28 ${right[0]} L28 ${right[1]} C14 ${right[1]} 14 ${left[1]} 0 ${left[1]} Z`,
                    );
                }
                const actions = node.querySelector<HTMLElement>(`[data-actions="${index}"]`);
                if (actions) {
                    actions.style.top = `${input[0] - 2}px`;
                    actions.hidden = input[0] < 0 || input[0] > box.height - 20;
                }
            });
        };
        const schedule = () => {
            if (!frame) frame = requestAnimationFrame(draw);
        };
        const resize = new ResizeObserver(schedule);
        resize.observe(node);
        for (const { view } of views.slice(0, 3))
            view.scrollDOM.addEventListener("scroll", schedule);
        schedule();
        return () => {
            cancelAnimationFrame(frame);
            resize.disconnect();
            for (const { view } of views.slice(0, 3))
                view.scrollDOM.removeEventListener("scroll", schedule);
        };
    }, [editors, hunks, side]);
    const label = t(side === "ours" ? "merge.workbench.takeOurs" : "merge.workbench.takeTheirs");
    return (
        <div className={`mw-connectors mw-connectors-${side}`} ref={host}>
            <svg width="28" height="100%" aria-hidden="true">
                {hunks.map((hunk, index) => (
                    <path
                        key={hunk.id}
                        data-ribbon={index}
                        className={workbenchChangeClass(hunk)}
                    />
                ))}
            </svg>
            {hunks.map((hunk, index) => (
                <div key={hunk.id} className="mw-actions" data-actions={index}>
                    <button
                        className="action-btn discard-btn"
                        disabled={busy}
                        title={t("merge.status.removeBlock")}
                        aria-label={t("merge.status.removeBlock")}
                        onClick={() => discard(index)}
                    >
                        <VscClose />
                    </button>
                    <button
                        className="action-btn accept-btn"
                        data-accept={index}
                        disabled={busy}
                        title={label}
                        aria-label={label}
                        onClick={() => accept(index)}
                    >
                        {side === "ours" ? <VscChevronRight /> : <VscChevronLeft />}
                    </button>
                </div>
            ))}
        </div>
    );
}
