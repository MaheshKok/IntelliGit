import { randomUUID } from "node:crypto";
import { readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ChangelistPersistence } from "../../../src/changes/changelistPersistence";
import { GitExecutor } from "../../../src/git/executor";
import { RepositoryMutationCoordinator } from "../../../src/git/mutationCoordinator";
import { RepositoryLock } from "../../../src/git/repositoryLock";
import { RepositoryMutationGate } from "../../../src/git/repositoryMutationGate";
import { ShelfService } from "../../../src/services/shelfService";
import { connectedChangelists } from "../../helpers/connectedChangelists";
import { cleanTemporaryRepositories, createShelfFixture } from "./shelfTestHarness";

/**
 * Each restored file's safety re-reads still need their own Git processes, but no more than this.
 * It stays at 40: the remaining cost was cut per process (spawning the real Git binary instead of
 * the macOS xcrun shim), not by count. Reading the initial snapshots for all files at once would
 * save about 10 more per file, but needs a multi-file snapshot reader that isolates each file's
 * failure, and was left for later.
 */
const MAX_GIT_PROCESSES_PER_FILE = 40;

afterEach(async () => {
    vi.restoreAllMocks();
    await cleanTemporaryRepositories();
});

/**
 * Silently shelves changed files and returns what restoring them all to the active list needs.
 * `staged` files are shelved with their change staged, so an exact-state restore changes the index.
 */
async function shelvedFiles(
    files: number | string[],
    {
        staged = [],
        mode = "flattened",
        initial = {},
        incoming = {},
    }: {
        staged?: string[];
        mode?: "flattened" | "exactState";
        initial?: Record<string, string>;
        incoming?: Record<string, string>;
    } = {},
) {
    const names =
        typeof files === "number"
            ? Array.from({ length: files }, (_, index) => `file-${index}.txt`)
            : files;
    const raw = await createShelfFixture({
        initialFiles: Object.fromEntries(names.map((name) => [name, initial[name] ?? "base\n"])),
    });
    const root = await realpath(raw.root);
    const changelists = await connectedChangelists(root);
    const service = new ShelfService({
        repositoryRoot: root,
        executor: raw.executor,
        store: raw.store,
        changelists,
        gate: new RepositoryMutationGate(new RepositoryMutationCoordinator(), new RepositoryLock()),
    });
    for (const name of names)
        await writeFile(path.join(root, name), incoming[name] ?? "incoming\n");
    if (staged.length) await raw.executor.run(["add", "--", ...staged]);
    const saved = await service.shelve({ name: "S", paths: names, silent: true, keepLocal: false });
    const shelf = await raw.store.readCurrentShelfManifest(saved.shelfId!);
    const restore = () =>
        service.unshelve({
            id: saved.shelfId!,
            mode,
            removeFromShelf: true,
            expectedShelfGeneration: shelf.generation,
            targetOperation: {
                id: randomUUID(),
                root,
                target: {
                    kind: "existing",
                    id: changelists.get(root).activeId,
                    revision: changelists.revision(root),
                },
                sourceChecksum: shelf.checksum,
            },
        });
    return { names, root, executor: raw.executor, restore };
}

/** Restores `files` shelved files and counts the restore's Git commands. */
async function restoreCommands(files: number): Promise<number> {
    const { names, root, restore } = await shelvedFiles(files);
    const run = vi.spyOn(GitExecutor.prototype, "run");
    const binary = vi.spyOn(GitExecutor.prototype, "runBinary");
    const result = await restore();
    const commands = run.mock.calls.length + binary.mock.calls.length;
    run.mockRestore();
    binary.mockRestore();
    expect(result.status).toBe("applied");
    for (const name of names)
        expect(await readFile(path.join(root, name), "utf8"), name).toBe("incoming\n");
    return commands;
}

/** Restores `files` shelved files and counts the Git processes the restore starts. */
async function restoreProcesses(files: number): Promise<number> {
    const { restore } = await shelvedFiles(files);
    // `run` starts its process through `runBinary`, so counting `runBinary` alone counts each once.
    const binary = vi.spyOn(GitExecutor.prototype, "runBinary");
    const result = await restore();
    const processes = binary.mock.calls.length;
    binary.mockRestore();
    expect(result.status).toBe("applied");
    return processes;
}

