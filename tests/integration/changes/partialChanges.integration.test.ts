import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import {
    mkdtemp,
    readFile,
    readdir,
    rm,
    writeFile,
    chmod,
    symlink,
    copyFile,
    mkdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { GitExecutor } from "../../../src/git/executor";
import { PartialChanges } from "../../../src/git/partialChanges";
import { changeIds } from "../../../src/changes/selection";
import type {
    ChangeFileView,
    SelectedFileChanges,
} from "../../../src/webviews/protocol/changeSelection";
import { removeScratchDirectories } from "../../helpers/scratchDirectories";

let root: string;
let workflow: PartialChanges;
const base = Array.from({ length: 100 }, (_, index) => `line ${index}\n`).join("");
const selected = base.replace("line 20\n", "selected change\n");
const working = selected.replace("line 80\n", "other change\n");

function git(args: string[]): string {
    return execFileSync("git", args, { cwd: root, encoding: "utf8" });
}

function firstBlock(view: ChangeFileView): SelectedFileChanges {
    return {
        snapshotId: view.snapshotId,
        lineIds: changeIds(view.blocks.slice(0, 1)),
    };
}

beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "intelligit-partial-integration-"));
    git(["init", "-q"]);
    git(["config", "user.name", "Partial Tests"]);
    git(["config", "user.email", "partial@example.invalid"]);
    git(["config", "commit.gpgSign", "false"]);
    await writeFile(path.join(root, "text.txt"), base);
    await writeFile(path.join(root, "other.txt"), "base\n");
    git(["add", "--", "text.txt", "other.txt"]);
    git(["commit", "-qm", "base"]);
    await writeFile(path.join(root, "text.txt"), working);
    workflow = new PartialChanges(new GitExecutor(root), root);
});

afterEach(async () => {
    await removeScratchDirectories(root);
});

