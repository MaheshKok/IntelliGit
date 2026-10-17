// @vitest-environment jsdom
import React, { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { useVisibleFileStats } from "../../../src/webviews/react/commit-panel/hooks/useVisibleFileStats";
import { initReactDomTestEnvironment, mount, unmount } from "../../helpers/reactDomTestUtils";

const api = vi.hoisted(() => ({ postMessage: vi.fn() }));
vi.mock("../../../src/webviews/react/shared/vscodeApi", () => ({ getVsCodeApi: () => api }));
initReactDomTestEnvironment();

function Harness({ root, revision }: { root: string; revision: string }) {
    const visible = useVisibleFileStats(root);
    return (
        <button
            onClick={() => {
                for (let i = 0; i < 170; i++)
                    visible({
                        path: `file-${i % 150}.txt`,
                        status: "M",
                        staged: false,
                        additions: 0,
                        deletions: 0,
                        statsState: "pending",
                        statsRevision: revision,
                    });
            }}
        >
            Visible
        </button>
    );
}

describe("visible file statistics batching", () => {
    it("deduplicates rows and caps every request at 128 literal paths", () => {
        vi.useFakeTimers();
        const mounted = mount(<Harness root="/repo" revision="one" />);
        try {
            act(() => mounted.container.querySelector("button")!.click());
            expect(api.postMessage).not.toHaveBeenCalled();
            act(() => vi.advanceTimersByTime(24));
            const messages = api.postMessage.mock.calls.map(([value]) => value);
            expect(messages).toHaveLength(2);
            expect(messages.flatMap((value) => value.paths)).toHaveLength(150);
            for (const value of messages) {
                expect(value).toMatchObject({
                    type: "requestWorkingFileStats",
                    repositoryRoot: "/repo",
                    revision: "one",
                });
                expect(value.paths.length).toBeLessThanOrEqual(128);
            }
        } finally {
            unmount(mounted.root, mounted.container);
            vi.useRealTimers();
        }
    });

    it("drops queued paths when the rendered repository changes", () => {
        vi.useFakeTimers();
        const mounted = mount(<Harness root="/old" revision="old" />);
        try {
            act(() => mounted.container.querySelector("button")!.click());
            act(() => mounted.root.render(<Harness root="/new" revision="new" />));
            act(() => mounted.container.querySelector("button")!.click());
            act(() => vi.advanceTimersByTime(24));
            expect(api.postMessage).toHaveBeenCalledTimes(2);
            for (const [value] of api.postMessage.mock.calls)
                expect(value).toMatchObject({ repositoryRoot: "/new", revision: "new" });
        } finally {
            unmount(mounted.root, mounted.container);
            vi.useRealTimers();
        }
    });
});
