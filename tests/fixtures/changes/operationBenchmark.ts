import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import {
    mkdir,
    mkdtemp,
    readFile,
    readdir,
    realpath,
    stat,
    statfs,
    writeFile,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { performance } from "node:perf_hooks";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { ChangelistStore } from "../../../src/changes/changelistStore";
import { changeFingerprint, parseChangeDiff } from "../../../src/changes/parseDiff";
import { rangeSnapshot } from "../../../src/changes/rangeMapping";
import { GitExecutor } from "../../../src/git/executor";
import { readPartialSnapshot } from "../../../src/git/partialSnapshot";
import { mapWithConcurrency } from "../../../src/utils/concurrency";
import { runGit } from "../repo/gitRun";
import { removeScratchDirectories } from "../../helpers/scratchDirectories";

/** Fixed distribution revision, shared by independently clean baseline and candidate fixtures. */
const BENCHMARK_SEED = 337_004;
const execFileAsync = promisify(execFile);

/** Generates the complete requested population, including staged-only, worktree-only and split rows. */
export function benchmarkFiles(files: number, lists: number) {
    assert.ok([1000, 10000].includes(files));
    assert.ok([20, 100].includes(lists));
    return Array.from({ length: files }, (_, i) => ({
        path: `bench-${String(i).padStart(5, "0")}-${i === 0 ? "first" : i === files - 1 ? "final-雪-😀" : i === Math.floor(files / 2) ? "長い名前-" + "unicode-雪-".repeat(12) : "file"}.txt`,
        owner: (i + BENCHMARK_SEED) % lists,
        splitOwner: i % 10 === 0 ? (i + BENCHMARK_SEED + 1) % lists : undefined,
        staged: i % 3 !== 1,
        unstaged: i % 3 !== 0,
    }));
}

/** Builds two independent text insertions, preserving the staged preimage for dual-layer rows. */
function fileContent(index: number, staged: boolean, unstaged: boolean) {
    const base = Array.from({ length: 32 }, (_, line) => `file ${index} base ${line}\n`).join("");
    const stage = staged ? base + `file ${index} staged A\nfile ${index} staged B\n` : base;
    const preimage = unstaged ? stage : base;
    const additions = unstaged
        ? `file ${index} working A\nfile ${index} working B\n`
        : stage.slice(base.length);
    const working = unstaged ? stage + additions : stage;
    const count = preimage.split("\n").length - 1;
    const diff =
        `@@ -${count},0 +${count + 1},2 @@\n` +
        additions
            .split(/(?<=\n)/)
            .filter(Boolean)
            .map((line) => `+${line}`)
            .join("");
    return { base, stage, working, preimage, diff };
}

/** Writes the existing validated schema-3 seed used by the storage benchmark; never invents storage. */
export async function seedBenchmarkMetadata(
    root: string,
    gitDir: string,
    files: number,
    lists: number,
    head: string,
    indexHash: string,
    snapshots?: ReadonlyMap<string, ReturnType<typeof rangeSnapshot>>,
) {
    root = await realpath(root);
    gitDir = await realpath(gitDir);
    const rows = benchmarkFiles(files, lists);
    const state = {
        ...new ChangelistStore().get(root),
        changes: {} as Record<
            string,
            {
                contentId: string;
                totalChanges: number;
                tracking: ReturnType<typeof rangeSnapshot>;
                lines: Record<string, string>;
            }
        >,
    };
    for (let i = 1; i < lists; i++)
        state.lists.push({
            id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
            name:
                i === lists - 1
                    ? "最後のリスト-" + "long-name-".repeat(7)
                    : `List ${String(i).padStart(3, "0")}`,
            description: "",
            draft: "",
        });
    if (snapshots) assert.equal(snapshots.size, rows.length);
    rows.forEach((row, i) => {
        if (snapshots) assert.ok(snapshots.has(row.path), "every native row has a real snapshot");
        const content = fileContent(i, row.staged, row.unstaged);
        const blocks = parseChangeDiff(content.diff, content.preimage, content.working);
        const contentId = changeFingerprint(
            JSON.stringify([content.preimage, content.working, blocks]),
        );
        const tracking = snapshots
            ? snapshots.get(row.path)!
            : rangeSnapshot({
                  head,
                  indexHash,
                  working: content.working,
                  contentId,
                  view: {
                      snapshotId: contentId,
                      path: row.path,
                      side: row.unstaged ? "working" : "index",
                      base: content.preimage,
                      blocks,
                  },
              });
        assert.ok(tracking.anchors.length > 0);
        state.files[row.path] = state.lists[row.owner].id;
        state.changes[row.path] = {
            contentId: tracking.contentId,
            totalChanges: tracking.anchors.length,
            tracking,
            lines:
                row.splitOwner === undefined
                    ? {}
                    : { [tracking.anchors[0].fingerprint]: state.lists[row.splitOwner].id },
        };
    });
    const directory = path.join(gitDir, "intelligit/changelists");
    await mkdir(directory, { recursive: true });
    const bytes = JSON.stringify({ schemaVersion: 3, root, gitDir, state });
    assert.ok(Buffer.byteLength(bytes) < 64 * 1024 * 1024, "seed fits the existing legacy budget");
    await writeFile(path.join(directory, "state.json"), bytes);
    return {
        rows,
        legacyBytes: Buffer.byteLength(bytes),
        distributionHash: changeFingerprint(JSON.stringify(rows)),
        seed: BENCHMARK_SEED,
    };
}

/** Seeds real bytes and captures HEAD-to-worktree tracking before measurement; preparation never migrates metadata. */
export async function seedBenchmarkRepository(
    root: string,
    env: NodeJS.ProcessEnv,
    files: number,
    lists: number,
) {
    const preparationStarted = performance.now();
    root = await realpath(root);
    const rows = benchmarkFiles(files, lists);
    const writePhase = async (phase: "base" | "stage" | "working") => {
        for (let offset = 0; offset < rows.length; offset += 32)
            await Promise.all(
                rows
                    .slice(offset, offset + 32)
                    .map((row, j) =>
                        writeFile(
                            path.join(root, row.path),
                            fileContent(offset + j, row.staged, row.unstaged)[phase],
                        ),
                    ),
            );
    };
    await writePhase("base");
    await runGit(root, ["add", "--all"], env);
    await runGit(
        root,
        ["commit", "--allow-empty", "-m", "deterministic operation benchmark base"],
        env,
    );
    await writePhase("stage");
    await runGit(root, ["add", "--all"], env);
    await writePhase("working");
    const gitDir = await runGit(root, ["rev-parse", "--absolute-git-dir"], env);
    const head = await runGit(root, ["rev-parse", "HEAD"], env);
    const snapshotStarted = performance.now();
    const executor = new GitExecutor(
        root,
        undefined,
        Object.fromEntries(
            Object.entries(env).filter(
                (entry): entry is [string, string] => entry[1] !== undefined,
            ),
        ),
    );
    const snapshots = new Map<string, ReturnType<typeof rangeSnapshot>>();
    await mapWithConcurrency(rows, 4, async (row) => {
        snapshots.set(
            row.path,
            rangeSnapshot(await readPartialSnapshot(executor, root, row.path, "working")),
        );
    });
    const snapshotPreparationMs = performance.now() - snapshotStarted;
    const seeded = await seedBenchmarkMetadata(
        root,
        gitDir,
        files,
        lists,
        head,
        changeFingerprint(await readFile(path.join(gitDir, "index"))),
        snapshots,
    );
    return {
        ...seeded,
        snapshotPreparationMs,
        preparationMs: performance.now() - preparationStarted,
        snapshotProducer:
            "readPartialSnapshot HEAD-to-worktree; four concurrent readers; schema3 publication only",
    };
}

/** Preserves raw order and warmups; nearest-rank p95 is descriptive, never a pass threshold. */
export function summarizeSamples(samples: readonly number[], warmups: readonly number[]) {
    assert.ok(
        samples.length > 0 &&
            [...samples, ...warmups].every((value) => Number.isFinite(value) && value >= 0),
        "all latency samples must be finite nonnegative numbers",
    );
    const sorted = [...samples].sort((a, b) => a - b);
    return {
        count: samples.length,
        warmupCount: warmups.length,
        samplesMs: [...samples],
        warmupSamplesMs: [...warmups],
        p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
        medianMs:
            (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) /
            2,
    };
}

/** Measures every invocation, retaining warmups; `start()` restarts the clock after unmeasured setup. */
export async function measureBenchmark(
    samples: number,
    warmups: number,
    operation: (iteration: number, start: () => void) => unknown | Promise<unknown>,
) {
    const measured: number[] = [];
    const warmed: number[] = [];
    for (let i = 0; i < warmups + samples; i++) {
        let started = performance.now();
        await operation(i, () => {
            started = performance.now();
        });
        (i < warmups ? warmed : measured).push(performance.now() - started);
    }
    return summarizeSamples(measured, warmed);
}

/** Validates standard separate-value CLI flags; full mode cannot silently run fewer than30 samples. */
export function parseBenchmarkArguments(args: readonly string[]) {
    const options = new Map<string, string>();
    const allowed = new Set(["--files", "--lists", "--output", "--mode", "--samples", "--warmups"]);
    for (let i = 0; i < args.length; i += 2) {
        assert.ok(
            allowed.has(args[i]) && args[i + 1] && !options.has(args[i]),
            "unknown, missing or duplicate benchmark option",
        );
        options.set(args[i], args[i + 1]);
    }
    const files = (options.get("--files") ?? "1000,10000").split(",").map(Number);
    const lists = (options.get("--lists") ?? "20,100").split(",").map(Number);
    assert.ok(
        files.every((value) => [1000, 10000].includes(value)) &&
            new Set(files).size === files.length,
    );
    assert.ok(
        lists.every((value) => [20, 100].includes(value)) && new Set(lists).size === lists.length,
    );
    const mode = options.get("--mode") ?? "full";
    assert.ok(mode === "full" || mode === "thin");
    const samples = Number(options.get("--samples") ?? (mode === "full" ? 30 : 2));
    const warmups = Number(options.get("--warmups") ?? (mode === "full" ? 3 : 1));
    assert.ok(Number.isInteger(samples) && samples >= (mode === "full" ? 30 : 1));
    assert.ok(Number.isInteger(warmups) && warmups >= 0);
    const output = options.get("--output");
    assert.ok(output, "--output is required");
    return { files, lists, mode, samples, warmups, output };
}

/** Counts persisted manifest and evidence separately, matching the existing storage benchmark. */
export async function benchmarkStorage(gitDir: string) {
    const directory = path.join(gitDir, "intelligit/changelists");
    const manifestBytes = (await stat(path.join(directory, "state.json"))).size;
    const evidence = await readdir(path.join(directory, "evidence")).catch(
        (error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return [];
            throw error;
        },
    );
    let evidenceBytes = 0;
    for (const file of evidence)
        evidenceBytes += (await stat(path.join(directory, "evidence", file))).size;
    const { schemaVersion } = JSON.parse(
        await readFile(path.join(directory, "state.json"), "utf8"),
    ) as { schemaVersion: number };
    return { schemaVersion, manifestBytes, evidenceBytes, evidenceFiles: evidence.length };
}

/** SHA-256 of every regular file below each directory, keyed by root-relative path. */
async function hashTree(root: string, directories: readonly string[]) {
    const hashes: Record<string, string> = {};
    const walk = async (directory: string) => {
        for (const entry of await readdir(path.join(root, directory), {
            withFileTypes: true,
        })) {
            const relative = path.join(directory, entry.name);
            if (entry.isDirectory()) await walk(relative);
            else if (entry.isFile())
                hashes[relative] = createHash("sha256")
                    .update(await readFile(path.join(root, relative)))
                    .digest("hex");
        }
    };
    for (const directory of directories) await walk(directory);
    return hashes;
}

/** One digest per tree: sorted path/hash pairs, so any added, removed or changed file moves it. */
function treeDigest(hashes: Record<string, string>, directory: string) {
    return createHash("sha256")
        .update(
            JSON.stringify(
                Object.entries(hashes)
                    .filter(([file]) => file.startsWith(directory + path.sep))
                    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
            ),
        )
        .digest("hex");
}

/** Identity of the extension build actually launched: commit, dist/src digests and every local edit. */
export async function extensionBuildIdentity(extensionPath: string) {
    const git = (args: string[]) =>
        execFileSync("git", args, { cwd: extensionPath, encoding: "utf8" }).trimEnd();
    const hashes = await hashTree(extensionPath, ["src", "dist"]);
    assert.ok(
        hashes[path.join("dist", "extension.js")],
        `${extensionPath} has no built dist/extension.js`,
    );
    const uncommittedSrc = git(["status", "--porcelain", "--untracked-files=all", "--", "src"])
        .split("\n")
        .filter(Boolean);
    return {
        extensionPath,
        revision: git(["rev-parse", "HEAD"]),
        packageVersion: (
            JSON.parse(await readFile(path.join(extensionPath, "package.json"), "utf8")) as {
                version: string;
            }
        ).version,
        distHash: treeDigest(hashes, "dist"),
        srcHash: treeDigest(hashes, "src"),
        uncommittedSrc: uncommittedSrc.map((line) => {
            const file = line.slice(3);
            return { status: line.slice(0, 2), file, sha256: hashes[path.normalize(file)] ?? null };
        }),
    };
}

/** Resolves palette titles and the destination-picker capability from the build's own manifests. */
export async function extensionCapabilities(extensionPath: string) {
    const read = async (file: string) =>
        JSON.parse(await readFile(path.join(extensionPath, file), "utf8")) as Record<
            string,
            unknown
        >;
    const manifest = (await read("package.json")) as {
        contributes: { commands: { command: string; title: string; category?: string }[] };
    };
    const nls = (await read("package.nls.json")) as Record<string, string>;
    const resolve = (value: string) =>
        value.replace(/^%(.+)%$/, (_, key: string) => {
            assert.ok(typeof nls[key] === "string", `package.nls.json lacks ${key}`);
            return nls[key];
        });
    const title = (id: string) => {
        const command = manifest.contributes.commands.find((entry) => entry.command === id);
        assert.ok(command, `${extensionPath} does not contribute ${id}`);
        return `${command.category ? resolve(command.category) + ": " : ""}${resolve(command.title)}`;
    };
    const bundle = await read("l10n/bundle.l10n.json");
    return {
        saveToShelf: title("intelligit.saveToShelf"),
        unshelve: title("intelligit.unshelve"),
        targetPicker: "Select a destination changelist" in bundle,
    };
}

/** Free bytes on the volume holding `directory`; volume-wide, so concurrent writers are included. */
export async function freeBytes(directory: string) {
    const stats = await statfs(directory);
    return stats.bavail * stats.bsize;
}

/** APFS clone of a whole tree via clonefile(2); `destination` must not exist yet. */
export async function cloneTree(source: string, destination: string) {
    // Node's fs.cp with COPYFILE_FICLONE_FORCE was measured to silently copy bytes on macOS.
    await execFileAsync("cp", ["-c", "-R", source, destination]);
}

/** Proves cloning shares blocks here: a 64 MiB clone must not consume a full copy's space. */
export async function assertCloneSupported(directory: string) {
    const probe = await mkdtemp(path.join(directory, "clone-probe-"));
    try {
        await writeFile(path.join(probe, "source"), randomBytes(64 * 1024 * 1024));
        const settle = async () => {
            await execFileAsync("sync");
            await new Promise((resolve) => setTimeout(resolve, 2_000));
            return freeBytes(directory);
        };
        const before = await settle();
        await cloneTree(path.join(probe, "source"), path.join(probe, "clone"));
        const consumed = before - (await settle());
        assert.ok(
            consumed < 32 * 1024 * 1024,
            `cp -c consumed ${consumed} bytes for a 64 MiB file: cloning is unsupported here; refusing a full-copy fallback`,
        );
        return { probeBytes: 64 * 1024 * 1024, consumedBytes: consumed };
    } finally {
        await removeScratchDirectories(probe);
    }
}

interface IpcDirection {
    count: number;
    serializedBytes: number;
    serializationFailures: number;
}
/** Host metrics snapshot shape returned by the E2E control channel's `metrics` store. */
export interface HostMetricsSnapshot {
    ipc: Record<"in" | "out", IpcDirection>;
    heap: NodeJS.MemoryUsage;
    retainedCaptureMessages: number;
}

/** Counts and total durations per Git subcommand kind, from the forwarding shim's log. */
export function summarizeGit(samples: readonly { kind: string; durationMs: number }[]) {
    const byKind: Record<string, { count: number; totalMs: number }> = {};
    for (const sample of samples) {
        const entry = (byKind[sample.kind] ??= { count: 0, totalMs: 0 });
        entry.count++;
        entry.totalMs += sample.durationMs;
    }
    return { count: samples.length, byKind };
}

/** IPC, host heap and subprocess cost of one scenario window, warmups included. */
export function scenarioCost(
    before: HostMetricsSnapshot,
    after: HostMetricsSnapshot,
    git: readonly { kind: string; durationMs: number }[],
    interactions: number,
) {
    const delta = (direction: "in" | "out") => ({
        count: after.ipc[direction].count - before.ipc[direction].count,
        serializedBytes:
            after.ipc[direction].serializedBytes - before.ipc[direction].serializedBytes,
        serializationFailures:
            after.ipc[direction].serializationFailures -
            before.ipc[direction].serializationFailures,
    });
    return {
        interactions,
        includesWarmups: true,
        ipc: { in: delta("in"), out: delta("out") },
        hostHeapUsedBefore: before.heap.heapUsed,
        hostHeapUsedAfter: after.heap.heapUsed,
        git: summarizeGit(git),
    };
}

/** Records real build/source identity and machine/runtime facts; absent versions are not guessed. */
export async function benchmarkProvenance(repoRoot: string) {
    const hashes = await hashTree(repoRoot, ["src", "dist"]);
    for (const file of [
        "package.json",
        "scripts/benchmark-changelist-operations.ts",
        "tests/fixtures/changes/operationBenchmark.ts",
        "tests/e2e/hostFixtures/changelistBenchmark.ts",
        "tests/e2e/changelistScale.spec.ts",
    ])
        hashes[file] = createHash("sha256")
            .update(await readFile(path.join(repoRoot, file)))
            .digest("hex");
    return {
        revision: execFileSync("git", ["rev-parse", "HEAD"], {
            cwd: repoRoot,
            encoding: "utf8",
        }).trim(),
        sourceHashes: hashes,
        versions: process.versions,
        git: execFileSync("git", ["--version"], { encoding: "utf8" }).trim(),
        os: { platform: os.platform(), release: os.release(), arch: os.arch() },
        hardware: {
            cpus: os.cpus().map((cpu) => ({ model: cpu.model, speed: cpu.speed })),
            totalMemory: os.totalmem(),
        },
        seed: BENCHMARK_SEED,
    };
}
