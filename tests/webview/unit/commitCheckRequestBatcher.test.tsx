// @vitest-environment jsdom

import React, { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { useCommitCheckRequestBatcher } from "../../../src/webviews/react/commit-list/useCommitCheckRequestBatcher";

function Harness({
    expose,
    postMessage,
}: {
    expose: React.MutableRefObject<((hash: string) => void) | null>;
    postMessage: (message: unknown) => void;
}): null {
    const queue = useCommitCheckRequestBatcher(postMessage);
    useEffect(() => {
        expose.current = queue;
    }, [expose, queue]);
    return null;
}

beforeAll(() => {
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
        value: true,
        configurable: true,
    });
});

afterEach(() => {
    vi.useRealTimers();
});

describe("useCommitCheckRequestBatcher", () => {
    it("preserves the single-hash message shape for one request", async () => {
        vi.useFakeTimers();
        const host = document.createElement("div");
        const root = createRoot(host);
        const postMessage = vi.fn();
        const expose = { current: null as ((hash: string) => void) | null };

        await act(async () => {
            root.render(<Harness expose={expose} postMessage={postMessage} />);
        });
        act(() => {
            expose.current?.("abc1234");
            vi.runOnlyPendingTimers();
        });

        expect(postMessage).toHaveBeenCalledWith({ type: "requestCommitChecks", hash: "abc1234" });
        await act(async () => root.unmount());
    });

    it("coalesces multiple visible-row requests into one batch", async () => {
        vi.useFakeTimers();
        const host = document.createElement("div");
        const root = createRoot(host);
        const postMessage = vi.fn();
        const expose = { current: null as ((hash: string) => void) | null };

        await act(async () => {
            root.render(<Harness expose={expose} postMessage={postMessage} />);
        });
        act(() => {
            expose.current?.("abc1234");
            expose.current?.("def5678");
            expose.current?.("abc1234");
            vi.runOnlyPendingTimers();
        });

        expect(postMessage).toHaveBeenCalledTimes(1);
        expect(postMessage).toHaveBeenCalledWith({
            type: "requestCommitChecks",
            hashes: ["abc1234", "def5678"],
        });
        await act(async () => root.unmount());
    });
});
