/**
 * Atomic per-run fixture manifest (PLAN.md Phase 1 step 8, the manifest slice -- Codex R5 #6):
 * "The setup project publishes the template path through an atomic per-run manifest file at a
 * runner-known path (written to a temp name, then renamed), not through the environment... The
 * setup project runs in its own worker process, so mutating `process.env` there is invisible to
 * every other worker... Workers read the manifest; a missing or partial manifest is a hard
 * failure, never a silent rebuild."
 *
 * There are TWO distinct write paths, because "atomic" alone does not cover every hazard here.
 * `DEFAULT_MANIFEST_PATH` is a single FIXED path shared by every worker in a run (necessarily --
 * see that constant's own doc comment for why a per-run ID cannot be minted in the Playwright
 * config and published any other way), which means two runs on the same machine (a developer
 * running the suite twice, two CI jobs sharing a runner) resolve to the SAME path. `writeFixtureManifest`
 * writes a uniquely-named temp file in the SAME directory as the target (so the rename is
 * same-filesystem, which is what makes it atomic on every POSIX filesystem this suite runs on) and
 * renames it into place -- a reader can therefore only ever observe the manifest fully absent or
 * fully present, never partially written, which `tests/unit/fixtures/manifest.test.ts` proves by
 * racing a real writer against concurrent readers -- but it still unconditionally OVERWRITES
 * whatever was already at that path, which is correct only for an explicit, deliberate act (e.g.
 * clearing a manifest left behind by a crashed prior run), never for routine per-run publishing.
 * `claimFixtureManifest` is the setup project's routine publish path: it uses the same temp-file
 * technique but refuses -- throwing, naming the existing manifest's `templateRoot` -- when a live
 * manifest already occupies the target, so one run's setup can never silently clobber (or be
 * silently read out from under) another concurrent run. See each function's own doc comment for
 * why `claimFixtureManifest`'s refusal is race-free rather than merely check-then-write.
 *
 * `readFixtureManifest` is deliberately never a fallback: a missing file, an empty file, a file
 * that fails `JSON.parse`, and a file that parses but does not match {@link FixtureManifest}'s
 * shape are four DISTINCT hard failures, each with an error message that says which one occurred
 * -- there is no code path in this module that returns a default, a rebuild, or a partial value.
 * Schema validation is hand-written rather than through a library: `zod` is not a dependency of
 * this repository (`package.json` has no `zod` entry, confirmed by grep before writing this file),
 * and this package's own convention (`snapshotTypes.ts`'s `Section<T>`, `copyInodeGuard.ts`'s
 * `assertNoSharedInodes`) is small, explicit, hand-written validation with a single throw naming
 * every problem found, not a validation library dependency.
 */

import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/** Bumped only if this manifest's shape ever changes incompatibly; a manifest written by a stale
 * producer must fail schema validation loudly rather than be silently reinterpreted. */
export const MANIFEST_SCHEMA_VERSION = 1 as const;

/**
 * The atomic per-run manifest's full contents. Deliberately minimal: the one thing every worker
 * needs and cannot derive itself is WHERE the setup project built the template
 * (`seedFixtureTemplate`'s own `destination` argument -- the directory containing `workspace/` and
 * `origin.git/`, per `seed.ts`'s and `copyTemplate.ts`'s shared layout convention). Everything else
 * a worker needs (a fresh sanitized git env, fresh scratch directories) it builds for itself --
 * see `harness.ts`'s `createFixtureWorkspace`.
 */
export interface FixtureManifest {
    readonly schemaVersion: typeof MANIFEST_SCHEMA_VERSION;
    /** Absolute path to the directory `seedFixtureTemplate` built into: `<templateRoot>/workspace`
     * and `<templateRoot>/origin.git` both exist under it. */
    readonly templateRoot: string;
}

/**
 * The runner-known path every worker reads from when a caller does not supply its own -- a fixed,
 * process-independent location under the OS temp directory, so every worker process in the same
 * Playwright run agrees on it without needing an environment variable (PLAN.md step 8: "not
 * through the environment").
 */
export const DEFAULT_MANIFEST_PATH = path.join(tmpdir(), "intelligit-e2e-fixture-manifest.json");

/**
 * Writes `manifest` to `manifestPath` atomically -- but UNCONDITIONALLY: any manifest already at
 * `manifestPath` is silently replaced. This is the explicit-override path, not the routine publish
 * path -- use it only for a deliberate act such as clearing a manifest left behind by a crashed
 * prior run. For the setup project's routine per-run publish, use `claimFixtureManifest`, which
 * refuses instead of overwriting when a live manifest already exists.
 *
 * The write itself serializes, writes to a uniquely-named temp file in `manifestPath`'s own
 * directory, then renames it into place. A reader racing this call (see `readFixtureManifest`) can
 * therefore only ever observe the file fully absent or fully present.
 *
 * The temp file's name embeds both the PID and a random UUID so that two concurrent writers (there
 * should only ever be one setup project per run, but this function does not assume that) cannot
 * collide on the same temp path and clobber each other's in-flight write.
 */
