import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { build } from "esbuild";
import { mkdtemp, readFile, readdir, writeFile, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { GitExecutor } from "../../../src/git/executor";
import { PartialChanges } from "../../../src/git/partialChanges";
import { changeIds } from "../../../src/changes/selection";
import { removeScratchDirectories } from "../../helpers/scratchDirectories";

let root: string;
let partial: PartialChanges;
const base = Array.from({ length: 100 }, (_, i) => `line ${i}\n`).join("");
const selected = base.replace("line 20\n", "selected change\n");
const remainder = base.replace("line 80\n", "retained change\n");
const working = selected.replace("line 80\n", "retained change\n");
const git = (args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
const selection = async () => {
    const view = await partial.open("text.txt");
    return { snapshotId: view.snapshotId, lineIds: changeIds(view.blocks.slice(0, 1)) };
};

beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "intelligit-partial-operations-"));
    git(["init", "-q"]);
    git(["config", "user.name", "Selected Operations"]);
    git(["config", "user.email", "selected@example.invalid"]);
    git(["config", "commit.gpgSign", "false"]);
    git(["config", "core.hooksPath", path.join(root, ".git/hooks")]);
    await writeFile(path.join(root, "text.txt"), base);
    await writeFile(path.join(root, "other.txt"), "base\n");
    git(["add", "."]);
    git(["commit", "-qm", "original"]);
    await writeFile(path.join(root, "other.txt"), "unrelated staged\n");
    git(["add", "other.txt"]);
    await writeFile(path.join(root, "text.txt"), working);
    partial = new PartialChanges(new GitExecutor(root), root);
});
afterEach(async () => removeScratchDirectories(root));

