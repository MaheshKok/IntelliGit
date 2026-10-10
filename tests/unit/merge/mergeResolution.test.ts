import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, writeFile, readFile, symlink, rm, chmod, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitExecutor } from "../../../src/git/executor";
import {
    readMergeResolutionSnapshot,
    applyMergeResolution,
} from "../../../src/git/mergeResolution";
import { removeScratchDirectories } from "../../helpers/scratchDirectories";

vi.mock("vscode", () => ({ l10n: { t: (text: string) => text } }));
let root: string;
let executor: GitExecutor;
function git(...args: string[]): string {
    return execFileSync("git", args, { cwd: root, encoding: "utf8" });
}
async function conflict(name = "file.ts", base = "base\n", ours = "ours\n", theirs = "theirs\n") {
    git("init", "-b", "main");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
    git("config", "commit.gpgsign", "false");
    git("config", "core.autocrlf", "false");
    await writeFile(path.join(root, name), base);
    git("add", ".");
    git("commit", "-m", "base");
    git("checkout", "-b", "feature");
    await writeFile(path.join(root, name), theirs);
    git("commit", "-am", "theirs");
    git("checkout", "main");
    await writeFile(path.join(root, name), ours);
    git("commit", "-am", "ours");
    spawnSync("git", ["merge", "feature"], { cwd: root });
    executor = new GitExecutor(root);
}
beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "intelligit-merge-resolution-"));
});
afterEach(async () => {
    vi.restoreAllMocks();
    await removeScratchDirectories(root);
});

