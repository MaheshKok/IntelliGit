import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
    RebaseManifestAmbiguousReason,
    RebaseManifestReadResult,
    RebasePushTarget,
    RebaseReservation,
    RebaseReservationAcquireResult,
    RebaseReservationSweepResult,
    RebaseSessionLifecycle,
    RebaseSessionManifest,
    RebaseSessionPaths,
    RebaseStoragePaths,
} from "./types";

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
// Lowercase-only: Git emits lowercase object IDs and submission validation normalizes to
// lowercase, so an uppercase ID in a manifest can never equal a later `git rev-parse` result.
const FULL_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const LIFECYCLES = new Set<RebaseSessionLifecycle>([
    "starting",
    "running",
    "paused",
    "completed-pending-push",
    "done",
]);
const LIVE_LIFECYCLES = new Set<RebaseSessionLifecycle>(["starting", "running", "paused"]);

/** A manifest whose lifecycle still controls a live rebase, as `readLiveRebaseManifest` returns. */
export type LiveRebaseSessionManifest = RebaseSessionManifest & {
    lifecycle: "starting" | "running" | "paused";
};

/** One manifest file retained for a repository, including fail-closed read results. */
export interface RebaseManifestListEntry {
    /** Session identifier derived from the manifest filename. */
    sessionId: string;
    /** Parsed state, or the reason it cannot safely drive recovery. */
    result: RebaseManifestReadResult;
}

/** Returns the isolated storage namespace for a caller-supplied repository root. */
export function getRebaseStoragePaths(storageRoot: string, repoRoot: string): RebaseStoragePaths {
    const repositoryKey = createHash("sha256").update(path.resolve(repoRoot)).digest("hex");
    const repositoryDirectory = path.join(storageRoot, "interactive-rebase", repositoryKey);
    const sessionsDirectory = path.join(repositoryDirectory, "sessions");
    const manifestDirectory = path.join(repositoryDirectory, "manifests");
    return {
        repositoryDirectory,
        sessionsDirectory,
        manifestDirectory,
        reservationPath: path.join(repositoryDirectory, "reservation.json"),
        sessionDirectory: (sessionId) => path.join(sessionsDirectory, validateSessionId(sessionId)),
        manifestPath: (sessionId) =>
            path.join(manifestDirectory, `${validateSessionId(sessionId)}.json`),
    };
}

/**
 * Atomically creates the repository reservation pointer after checking Git's rebase directories.
 *
 * The caller must release only the returned reservation handle after every non-paused exit path.
 * The caller must also persist a `starting` manifest before yielding control: the orphan sweep
 * treats a pointer with no manifest as reclaimable, so a window that activates inside that gap
 * would delete a live session's pointer and break mutual exclusion.
 */
export async function tryAcquireRebaseReservation({
    storageRoot,
    repoRoot,
    gitDir,
    sessionId,
}: {
    /** Extension-managed storage directory supplied by the caller. */
    storageRoot: string;
    /** Active worktree root used to derive the repository storage namespace. */
    repoRoot: string;
    /** Git directory checked for an already-running rebase. */
    gitDir: string;
    /** Session ID to store in the exclusive reservation pointer. */
    sessionId: string;
}): Promise<RebaseReservationAcquireResult> {
    const paths = getRebaseStoragePaths(storageRoot, repoRoot);
    const validSessionId = validateSessionId(sessionId);
    if (await hasGitRebaseDirectory(gitDir)) {
        return { status: "rejected", reason: "rebase-in-progress" };
    }
    await ensureDirectory(paths.repositoryDirectory);
    try {
        await writeFile(paths.reservationPath, JSON.stringify({ sessionId: validSessionId }), {
            encoding: "utf8",
            flag: "wx",
            mode: 0o600,
        });
    } catch (error) {
        if (isFileExists(error)) return { status: "rejected", reason: "reservation-exists" };
        throw error;
    }
    return {
        status: "acquired",
        reservation: { sessionId: validSessionId, pointerPath: paths.reservationPath },
    };
}

/** Removes a reservation pointer only when it still belongs to the returned reservation handle. */
export async function releaseRebaseReservation(reservation: RebaseReservation): Promise<void> {
    const stored = await readReservation(reservation.pointerPath);
    if (stored.status === "valid" && stored.sessionId !== reservation.sessionId) return;
    await rm(reservation.pointerPath, { force: true });
}

