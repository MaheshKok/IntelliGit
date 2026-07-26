import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { GitExecutor } from "../../../src/git/executor";
import { RepositoryMutationCoordinator } from "../../../src/git/mutationCoordinator";
import { RepositoryLock } from "../../../src/git/repositoryLock";
import { RepositoryMutationGate } from "../../../src/git/repositoryMutationGate";
import { resolveShelfPaths } from "../../../src/shelf/paths";
import { ShelfStore } from "../../../src/shelf/store";
import { ShelfService } from "../../../src/services/shelfService";

const execFileAsync = promisify(execFile);
const directories: string[] = [];

afterEach(async () => {
    await Promise.all(
        directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
    );
});

async function git(repositoryRoot: string, args: string[]): Promise<void> {
    await execFileAsync("git", args, {
        cwd: repositoryRoot,
        env: {
            ...process.env,
            GIT_AUTHOR_NAME: "Test",
            GIT_AUTHOR_EMAIL: "test@example.invalid",
            GIT_COMMITTER_NAME: "Test",
            GIT_COMMITTER_EMAIL: "test@example.invalid",
        },
    });
}

describe("ShelfService Unicode filenames", () => {
    it("shelves, reverts, and flattened-unshelves a supplementary Unicode filename", async () => {
        const root = await mkdtemp(path.join(tmpdir(), "intelligit-shelf-unicode-"));
        directories.push(root);
        const relativePath = "emoji-😀.txt";
        const target = path.join(root, relativePath);
        await git(root, ["init"]);
        await writeFile(target, "base\n");
        await git(root, ["add", "--", relativePath]);
        await git(root, ["commit", "-m", "unicode base"]);
        const store = new ShelfStore(
            await resolveShelfPaths({
                repositoryRoot: root,
                globalStoragePath: path.join(root, "shelf-storage"),
            }),
        );
        const gate = new RepositoryMutationGate(
            new RepositoryMutationCoordinator(),
            new RepositoryLock(),
        );
        const service = new ShelfService({
            repositoryRoot: root,
            executor: new GitExecutor(root),
            store,
            gate,
        });
        await writeFile(target, "modified\n");

        const shelf = await service.shelve({
            name: "unicode",
            paths: [relativePath],
            silent: true,
            keepLocal: false,
        });

        await expect(readFile(target, "utf8")).resolves.toBe("base\n");
        await expect(
            service.unshelve({ id: shelf.shelfId!, removeFromShelf: false, mode: "flattened" }),
        ).resolves.toMatchObject({ status: "ok", entries: [{ kind: "applied" }] });
        await expect(readFile(target, "utf8")).resolves.toBe("modified\n");
    });
});
