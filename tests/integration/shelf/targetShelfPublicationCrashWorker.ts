import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveShelfPaths } from "../../../src/shelf/paths";
import { ShelfStore, type ShelfTargetPublicationRequest } from "../../../src/shelf/store";

const [temporary, requestFile, mode] = process.argv.slice(2);
if (!temporary || !requestFile || !["crash", "resume"].includes(mode))
    throw new Error("Invalid worker arguments.");
const request = JSON.parse(await readFile(requestFile, "utf8")) as ShelfTargetPublicationRequest;
const paths = await resolveShelfPaths({
    repositoryRoot: path.join(temporary, "repository"),
    globalStoragePath: temporary,
});
const store = new ShelfStore(paths, {
    publicationCheckpoint: async (phase) => {
        if (mode === "crash" && phase === "pointer") process.kill(process.pid, "SIGKILL");
    },
});
if (mode === "crash") {
    // Models the adapter's one recorded Git mutation, before storage-only recovery begins.
    await writeFile(path.join(temporary, "git-count"), "1", { flag: "wx" });
}
const manifest = await store.publishTargetOperation(request);
await writeFile(path.join(temporary, "result.json"), JSON.stringify(manifest));
