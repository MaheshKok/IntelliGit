// Pure construction of the editor commands Git runs for an interactive rebase.
//
// This module is deliberately free of side effects so the extension host can import it. Its
// sibling `editorHelper.ts` is a standalone CLI entry point that executes on import, which makes
// that module unsafe to import from the host process.

/** The two editor roles Git invokes during an interactive rebase driven by this extension. */
export type EditorRole = "message" | "sequence";

/**
 * Quotes one argument for the shell Git uses to execute configured editors.
 *
 * The value is normalized for POSIX/MSYS paths before it is single-quoted; apostrophes use the
 * POSIX `\\''` escape sequence so the resulting editor command contains no unquoted input.
 */
export function quoteGitEditorArgument(value: string): string {
    return `'${value.replaceAll("\\", "/").replaceAll("'", "'\\''")}'`;
}

/**
 * Builds the editor command string Git executes through its shell.
 *
 * `ELECTRON_RUN_AS_NODE` is scoped to this command with `env`, so Git hooks and their children
 * do not inherit it. The returned command accepts the target editor path as Git's final argument.
 */
export function createGitEditorCommand(
    scriptPath: string,
    role: EditorRole,
    sessionDirectory: string,
): string {
    return [
        "env ELECTRON_RUN_AS_NODE=1",
        quoteGitEditorArgument(process.execPath),
        quoteGitEditorArgument(scriptPath),
        quoteGitEditorArgument(role),
        quoteGitEditorArgument(sessionDirectory),
    ].join(" ");
}
