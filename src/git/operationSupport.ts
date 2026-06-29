import { getErrorMessage, sanitizeErrorMessage } from "../utils/errors";

declare const require: (id: string) => unknown;

const OUTPUT_CHANNEL_NAME = "IntelliGit";

type VsCodeApi = typeof import("vscode");
type OutputChannelLike = { appendLine: (value: string) => void };

/** Options that let Git operation helpers mirror logged warnings into VS Code UI. */
export type GitOpsWarningOptions = { userWarningMessage?: string };

let cachedVsCodeApi: VsCodeApi | null | undefined;
let outputChannel: OutputChannelLike | undefined;

/**
 * Lazily resolves the VS Code extension-host API when Git helpers run inside VS Code.
 *
 * Tests and non-extension environments cannot import `vscode`; those callers receive
 * `null`, and the result is cached so repeated warning paths do not repeatedly probe
 * the module loader.
 */
export function getVsCodeApi(): VsCodeApi | null {
    if (cachedVsCodeApi !== undefined) return cachedVsCodeApi;
    try {
        const globalRequire = (globalThis as { require?: (id: string) => unknown }).require;
        cachedVsCodeApi = (
            typeof globalRequire === "function" ? globalRequire("vscode") : require("vscode")
        ) as VsCodeApi;
    } catch {
        cachedVsCodeApi = null;
    }
    return cachedVsCodeApi;
}

/**
 * Returns the shared IntelliGit output channel, falling back to `console.warn` in tests.
 *
 * The fallback keeps Git operation warnings visible without requiring callers to mock
 * the VS Code module when exercising parser and operation-support code outside the host.
 */
function getOutputChannel(): OutputChannelLike {
    if (outputChannel) return outputChannel;
    const vscode = getVsCodeApi();
    outputChannel = vscode
        ? vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME)
        : { appendLine: (value: string) => console.warn(value) };
    return outputChannel;
}

function withNotificationPrefix(message: string): string {
    return `${OUTPUT_CHANNEL_NAME}: ${message}`;
}

function showTimedWarningMessage(vscode: VsCodeApi, message: string): void {
    void vscode.window.showWarningMessage(withNotificationPrefix(message));
}

/**
 * Logs a sanitized Git operation warning and optionally shows a user-facing warning.
 *
 * The original error message is written to the IntelliGit output channel for support
 * diagnostics; stack traces are sanitized before logging. UI warnings are best-effort
 * and only shown when the VS Code API is available.
 */
export function logGitOpsWarning(
    context: string,
    err: unknown,
    options?: GitOpsWarningOptions,
): void {
    const channel = getOutputChannel();
    const message = getErrorMessage(err);
    channel.appendLine(`[GitOps] ${context}: ${message}`);
    if (err instanceof Error && err.stack) {
        channel.appendLine(sanitizeErrorMessage(err.stack));
    }
    if (options?.userWarningMessage) {
        const vscode = getVsCodeApi();
        if (vscode) {
            showTimedWarningMessage(vscode, options.userWarningMessage);
        }
    }
}

/** Returns the localized warning shown when commit-level numstat cannot be read. */
export function commitStatsUnavailableMessage(): string {
    const vscode = getVsCodeApi();
    return vscode
        ? vscode.l10n.t("Some commit change stats may be unavailable.")
        : "Some commit change stats may be unavailable.";
}

/** Returns the localized warning shown when unstaged working-tree stats are unavailable. */
export function unstagedStatsUnavailableMessage(): string {
    const vscode = getVsCodeApi();
    return vscode
        ? vscode.l10n.t("Some unstaged change stats may be unavailable.")
        : "Some unstaged change stats may be unavailable.";
}

/** Returns the localized warning shown when staged working-tree stats are unavailable. */
export function stagedStatsUnavailableMessage(): string {
    const vscode = getVsCodeApi();
    return vscode
        ? vscode.l10n.t("Some staged change stats may be unavailable.")
        : "Some staged change stats may be unavailable.";
}

/**
 * Validates a stash index before it is interpolated into a `stash@{n}` ref.
 *
 * @throws When the index is not a non-negative integer.
 */
export function assertStashIndex(index: number): void {
    if (!Number.isInteger(index) || index < 0) {
        throw new Error(`Invalid stash index: ${index}`);
    }
}

/**
 * Converts user- or webview-provided input into a safe repository-relative Git path.
 *
 * Absolute paths, control characters, empty/root selections, and `..` traversal are
 * rejected before the value is embedded in `git show <ref>:<path>` syntax. Backslashes
 * are normalized to Git's slash-separated path form after validation.
 *
 * @throws When the path cannot be represented as a non-root repository-relative path.
 */
export function assertRepoRelativeGitPath(filePath: string): string {
    const trimmed = filePath.trim();
    if (
        !trimmed ||
        trimmed.startsWith("/") ||
        trimmed.startsWith("\\") ||
        /^[a-zA-Z]:[\\/]/.test(trimmed)
    ) {
        throw new Error(`Rejected non-relative path: ${filePath}`);
    }
    if (/[\0\r\n]/.test(trimmed)) {
        throw new Error(`Rejected path containing control characters: ${filePath}`);
    }
    const normalized = trimmed.replace(/\\/g, "/");
    const segments = normalized.split("/").filter((segment) => segment && segment !== ".");
    if (segments.length === 0) {
        throw new Error(`Rejected repo root path: ${filePath}`);
    }
    if (segments.some((segment) => segment === "..")) {
        throw new Error(`Rejected path escaping repo root: ${filePath}`);
    }
    return segments.join("/");
}
