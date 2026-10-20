import { mkdtemp, mkdir, realpath, symlink, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { removeScratchDirectories } from "../../helpers/scratchDirectories";
import { execFileSync } from "node:child_process";
import { GitExecutor } from "../../../src/git/executor";
import { readPartialSnapshot } from "../../../src/git/partialSnapshot";
import { rangeSnapshot } from "../../../src/changes/rangeMapping";
import os from "node:os";
import path from "node:path";
import { ChangelistStore } from "../../../src/changes/changelistStore";
import { describe, expect, it, vi } from "vitest";
import {
    benchmarkFiles,
    extensionBuildIdentity,
    extensionCapabilities,
    measureBenchmark,
    scenarioCost,
    seedBenchmarkMetadata,
    seedBenchmarkRepository,
    parseBenchmarkArguments,
    summarizeSamples,
} from "../../fixtures/changes/operationBenchmark";

describe("operation benchmark contracts", () => {
    it("seeds first, last and dual-layer ownership with exact real snapshot parity for every layer", async () => {
        const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "benchmark-parity-")));
        const env = {
            ...process.env,
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_CONFIG_SYSTEM: "/dev/null",
        };
        try {
            execFileSync("git", ["init", "-b", "main", root], { env });
            execFileSync("git", ["-C", root, "config", "user.name", "Benchmark Fixture"], { env });
            execFileSync("git", ["-C", root, "config", "user.email", "benchmark@example.invalid"], {
                env,
            });
            const fixture = await seedBenchmarkRepository(root, env, 1000, 20);
            const { state } = JSON.parse(
                await readFile(path.join(root, ".git/intelligit/changelists/state.json"), "utf8"),
            );
            expect(Object.keys(state.changes)).toHaveLength(1000);
            expect(new Set(Object.values(state.files)).size).toBe(20);
            for (const row of fixture.rows) {
                const seeded = state.changes[row.path];
                expect(state.files[row.path]).toBe(state.lists[row.owner].id);
                expect(Object.values(seeded.lines)).toEqual(
                    row.splitOwner === undefined ? [] : [state.lists[row.splitOwner].id],
                );
                expect(
                    Object.keys(seeded.lines).every((key) =>
                        seeded.tracking.anchors.some(
                            (anchor: { fingerprint: string }) => anchor.fingerprint === key,
                        ),
                    ),
                ).toBe(true);
            }
            const executor = new GitExecutor(root, undefined, env);
            for (const index of [0, 1, 2, 10, 500, 999]) {
                const row = fixture.rows[index];
                const actual = rangeSnapshot(
                    await readPartialSnapshot(executor, root, row.path, "working"),
                );
                expect(state.changes[row.path].tracking, row.path).toEqual(actual);
                expect(state.changes[row.path].contentId, row.path).toBe(actual.contentId);
                expect(state.changes[row.path].totalChanges, row.path).toBe(
                    row.staged && row.unstaged ? 4 : 2,
                );
            }
        } finally {
            await removeScratchDirectories(root);
        }
    }, 300_000);

    it("connects every seeded row through canonical symlink roots with long Unicode list names", async () => {
        const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "benchmark-seed-test-")));
        try {
            const gitDir = path.join(root, ".git");
            await mkdir(gitDir);
            const alias = path.join(root, "alias");
            await symlink(root, alias, "dir");
            const fixture = await seedBenchmarkMetadata(
                alias,
                path.join(alias, ".git"),
                1000,
                20,
                "a".repeat(40),
                "b".repeat(64),
            );
            const store = new ChangelistStore();
            await expect(store.connect(root, gitDir)).resolves.toBeUndefined();
            expect(Object.keys(store.get(root).files)).toHaveLength(fixture.rows.length);
            expect(store.get(root).lists).toHaveLength(20);
            expect(store.get(root).lists.at(-1)!.name).toContain("最後");
        } finally {
            await removeScratchDirectories(root);
        }
    });
    it.each([
        [1000, 20],
        [1000, 100],
        [10000, 20],
        [10000, 100],
    ])(
        "retains all %s files across %s deterministic owners, first/last Unicode and split layers",
        (files, lists) => {
            const rows = benchmarkFiles(files, lists);
            expect(rows).toHaveLength(files);
            expect(new Set(rows.map((row) => row.path)).size).toBe(files);
            expect(new Set(rows.map((row) => row.owner)).size).toBe(lists);
            expect(rows[0].path).toContain("first");
            expect(rows.at(-1)!.path).toContain("final-雪-😀");
            expect(rows.some((row) => Buffer.byteLength(row.path) > 100)).toBe(true);
            expect(rows.filter((row) => row.splitOwner !== undefined)).toHaveLength(
                Math.ceil(files / 10),
            );
            expect(
                rows.every((row) => row.splitOwner === undefined || row.splitOwner !== row.owner),
            ).toBe(true);
            expect(rows.some((row) => row.staged && row.unstaged)).toBe(true);
            expect(rows.some((row) => row.staged && !row.unstaged)).toBe(true);
            expect(rows.some((row) => !row.staged && row.unstaged)).toBe(true);
            expect(benchmarkFiles(files, lists)).toEqual(rows);
        },
    );
    it("retains every measured and warmup sample and computes the nearest-rank p95", () => {
        const samples = Array.from({ length: 30 }, (_, i) => 30 - i);
        const result = summarizeSamples(samples, [60, 50]);
        expect(result).toMatchObject({
            samplesMs: samples,
            warmupSamplesMs: [60, 50],
            count: 30,
            warmupCount: 2,
            p95Ms: 29,
        });
        expect(() => summarizeSamples([], [])).toThrow();
        expect(() => summarizeSamples([NaN], [])).toThrow();
    });
    it("starts each sample's clock at start() and otherwise at invocation", async () => {
        let now = 0;
        const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
        try {
            const result = await measureBenchmark(2, 1, (i, start) => {
                now += 100;
                if (i > 0) start();
                now += 7;
            });
            expect(result.warmupSamplesMs).toEqual([107]);
            expect(result.samplesMs).toEqual([7, 7]);
        } finally {
            clock.mockRestore();
        }
    });
    it("summarizes scenario IPC, heap and Git cost as after-minus-before deltas", () => {
        const snapshot = (count: number, bytes: number, heapUsed: number) => ({
            ipc: {
                in: { count, serializedBytes: bytes, serializationFailures: 0 },
                out: { count: count * 2, serializedBytes: bytes * 2, serializationFailures: 1 },
            },
            heap: { heapUsed } as NodeJS.MemoryUsage,
            retainedCaptureMessages: 0,
        });
        const cost = scenarioCost(
            snapshot(3, 100, 10),
            snapshot(8, 160, 25),
            [
                { kind: "status", durationMs: 4 },
                { kind: "status", durationMs: 6 },
                { kind: "numstat", durationMs: 2 },
            ],
            33,
        );
        expect(cost).toEqual({
            interactions: 33,
            includesWarmups: true,
            ipc: {
                in: { count: 5, serializedBytes: 60, serializationFailures: 0 },
                out: { count: 10, serializedBytes: 120, serializationFailures: 0 },
            },
            hostHeapUsedBefore: 10,
            hostHeapUsedAfter: 25,
            git: {
                count: 3,
                byKind: { status: { count: 2, totalMs: 10 }, numstat: { count: 1, totalMs: 2 } },
            },
        });
    });
    it("resolves palette titles and the destination picker from the build's own manifests", async () => {
        const repo = path.resolve(__dirname, "../../..");
        const capabilities = await extensionCapabilities(repo);
        expect(capabilities).toEqual({
            saveToShelf: "IntelliGit: Save to Shelf…",
            unshelve: "IntelliGit: Unshelve…",
            targetPicker: true,
        });
        const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "benchmark-caps-")));
        try {
            await mkdir(path.join(root, "l10n"));
            await writeFile(path.join(root, "l10n/bundle.l10n.json"), "{}");
            await writeFile(path.join(root, "package.nls.json"), "{}");
            await writeFile(
                path.join(root, "package.json"),
                JSON.stringify({
                    contributes: {
                        commands: ["saveToShelf", "unshelve"].map((id) => ({
                            command: `intelligit.${id}`,
                            title: id,
                        })),
                    },
                }),
            );
            await expect(extensionCapabilities(root)).resolves.toMatchObject({
                unshelve: "unshelve",
                targetPicker: false,
            });
            await writeFile(
                path.join(root, "package.json"),
                JSON.stringify({
                    contributes: {
                        commands: [{ command: "intelligit.saveToShelf", title: "%missing%" }],
                    },
                }),
            );
            await expect(extensionCapabilities(root)).rejects.toThrow("missing");
        } finally {
            await removeScratchDirectories(root);
        }
    });
    it("identifies a build by commit, dist digest and every uncommitted source file", async () => {
        const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "benchmark-build-")));
        const env = {
            ...process.env,
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_CONFIG_SYSTEM: "/dev/null",
        };
        const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { env });
        try {
            await mkdir(path.join(root, "src"));
            await mkdir(path.join(root, "dist"));
            await writeFile(path.join(root, "package.json"), '{"version":"1.2.3"}');
            await writeFile(path.join(root, "src/a.ts"), "a");
            await writeFile(path.join(root, "dist/extension.js"), "one");
            git("init", "-b", "main");
            git("add", "package.json", "src");
            git("-c", "user.name=B", "-c", "user.email=b@example.invalid", "commit", "-m", "x");
            const first = await extensionBuildIdentity(root);
            expect(first).toMatchObject({ packageVersion: "1.2.3", uncommittedSrc: [] });
            expect(first.revision).toMatch(/^[0-9a-f]{40}$/);
            await writeFile(path.join(root, "dist/extension.js"), "two");
            await writeFile(path.join(root, "src/a.ts"), "ported");
            const second = await extensionBuildIdentity(root);
            expect(second.distHash).not.toBe(first.distHash);
            expect(second.srcHash).not.toBe(first.srcHash);
            expect(second.uncommittedSrc).toEqual([
                {
                    status: " M",
                    file: "src/a.ts",
                    sha256: createHash("sha256").update("ported").digest("hex"),
                },
            ]);
        } finally {
            await removeScratchDirectories(root);
        }
    });
    it("accepts the full four-combination CLI matrix and explicitly bounded thin mode", () => {
        expect(
            parseBenchmarkArguments([
                "--files",
                "1000,10000",
                "--lists",
                "20,100",
                "--output",
                "proof",
            ]),
        ).toMatchObject({
            files: [1000, 10000],
            lists: [20, 100],
            output: "proof",
            mode: "full",
            samples: 30,
        });
        expect(
            parseBenchmarkArguments([
                "--files",
                "1000",
                "--lists",
                "20",
                "--output",
                "proof",
                "--mode",
                "thin",
                "--samples",
                "2",
            ]),
        ).toMatchObject({ mode: "thin", samples: 2 });
        expect(() => parseBenchmarkArguments(["--output", "proof", "--samples", "2"])).toThrow();
        expect(() => parseBenchmarkArguments(["--files", "999", "--output", "proof"])).toThrow();
        expect(() => parseBenchmarkArguments(["--unknown", "value"])).toThrow();
    });
});
