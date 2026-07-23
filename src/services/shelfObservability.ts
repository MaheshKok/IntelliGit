import { getErrorMessage, sanitizeErrorMessage } from "../utils/errors";

declare const require: (id: string) => unknown;
type VsCodeApi = typeof import("vscode");
type OutputChannelLike = { appendLine(value: string): void };
let cachedVsCodeApi: VsCodeApi | null | undefined;
let outputChannel: OutputChannelLike | undefined;

function getVsCodeApi(): VsCodeApi | null {
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

function channel(): OutputChannelLike {
    if (!outputChannel) {
        outputChannel = getVsCodeApi()?.window.createOutputChannel("IntelliGit Shelf") ?? {
            appendLine: (value) => console.warn(value),
        };
    }
    return outputChannel;
}

/** Identifies one shelf operation for a log line; never carries patch contents. */
export interface ShelfOperationLogContext {
    readonly operation: string;
    readonly repositoryRoot: string;
}

/** Safe result metadata for one completed shelf operation. */
export interface ShelfOperationLogResult {
    readonly status?: string;
    readonly shelfId?: string;
    readonly newGeneration?: number;
    readonly entries?: readonly { readonly kind: string; readonly path?: string }[];
}

/** Logs one safe shelf-operation summary line: paths, outcomes, and generations only. */
export function logShelfOperation(
    context: ShelfOperationLogContext,
    result: ShelfOperationLogResult,
): void {
    const entries = result.entries ?? [];
    const countsByKind = new Map<string, number>();
    for (const entry of entries) {
        countsByKind.set(entry.kind, (countsByKind.get(entry.kind) ?? 0) + 1);
    }
    const counts = [...countsByKind].map(([kind, count]) => `${kind}:${count}`).join(",");
    const pending = entries
        .filter((entry) => entry.kind === "structuralPending" && entry.path)
        .map((entry) => entry.path)
        .join(",");
    channel().appendLine(
        `[Shelf] operation=${context.operation} repository=${context.repositoryRoot} ` +
            `status=${result.status ?? ""} shelfId=${result.shelfId ?? ""} ` +
            `generation=${result.newGeneration ?? ""} entries=${counts} structuralPending=${pending}`,
    );
}

/** Logs a sanitized shelf warning with a flattened message and redacted stack. */
export function logShelfWarning(context: string, err: unknown): void {
    channel().appendLine(`[Shelf] ${context}: ${getErrorMessage(err).replace(/\s+/g, " ")}`);
    if (err instanceof Error && err.stack) channel().appendLine(sanitizeErrorMessage(err.stack));
}
