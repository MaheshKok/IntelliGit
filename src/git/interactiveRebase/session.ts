import { writeFile } from "node:fs/promises";
import { buildRebaseTodo } from "./todo";
import type { RebaseSessionPaths, RebaseTodoEntry } from "./types";

/**
 * Writes the helper artifacts consumed by one interactive-rebase editor session.
 *
 * Only `reword` and `squash` entries reach the message map because those are the
 * only actions for which the editor helper replaces Git's message file.
 */
export async function writeInteractiveRebaseSession(
    paths: RebaseSessionPaths,
    entries: readonly RebaseTodoEntry[],
): Promise<void> {
    const messages = Object.fromEntries(
        entries
            .filter(
                (
                    entry,
                ): entry is RebaseTodoEntry & { action: "reword" | "squash"; message: string } =>
                    (entry.action === "reword" || entry.action === "squash") &&
                    typeof entry.message === "string",
            )
            .map((entry) => [
                entry.hash.toLowerCase(),
                { action: entry.action, message: entry.message },
            ]),
    );
    await Promise.all([
        writeFile(paths.todoPath, buildRebaseTodo(entries), "utf8"),
        writeFile(paths.messageMapPath, JSON.stringify(messages), "utf8"),
    ]);
}
