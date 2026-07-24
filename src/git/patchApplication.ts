import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { GitExecutor } from "./executor";

/**
 * Applies patch text to both index and working tree through a temporary file.
 *
 * Git receives `--index --3way` so successful application stages the exact patch while conflicts
 * remain available to the existing conflict-session flow. Temporary files are removed in `finally`;
 * apply failures propagate unchanged and cleanup failures are logged without masking them.
 */
export async function applyPatchTextToRepo(
    patchText: string,
    reverse: boolean,
    executor: GitExecutor,
): Promise<void> {
    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "intelligit-filepatch-"));
    const patchFilePath = path.join(tempDir, "selected-change.patch");
    try {
        await fs.promises.writeFile(patchFilePath, patchText, "utf8");
        await executor.run([
            "apply",
            "--index",
            "--3way",
            "--whitespace=nowarn",
            ...(reverse ? ["-R"] : []),
            patchFilePath,
        ]);
    } finally {
        await fs.promises.rm(tempDir, { recursive: true, force: true }).catch((err) => {
            console.warn(`[intelligit] Failed to clean up temp patch dir ${tempDir}:`, err);
        });
    }
}
