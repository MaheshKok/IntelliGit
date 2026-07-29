import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import * as vscode from "vscode";
import type { DiffForPathsResult } from "../git/operations";

/** Limits any single repository instruction file before it reaches the prompt. */
const MAX_INSTRUCTION_FILE_BYTES = 8_000;
/** Limits all repository instruction files combined before they reach the prompt. */
const MAX_INSTRUCTION_TOTAL_BYTES = 16_000;
/** Bounds mutable prompt context before model-specific token fitting. */
const MAX_MUTABLE_CONTEXT_CHARS = 40_000;
/** Reserves output tokens so the generated message is not starved by input context. */
const OUTPUT_TOKEN_MARGIN = 64;
const CANCELLATION_MESSAGE = "Commit-message generation was cancelled.";
const FINAL_OUTPUT_CONTRACT =
    "Output exactly a concise subject line followed by an optional body, with no Markdown/code fences.";

type PromptContext = {
    diff: string;
    summarizedPaths: readonly string[];
    truncated: boolean;
    subjects: readonly string[];
    instructions: readonly string[];
    wasTrimmed: boolean;
};

/** Stable error kinds that the future host layer can map without depending on VS Code error codes. */
export type CommitMessageGenerationErrorKind =
    | "copilotUnavailable"
    | "notFound"
    | "noPermissions"
    | "blocked"
    | "unknown"
    | "cancelled"
    | "promptTooLarge"
    | "emptyResult";

/**
 * Base error for the P3 generator's stable failure surface.
 *
 * @public consumed by later host wiring that turns generator failures into errorKind values.
 */
export class GenerationRequestError extends Error {
    /** Creates a stable generator error while retaining the original failure as its cause. */
    constructor(
        readonly kind: CommitMessageGenerationErrorKind,
        message: string,
        options?: ErrorOptions,
    ) {
        super(message, options);
        this.name = "GenerationRequestError";
    }
}

/**
 * Raised when VS Code returns no Copilot language model.
 *
 * @public consumed by later host wiring.
 */
export class CopilotUnavailableError extends GenerationRequestError {
    /** Creates the stable unavailable-model failure. */
    constructor() {
        super("copilotUnavailable", "No Copilot language model is available.");
        this.name = "CopilotUnavailableError";
    }
}

/**
 * Raised when the protected prompt cannot fit the selected model's input budget.
 *
 * @public consumed by later host wiring.
 */
export class PromptTooLargeError extends GenerationRequestError {
    /** Creates the stable over-budget failure. */
    constructor() {
        super("promptTooLarge", "The commit-message prompt cannot fit the selected model.");
        this.name = "PromptTooLargeError";
    }
}

/**
 * Raised when a completed model stream contains no non-whitespace text.
 *
 * @public consumed by later host wiring.
 */
export class EmptyResultError extends GenerationRequestError {
    /** Creates the stable empty-completion failure. */
    constructor() {
        super("emptyResult", "Copilot returned an empty commit message.");
        this.name = "EmptyResultError";
    }
}

/** Inputs required to prepare, but not yet consume, a Copilot commit-message response. */
export interface PrepareCommitMessageGenerationOptions {
    /** Target repository workspace configuration scope and safe root for instruction files. */
    workspaceFolder: vscode.WorkspaceFolder;
    /** Bounded selected-path diff data supplied by P2. */
    diffResult: DiffForPathsResult;
    /** Current-HEAD subjects supplied by P4 for style context only. */
    commitSubjects: readonly string[];
    /** Whether the message describes an amendment rather than a normal commit. */
    amend: boolean;
    /** Request cancellation propagated to selection, fitting, sending, and stream consumption. */
    token: vscode.CancellationToken;
    /** Optional deterministic logger for nonfatal instruction-entry skips. */
    logger?: (message: string) => void;
}

/** Awaitable pre-start output that P4 can obtain before it emits its start event. */
export interface PreparedCommitMessageGeneration {
    /** Copilot model selected before any prompt fitting begins. */
    model: vscode.LanguageModelChat;
    /** Fitted prompt that was supplied to the model. */
    prompt: string;
    /** Async text-only response stream that can still fail while it is consumed. */
    text: AsyncIterable<string>;
}

/**
 * Builds the deterministic, model-facing commit-message prompt from already-normalized context.
 * The function has no I/O and always retains the final output contract.
 *
 * @public consumed by the later commit-message coordinator.
 */
