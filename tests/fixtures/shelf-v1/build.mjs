import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build, version } from "esbuild";

const fixtureDirectory = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(fixtureDirectory, "../../..");
const revision = "23464b48c7d47ae4f83429898c6df49b56faf0d3";

/** Rebuilds the shipped service solely from pinned Git objects, never current source or a mock parser. */
export async function buildBaseline(directory) {
    const sourceFiles = new Map();
    const source = (file) => {
        if (!sourceFiles.has(file)) {
            sourceFiles.set(
                file,
                execFileSync("git", ["show", `${revision}:${file}`], {
                    cwd: repository,
                    encoding: "utf8",
                    stdio: ["ignore", "pipe", "ignore"],
                }),
            );
        }
        return sourceFiles.get(file);
    };
    const resolve = (importer, request) => {
        const candidate = path.posix.normalize(
            path.posix.join(path.posix.dirname(importer), request),
        );
        for (const file of [
            candidate,
            `${candidate}.ts`,
            `${candidate}.tsx`,
            `${candidate}/index.ts`,
        ]) {
            try {
                source(file);
                return file;
            } catch {
                /* Try the next explicit TypeScript resolution. */
            }
        }
        throw new Error(`Missing baseline import ${request} from ${importer}`);
    };
    await mkdir(directory, { recursive: true });
    const outfile = path.join(directory, "shelfService.cjs");
    const result = await build({
        stdin: {
            contents:
                'export { ShelfService } from "baseline:src/services/shelfService.ts"; export { ShelfStore } from "baseline:src/shelf/store.ts"; export { resolveShelfPaths } from "baseline:src/shelf/paths.ts"; export { GitExecutor } from "baseline:src/git/executor.ts"; export { RepositoryMutationGate } from "baseline:src/git/repositoryMutationGate.ts"; export { RepositoryMutationCoordinator } from "baseline:src/git/mutationCoordinator.ts"; export { RepositoryLock } from "baseline:src/git/repositoryLock.ts";',
            loader: "ts",
        },
        outfile,
        bundle: true,
        platform: "node",
        format: "cjs",
        logLevel: "silent",
        metafile: true,
        plugins: [
            {
                name: "exact-shipped-shelf",
                setup(builder) {
                    builder.onResolve({ filter: /^baseline:/ }, (args) => ({
                        path: args.path.slice(9),
                        namespace: "baseline",
                    }));
                    builder.onResolve({ filter: /.*/, namespace: "baseline" }, (args) =>
                        args.path.startsWith(".")
                            ? { path: resolve(args.importer, args.path), namespace: "baseline" }
                            : { path: args.path, external: true },
                    );
                    builder.onLoad({ filter: /.*/, namespace: "baseline" }, (args) => ({
                        contents: source(args.path),
                        loader: args.path.endsWith(".tsx") ? "tsx" : "ts",
                    }));
                },
            },
        ],
    });
    const bundle = await readFile(outfile);
    const manifest = {
        revision,
        esbuildVersion: version,
        bundleSha256: createHash("sha256").update(bundle).digest("hex"),
        bytes: bundle.length,
        sourceFiles: [...sourceFiles.keys()].sort(),
        externalImports: [
            ...new Set(
                Object.values(result.metafile.outputs).flatMap((output) =>
                    output.imports.filter((value) => value.external).map((value) => value.path),
                ),
            ),
        ],
    };
    await writeFile(
        path.join(directory, "manifest.json"),
        JSON.stringify(manifest, null, 2) + "\n",
    );
    return { outfile, manifest };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    if (!process.argv[2])
        throw new Error("Usage: node tests/fixtures/shelf-v1/build.mjs OUTPUT_DIRECTORY");
    console.log(JSON.stringify(await buildBaseline(path.resolve(process.argv[2]))));
}
