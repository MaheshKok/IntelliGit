/**
 * Spec-derived tests for `tests/visual/recorder/validateWebviewFixture.ts` -- the runtime half of
 * PLAN.md Phase 6 step 36's protocol conformance requirement. `tsconfig.json` excludes `tests/`
 * and vitest transpiles without type-checking, so a fixture loaded with `JSON.parse` and cast with
 * `as WebviewFixture` can NEVER go red in CI no matter how malformed the file on disk is -- the
 * cast is compile-time-only and vitest never runs the compiler. `parseWebviewFixture` is the
 * runtime check that actually inspects the parsed value's shape at test time, so a structurally
 * malformed committed fixture fails the test that loads it instead of silently flowing through as
 * `unknown`-typed garbage wearing a `WebviewFixture` label.
 *
 * Every case here asserts BOTH directions per the task brief: rejection is proven for each
 * malformed shape, AND a valid fixture is proven to survive validation -- a validator that
 * rejects unconditionally would pass a rejection-only suite while catching nothing real.
 */

import { describe, expect, it } from "vitest";

import { parseWebviewFixture } from "../../../visual/recorder/validateWebviewFixture";
import { WEBVIEW_FIXTURE_SCHEMA_VERSION } from "../../../visual/recorder/webviewFixtureTypes";

const VALID_RAW = {
    schemaVersion: WEBVIEW_FIXTURE_SCHEMA_VERSION,
    contextId: "commit-panel",
    scenario: "clean",
    messages: [{ contextId: "commit-panel", message: { type: "state" } }],
};

describe("parseWebviewFixture -- accepts a structurally valid fixture", () => {
    it("returns the parsed fixture unchanged when every field is well-formed", () => {
        const parsed = parseWebviewFixture(VALID_RAW);
        expect(parsed).toEqual(VALID_RAW);
    });

    it("accepts an empty messages array", () => {
        const raw = { ...VALID_RAW, messages: [] };
        expect(parseWebviewFixture(raw)).toEqual(raw);
    });
});

describe("parseWebviewFixture -- rejects structurally malformed fixtures", () => {
    it("rejects a non-object top level", () => {
        expect(() => parseWebviewFixture("not an object")).toThrow();
        expect(() => parseWebviewFixture(null)).toThrow();
        expect(() => parseWebviewFixture([1, 2, 3])).toThrow();
    });

    it("rejects a missing required field (scenario)", () => {
        const { scenario: _scenario, ...withoutScenario } = VALID_RAW;
        expect(() => parseWebviewFixture(withoutScenario)).toThrow();
    });

    it("rejects a missing required field (messages)", () => {
        const { messages: _messages, ...withoutMessages } = VALID_RAW;
        expect(() => parseWebviewFixture(withoutMessages)).toThrow();
    });

    it("rejects an unknown context id at the fixture level", () => {
        const raw = { ...VALID_RAW, contextId: "not-a-real-context" };
        expect(() => parseWebviewFixture(raw)).toThrow(/context/i);
    });

    it("rejects an unknown context id on an individual message", () => {
        const raw = {
            ...VALID_RAW,
            messages: [{ contextId: "not-a-real-context", message: {} }],
        };
        expect(() => parseWebviewFixture(raw)).toThrow(/context/i);
    });

    it("rejects a message whose contextId disagrees with the fixture's own contextId", () => {
        const raw = {
            ...VALID_RAW,
            contextId: "commit-panel",
            messages: [{ contextId: "commit-info", message: {} }],
        };
        expect(() => parseWebviewFixture(raw)).toThrow();
    });

    it("rejects a message missing its required 'message' field", () => {
        const raw = { ...VALID_RAW, messages: [{ contextId: "commit-panel" }] };
        expect(() => parseWebviewFixture(raw)).toThrow();
    });

    it("rejects messages that is not an array", () => {
        const raw = { ...VALID_RAW, messages: "not-an-array" };
        expect(() => parseWebviewFixture(raw)).toThrow();
    });

    it("rejects a non-numeric schemaVersion", () => {
        const raw = { ...VALID_RAW, schemaVersion: "1" };
        expect(() => parseWebviewFixture(raw)).toThrow();
    });

    /**
     * `WEBVIEW_FIXTURE_SCHEMA_VERSION` exists so a stale fixture "fails loudly instead of comparing
     * against an incompatible shape". Type-checking the field as a number and then accepting ANY
     * number made the constant decorative: a fixture written under one schema and read under the
     * next passed validation and failed later as a confusing field-level mismatch, or not at all.
     *
     * Both neighbours are asserted, not just the older one. A validator written as
     * `schemaVersion < CURRENT` would pass an older-only test while silently accepting a fixture
     * from a NEWER writer -- the case where the reader is the stale side.
     */
    it.each([
        ["an older", WEBVIEW_FIXTURE_SCHEMA_VERSION - 1],
        ["a newer", WEBVIEW_FIXTURE_SCHEMA_VERSION + 1],
    ])("rejects %s schemaVersion, naming both the found and expected version", (_label, version) => {
        const raw = { ...VALID_RAW, schemaVersion: version };
        expect(() => parseWebviewFixture(raw)).toThrow(
            new RegExp(`is ${version}.*schema version ${WEBVIEW_FIXTURE_SCHEMA_VERSION}`),
        );
    });

    it("accepts exactly the current schemaVersion", () => {
        const raw = { ...VALID_RAW, schemaVersion: WEBVIEW_FIXTURE_SCHEMA_VERSION };
        expect(parseWebviewFixture(raw)).toEqual(raw);
    });
});
