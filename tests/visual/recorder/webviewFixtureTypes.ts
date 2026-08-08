/**
 * The on-disk shape of one committed webview payload fixture (PLAN.md step 11:
 * `tests/visual/fixtures/<webview>/<scenario>.json`). One fixture holds every canonicalized
 * message a single resolved host context ({@link WebviewContextId}) posted during one recorded
 * scenario -- `messages` is not the full multi-context capture; the recorder filters to one
 * context id before a fixture is built, and {@link parseWebviewFixture} (`validateWebviewFixture.ts`)
 * enforces that every message it contains actually belongs to that context.
 */

import type { CapturedWebviewMessage, WebviewContextId } from "../../../src/e2e/webviewCapture";

/** Bumped whenever the fixture shape changes, so a stale committed fixture fails loudly instead of comparing against an incompatible shape. */
export const WEBVIEW_FIXTURE_SCHEMA_VERSION = 1;

/** One fully canonicalized, versioned webview payload fixture -- the on-disk artifact. */
export interface WebviewFixture {
    readonly schemaVersion: number;
    readonly contextId: WebviewContextId;
    readonly scenario: string;
    readonly messages: readonly CapturedWebviewMessage[];
}
