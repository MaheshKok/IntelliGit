import { mkdir, mkdtemp, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GitExecutor } from "../../../src/git/executor";
import { GitOps } from "../../../src/git/operations";
import { removeScratchDirectories } from "../../helpers/scratchDirectories";

const roots: string[] = [];

afterEach(async () => {
    await removeScratchDirectories(...roots.splice(0));
});

async function createRepository(): Promise<{ root: string; git: GitExecutor }> {
    const root = await mkdtemp(path.join(tmpdir(), "intelligit-commit-rename-"));
    roots.push(root);
    const git = new GitExecutor(root);
    await git.run(["init", "-q"]);
    await git.run(["config", "user.name", "Fixture"]);
    await git.run(["config", "user.email", "fixture@example.invalid"]);
    return { root, git };
}

async function head(git: GitExecutor): Promise<string> {
    return (await git.run(["rev-parse", "HEAD"])).trim();
}

describe("commit detail rename detection", () => {
    it("reports a pure rename as one renamed file with unchanged line counts", async () => {
        const { root, git } = await createRepository();
        await mkdir(path.join(root, "src"), { recursive: true });
        const content = Array.from({ length: 12 }, (_, index) => `line ${index}`).join("\n");
        await writeFile(path.join(root, "src", "old-name.ts"), `${content}\n`);
        await git.run(["add", "."]);
        await git.run(["commit", "-qm", "base"]);

        await rename(path.join(root, "src", "old-name.ts"), path.join(root, "src", "new-name.ts"));
        await git.run(["add", "-A"]);
        await git.run(["commit", "-qm", "pure rename"]);

        const detail = await new GitOps(git).getCommitDetail(await head(git));

        expect(detail.files).toEqual([
            {
                path: "src/new-name.ts",
                oldPath: "src/old-name.ts",
                status: "R",
                additions: 0,
                deletions: 0,
            },
        ]);
    });

    it("keeps a rename with an edit as one renamed file carrying the edit's line counts", async () => {
        const { root, git } = await createRepository();
        await mkdir(path.join(root, "src"), { recursive: true });
        const content = Array.from({ length: 20 }, (_, index) => `line ${index}`).join("\n");
        await writeFile(path.join(root, "src", "old-name.ts"), `${content}\n`);
        await git.run(["add", "."]);
        await git.run(["commit", "-qm", "base"]);

        await rename(path.join(root, "src", "old-name.ts"), path.join(root, "src", "new-name.ts"));
        await writeFile(path.join(root, "src", "new-name.ts"), `${content}\nadded line\n`);
        await git.run(["add", "-A"]);
        await git.run(["commit", "-qm", "rename and edit"]);

        const detail = await new GitOps(git).getCommitDetail(await head(git));

        expect(detail.files).toEqual([
            {
                path: "src/new-name.ts",
                oldPath: "src/old-name.ts",
                status: "R",
                additions: 1,
                deletions: 0,
            },
        ]);
    });

    it("keeps an ordinary modification as one modified file", async () => {
        const { root, git } = await createRepository();
        await writeFile(path.join(root, "plain.txt"), "before\n");
        await git.run(["add", "."]);
        await git.run(["commit", "-qm", "base"]);

        await writeFile(path.join(root, "plain.txt"), "after\n");
        await git.run(["commit", "-qam", "edit"]);

        const detail = await new GitOps(git).getCommitDetail(await head(git));

        expect(detail.files).toEqual([
            { path: "plain.txt", status: "M", additions: 1, deletions: 1 },
        ]);
    });
});
