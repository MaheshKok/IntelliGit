import { useLayoutEffect, type RefObject } from "react";

export function restoreShelfDialogFocus(target: HTMLElement | null | undefined): void {
    if (target?.isConnected) target.focus();
}

/** Moves focus into a shelf dialog and returns it to its invoking control on dismissal. */
export function useShelfDialogFocus(
    target: HTMLElement | null | undefined,
    initialFocusRef: RefObject<HTMLElement>,
): void {
    useLayoutEffect(() => {
        initialFocusRef.current?.focus();
        return () => restoreShelfDialogFocus(target);
    }, [initialFocusRef, target]);
}
