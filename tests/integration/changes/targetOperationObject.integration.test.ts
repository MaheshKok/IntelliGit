import { afterEach, expect, it } from "vitest";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ChangelistPersistence } from "../../../src/changes/changelistPersistence";
import { GitExecutor } from "../../../src/git/executor";
import { captureTargetNativeEvidence } from "../../../src/git/targetOperationRecovery";
import { removeScratchDirectories } from "../../helpers/scratchDirectories";

const roots: string[] = [];
afterEach(async () => {
    await removeScratchDirectories(...roots);
});

it.each(["real", "injected-overlap"] as const)(
    "%s dependency: durably captures identical changed path bytes across fresh immutable publications",
    async (dependency) => {
        const root = await realpath(await mkdtemp(path.join(tmpdir(), "target-identical-")));
        roots.push(root);
        const git = new GitExecutor(root);
        await git.run(["init", "-q"]);
        for (const file of ["first", "second"]) await writeFile(path.join(root, file), "base\n");
        await git.run(["add", "."]);
        await git.run([
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.invalid",
            "commit",
            "-qm",
            "base",
        ]);
        const persistence = await ChangelistPersistence.open(root, path.join(root, ".git"));
        const pendingPublications: Promise<string>[] = [];
        if (dependency === "injected-overlap") {
            // Model the observed unsafe shared-object publication window; real storage still writes every object.
            const publish = persistence.storeTargetOperationObject.bind(persistence);
            const inFlight = new Set<string>();
            persistence.storeTargetOperationObject = (bytes) => {
                const key = Buffer.from(bytes).toString("hex");
                if (inFlight.has(key))
                    return Promise.reject(
                        new Error("Injected overlapping immutable-object publication window."),
                    );
                inFlight.add(key);
                const publication = (async () => {
                    try {
                        const hash = await publish(bytes);
                        await new Promise<void>((resolve) => setImmediate(resolve));
                        return hash;
                    } finally {
                        inFlight.delete(key);
                    }
                })();
                pendingPublications.push(publication);
                return publication;
            };
        }
        try {
            for (let iteration = 0; iteration < (dependency === "real" ? 12 : 1); iteration++) {
                const changed = Buffer.from([0, 255, 128, 10, iteration]);
                for (const file of ["first", "second"])
                    await writeFile(path.join(root, file), changed);
                const captured = captureTargetNativeEvidence(git, persistence, "identical-paths", [
                    "first",
                    "second",
                ]);
                await expect(
                    captured,
                    "equal-content path capture must complete without an integrity false alarm",
                ).resolves.toBeDefined();
                const evidence = await captured;
                const references = evidence.paths.map(({ state }) => {
                    if (state.kind !== "regular")
                        throw new Error("Fixture must capture regular files.");
                    return state.content;
                });
                expect(
                    references[0],
                    "identical path captures must retain the same immutable object",
                ).toEqual(references[1]);
                for (const reference of references)
                    expect(await persistence.loadTargetOperationObject(reference)).toEqual(changed);
            }
        } finally {
            await Promise.allSettled(pendingPublications);
        }
    },
);

it.each(["worktree", "index"] as const)(
    "rejects mixed %s evidence when source changes during durable object I/O",
    async (source) => {
        const root = await realpath(await mkdtemp(path.join(tmpdir(), "target-capture-race-")));
        roots.push(root);
        const git = new GitExecutor(root);
        await git.run(["init", "-q"]);
        await writeFile(path.join(root, "affected"), "base\n");
        await git.run(["add", "."]);
        await git.run([
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.invalid",
            "commit",
            "-qm",
            "base",
        ]);
        await writeFile(path.join(root, "affected"), "working\n");
        const persistence = await ChangelistPersistence.open(root, path.join(root, ".git"));
        const publish = persistence.storeTargetOperationObject.bind(persistence);
        let changed = false;
        persistence.storeTargetOperationObject = async (bytes) => {
            const result = await publish(bytes);
            if (!changed && bytes.toString() === (source === "worktree" ? "working\n" : "base\n")) {
                changed = true;
                if (source === "worktree")
                    await writeFile(path.join(root, "affected"), "external\n");
                else await git.run(["add", "affected"]);
            }
            return result;
        };
        await expect(
            captureTargetNativeEvidence(git, persistence, "capture-race", ["affected"]),
            "native capture must reject a source changed during object publication",
        ).rejects.toThrow();
        expect(
            changed,
            "the actual durable object writer must exercise the source-change seam",
        ).toBe(true);
    },
);

it("loads exact durable recovery bytes and rejects missing corrupt sized or redirected objects", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "target-object-"));
    roots.push(root);
    const gitDir = path.join(root, ".git");
    await mkdir(gitDir);
    const persistence = await ChangelistPersistence.open(root, gitDir);
    const bytes = Buffer.from([0, 255, 10, 128]);
    const hash = await persistence.storeTargetOperationObject(bytes);
    const reference = { hash, size: bytes.length };
    expect(
        typeof persistence.loadTargetOperationObject,
        "durable recovery bytes must be loadable",
    ).toBe("function");
    expect(await persistence.loadTargetOperationObject(reference)).toEqual(bytes);
    await expect(
        persistence.loadTargetOperationObject({ ...reference, size: 1 }),
    ).rejects.toThrow();
    await expect(
        persistence.loadTargetOperationObject({ ...reference, hash: "../escape" }),
    ).rejects.toThrow();
    const file = path.join(persistence.evidenceDirectory, `${hash}.bin`);
    await writeFile(file, Buffer.from([1, 255, 10, 128]));
    await expect(
        persistence.loadTargetOperationObject(reference),
        "same-size corrupt recovery bytes must be rejected",
    ).rejects.toThrow();
    await rm(file);
    await expect(persistence.loadTargetOperationObject(reference)).rejects.toThrow();
    const outside = path.join(root, "outside");
    await writeFile(outside, bytes);
    await symlink(outside, file);
    await expect(persistence.loadTargetOperationObject(reference)).rejects.toThrow();
});
