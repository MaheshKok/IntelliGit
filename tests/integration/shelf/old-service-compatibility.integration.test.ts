import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import pinned from "../../fixtures/shelf-v1/manifest.json";
import { removeScratchDirectories } from "../../helpers/scratchDirectories";

type Baseline = typeof import("../../../src/services/shelfService") &
    typeof import("../../../src/shelf/store") &
    typeof import("../../../src/shelf/paths") &
    typeof import("../../../src/git/executor") &
    typeof import("../../../src/git/repositoryMutationGate") &
    typeof import("../../../src/git/mutationCoordinator") &
    typeof import("../../../src/git/repositoryLock");

const directories: string[] = [];
afterEach(async () => {
    await Promise.all(
        directories.splice(0).map((directory) => removeScratchDirectories(directory)),
    );
});

describe("exact shipped schema-1 service adversary", () => {
    it("catalog-only upgrade lets old cached rename replace current before refusing", async () => {
        const directory = await mkdtemp(path.join(tmpdir(), "old-shelf-service-"));
        directories.push(directory);
        const fixture = new URL("../../fixtures/shelf-v1/shelfService.cjs", import.meta.url);
        const bundle = await readFile(fixture);
        expect(bundle.length).toBe(pinned.bytes);
        expect(createHash("sha256").update(bundle).digest("hex")).toBe(pinned.bundleSha256);
        const old = createRequire(import.meta.url)(fileURLToPath(fixture)) as Baseline;
        const root = path.join(directory, "repository");
        await mkdir(root);
        const env = {
            ...process.env,
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_CONFIG_SYSTEM: "/dev/null",
            GIT_AUTHOR_NAME: "Fixture",
            GIT_AUTHOR_EMAIL: "fixture@example.invalid",
            GIT_COMMITTER_NAME: "Fixture",
            GIT_COMMITTER_EMAIL: "fixture@example.invalid",
        };
        const git = (args: string[]) =>
            execFileSync("git", args, {
                cwd: root,
                env,
                encoding: "utf8",
                stdio: ["ignore", "pipe", "pipe"],
            });
        git(["init"]);
        await writeFile(path.join(root, "tracked.txt"), "base\n");
        git(["add", "tracked.txt"]);
        git(["commit", "-m", "baseline"]);
        const worktree = "base\nchange\n";
        await writeFile(path.join(root, "tracked.txt"), worktree);
        const indexBefore = await readFile(path.join(root, ".git", "index"));
        const paths = await old.resolveShelfPaths({
            repositoryRoot: root,
            globalStoragePath: path.join(directory, "storage"),
        });
        const store = new old.ShelfStore(paths);
        const service = new old.ShelfService({
            repositoryRoot: root,
            store,
            executor: new old.GitExecutor(root, undefined, env),
            gate: new old.RepositoryMutationGate(
                new old.RepositoryMutationCoordinator(),
                new old.RepositoryLock(),
            ),
        });
        const created = await service.shelve({
            name: "legacy",
            paths: ["tracked.txt"],
            silent: true,
            keepLocal: true,
        });
        expect(created.status).toBe("ok");
        const id = created.shelfId!;
        const before = await store.readCurrentShelfManifest(id);
        const catalogPath = path.join(paths.root, "catalog.json");
        const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
        catalog.schemaVersion = 2;
        await writeFile(catalogPath, JSON.stringify(catalog));

        await expect(
            service.renameShelf({
                id,
                expectedShelfGeneration: before.generation,
                name: "old cached rename",
            }),
        ).rejects.toThrow("Invalid shelf catalog.");

        const after = await store.readCurrentShelfManifest(id);
        expect(after.generation).toBeGreaterThan(before.generation);
        expect(after.metadata.name).toBe("old cached rename");
        expect(after.checksum).not.toBe(before.checksum);
        expect(await readFile(path.join(root, "tracked.txt"), "utf8")).toBe(worktree);
        expect(await readFile(path.join(root, ".git", "index"))).toEqual(indexBefore);
    });
});