export function buildCommitMessagePrompt(
    instructions: readonly string[],
    diffResult: DiffForPathsResult,
    commitSubjects: readonly string[],
    amend: boolean,
): string {
    return [
        "Generate a commit message for the selected checked paths.",
        `This is a ${amend ? "commit amendment" : "normal commit"}.`,
        "Selected-path unified diff:",
        diffResult.diff || "(No patch text was available.)",
        diffResult.summarizedPaths.length > 0
            ? `Change-carrying paths summarized outside the patch: ${diffResult.summarizedPaths.join(", ")}.`
            : "",
        diffResult.truncated
            ? "The selected-path diff was truncated; account for the summaries."
            : "",
        "Recent commit subjects (style context only):",
        ...commitSubjects,
        "Repository commit-message instructions:",
        ...instructions,
        FINAL_OUTPUT_CONTRACT,
    ]
        .filter(Boolean)
        .join("\n");
}

/** Loads normalized instructions from the target repository configuration without letting files escape it. */
async function loadInstructions(
    workspaceFolder: vscode.WorkspaceFolder,
    token: vscode.CancellationToken,
    logger: (message: string) => void,
): Promise<string[]> {
    const raw = vscode.workspace
        .getConfiguration("github.copilot.chat.commitMessageGeneration", workspaceFolder.uri)
        .get<unknown>("instructions");
    if (!Array.isArray(raw)) return [];

    throwIfCancelled(token);
    const root = await realpath(workspaceFolder.uri.fsPath);
    throwIfCancelled(token);
    const instructions: string[] = [];
    let totalBytes = 0;
    for (const entry of raw) {
        throwIfCancelled(token);
        if (!isSingleInstructionEntry(entry)) {
            logger("Skipped an invalid commit-message instruction entry.");
            continue;
        }
        if ("text" in entry) {
            const text = entry.text.trim();
            if (text) instructions.push(text);
            else logger("Skipped an invalid commit-message instruction entry.");
            continue;
        }
        const loaded = await readInstructionFile(root, entry.file, totalBytes, token, logger);
        throwIfCancelled(token);
        if (loaded === undefined) continue;
        totalBytes += loaded.bytes;
        instructions.push(loaded.text);
    }
    return instructions;
}

/** Narrows the supported exactly-one-field instruction schema before any file access occurs. */
function isSingleInstructionEntry(entry: unknown): entry is { text: string } | { file: string } {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return false;
    const values = entry as Record<string, unknown>;
    const keys = Object.keys(values);
    return (
        keys.length === 1 &&
        ((keys[0] === "text" && typeof values.text === "string") ||
            (keys[0] === "file" && typeof values.file === "string"))
    );
}

/** Reads a regular in-root instruction file through a capped descriptor read, never readFile. */
async function readInstructionFile(
    root: string,
    relativePath: string,
    usedBytes: number,
    token: vscode.CancellationToken,
    logger: (message: string) => void,
): Promise<{ text: string; bytes: number } | undefined> {
    throwIfCancelled(token);
    if (
        !relativePath.trim() ||
        path.isAbsolute(relativePath) ||
        relativePath.split(/[\\/]+/).includes("..")
    ) {
        logger("Skipped an invalid commit-message instruction entry.");
        return undefined;
    }
    const candidate = path.resolve(root, relativePath);
    if (!isInside(root, candidate)) {
        logger("Skipped an invalid commit-message instruction entry.");
        return undefined;
    }
    let resolved: string;
    try {
        resolved = await realpath(candidate);
        throwIfCancelled(token);
    } catch {
        logger("Skipped an invalid commit-message instruction entry.");
        return undefined;
    }
    if (!isInside(root, resolved)) {
        logger("Skipped an invalid commit-message instruction entry.");
        return undefined;
    }
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
        const preliminaryMetadata = await lstat(resolved);
        throwIfCancelled(token);
        if (!preliminaryMetadata.isFile()) {
            logger("Skipped an invalid commit-message instruction entry.");
            return undefined;
        }
        handle = await open(resolved, "r");
        throwIfCancelled(token);
        const metadata = await handle.stat();
        throwIfCancelled(token);
        if (
            !metadata.isFile() ||
            metadata.size > MAX_INSTRUCTION_FILE_BYTES ||
            metadata.size + usedBytes > MAX_INSTRUCTION_TOTAL_BYTES
        ) {
            logger("Skipped an invalid commit-message instruction entry.");
            return undefined;
        }
        const buffer = Buffer.alloc(metadata.size + 1);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        throwIfCancelled(token);
        if (
            bytesRead > MAX_INSTRUCTION_FILE_BYTES ||
            bytesRead + usedBytes > MAX_INSTRUCTION_TOTAL_BYTES
        ) {
            logger("Skipped an invalid commit-message instruction entry.");
            return undefined;
        }
        const text = buffer.subarray(0, bytesRead).toString("utf8").trim();
        if (!text) {
            logger("Skipped an invalid commit-message instruction entry.");
            return undefined;
        }
        return { text, bytes: bytesRead };
    } catch (error) {
        if (error instanceof GenerationRequestError) throw error;
        logger("Skipped an invalid commit-message instruction entry.");
        return undefined;
    } finally {
        await handle?.close();
    }
}

