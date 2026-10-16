import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fork } from "node:child_process";
import * as fs from "node:fs/promises";
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { build } from "esbuild";
import { ChangelistStore } from "../../../src/changes/changelistStore";
import { ChangelistPersistence } from "../../../src/changes/changelistPersistence";
import { RepositoryLock } from "../../../src/git/repositoryLock";
import { removeScratchDirectories } from "../../helpers/scratchDirectories";
import {
    attachAfterChangelistLoad,
    changelistDraftBridge,
} from "../../../src/views/changelistDraftBridge";

let root: string;
let gitDir: string;
beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "intelligit-changelist-storage-"));
    gitDir = path.join(root, ".git");
    await mkdir(gitDir);
});
afterEach(async () => {
    vi.restoreAllMocks();
    await removeScratchDirectories(root);
});

function storage() {
    const values = new Map<string, unknown>();
    return {
        values,
        get: <T>(key: string) => values.get(key) as T | undefined,
        update: async (key: string, value: unknown) => {
            values.set(key, structuredClone(value));
        },
    };
}

describe("authoritative worktree changelist persistence", () => {
    it("retries a brief cross-window lease without losing the draft", async () => {
        const first = new ChangelistStore();
        const second = new ChangelistStore();
        await first.connect(root, gitDir);
        await second.connect(root, gitDir);
        const release = await first.beginCommit(root);
        const acquire = RepositoryLock.prototype.acquire;
        let attempted!: () => void;
        const firstAttempt = new Promise<void>((resolve) => {
            attempted = resolve;
        });
        vi.spyOn(RepositoryLock.prototype, "acquire").mockImplementationOnce(async function (
            this: RepositoryLock,
            directory,
        ) {
            try {
                return await acquire.call(this, directory);
            } finally {
                attempted();
            }
        });
        const saved = second
            .saveDraft(root, "all", "", "Concurrent draft")
            .catch((error: unknown) => error);
        await firstAttempt;
        await release();
        expect(await saved).not.toBeInstanceOf(Error);
        expect(first.draft(root, "all")).toBe("Concurrent draft");
    });

    it.each(["writeFile", "sync"] as const)(
        "leaves no published migration backup after an interrupted %s and permits retry",
        async (operation) => {
            const persistence = await ChangelistPersistence.open(root, gitDir);
            const value = { root, legacy: undefined, state: new ChangelistStore().get(root) };
            const probe = await fs.open(path.join(root, "probe"), "w");
            await probe.close();
            vi.spyOn(
                Object.getPrototypeOf(probe) as fs.FileHandle,
                operation,
            ).mockRejectedValueOnce(new Error("interrupted backup write"));
            await expect(persistence.backup(value)).rejects.toThrow("interrupted backup write");
            const filename = path.join(persistence.directory, "migration.json");
            await expect(readFile(filename)).rejects.toMatchObject({ code: "ENOENT" });
            await persistence.backup(value);
            expect(JSON.parse(await readFile(filename, "utf8"))).toEqual({
                root,
                state: value.state,
            });
        },
    );

    it("hydrates native SCM from disk before attaching after a workspace reload", async () => {
        const legacy = storage();
        const first = new ChangelistStore(legacy);
        await first.saveDraft(root, "all", undefined, "Migration-time draft");
        await first.connect(root, gitDir);
        await first.saveDraft(root, "all", "Migration-time draft", "Current durable draft");
        const reloaded = { ...legacy, keys: () => [...legacy.values.keys()] };
        const bridge = changelistDraftBridge(reloaded, () => undefined);
        let attached = false;
        await new Promise<void>((resolve) => {
            attachAfterChangelistLoad(
                reloaded,
                root,
                async () => ({ gitDir }),
                () => {
                    attached = true;
                    resolve();
                },
            );
            expect(attached).toBe(false);
        });
        expect(bridge.readDraft(root)).toBe("Current durable draft");
        const loaded = ChangelistStore.forStorage(reloaded);
        await loaded.saveDraft(root, "all", "Current durable draft", "Native follow-up");
        expect(first.draft(root, "all")).toBe("Native follow-up");
    });

    it("preserves conflicting workspace migrations without choosing a winner silently", async () => {
        const first = new ChangelistStore(storage());
        await first.create(root, 0, "First workspace");
        await first.connect(root, gitDir);
        const second = new ChangelistStore(storage());
        await second.create(root, 0, "Other workspace");
        await expect(second.connect(root, gitDir)).rejects.toThrow("Conflicting");
        expect(first.get(root).lists[1].name).toBe("First workspace");
        const directory = path.join(gitDir, "intelligit/changelists");
        const conflict = (await readdir(directory)).find((name) =>
            name.startsWith("migration-conflict-"),
        );
        expect(conflict).toBeDefined();
        expect(
            JSON.parse(await readFile(path.join(directory, conflict!), "utf8")).state.lists[1].name,
        ).toBe("Other workspace");
    });

    it.each([false, true])(
        "refuses another root's conflicting migration after connecting the first root (reload=%s)",
        async (reload) => {
            const otherRoot = path.join(root, "other");
            const otherGitDir = path.join(otherRoot, ".git");
            await mkdir(otherGitDir, { recursive: true });
            const first = new ChangelistStore(storage());
            await first.create(otherRoot, 0, "Durable owner");
            await first.connect(otherRoot, otherGitDir);
            const legacy = storage();
            const second = new ChangelistStore(legacy);
            await second.create(root, 0, "First repository");
            await second.create(otherRoot, 0, "Unmigrated workspace owner");
            await second.connect(root, gitDir);
            const migrating = reload ? new ChangelistStore(legacy) : second;
            await expect(
                migrating.connect(otherRoot, otherGitDir),
                "connecting one root must not authorize a conflicting migration in another",
            ).rejects.toThrow("Conflicting");
            expect(first.get(otherRoot).lists[1].name).toBe("Durable owner");
        },
    );

    it("accepts current durable drafts when this root's original migration seed matches", async () => {
        const legacy = storage();
        const first = new ChangelistStore(legacy);
        await first.saveDraft(root, "all", undefined, "Migration draft");
        await first.connect(root, gitDir);
        await first.saveDraft(root, "all", "Migration draft", "Current durable draft");
        const reloaded = new ChangelistStore(legacy);
        await expect(
            reloaded.connect(root, gitDir),
            "a proven migrated seed must allow later authoritative edits",
        ).resolves.toBeUndefined();
        expect(reloaded.draft(root, "all")).toBe("Current durable draft");
    });

    it("reloads a fresh workspace that adopted another workspace's durable metadata", async () => {
        const first = new ChangelistStore(storage());
        await first.saveDraft(root, "all", undefined, "Original migration draft");
        await first.connect(root, gitDir);
        const freshWorkspace = storage();
        const second = new ChangelistStore(freshWorkspace);
        await second.connect(root, gitDir);
        expect(second.draft(root, "all")).toBe("Original migration draft");
        await first.saveDraft(root, "all", "Original migration draft", "Later durable draft");
        const reloaded = new ChangelistStore(freshWorkspace);
        await expect(
            reloaded.connect(root, gitDir),
            "a workspace without legacy intent must remain connected after reload",
        ).resolves.toBeUndefined();
        expect(reloaded.draft(root, "all")).toBe("Later durable draft");
    });

    it.each(["missing", "corrupt", "other-root"] as const)(
        "refuses divergent migration intent when its proof is %s without changing either source",
        async (proof) => {
            const legacy = storage();
            const first = new ChangelistStore(legacy);
            await first.saveDraft(root, "all", undefined, "Migration draft");
            await first.connect(root, gitDir);
            await first.saveDraft(root, "all", "Migration draft", "Current durable draft");
            const directory = path.join(gitDir, "intelligit/changelists");
            const filename = path.join(directory, "migration.json");
            if (proof === "missing") await rm(filename);
            else if (proof === "corrupt") await writeFile(filename, "{interrupted");
            else {
                const backup = JSON.parse(await readFile(filename, "utf8"));
                backup.root = path.join(root, "other");
                await writeFile(filename, JSON.stringify(backup));
            }
            const workspaceBefore = structuredClone(legacy.get("intelligit.changelists.v1"));
            const durableBefore = await readFile(path.join(directory, "state.json"), "utf8");
            await expect(new ChangelistStore(legacy).connect(root, gitDir)).rejects.toThrow();
            expect(legacy.get("intelligit.changelists.v1")).toEqual(workspaceBefore);
            expect(await readFile(path.join(directory, "state.json"), "utf8")).toBe(durableBefore);
        },
    );

    it("refuses an interrupted corrupt backup and a missing authoritative record", async () => {
        const directory = path.join(gitDir, "intelligit/changelists");
        await mkdir(directory, { recursive: true });
        await writeFile(path.join(directory, "migration.json"), "{interrupted");
        const first = new ChangelistStore();
        await expect(first.connect(root, gitDir)).rejects.toThrow();
        expect(await readFile(path.join(directory, "migration.json"), "utf8")).toBe("{interrupted");
        await rm(path.join(directory, "migration.json"));
        await first.connect(root, gitDir);
        await rm(path.join(directory, "state.json"));
        await expect(first.create(root, 0, "Recover from cache")).rejects.toThrow("disappeared");
        expect(() => first.get(root)).toThrow("disappeared");
    });

    it("migrates once with a recoverable copy, a downgrade sentinel, stable IDs and explicit emptiness", async () => {
        const legacy = storage();
        const store = new ChangelistStore(legacy);
        let state = await store.create(root, 0, "Feature", "context", true);
        state = await store.saveDraft(root, state.activeId, "", "draft");
        state = await store.recordSelection(root, "file.txt", "content", "all", [], 4);
        const old = structuredClone(legacy.get("intelligit.changelists.v1"));
        await store.connect(root, gitDir);
        expect(legacy.get("intelligit.changelists.v1")).toMatchObject({ schemaVersion: 3 });
        const backupPath = path.join(gitDir, "intelligit/changelists/migration.json");
        const backup = await readFile(backupPath, "utf8");
        expect(JSON.parse(backup).legacy).toEqual(old);
        const fresh = new ChangelistStore(legacy);
        await fresh.connect(root, gitDir);
        expect(fresh.get(root)).toEqual(state);
        expect(await readFile(backupPath, "utf8")).toBe(backup);
        const disconnected = new ChangelistStore(legacy);
        await expect(
            disconnected.create(root, state.revision, "unsafe downgrade writer"),
        ).rejects.toThrow("connected worktree");
    });

    it("makes independent windows observe the winning revision and reject stale ownership changes", async () => {
        const first = new ChangelistStore(storage());
        const second = new ChangelistStore(storage());
        await first.connect(root, gitDir);
        await second.connect(root, gitDir);
        const winner = await first.create(root, 0, "Winner");
        expect(second.get(root)).toEqual(winner);
        await expect(second.create(root, 0, "Stale")).rejects.toThrow("changed");
        const next = await second.saveDraft(root, winner.lists[1].id, "", "second window");
        expect(first.get(root)).toEqual(next);
    });

    it("keeps a cross-window metadata lease for the entire selected commit", async () => {
        const first = new ChangelistStore();
        const second = new ChangelistStore();
        await first.connect(root, gitDir);
        await second.connect(root, gitDir);
        const release = await first.beginCommit(root);
        try {
            await expect(second.create(root, 0, "Concurrent")).rejects.toThrow("in progress");
            await first.prepareCommitInclusion(root, 0, "all", [
                { path: "one.txt", contentId: "snapshot", lineIds: ["0:1"], total: 2 },
            ]);
            expect(second.get(root).changes["one.txt"].selections?.all.lineIds).toEqual(["0:1"]);
        } finally {
            await release();
        }
        await expect(
            second.create(root, second.get(root).revision, "After commit"),
        ).resolves.toMatchObject({ revision: 2 });
    });

    it("preserves corrupt authoritative bytes and refuses writes or migration fallback", async () => {
        const store = new ChangelistStore(storage());
        await store.connect(root, gitDir);
        const filename = path.join(gitDir, "intelligit/changelists/state.json");
        await writeFile(filename, "{broken state");
        expect(() => store.get(root)).toThrow();
        await expect(store.create(root, 0, "Overwrite")).rejects.toThrow();
        expect(await readFile(filename, "utf8")).toBe("{broken state");
        await expect(new ChangelistStore().connect(root, gitDir)).rejects.toThrow();
    });

    it("refuses copied metadata from a different canonical worktree", async () => {
        const first = new ChangelistStore();
        await first.connect(root, gitDir);
        await first.create(root, 0, "Only first");
        const other = path.join(root, "linked");
        await mkdir(other);
        await expect(new ChangelistStore().connect(other, gitDir)).rejects.toThrow(
            "requires review",
        );
        const ownGit = path.join(gitDir, "worktrees/linked");
        await mkdir(ownGit, { recursive: true });
        const second = new ChangelistStore();
        await second.connect(other, ownGit);
        expect(second.get(other).lists).toHaveLength(1);
        expect(first.get(root).lists).toHaveLength(2);
    });

    it("leaves the last good record intact when a new record exceeds the storage budget", async () => {
        const store = new ChangelistStore();
        await store.connect(root, gitDir);
        const persistence = await ChangelistPersistence.open(root, gitDir);
        const before = await readFile(persistence.filename, "utf8");
        await expect(
            persistence.write({ ...store.get(root), allDraft: "x".repeat(64 * 1024 * 1024) }),
        ).rejects.toThrow("storage budget");
        expect(await readFile(persistence.filename, "utf8")).toBe(before);
    });

    it("admits only one of two simultaneous real processes at the same revision", async () => {
        const compiled = path.join(root, "store.cjs");
        await build({
            entryPoints: [path.resolve("src/changes/changelistStore.ts")],
            bundle: true,
            platform: "node",
            format: "cjs",
            outfile: compiled,
            logLevel: "silent",
        });
        const worker = path.join(root, "worker.cjs");
        await writeFile(
            worker,
            `const { ChangelistStore } = require('./store.cjs');
const store = new ChangelistStore();
(async () => {
 await store.connect(process.argv[2], process.argv[3]);
 process.send({ ready: true });
 process.once('message', async () => {
  try { const state = await store.create(process.argv[2], 0, process.argv[4]); process.send({ accepted: true, state }); }
  catch (error) { process.send({ accepted: false, error: error.message }); }
  process.disconnect();
 });
})().catch(error => { console.error(error); process.exitCode = 1; process.disconnect(); });`,
        );
        const initial = new ChangelistStore();
        await initial.connect(root, gitDir);
        const children: ReturnType<typeof fork>[] = [];
        try {
            for (const name of ["A", "B"]) {
                const child = fork(worker, [root, gitDir, name], {
                    stdio: ["ignore", "pipe", "pipe", "ipc"],
                });
                children.push(child);
                await new Promise<void>((resolve, reject) => {
                    let errors = "";
                    child.stderr?.on("data", (chunk) => {
                        errors += String(chunk);
                    });
                    child.once("message", () => resolve());
                    child.on("exit", (code) => {
                        if (code) reject(new Error(`worker exited ${code}: ${errors}`));
                    });
                });
            }
            const results = children.map(
                (child) =>
                    new Promise<{ accepted: boolean }>((resolve) => child.once("message", resolve)),
            );
            for (const child of children) child.send("go");
            const settled = await Promise.all(results);
            expect(settled.filter((result) => result.accepted)).toHaveLength(1);
            expect(initial.get(root).lists).toHaveLength(2);
            expect(initial.get(root).revision).toBe(1);
        } finally {
            for (const child of children) child.kill();
        }
    });
});
