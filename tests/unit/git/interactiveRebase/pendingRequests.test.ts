import { describe, expect, it } from "vitest";
import { createPendingRebaseDialogRequests } from "../../../../src/git/interactiveRebase/pendingRequests";

const HASH_A = "a".repeat(40);
const HASH_B = "b".repeat(40);

/** Builds a valid pending-dialog registration with explicit origin identity. */
function request(originProvider: object, repoRoot: string = "/repo") {
    return {
        originProvider,
        repoRoot,
        baseHash: HASH_A,
        rangeHashes: [HASH_A, HASH_B],
        expectedHead: HASH_B,
        expectedBranch: "refs/heads/main",
    };
}

describe("pending interactive-rebase dialog requests", () => {
    it("consumes a request once and exposes an immutable copy", () => {
        const origin = {};
        const requests = createPendingRebaseDialogRequests();
        const requestId = requests.register(request(origin));

        const first = requests.consume(requestId, origin);
        expect(first).toMatchObject({
            status: "consumed",
            request: {
                requestId,
                originProvider: origin,
                repoRoot: "/repo",
                rangeHashes: [HASH_A, HASH_B],
            },
        });
        if (first.status !== "consumed") throw new Error("Expected a consumed request.");
        expect(Object.isFrozen(first.request)).toBe(true);
        expect(Object.isFrozen(first.request.rangeHashes)).toBe(true);
        expect(requests.consume(requestId, origin)).toEqual({
            status: "rejected",
            reason: "unknown-or-expired",
        });
    });

    it("rejects a wrong origin without consuming the request", () => {
        const origin = {};
        const requests = createPendingRebaseDialogRequests();
        const requestId = requests.register(request(origin));

        expect(requests.consume(requestId, {})).toEqual({
            status: "rejected",
            reason: "wrong-origin",
        });
        expect(requests.consume(requestId, origin)).toMatchObject({ status: "consumed" });
    });

    it("rejects an unknown request id", () => {
        const requests = createPendingRebaseDialogRequests();

        expect(requests.consume("missing", {})).toEqual({
            status: "rejected",
            reason: "unknown-or-expired",
        });
    });

    it("expires requests through the injected clock without waiting", () => {
        let now = 0;
        const origin = {};
        const requests = createPendingRebaseDialogRequests({ now: () => now });
        const requestId = requests.register(request(origin));
        now = Number.MAX_SAFE_INTEGER;

        expect(requests.consume(requestId, origin)).toEqual({
            status: "rejected",
            reason: "unknown-or-expired",
        });
    });

    it("cancels requests by id and by disposed origin", () => {
        const originA = {};
        const originB = {};
        const requests = createPendingRebaseDialogRequests();
        const byId = requests.register(request(originA));
        const byOrigin = requests.register(request(originB));

        requests.cancel(byId);
        requests.cancelAllForOrigin(originB);

        expect(requests.consume(byId, originA)).toMatchObject({ status: "rejected" });
        expect(requests.consume(byOrigin, originB)).toMatchObject({ status: "rejected" });
    });

    it("scopes repository-switch cancellation to the origins that switched", () => {
        const docked = {};
        const undocked = {};
        const requests = createPendingRebaseDialogRequests();
        const dockedRequest = requests.register(request(docked));
        const undockedRequest = requests.register(request(undocked));
        const otherRootRequest = requests.register(request(docked, "/other-repo"));

        requests.cancelForOrigins([docked], "/repo");

        expect(requests.consume(dockedRequest, docked)).toMatchObject({ status: "rejected" });
        // The undocked window still shows /repo, so a docked switch must not close its dialog.
        expect(requests.consume(undockedRequest, undocked)).toMatchObject({ status: "consumed" });
        expect(requests.consume(otherRootRequest, docked)).toMatchObject({ status: "consumed" });
    });

    it("supersedes an earlier request from the same origin and repository", () => {
        const origin = {};
        const requests = createPendingRebaseDialogRequests();
        const first = requests.register(request(origin));
        const second = requests.register(request(origin));

        expect(requests.consume(first, origin)).toEqual({
            status: "rejected",
            reason: "unknown-or-expired",
        });
        expect(requests.consume(second, origin)).toMatchObject({ status: "consumed" });
    });

    it("keeps one request per origin and per repository rather than one overall", () => {
        const originA = {};
        const originB = {};
        const requests = createPendingRebaseDialogRequests();
        const sameOriginOtherRoot = requests.register(request(originA, "/other-repo"));
        const otherOriginSameRoot = requests.register(request(originB));

        // Registering for (originA, /repo) may only supersede that exact pair.
        requests.register(request(originA));

        expect(requests.consume(sameOriginOtherRoot, originA)).toMatchObject({
            status: "consumed",
        });
        expect(requests.consume(otherOriginSameRoot, originB)).toMatchObject({
            status: "consumed",
        });
    });

    it("issues a distinct crypto UUID for every registration", () => {
        const requests = createPendingRebaseDialogRequests();
        const first = requests.register(request({}));
        const second = requests.register(request({}));

        expect(first).not.toBe(second);
        expect(first).toMatch(/^[0-9a-f-]{36}$/i);
        expect(second).toMatch(/^[0-9a-f-]{36}$/i);
    });
});
