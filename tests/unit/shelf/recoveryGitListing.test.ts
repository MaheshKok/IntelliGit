import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { GitExecutor } from "../../../src/git/executor";
import { GitExecutorRecoveryGit } from "../../../src/shelf/recoveryGit";
import { removeScratchDirectories } from "../../helpers/scratchDirectories";

const execFileAsync = promisify(execFile);
const directories: string[] = [];

afterEach(async () => {
    await removeScratchDirectories(...directories.splice(0));
});

async function git(directory: string, args: string[], input?: string): Promise<string> {
    const child = execFileAsync("git", args, {
        cwd: directory,
        env: {
            ...process.env,
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_AUTHOR_NAME: "Test",
            GIT_AUTHOR_EMAIL: "test@example.invalid",
            GIT_COMMITTER_NAME: "Test",
            GIT_COMMITTER_EMAIL: "test@example.invalid",
        },
    });
    if (input !== undefined) child.child.stdin?.end(input);
    return (await child).stdout;
}

async function write(root: string, file: string, content: string): Promise<void> {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), content);
}

/** Paths whose literal-pathspec answers differ in shape: prefixes, globs, Unicode, directories. */
const PATHS = [
    "plain.txt",
    "a",
    "a-b.txt",
    "a/inner.txt",
    "dir",
    "dir/nested/deep.txt",
    "glob[ab].txt",
    "star*.txt",
    "ünïcødé.txt",
    "skip.txt",
    "assume.txt",
    "conflict.txt",
    "missing.txt",
    "dir/missing.txt",
];

async function repository(): Promise<{ root: string; baseOid: string }> {
    const root = await mkdtemp(path.join(tmpdir(), "intelligit-recovery-listing-"));
    directories.push(root);
    await git(root, ["init", "--initial-branch=main"]);
    for (const file of [
        "plain.txt",
        "a-b.txt",
        "a/inner.txt",
        "dir/one.txt",
        "dir/nested/deep.txt",
        "glob[ab].txt",
        "globa.txt",
        "star*.txt",
        "starx.txt",
        "ünïcødé.txt",
        "skip.txt",
        "assume.txt",
        "conflict.txt",
    ])
        await write(root, file, `${file}\n`);
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", "base"]);
    const baseOid = (await git(root, ["rev-parse", "HEAD^{tree}"])).trim();
    await git(root, ["update-index", "--skip-worktree", "skip.txt"]);
    await git(root, ["update-index", "--assume-unchanged", "assume.txt"]);
    // Higher-stage entries for one path, as an unresolved merge leaves them.
    const blob = (await git(root, ["hash-object", "-w", "conflict.txt"])).trim();
    await git(
        root,
        ["update-index", "--index-info"],
        `0 ${"0".repeat(40)}\tconflict.txt\n` +
            [1, 2, 3].map((stage) => `100644 ${blob} ${stage}\tconflict.txt\n`).join(""),
    );
    return { root, baseOid };
}

/** Normalizes a call's outcome so a refusal compares as equal to the same refusal. */
async function outcome<T>(read: () => T | Promise<T>): Promise<unknown> {
    try {
        return { value: await read() };
    } catch (error) {
        return { error: (error as Error).message };
    }
}

describe("recovery Git batched reads", () => {
    it("answers every per-path index query exactly as the per-path commands do", async () => {
        const { root } = await repository();
        const recoveryGit = new GitExecutorRecoveryGit(new GitExecutor(root));

        const listing = await recoveryGit.readIndexListing();

        expect(listing.fingerprint).toBe(await recoveryGit.getIndexFingerprint());
        for (const file of PATHS) {
            expect(await outcome(() => listing.entry(file)), `entry ${file}`).toEqual(
                await outcome(() => recoveryGit.getIndexEntry(file)),
            );
            expect(listing.pathFingerprint(file), `fingerprint ${file}`).toBe(
                await recoveryGit.getIndexPathFingerprint(file),
            );
        }
    });

    it("answers every base entry query exactly as the single-path ls-tree does", async () => {
        const { root, baseOid } = await repository();
        const single = new GitExecutorRecoveryGit(new GitExecutor(root));
        const batched = new GitExecutorRecoveryGit(new GitExecutor(root));

        await batched.prefetchBaseEntries(baseOid, PATHS);

        for (const file of PATHS) {
            expect(await outcome(() => batched.getBaseEntry(baseOid, file)), file).toEqual(
                await outcome(() => single.getBaseEntry(baseOid, file)),
            );
        }
    });

    it("splits base prefetch into bounded ls-tree batches", async () => {
        const { root, baseOid } = await repository();
        const executor = new GitExecutor(root);
        const runBinary = executor.runBinary.bind(executor);
        const commands: string[][] = [];
        executor.runBinary = (args, options) => {
            commands.push(args);
            return runBinary(args, options);
        };
        const recoveryGit = new GitExecutorRecoveryGit(executor);
        const many = Array.from({ length: 450 }, (_, i) => `generated/${i}.txt`);

        await recoveryGit.prefetchBaseEntries(baseOid, [...many, "plain.txt"]);
        const before = commands.length;
        const entry = await recoveryGit.getBaseEntry(baseOid, "plain.txt");

        const batches = commands.filter((args) => args.includes("ls-tree"));
        expect(batches).toHaveLength(3);
        expect(Math.max(...batches.map((args) => args.length))).toBeLessThanOrEqual(5 + 200);
        expect(entry).toMatchObject({ mode: "100644" });
        expect(commands.length, "a prefetched path needs no further Git process").toBe(before);
    });
});
