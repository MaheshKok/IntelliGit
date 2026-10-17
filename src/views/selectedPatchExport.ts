import type * as vscode from "vscode";
import { lstat, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PartialFileSnapshot } from "../git/partialSnapshot";
import { replaceMergeWorktreeFile } from "../shelf/safeWorktreeWrite";
import { assertChangeBuffersSaved } from "./changeDirtyBuffers";

/** Canonical picker destinations cannot alias this worktree's source or Git metadata. */
function assertExportLocation(output: string, source: string, snapshot: PartialFileSnapshot): void {
    const inside = (root: string) => {
        const relative = path.relative(root, output);
        return (
            relative === "" ||
            (!relative.startsWith(`..${path.sep}`) &&
                relative !== ".." &&
                !path.isAbsolute(relative))
        );
    };
    if (
        path.relative(source, output) === "" ||
        [snapshot.gitDir, snapshot.commonDir, path.join(snapshot.root, ".git")].some(inside) ||
        output.split(path.sep).some((part) => part.toLowerCase() === ".git")
    )
        throw new Error("Choose a patch destination outside Git metadata and the source file.");
}

/** Only native workspace-host paths are interpreted as filesystem names; other URI schemes are refused. */
export async function writeSelectedPatch(
    target: Pick<vscode.Uri, "scheme" | "fsPath">,
    snapshot: PartialFileSnapshot,
    patch: Buffer,
    recheck: () => Promise<void>,
): Promise<void> {
    if (target.scheme !== "file" || !path.isAbsolute(target.fsPath))
        throw new Error("Choose a patch destination on this workspace host's native filesystem.");
    if (!patch.length || patch.length > 8 * 1024 * 1024)
        throw new Error("The selected patch exceeds its supported size.");
    const directory = await realpath(path.dirname(target.fsPath));
    const output = path.join(directory, path.basename(target.fsPath));
    const source = await realpath(path.join(snapshot.root, snapshot.view.path));
    assertExportLocation(output, source, snapshot);
    const check = async () => {
        if ((await realpath(directory)) !== directory)
            throw new Error("The selected export directory changed.");
        assertExportLocation(output, source, snapshot);
        await assertChangeBuffersSaved(directory, [path.basename(output)], {
            allowMissingTargets: true,
        });
        await recheck();
    };
    await check();
    const existing = await lstat(output).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException | null)?.code !== "ENOENT") throw error;
        return undefined;
    });
    if (existing) {
        if (!existing.isFile() || existing.isSymbolicLink())
            throw new Error(
                "Patch export requires a regular destination, not a link or directory.",
            );
        // Replacing the entry, rather than truncating its inode, preserves source hardlink aliases.
        await replaceMergeWorktreeFile(directory, path.basename(output), patch, async () => {
            await check();
            const current = await lstat(output);
            if (
                current.ino !== existing.ino ||
                current.dev !== existing.dev ||
                current.size !== existing.size ||
                current.mtimeMs !== existing.mtimeMs ||
                current.ctimeMs !== existing.ctimeMs ||
                current.mode !== existing.mode
            )
                throw new Error("The selected patch destination changed.");
        });
    } else {
        await check();
        await writeFile(output, patch, { flag: "wx", mode: 0o600 });
    }
}
