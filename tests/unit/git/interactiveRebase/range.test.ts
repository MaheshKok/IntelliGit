import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ABSENT_GIT_CONFIG_GLOBAL } from "../../../helpers/gitConfigIsolation";
import {
    loadInteractiveRebaseRange,
    MAX_INTERACTIVE_REBASE_RANGE_COMMITS,
    MAX_INTERACTIVE_REBASE_RANGE_OUTPUT_BYTES,
} from "../../../../src/git/interactiveRebase/range";
import type { GitExecutor } from "../../../../src/git/executor";
import { removeScratchDirectories } from "../../../helpers/scratchDirectories";

const execFileAsync = promisify(execFile);
const HASH_A = "a".repeat(40);
const HASH_B = "b".repeat(40);
const BASE = "c".repeat(40);
const HEAD_HASH = "d".repeat(40);
const RANGE = `${BASE}^..${HEAD_HASH}`;
const AUTHOR_DATE = "2026-08-01T12:00:00+00:00";
const directories: string[] = [];

afterEach(async () => {
    await Promise.all(
        directories.splice(0).map((directory) => removeScratchDirectories(directory)),
    );
});

function record(hash: string, author = "Author", body = "body"): string {
    return [hash, author, AUTHOR_DATE, body].join("\0");
}

function executorFor({
    count = 1,
    output = `${record(HASH_A)}\0`,
    truncated = false,
    unpushedTruncated = false,
    unpushed = "",
}: {
    count?: number | string;
    output?: string;
    truncated?: boolean;
    unpushedTruncated?: boolean;
    unpushed?: string;
} = {}): GitExecutor {
    const run = vi.fn(async (args: string[]) => {
        if (args.join(" ") === `rev-list --count --end-of-options ${RANGE}`) return String(count);
        throw new Error(`Unexpected Git command: ${args.join(" ")}`);
    });
    const runBinary = vi.fn(async (args: string[]) => {
        if (args[0] === "log") {
            return {
                stdout: Buffer.from(output),
                stderr: Buffer.alloc(0),
                exitCode: 0,
                truncated,
            };
        }
        if (args.join(" ") === `rev-list ${RANGE} --not --remotes`) {
            return {
                stdout: Buffer.from(unpushed),
                stderr: Buffer.alloc(0),
                exitCode: 0,
                truncated: unpushedTruncated,
            };
        }
        throw new Error(`Unexpected Git command: ${args.join(" ")}`);
    });
    return { run, runBinary } as unknown as GitExecutor;
}

