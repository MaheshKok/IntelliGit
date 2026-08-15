import { execFile } from "node:child_process";
import { readdir, realpath } from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";

import type { FixtureWorkspace } from "../../fixtures/repo/harness";
import { getRebaseStoragePaths } from "../../../src/git/interactiveRebase/storage";
import { resolveShelfPaths } from "../../../src/shelf/paths";
import { name as extensionName, publisher } from "../../../package.json";
import { sanitizedGitEnv } from "./gitEnv";

const execFileAsync = promisify(execFile);

/**
 * VS Code stores an extension's global state under a lower-cased `<publisher>.<name>` folder.
 * Derived from the manifest rather than written out: a rename would otherwise point the oracle at
 * a directory that does not exist, and every list beneath a missing directory comes back empty --
 * so each assertion about durable state would keep passing while reading nothing at all.
 */
const EXTENSION_STORAGE_FOLDER = `${publisher}.${extensionName}`.toLowerCase();

/** Parsed direct-file observation of the extension's durable repository state. */
export interface DurableStateSnapshot {
    readonly globalStoragePath: string;
    readonly shelfRoot: string;
    readonly shelfStoreFiles: readonly string[];
    readonly shelfLockDirectory: string;
    readonly rebaseRepositoryDirectory: string;
    readonly rebaseManifestFiles: readonly string[];
    readonly repoLockPath: string;
    readonly repoLockPresent: boolean;
    readonly takeoverPaths: readonly string[];
}

type DurableWorkspace = Pick<FixtureWorkspace, "root" | "profileDir" | "env">;

/**
 * The shelf store keeps its advisory lock at `<shelfRoot>/.store-lock/store.lock`
 * (`src/shelf/store.ts`), which is inside the tree `shelfStoreFiles` walks. That lock is transient
 * -- an in-flight background refresh holds it for a few milliseconds -- so sampling the file list
 * once turns `shelfStoreFiles).toEqual([])` into a coin flip. It has already been observed twice on
 * the `pull` row. Excluded here and asserted by polling instead, so a genuine leak still fails
 * while a lock that is merely still held does not.
 */
const SHELF_LOCK_DIRECTORY_NAME = ".store-lock";

/** Lists every file beneath a directory, sorted, treating a missing directory as empty. */
export async function listFilesUnder(root: string): Promise<readonly string[]> {
    let entries;
    try {
        entries = await readdir(root, { withFileTypes: true });
    } catch (error) {
        if (isMissing(error)) return [];
        throw error;
    }
    const files: string[] = [];
    for (const entry of entries) {
        const entryPath = path.join(root, entry.name);
        if (entry.isDirectory()) {
            files.push(...(await listFilesUnder(entryPath)));
        } else {
            files.push(entryPath);
        }
    }
    // Sorted once over the flat result, by code point. Sorting each directory's own entries
    // instead orders the output by traversal rather than by path, so `a/z` lands before `a-b`
    // while the list still looks sorted -- and `localeCompare` takes that ordering from the host's
    // ICU data, which makes any assertion pinning the list disagree between machines.
    return files.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

async function resolveCommonDir(workspace: DurableWorkspace): Promise<string> {
    const result = await execFileAsync("git", ["rev-parse", "--git-common-dir"], {
        cwd: workspace.root,
        env: sanitizedGitEnv(workspace.env),
        maxBuffer: 1024 * 1024,
    });
    const commonDir = result.stdout.trim();
    return path.resolve(workspace.root, commonDir);
}

function isMissing(error: unknown): boolean {
    return (
        typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
    );
}

/** Reads shelf, rebase, and repository-lock files directly from the fixture workspace. */
export async function readDurableState(
    workspace: DurableWorkspace,
    options: { readonly globalStoragePath?: string } = {},
): Promise<DurableStateSnapshot> {
    // VS Code lower-cases the extension id for its storage folder, and production identifies a
    // repository by its realpath — an unresolved /var symlink hashes to a different directory, so
    // the oracle would read an empty path forever and assert nothing.
    const globalStoragePath =
        options.globalStoragePath ??
        path.join(workspace.profileDir, "User", "globalStorage", EXTENSION_STORAGE_FOLDER);
    const [shelfPaths, commonDir] = await Promise.all([
        resolveShelfPaths({ repositoryRoot: workspace.root, globalStoragePath }),
        resolveCommonDir(workspace),
    ]);
    const resolvedRoot = await realpath(workspace.root);
    const rebasePaths = getRebaseStoragePaths(globalStoragePath, resolvedRoot);
    const shelfLockDirectory = path.join(shelfPaths.root, SHELF_LOCK_DIRECTORY_NAME);
    const lockDirectory = path.join(commonDir, "intelligit");
    const repoLockPath = path.join(lockDirectory, "repo.lock");
    let lockEntries: readonly string[] = [];
    try {
        lockEntries = await readdir(lockDirectory);
    } catch (error) {
        if (!isMissing(error)) throw error;
    }
    return {
        globalStoragePath,
        shelfRoot: shelfPaths.root,
        shelfStoreFiles: (await listFilesUnder(shelfPaths.root)).filter(
            (file) => !file.startsWith(shelfLockDirectory + path.sep),
        ),
        shelfLockDirectory,
        rebaseRepositoryDirectory: rebasePaths.repositoryDirectory,
        rebaseManifestFiles: await listFilesUnder(rebasePaths.manifestDirectory),
        repoLockPath,
        repoLockPresent: lockEntries.includes("repo.lock"),
        takeoverPaths: lockEntries
            .filter((entry) => entry.startsWith("takeover-"))
            .map((entry) => path.join(lockDirectory, entry))
            .sort(),
    };
}
