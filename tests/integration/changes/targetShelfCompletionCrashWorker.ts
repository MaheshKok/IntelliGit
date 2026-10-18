import { writeFile } from "node:fs/promises";
import path from "node:path";
import { createCompletionFixture, openCompletionFixture } from "./targetShelfCompletionFixture";

const [root, mode] = process.argv.slice(2);
if (!root || !["crash", "resume"].includes(mode))
    throw new Error("Invalid crash-worker arguments.");
if (mode === "crash") await createCompletionFixture({ root });
const fixture = await openCompletionFixture(root, {
    publicationCheckpoint: async (phase) => {
        if (mode === "crash" && phase === "pointer") process.kill(process.pid, "SIGKILL");
    },
});
const result = await fixture.withLease(async (lease) =>
    fixture.store.recoverTargetOperation(lease, await fixture.observation(), fixture.shelf),
);
await writeFile(path.join(root, "completion-result.json"), JSON.stringify(result));
