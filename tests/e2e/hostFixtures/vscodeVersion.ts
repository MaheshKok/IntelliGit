/**
 * VS Code build the Phase 0 host-fixture capture launches.
 *
 * Deliberately pinned, not `stable` -- an overnight VS Code release must not
 * be able to change what this capture records (PLAN.md step 26 states the
 * same rule for Layer 2 generally).
 *
 * Kept in sync **by hand** with `VSCODE_VERSION` in
 * `tests/e2e/spike/launch.spec.ts`. Not imported from there: that file is
 * frozen, already-passed spike output, and this module intentionally leaves
 * it untouched rather than refactoring it into a shared constant. A future
 * phase (PLAN.md step 26 names the intent) is expected to consolidate every
 * VS-Code-version constant in the suite into one shared source; until then, a
 * version bump here must be mirrored there, and vice versa.
 */
export const VSCODE_VERSION = "1.132.0";
