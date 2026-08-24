import { lstat, mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { RecoverySafetyError } from "./recoveryGit";

/** Resolves a repository-relative worktree path without allowing lexical escape. */
export function resolveRepositoryPath(repositoryRoot: string, relativePath: string): string {
    const safeRelativePath = assertRepositoryRelativePath(relativePath);
    const target = path.resolve(repositoryRoot, safeRelativePath);
    const relative = path.relative(repositoryRoot, target);
    if (
        relative === "" ||
        relative === ".." ||
        relative.startsWith(".." + path.sep) ||
        path.isAbsolute(relative)
    ) {
        throw new RecoverySafetyError("Recovery path escapes repository root.");
    }
    return target;
}

/** Resolves a transaction staging path without allowing lexical escape. */
export function resolveRecoveryPath(recoveryDirectory: string, relativePath: string): string {
    const target = path.resolve(recoveryDirectory, assertRepositoryRelativePath(relativePath));
    const relative = path.relative(recoveryDirectory, target);
    if (
        relative === "" ||
        relative === ".." ||
        relative.startsWith(".." + path.sep) ||
        path.isAbsolute(relative)
    ) {
        throw new RecoverySafetyError("Recovery staging path escapes its transaction directory.");
    }
    return target;
}

/** Validates one input path is safely repository-relative. */
export function assertRepositoryRelativePath(value: string): string {
    if (!value || path.isAbsolute(value)) {
        throw new RecoverySafetyError("Recovery path must be repository-relative.");
    }
    const normalized = path.normalize(value);
    if (normalized === "." || normalized === ".." || normalized.startsWith(".." + path.sep)) {
        throw new RecoverySafetyError("Recovery path escapes repository root.");
    }
    // Returned with forward slashes, not the platform separator. This value is used as a GIT
    // path -- `writeIndexEntry`, `getIndexEntry`, `getIndexPathFingerprint` and `getBaseEntry`
    // all take it straight to git -- and git addresses paths with `/` on every platform, so
    // `git show <oid>:blocked\one.txt` resolves nothing. `path.normalize` returns
    // `blocked\one.txt` on Windows, so each of those lookups silently addressed a path git had
    // never heard of. It is also the value surfaced in `ShelfRollbackRetainedError.retainedPaths`
    // and used as a journal key, both of which must stay portable across platforms for an
    // exported shelf to import elsewhere. `src/utils/fileOps.ts` documents the same constraint
    // and already does this.
    //
    // The escape guard above deliberately runs first, on the platform form, so this is purely a
    // change of representation: `path.resolve` treats `/` and `\` identically on Windows, so the
    // filesystem call sites (`resolveRepositoryPath`, `resolveRecoveryPath`) are unaffected.
    return normalized.split(path.sep).join("/");
}

/** Realpath-checks an existing target parent against the repository root. */
export async function assertContainedParent(repositoryRoot: string, target: string): Promise<void> {
    const [root, parent] = await Promise.all([
        realpath(repositoryRoot),
        realpath(path.dirname(target)),
    ]);
    assertContained(root, parent);
}

/** Checks all existing ancestors when the immediate parent has not yet been created. */
export async function assertContainedParentIfPresent(
    repositoryRoot: string,
    target: string,
): Promise<void> {
    try {
        await assertContainedParent(repositoryRoot, target);
    } catch (error) {
        if (!isNotFound(error)) throw error;
        await walkContainedParent(repositoryRoot, target, false);
    }
}

/**
 * Creates missing parent directories one component at a time after lstat/realpath checks.
 *
 * Node has no openat-family API, so lstat bracketing bounds (but cannot erase) a hostile
 * rename race; no directory is created through an already-observed symlink.
 */
export async function ensureContainedParent(repositoryRoot: string, target: string): Promise<void> {
    await walkContainedParent(repositoryRoot, target, true);
    await assertContainedParent(repositoryRoot, target);
}

async function walkContainedParent(
    repositoryRoot: string,
    target: string,
    createMissing: boolean,
): Promise<void> {
    const root = await realpath(repositoryRoot);
    const rootLexical = path.resolve(repositoryRoot);
    const parentLexical = path.resolve(path.dirname(target));
    const relative = path.relative(rootLexical, parentLexical);
    if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) {
        throw new RecoverySafetyError("Recovery write escaped the repository root.");
    }
    if (relative === "") return;
    let current = root;
    for (const component of relative.split(path.sep)) {
        const candidate = path.join(current, component);
        let details: Awaited<ReturnType<typeof lstat>>;
        try {
            // react-doctor-disable-next-line react-doctor/async-await-in-loop -- Parent components must be checked and canonicalized in order before creating a child.
            details = await lstat(candidate);
        } catch (error) {
            if (!isNotFound(error)) throw error;
            if (!createMissing) return;
            await mkdir(candidate, { mode: 0o700 });
            details = await lstat(candidate);
        }
        if (!details.isDirectory() || details.isSymbolicLink()) {
            throw new RecoverySafetyError("Recovery write escaped the repository root.");
        }
        current = await realpath(candidate);
        assertContained(root, current);
    }
}

function assertContained(root: string, candidate: string): void {
    const relative = path.relative(root, candidate);
    if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) {
        throw new RecoverySafetyError("Recovery write escaped the repository root.");
    }
}

function isNotFound(error: unknown): boolean {
    return (
        typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
    );
}
