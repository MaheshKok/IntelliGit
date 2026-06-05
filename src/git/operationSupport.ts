import { getErrorMessage, sanitizeErrorMessage } from "../utils/errors";

declare const require: (id: string) => unknown;

const OUTPUT_CHANNEL_NAME = "IntelliGit";

type VsCodeApi = typeof import("vscode");
type OutputChannelLike = { appendLine: (value: string) => void };
export type GitOpsWarningOptions = { userWarningMessage?: string };

let cachedVsCodeApi: VsCodeApi | null | undefined;
let outputChannel: OutputChannelLike | undefined;

export function getVsCodeApi(): VsCodeApi | null {
    if (cachedVsCodeApi !== undefined) return cachedVsCodeApi;
    try {
        cachedVsCodeApi = require("vscode") as VsCodeApi;
    } catch {
        cachedVsCodeApi = null;
    }
    return cachedVsCodeApi;
}

function getOutputChannel(): OutputChannelLike {
    if (outputChannel) return outputChannel;
    const vscode = getVsCodeApi();
    outputChannel = vscode
        ? vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME)
        : { appendLine: (value: string) => console.warn(value) };
    return outputChannel;
}

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
            void vscode.window.showWarningMessage(options.userWarningMessage);
        }
    }
}

export function commitStatsUnavailableMessage(): string {
    const vscode = getVsCodeApi();
    return vscode
        ? vscode.l10n.t("Some commit change stats may be unavailable.")
        : "Some commit change stats may be unavailable.";
}

export function unstagedStatsUnavailableMessage(): string {
    const vscode = getVsCodeApi();
    return vscode
        ? vscode.l10n.t("Some unstaged change stats may be unavailable.")
        : "Some unstaged change stats may be unavailable.";
}

export function stagedStatsUnavailableMessage(): string {
    const vscode = getVsCodeApi();
    return vscode
        ? vscode.l10n.t("Some staged change stats may be unavailable.")
        : "Some staged change stats may be unavailable.";
}

export function assertStashIndex(index: number): void {
    if (!Number.isInteger(index) || index < 0) {
        throw new Error(`Invalid stash index: ${index}`);
    }
}

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
