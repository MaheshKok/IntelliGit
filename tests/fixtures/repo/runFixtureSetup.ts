/**
 * The setup project's own logic (PLAN.md Phase 1 step 8: "The setup project runs exactly once
 * regardless of worker count," publishing the template through `manifest.ts`'s atomic per-run
 * manifest) plus PLAN.md line 71's `fsck` gate: "`fsck` runs on the template once per suite ... not
 * on every per-test copy." The order below is load-bearing and intentionally cannot be
 * reshuffled by a caller: seed, THEN `fsck`, THEN publish. A template that fails `fsck` must never
 * be reachable through the manifest -- a worker reading a published manifest is trusting that the
 * template behind it is not corrupt, and that trust only holds if publication is gated on the check
 * rather than raced against it or done first for convenience.
 *
 * This module is deliberately plain, Playwright-free TypeScript, exactly like `harness.ts` and
 * `manifest.ts` -- fully exercisable from vitest without Playwright running at all. A later slice
 * wires it into an actual Playwright setup project; that wiring is out of scope here.
 *
 * **What "non-clean" means (empirically determined against a real seeded template, git 2.50.1).**
 * Plain `git fsck` (no extra flags) was run against a freshly `seedFixtureTemplate`'d workspace and
 * bare origin, both of which carry pre-seeded stash entries (PLAN.md step 7's "dirty layer"). The
 * result was exit code 0 with COMPLETELY EMPTY stdout and stderr -- no "dangling"/"notice:" noise
 * at all, because default `git fsck` treats every ref's reflog as a reachability root, and the
 * older stash entry stays reachable through `refs/stash`'s own reflog. (Passing `--no-reflog`
 * makes that same, non-corrupt template report `dangling commit ...` -- proving the advisory noise
 * a naive implementation might need to filter is a `--no-reflog`-only artifact, not something plain
 * `git fsck` ever produces here.) Separately, truncating one real loose object in place (the
 * mechanism `tests/unit/fixtures/runFixtureSetup.test.ts`'s `corruptOneLooseObject` helper uses)
 * made `git fsck` exit 3 with `error: corrupt loose object ...` / `missing blob ...` on stderr.
 *
 * The dividing line is therefore simply **the process exit code**: `runGit` (this package's shared
 * git-subprocess seam, `gitRun.ts`) already rejects whenever `git` exits non-zero, and resolves
 * whenever it exits 0 -- regardless of any advisory text on stdout. Checking only the exit code,
 * rather than pattern-matching stdout/stderr text, is deliberately the more robust design: it can
 * never be too strict (an exit-0 run is never failed no matter what advisory line git chooses to
 * print, on this or a future git version) and never too loose (git's own exit code is what actually
 * distinguishes "problems found" from "clean" for `fsck`).
 */

import { runGit } from "./gitRun";
import { claimFixtureManifest, DEFAULT_MANIFEST_PATH, MANIFEST_SCHEMA_VERSION } from "./manifest";
import { seedFixtureTemplate, type FixtureTemplate } from "./seed";
import { tmpdir } from "node:os";
import path from "node:path";

/** The runner-known default template destination, mirroring `manifest.ts`'s `DEFAULT_MANIFEST_PATH`
 * and `harness.ts`'s `DEFAULT_WORKSPACES_ROOT`: one fixed location under the OS temp directory so a
 * developer or CI job running the setup project twice collides predictably (and must explicitly
 * `runFixtureTeardown` first) rather than two runs silently building two different templates. */
export const DEFAULT_TEMPLATE_ROOT = path.join(tmpdir(), "intelligit-e2e-fixture-template");

export interface RunFixtureSetupOptions {
    /** Where to build the template. Defaults to {@link DEFAULT_TEMPLATE_ROOT}. Must be empty or
     * not-yet-exist -- the same contract `seedFixtureTemplate` itself enforces. */
    readonly templateRoot?: string;
    /** Where to publish the manifest. Defaults to {@link DEFAULT_MANIFEST_PATH}. */
    readonly manifestPath?: string;
}