export async function writeFixtureManifest(manifestPath: string, manifest: FixtureManifest): Promise<void> {
    const directory = path.dirname(manifestPath);
    await mkdir(directory, { recursive: true });

    const tempPath = path.join(directory, `.${path.basename(manifestPath)}.tmp-${process.pid}-${randomUUID()}`);
    const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
    await writeFile(tempPath, serialized, "utf8");
    // Same-directory rename: atomic on every POSIX filesystem this suite runs on. A cross-filesystem
    // rename is NOT atomic, which is exactly why the temp file above is created next to the target
    // rather than in, say, a shared OS temp root that might be a different filesystem/mount.
    await rename(tempPath, manifestPath);
}

/**
 * Publishes `manifest` to `manifestPath`, but ONLY if no live manifest already exists there --
 * this is the setup project's own publish path (PLAN.md step 8's "atomic per-run manifest"). The
 * manifest lives at one fixed, runner-known path (`DEFAULT_MANIFEST_PATH`) shared by every worker
 * in a run, because publishing a per-run ID through the environment does not work here: the setup
 * project runs in its own worker process, and Playwright's config module (where a random ID would
 * have to be minted) is re-evaluated separately in every worker process, so each worker would mint
 * its own ID and never agree on one. A fixed path is therefore correct -- but it means two runs on
 * the same machine (a developer running the suite twice, two CI jobs sharing a runner) both resolve
 * to the SAME path. Without a claim step, run B's setup silently overwrites run A's manifest while
 * run A's workers are still reading it: exactly the silent cross-run contamination this fixture
 * design exists to prevent. `writeFixtureManifest` cannot be reused for this call site because it
 * unconditionally overwrites; this function refuses instead, and only the explicit, documented call
 * to `writeFixtureManifest` (e.g. to deliberately clear a manifest left behind by a crashed prior
 * run) may still replace a live manifest.
 *
 * Race-free by construction, not check-then-write: the existence check and the publish happen as a
 * SINGLE filesystem syscall, `link(tempPath, manifestPath)`. POSIX `link(2)` atomically fails with
 * `EEXIST` if `newpath` already exists -- the kernel performs "does this name exist? if not, create
 * it pointing at this inode" as one indivisible operation, so there is no window between a check and
 * a write for a second claimant to land in. This is the reason `link` was chosen over
 * `existsSync` + `writeFile` (which has exactly that window: two callers can both observe "absent"
 * before either has written) and over `open(..., "wx")` (an equally race-free alternative writing
 * the file's bytes directly at the final name via the same atomic-create-if-absent kernel
 * guarantee -- `link` was picked instead because it reuses the existing temp-file-write pathway
 * `writeFixtureManifest` already established, so the bytes are fully written to a private path
 * before the atomic claim step even begins). Given N concurrent callers racing the same
 * `manifestPath`, exactly one `link` call can win; the kernel guarantees every other caller observes
 * `EEXIST`, never a torn or double-accepted state.
 */
export async function claimFixtureManifest(manifestPath: string, manifest: FixtureManifest): Promise<void> {
    const directory = path.dirname(manifestPath);
    await mkdir(directory, { recursive: true });

    const tempPath = path.join(directory, `.${path.basename(manifestPath)}.claim-${process.pid}-${randomUUID()}`);
    const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
    await writeFile(tempPath, serialized, "utf8");

    try {
        // The atomic claim: a single syscall that fails with EEXIST if manifestPath is already
        // taken. On success, manifestPath and tempPath are two hard links to the same inode; the
        // `finally` below drops the tempPath link, leaving manifestPath as the sole reference.
        await link(tempPath, manifestPath);
    } catch (error) {
        if (isExistsError(error)) {
            const existingTemplateRoot = await describeExistingManifestTemplateRoot(manifestPath);
            throw new Error(
                `claimFixtureManifest: refusing to publish -- a live manifest already exists at ` +
                    `"${manifestPath}" (existing templateRoot: ${existingTemplateRoot}). This claim never ` +
                    `overwrites: either a concurrent run genuinely owns this path right now (do not touch ` +
                    `it), or this is a leftover manifest from a crashed prior run, which requires a ` +
                    `deliberate act to clear -- remove it explicitly, or call writeFixtureManifest, which ` +
                    `overwrites unconditionally.`,
            );
        }
        throw error;
    } finally {
        // Unconditional cleanup: the temp file must not survive either the success path (where it
        // is now a redundant second link to manifestPath's inode) or the refusal path (where it was
        // never published at all).
        await rm(tempPath, { force: true });
    }
}

