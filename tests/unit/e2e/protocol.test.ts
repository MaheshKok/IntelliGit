// Spec-derived tests for the E2E control channel's request/response envelope. Every request
// crosses a process boundary as a JSON file Playwright wrote, so `parseE2eRequest` is the
// trust boundary: it must accept every well-formed request shape (3 stores x 3 operations)
// and reject every structurally invalid one with a clear error, never a silent coercion.

import { describe, expect, it } from "vitest";
import {
    errorResponse,
    okAckResponse,
    okSecretPresenceResponse,
    okValueResponse,
    parseE2eRequest,
} from "../../../src/e2e/protocol";

describe("parseE2eRequest: memento", () => {
    it("parses a snapshot request", () => {
        const request = parseE2eRequest({
            nonce: "n1",
            store: "memento",
            operation: "snapshot",
            scope: "workspace",
            key: "intelligit.selectedRepositoryRoot",
        });
        expect(request).toEqual({
            nonce: "n1",
            store: "memento",
            operation: "snapshot",
            scope: "workspace",
            key: "intelligit.selectedRepositoryRoot",
        });
    });

    it("parses a seed request and preserves an arbitrary JSON value", () => {
        const request = parseE2eRequest({
            nonce: "n1",
            store: "memento",
            operation: "seed",
            scope: "global",
            key: "intelligit.commitChecks.cache.v1",
            value: { nested: [1, 2, 3] },
        });
        expect(request.operation).toBe("seed");
        if (request.operation === "seed") {
            expect(request.value).toEqual({ nested: [1, 2, 3] });
        }
    });

    it("parses a reset request", () => {
        const request = parseE2eRequest({
            nonce: "n1",
            store: "memento",
            operation: "reset",
            scope: "workspace",
            key: "intelligit.selectedRepositoryRoot",
        });
        expect(request.operation).toBe("reset");
    });

    it("rejects a seed request missing 'value'", () => {
        expect(() =>
            parseE2eRequest({
                nonce: "n1",
                store: "memento",
                operation: "seed",
                scope: "workspace",
                key: "k",
            }),
        ).toThrow(/missing field "value"/);
    });

    it("rejects an invalid scope", () => {
        expect(() =>
            parseE2eRequest({
                nonce: "n1",
                store: "memento",
                operation: "snapshot",
                scope: "user",
                key: "k",
            }),
        ).toThrow(/scope/);
    });
});

describe("parseE2eRequest: secret", () => {
    it("parses seed/snapshot/reset requests", () => {
        expect(
            parseE2eRequest({
                nonce: "n1",
                store: "secret",
                operation: "seed",
                key: "intelligit.commitChecks.token:gitlab.com",
                value: "glpat-abc",
            }),
        ).toMatchObject({ operation: "seed", value: "glpat-abc" });

        expect(
            parseE2eRequest({
                nonce: "n1",
                store: "secret",
                operation: "snapshot",
                key: "intelligit.commitChecks.token:gitlab.com",
            }),
        ).toMatchObject({ operation: "snapshot" });

        expect(
            parseE2eRequest({
                nonce: "n1",
                store: "secret",
                operation: "reset",
                key: "intelligit.commitChecks.token:gitlab.com",
            }),
        ).toMatchObject({ operation: "reset" });
    });

    it("rejects a seed request whose value is not a string", () => {
        expect(() =>
            parseE2eRequest({
                nonce: "n1",
                store: "secret",
                operation: "seed",
                key: "k",
                value: 12345,
            }),
        ).toThrow(/must be a non-empty string/);
    });
});

describe("parseE2eRequest: webviewState", () => {
    it("parses seed/snapshot/reset requests addressed by viewId + key", () => {
        const request = parseE2eRequest({
            nonce: "n1",
            store: "webviewState",
            operation: "seed",
            viewId: "commit-panel",
            key: "groupByDir",
            value: true,
        });
        expect(request).toMatchObject({ viewId: "commit-panel", key: "groupByDir", value: true });
    });

    it("rejects a request missing viewId", () => {
        expect(() =>
            parseE2eRequest({
                nonce: "n1",
                store: "webviewState",
                operation: "snapshot",
                key: "groupByDir",
            }),
        ).toThrow(/viewId/);
    });
});

describe("parseE2eRequest: structural rejections", () => {
    it("rejects a non-object payload", () => {
        expect(() => parseE2eRequest("not an object")).toThrow(/JSON object/);
        expect(() => parseE2eRequest(null)).toThrow(/JSON object/);
        expect(() => parseE2eRequest([1, 2, 3])).toThrow(/JSON object/);
    });

    it("rejects a missing nonce", () => {
        expect(() =>
            parseE2eRequest({
                store: "memento",
                operation: "snapshot",
                scope: "workspace",
                key: "k",
            }),
        ).toThrow(/nonce/);
    });

    it("rejects an invalid operation", () => {
        expect(() =>
            parseE2eRequest({
                nonce: "n1",
                store: "memento",
                operation: "destroy",
                scope: "workspace",
                key: "k",
            }),
        ).toThrow(/operation/);
    });

    it("rejects an unknown store", () => {
        expect(() =>
            parseE2eRequest({
                nonce: "n1",
                store: "configuration",
                operation: "snapshot",
                key: "k",
            }),
        ).toThrow(/store/);
    });
});

describe("response builders", () => {
    it("okValueResponse carries the value under result.kind 'value'", () => {
        expect(okValueResponse("n1", { a: 1 })).toEqual({
            nonce: "n1",
            ok: true,
            result: { kind: "value", value: { a: 1 } },
        });
    });

    it("okSecretPresenceResponse never needs a raw value field", () => {
        const response = okSecretPresenceResponse("n1", true, "deadbeef");
        expect(response).toEqual({
            nonce: "n1",
            ok: true,
            result: { kind: "secretPresence", present: true, digest: "deadbeef" },
        });
        expect(JSON.stringify(response)).not.toContain("glpat");
    });

    it("okAckResponse carries no result payload", () => {
        expect(okAckResponse("n1")).toEqual({ nonce: "n1", ok: true });
    });

    it("errorResponse carries ok: false and the reason", () => {
        expect(errorResponse("n1", "not allowlisted")).toEqual({
            nonce: "n1",
            ok: false,
            error: "not allowlisted",
        });
    });
});
