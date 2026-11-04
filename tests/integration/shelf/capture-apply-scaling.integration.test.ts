import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { GitExecutor } from "../../../src/git/executor";
import type { ShelfCaptureDependencies } from "../../../src/services/shelfServiceCapture";
import { cleanTemporaryRepositories, createShelfFixture, git } from "./shelfTestHarness";

afterEach(async () => {
    vi.restoreAllMocks();
    await cleanTemporaryRepositories();
});

/** Shelves `files` modified tracked files and counts the Git processes and `git apply` runs. */
async function captureProcesses(
    files: number,
): Promise<{ readonly applies: number; readonly processes: number }> {
    const names = Array.from({ length: files }, (_, index) => `file-${index}.txt`);
    const fixture = await createShelfFixture({
        initialFiles: Object.fromEntries(names.map((name) => [name, "base\n"])),
    });
    for (const name of names) await writeFile(path.join(fixture.root, name), "incoming\n");
    // `run` starts its process through `runBinary`, so counting `runBinary` alone counts each once.
    const binary = vi.spyOn(GitExecutor.prototype, "runBinary");
    const saved = await fixture.service.shelve({
        name: "S",
        paths: names,
        silent: true,
        keepLocal: true,
    });
    const applies = binary.mock.calls.filter(([args]) => args.includes("apply")).length;
    const processes = binary.mock.calls.length;
    binary.mockRestore();
    const entries = await fixture.service.getShelfFiles(saved.shelfId!);
    expect(entries.map((entry) => entry.worktreeBlock?.path).sort()).toEqual([...names].sort());
    for (const entry of entries)
        expect(entry, entry.worktreeBlock?.path).toMatchObject({
            exactReconstruction: true,
            worktreeBlock: { status: "M" },
        });
    return { applies, processes };
}

it("runs a fixed number of git apply processes however many files a capture holds", async () => {
    const twenty = await captureProcesses(20);
    const forty = await captureProcesses(40);
    const counts = `20 files: ${JSON.stringify(twenty)}, 40 files: ${JSON.stringify(forty)}`;
    expect(forty.applies, counts).toBe(twenty.applies);
    // One `--check` and one apply for the whole capture.
    expect(twenty.applies, counts).toBeLessThanOrEqual(2);
});

/** Refuses any apply check whose patch carries `name`, as Git does for a hunk that misses. */
function refuseApplyChecksFor(name: string): void {
    const original = GitExecutor.prototype.runBinary;
    vi.spyOn(GitExecutor.prototype, "runBinary").mockImplementation(function (
        this: GitExecutor,
        args,
        options,
    ) {
        if (
            args.includes("apply") &&
            args.includes("--check") &&
            Buffer.isBuffer(options?.input) &&
            options.input.includes(`b/${name}`)
        )
            return Promise.resolve({
                stdout: Buffer.alloc(0),
                stderr: Buffer.from(`error: patch failed: ${name}:1\n`),
                exitCode: 1,
                truncated: false,
            });
        return original.call(this, args, options);
    });
}

it("keeps every other file's raw fidelity when one file's patch does not apply", async () => {
    const plain = ["plain-0.txt", "plain-1.txt"];
    const crlf = ["crlf-0.txt", "crlf-1.txt", "crlf-2.txt"];
    const bad = "crlf-bad.txt";
    const names = [...plain, ...crlf, bad];
    const fixture = await createShelfFixture({
        initialFiles: {
            ...Object.fromEntries(names.map((name) => [name, "base\n"])),
            ".gitattributes": "crlf-*.txt text eol=crlf\n",
        },
    });
    for (const name of plain) await writeFile(path.join(fixture.root, name), "incoming\n");
    for (const name of [...crlf, bad])
        await writeFile(path.join(fixture.root, name), "incoming\r\n");
    refuseApplyChecksFor(bad);
    const saved = await fixture.service.shelve({
        name: "S",
        paths: names,
        silent: true,
        keepLocal: true,
    });
    const entries = new Map(
        (await fixture.service.getShelfFiles(saved.shelfId!)).map((entry) => [
            entry.worktreeBlock?.path,
            entry,
        ]),
    );
    expect([...entries.keys()].sort()).toEqual([...names].sort());
    // Plain files materialize to their exact worktree bytes, so no raw artefacts are needed.
    for (const name of plain)
        expect(entries.get(name), name).toMatchObject({ exactReconstruction: true });
    // CRLF worktree bytes differ from Git's normalized bytes, so raw before/after artefacts are kept.
    for (const name of crlf)
        expect(entries.get(name), name).toMatchObject({
            exactReconstruction: false,
            worktreeBlock: {
                rawBeforeObjectHash: expect.stringMatching(/^[a-f0-9]{64}$/),
                rawAfterObjectHash: expect.stringMatching(/^[a-f0-9]{64}$/),
            },
        });
    // The file whose patch was refused is still shelved, only without raw artefacts.
    expect(entries.get(bad), bad).toMatchObject({ exactReconstruction: true });
    expect(entries.get(bad)?.worktreeBlock?.rawAfterObjectHash, bad).toBeUndefined();
});