/**
 * Reclaims an activation-time orphan pointer that has neither Git rebase state nor a live manifest.
 *
 * Any malformed pointer or ambiguous manifest is retained so recovery never treats uncertain state as safe.
 */
export async function sweepOrphanedRebaseReservation({
    storageRoot,
    repoRoot,
    gitDir,
}: {
    /** Extension-managed storage directory supplied by the caller. */
    storageRoot: string;
    /** Active worktree root used to derive the repository storage namespace. */
    repoRoot: string;
    /** Git directory checked for an already-running rebase. */
    gitDir: string;
}): Promise<RebaseReservationSweepResult> {
    const paths = getRebaseStoragePaths(storageRoot, repoRoot);
    const reservation = await readReservation(paths.reservationPath);
    if (reservation.status === "missing") return { status: "none" };
    if (reservation.status === "ambiguous")
        return { status: "retained", reason: "ambiguous-state" };
    if (await hasGitRebaseDirectory(gitDir)) {
        return { status: "retained", reason: "rebase-in-progress" };
    }
    const manifest = await readRebaseManifest(storageRoot, repoRoot, reservation.sessionId);
    if (manifest.status === "ambiguous") return { status: "retained", reason: "ambiguous-state" };
    if (manifest.status === "valid" && LIVE_LIFECYCLES.has(manifest.manifest.lifecycle)) {
        return { status: "retained", reason: "live-manifest" };
    }
    await rm(paths.reservationPath, { force: true });
    return { status: "reclaimed" };
}

/** Creates a unique per-submission directory for sequence-editor helper artifacts only. */
export async function createRebaseSessionDirectory(
    storageRoot: string,
    repoRoot: string,
    sessionId: string,
): Promise<RebaseSessionPaths> {
    const paths = getRebaseStoragePaths(storageRoot, repoRoot);
    const directory = paths.sessionDirectory(sessionId);
    await ensureDirectory(paths.sessionsDirectory);
    await ensureNewDirectory(directory);
    const consumptionDirectory = path.join(directory, "consumed");
    await ensureNewDirectory(consumptionDirectory);
    return {
        directory,
        todoPath: path.join(directory, "todo"),
        messageMapPath: path.join(directory, "messages.json"),
        consumptionDirectory,
    };
}

/** Deletes a session's helper-artifact directory without touching its durable manifest. */
export async function deleteRebaseSessionDirectory(
    storageRoot: string,
    repoRoot: string,
    sessionId: string,
): Promise<void> {
    const paths = getRebaseStoragePaths(storageRoot, repoRoot);
    await rm(paths.sessionDirectory(sessionId), { force: true, recursive: true });
}

/** Validates and atomically replaces one durable session manifest outside the helper-artifact directory. */
export async function writeRebaseManifest(
    storageRoot: string,
    manifest: RebaseSessionManifest,
): Promise<void> {
    const validationError = validateManifest(manifest);
    if (validationError) throw manifestWriteError(validationError);
    const paths = getRebaseStoragePaths(storageRoot, manifest.repoRoot);
    const target = paths.manifestPath(manifest.sessionId);
    await ensureDirectory(paths.manifestDirectory);
    await writeManifestAtomically(target, manifest);
}

/** Reads one manifest, fail-closing malformed, truncated, and unsupported state as ambiguous. */
export async function readRebaseManifest(
    storageRoot: string,
    repoRoot: string,
    sessionId: string,
): Promise<RebaseManifestReadResult> {
    if (!isSafeSessionId(sessionId)) return { status: "ambiguous", reason: "invalid-schema" };
    const paths = getRebaseStoragePaths(storageRoot, repoRoot);
    let contents: string;
    try {
        contents = await readFile(paths.manifestPath(sessionId), "utf8");
    } catch (error) {
        if (isFileMissing(error)) return { status: "missing" };
        return { status: "ambiguous", reason: "unreadable" };
    }
    const parsed = parseManifest(contents);
    if ("reason" in parsed) return { status: "ambiguous", reason: parsed.reason };
    if (parsed.manifest.sessionId !== sessionId) {
        return { status: "ambiguous", reason: "invalid-schema" };
    }
    const validationError = validateManifest(parsed.manifest);
    if (validationError) return { status: "ambiguous", reason: "invalid-schema" };
    return { status: "valid", manifest: parsed.manifest };
}

/**
 * Lists every retained manifest file for one repository without suppressing unreadable or corrupt state.
 *
 * A missing manifest directory is a normal empty state; every other directory-read failure is surfaced to
 * the caller so recovery cannot silently omit durable session evidence.
 */
