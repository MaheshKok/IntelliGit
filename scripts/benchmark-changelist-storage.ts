import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { ChangelistStore } from "../src/changes/changelistStore";
import { changeFingerprint as hash, parseChangeDiff } from "../src/changes/parseDiff";
import { rangeSnapshot } from "../src/changes/rangeMapping";

/** Builds real sparse text evidence; fixture creation is excluded from operation timings. */
function snapshot(root: string, file: string, count: number, version = 0) {
    const gitDir = path.join(root, ".git");
    const lines = Array.from({ length: count }, (_, i) => `${file} unique line ${i}\n`);
    const base = lines.join("");
    const middle = Math.floor(count / 2);
    const first = `${file} insertion A version ${version}\n`;
    const last = `${file} insertion B version ${version}\n`;
    const working = [...lines.slice(0, middle), first, ...lines.slice(middle), last].join("");
    const diff = `@@ -${middle},0 +${middle + 1},1 @@\n+${first}@@ -${count},0 +${count + 2},1 @@\n+${last}`;
    const blocks = parseChangeDiff(diff, base, working);
    const contentId = hash(JSON.stringify([base, working, blocks]));
    const result = rangeSnapshot({
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
        view: { snapshotId: contentId, path: file, side: "working", base, blocks },
    });
    assert.equal(result.anchors.length, 2, "fixture must contain two real selectable insertions");
    assert.ok(Buffer.byteLength(working) < 2 * 1024 * 1024);
    return result;
}

/** Seeds validated legacy data for equivalent startup; this does not measure initial tracking. */
async function seed(root: string, files: number, lists: number, lines: number) {
    const state = {
        ...new ChangelistStore().get(root),
        changes: {} as Record<
            string,
            {
                contentId: string;
                totalChanges: number;
                tracking: ReturnType<typeof snapshot>;
                lines: Record<string, string>;
            }
        >,
    };
    for (let i = 1; i < lists; i++) {
        state.lists.push({
            id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
            name: `List ${i}`,
            description: "",
            draft: "",
        });
    }
    for (let i = 0; i < files; i++) {
        const file = `file-${i}.txt`;
        const evidence = snapshot(root, file, lines);
        state.files[file] = state.lists[i % lists].id;
        state.changes[file] = {
            contentId: evidence.contentId,
            totalChanges: 2,
            tracking: evidence,
            lines: i % 10 === 0 ? { [evidence.anchors[0].fingerprint]: state.lists[1].id } : {},
        };
    }
    const gitDir = path.join(root, ".git");
    const directory = path.join(gitDir, "intelligit", "changelists");
    await mkdir(directory, { recursive: true });
    const bytes = JSON.stringify({ schemaVersion: 3, root, gitDir, state });
    assert.ok(
        Buffer.byteLength(bytes) < 64 * 1024 * 1024,
        "shared fixture must fit the legacy budget",
    );
    await writeFile(path.join(directory, "state.json"), bytes);
    return Buffer.byteLength(bytes);
}

/** Records individual samples, so medians and tails remain inspectable without a CI time gate. */
async function measure(count: number, operation: (i: number) => unknown | Promise<unknown>) {
    const samples: number[] = [];
    for (let i = 0; i < count; i++) {
        const start = performance.now();
        await operation(i);
        samples.push(performance.now() - start);
    }
    const ordered = [...samples].sort((a, b) => a - b);
    return {
        count,
        medianMs: (ordered[Math.floor((count - 1) / 2)] + ordered[Math.floor(count / 2)]) / 2,
        p95Ms: ordered[Math.ceil(count * 0.95) - 1],
        samplesMs: samples,
    };
}

