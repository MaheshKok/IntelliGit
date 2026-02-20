// Shared DOM test utilities for jsdom React component tests.

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, vi } from "vitest";

const mountedRoots = new Set<{ root: Root; container: HTMLDivElement }>();

export function mount(node: React.ReactElement): { container: HTMLDivElement; root: Root } {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
        root.render(node);
    });
    mountedRoots.add({ root, container });
    return { container, root };
}

export function unmount(root: Root, container: HTMLDivElement): void {
    act(() => {
        root.unmount();
    });
    container.remove();
    for (const entry of mountedRoots) {
        if (entry.root === root || entry.container === container) {
            mountedRoots.delete(entry);
        }
    }
}

export async function flush(): Promise<void> {
    await act(async () => {
        await Promise.resolve();
    });
}

export function initReactDomTestEnvironment(): void {
    beforeAll(() => {
        Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
            value: true,
            configurable: true,
        });
        Object.defineProperty(window, "matchMedia", {
            value: vi.fn().mockImplementation((query: string) => ({
                matches: false,
                media: query,
                onchange: null,
                addListener: vi.fn(),
                removeListener: vi.fn(),
                addEventListener: vi.fn(),
                removeEventListener: vi.fn(),
                dispatchEvent: vi.fn(),
            })),
            configurable: true,
        });

        class ResizeObserverMock {
            observe = vi.fn();
            unobserve = vi.fn();
            disconnect = vi.fn();
        }
        Object.defineProperty(globalThis, "ResizeObserver", {
            value: ResizeObserverMock,
            configurable: true,
        });
        vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => {
            return {
                setTransform: vi.fn(),
                clearRect: vi.fn(),
                beginPath: vi.fn(),
                arc: vi.fn(),
                fill: vi.fn(),
                stroke: vi.fn(),
                moveTo: vi.fn(),
                lineTo: vi.fn(),
                bezierCurveTo: vi.fn(),
                set lineCap(_: string) {},
                set lineWidth(_: number) {},
                set strokeStyle(_: string) {},
                set fillStyle(_: string) {},
            } as unknown as CanvasRenderingContext2D;
        });
    });

    afterEach(() => {
        for (const entry of Array.from(mountedRoots)) {
            const { root, container } = entry;
            act(() => {
                root.unmount();
            });
            container.remove();
            mountedRoots.delete(entry);
        }
        document.body.innerHTML = "";
        vi.clearAllMocks();
    });
}
