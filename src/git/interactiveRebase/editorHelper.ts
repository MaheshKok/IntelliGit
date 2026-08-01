import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const ACTIONS = new Set(["pick", "reword", "squash", "fixup", "drop"]);
const FULL_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

type EditorRole = "message" | "sequence";

interface Invocation {
    editorPath: string;
    role: EditorRole;
    sessionDirectory: string;
}

interface PreparedMessage {
    action: string;
    message: string;
}

interface TodoStep {
    action: string;
    hash: string;
}

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

/**
 * Reports why the helper is stopping the rebase and returns Git's failure exit code.
 *
 * The reason is written to stderr as a single machine-readable token because Git surfaces only
 * a generic "editor failed" message; the extension captures this line to explain the stop.
 */
function fail(reason: string): number {
    process.stderr.write(`intelligit-rebase-editor: ${reason}\n`);
    return 1;
}

/** Runs the requested editor role and returns the exit code Git should receive. */
function main(): number {
    const invocation = readInvocation();
    if (!invocation) return fail("invalid-invocation");

    const rebaseMergeDirectory = findRebaseMergeDirectory(invocation.editorPath);
    if (!rebaseMergeDirectory) return fail("rebase-directory-not-found");

    if (invocation.role === "sequence") {
        return writeSequenceTodo(
            invocation.sessionDirectory,
            invocation.editorPath,
            rebaseMergeDirectory,
        );
    }
    return writePreparedMessage(
        invocation.sessionDirectory,
        invocation.editorPath,
        rebaseMergeDirectory,
    );
}

/**
 * Parses the sole supported invocation form: `<role> <sessionDirectory> <editorPath>`.
 *
 * Git appends the editor path as the final argument to the command built by
 * {@link createGitEditorCommand}, so role and session directory always precede it.
 */
function readInvocation(): Invocation | undefined {
    const [first, second, third] = process.argv.slice(2);
    if (isEditorRole(first) && typeof second === "string" && typeof third === "string") {
        return { role: first, sessionDirectory: second, editorPath: third };
    }
    return undefined;
}

/** Replaces Git's sequence todo and records ownership in the ephemeral rebase state directory. */
function writeSequenceTodo(
    sessionDirectory: string,
    editorPath: string,
    rebaseMergeDirectory: string,
): number {
    const todo = readText(path.join(sessionDirectory, "todo"));
    if (todo === undefined) return fail("session-todo-unreadable");

    try {
        writeFileSync(editorPath, todo, "utf8");
        writeFileSync(
            path.join(rebaseMergeDirectory, "intelligit-session"),
            sessionId(sessionDirectory),
            "utf8",
        );
        return 0;
    } catch {
        return fail("sequence-write-failed");
    }
}

/** Resolves and injects one prepared message without allowing an uncertain step to consume it. */
function writePreparedMessage(
    sessionDirectory: string,
    editorPath: string,
    rebaseMergeDirectory: string,
): number {
    if (!hasMatchingMarker(rebaseMergeDirectory, sessionId(sessionDirectory))) {
        return fail("session-marker-mismatch");
    }

    const messages = readPreparedMessages(path.join(sessionDirectory, "messages.json"));
    const todo = readTodo(path.join(sessionDirectory, "todo"));
    if (!messages || !todo) return fail("session-state-unreadable");

    const currentStep = resolveCurrentStep(todo, rebaseMergeDirectory);
    if (!currentStep) {
        return hasUnconsumedMessages(messages, sessionDirectory) ? fail("step-unresolved") : 0;
    }

    const prepared = messages[currentStep.hash];
    if (!prepared) return 0;
    if (prepared.action !== currentStep.action) {
        return hasUnconsumedMessages(messages, sessionDirectory) ? fail("step-action-mismatch") : 0;
    }

    const consumptionPath = path.join(sessionDirectory, "consumed", currentStep.hash);
    if (existsSync(consumptionPath)) return 0;

    try {
        writeFileSync(consumptionPath, "", { encoding: "utf8", flag: "wx" });
    } catch (error) {
        return isNodeError(error, "EEXIST") ? 0 : fail("consumption-marker-failed");
    }

    try {
        writeFileSync(editorPath, prepared.message, "utf8");
        return 0;
    } catch {
        rmSync(consumptionPath, { force: true });
        return fail("message-write-failed");
    }
}

/** Locates the Git `rebase-merge` directory from the editor file or Git's supplied directory. */
function findRebaseMergeDirectory(editorPath: string): string | undefined {
    const editorDirectory = path.dirname(path.resolve(editorPath));
    const gitDirectory = process.env.GIT_DIR;
    const candidates = [
        path.basename(editorDirectory) === "rebase-merge"
            ? editorDirectory
            : path.join(editorDirectory, "rebase-merge"),
        ...(gitDirectory ? [path.resolve(process.cwd(), gitDirectory, "rebase-merge")] : []),
    ];
    return candidates.find((candidate) => existsSync(candidate));
}