describe("immutable merge resolutions", () => {
    it("reads exact stages and stages a complete result", async () => {
        await conflict();
        const snapshot = await readMergeResolutionSnapshot(executor, root, "file.ts");
        expect([snapshot.base, snapshot.ours, snapshot.theirs]).toEqual([
            "base\n",
            "ours\n",
            "theirs\n",
        ]);
        await applyMergeResolution(
            executor,
            root,
            "file.ts",
            snapshot,
            "merged\n",
            () => undefined,
        );
        expect(await readFile(path.join(root, "file.ts"), "utf8")).toBe("merged\n");
        expect(git("ls-files", "-u")).toBe("");
        expect(git("show", ":file.ts")).toBe("merged\n");
    });
    it("preserves external edits and unmerged stages", async () => {
        await conflict();
        const snapshot = await readMergeResolutionSnapshot(executor, root, "file.ts");
        await writeFile(path.join(root, "file.ts"), "external\n");
        await expect(
            applyMergeResolution(executor, root, "file.ts", snapshot, "draft\n", () => undefined),
        ).rejects.toThrow("changed");
        expect(await readFile(path.join(root, "file.ts"), "utf8")).toBe("external\n");
        expect(git("ls-files", "-u")).toBe(snapshot.index.replaceAll("\0", "\n"));
    });
    it("refuses unsaved VS Code documents before writing", async () => {
        await conflict();
        const snapshot = await readMergeResolutionSnapshot(executor, root, "file.ts");
        const before = await readFile(path.join(root, "file.ts"));
        await expect(
            applyMergeResolution(executor, root, "file.ts", snapshot, "draft", async () => {
                await Promise.resolve();
                throw new Error("dirty");
            }),
        ).rejects.toThrow("dirty");
        expect(await readFile(path.join(root, "file.ts"))).toEqual(before);
    });
    it("fences changes introduced immediately before atomic replacement", async () => {
        await conflict();
        const snapshot = await readMergeResolutionSnapshot(executor, root, "file.ts");
        let calls = 0;
        const check = () => {
            calls++;
            if (calls === 3) execFileSync("git", ["add", "file.ts"], { cwd: root });
        };
        const before = await readFile(path.join(root, "file.ts"));
        await expect(
            applyMergeResolution(executor, root, "file.ts", snapshot, "draft", check),
        ).rejects.toThrow();
        expect(await readFile(path.join(root, "file.ts"))).toEqual(before);
    });
    it("refuses sessions after abort and recreation with identical stages", async () => {
        await conflict();
        const snapshot = await readMergeResolutionSnapshot(executor, root, "file.ts");
        git("merge", "--abort");
        spawnSync("git", ["merge", "feature"], { cwd: root });
        await expect(
            applyMergeResolution(executor, root, "file.ts", snapshot, "draft", () => undefined),
        ).rejects.toThrow("changed");
    });
    it.each([
        "<<<<<<< ours\nx",
        ">>>>>>> theirs\nx",
        "<<<<<<<\nx",
        ">>>>>>>\nx",
        "<<<<<<< ours\r\nx",
        ">>>>>>> theirs\r\nx",
        "<<<<<<<\r\nx",
        ">>>>>>>\r\nx",
        "bad\0text",
    ])("refuses markers or NUL: %s", async (content) => {
        await conflict();
        const snapshot = await readMergeResolutionSnapshot(executor, root, "file.ts");
        await expect(
            applyMergeResolution(executor, root, "file.ts", snapshot, content, () => undefined),
        ).rejects.toThrow();
        expect(git("ls-files", "-u")).not.toBe("");
    });
    it.each([
        "Install\n=======\n",
        "Title\r\n=======\r\n",
        "|||||||\n",
        "||||||| base\r\n",
        "<<<<<<<identifier\n>>>>>>>identifier\n",
    ])("accepts ordinary text that resembles partial markers: %s", async (content) => {
        await conflict();
        const snapshot = await readMergeResolutionSnapshot(executor, root, "file.ts");
        await applyMergeResolution(executor, root, "file.ts", snapshot, content, () => undefined);
        expect(await readFile(path.join(root, "file.ts"), "utf8")).toBe(content);
        expect(git("show", ":file.ts")).toBe(content);
        expect(git("ls-files", "-u")).toBe("");
    });
    it("uses literal pathspecs for magic filenames without touching neighboring files", async () => {
        const name = process.platform === "win32" ? "[glob].ts" : ":(glob)*.ts";
        await conflict(name);
        const neighbor = process.platform === "win32" ? "g.ts" : "neighbor.ts";
        await writeFile(path.join(root, neighbor), "private\n");
        const snapshot = await readMergeResolutionSnapshot(executor, root, name);
        await applyMergeResolution(executor, root, name, snapshot, "resolved\n", () => undefined);
        expect(git("--literal-pathspecs", "show", `:${name}`)).toBe("resolved\n");
        expect(git("ls-files", "--", neighbor)).toBe("");
    });
    it("refuses a symlink substituted for the worktree file", async () => {
        await conflict();
        const snapshot = await readMergeResolutionSnapshot(executor, root, "file.ts");
        await writeFile(path.join(root, "other"), "protected");
        await rm(path.join(root, "file.ts"));
        await symlink("other", path.join(root, "file.ts"));
        await expect(
            applyMergeResolution(executor, root, "file.ts", snapshot, "draft", () => undefined),
        ).rejects.toThrow("regular");
        expect(await readFile(path.join(root, "other"), "utf8")).toBe("protected");
    });
    it("preserves executable permissions and CRLF bytes", async () => {
        await conflict();
        await chmod(path.join(root, "file.ts"), 0o755);
        const mode = (await stat(path.join(root, "file.ts"))).mode & 0o777;
        if (process.platform !== "win32") expect(mode).toBe(0o755);
        const snapshot = await readMergeResolutionSnapshot(executor, root, "file.ts");
        await applyMergeResolution(
            executor,
            root,
            "file.ts",
            snapshot,
            "a\r\nb\r\n",
            () => undefined,
        );
        expect((await stat(path.join(root, "file.ts"))).mode & 0o777).toBe(mode);
        expect(await readFile(path.join(root, "file.ts"), "utf8")).toBe("a\r\nb\r\n");
    });
    it("refuses deleted-side conflicts instead of confusing deletion with an empty blob", async () => {
        await conflict();
        git("merge", "--abort");
        git("checkout", "feature");
        git("rm", "file.ts");
        git("commit", "-m", "delete");
        git("checkout", "main");
        spawnSync("git", ["merge", "feature"], { cwd: root });
        await expect(readMergeResolutionSnapshot(executor, root, "file.ts")).rejects.toThrow(
            "deleted-side",
        );
    });
    it("supports add/add with a missing base", async () => {
        await conflict();
        const entries = git("ls-files", "-u")
            .trim()
            .split("\n")
            .filter((line) => !line.includes(" 1\t"));
        spawnSync("git", ["update-index", "--index-info"], {
            cwd: root,
            input: "0 " + "0".repeat(40) + "\tfile.ts\n" + entries.join("\n") + "\n",
        });
        const snapshot = await readMergeResolutionSnapshot(executor, root, "file.ts");
        expect(snapshot.base).toBe("");
        await applyMergeResolution(
            executor,
            root,
            "file.ts",
            snapshot,
            "combined\n",
            () => undefined,
        );
        expect(git("show", ":file.ts")).toBe("combined\n");
    });
    it("retains a saved result and unmerged stages when staging fails", async () => {
        await conflict();
        const snapshot = await readMergeResolutionSnapshot(executor, root, "file.ts");
        await writeFile(path.join(root, ".git/index.lock"), "lock");
        const runBinary = vi.spyOn(GitExecutor.prototype, "runBinary");
        const error: unknown = await applyMergeResolution(
            executor,
            root,
            "file.ts",
            snapshot,
            "resolved\n",
            () => undefined,
        ).catch((failure: unknown) => failure);
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain("staging failed");
        expect((error as Error).cause).toBeInstanceOf(Error);
        expect(((error as Error).cause as Error).message).toContain("index.lock");
        expect(
            runBinary.mock.calls.filter(([args]) => args[1] === "add").map(([args]) => args),
        ).toEqual([["--literal-pathspecs", "add", "--", "file.ts"]]);
        expect(await readFile(path.join(root, ".git/index.lock"), "utf8")).toBe("lock");
        expect(await readFile(path.join(root, "file.ts"), "utf8")).toBe("resolved\n");
        expect(git("ls-files", "-u")).not.toBe("");
    });
    it("refuses binary worktree text and oversized output before writing", async () => {
        await conflict();
        const snapshot = await readMergeResolutionSnapshot(executor, root, "file.ts");
        const before = await readFile(path.join(root, "file.ts"));
        await expect(
            applyMergeResolution(
                executor,
                root,
                "file.ts",
                snapshot,
                "x".repeat(2 * 1024 * 1024 + 1),
                () => undefined,
            ),
        ).rejects.toThrow("size");
        expect(await readFile(path.join(root, "file.ts"))).toEqual(before);
        await writeFile(path.join(root, "file.ts"), Buffer.from([0xff, 0]));
        await expect(readMergeResolutionSnapshot(executor, root, "file.ts")).rejects.toThrow(
            "Binary",
        );
    });
    it("supports add/add with a missing base through exact stage reads", async () => {
        await conflict();
        const entries = git("ls-files", "-u")
            .trim()
            .split("\n")
            .filter((line) => !line.includes(" 1\t"));
        spawnSync("git", ["update-index", "--index-info"], {
            cwd: root,
            input: "0 " + "0".repeat(40) + "\tfile.ts\n" + entries.join("\n") + "\n",
        });
        const snapshot = await readMergeResolutionSnapshot(executor, root, "file.ts");
        expect(snapshot.base).toBe("");
        await applyMergeResolution(
            executor,
            root,
            "file.ts",
            snapshot,
            "combined\n",
            () => undefined,
        );
        expect(git("show", ":file.ts")).toBe("combined\n");
    });
});
