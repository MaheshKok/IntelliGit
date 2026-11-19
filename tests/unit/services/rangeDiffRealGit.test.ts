/**
 * "Changed since last green" opens each side of a file through the real GitOps reader. The
 * mocked reader in diffService.test.ts cannot see that reader rejecting or rewriting a name Git
 * itself listed, so this file runs against a real repository.
 */
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { removeScratchDirectories } from "../../helpers/scratchDirectories";

const mocks = vi.hoisted(() => ({
    executeCommand: vi.fn(),
}));

vi.mock("vscode", () => ({
    Uri: {
        from: (components: { scheme: string; path: string; query?: string }) => components,
        file: (fsPath: string) => ({ fsPath, scheme: "file", path: fsPath }),
    },
    env: { language: "en" },
    l10n: { t: (text: string) => text },
    commands: { executeCommand: mocks.executeCommand },
    window: {},
    workspace: {
        registerTextDocumentContentProvider: vi.fn(),
        onDidCloseTextDocument: vi.fn(),
    },
}));

import { GitExecutor } from "../../../src/git/executor";
import { GitOps } from "../../../src/git/operations";
import { openRevisionRangeFileDiff } from "../../../src/services/diffService";

let root: string;

function git(...args: string[]): string {
    return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "intelligit-range-reader-"));
    git("init", "-q", "-b", "main");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
    git("config", "commit.gpgsign", "false");
});

afterEach(async () => {
    await removeScratchDirectories(root);
});

// A name Git listed is data: a line break, edge spaces and a backslash are all legal on POSIX.
const itPosix = process.platform === "win32" ? it.skip : it;

describe("openRevisionRangeFileDiff with the real Git content reader", () => {
    itPosix.each([
        ["a line break", "with\nnewline.txt"],
        ["a leading space", " lead.txt"],
        ["a trailing space", "trail.txt "],
        ["a backslash", "back\\slash.txt"],
        ["an ordinary name", "plain.txt"],
    ])("opens both revisions of a Git-listed file with %s", async (_what, file) => {
        await writeFile(path.join(root, file), "one\n");
        git("add", "-A");
        git("commit", "-q", "-m", "one");
        const first = git("rev-parse", "HEAD");
        await writeFile(path.join(root, file), "two\n");
        git("add", "-A");
        git("commit", "-q", "-m", "two");
        const second = git("rev-parse", "HEAD");
        const ops = new GitOps(new GitExecutor(root));
        const read = vi.spyOn(ops, "getFileContentAtRef");

        await openRevisionRangeFileDiff(first, second, { path: file, status: "M" }, ops);

        expect(await Promise.all(read.mock.results.map((result) => result.value))).toEqual([
            "one\n",
            "two\n",
        ]);
    });

    it.each([
        ["a NUL byte", "bad\0name"],
        ["an absolute path", "/etc/passwd"],
        ["a path that leaves the repository", "dir/../../outside.txt"],
    ])("the listed-name reader still refuses %s", async (_what, file) => {
        const ops = new GitOps(new GitExecutor(root));

        await expect(ops.getFileContentAtRef(file, "HEAD", { listedName: true })).rejects.toThrow(
            /Rejected/,
        );
    });
});
