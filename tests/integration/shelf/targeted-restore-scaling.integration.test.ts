import { randomUUID } from "node:crypto";
import { readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { GitExecutor } from "../../../src/git/executor";
import { RepositoryMutationCoordinator } from "../../../src/git/mutationCoordinator";
import { RepositoryLock } from "../../../src/git/repositoryLock";
import { RepositoryMutationGate } from "../../../src/git/repositoryMutationGate";
import { ShelfService } from "../../../src/services/shelfService";
import { connectedChangelists } from "../../helpers/connectedChangelists";
import { cleanTemporaryRepositories, createShelfFixture } from "./shelfTestHarness";

afterEach(async () => {
    vi.restoreAllMocks();
    await cleanTemporaryRepositories();
});

/** Silently shelves `files` changed files, restores them all to the active list, and counts the restore's Git commands. */
async function restoreCommands(files: number): Promise<number> {
    const names = Array.from({ length: files }, (_, index) => `file-${index}.txt`);
    const raw = await createShelfFixture({
        initialFiles: Object.fromEntries(names.map((name) => [name, "base\n"])),
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
    for (const name of names) await writeFile(path.join(root, name), "incoming\n");
    const saved = await service.shelve({ name: "S", paths: names, silent: true, keepLocal: false });
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
    const commands = run.mock.calls.length + binary.mock.calls.length;
    run.mockRestore();
    binary.mockRestore();
    expect(result.status).toBe("applied");
    for (const name of names)
        expect(await readFile(path.join(root, name), "utf8"), name).toBe("incoming\n");
    return commands;
}

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