/** Restores `files` shelved files and counts how many saved evidence files the restore reads back. */
async function restoreEvidenceReads(files: number): Promise<number> {
    const { restore } = await shelvedFiles(files);
    const reads = vi.spyOn(
        ChangelistPersistence.prototype as unknown as {
            readImmutableBytesWithIdentity(file: string): Promise<unknown>;
        },
        "readImmutableBytesWithIdentity",
    );
    const result = await restore();
    const count = reads.mock.calls.length;
    reads.mockRestore();
    expect(result.status).toBe("applied");
    return count;
}

// Saving each step re-read and re-hashed every earlier step's saved evidence, which kept a
// 20-file restore near 40 s; each further file must add a fixed number of evidence reads.
it("each further restored file reads back the same amount of saved evidence", async () => {
    const two = await restoreEvidenceReads(2);
    const four = await restoreEvidenceReads(4);
    const six = await restoreEvidenceReads(6);
    expect(six - four, `Evidence reads: 2 files ${two}, 4 files ${four}, 6 files ${six}`).toBe(
        four - two,
    );
}, 120_000);

// A 20-file restore in a 1000-file repository took over two minutes when every step re-checked
// and re-snapshotted every file restored before it; each further file must add a fixed cost.
it("each further restored file costs the same Git work however many files came before it", async () => {
    const two = await restoreCommands(2);
    const four = await restoreCommands(4);
    const six = await restoreCommands(6);
    expect(six - four, `Git commands: 2 files ${two}, 4 files ${four}, 6 files ${six}`).toBe(
        four - two,
    );
}, 120_000);

// Each Git process costs ~15 ms to start on macOS, and a restore once started ~77 of them per file,
// so a 20-file restore took 25 s; each further file must start far fewer.
it("each further restored file starts at most a fixed number of Git processes", async () => {
    const two = await restoreProcesses(2);
    const six = await restoreProcesses(6);
    expect((six - two) / 4, `Git processes: 2 files ${two}, 6 files ${six}`).toBeLessThanOrEqual(
        MAX_GIT_PROCESSES_PER_FILE,
    );
}, 120_000);

// Every saved state re-validated each earlier restore's receipt with its own Git object-format
// lookup, so restores slowed down for as long as the repository kept being used.
it("a restore costs the same Git work however many restores came before it", async () => {
    const raw = await createShelfFixture({
        initialFiles: { "a.txt": "base\n", "b.txt": "base\n" },
    });
    const root = await realpath(raw.root);
    const changelists = await connectedChangelists(root);
    const service = new ShelfService({
        repositoryRoot: root,
        executor: raw.executor,
        store: raw.store,
        changelists,
        gate: new RepositoryMutationGate(new RepositoryMutationCoordinator(), new RepositoryLock()),
    });
    const counts: number[] = [];
    for (let round = 0; round < 3; round++) {
        for (const name of ["a.txt", "b.txt"])
            await writeFile(path.join(root, name), `incoming ${round}\n`);
        const saved = await service.shelve({
            name: `S${round}`,
            paths: ["a.txt", "b.txt"],
            silent: true,
            keepLocal: false,
        });
        const shelf = await raw.store.readCurrentShelfManifest(saved.shelfId!);
        const run = vi.spyOn(GitExecutor.prototype, "run");
        const binary = vi.spyOn(GitExecutor.prototype, "runBinary");
        const result = await service.unshelve({
            id: saved.shelfId!,
            mode: "flattened",
            removeFromShelf: true,
            expectedShelfGeneration: shelf.generation,
            targetOperation: {
                id: randomUUID(),
                root,
                target: {
                    kind: "existing",
                    id: changelists.get(root).activeId,
                    revision: changelists.revision(root),
                },
                sourceChecksum: shelf.checksum,
            },
        });
        counts.push(run.mock.calls.length + binary.mock.calls.length);
        run.mockRestore();
        binary.mockRestore();
        expect(result.status).toBe("applied");
    }
    expect(counts[2], `Git commands per restore, oldest first: ${counts.join(", ")}`).toBe(
        counts[1],
    );
}, 120_000);

// Each step re-reads only its own files, so an edit to a file an earlier step restored is left to
// the full check after the last step, which must still refuse to record the restore as clean.
it("an outside edit to an already restored file during a later step stops the restore for review", async () => {
    const { names, root, executor, restore } = await shelvedFiles(2);
    const binary = executor.runBinary.bind(executor);
    let applies = 0;
    vi.spyOn(executor, "runBinary").mockImplementation(async (args, options) => {
        if (JSON.stringify(args) === JSON.stringify(["apply", "-"]) && ++applies === 2)
            await writeFile(path.join(root, names[0]!), "outside edit\n");
        return binary(args, options);
    });
    const result = await restore();
    expect(applies, "both files must reach Git apply").toBe(2);
    expect(result.status, "an outside edit mid-restore must stop the restore for review").toBe(
        "appliedNeedsReview",
    );
    expect(await readFile(path.join(root, names[0]!), "utf8")).toBe("outside edit\n");
});

