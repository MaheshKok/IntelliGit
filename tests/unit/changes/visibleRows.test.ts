import { describe, expect, it, vi } from "vitest";
import { observeVisibleRow } from "../../../src/webviews/react/shared/visibleRows";

describe("shared visible row observation", () => {
    it("uses one observer for many trees and reads only intersecting rows", () => {
        let receive!: IntersectionObserverCallback;
        const observe = vi.fn();
        const unobserve = vi.fn();
        const disconnect = vi.fn();
        const instances = vi.fn();
        vi.stubGlobal(
            "IntersectionObserver",
            class {
                constructor(callback: IntersectionObserverCallback) {
                    receive = callback;
                    instances();
                }
                observe = observe;
                unobserve = unobserve;
                disconnect = disconnect;
            },
        );
        const first = {} as Element;
        const second = {} as Element;
        const visible = vi.fn();
        const hidden = vi.fn();
        const stopFirst = observeVisibleRow(first, visible);
        const stopSecond = observeVisibleRow(second, hidden);
        try {
            expect(instances).toHaveBeenCalledOnce();
            receive(
                [
                    { target: first, isIntersecting: true },
                    { target: second, isIntersecting: false },
                ] as IntersectionObserverEntry[],
                {} as IntersectionObserver,
            );
            expect(visible).toHaveBeenCalledOnce();
            expect(hidden).not.toHaveBeenCalled();
            stopFirst();
            expect(disconnect).not.toHaveBeenCalled();
            stopSecond();
            expect(disconnect).toHaveBeenCalledOnce();
        } finally {
            stopFirst();
            stopSecond();
            vi.unstubAllGlobals();
        }
    });
});