/** Best-effort description of the manifest already occupying `manifestPath`, for the claim-refusal
 * error message. Falls back to a description of the read/parse failure itself rather than
 * propagating it, so an unreadable or malformed pre-existing file never masks the claim refusal
 * that is the actual point of the error. */
async function describeExistingManifestTemplateRoot(manifestPath: string): Promise<string> {
    try {
        const existing = await readFixtureManifest(manifestPath);
        return existing.templateRoot;
    } catch (error) {
        return `<unreadable -- ${describeError(error)}>`;
    }
}

function isExistsError(error: unknown): boolean {
    return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

/**
 * Reads and validates the manifest at `manifestPath`, throwing a distinct, named hard failure for
 * each of: the file is missing, the file is empty, the file's content is not valid JSON
 * (truncated/malformed), or the parsed JSON does not match {@link FixtureManifest}'s shape. Never
 * falls back to a default and never triggers a rebuild -- a caller that wants "build if missing"
 * behavior must implement that explicitly on top of this function, not inside it.
 */
export async function readFixtureManifest(manifestPath: string): Promise<FixtureManifest> {
    const raw = await readManifestFile(manifestPath);

    if (raw.trim().length === 0) {
        throw new Error(
            `readFixtureManifest: manifest file at "${manifestPath}" is empty. This is a hard ` +
                `failure -- an empty manifest is never treated as "not built yet" and never triggers ` +
                `a silent rebuild.`,
        );
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (error) {
        throw new Error(
            `readFixtureManifest: manifest file at "${manifestPath}" is truncated or contains ` +
                `malformed JSON (${describeError(error)}). A correctly-written manifest is only ever ` +
                `observed fully absent or fully present (see writeFixtureManifest's atomic ` +
                `write-then-rename); a truncated file means something bypassed that contract. This is ` +
                `a hard failure, never a silent rebuild.`,
        );
    }

    return validateManifestShape(parsed, manifestPath);
}

/** Isolates the one call in this module allowed to see `ENOENT`, so the missing-file message stays
 * distinct from every other read failure (permission errors, I/O errors, ...). */
async function readManifestFile(manifestPath: string): Promise<string> {
    try {
        return await readFile(manifestPath, "utf8");
    } catch (error) {
        if (isNotFoundError(error)) {
            throw new Error(
                `readFixtureManifest: no manifest file at "${manifestPath}". The setup project must ` +
                    `run and publish the manifest (writeFixtureManifest) before any worker reads it. ` +
                    `This is a hard failure: a missing manifest never triggers a silent per-worker ` +
                    `template rebuild.`,
            );
        }
        throw new Error(`readFixtureManifest: failed to read manifest file at "${manifestPath}": ${describeError(error)}`);
    }
}

/** Validates the parsed JSON against {@link FixtureManifest}'s shape at the trust boundary --
 * `JSON.parse`'s return type is `unknown` in spirit even though TypeScript widens it to `any`, so
 * nothing downstream may treat `parsed` as a `FixtureManifest` until every field is checked here.
 * Collects every problem before throwing, mirroring this package's `assertNoSharedInodes` /
 * `assertAlternatesContained` / `assertWorkspaceEquivalentToTemplate` convention of one throw
 * naming every offender rather than failing on the first. */
function validateManifestShape(parsed: unknown, manifestPath: string): FixtureManifest {
    const problems: string[] = [];
    const record = asRecord(parsed);

    if (record === null) {
        problems.push(`expected the manifest's top level to be a JSON object, got ${describeType(parsed)}`);
    } else {
        if (record.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
            problems.push(
                `"schemaVersion" must be exactly ${MANIFEST_SCHEMA_VERSION}, got ${JSON.stringify(record.schemaVersion)}`,
            );
        }
        if (!isNonEmptyAbsolutePathString(record.templateRoot)) {
            problems.push(`"templateRoot" must be a non-empty absolute path string, got ${JSON.stringify(record.templateRoot)}`);
        }
    }

    if (problems.length > 0) {
        throw new Error(
            `readFixtureManifest: manifest file at "${manifestPath}" fails schema validation -- ` +
                `${problems.length} problem(s): ${problems.join("; ")}. This is a hard failure, never a ` +
                `default or a partial fallback.`,
        );
    }

    // Safe: every field the interface declares was just checked above.
    return record as unknown as FixtureManifest;
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function isNonEmptyAbsolutePathString(value: unknown): value is string {
    return typeof value === "string" && value.length > 0 && path.isAbsolute(value);
}

function describeType(value: unknown): string {
    if (value === null) return "null";
    if (Array.isArray(value)) return "array";
    return typeof value;
}

function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function isNotFoundError(error: unknown): boolean {
    return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