// A step that changes the index re-reads every file, so it must also compare the files it did not
// restore with the saved record, or an outside edit to an earlier file is recorded as restored.
it("an outside edit to an earlier file before a step that changes the index stops the restore for review", async () => {
    const { names, root, executor, restore } = await shelvedFiles(2, {
        staged: ["file-1.txt"],
        mode: "exactState",
    });
    const binary = executor.runBinary.bind(executor);
    let edited = false;
    vi.spyOn(executor, "runBinary").mockImplementation(async (args, options) => {
        if (
            args[0] === "apply" &&
            !args.includes("--check") &&
            !edited &&
            (await readFile(path.join(root, names[0]!), "utf8")) === "incoming\n"
        ) {
            edited = true;
            await writeFile(path.join(root, names[0]!), "outside edit\n");
        }
        return binary(args, options);
    });
    const result = await restore();
    expect(edited, "the first file must be restored before a later Git apply").toBe(true);
    expect(result.status, "an outside edit mid-restore must stop the restore for review").toBe(
        "appliedNeedsReview",
    );
    expect(await readFile(path.join(root, names[0]!), "utf8")).toBe("outside edit\n");
});

// Each step checks its own files before Git writes them, so an outside edit that the shelved
// change would merge into silently is never recorded as restored.
it("an outside edit to a file before its own step stops the restore for review", async () => {
    const lines = Array.from({ length: 12 }, (_, index) => `line-${index}\n`).join("");
    const outside = lines.replace("line-11\n", "outside edit\n");
    const { names, root, executor, restore } = await shelvedFiles(2, {
        initial: { "file-1.txt": lines },
        incoming: { "file-1.txt": lines.replace("line-0\n", "incoming\n") },
    });
    const binary = executor.runBinary.bind(executor);
    let edited = false;
    vi.spyOn(executor, "runBinary").mockImplementation(async (args, options) => {
        const result = await binary(args, options);
        if (
            args[0] === "apply" &&
            !args.includes("--check") &&
            !edited &&
            (await readFile(path.join(root, names[0]!), "utf8")) === "incoming\n"
        ) {
            edited = true;
            await writeFile(path.join(root, names[1]!), outside);
        }
        return result;
    });
    const result = await restore();
    expect(edited, "the first file must be restored before the second").toBe(true);
    expect(result.status, "an outside edit before its step must stop the restore for review").toBe(
        "appliedNeedsReview",
    );
    expect(await readFile(path.join(root, names[1]!), "utf8")).toBe(outside);
});

it("an exact-state restore keeps a staged change staged", async () => {
    const { root, executor, restore } = await shelvedFiles(2, {
        staged: ["file-1.txt"],
        mode: "exactState",
    });
    const result = await restore();
    expect(result.status).toBe("applied");
    expect((await executor.run(["diff", "--cached", "--name-only"])).trim()).toBe("file-1.txt");
    for (const name of ["file-0.txt", "file-1.txt"])
        expect(await readFile(path.join(root, name), "utf8"), name).toBe("incoming\n");
});

// Attribution depends on Git attributes, so a step that restores a `.gitattributes` file must
// re-check earlier files instead of keeping what they were checked under the old attributes.
it("restoring a .gitattributes file re-checks files restored before it", async () => {
    const { names, root, executor, restore } = await shelvedFiles(["-a.txt", ".gitattributes"], {
        incoming: { ".gitattributes": "*.txt filter=unknown-driver\n" },
    });
    const binary = executor.runBinary.bind(executor);
    const order: string[] = [];
    vi.spyOn(executor, "runBinary").mockImplementation(async (args, options) => {
        const result = await binary(args, options);
        if (args[0] === "apply" && !args.includes("--check"))
            for (const name of names)
                if (
                    !order.includes(name) &&
                    (await readFile(path.join(root, name), "utf8")) !== "base\n"
                )
                    order.push(name);
        return result;
    });
    const result = await restore();
    expect(order, "the text file must be restored before the attributes file").toEqual(names);
    expect(
        result.status,
        "a file now under an unknown filter cannot keep its earlier attribution",
    ).toBe("appliedNeedsReview");
});
