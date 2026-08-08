/**
 * Turns captured extension -> webview messages into deterministic, committable payloads (Phase 2b
 * deliverables 1 and 2). Two independent recordings of the same logical scenario carry different
 * absolute workspace roots, different UUID shelf/session ids, and different `Date.now()` values
 * (PLAN.md step 12); this module removes every one of those sources of nondeterminism so the
 * canonicalized result -- once run through `webviewFixtureFile.ts`'s serializer -- is byte-
 * identical across recordings, which is what makes a committed fixture reviewable as a real diff
 * instead of noise (step 13).
 *
 * Path substitution reuses `placeholderCanonicalization.ts`'s shared core -- the same
 * longest-needle-first, realpath-aware substitution Phase 1's `normalizeSnapshot` uses, so there is
 * exactly one implementation of "how a path becomes `<ROOT>`/`<ORIGIN>`/`<PROFILE>`" in this
 * repository. Volatile non-path values (timestamps, UUIDs) go through
 * `volatileFieldDeclarations.ts`'s explicit declared list instead, deliberately not through the
 * same path-substitution mechanism: a UUID or timestamp is not a filesystem path and has no
 * meaningful "root", so reusing path substitution for it would require inventing fake roots. Path
 * substitution runs first so a volatile field's placeholder can never itself be mistaken for
 * (and re-substituted by) a path needle.
 */

import type { CapturedWebviewMessage } from "../../../src/e2e/webviewCapture";
import {
    buildPlaceholderReplacements,
    normalizeUnknownDeep,
    type PlaceholderRoots,
} from "../../fixtures/repo/placeholderCanonicalization";
import {
    applyVolatileFieldDeclarations,
    type VolatileFieldDeclaration,
} from "./volatileFieldDeclarations";

/**
 * Canonicalizes one captured message's payload: deep path-placeholder substitution, then declared
 * volatile-field substitution. `contextId` passes through untouched -- it is a fixed identifier
 * from {@link WEBVIEW_CONTEXT_IDS}, never a path or a volatile value.
 */
function canonicalizeOne(
    captured: CapturedWebviewMessage,
    replacements: ReturnType<typeof buildPlaceholderReplacements>,
    volatileFields: readonly VolatileFieldDeclaration[],
): CapturedWebviewMessage {
    const pathNormalized = normalizeUnknownDeep(captured.message, replacements);
    const fullyNormalized = applyVolatileFieldDeclarations(pathNormalized, volatileFields);
    return { contextId: captured.contextId, message: fullyNormalized };
}

/**
 * Canonicalizes every captured message so two recordings of the same scenario, made at different
 * absolute paths and different wall-clock instants, produce deep-equal (and, once serialized,
 * byte-identical) results. Returns a new array; `messages` is never mutated.
 */
export function canonicalizeCapturedMessages(
    messages: readonly CapturedWebviewMessage[],
    roots: PlaceholderRoots,
    volatileFields: readonly VolatileFieldDeclaration[],
): readonly CapturedWebviewMessage[] {
    const replacements = buildPlaceholderReplacements(roots);
    return messages.map((captured) => canonicalizeOne(captured, replacements, volatileFields));
}
