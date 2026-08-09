import { describe, expect, it } from "vitest";

import {
    installAcquireVsCodeApiStub,
    type RecordedVsCodeApi,
} from "../../../visual/harness/acquireVsCodeApiStub";

interface TestVsCodeApi {
    readonly postMessage: (message: unknown) => void;
    readonly getState: () => unknown;
    readonly setState: (state: unknown) => void;
}

function acquireFrom(target: Record<string, unknown>): TestVsCodeApi {
    const acquire = target.acquireVsCodeApi as (() => TestVsCodeApi) | undefined;
    if (!acquire) throw new Error("Stub did not install acquireVsCodeApi.");
    return acquire();
}

describe("installAcquireVsCodeApiStub", () => {
    it("records messages in call order and round-trips state", () => {
        const target: Record<string, unknown> = {};
        const { recorder } = installAcquireVsCodeApiStub(target);
        const api = acquireFrom(target);

        expect(api.getState()).toBeUndefined();
        const state = { repository: "repo-a" };
        api.setState(state);
        api.postMessage({ type: "first" });
        api.postMessage({ type: "second" });

        expect(recorder()).toEqual({
            postedMessages: [{ type: "first" }, { type: "second" }],
            state,
        } satisfies RecordedVsCodeApi);
        expect(api.getState()).toBe(state);
    });

    it("can fail: a caller mutation cannot alter a later recorded snapshot", () => {
        const target: Record<string, unknown> = {};
        const { recorder } = installAcquireVsCodeApiStub(target);
        const api = acquireFrom(target);
        api.postMessage("original");

        const snapshot = recorder();
        (snapshot.postedMessages as unknown[]).push("mutated caller copy");

        expect(recorder().postedMessages).toEqual(["original"]);
    });

    it("can fail: a second acquire throws instead of creating a second channel", () => {
        const target: Record<string, unknown> = {};
        installAcquireVsCodeApiStub(target);
        const acquire = target.acquireVsCodeApi as () => TestVsCodeApi;

        acquire();
        expect(() => acquire()).toThrow(/only be acquired once|already acquired/i);
    });

    it("can fail: installing twice on one target throws", () => {
        const target: Record<string, unknown> = {};
        installAcquireVsCodeApiStub(target);

        expect(() => installAcquireVsCodeApiStub(target)).toThrow(/already installed/i);
    });
});