describe("selected operations on real Git", () => {
    it("exports an applicable patch containing only the chosen block without changing Git state", async () => {
        const before = await readFile(path.join(root, ".git/index"));
        const head = git(["rev-parse", "HEAD"]);
        const patch = await partial.exportPatch(await selection(), () => undefined);
        expect(patch.toString()).toContain("selected change");
        expect(patch.toString()).not.toContain("retained change");
        expect(patch.toString()).toContain("a/text.txt");
        expect(git(["rev-parse", "HEAD"])).toBe(head);
        expect(await readFile(path.join(root, ".git/index"))).toEqual(before);
        expect(await readFile(path.join(root, "text.txt"), "utf8")).toBe(working);
    });

    it.each(["color.ui", "color.diff"])(
        "exports an applicable uncolored selection when %s is always",
        async (setting) => {
            git(["config", setting, "always"]);
            const patch = await partial.exportPatch(await selection(), () => undefined);
            expect(patch.includes(0x1b)).toBe(false);
            execFileSync("git", ["apply", "--reverse", "--check", "-"], {
                cwd: root,
                input: patch,
            });
            expect(await readFile(path.join(root, "text.txt"), "utf8")).toBe(working);
        },
    );

    it.each(["unstaged", "fully staged", "split staging"] as const)(
        "rolls back one block with %s while preserving the other block and unrelated staging",
        async (mode) => {
            if (mode === "fully staged") git(["add", "text.txt"]);
            if (mode === "split staging") {
                await writeFile(path.join(root, "text.txt"), remainder);
                git(["add", "text.txt"]);
                await writeFile(path.join(root, "text.txt"), working);
            }
            const head = git(["rev-parse", "HEAD"]);
            await partial.rollback(await selection(), () => undefined);
            expect(await readFile(path.join(root, "text.txt"), "utf8")).toBe(remainder);
            expect(git(["show", ":text.txt"])).toBe(mode === "unstaged" ? base : remainder);
            expect(git(["show", ":other.txt"])).toBe("unrelated staged\n");
            expect(git(["rev-parse", "HEAD"])).toBe(head);
        },
    );

    it("refuses differing staged text rather than overwriting it", async () => {
        await writeFile(
            path.join(root, "text.txt"),
            base.replace("line 20\n", "different staged\n"),
        );
        git(["add", "text.txt"]);
        await writeFile(path.join(root, "text.txt"), working);
        const index = await readFile(path.join(root, ".git/index"));
        await expect(partial.rollback(await selection(), () => undefined)).rejects.toThrow(
            "overlap",
        );
        expect(await readFile(path.join(root, "text.txt"), "utf8")).toBe(working);
        expect(await readFile(path.join(root, ".git/index"))).toEqual(index);
    });

    it("preserves foreign locks and dirty native buffers before any destructive write", async () => {
        const chosen = await selection();
        await expect(
            partial.rollback(chosen, () => {
                throw new Error("dirty buffer");
            }),
        ).rejects.toThrow("dirty buffer");
        await writeFile(path.join(root, ".git/index.lock"), "foreign");
        await expect(partial.rollback(chosen, () => undefined)).rejects.toThrow();
        expect(await readFile(path.join(root, ".git/index.lock"), "utf8")).toBe("foreign");
        expect(await readFile(path.join(root, "text.txt"), "utf8")).toBe(working);
    });

    it("releases only its owned lock when a buffer becomes dirty before the file replacement", async () => {
        const chosen = await selection();
        const snapshot = partial.snapshot(chosen.snapshotId);
        const index = await readFile(path.join(root, ".git/index"));
        const failure = new Error("native buffer became dirty before replacement");
        let afterLock = false;
        let guarded = 0;
        await expect(
            partial.rollback(
                chosen,
                () => {
                    if (afterLock && ++guarded === 3) throw failure;
                },
                {
                    afterLock: async () => {
                        afterLock = true;
                    },
                },
            ),
        ).rejects.toBe(failure);
        expect(await readFile(path.join(root, "text.txt"), "utf8")).toBe(working);
        expect(await readFile(path.join(root, ".git/index"))).toEqual(index);
        await expect(readFile(path.join(root, ".git/index.lock"))).rejects.toMatchObject({
            code: "ENOENT",
        });
        expect(await readdir(path.join(root, ".git/intelligit/partial-index"))).toEqual([]);
        expect(await partial.canRestoreInclusion(snapshot)).toBe(true);
    });

    it("retains a modified lock refused at the final pre-replacement check", async () => {
        const chosen = await selection();
        const index = await readFile(path.join(root, ".git/index"));
        const lock = path.join(root, ".git/index.lock");
        let afterLock = false;
        let guarded = 0;
        await expect(
            partial.rollback(
                chosen,
                async () => {
                    if (afterLock && ++guarded === 3)
                        await writeFile(lock, "externally modified lock");
                },
                {
                    afterLock: async () => {
                        afterLock = true;
                    },
                },
            ),
        ).rejects.toThrow();
        expect(await readFile(lock, "utf8")).toBe("externally modified lock");
        expect(await readFile(path.join(root, "text.txt"), "utf8")).toBe(working);
        expect(await readFile(path.join(root, ".git/index"))).toEqual(index);
        expect(await readdir(path.join(root, ".git/intelligit/partial-index"))).toHaveLength(1);
    });

    it("recovers index reconciliation after the worktree transition without repeating the rollback", async () => {
        git(["add", "text.txt"]);
        await expect(
            partial.rollback(await selection(), () => undefined, {
                afterWorktreePublish: async () => {
                    throw new Error("interrupted");
                },
            }),
        ).rejects.toThrow("recovery");
        expect(await readFile(path.join(root, "text.txt"), "utf8")).toBe(remainder);
        expect(await partial.recover()).toBe(true);
        expect(git(["show", ":text.txt"])).toBe(remainder);
        expect(git(["show", ":other.txt"])).toBe("unrelated staged\n");
        expect(await readdir(path.join(root, ".git/intelligit/partial-index"))).toEqual([]);
    });

    it("quarantines interrupted rollback if an external editor changes the resulting bytes", async () => {
        await expect(
            partial.rollback(await selection(), () => undefined, {
                afterWorktreePublish: async () => {
                    throw new Error("interrupted");
                },
            }),
        ).rejects.toThrow("recovery");
        await writeFile(path.join(root, "text.txt"), "external edit\n");
        const index = await readFile(path.join(root, ".git/index"));
        await partial.recover();
        expect(partial.recoveryIssues().some((issue) => issue.kind === "quarantined")).toBe(true);
        expect(await readFile(path.join(root, "text.txt"), "utf8")).toBe("external edit\n");
        expect(await readFile(path.join(root, ".git/index"))).toEqual(index);
    });

    it("does not replace an external index changed at the final recovery boundary", async () => {
        git(["add", "text.txt"]);
        await expect(
            partial.rollback(await selection(), () => undefined, {
                afterWorktreePublish: async () => {
                    throw new Error("interrupted");
                },
            }),
        ).rejects.toThrow("recovery");
        const index = path.join(root, ".git/index");
        const external = path.join(root, ".git/external-index");
        await copyFile(index, external);
        const oid = execFileSync("git", ["hash-object", "-w", "--stdin"], {
            cwd: root,
            encoding: "utf8",
            input: "external staged\n",
        }).trim();
        execFileSync("git", ["update-index", "--add", "--cacheinfo", "100644", oid, "other.txt"], {
            cwd: root,
            env: { ...process.env, GIT_INDEX_FILE: external },
        });
        const expected = await readFile(external);
        await partial.recover({ beforeRecoveryPublish: () => copyFile(external, index) });
        expect(await readFile(index)).toEqual(expected);
        expect(git(["show", ":other.txt"])).toBe("external staged\n");
        expect(partial.recoveryIssues().some((issue) => issue.kind === "quarantined")).toBe(true);
        expect(await readFile(path.join(root, "text.txt"), "utf8")).toBe(remainder);
    });

    it("preserves Git-compatible CRLF bytes in the unselected remainder", async () => {
        await writeFile(path.join(root, ".gitattributes"), "text.txt text eol=crlf\n");
        git(["add", ".gitattributes"]);
        git(["commit", "-qm", "CRLF policy", "--only", ".gitattributes"]);
        await writeFile(path.join(root, "text.txt"), working.replaceAll("\n", "\r\n"));
        await partial.rollback(await selection(), () => undefined);
        expect(await readFile(path.join(root, "text.txt"))).toEqual(
            Buffer.from(remainder.replaceAll("\n", "\r\n")),
        );
    });

    it("retains a corrupt worktree backup for review without guessing a recovery write", async () => {
        await expect(
            partial.rollback(await selection(), () => undefined, {
                afterWorktreePublish: async () => {
                    throw new Error("interrupted");
                },
            }),
        ).rejects.toThrow("recovery");
        const parent = path.join(root, ".git/intelligit/partial-index");
        const [id] = await readdir(parent);
        await writeFile(path.join(parent, id, "worktree-before"), "corrupt");
        const index = await readFile(path.join(root, ".git/index"));
        await partial.recover();
        expect(partial.recoveryIssues()[0]).toMatchObject({ kind: "quarantined" });
        expect(await readFile(path.join(root, ".git/index"))).toEqual(index);
        expect(await readFile(path.join(root, "text.txt"), "utf8")).toBe(remainder);
    });

    it("recovers after a real process is killed at the durable worktree boundary", async () => {
        git(["add", "text.txt"]);
        const worker = path.join(root, ".git", "selected-crash.cjs");
        await build({
            stdin: {
                contents: `
                    import { PartialChanges } from ${JSON.stringify(path.resolve(__dirname, "../../../src/git/partialChanges.ts"))};
                    import { GitExecutor } from ${JSON.stringify(path.resolve(__dirname, "../../../src/git/executor.ts"))};
                    import { changeIds } from ${JSON.stringify(path.resolve(__dirname, "../../../src/changes/selection.ts"))};
                    void (async () => {
                        const root = process.argv[2];
                        const partial = new PartialChanges(new GitExecutor(root), root);
                        const file = await partial.open("text.txt");
                        await partial.rollback({ snapshotId: file.snapshotId, lineIds: changeIds(file.blocks.slice(0, 1)) }, () => undefined, {
                            afterWorktreePublish: async () => {
                                process.stdout.write("worktree-published\\n");
                                setInterval(() => {}, 1000);
                                await new Promise(() => {});
                            },
                        });
                    })().catch((error) => { console.error(error); process.exit(1); });`,
                resolveDir: path.resolve(__dirname, "../../.."),
                loader: "ts",
            },
            bundle: true,
            platform: "node",
            format: "cjs",
            outfile: worker,
        });
        const child = spawn(process.execPath, [worker, root], {
            stdio: ["ignore", "pipe", "pipe"],
        });
        let stderr = "";
        let stdout = "";
        child.stderr.on("data", (bytes) => {
            stderr = (stderr + bytes.toString()).slice(-16_384);
        });
        try {
            await new Promise<void>((resolve, reject) => {
                const timeout = setTimeout(
                    () => reject(new Error(`Crash checkpoint unavailable: ${stderr}`)),
                    10_000,
                );
                child.stdout.on("data", (bytes) => {
                    stdout = (stdout + bytes.toString()).slice(-16_384);
                    if (stdout.includes("worktree-published")) {
                        clearTimeout(timeout);
                        resolve();
                    }
                });
                child.once("error", (error) => {
                    clearTimeout(timeout);
                    reject(error);
                });
                child.once("exit", () => {
                    clearTimeout(timeout);
                    reject(new Error(`Worker exited before checkpoint: ${stderr}`));
                });
            });
            const exited = once(child, "exit");
            child.kill("SIGKILL");
            await exited;
            expect(await readFile(path.join(root, "text.txt"), "utf8")).toBe(remainder);
            expect(await partial.recover()).toBe(true);
            expect(git(["show", ":text.txt"])).toBe(remainder);
            expect(git(["show", ":other.txt"])).toBe("unrelated staged\n");
        } finally {
            if (child.exitCode === null && child.signalCode === null) {
                const exited = once(child, "exit");
                child.kill("SIGKILL");
                await exited;
            }
        }
    });

    it("runs branch-aware hooks on amend and refuses hook tree changes before publication", async () => {
        git(["branch", "-M", "owned/amend-branch"]);
        const head = git(["rev-parse", "HEAD"]);
        await writeFile(
            path.join(root, ".git/hooks/pre-commit"),
            '#!/bin/sh\ntest "$(git symbolic-ref --short HEAD)" = "owned/amend-branch" || exit 19\nprintf \'hook change\\n\' > text.txt\ngit add -- text.txt\n',
            { mode: 0o755 },
        );
        await expect(
            partial.commit(
                [await selection()],
                "hook refusal",
                () => undefined,
                {},
                { amend: true },
            ),
        ).rejects.toThrow("hook changed");
        expect(git(["rev-parse", "HEAD"])).toBe(head);
        expect(git(["show", ":other.txt"])).toBe("unrelated staged\n");
        // The hook's own worktree write is deliberately not rolled back.
        expect(await readFile(path.join(root, "text.txt"), "utf8")).toBe("hook change\n");
    });

    it("refuses a non-UTF-8 message configuration before publishing an amend", async () => {
        git(["config", "i18n.commitEncoding", "ISO-8859-1"]);
        const head = git(["rev-parse", "HEAD"]);
        const index = await readFile(path.join(root, ".git/index"));
        await expect(
            partial.commit(
                [await selection()],
                "Selected amend",
                () => undefined,
                {},
                { amend: true },
            ),
        ).rejects.toThrow("Non-UTF-8 commit-message");
        expect(git(["rev-parse", "HEAD"])).toBe(head);
        expect(await readFile(path.join(root, ".git/index"))).toEqual(index);
        expect(await readFile(path.join(root, "text.txt"), "utf8")).toBe(working);
    });

    it.each([false, true])(
        "amends only selected text and preserves the original parent list (nonRoot=%s)",
        async (nonRoot) => {
            if (nonRoot) git(["commit", "--allow-empty", "-qm", "second"]);
            const parents = git(["show", "-s", "--format=%P", "HEAD"]);
            const author = git(["show", "-s", "--format=%an <%ae> %aI", "HEAD"]);
            const oldHead = git(["rev-parse", "HEAD"]).trim();
            const commit = await partial.commit(
                [await selection()],
                "amended selection",
                () => undefined,
                {},
                { amend: true },
            );
            expect(commit).not.toBe(oldHead);
            expect(git(["show", "-s", "--format=%P", "HEAD"])).toBe(parents);
            expect(git(["show", "-s", "--format=%an <%ae> %aI", "HEAD"])).toBe(author);
            expect(git(["show", "HEAD:text.txt"])).toBe(selected);
            expect(git(["show", "HEAD:other.txt"])).toBe(nonRoot ? "unrelated staged\n" : "base\n");
            expect(await readFile(path.join(root, "text.txt"), "utf8")).toBe(working);
        },
    );
});
