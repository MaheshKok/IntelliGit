import { useEffect, useLayoutEffect, type MutableRefObject } from "react";
import type { WorkbenchKeyCommands } from "./codeEditor";
import type { useWorkbenchCommands } from "./useWorkbenchCommands";
import type { WorkbenchHunk } from "./workbenchModel";
import { workbenchCounts } from "./workbenchLayout";

function historyCommand(event: KeyboardEvent) {
    if (!event.ctrlKey && !event.metaKey) return;
    const key = event.key.toLowerCase();
    if (key === "z" && !event.shiftKey) return "undoResult";
    if ((key === "z" && event.shiftKey) || key === "y") return "redoResult";
}

function keyCommand(event: KeyboardEvent) {
    const normalizedKey = event.key.toLowerCase();
    const hasCommandModifier = event.ctrlKey || event.metaKey;
    const plainKey = !hasCommandModifier && !event.altKey;
    if ((normalizedKey === "p" && plainKey) || (event.shiftKey && event.key === "F7"))
        return "prev";
    if ((normalizedKey === "n" && plainKey) || event.key === "F7") return "next";
    if (hasCommandModifier && event.key === "ArrowLeft") return "ours";
    if (hasCommandModifier && event.key === "ArrowRight") return "theirs";
    if (normalizedKey === "b" && plainKey) return "both";
    if (normalizedKey === "x" && plainKey) return "none";
    if (hasCommandModifier && event.key === "Enter") return "apply";
    return historyCommand(event);
}

/** Keeps typing keys in editors and form controls, with classic shortcuts elsewhere. */
export function useWorkbenchKeyboard(
    hunks: readonly WorkbenchHunk[],
    commands: ReturnType<typeof useWorkbenchCommands>,
    keymap: MutableRefObject<WorkbenchKeyCommands | null>,
) {
    const unresolved = workbenchCounts(hunks).unresolved;
    useLayoutEffect(() => {
        keymap.current = {
            next: () => commands.moveActive(1),
            prev: () => commands.moveActive(-1),
            applyIfClean: () => {
                if (unresolved !== 0) return false;
                commands.apply();
                return true;
            },
        };
    }, [commands, keymap, unresolved]);

    useEffect(() => {
        const handlers = {
            prev: () => commands.moveActive(-1),
            next: () => commands.moveActive(1),
            ours: () => commands.resolveFromKeyboard("ours"),
            theirs: () => commands.resolveFromKeyboard("theirs"),
            both: () => commands.resolveFromKeyboard("both"),
            none: () => commands.resolveFromKeyboard("none"),
            apply: commands.apply,
            undoResult: commands.undoResult,
            redoResult: commands.redoResult,
        };
        const onKeyDown = (event: KeyboardEvent) => {
            const target = event.target;
            if (
                target instanceof Element &&
                (target.closest(".cm-content") ||
                    ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
            )
                return;
            const command = keyCommand(event);
            if (!command) return;
            if (command === "apply" && unresolved !== 0) return;
            event.preventDefault();
            handlers[command]();
        };
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, [commands, unresolved]);
}