describe("loadInteractiveRebaseRange", () => {
    it("loads NUL-only fixed-arity records and computes pushedness in one batched query", async () => {
        const hostileBody = `${HASH_B}Author${AUTHOR_DATE}record-like\rline\nlone\ncontrol:`;
        const executor = executorFor({
            count: 2,
            output: `${record(HASH_A, "", "")}\0${record(HASH_B, "Author", hostileBody)}\0`,
            unpushed: `${HASH_B}\n`,
        });

        await expect(loadInteractiveRebaseRange(executor, BASE, HEAD_HASH)).resolves.toEqual({
            status: "ok",
            commits: [
                { hash: HASH_A, authorName: "", authoredAt: AUTHOR_DATE, body: "", isPushed: true },
                {
                    hash: HASH_B,
                    authorName: "Author",
                    authoredAt: AUTHOR_DATE,
                    body: hostileBody,
                    isPushed: false,
                },
            ],
        });
        expect((executor.run as ReturnType<typeof vi.fn>).mock.calls).toEqual([
            [["rev-list", "--count", "--end-of-options", RANGE]],
        ]);
        expect((executor.runBinary as ReturnType<typeof vi.fn>).mock.calls).toEqual([
            [
                [
                    "log",
                    "--reverse",
                    "-z",
                    "--encoding=UTF-8",
                    "--format=%H%x00%an%x00%aI%x00%B",
                    "--end-of-options",
                    RANGE,
                ],
                { maxOutputBytes: MAX_INTERACTIVE_REBASE_RANGE_OUTPUT_BYTES },
            ],
            [
                ["rev-list", RANGE, "--not", "--remotes"],
                { maxOutputBytes: MAX_INTERACTIVE_REBASE_RANGE_OUTPUT_BYTES },
            ],
        ]);
    });

    it.each([
        ["an option-shaped argument", "--output=/tmp/intelligit-should-not-exist"],
        ["a leading dash", "-HEAD"],
        ["an abbreviated hash", "abc1234"],
        ["an uppercase object ID", "A".repeat(40)],
        ["a revision expression", "HEAD~5"],
        ["a range the caller built itself", `${BASE}^..HEAD`],
        ["an empty string", ""],
    ] as const)("rejects %s as a base before spawning Git", async (_name, baseHash) => {
        const executor = executorFor();

        await expect(loadInteractiveRebaseRange(executor, baseHash, HEAD_HASH)).resolves.toEqual({
            status: "rejected",
            reason: "invalid-base-hash",
        });
        expect(executor.run).not.toHaveBeenCalled();
        expect(executor.runBinary).not.toHaveBeenCalled();
    });

    it.each([
        ["an option-shaped argument", "--output=/tmp/intelligit-should-not-exist"],
        ["a leading dash", "-HEAD"],
        ["the literal HEAD", "HEAD"],
        ["an abbreviated hash", "abc1234"],
        ["an empty string", ""],
    ] as const)("rejects %s as a head before spawning Git", async (_name, headHash) => {
        const executor = executorFor();

        await expect(loadInteractiveRebaseRange(executor, BASE, headHash)).resolves.toEqual({
            status: "rejected",
            reason: "invalid-head-hash",
        });
        expect(executor.run).not.toHaveBeenCalled();
        expect(executor.runBinary).not.toHaveBeenCalled();
    });

    it("pins every query to the supplied head instead of resolving HEAD itself", async () => {
        const executor = executorFor();

        await loadInteractiveRebaseRange(executor, BASE, HEAD_HASH);

        const issued = [
            ...(executor.run as ReturnType<typeof vi.fn>).mock.calls,
            ...(executor.runBinary as ReturnType<typeof vi.fn>).mock.calls,
        ].flatMap(([args]: [string[]]) => args);
        expect(issued).not.toContain("HEAD");
        expect(issued.filter((arg) => arg === RANGE)).toHaveLength(3);
    });

    it("rejects a range over the product cap before loading bodies or pushedness", async () => {
        const executor = executorFor({ count: MAX_INTERACTIVE_REBASE_RANGE_COMMITS + 1 });

        await expect(loadInteractiveRebaseRange(executor, BASE, HEAD_HASH)).resolves.toEqual({
            status: "rejected",
            reason: "range-too-large",
        });
        expect(executor.runBinary).not.toHaveBeenCalled();
        expect(executor.run).toHaveBeenCalledTimes(1);
    });

    it("accepts exactly the product cap", async () => {
        const executor = executorFor({
            count: MAX_INTERACTIVE_REBASE_RANGE_COMMITS,
            output: `${Array.from({ length: MAX_INTERACTIVE_REBASE_RANGE_COMMITS }, (_, index) =>
                record(index.toString(16).padStart(40, "0")),
            ).join("\0")}\0`,
        });

        const result = await loadInteractiveRebaseRange(executor, BASE, HEAD_HASH);
        expect(result).toMatchObject({ status: "ok" });
        if (result.status === "ok") {
            expect(result.commits).toHaveLength(MAX_INTERACTIVE_REBASE_RANGE_COMMITS);
        }
    });

    it("rejects an empty range instead of returning zero commits", async () => {
        const executor = executorFor({ count: 0, output: "" });

        await expect(loadInteractiveRebaseRange(executor, BASE, HEAD_HASH)).resolves.toEqual({
            status: "rejected",
            reason: "empty-range",
        });
        expect(executor.runBinary).not.toHaveBeenCalled();
    });

    it("rejects a record count that disagrees with the independent count probe", async () => {
        const executor = executorFor({ count: 2, output: `${record(HASH_A)}\0` });

        await expect(loadInteractiveRebaseRange(executor, BASE, HEAD_HASH)).resolves.toEqual({
            status: "rejected",
            reason: "count-mismatch",
        });
    });

    it.each([
        ["the range load", { truncated: true }],
        ["the pushedness query", { unpushedTruncated: true }],
    ] as const)("rejects truncated output from %s without parsing it", async (_name, overrides) => {
        await expect(
            loadInteractiveRebaseRange(executorFor(overrides), BASE, HEAD_HASH),
        ).resolves.toEqual({
            status: "rejected",
            reason: "output-truncated",
        });
    });

    it.each([
        ["a missing trailing sentinel", record(HASH_A), "missing-trailing-sentinel"],
        ["an empty stream", "", "missing-trailing-sentinel"],
        ["two trailing sentinels", `${record(HASH_A)}\0\0`, "malformed-arity"],
        ["an arity remainder of one", `field\0`, "malformed-arity"],
        ["an arity remainder of two", `field\0field\0`, "malformed-arity"],
        ["an arity remainder of three", `field\0field\0field\0`, "malformed-arity"],
    ] as const)("rejects %s", async (_name, output, reason) => {
        await expect(
            loadInteractiveRebaseRange(executorFor({ output }), BASE, HEAD_HASH),
        ).resolves.toEqual({
            status: "rejected",
            reason,
        });
    });

    it.each([
        ["a non-numeric count", "not-a-count"],
        ["a blank count", ""],
    ] as const)("fails closed on %s", async (_name, count) => {
        await expect(
            loadInteractiveRebaseRange(executorFor({ count }), BASE, HEAD_HASH),
        ).resolves.toEqual({
            status: "rejected",
            reason: "invalid-range-count",
        });
    });
});

