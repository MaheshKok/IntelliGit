import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { build, version as esbuildVersion } from "esbuild";

const revision = "23464b48c7d47ae4f83429898c6df49b56faf0d3";
const requiredEsbuildVersion = "0.28.2";
const root = path.resolve(import.meta.dirname, "../../../..");
const directory = import.meta.dirname;
const outfile = path.join(directory, "changelistStore.cjs");

if (esbuildVersion !== requiredEsbuildVersion)
    throw new Error(`Expected esbuild ${requiredEsbuildVersion}, received ${esbuildVersion}.`);

const source = (file) =>
    execFileSync("git", ["show", `${revision}:${file}`], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
    });
const resolve = (importer, request) => {
    const candidate = path.posix.normalize(path.posix.join(path.posix.dirname(importer), request));
    for (const file of [
        candidate,
        `${candidate}.ts`,
        `${candidate}.tsx`,
        `${candidate}/index.ts`,
    ]) {
        try {
            source(file);
            return file;
        } catch {}
    }
    throw new Error(`Baseline import is missing: ${request} from ${importer}`);
};

await mkdir(directory, { recursive: true });
await build({
    entryPoints: ["baseline:src/changes/changelistStore.ts"],
    outfile,
    bundle: true,
    platform: "node",
    format: "cjs",
    logLevel: "silent",
    plugins: [
        {
            name: "exact-schema4-baseline",
            setup(build) {
                build.onResolve({ filter: /^baseline:/ }, (args) => ({
                    path: args.path.slice("baseline:".length),
                    namespace: "baseline",
                }));
                build.onResolve({ filter: /.*/, namespace: "baseline" }, (args) =>
                    args.path.startsWith(".")
                        ? { path: resolve(args.importer, args.path), namespace: "baseline" }
                        : { path: args.path, external: true },
                );
                build.onLoad({ filter: /.*/, namespace: "baseline" }, (args) => ({
                    contents: source(args.path),
                    loader: args.path.endsWith(".tsx") ? "tsx" : "ts",
                }));
            },
        },
    ],
});
const bytes = await readFile(outfile);
const bundleSha256 = createHash("sha256").update(bytes).digest("hex");
await writeFile(
    path.join(directory, "manifest.json"),
    `${JSON.stringify(
        {
            fixtureVersion: 1,
            originRevision: revision,
            entrypoint: "src/changes/changelistStore.ts",
            bundle: "changelistStore.cjs",
            bundleSha256,
        },
        null,
        4,
    )}\n`,
);
process.stdout.write(`${bundleSha256}\n`);
