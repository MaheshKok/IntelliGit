/**
 * Runtime validator for a committed webview payload fixture -- the runtime half of PLAN.md Phase 6
 * step 36's protocol conformance requirement. `tsconfig.json` excludes `tests/` and vitest
 * transpiles without type-checking, so a test that does `JSON.parse(raw) as WebviewFixture` can
 * NEVER go red for a malformed fixture: the cast is compile-time-only and the compiler never runs
 * over this file's callers. `parseWebviewFixture` instead inspects the parsed value's actual shape
 * at test time and throws on any mismatch, exactly the manual-validation style this repository
 * already uses at its other untrusted-payload boundaries (`src/views/messageValidation.ts`,
 * `src/e2e/protocol.ts`) -- a fixture read from disk is exactly that kind of boundary: untrusted
 * bytes that happen to usually be well-formed, until a hand-edit or a stale regeneration makes them
 * not.
 */

import {
    WEBVIEW_CONTEXT_IDS,
    type CapturedWebviewMessage,
    type WebviewContextId,
} from "../../../src/e2e/webviewCapture";
import { WEBVIEW_FIXTURE_SCHEMA_VERSION, type WebviewFixture } from "./webviewFixtureTypes";

function assertRecord(value: unknown, context: string): Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error(`${context} must be a JSON object, got ${JSON.stringify(value)}`);
    }
    return value as Record<string, unknown>;
}

function assertString(value: unknown, field: string): string {
    if (typeof value !== "string") {
        throw new Error(`${field} must be a string, got ${typeof value}`);
    }
    return value;
}

function assertNumber(value: unknown, field: string): number {
    if (typeof value !== "number") {
        throw new Error(`${field} must be a number, got ${typeof value}`);
    }
    return value;
}

function assertContextId(value: unknown, field: string): WebviewContextId {
    if (typeof value !== "string" || !(WEBVIEW_CONTEXT_IDS as readonly string[]).includes(value)) {
        throw new Error(
            `${field} must be one of the resolved host context ids (${WEBVIEW_CONTEXT_IDS.join(", ")}), got ${JSON.stringify(value)}`,
        );
    }
    return value as WebviewContextId;
}

/** Validates one entry of `messages`, and that it belongs to the fixture's own context id. */
function assertCapturedMessage(
    value: unknown,
    index: number,
    fixtureContextId: WebviewContextId,
): CapturedWebviewMessage {
    const record = assertRecord(value, `messages[${index}]`);
    const contextId = assertContextId(record.contextId, `messages[${index}].contextId`);
    if (contextId !== fixtureContextId) {
        throw new Error(
            `messages[${index}].contextId is "${contextId}" but the fixture's own contextId is "${fixtureContextId}"`,
        );
    }
    if (!("message" in record)) {
        throw new Error(`messages[${index}] is missing required field "message"`);
    }
    return { contextId, message: record.message };
}

/**
 * Parses and validates an untrusted `WebviewFixture` payload read from disk. Throws on any
 * structural mismatch -- wrong top-level shape, an unknown context id (at the fixture level or on
 * an individual message), a message whose context id disagrees with the fixture's own, or a
 * missing required field -- rather than letting a malformed file flow through as `unknown`-typed
 * data wearing a `WebviewFixture` label.
 */
export function parseWebviewFixture(raw: unknown): WebviewFixture {
    const record = assertRecord(raw, "Webview fixture");
    const schemaVersion = assertNumber(
        record.schemaVersion,
        'Webview fixture field "schemaVersion"',
    );
    // `WEBVIEW_FIXTURE_SCHEMA_VERSION` exists to make a stale fixture "fail loudly instead of
    // comparing against an incompatible shape" (its own doc comment), which only happens if
    // something compares. Type-checking the field as a number and then accepting any value made the
    // constant decorative: a fixture written under schema 1 and read after a schema 2 rename would
    // pass every check here and fail later as a confusing field-level mismatch, or not at all.
    if (schemaVersion !== WEBVIEW_FIXTURE_SCHEMA_VERSION) {
        throw new Error(
            `Webview fixture field "schemaVersion" is ${schemaVersion}, but this recorder reads ` +
                `schema version ${WEBVIEW_FIXTURE_SCHEMA_VERSION}. Regenerate the committed ` +
                "fixtures with UPDATE_WEBVIEW_FIXTURES=1 rather than reading them under a schema " +
                "they were not written for.",
        );
    }
    const contextId = assertContextId(record.contextId, 'Webview fixture field "contextId"');
    const scenario = assertString(record.scenario, 'Webview fixture field "scenario"');

    if (!Array.isArray(record.messages)) {
        throw new Error(
            `Webview fixture field "messages" must be an array, got ${typeof record.messages}`,
        );
    }
    const messages = record.messages.map((entry, index) =>
        assertCapturedMessage(entry, index, contextId),
    );

    return { schemaVersion, contextId, scenario, messages };
}
