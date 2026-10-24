import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ChangelistStore } from "../src/changes/changelistStore";
import {
    benchmarkProvenance,
    benchmarkStorage,
    measureBenchmark,
    parseBenchmarkArguments,
    seedBenchmarkMetadata,
    summarizeSamples,
} from "../tests/fixtures/changes/operationBenchmark";

/**
 * Host/store microbenchmark: synthetic validated schema3 evidence, real store migrations and writes.
 * Run under Node, not Bun, so heap figures come from V8 like the extension host:
 * `bunx esbuild scripts/benchmark-changelist-operations.ts --bundle --platform=node --outfile=$T/bench.cjs`
 * then `node --expose-gc $T/bench.cjs --output <directory>`.
 */
async function main() {
    assert.equal(
        typeof global.gc,
        "function",
        "Bundle for Node and run with --expose-gc (see the comment above)",
    );
    const options = parseBenchmarkArguments(process.argv.slice(2));
    await mkdir(options.output, { recursive: true });
    const provenance = await benchmarkProvenance(process.cwd());
    for (const files of options.files)
        for (const lists of options.lists) {
            const owner = await realpath(
                await mkdtemp(path.join(os.tmpdir(), "intelligit-operation-bench-")),
            );
            try {
                const cold: number[] = [];
                const warmCold: number[] = [];
                let store: ChangelistStore | undefined;
                let root = "";
                let seeded: Awaited<ReturnType<typeof seedBenchmarkMetadata>> | undefined;
                global.gc?.();
                const heapBefore = process.memoryUsage();
                for (let i = 0; i < options.samples + options.warmups; i++) {
                    root = path.join(owner, `cold-${i}`);
                    await mkdir(path.join(root, ".git"), { recursive: true });
                    seeded = await seedBenchmarkMetadata(
                        root,
                        path.join(root, ".git"),
                        files,
                        lists,
                        "a".repeat(40),
                        "b".repeat(64),
                    );
                    store = new ChangelistStore();
                    const started = performance.now();
                    await store.connect(root, path.join(root, ".git"));
                    (i < options.warmups ? warmCold : cold).push(performance.now() - started);
                    assert.equal(Object.keys(store.get(root).files).length, files);
                    if (i < options.samples + options.warmups - 1)
                        await rm(root, { recursive: true, force: true });
                }
                assert.ok(store && seeded);
                const active = store;
                global.gc?.();
                const heapSettled = process.memoryUsage();
                const view = await measureBenchmark(options.samples, options.warmups, () =>
                    active.view(root),
                );
                const revision = await measureBenchmark(options.samples, options.warmups, () =>
                    active.revision(root),
                );
                let previous = "";
                const draft = await measureBenchmark(
                    options.samples,
                    options.warmups,
                    async (i) => {
                        const next = `benchmark draft ${i}`;
                        await active.saveDraft(root, "all", previous, next);
                        previous = next;
                    },
                );
                const move = await measureBenchmark(options.samples, options.warmups, (i) =>
                    active.moveFiles(
                        root,
                        active.revision(root),
                        active.get(root).lists[i % 2].id,
                        [seeded!.rows.at(-1)!.path],
                    ),
                );
                const parse = await measureBenchmark(options.samples, options.warmups, async () =>
                    JSON.parse(
                        await readFile(
                            path.join(root, ".git/intelligit/changelists/state.json"),
                            "utf8",
                        ),
                    ),
                );
                global.gc?.();
                const heapRepeated = process.memoryUsage();
                const result = {
                    kind: "host-store-microbenchmark",
                    label: "microbenchmark: host-only store calls, not end-to-end evidence",
                    runtime: { execPath: process.execPath, execArgv: process.execArgv },
                    options,
                    files,
                    lists,
                    provenance,
                    fixture: {
                        seed: seeded.seed,
                        distributionHash: seeded.distributionHash,
                        legacyBytes: seeded.legacyBytes,
                        method: "existing schema3 sparse evidence seed; no UI/Git command latency claim",
                    },
                    heapBefore,
                    heapSettled,
                    heapRepeated,
                    storage: await benchmarkStorage(path.join(root, ".git")),
                    scenarios: {
                        coldConnect: summarizeSamples(cold, warmCold),
                        view,
                        revision,
                        draft,
                        move,
                        metadataParse: parse,
                    },
                    unmeasured: {
                        targetPickCancel:
                            "UI-only; measured end to end in tests/e2e/changelistScale.spec.ts",
                        listCapture: "measured end to end in tests/e2e/changelistScale.spec.ts",
                        targetRestore: "measured end to end in tests/e2e/changelistScale.spec.ts",
                    },
                };
                await writeFile(
                    path.join(options.output, `host-${files}-${lists}.json`),
                    JSON.stringify(result, null, 2),
                );
                console.log(
                    JSON.stringify({
                        files,
                        lists,
                        samples: options.samples,
                        output: path.resolve(options.output, `host-${files}-${lists}.json`),
                    }),
                );
            } finally {
                await rm(owner, { recursive: true, force: true });
            }
        }
}
main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
