/**
 * The matching teardown for `runFixtureSetup.ts` (PLAN.md Phase 1 step 8: "a matching teardown
 * project"). Removes exactly the two things a run's setup can leave behind -- the template
 * directory and the manifest file -- and nothing else: it does not know about, and does not touch,
 * per-worker `createFixtureWorkspace()` output (that is each workspace's own `dispose()`), nor the
 * scratch `HOME` `seedFixtureTemplate` allocates for the template itself (`FixtureTemplate.home`
 * lives outside `templateRoot`, under the OS temp root, and -- exactly like every other direct
 * `seedFixtureTemplate` caller in this package, see `seed.ts`'s own doc comment and
 * `tests/unit/fixtures/seed.test.ts`'s `afterAll` -- disposing of it is the caller's own
 * responsibility, not something bound into this teardown's lifecycle).
 *
 * Safe to call when setup never ran, ran partway (template built but manifest never published, or
 * vice versa), or already ran once before: `rm(..., { force: true })` only ignores ENOENT ("this
 * path does not exist") -- confirmed empirically before writing this module -- so a genuine failure
 * (permission denied, a read-only mount, ...) still propagates rather than being swallowed.
 */

import { rm } from "node:fs/promises";

import { DEFAULT_MANIFEST_PATH } from "./manifest";
import { DEFAULT_TEMPLATE_ROOT } from "./runFixtureSetup";
import { removeScratchDirectories } from "../../helpers/scratchDirectories";

export interface RunFixtureTeardownOptions {
    /** The template directory to remove. Defaults to {@link DEFAULT_TEMPLATE_ROOT}. */
    readonly templateRoot?: string;
    /** The manifest file to remove. Defaults to {@link DEFAULT_MANIFEST_PATH}. */
    readonly manifestPath?: string;
}

/**
 * Removes `templateRoot` (recursively) and `manifestPath`, in parallel: the two removals are
 * independent of each other, and running them concurrently rather than sequentially does not change
 * this function's safety or idempotency properties. Idempotent -- a second call after the first
 * succeeded observes both paths already absent and resolves without throwing, the same as if
 * neither had ever existed.
 */
export async function runFixtureTeardown(options?: RunFixtureTeardownOptions): Promise<void> {
    const templateRoot = options?.templateRoot ?? DEFAULT_TEMPLATE_ROOT;
    const manifestPath = options?.manifestPath ?? DEFAULT_MANIFEST_PATH;

    await Promise.all([
        removeScratchDirectories(templateRoot),
        removeScratchDirectories(manifestPath),
    ]);
}
