import React, { useLayoutEffect, useRef, type RefObject } from "react";
import type { EditorView } from "@codemirror/view";
import { VscArrowLeft, VscArrowRight } from "react-icons/vsc";
import type { WorkbenchHunk } from "./workbenchModel";
import { t } from "../shared/i18n";

/** Links visible input changes to their live result ranges with inline accept controls. */
export function MergeConnectors({
    editors,
    hunks,
    side,
    busy,
    accept,
}: {
    editors: RefObject<Array<{ view: EditorView }>>;
    hunks: readonly WorkbenchHunk[];
    side: "ours" | "theirs";
    busy: boolean;
    accept: (index: number) => void;
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
                        `M0 ${left[0]} C16 ${left[0]} 16 ${right[0]} 32 ${right[0]} L32 ${right[1]} C16 ${right[1]} 16 ${left[1]} 0 ${left[1]} Z`,
                    );
                }
                const button = node.querySelector<HTMLButtonElement>(`[data-accept="${index}"]`);
                if (button) {
                    button.style.top = `${input[0]}px`;
                    button.hidden = input[0] < 0 || input[0] > box.height - 22;
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
        <div className="mw-connectors" ref={host}>
            <svg width="32" height="100%" aria-hidden="true">
                {hunks.map((hunk, index) => (
                    <path
                        key={hunk.id}
                        data-ribbon={index}
                        className={hunk.resolved ? "resolved" : "pending"}
                    />
                ))}
            </svg>
            {hunks.map((hunk, index) => (
                <button
                    key={hunk.id}
                    data-accept={index}
                    disabled={busy}
                    title={label}
                    aria-label={label}
                    onClick={() => accept(index)}
                >
                    {side === "ours" ? <VscArrowRight /> : <VscArrowLeft />}
                </button>
            ))}
        </div>
    );
}
