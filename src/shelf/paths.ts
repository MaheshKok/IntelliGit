import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";

/** Inputs for resolving one repository's private shelf storage. */
export interface ResolveShelfPathsOptions {
    repositoryRoot: string;
    globalStoragePath: string;
    overridePath?: string;
}

/** Resolved storage paths, all rooted under the stable repository identity. */
export interface ShelfPaths {
    repoId: string;
    root: string;
    scopeRoot: string;
    storageBase: string;
}

/** Raised when a shelf storage path is unsafe or escapes the shelf root. */
export class ShelfPathError extends Error {
    /** Creates a path error suitable for callers to surface directly. */
    constructor(message: string) {
        super(message);
        this.name = "ShelfPathError";
    }
}

/** Resolves the per-repository shelf root without creating it. */
export async function resolveShelfPaths(options: ResolveShelfPathsOptions): Promise<ShelfPaths> {
    const repositoryRoot = path.normalize(await realpath(options.repositoryRoot));
    const repoId = createHash("sha256").update(repositoryRoot).digest("hex").slice(0, 16);
    const scopeRoot = path.resolve(options.overridePath ?? options.globalStoragePath);
    const storageBase = options.overridePath ? scopeRoot : path.join(scopeRoot, "shelves");

    return {
        repoId,
        root: path.join(storageBase, repoId),
        scopeRoot,
        storageBase,
    };
}

/** Creates the shelf root with owner-only permissions and rejects symlinked roots. */
export async function ensureShelfRoot(paths: ShelfPaths): Promise<void> {
    await ensurePrivateDirectory(paths.scopeRoot);
    await ensurePrivateDirectory(paths.storageBase);
    await ensurePrivateDirectory(paths.root);
}

/** Resolves one Phase-1 internal artifact and rejects paths outside the shelf root. */
export function resolveShelfInternalPath(paths: ShelfPaths, relativePath: string): string {
    if (!relativePath || path.isAbsolute(relativePath)) {
        throw new ShelfPathError("Shelf artifact path must be a non-empty relative path.");
    }
    const target = path.resolve(paths.root, relativePath);
    const relative = path.relative(paths.root, target);
    if (
        relative === "" ||
        relative === ".." ||
        relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative)
    ) {
        throw new ShelfPathError("Shelf artifact path escapes the shelf root.");
    }
    return target;
}

/** Creates and verifies an internal artifact parent without traversing shelf symlinks. */
export async function ensureShelfInternalParent(
    paths: ShelfPaths,
    relativePath: string,
): Promise<string> {
    const target = resolveShelfInternalPath(paths, relativePath);
    await ensureShelfRoot(paths);
    await verifyInternalParent(paths.root, path.dirname(target), true);
    return target;
}

/** Verifies an existing internal artifact parent without following shelf symlinks. */
export async function assertShelfInternalParent(
    paths: ShelfPaths,
    relativePath: string,
): Promise<string> {
    const target = resolveShelfInternalPath(paths, relativePath);
    await ensureShelfRoot(paths);
    await verifyInternalParent(paths.root, path.dirname(target), false);
    return target;
}

/** Writes an owner-only internal shelf artifact after resolving its containment. */
export async function writePrivateShelfFile(
    paths: ShelfPaths,
    relativePath: string,
    contents: string | Uint8Array,
): Promise<string> {
    const target = await ensureShelfInternalParent(paths, relativePath);
    await rejectSymlinkIfPresent(target);
    await writeFile(target, contents, { mode: 0o600 });
    await chmod(target, 0o600);
    return target;
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
    const absolute = path.resolve(directory);
    const parsed = path.parse(absolute);
    const parts = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean);
    if (parts.length === 0)
        throw new ShelfPathError("Shelf storage root cannot be the filesystem root.");
    let current = parsed.root;
    for (const part of parts) {
        const candidate = path.join(current, part);
        let details: Awaited<ReturnType<typeof lstat>>;
        try {
            details = await lstat(candidate);
        } catch (error) {
            if (!isNotFound(error)) throw error;
            await mkdir(candidate, { mode: 0o700 });
            details = await lstat(candidate);
        }
        if (details.isSymbolicLink()) {
            if (isTrustedSystemAlias(candidate)) {
                current = await realpath(candidate);
                continue;
            }
            throw new ShelfPathError(`Shelf storage root is not a real directory: ${candidate}`);
        }
        if (!details.isDirectory()) {
            throw new ShelfPathError(`Shelf storage root is not a real directory: ${candidate}`);
        }
        current = candidate;
    }
    await chmod(absolute, 0o700);
}

async function verifyInternalParent(
    rootPath: string,
    directory: string,
    createMissing: boolean,
): Promise<void> {
    const rootLexical = path.resolve(rootPath);
    const parentLexical = path.resolve(directory);
    const relative = path.relative(rootLexical, parentLexical);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new ShelfPathError("Shelf artifact path escapes the shelf root.");
    }
    const root = await realpath(rootPath);
    if (relative === "") return;
    let current = root;
    for (const part of relative.split(path.sep)) {
        const candidate = path.join(current, part);
        let details: Awaited<ReturnType<typeof lstat>>;
        try {
            details = await lstat(candidate);
        } catch (error) {
            if (!isNotFound(error)) throw error;
            if (!createMissing) throw error;
            await mkdir(candidate, { mode: 0o700 });
            details = await lstat(candidate);
        }
        if (details.isSymbolicLink() || !details.isDirectory()) {
            throw new ShelfPathError(`Shelf artifact parent is not a real directory: ${candidate}`);
        }
        current = await realpath(candidate);
        assertContained(root, current);
    }
}

function assertContained(root: string, candidate: string): void {
    const relative = path.relative(root, candidate);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new ShelfPathError("Shelf artifact path escapes the shelf root.");
    }
}

function isTrustedSystemAlias(candidate: string): boolean {
    // macOS exposes its writable temporary tree through these immutable root aliases.
    // Other symlink components remain fail-closed; Node has no openat-family primitive
    // to eliminate a hostile rename race after this lstat/realpath bracket.
    return process.platform === "darwin" && (candidate === "/tmp" || candidate === "/var");
}

async function rejectSymlinkIfPresent(target: string): Promise<void> {
    try {
        if ((await lstat(target)).isSymbolicLink()) {
            throw new ShelfPathError(`Shelf artifact cannot replace a symbolic link: ${target}`);
        }
    } catch (error) {
        if (isNotFound(error)) return;
        throw error;
    }
}

function isNotFound(error: unknown): boolean {
    return (
        typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
    );
}