describe("loadInteractiveRebaseRange real Git framing", () => {
    it("round-trips hostile commit bodies through Git's NUL-only framing", async () => {
        const repo = await createRepository();
        await commit(repo, "initial\n");

        const firstBody = "SOH: CR:\r lone-LF:\n control:\n";
        const secondBody = `${HASH_A}Author${AUTHOR_DATE}well-formed-record-text\n`;
        const firstHash = await commit(repo, firstBody);
        const secondHash = await commit(repo, secondBody);

        await expect(
            loadInteractiveRebaseRange(await executorIn(repo), firstHash, secondHash),
        ).resolves.toEqual({
            status: "ok",
            commits: [
                expect.objectContaining({ hash: firstHash, body: firstBody, isPushed: false }),
                expect.objectContaining({ hash: secondHash, body: secondBody, isPushed: false }),
            ],
        });
    });

    it("does not let an option-shaped argument reach Git and write a file", async () => {
        const repo = await createRepository();
        await commit(repo, "initial\n");
        const head = await commit(repo, "second\n");
        const target = path.join(repo, "PWNED");

        await expect(
            loadInteractiveRebaseRange(await executorIn(repo), `--output=${target}`, head),
        ).resolves.toEqual({ status: "rejected", reason: "invalid-base-hash" });
        expect(existsSync(target)).toBe(false);

        await expect(
            loadInteractiveRebaseRange(await executorIn(repo), head, `--output=${target}`),
        ).resolves.toEqual({ status: "rejected", reason: "invalid-head-hash" });
        expect(existsSync(target)).toBe(false);
    });

    it("treats a real truncated stream as a hard error", async () => {
        const repo = await createRepository();
        await commit(repo, "initial\n");
        const base = await commit(repo, "second\n");
        const head = await commit(repo, "third\n");

        await expect(
            loadInteractiveRebaseRange(await executorIn(repo), base, head, {
                maxOutputBytes: 12,
            }),
        ).resolves.toEqual({ status: "rejected", reason: "output-truncated" });
    });

    it("loads the pinned range even after the branch moves past it", async () => {
        const repo = await createRepository();
        await commit(repo, "initial\n");
        const base = await commit(repo, "second\n");
        const pinnedHead = await commit(repo, "third\n");
        const laterHash = await commit(repo, "fourth\n");

        const result = await loadInteractiveRebaseRange(await executorIn(repo), base, pinnedHead);

        expect(result).toMatchObject({ status: "ok" });
        if (result.status !== "ok") return;
        expect(result.commits.map((commit) => commit.hash)).toEqual([base, pinnedHead]);
        expect(result.commits.map((commit) => commit.hash)).not.toContain(laterHash);
    });

    it("reads a body Git already transcoded when i18n.commitEncoding is unset", async () => {
        const repo = await createRepository();
        await commit(repo, "initial\n");
        const head = await commitRawMessage(repo, NON_UTF8_MESSAGE);

        const result = await loadInteractiveRebaseRange(await executorIn(repo), head, head);

        // Git treats a non-UTF-8 message as latin-1 and stores UTF-8 when no encoding is
        // configured, so the stored object never holds the original byte. Read as raw bytes:
        // decoding this to a string first would replace the byte and make the check vacuous.
        const stored = await gitBytes(repo, ["cat-file", "commit", head]);
        expect(stored.includes(0xff)).toBe(false);
        expect(stored.includes(Buffer.from("ÿ", "utf8"))).toBe(true);
        expect(result).toEqual({
            status: "ok",
            commits: [expect.objectContaining({ hash: head, body: "subject\n\nÿ\n" })],
        });
    });

    it("decodes a body Git stored verbatim under a configured commit encoding", async () => {
        const repo = await createRepository();
        // With an encoding configured, Git stores the message bytes untouched and records an
        // `encoding` header. This is the case the range loader must ask Git to convert — without
        // an explicit output encoding the raw byte reaches `toString("utf8")` as U+FFFD.
        await git(repo, ["config", "i18n.commitEncoding", "ISO-8859-1"]);
        await commit(repo, "initial\n");
        const head = await commitRawMessage(repo, NON_UTF8_MESSAGE);

        const result = await loadInteractiveRebaseRange(await executorIn(repo), head, head);

        const stored = await gitBytes(repo, ["cat-file", "commit", head]);
        expect(stored.includes(0xff)).toBe(true);
        expect(stored.includes(Buffer.from("encoding ISO-8859-1"))).toBe(true);
        expect(result).toEqual({
            status: "ok",
            commits: [expect.objectContaining({ hash: head, body: "subject\n\nÿ\n" })],
        });
        if (result.status !== "ok") return;
        expect(result.commits[0].body).not.toContain("�");
    });
});