/** Returns whether a resolved path remains strictly within the repository root. */
function isInside(root: string, candidate: string): boolean {
    const relative = path.relative(root, candidate);
    return (
        relative !== "" &&
        !relative.startsWith(`..${path.sep}`) &&
        relative !== ".." &&
        !path.isAbsolute(relative)
    );
}

/** Selects the first available model according to the intentionally small preference order. */
function chooseModel(models: readonly vscode.LanguageModelChat[]): vscode.LanguageModelChat {
    const preference = ["gpt-4o", "gpt-4.1", "gpt-4"];
    return (
        preference
            .map((family) => models.find((model) => model.family.toLowerCase().includes(family)))
            .find((model): model is vscode.LanguageModelChat => model !== undefined) ?? models[0]
    );
}

/** Throws the stable cancellation error at every await boundary. */
function throwIfCancelled(token: vscode.CancellationToken): void {
    if (token.isCancellationRequested) {
        throw new GenerationRequestError("cancelled", CANCELLATION_MESSAGE);
    }
}

/** Races non-cancellable VS Code work with cancellation and discards an orphaned eventual result. */
async function awaitWithCancellation<T>(
    operation: Thenable<T> | PromiseLike<T>,
    token: vscode.CancellationToken,
): Promise<T> {
    throwIfCancelled(token);
    return new Promise<T>((resolve, reject) => {
        const subscription = token.onCancellationRequested(() => {
            subscription.dispose();
            reject(new Error(CANCELLATION_MESSAGE));
        });
        Promise.resolve(operation).then(
            (value) => {
                subscription.dispose();
                resolve(value);
            },
            (error: unknown) => {
                subscription.dispose();
                if (error instanceof Error) reject(error);
                else reject(new Error("Copilot model selection failed."));
            },
        );
    });
}

/** Maps raw LM and cancellation failures to the stable P3 error surface. */
function toGenerationError(error: unknown): GenerationRequestError {
    if (error instanceof GenerationRequestError) return error;
    const code =
        typeof error === "object" && error !== null
            ? (error as { code?: unknown }).code
            : undefined;
    const name =
        typeof error === "object" && error !== null
            ? (error as { name?: unknown }).name
            : undefined;
    const kind =
        code === "NotFound"
            ? "notFound"
            : code === "NoPermissions"
              ? "noPermissions"
              : code === "Blocked"
                ? "blocked"
                : code === "Cancelled" ||
                    code === "Canceled" ||
                    name === "CancellationError" ||
                    (error instanceof Error && error.message === CANCELLATION_MESSAGE)
                  ? "cancelled"
                  : "unknown";
    return new GenerationRequestError(kind, "Copilot commit-message generation failed.", {
        cause: error,
    });
}

/** Builds an internal prompt after fitting mutable data while preserving the immutable output contract. */
function buildPrompt(context: PromptContext, amend: boolean): string {
    return [
        "Generate a commit message for the selected checked paths.",
        `This is a ${amend ? "commit amendment" : "normal commit"}.`,
        context.wasTrimmed ? "Prompt context was truncated to fit the selected Copilot model." : "",
        "Selected-path unified diff:",
        context.diff || "(No patch text was available.)",
        context.summarizedPaths.length > 0
            ? `Change-carrying paths summarized outside the patch: ${context.summarizedPaths.join(", ")}.`
            : "",
        context.truncated ? "The selected-path diff was truncated; account for the summaries." : "",
        "Recent commit subjects (style context only):",
        ...context.subjects,
        "Repository commit-message instructions:",
        ...context.instructions,
        FINAL_OUTPUT_CONTRACT,
    ]
        .filter(Boolean)
        .join("\n");
}