/** Confirms that the live rebase state belongs to this exact helper-artifact directory. */
function hasMatchingMarker(rebaseMergeDirectory: string, expectedSessionId: string): boolean {
    return (
        readText(path.join(rebaseMergeDirectory, "intelligit-session"))?.trim() ===
        expectedSessionId
    );
}

/** Parses Phase 1's lower-case object-ID keyed message map or treats malformed state as unsafe. */
function readPreparedMessages(pathname: string): Record<string, PreparedMessage> | undefined {
    const contents = readText(pathname);
    if (contents === undefined) return undefined;
    try {
        const parsed: unknown = JSON.parse(contents);
        if (!isRecord(parsed)) return undefined;
        const messages: Record<string, PreparedMessage> = {};
        for (const [hash, value] of Object.entries(parsed)) {
            if (
                !FULL_OBJECT_ID.test(hash) ||
                hash !== hash.toLowerCase() ||
                !isPreparedMessage(value)
            ) {
                return undefined;
            }
            messages[hash] = value;
        }
        return messages;
    } catch {
        return undefined;
    }
}

/** Parses the generated todo enough to bind a Git action and hash to a submitted step. */
function readTodo(pathname: string): TodoStep[] | undefined {
    const contents = readText(pathname);
    if (contents === undefined) return undefined;

    const steps: TodoStep[] = [];
    for (const line of contents.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
        const [action, hash] = trimmed.split(/\s+/, 3);
        if (!ACTIONS.has(action) || !FULL_OBJECT_ID.test(hash ?? "")) return undefined;
        steps.push({ action, hash: hash.toLowerCase() });
    }
    return steps;
}

/** Resolves from `done` first and falls back to Git's one-based `msgnum` counter. */
function resolveCurrentStep(
    todo: readonly TodoStep[],
    rebaseMergeDirectory: string,
): TodoStep | undefined {
    const done = readText(path.join(rebaseMergeDirectory, "done"));
    const doneStep = done === undefined ? undefined : parseDoneTail(done);
    if (doneStep) {
        const matches = todo.filter(
            (step) => step.action === doneStep.action && step.hash.startsWith(doneStep.hash),
        );
        if (matches.length === 1) return matches[0];
    }

    const msgnum = Number(readText(path.join(rebaseMergeDirectory, "msgnum"))?.trim());
    return Number.isInteger(msgnum) && msgnum >= 1 ? todo[msgnum - 1] : undefined;
}

/** Returns the final actionable record Git appended to its completed-todo log. */
function parseDoneTail(contents: string): TodoStep | undefined {
    const lines = contents.split(/\r?\n/);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
        const tail = lines[index].trim();
        if (tail.length === 0 || tail.startsWith("#")) continue;
        const [action, hash] = tail.split(/\s+/, 3);
        if (!ACTIONS.has(action) || !FULL_OBJECT_ID.test(hash ?? "")) return undefined;
        return { action, hash: hash.toLowerCase() };
    }
    return undefined;
}

/** Reports whether any prepared key has not yet acquired its one-shot consumption marker. */
function hasUnconsumedMessages(
    messages: Readonly<Record<string, PreparedMessage>>,
    sessionDirectory: string,
): boolean {
    return Object.keys(messages).some(
        (hash) => !existsSync(path.join(sessionDirectory, "consumed", hash)),
    );
}

/** Reads a UTF-8 helper artifact without allowing an I/O failure to throw through Git. */
function readText(pathname: string): string | undefined {
    try {
        return readFileSync(pathname, "utf8");
    } catch {
        return undefined;
    }
}

/** Derives the Phase 1 session ID from the name of its per-submission directory. */
function sessionId(sessionDirectory: string): string {
    return path.basename(path.resolve(sessionDirectory));
}

/** Narrows an untrusted role string to the two helper entry points. */
function isEditorRole(value: unknown): value is EditorRole {
    return value === "message" || value === "sequence";
}

/** Validates the only message payloads Phase 1 is allowed to persist for editor injection. */
function isPreparedMessage(value: unknown): value is PreparedMessage {
    return (
        isRecord(value) &&
        (value.action === "reword" || value.action === "squash") &&
        typeof value.message === "string"
    );
}

/** Narrows an untrusted JSON value to a non-array object record. */
function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Identifies a Node I/O failure by its stable error code without trusting its shape. */
function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
    return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

process.exitCode = main();