/** `subject\n\n<0xFF>\n` — a body that is not valid UTF-8. */
const NON_UTF8_MESSAGE = Buffer.from([
    0x73, 0x75, 0x62, 0x6a, 0x65, 0x63, 0x74, 0x0a, 0x0a, 0xff, 0x0a,
]);

async function commitRawMessage(repo: string, message: Buffer): Promise<string> {
    const messagePath = path.join(repo, `raw-message-${message.length}`);
    await writeFile(messagePath, message);
    await git(repo, ["commit", "--allow-empty", "--cleanup=verbatim", "-F", messagePath]);
    return (await git(repo, ["rev-parse", "HEAD"])).trim();
}

async function gitBytes(repo: string, args: string[]): Promise<Buffer> {
    return (await execFileAsync("git", args, { cwd: repo, encoding: "buffer" })).stdout;
}

async function executorIn(repo: string): Promise<GitExecutor> {
    const { GitExecutor: Executor } = await import("../../../../src/git/executor");
    return new Executor(repo);
}

async function createRepository(): Promise<string> {
    const repo = await mkdtemp(path.join(tmpdir(), "intelligit-rebase-range-"));
    directories.push(repo);
    await git(repo, ["init"]);
    await git(repo, ["config", "user.email", "test@example.com"]);
    await git(repo, ["config", "user.name", "Test User"]);
    return repo;
}

async function git(repo: string, args: string[]): Promise<string> {
    return (
        await execFileAsync("git", ["-c", "commit.gpgSign=false", ...args], {
            cwd: repo,
            env: {
                ...process.env,
                GIT_CONFIG_GLOBAL: ABSENT_GIT_CONFIG_GLOBAL,
                GIT_CONFIG_NOSYSTEM: "1",
            },
        })
    ).stdout;
}

async function commit(repo: string, body: string): Promise<string> {
    const messagePath = path.join(repo, `message-${directories.length}-${Date.now()}`);
    await writeFile(messagePath, body, "utf8");
    await git(repo, ["commit", "--allow-empty", "--cleanup=verbatim", "-F", messagePath]);
    return (await git(repo, ["rev-parse", "HEAD"])).trim();
}