/** Reduces mutable input proportionally while leaving structural and output instructions untouched. */
function capContext(context: PromptContext, cap: number): PromptContext {
    const parts = [
        context.diff,
        context.summarizedPaths.join("\n"),
        context.subjects.join("\n"),
        context.instructions.join("\n"),
    ];
    const total = parts.reduce((sum, part) => sum + part.length, 0);
    if (total <= cap) return context;
    const limit = (value: string) =>
        value.slice(0, Math.max(0, Math.floor((value.length / total) * cap)));
    const diff = limit(context.diff);
    const summaries = limit(context.summarizedPaths.join("\n")).split("\n").filter(Boolean);
    const subjects = limit(context.subjects.join("\n")).split("\n").filter(Boolean);
    const instructions = limit(context.instructions.join("\n")).split("\n").filter(Boolean);
    return {
        ...context,
        diff,
        summarizedPaths: summaries,
        subjects,
        instructions,
        wasTrimmed: true,
    };
}

/** Counts the mutable characters that remain eligible for proportional token-fit trimming. */
function mutableContextChars(context: PromptContext): number {
    return (
        context.diff.length +
        context.summarizedPaths.join("\n").length +
        context.subjects.join("\n").length +
        context.instructions.join("\n").length
    );
}

/**
 * Selects, safely prepares, token-fits, and starts a text-only Copilot response before P4 emits start.
 * It throws stable typed failures and never starts a request whose measured prompt exceeds the input budget.
 *
 * @public consumed by the later commit-message coordinator.
 */
export async function prepareCommitMessageGeneration(
    options: PrepareCommitMessageGenerationOptions,
): Promise<PreparedCommitMessageGeneration> {
    const logger = options.logger ?? console.warn;
    try {
        const models = await awaitWithCancellation(
            vscode.lm.selectChatModels({ vendor: "copilot" }),
            options.token,
        );
        throwIfCancelled(options.token);
        if (models.length === 0) throw new CopilotUnavailableError();
        const model = chooseModel(models);
        const instructions = await loadInstructions(options.workspaceFolder, options.token, logger);
        throwIfCancelled(options.token);
        const original: PromptContext = {
            diff: options.diffResult.diff,
            summarizedPaths: options.diffResult.summarizedPaths,
            truncated: options.diffResult.truncated,
            subjects: options.commitSubjects.slice(0, 10),
            instructions,
            wasTrimmed: false,
        };
        const budget = model.maxInputTokens - OUTPUT_TOKEN_MARGIN;
        if (budget <= 0) throw new PromptTooLargeError();
        let context = capContext(original, MAX_MUTABLE_CONTEXT_CHARS);
        let prompt = buildPrompt(context, options.amend);
        for (let attempt = 0; attempt < 3; attempt += 1) {
            const tokenCount = await model.countTokens(prompt, options.token);
            throwIfCancelled(options.token);
            if (tokenCount <= budget) {
                const response = await model.sendRequest(
                    [vscode.LanguageModelChatMessage.User(prompt)],
                    undefined,
                    options.token,
                );
                throwIfCancelled(options.token);
                return { model, prompt, text: textOnlyStream(response.text, options.token) };
            }
            if (attempt === 2) break;
            const currentMutableChars = mutableContextChars(context);
            const proportionalCap = Math.floor((currentMutableChars * budget * 0.98) / tokenCount);
            context = capContext(
                context,
                Math.max(0, Math.min(currentMutableChars - 1, proportionalCap)),
            );
            prompt = buildPrompt(context, options.amend);
        }
        throw new PromptTooLargeError();
    } catch (error) {
        throw toGenerationError(error);
    }
}

/** Consumes only response.text, preserving chunks and translating stream-time failures. */
async function* textOnlyStream(
    text: AsyncIterable<string>,
    token: vscode.CancellationToken,
): AsyncIterable<string> {
    let hasContent = false;
    try {
        for await (const chunk of text) {
            throwIfCancelled(token);
            if (chunk.trim()) hasContent = true;
            yield chunk;
        }
        throwIfCancelled(token);
        if (!hasContent) throw new EmptyResultError();
    } catch (error) {
        throw toGenerationError(error);
    }
}