it("gives each file its own raw fidelity when files without a batch slot sort before it", async () => {
    // The untracked file has no materialize request and the refused one falls out of its group,
    // so batch slots, split-group positions and entry positions all differ for the CRLF file.
    const untracked = "a-new.txt";
    const bad = "b-bad.txt";
    const crlf = "c-crlf.txt";
    const plain = "d-plain.txt";
    const fixture = await createShelfFixture({
        initialFiles: {
            [bad]: "base\n",
            [crlf]: "base\n",
            [plain]: "base\n",
            ".gitattributes": "c-crlf.txt text eol=crlf\n",
        },
    });
    await writeFile(path.join(fixture.root, untracked), "new\n");
    await writeFile(path.join(fixture.root, bad), "incoming\n");
    await writeFile(path.join(fixture.root, crlf), "incoming\r\n");
    await writeFile(path.join(fixture.root, plain), "incoming\n");
    refuseApplyChecksFor(bad);
    const saved = await fixture.service.shelve({
        name: "S",
        paths: [untracked, bad, crlf, plain],
        silent: true,
        keepLocal: true,
    });
    const entries = new Map(
        (await fixture.service.getShelfFiles(saved.shelfId!)).map((entry) => [
            entry.worktreeBlock?.path,
            entry,
        ]),
    );
    expect([...entries.keys()].sort()).toEqual([untracked, bad, crlf, plain]);
    expect(entries.get(crlf), crlf).toMatchObject({
        exactReconstruction: false,
        worktreeBlock: {
            rawBeforeObjectHash: expect.stringMatching(/^[a-f0-9]{64}$/),
            rawAfterObjectHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
    });
    expect(entries.get(plain), plain).toMatchObject({ exactReconstruction: true });
    for (const name of [untracked, bad])
        expect(entries.get(name)?.worktreeBlock?.rawAfterObjectHash, name).toBeUndefined();
});

it("layers a file's staged and unstaged patches inside the batch", async () => {
    const lines = Array.from({ length: 60 }, (_, index) => `line ${index}`);
    const text = (edited: readonly string[]) => `${edited.join("\n")}\n`;
    const fixture = await createShelfFixture({
        initialFiles: { "layered.txt": text(lines), "plain.txt": "base\n" },
    });
    const staged = lines.map((line, index) => (index === 0 ? "staged" : line));
    await writeFile(path.join(fixture.root, "layered.txt"), text(staged));
    await git(fixture.root, ["add", "layered.txt"]);
    // Far from the staged hunk, so the worktree patch alone would still apply to the bare base.
    const both = staged.map((line, index) => (index === 50 ? "unstaged" : line));
    await writeFile(path.join(fixture.root, "layered.txt"), text(both));
    await writeFile(path.join(fixture.root, "plain.txt"), "incoming\n");
    const binary = vi.spyOn(GitExecutor.prototype, "runBinary");
    const saved = await fixture.service.shelve({
        name: "S",
        paths: ["layered.txt", "plain.txt"],
        silent: true,
        keepLocal: true,
    });
    const applies = binary.mock.calls.filter(([args]) => args.includes("apply")).length;
    binary.mockRestore();
    const layered = (await fixture.service.getShelfFiles(saved.shelfId!)).find(
        (entry) => entry.worktreeBlock?.path === "layered.txt",
    );
    expect(layered).toMatchObject({
        exactReconstruction: true,
        indexBlock: { status: "M" },
        worktreeBlock: { status: "M" },
    });
    expect(applies).toBeLessThanOrEqual(2);
});

it("materializes a base whose path is already taken in the batch folder on its own", async () => {
    // Case-folding filesystems map two repository paths onto one temp file; reusing a path
    // reproduces that collision on any filesystem.
    const fixture = await createShelfFixture();
    const materializeEntries = (
        fixture.service as unknown as {
            materializeEntries: ShelfCaptureDependencies["materializeEntries"];
        }
    ).materializeEntries.bind(fixture.service);
    const patch = (from: string, to: string) =>
        Buffer.from(
            `diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-${from}\n+${to}\n`,
        );
    // The second patch applies only on top of the first, so one shared file would answer "two" twice.
    const results = await materializeEntries([
        { relativePath: "a.txt", base: Buffer.from("base\n"), worktreePatch: patch("base", "one") },
        { relativePath: "a.txt", base: Buffer.from("base\n"), worktreePatch: patch("one", "two") },
    ]);
    expect(results).toEqual([Buffer.from("one\n"), undefined]);
});