describe("partial changes on real Git", () => {
    it("retains a changed lock after an interrupted publication was reset to its original HEAD", async () => {
        const view = await workflow.open("text.txt");
        const oldHead = git(["rev-parse", "HEAD"]).trim();
        await expect(
            workflow.commit([firstBlock(view)], "published then reset", () => undefined, {
                afterPublish: async () => {
                    git(["update-ref", "HEAD", oldHead, git(["rev-parse", "HEAD"]).trim()]);
                    throw new Error("interrupted");
                },
            }),
        ).rejects.toThrow("commit succeeded");
        const lock = path.join(root, ".git/index.lock");
        await writeFile(lock, "changed foreign bytes");
        const index = await readFile(path.join(root, ".git/index"));
        expect(await workflow.recover()).toBe(false);
        expect(workflow.recoveryIssues()[0].reason).toContain("foreign lock");
        expect(await readFile(lock, "utf8")).toBe("changed foreign bytes");
        expect(await readFile(path.join(root, ".git/index"))).toEqual(index);
        expect(git(["rev-parse", "HEAD"]).trim()).toBe(oldHead);
    });
    it.each(["missing", "invalid", "oversized"] as const)(
        "reports and discards an unreadable pending record (%s) without changing Git or a foreign lock",
        async (kind) => {
            const parent = path.join(root, ".git/intelligit/partial-index");
            const id = "00000000-0000-4000-8000-000000000001";
            const directory = path.join(parent, id);
            await mkdir(directory, { recursive: true });
            if (kind !== "missing")
                await writeFile(
                    path.join(directory, "journal.json"),
                    kind === "invalid" ? "{bad json" : "x".repeat(16_385),
                );
            const head = git(["rev-parse", "HEAD"]);
            const index = await readFile(path.join(root, ".git/index"));
            const lock = path.join(root, ".git/index.lock");
            await writeFile(lock, "foreign lock");
            expect(await workflow.recover()).toBe(false);
            expect(workflow.recoveryIssues()).toEqual([
                expect.objectContaining({
                    id,
                    kind: "unreadable",
                    location: "pending",
                }),
            ]);
            await workflow.open("text.txt");
            await workflow.discardRecovery(id, "pending");
            expect(await readdir(parent)).toEqual([]);
            expect(await readFile(lock, "utf8")).toBe("foreign lock");
            expect(git(["rev-parse", "HEAD"])).toBe(head);
            expect(await readFile(path.join(root, ".git/index"))).toEqual(index);
        },
    );

    it("allows explicit disposal of an unreadable quarantined record", async () => {
        const parent = path.join(root, ".git/intelligit/partial-index-quarantine");
        const id = "00000000-0000-4000-8000-000000000002";
        await mkdir(path.join(parent, id), { recursive: true });
        expect(await workflow.recover()).toBe(false);
        expect(workflow.recoveryIssues()[0]).toMatchObject({
            kind: "unreadable",
            location: "quarantined",
        });
        await workflow.discardRecovery(id);
        expect(await readdir(parent)).toEqual([]);
    });
    it("stages one block without touching worktree, HEAD or unrelated staged content", async () => {
        await writeFile(path.join(root, "other.txt"), "user staged\n");
        git(["add", "--", "other.txt"]);
        const head = git(["rev-parse", "HEAD"]);
        const view = await workflow.open("text.txt");
        await workflow.stage(firstBlock(view), () => undefined);
        expect(git(["show", ":text.txt"])).toBe(selected);
        expect(git(["show", ":other.txt"])).toBe("user staged\n");
        expect(await readFile(path.join(root, "text.txt"), "utf8")).toBe(working);
        expect(git(["rev-parse", "HEAD"])).toBe(head);
    });

    it("unstages only a selected indexed block", async () => {
        git(["add", "--", "text.txt"]);
        const view = await workflow.open("text.txt", "index");
        await workflow.stage(firstBlock(view), () => undefined);
        expect(git(["show", ":text.txt"])).toBe(base.replace("line 80\n", "other change\n"));
        expect(await readFile(path.join(root, "text.txt"), "utf8")).toBe(working);
    });

    it("commits selected content and preserves unrelated staged and unstaged changes", async () => {
        await writeFile(path.join(root, "other.txt"), "user staged\n");
        git(["add", "--", "other.txt"]);
        const oldHead = git(["rev-parse", "HEAD"]).trim();
        const view = await workflow.open("text.txt");
        const commit = await workflow.commit([firstBlock(view)], "partial change", () => undefined);
        expect(git(["rev-parse", "HEAD"]).trim()).toBe(commit);
        expect(git(["rev-parse", "HEAD^"]).trim()).toBe(oldHead);
        expect(git(["show", "HEAD:text.txt"])).toBe(selected);
        expect(git(["show", "HEAD:other.txt"])).toBe("base\n");
        expect(git(["show", ":other.txt"])).toBe("user staged\n");
        expect(git(["show", ":text.txt"])).toBe(selected);
        expect(await readFile(path.join(root, "text.txt"), "utf8")).toBe(working);
    });

    it("retains other staged blocks in the same file after a partial commit", async () => {
        git(["add", "--", "text.txt"]);
        const view = await workflow.open("text.txt");
        await workflow.commit([firstBlock(view)], "one staged block", () => undefined);
        expect(git(["show", "HEAD:text.txt"])).toBe(selected);
        expect(git(["show", ":text.txt"])).toBe(working);
        expect(await readFile(path.join(root, "text.txt"), "utf8")).toBe(working);
    });

    it("refuses a stale worktree, index, branch and dirty native buffer", async () => {
        const view = await workflow.open("text.txt");
        const head = git(["rev-parse", "HEAD"]);
        const index = await readFile(path.join(root, ".git/index"));
        await writeFile(path.join(root, "text.txt"), working + "external\n");
        await expect(workflow.commit([firstBlock(view)], "stale", () => undefined)).rejects.toThrow(
            "changed",
        );
        expect(git(["rev-parse", "HEAD"])).toBe(head);
        expect(await readFile(path.join(root, ".git/index"))).toEqual(index);
        await writeFile(path.join(root, "text.txt"), working);
        await expect(
            workflow.stage(firstBlock(view), () => {
                throw new Error("dirty buffer");
            }),
        ).rejects.toThrow("dirty buffer");
        expect(await readFile(path.join(root, ".git/index"))).toEqual(index);
        await writeFile(path.join(root, "other.txt"), "external staged\n");
        git(["add", "--", "other.txt"]);
        await expect(workflow.stage(firstBlock(view), () => undefined)).rejects.toThrow("changed");
    });

    it("never removes another process's index lock", async () => {
        const view = await workflow.open("text.txt");
        const lock = path.join(root, ".git/index.lock");
        await writeFile(lock, "foreign owner");
        await expect(workflow.stage(firstBlock(view), () => undefined)).rejects.toThrow();
        expect(await readFile(lock, "utf8")).toBe("foreign owner");
    });

    it("runs a failing pre-commit hook without publishing HEAD or changing the real index", async () => {
        const hook = path.join(root, ".git/hooks/pre-commit");
        await writeFile(hook, "#!/bin/sh\nprintf ran > hook-ran\nexit 1\n");
        await chmod(hook, 0o755);
        const view = await workflow.open("text.txt");
        const index = await readFile(path.join(root, ".git/index"));
        const head = git(["rev-parse", "HEAD"]);
        await expect(
            workflow.commit([firstBlock(view)], "hook failure", () => undefined),
        ).rejects.toThrow();
        expect(await readFile(path.join(root, "hook-ran"), "utf8")).toBe("ran");
        expect(git(["rev-parse", "HEAD"])).toBe(head);
        expect(await readFile(path.join(root, ".git/index"))).toEqual(index);
    });

    it("preserves the original branch context for hooks while keeping real refs unchanged", async () => {
        const branch = git(["symbolic-ref", "--short", "HEAD"]).trim();
        const hook = path.join(root, ".git/hooks/pre-commit");
        await writeFile(hook, "#!/bin/sh\ngit symbolic-ref --short HEAD > hook-branch\n");
        await chmod(hook, 0o755);
        const view = await workflow.open("text.txt");
        await workflow.commit([firstBlock(view)], "branch aware", () => undefined);
        expect((await readFile(path.join(root, "hook-branch"), "utf8")).trim()).toBe(branch);
        expect(git(["symbolic-ref", "--short", "HEAD"]).trim()).toBe(branch);
    });

    it("invokes the configured signing program and retains the resulting signature object", async () => {
        const signer = path.join(root, ".git", "fixture-signer");
        await writeFile(
            signer,
            "#!/bin/sh\ncat >/dev/null\nprintf signed > signer-ran\nprintf '[GNUPG:] SIG_CREATED D 1 10 00 0 AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\\n' >&2\nprintf '%s\\n' '-----BEGIN PGP SIGNATURE-----' 'ZmFrZS1zaWduYXR1cmU=' '-----END PGP SIGNATURE-----'\n",
        );
        await chmod(signer, 0o755);
        git(["config", "gpg.program", signer]);
        git(["config", "user.signingkey", "A".repeat(40)]);
        git(["config", "commit.gpgSign", "true"]);
        const view = await workflow.open("text.txt");
        await workflow.commit([firstBlock(view)], "signed selected commit", () => undefined);
        expect(await readFile(path.join(root, "signer-ran"), "utf8")).toBe("signed");
        expect(git(["cat-file", "-p", "HEAD"])).toContain("gpgsig -----BEGIN PGP SIGNATURE-----");
        expect(git(["show", "HEAD:text.txt"])).toBe(selected);
    });

    it("does not silently disable signing when the configured signer fails", async () => {
        git(["config", "gpg.program", path.join(root, "missing-signer")]);
        git(["config", "commit.gpgSign", "true"]);
        const view = await workflow.open("text.txt");
        const head = git(["rev-parse", "HEAD"]);
        const index = await readFile(path.join(root, ".git/index"));
        await expect(
            workflow.commit([firstBlock(view)], "sign failure", () => undefined),
        ).rejects.toThrow();
        expect(git(["rev-parse", "HEAD"])).toBe(head);
        expect(await readFile(path.join(root, ".git/index"))).toEqual(index);
    });

    it("refuses a foreign replacement of its acquired index lock before publishing", async () => {
        const view = await workflow.open("text.txt");
        const head = git(["rev-parse", "HEAD"]);
        const lock = path.join(root, ".git/index.lock");
        await expect(
            workflow.commit([firstBlock(view)], "foreign lock", () => undefined, {
                afterLock: async () => {
                    await rm(lock);
                    await writeFile(lock, "replacement owner");
                },
            }),
        ).rejects.toThrow("ownership");
        expect(await readFile(lock, "utf8")).toBe("replacement owner");
        expect(git(["rev-parse", "HEAD"])).toBe(head);
    });

    it("refuses hook-added content instead of publishing an unselected change", async () => {
        const hook = path.join(root, ".git/hooks/pre-commit");
        await writeFile(hook, "#!/bin/sh\nprintf extra > other.txt\ngit add -- other.txt\n");
        await chmod(hook, 0o755);
        const view = await workflow.open("text.txt");
        const index = await readFile(path.join(root, ".git/index"));
        const head = git(["rev-parse", "HEAD"]);
        await expect(
            workflow.commit([firstBlock(view)], "hook mutation", () => undefined),
        ).rejects.toThrow("hook changed");
        expect(git(["rev-parse", "HEAD"])).toBe(head);
        expect(await readFile(path.join(root, ".git/index"))).toEqual(index);
    });

    it("recovers an index reconciliation interrupted after the ref CAS without another commit", async () => {
        const view = await workflow.open("text.txt");
        await expect(
            workflow.commit([firstBlock(view)], "recoverable", () => undefined, {
                afterPublish: async () => {
                    throw new Error("injected crash boundary");
                },
            }),
        ).rejects.toThrow("commit succeeded");
        const committed = git(["rev-parse", "HEAD"]);
        expect(git(["show", "HEAD:text.txt"])).toBe(selected);
        expect(await workflow.recover()).toBe(true);
        expect(git(["rev-parse", "HEAD"])).toBe(committed);
        expect(git(["show", ":text.txt"])).toBe(selected);
    });

    it("retains recovery evidence when an external ref advances after publication", async () => {
        const view = await workflow.open("text.txt");
        const index = await readFile(path.join(root, ".git/index"));
        await expect(
            workflow.commit([firstBlock(view)], "selected publication", () => undefined, {
                afterPublish: async () => {
                    const current = git(["rev-parse", "HEAD"]).trim();
                    const tree = git(["rev-parse", "HEAD^{tree}"]).trim();
                    const external = git([
                        "commit-tree",
                        tree,
                        "-p",
                        current,
                        "-m",
                        "external",
                    ]).trim();
                    git(["update-ref", "HEAD", external, current]);
                },
            }),
        ).rejects.toThrow("commit succeeded");
        const advanced = git(["rev-parse", "HEAD"]);
        expect(await readdir(path.join(root, ".git/intelligit/partial-index"))).toHaveLength(1);
        expect(await workflow.recover()).toBe(false);
        expect(workflow.recoveryIssues()).toEqual([
            expect.objectContaining({
                kind: "quarantined",
                reason: expect.stringContaining("will not overwrite"),
            }),
        ]);
        await expect(readFile(path.join(root, ".git/index.lock"))).rejects.toMatchObject({
            code: "ENOENT",
        });
        expect(await readdir(path.join(root, ".git/intelligit/partial-index"))).toEqual([]);
        expect(git(["rev-parse", "HEAD"])).toBe(advanced);
        expect(await readFile(path.join(root, ".git/index"))).toEqual(index);
        expect(await readFile(path.join(root, "text.txt"), "utf8")).toBe(working);
        await workflow.open("text.txt");
        git(["add", "--", "other.txt"]);
        const beforeDiscard = await readFile(path.join(root, ".git/index"));
        await workflow.discardRecovery(workflow.recoveryIssues()[0].id);
        expect(workflow.recoveryIssues()).toEqual([]);
        expect(await readFile(path.join(root, ".git/index"))).toEqual(beforeDiscard);
        expect(git(["rev-parse", "HEAD"])).toBe(advanced);
    });

    it.each(["replace", "modify"] as const)(
        "does not publish or delete a foreign lock during recovery (%s)",
        async (kind) => {
            const view = await workflow.open("text.txt");
            await expect(
                workflow.commit([firstBlock(view)], "interrupted", () => undefined, {
                    afterPublish: async () => {
                        throw new Error("crash");
                    },
                }),
            ).rejects.toThrow("commit succeeded");
            const head = git(["rev-parse", "HEAD"]);
            const index = await readFile(path.join(root, ".git/index"));
            const lock = path.join(root, ".git/index.lock");
            expect(
                await workflow.recover({
                    beforeRecoveryPublish: async () => {
                        if (kind === "replace") await rm(lock);
                        await writeFile(lock, "foreign recovery lock");
                    },
                }),
            ).toBe(false);
            expect(workflow.recoveryIssues()[0].reason).toContain("foreign lock");
            expect(await readFile(lock, "utf8")).toBe("foreign recovery lock");
            await workflow.discardRecovery(workflow.recoveryIssues()[0].id);
            expect(await readFile(lock, "utf8")).toBe("foreign recovery lock");
            expect(await readFile(path.join(root, ".git/index"))).toEqual(index);
            expect(git(["rev-parse", "HEAD"])).toBe(head);
        },
    );

    it("quarantines a refused record without blocking a later valid reconciliation", async () => {
        const view = await workflow.open("text.txt");
        await expect(
            workflow.commit([firstBlock(view)], "interrupted", () => undefined, {
                afterPublish: async () => {
                    throw new Error("crash");
                },
            }),
        ).rejects.toThrow("commit succeeded");
        const parent = path.join(root, ".git/intelligit/partial-index");
        const [id] = await readdir(parent);
        const record = JSON.parse(
            await readFile(path.join(parent, id, "journal.json"), "utf8"),
        ) as Record<string, unknown>;
        const refused = path.join(parent, "00000000-0000-0000-0000-000000000001");
        await mkdir(refused);
        await writeFile(
            path.join(refused, "journal.json"),
            JSON.stringify({ ...record, newHead: "a".repeat(40) }),
        );
        await copyFile(path.join(parent, id, "index"), path.join(refused, "index"));
        const head = git(["rev-parse", "HEAD"]);
        expect(await workflow.recover()).toBe(true);
        expect(git(["show", ":text.txt"])).toBe(selected);
        expect(git(["rev-parse", "HEAD"])).toBe(head);
        expect(workflow.recoveryIssues()).toHaveLength(1);
    });

    it("quarantines recovery after a branch change without overwriting the index", async () => {
        const view = await workflow.open("text.txt");
        await expect(
            workflow.commit([firstBlock(view)], "interrupted", () => undefined, {
                afterPublish: async () => {
                    throw new Error("crash");
                },
            }),
        ).rejects.toThrow("commit succeeded");
        const head = git(["rev-parse", "HEAD"]);
        const index = await readFile(path.join(root, ".git/index"));
        git(["branch", "new-context"]);
        git(["symbolic-ref", "HEAD", "refs/heads/new-context"]);
        expect(await workflow.recover()).toBe(false);
        expect(workflow.recoveryIssues()[0].reason).toContain("branch changed");
        expect(await readFile(path.join(root, ".git/index"))).toEqual(index);
        expect(git(["rev-parse", "HEAD"])).toBe(head);
        git(["add", "--", "other.txt"]);
    });

    it("does not overwrite an externally staged index when recovery is refused", async () => {
        const view = await workflow.open("text.txt");
        await expect(
            workflow.commit([firstBlock(view)], "interrupted", () => undefined, {
                afterPublish: async () => {
                    throw new Error("crash");
                },
            }),
        ).rejects.toThrow("commit succeeded");
        await writeFile(path.join(root, "other.txt"), "external staging\n");
        const alternate = path.join(root, ".git/external-index");
        await copyFile(path.join(root, ".git/index"), alternate);
        execFileSync("git", ["add", "--", "other.txt"], {
            cwd: root,
            env: { ...process.env, GIT_INDEX_FILE: alternate },
        });
        const foreign = await readFile(alternate);
        await writeFile(path.join(root, ".git/index"), foreign);
        const head = git(["rev-parse", "HEAD"]);
        expect(await workflow.recover()).toBe(false);
        expect(await readFile(path.join(root, ".git/index"))).toEqual(foreign);
        expect(git(["show", ":other.txt"])).toBe("external staging\n");
        expect(git(["rev-parse", "HEAD"])).toBe(head);
        await expect(readFile(path.join(root, ".git/index.lock"))).rejects.toMatchObject({
            code: "ENOENT",
        });
    });

    it("reports a live foreign owner without removing its lock or blocking snapshot reads", async () => {
        const view = await workflow.open("text.txt");
        await expect(
            workflow.commit([firstBlock(view)], "interrupted", () => undefined, {
                afterPublish: async () => {
                    throw new Error("crash");
                },
            }),
        ).rejects.toThrow("commit succeeded");
        const owner = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
            stdio: "ignore",
        });
        try {
            if (!owner.pid) throw new Error("Missing owner process");
            const parent = path.join(root, ".git/intelligit/partial-index");
            const [id] = await readdir(parent);
            const file = path.join(parent, id, "journal.json");
            const record = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
            await writeFile(file, JSON.stringify({ ...record, pid: owner.pid }));
            const lock = await readFile(path.join(root, ".git/index.lock"));
            expect(await workflow.recover()).toBe(false);
            expect(workflow.recoveryIssues()).toEqual([
                expect.objectContaining({ kind: "active" }),
            ]);
            await workflow.open("text.txt");
            expect(await readFile(path.join(root, ".git/index.lock"))).toEqual(lock);
            await expect(workflow.discardRecovery(id)).rejects.toThrow("changed");
        } finally {
            const exited = once(owner, "exit");
            owner.kill();
            await exited;
        }
        expect(await workflow.recover()).toBe(true);
    });

    it("keeps review available at the quarantine limit and resumes after explicit dismissal", async () => {
        const view = await workflow.open("text.txt");
        await expect(
            workflow.commit([firstBlock(view)], "interrupted", () => undefined, {
                afterPublish: async () => {
                    throw new Error("crash");
                },
            }),
        ).rejects.toThrow("commit succeeded");
        const parent = path.join(root, ".git/intelligit/partial-index");
        const [id] = await readdir(parent);
        const bytes = await readFile(path.join(parent, id, "journal.json"), "utf8");
        const quarantine = path.join(root, ".git/intelligit/partial-index-quarantine");
        await mkdir(quarantine);
        for (let n = 0; n < 32; n++) {
            const kept = path.join(
                quarantine,
                `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
            );
            await mkdir(kept);
            await writeFile(path.join(kept, "journal.json"), bytes);
            await copyFile(path.join(parent, id, "index"), path.join(kept, "index"));
        }
        const committed = git(["rev-parse", "HEAD"]).trim();
        const tree = git(["rev-parse", "HEAD^{tree}"]).trim();
        git([
            "update-ref",
            "HEAD",
            git(["commit-tree", tree, "-p", committed, "-m", "external"]).trim(),
            committed,
        ]);
        const head = git(["rev-parse", "HEAD"]);
        const index = await readFile(path.join(root, ".git/index"));
        expect(await workflow.recover()).toBe(false);
        expect(
            workflow.recoveryIssues().filter((issue) => issue.kind === "quarantined"),
        ).toHaveLength(32);
        expect(workflow.recoveryIssues().some((issue) => issue.kind === "blocked")).toBe(true);
        await expect(readFile(path.join(root, ".git/index.lock"))).rejects.toMatchObject({
            code: "ENOENT",
        });
        const first = workflow.recoveryIssues().find((issue) => issue.kind === "quarantined")!;
        await workflow.discardRecovery(first.id);
        expect(await workflow.recover()).toBe(false);
        expect(workflow.recoveryIssues().some((issue) => issue.kind === "blocked")).toBe(false);
        expect(await readdir(parent)).toEqual([]);
        expect(git(["rev-parse", "HEAD"])).toBe(head);
        expect(await readFile(path.join(root, ".git/index"))).toEqual(index);
    });
    it("pins blank-context formatting despite the user's suppressBlankEmpty configuration", async () => {
        const content = "one\n\nold\n\nlast\n";
        const changed = content.replace("old", "changed");
        await writeFile(path.join(root, "blank.txt"), content);
        git(["add", "--", "blank.txt"]);
        git(["commit", "-qm", "blank context"]);
        await writeFile(path.join(root, "blank.txt"), changed);
        git(["config", "diff.suppressBlankEmpty", "true"]);
        const view = await workflow.open("blank.txt");
        await workflow.stage(
            { snapshotId: view.snapshotId, lineIds: changeIds(view.blocks) },
            () => undefined,
        );
        expect(git(["show", ":blank.txt"])).toBe(changed);
        expect(git(["config", "--get", "diff.suppressBlankEmpty"]).trim()).toBe("true");
    });
    it("rejects a same-commit branch switch without changing Git", async () => {
        const view = await workflow.open("text.txt");
        const head = git(["rev-parse", "HEAD"]);
        const index = await readFile(path.join(root, ".git/index"));
        git(["switch", "-c", "other-branch"]);
        await expect(workflow.stage(firstBlock(view), () => undefined)).rejects.toThrow("changed");
        expect(git(["rev-parse", "HEAD"])).toBe(head);
        expect(await readFile(path.join(root, ".git/index"))).toEqual(index);
    });

    it.skipIf(process.platform === "win32")(
        "rejects a symlink replacement without changing Git",
        async () => {
            const fresh = await workflow.open("text.txt");
            const head = git(["rev-parse", "HEAD"]);
            const index = await readFile(path.join(root, ".git/index"));
            await rm(path.join(root, "text.txt"));
            await symlink("other.txt", path.join(root, "text.txt"));
            await expect(workflow.stage(firstBlock(fresh), () => undefined)).rejects.toThrow(
                "regular",
            );
            expect(git(["rev-parse", "HEAD"])).toBe(head);
            expect(await readFile(path.join(root, ".git/index"))).toEqual(index);
        },
    );

    it("rejects binary, symlink and active-operation partial edits", async () => {
        await writeFile(path.join(root, "text.txt"), Buffer.from([1, 0, 2]));
        await expect(workflow.open("text.txt")).rejects.toThrow("Binary");
        await writeFile(path.join(root, "text.txt"), working);
        await writeFile(path.join(root, ".git/MERGE_HEAD"), git(["rev-parse", "HEAD"]));
        await expect(workflow.open("text.txt")).rejects.toThrow("Git operation");
    });

    it("supports Git's CRLF clean conversion without rewriting worktree bytes", async () => {
        git(["config", "core.autocrlf", "true"]);
        const crlf = working.replace(/\n/g, "\r\n");
        await writeFile(path.join(root, "text.txt"), crlf);
        const view = await workflow.open("text.txt");
        await workflow.stage(firstBlock(view), () => undefined);
        expect(git(["show", ":text.txt"])).toBe(selected);
        expect(await readFile(path.join(root, "text.txt"), "utf8")).toBe(crlf);
    });

    it("commits on detached HEAD without moving the branch it was detached from", async () => {
        const branch = git(["symbolic-ref", "HEAD"]).trim();
        const original = git(["rev-parse", branch]);
        git(["checkout", "--detach", "-q"]);
        const view = await workflow.open("text.txt");
        const committed = await workflow.commit(
            [firstBlock(view)],
            "detached selection",
            () => undefined,
        );
        expect(git(["rev-parse", "HEAD"]).trim()).toBe(committed);
        expect(git(["rev-parse", branch])).toBe(original);
        expect(git(["show", "HEAD:text.txt"])).toBe(selected);
    });

    it("publishes to a linked worktree without changing the main worktree HEAD or index", async () => {
        const linked = path.join(root, "linked");
        git(["worktree", "add", "-q", "-b", "linked-branch", linked]);
        const mainHead = git(["rev-parse", "HEAD"]);
        const mainIndex = await readFile(path.join(root, ".git/index"));
        await writeFile(path.join(linked, "text.txt"), working);
        const service = new PartialChanges(new GitExecutor(linked), linked);
        const view = await service.open("text.txt");
        await service.commit([firstBlock(view)], "linked selection", () => undefined);
        const linkedContent = execFileSync("git", ["show", "HEAD:text.txt"], {
            cwd: linked,
            encoding: "utf8",
        });
        expect(linkedContent).toBe(selected);
        expect(git(["rev-parse", "HEAD"])).toBe(mainHead);
        expect(await readFile(path.join(root, ".git/index"))).toEqual(mainIndex);
        expect(await readFile(path.join(root, "text.txt"), "utf8")).toBe(working);
    });
});

it("returns to partial handling before mutation when complete ownership is not proven", async () => {
    const view = await workflow.open("text.txt");
    const head = git(["rev-parse", "HEAD"]);
    const index = await readFile(path.join(root, ".git/index"));
    expect(
        await workflow.tryCommitWholeFiles(
            ["text.txt"],
            "split owners",
            () => false,
            () => undefined,
        ),
    ).toBeUndefined();
    expect(git(["rev-parse", "HEAD"])).toBe(head);
    expect(await readFile(path.join(root, ".git/index"))).toEqual(index);
    expect(workflow.snapshot(view.snapshotId).view.snapshotId).toBe(view.snapshotId);
});

it.each([
    ["capture", "text.txt"],
    ["capture", "other.txt"],
    ["hook", "text.txt"],
    ["hook", "other.txt"],
] as const)(
    "whole-owned snapshot guard rejects a %s-time change in %s",
    async (when, changedFile) => {
        await writeFile(path.join(root, "other.txt"), "owned second file\n");
        if (when === "hook") {
            const hook = path.join(root, ".git/hooks/pre-commit");
            await writeFile(hook, "#!/bin/sh\nprintf ran > owned-hook-ran\n");
            await chmod(hook, 0o755);
        }
        const head = git(["rev-parse", "HEAD"]);
        const index = await readFile(path.join(root, ".git/index"));
        let injected = false;
        await expect(
            workflow.tryCommitWholeFiles(
                ["text.txt", "other.txt"],
                "stale whole file",
                () => true,
                async () => {
                    if (
                        !injected &&
                        (when === "capture" || (await readdir(root)).includes("owned-hook-ran"))
                    ) {
                        injected = true;
                        await writeFile(path.join(root, changedFile), "external edit\n");
                    }
                },
            ),
        ).rejects.toThrow("changed");
        expect(injected, "the whole-owned transaction reached the requested file fence").toBe(true);
        expect(git(["rev-parse", "HEAD"]), "file drift must prevent ref publication").toBe(head);
        expect(await readFile(path.join(root, ".git/index"))).toEqual(index);
        expect(await readFile(path.join(root, changedFile), "utf8")).toBe("external edit\n");
    },
);

it.each(["failure", "extra content"] as const)(
    "whole-owned commits preserve HEAD and index after hook %s",
    async (kind) => {
        const hook = path.join(root, ".git/hooks/pre-commit");
        await writeFile(
            hook,
            kind === "failure"
                ? "#!/bin/sh\nexit 1\n"
                : "#!/bin/sh\nprintf extra > other.txt\ngit add -- other.txt\n",
        );
        await chmod(hook, 0o755);
        const head = git(["rev-parse", "HEAD"]);
        const index = await readFile(path.join(root, ".git/index"));
        await expect(
            workflow.tryCommitWholeFiles(
                ["text.txt"],
                "guard hook",
                () => true,
                () => undefined,
            ),
        ).rejects.toThrow();
        expect(git(["rev-parse", "HEAD"]), "a rejected hook must not publish").toBe(head);
        expect(await readFile(path.join(root, ".git/index"))).toEqual(index);
    },
);

it("recovers whole-owned index publication without creating another commit", async () => {
    const head = git(["rev-parse", "HEAD"]).trim();
    await writeFile(path.join(root, "other.txt"), "unrelated staged\n");
    git(["add", "--", "other.txt"]);
    const unrelatedIndex = git(["ls-files", "--stage", "--", "other.txt"]);
    await expect(
        workflow.tryCommitWholeFiles(
            ["text.txt"],
            "recover whole file",
            () => true,
            () => undefined,
            {
                afterPublish: () => {
                    throw new Error("interrupted whole publication");
                },
            },
        ),
    ).rejects.toThrow("commit succeeded");
    const published = git(["rev-parse", "HEAD"]);
    expect(await workflow.recover()).toBe(true);
    expect(git(["rev-parse", "HEAD"])).toBe(published);
    expect(git(["rev-list", "--count", `${head}..HEAD`]).trim()).toBe("1");
    expect(git(["show", "HEAD:text.txt"])).toBe(working);
    expect(git(["show", ":text.txt"])).toBe(working);
    expect(git(["ls-files", "--stage", "--", "other.txt"])).toBe(unrelatedIndex);
});

describe("selected patch export", () => {
    it.each(["text.txt", "literal [é]*.txt"])(
        "exports only selected lines for %s without changing repository state",
        async (file) => {
            if (file !== "text.txt") {
                git(["mv", "text.txt", file]);
                git(["commit", "-qm", "rename"]);
            }
            await writeFile(path.join(root, file), base.replace("line 80\n", "staged other\n"));
            await writeFile(path.join(root, "other.txt"), "unrelated staged\n");
            git(["add", "--", file, "other.txt"]);
            await writeFile(path.join(root, file), working);
            const view = await workflow.open(file);
            const head = git(["rev-parse", "HEAD"]);
            const index = await readFile(path.join(root, ".git/index"));
            await mkdir(path.join(root, ".git/intelligit"), { recursive: true });
            await writeFile(path.join(root, ".git/intelligit", "metadata.json"), "preserved");
            const metadata = await readdir(path.join(root, ".git/intelligit"));
            const patch = await workflow.exportPatch(firstBlock(view), () => undefined);
            const fixture = await mkdtemp(path.join(tmpdir(), "intelligit-export-apply-"));
            try {
                execFileSync("git", ["init", "-q"], { cwd: fixture });
                await writeFile(path.join(fixture, file), base);
                execFileSync("git", ["apply", "--binary", "-"], { cwd: fixture, input: patch });
                expect(await readFile(path.join(fixture, file), "utf8")).toBe(selected);
                expect(await readdir(fixture)).toEqual(expect.arrayContaining([file, ".git"]));
                expect(patch.toString()).not.toContain("unrelated staged");
                expect(await readFile(path.join(root, ".git/index"))).toEqual(index);
                expect(await readFile(path.join(root, file), "utf8")).toBe(working);
                expect(git(["rev-parse", "HEAD"])).toBe(head);
                expect(await readdir(path.join(root, ".git/intelligit"))).toEqual(metadata);
            } finally {
                await removeScratchDirectories(fixture);
            }
        },
    );

    it.each(["validate", "exportPatch"] as const)(
        "%s rejects empty, foreign, dirty and stale selections",
        async (method) => {
            const view = await workflow.open("text.txt");
            const selection = firstBlock(view);
            const index = await readFile(path.join(root, ".git/index"));
            const head = git(["rev-parse", "HEAD"]);
            await expect(
                workflow[method]({ ...selection, lineIds: [] }, () => undefined),
            ).rejects.toThrow("Select changes first");
            await expect(
                workflow[method]({ ...selection, lineIds: ["foreign"] }, () => undefined),
            ).rejects.toThrow();
            await expect(
                workflow[method](selection, () => {
                    throw new Error("dirty buffer");
                }),
            ).rejects.toThrow("dirty buffer");
            await writeFile(path.join(root, "text.txt"), working + "external\n");
            await expect(workflow[method](selection, () => undefined)).rejects.toThrow("changed");
            expect(await readFile(path.join(root, ".git/index"))).toEqual(index);
            expect(git(["rev-parse", "HEAD"])).toBe(head);
        },
    );

    it.each([
        "worktree",
        "index",
        "ref",
        "head",
        "attributes",
        "dirty",
        "empty",
        "truncated",
    ] as const)(
        "rejects %s after patch generation and removes its private index",
        async (fault) => {
            const executor = new GitExecutor(root);
            workflow = new PartialChanges(executor, root);
            const view = await workflow.open("text.txt");
            const original = executor.runBinary.bind(executor);
            let privateIndex: string | undefined;
            let generated = false;
            vi.spyOn(executor, "runBinary").mockImplementation(async (args, options) => {
                const result = await original(args, options);
                if (args.includes("--cached") && args.includes("--binary")) {
                    generated = true;
                    privateIndex = options?.env?.GIT_INDEX_FILE;
                    if (fault === "worktree")
                        await writeFile(path.join(root, "text.txt"), working + "external\n");
                    if (fault === "index") {
                        await writeFile(path.join(root, "other.txt"), "external\n");
                        git(["add", "other.txt"]);
                    }
                    if (fault === "ref") git(["checkout", "-qb", "changed-ref"]);
                    if (fault === "head") git(["commit", "--allow-empty", "-qm", "changed head"]);
                    if (fault === "attributes")
                        await writeFile(path.join(root, ".gitattributes"), "text.txt -filter\n");
                    if (fault === "empty") return { ...result, stdout: Buffer.alloc(0) };
                    if (fault === "truncated") return { ...result, truncated: true };
                }
                return result;
            });
            try {
                await expect(
                    workflow.exportPatch(firstBlock(view), () => {
                        if (generated && fault === "dirty") throw new Error("dirty buffer");
                    }),
                ).rejects.toThrow();
                expect(generated).toBe(true);
                expect(privateIndex).toBeDefined();
                await expect(readFile(privateIndex!)).rejects.toMatchObject({ code: "ENOENT" });
            } finally {
                vi.restoreAllMocks();
            }
        },
    );
});
