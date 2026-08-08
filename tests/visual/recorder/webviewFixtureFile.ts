/**
 * Path and serialization conventions for committed webview payload fixtures (Phase 2b deliverable
 * 3). Mirrors `tests/e2e/hostFixtures/hostFixtureFile.ts`'s already-established convention byte
 * for byte -- 4-space indent (matching this repo's Prettier `tabWidth`), one trailing newline, and
 * key order following the {@link WebviewFixture} type declaration rather than sorted -- because
 * nothing enforces that convention (prettier's globs do not reach `tests/**` or `.json`); this
 * function is the only source of truth for it, exactly as `serializeHostFixture` is for host
 * fixtures.
 */

import path from "node:path";

import type { CapturedWebviewMessage, WebviewContextId } from "../../../src/e2e/webviewCapture";
import { WEBVIEW_FIXTURE_SCHEMA_VERSION, type WebviewFixture } from "./webviewFixtureTypes";

/**
 * Where one context id's committed fixtures live, relative to the repo root -- the `<webview>`
 * directory in PLAN.md step 11's `tests/visual/fixtures/<webview>/<scenario>.json` convention.
 */
export function webviewFixtureOutputDir(repoRoot: string, contextId: WebviewContextId): string {
    return path.join(repoRoot, "tests", "visual", "fixtures", contextId);
}

/** Absolute path for one context id's one scenario fixture. */
export function webviewFixtureFilePath(
    repoRoot: string,
    contextId: WebviewContextId,
    scenario: string,
): string {
    return path.join(webviewFixtureOutputDir(repoRoot, contextId), `${scenario}.json`);
}

/**
 * Assembles a {@link WebviewFixture} from already-canonicalized messages (see
 * `canonicalizeCapturedMessages.ts`). Field order here fixes the JSON key order
 * {@link serializeWebviewFixture} emits, so it is deliberately not alphabetical.
 */
export function buildWebviewFixture(
    contextId: WebviewContextId,
    scenario: string,
    messages: readonly CapturedWebviewMessage[],
): WebviewFixture {
    return { schemaVersion: WEBVIEW_FIXTURE_SCHEMA_VERSION, contextId, scenario, messages };
}

/**
 * Serializes a webview fixture to the exact bytes this recorder writes to disk: 4-space indented
 * JSON, keys in the {@link WebviewFixture} declaration's fixed order, one trailing newline.
 */
export function serializeWebviewFixture(fixture: WebviewFixture): string {
    return `${JSON.stringify(fixture, null, 4)}\n`;
}