export interface FixtureSetupResult {
    /** Everything `seedFixtureTemplate` built -- the caller's own responsibility to dispose of
     * `template.home`, exactly like every other direct `seedFixtureTemplate` caller in this
     * package (see `seed.ts`'s own doc comment, and `tests/unit/fixtures/seed.test.ts`'s
     * `afterAll`). */
    readonly template: FixtureTemplate;
    readonly manifestPath: string;
}

/**
 * The `fsck` gate, split out as its own exported function rather than inlined into
 * {@link runFixtureSetup}: it is independently useful (PLAN.md line 71 also requires `fsck` to run
 * "inside the Phase 6 harness tests", which is this exact same check reused verbatim, not a
 * reimplementation of it) and independently testable, which is what lets
 * `tests/unit/fixtures/runFixtureSetup.test.ts` prove this specific function rejects a real
 * corrupted template without needing to drive the whole setup pipeline to do it.
 *
 * Checks BOTH the working-tree repository and the bare origin -- PLAN.md step 9 treats both as
 * part of "the template"'s restorable domain, and each has its own independent object store that
 * `fsck` can only verify by being pointed at it directly. Runs both checks even if the first
 * fails, and throws once naming every offending location together, mirroring this package's
 * existing convention (`manifest.ts`'s `validateManifestShape`, `snapshotObjectStore.ts`'s
 * `assertAlternatesContained`) of one throw listing every problem rather than stopping at the
 * first.
 */
export async function assertTemplateFsckClean(template: FixtureTemplate): Promise<void> {
    const checks: ReadonlyArray<readonly [label: string, root: string]> = [
        [`workspace (${template.root})`, template.root],
        [`origin (${template.originRoot})`, template.originRoot],
    ];

    const results = await Promise.all(
        checks.map(async ([label, root]) => {
            try {
                await runGit(root, ["fsck"], template.env);
                return { label, ok: true as const };
            } catch (error) {
                return { label, ok: false as const, message: describeError(error) };
            }
        }),
    );

    const failures = results.filter((result): result is { label: string; ok: false; message: string } => !result.ok);
    if (failures.length > 0) {
        throw new Error(
            `assertTemplateFsckClean: git fsck reported problems in ${failures.length} location(s) -- ` +
                `refusing to treat this template as clean: ` +
                failures.map((failure) => `${failure.label}: ${failure.message}`).join(" | "),
        );
    }
}

/** Publishes `templateRoot` for an already-built template via `claimFixtureManifest` -- the
 * routine, race-free, refuse-rather-than-clobber publish path (see `manifest.ts`'s own doc
 * comment). Split out from {@link runFixtureSetup} for the same reason as
 * {@link assertTemplateFsckClean}: an independently testable, independently reusable step. */
export async function publishTemplate(templateRoot: string, manifestPath: string): Promise<void> {
    await claimFixtureManifest(manifestPath, {
        schemaVersion: MANIFEST_SCHEMA_VERSION,
        templateRoot,
    });
}

/**
 * Builds the template exactly once, verifies it, and publishes it -- in that exact order. A
 * template that fails {@link assertTemplateFsckClean} is left on disk (not auto-deleted) but its
 * manifest is never written: the corruption is the actual thing under test here, and destroying the
 * evidence the moment it is found would defeat the point of running `fsck` at all. Cleanup of a
 * failed (or successful, once a worker no longer needs it) template is `runFixtureTeardown`'s job,
 * run explicitly -- never implicit rollback inside this function.
 */
export async function runFixtureSetup(options?: RunFixtureSetupOptions): Promise<FixtureSetupResult> {
    const templateRoot = options?.templateRoot ?? DEFAULT_TEMPLATE_ROOT;
    const manifestPath = options?.manifestPath ?? DEFAULT_MANIFEST_PATH;

    const template = await seedFixtureTemplate(templateRoot);
    await assertTemplateFsckClean(template);
    await publishTemplate(templateRoot, manifestPath);

    return { template, manifestPath };
}

function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