export async function listRebaseManifests(
    storageRoot: string,
    repoRoot: string,
): Promise<RebaseManifestListEntry[]> {
    const paths = getRebaseStoragePaths(storageRoot, repoRoot);
    let entries: string[];
    try {
        entries = await readdir(paths.manifestDirectory);
    } catch (error) {
        if (isFileMissing(error)) return [];
        throw error;
    }
    const sessionIds = entries
        .filter((entry) => entry.endsWith(".json"))
        .map((entry) => entry.slice(0, -".json".length))
        .sort();
    return Promise.all(
        sessionIds.map(async (sessionId) => ({
            sessionId,
            result: await readRebaseManifest(storageRoot, repoRoot, sessionId),
        })),
    );
}

/**
 * Removes one retained manifest and its helper artifacts after an explicit discard decision.
 *
 * Both removals are idempotent so a repeated user action or a partially cleaned prior action succeeds.
 *
 * The session identifier is confined to the repository namespace rather than validated. The listing
 * surfaces every file it finds by name, including names this module's own writer could never
 * produce, and discard has to be able to clear anything the listing showed — validating would throw
 * on exactly those entries and strand them behind a notice no user action could ever clear.
 */
export async function discardRebaseSession(
    storageRoot: string,
    repoRoot: string,
    sessionId: string,
): Promise<void> {
    const paths = getRebaseStoragePaths(storageRoot, repoRoot);
    const manifestPath = confineToDirectory(paths.manifestDirectory, `${sessionId}.json`);
    const sessionDirectory = confineToDirectory(paths.sessionsDirectory, sessionId);
    await Promise.all([
        manifestPath ? rm(manifestPath, { force: true }) : Promise.resolve(),
        sessionDirectory
            ? rm(sessionDirectory, { force: true, recursive: true })
            : Promise.resolve(),
    ]);
}

/** Resolves a name directly inside one directory, or nothing when it would escape it. */
function confineToDirectory(directory: string, name: string): string | undefined {
    const parent = path.resolve(directory);
    const resolved = path.resolve(parent, name);
    return path.dirname(resolved) === parent ? resolved : undefined;
}

/**
 * Reads the one reservation-correlated live manifest, if it can be positively identified.
 *
 * A missing, malformed, unreadable, terminal, or racing reservation/manifest has no authority
 * over a live rebase, so callers receive `undefined` and must classify the rebase as unowned or
 * foreign rather than injecting helper messages.
 */
export async function readLiveRebaseManifest(
    storageRoot: string | undefined,
    repoRoot: string,
): Promise<LiveRebaseSessionManifest | undefined> {
    if (!storageRoot) return undefined;
    try {
        const reservation = await readReservation(
            getRebaseStoragePaths(storageRoot, repoRoot).reservationPath,
        );
        if (reservation.status !== "valid") return undefined;
        const manifest = await readRebaseManifest(storageRoot, repoRoot, reservation.sessionId);
        return manifest.status === "valid" && isLiveManifest(manifest.manifest)
            ? manifest.manifest
            : undefined;
    } catch {
        return undefined;
    }
}

/** Narrows persisted lifecycle state before it can authorize an ownership correlation. */
function isLiveManifest(manifest: RebaseSessionManifest): manifest is LiveRebaseSessionManifest {
    return LIVE_LIFECYCLES.has(manifest.lifecycle);
}

function validateSessionId(sessionId: string): string {
    if (!SESSION_ID.test(sessionId))
        throw new Error("Interactive rebase session ID is not a safe file name.");
    return sessionId;
}

async function hasGitRebaseDirectory(gitDir: string): Promise<boolean> {
    return (
        (await pathExists(path.join(gitDir, "rebase-merge"))) ||
        (await pathExists(path.join(gitDir, "rebase-apply")))
    );
}

async function pathExists(target: string): Promise<boolean> {
    try {
        await stat(target);
        return true;
    } catch (error) {
        return !isFileMissing(error);
    }
}

async function ensureDirectory(directory: string): Promise<void> {
    await mkdir(directory, { recursive: true, mode: 0o700 });
}

async function ensureNewDirectory(directory: string): Promise<void> {
    await mkdir(directory, { mode: 0o700 });
}

async function readReservation(
    pointerPath: string,
): Promise<
    { status: "missing" } | { status: "valid"; sessionId: string } | { status: "ambiguous" }
