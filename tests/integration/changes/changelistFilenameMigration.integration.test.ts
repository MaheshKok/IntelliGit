import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ChangelistStore } from "../../../src/changes/changelistStore";
import { changeFingerprint as hash, parseChangeDiff } from "../../../src/changes/parseDiff";
import { rangeSnapshot } from "../../../src/changes/rangeMapping";
import { removeScratchDirectories } from "../../helpers/scratchDirectories";

let root: string;
let gitDir: string;
beforeEach(async () => {
    root = await realpath(await mkdtemp(path.join(tmpdir(), "intelligit-filename-migration-")));
    gitDir = path.join(root, ".git");
    await mkdir(gitDir);
});
afterEach(async () => {
    await removeScratchDirectories(root);
});

/** A valid Git filename must keep split ownership, explicit emptiness and history through conversion. */
function legacyState() {
    const base = "base\n";
    const working = "base\naddition\n";
    const blocks = parseChangeDiff("@@ -1,0 +2,1 @@\n+addition\n", base, working);
    const contentId = hash(working);
    const snapshot = rangeSnapshot({
        root,
        gitDir,
        commonDir: gitDir,
        indexPath: path.join(gitDir, "index"),
        head: "a".repeat(40),
        ref: "refs/heads/main",
        indexHash: hash(base),
        worktreeHash: hash(working),
        attributes: "",
        mode: "100644",
        indexed: base,
        working,
        contentId,
        view: { snapshotId: contentId, path: "__proto__", side: "working", base, blocks },
    });
    const state = new ChangelistStore().get(root);
    const owner = "00000000-0000-4000-8000-000000000001";
    state.lists.push({ id: owner, name: "Other", description: "", draft: "List draft" });
    const lines = { [snapshot.anchors[0].fingerprint]: owner };
    return {
        ...state,
        files: { ["__proto__"]: "default" },
        changes: {
            ["__proto__"]: {
                contentId,
                totalChanges: 1,
                lines,
                tracking: snapshot,
                history: [{ snapshot, lines }],
                selections: { all: { contentId, lineIds: [], total: 1 } },
            },
        },
    };
}

it.each(["disk", "workspace"])(
    "preserves special filenames during %s migration",
    async (source) => {
        const legacy = legacyState();
        const values = new Map<string, unknown>();
        const storage = {
            get: <T>(key: string) => values.get(key) as T | undefined,
            update: async (key: string, value: unknown) => {
                values.set(key, structuredClone(value));
            },
        };
        if (source === "disk") {
            const directory = path.join(gitDir, "intelligit", "changelists");
            await mkdir(directory, { recursive: true });
            await writeFile(
                path.join(directory, "state.json"),
                JSON.stringify({
                    schemaVersion: 3,
                    root,
                    gitDir,
                    state: legacy,
                }),
            );
        } else {
            values.set("intelligit.changelists.v1", {
                schemaVersion: 2,
                entries: [{ root, state: legacy }],
            });
        }
        const store = new ChangelistStore(storage);
        if (source === "workspace") {
            await store.saveDraft(root, "all", "", "Preserve filenames");
            const saved = storage.get<{ entries: { state: typeof legacy }[] }>(
                "intelligit.changelists.v1",
            )!;
            expect(
                Object.hasOwn(saved.entries[0].state.changes, "__proto__"),
                "workspace serialization must retain the own filename entry",
            ).toBe(true);
            expect(saved.entries[0].state.changes["__proto__"]).toEqual(
                legacy.changes["__proto__"],
            );
        }
        await store.connect(root, gitDir);
        const migrated = store.get(root);
        expect(
            Object.hasOwn(migrated.changes, "__proto__"),
            "durable conversion must retain the own filename entry",
        ).toBe(true);
        expect(migrated.changes["__proto__"]).toMatchObject({
            lines: legacy.changes["__proto__"].lines,
            selections: legacy.changes["__proto__"].selections,
            history: [{ lines: legacy.changes["__proto__"].lines }],
        });
        const reopened = new ChangelistStore(storage);
        await reopened.connect(root, gitDir);
        expect(reopened.get(root)).toEqual(migrated);
    },
);