/** Counts durable evidence separately from intentionally retained schema-3 recovery backups. */
async function storage(directory: string) {
    const manifestBytes = (await stat(path.join(directory, "state.json"))).size;
    let evidenceFiles: string[] = [];
    try {
        evidenceFiles = await readdir(path.join(directory, "evidence"));
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    let evidenceBytes = 0;
    for (const name of evidenceFiles)
        evidenceBytes += (await stat(path.join(directory, "evidence", name))).size;
    return { manifestBytes, evidenceFiles: evidenceFiles.length, evidenceBytes };
}

/** Runs one dataset per process; timings are Node host measurements, not UI latency. */
async function main() {
    assert.equal(typeof global.gc, "function", "Run the compiled benchmark with Node --expose-gc");
    const files = Number(process.argv[2]);
    const lists = Number(process.argv[3]);
    assert.ok([10, 1000, 10000].includes(files), "files must be 10 (self-check), 1000, or 10000");
    assert.ok([20, 100].includes(lists), "lists must be 20 or 100");
    const lines = files === 10000 ? 32 : 256;
    const root = await realpath(
        await mkdtemp(path.join(tmpdir(), "intelligit-storage-benchmark-")),
    );
    try {
        const legacyBytes = await seed(root, files, lists, lines);
        global.gc?.();
        const initialMemory = process.memoryUsage();
        const store = new ChangelistStore();
        const cold = await measure(1, () => store.connect(root, path.join(root, ".git")));
        const revisionMethod = (store as unknown as { revision?: (root: string) => number })
            .revision;
        const revision = () =>
            revisionMethod ? revisionMethod.call(store, root) : store.get(root).revision;
        assert.equal(Object.keys(store.get(root).files).length, files);
        assert.equal(store.get(root).lists.length, lists);
        global.gc?.();
        const connectedMemory = process.memoryUsage();
        const polls = await measure(100, () => revision());
        const gets = await measure(20, () => store.get(root));
        const views = await measure(20, () => store.view(root));
        let previous = "";
        const drafts = await measure(10, async (i) => {
            const next = `Benchmark draft ${i}`;
            await store.saveDraft(root, "all", previous, next);
            previous = next;
        });
        const move = await measure(1, () =>
            store.moveFiles(root, revision(), "default", [`file-${files - 1}.txt`]),
        );
        const reconciliation = await measure(1, () =>
            store.track(root, "file-0.txt", snapshot(root, "file-0.txt", lines, 1)),
        );
        const rotations = await measure(10, (i) =>
            store.track(root, "file-0.txt", snapshot(root, "file-0.txt", lines, i + 2)),
        );
        assert.equal(store.draft(root, "all"), previous);
        assert.equal(store.get(root).changes["file-0.txt"].history?.length, 2);
        const directory = path.join(root, ".git", "intelligit", "changelists");
        const durable = await storage(directory);
        const envelope = JSON.parse(await readFile(path.join(directory, "state.json"), "utf8")) as {
            schemaVersion: number;
            state: { files: Record<string, string> };
        };
        assert.equal(Object.keys(envelope.state.files).length, files);
        const reopened = new ChangelistStore();
        const reopen = await measure(1, () => reopened.connect(root, path.join(root, ".git")));
        assert.equal(reopened.draft(root, "all"), previous);
        global.gc?.();
        console.log(
            JSON.stringify(
                {
                    runtime: process.version,
                    platform: process.platform,
                    architecture: process.arch,
                    files,
                    lists,
                    lines,
                    anchorsPerFile: 2,
                    initialHistoryPerFile: 0,
                    splitFileCount: Math.ceil(files / 10),
                    fixtureMethod:
                        "prebuilt schema-3 fixture, not public initial tracking throughput",
                    revisionMethod: revisionMethod ? "revision" : "get().revision",
                    legacyBytes,
                    schemaVersion: envelope.schemaVersion,
                    durable,
                    initialMemory,
                    connectedMemory,
                    finalMemory: process.memoryUsage(),
                    cold,
                    polls,
                    gets,
                    views,
                    drafts,
                    move,
                    reconciliation,
                    rotations,
                    reopen,
                },
                null,
                2,
            ),
        );
    } finally {
        await rm(root, { recursive: true, force: true });
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
