import * as vscode from "vscode";
import { realpath } from "node:fs/promises";
import path from "node:path";

/** Matches canonical file identities, including macOS /var and /private/var aliases. */
export async function assertChangeBuffersSaved(
    root: string,
    files: readonly string[],
    options: { allowMissingTargets?: boolean } = {},
): Promise<void> {
    const targets = new Set(
        await Promise.all(
            files.map((file) =>
                realpath(path.join(root, file)).catch(async (error: unknown) => {
                    if (
                        !options.allowMissingTargets ||
                        (error as NodeJS.ErrnoException | null)?.code !== "ENOENT"
                    )
                        throw error;
                    return path.join(
                        await realpath(path.dirname(path.join(root, file))),
                        path.basename(file),
                    );
                }),
            ),
        ),
    );
    const documents = [
        ...vscode.workspace.textDocuments,
        ...(vscode.workspace.notebookDocuments ?? []),
    ];
    for (const document of documents) {
        if (!document.isDirty || !["file", "vscode-remote"].includes(document.uri.scheme)) continue;
        const current = await realpath(document.uri.fsPath)
            .catch(async () =>
                path.join(
                    await realpath(path.dirname(document.uri.fsPath)),
                    path.basename(document.uri.fsPath),
                ),
            )
            .catch(() => undefined);
        if (current && targets.has(current)) {
            throw new Error(
                vscode.l10n.t("Save the native editor before selecting partial changes."),
            );
        }
    }
}