> {
    let contents: string;
    try {
        contents = await readFile(pointerPath, "utf8");
    } catch (error) {
        if (isFileMissing(error)) return { status: "missing" };
        throw error;
    }
    try {
        const parsed: unknown = JSON.parse(contents);
        return isRecord(parsed) &&
            typeof parsed.sessionId === "string" &&
            SESSION_ID.test(parsed.sessionId)
            ? { status: "valid", sessionId: parsed.sessionId }
            : { status: "ambiguous" };
    } catch {
        return { status: "ambiguous" };
    }
}

async function writeManifestAtomically(
    target: string,
    manifest: RebaseSessionManifest,
): Promise<void> {
    const temporary = path.join(
        path.dirname(target),
        `.${path.basename(target)}.${randomUUID()}.tmp`,
    );
    const serialized = JSON.stringify(manifest);
    try {
        const file = await open(temporary, "wx", 0o600);
        try {
            await file.writeFile(serialized, "utf8");
            await file.sync();
        } finally {
            await file.close();
        }
        const parsed = parseManifest(await readFile(temporary, "utf8"));
        if ("reason" in parsed || validateManifest(parsed.manifest)) {
            throw new Error("Validated interactive rebase manifest could not be persisted safely.");
        }
        await rename(temporary, target);
    } finally {
        await rm(temporary, { force: true });
    }
}

function parseManifest(
    contents: string,
): { manifest: RebaseSessionManifest } | { reason: RebaseManifestAmbiguousReason } {
    let parsed: unknown;
    try {
        parsed = JSON.parse(contents);
    } catch {
        return { reason: isTruncatedJson(contents) ? "truncated" : "corrupt" };
    }
    if (!isRecord(parsed)) return { reason: "corrupt" };
    if (parsed.version !== 1) return { reason: "unknown-version" };
    return { manifest: parsed as unknown as RebaseSessionManifest };
}

function validateManifest(manifest: RebaseSessionManifest): ManifestValidationError | undefined {
    if (!isRecord(manifest) || manifest.version !== 1) return "invalid-schema";
    if (!isSafeSessionId(manifest.sessionId)) return "invalid-session-id";
    if (!isNonEmptyString(manifest.repoRoot) || !isFullyQualifiedRef(manifest.branch)) {
        return "invalid-schema";
    }
    if (typeof manifest.hasPushedCommit !== "boolean") return "invalid-schema";
    if (!isFullObjectId(manifest.baseHash) || !isFullObjectId(manifest.expectedHead))
        return "invalid-schema";
    if (manifest.rebasedHeadOid !== undefined && !isFullObjectId(manifest.rebasedHeadOid)) {
        return "invalid-schema";
    }
    if (!isNonEmptyString(manifest.createdAt) || !Number.isFinite(Date.parse(manifest.createdAt))) {
        return "invalid-schema";
    }
    if (!LIFECYCLES.has(manifest.lifecycle)) return "invalid-schema";
    if (manifest.pushTarget !== undefined && !isPushTarget(manifest.pushTarget))
        return "invalid-push-target";
    return undefined;
}

function isPushTarget(value: unknown): value is RebasePushTarget {
    return (
        isRecord(value) &&
        isNonEmptyString(value.remoteName) &&
        isFullyQualifiedRef(value.remoteHeadRef) &&
        isFullObjectId(value.upstreamOid) &&
        Object.keys(value).length === 3
    );
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === "string" && value.trim().length > 0 && !/[\r\n\0]/.test(value);
}

function isFullyQualifiedRef(value: unknown): value is string {
    return isNonEmptyString(value) && value.startsWith("refs/");
}

function isFullObjectId(value: unknown): value is string {
    return typeof value === "string" && FULL_OBJECT_ID.test(value);
}

function isSafeSessionId(value: unknown): value is string {
    return typeof value === "string" && SESSION_ID.test(value);
}

function isFileExists(error: unknown): boolean {
    return isNodeError(error, "EEXIST");
}

function isFileMissing(error: unknown): boolean {
    return isNodeError(error, "ENOENT");
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
    return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function isTruncatedJson(contents: string): boolean {
    const trimmed = contents.trim();
    return trimmed.startsWith("{") && !trimmed.endsWith("}");
}

type ManifestValidationError = "invalid-schema" | "invalid-session-id" | "invalid-push-target";

function manifestWriteError(
    code: ManifestValidationError,
): Error & { code: ManifestValidationError } {
    return Object.assign(new Error(`Interactive rebase manifest validation failed: ${code}.`), {
        code,
    });
}
