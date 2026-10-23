import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { GitExecutor } from "../../../src/git/executor";
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
    const original = GitExecutor.prototype.runBinary;
    // Refuse any apply check whose patch carries the bad file, as Git does for a hunk that misses.
    vi.spyOn(GitExecutor.prototype, "runBinary").mockImplementation(function (
        this: GitExecutor,
        args,
        options,
    ) {
        if (
            args.includes("apply") &&
            args.includes("--check") &&
            Buffer.isBuffer(options?.input) &&
            options.input.includes(`b/${bad}`)
        )
            return Promise.resolve({
                stdout: Buffer.alloc(0),
                stderr: Buffer.from(`error: patch failed: ${bad}:1\n`),
                exitCode: 1,
                truncated: false,
            });
        return original.call(this, args, options);
    });
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
