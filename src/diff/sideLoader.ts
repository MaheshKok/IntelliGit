import * as path from "node:path";
import { TextDecoder } from "node:util";
import * as vscode from "vscode";
import { GitExecutor } from "../git/executor";
import { isMissingGitPathError } from "../git/operations";
import { getErrorMessage } from "../utils/errors";
import { assertRepoRelativePath } from "../utils/fileOps";
import { MAX_DIFF_BYTES } from "./diffBudgets";
import type { ProviderLoadResult, SideSpec } from "./unifiedDiffTypes";

type SideIneligibleReason = "binary" | "invalid-utf8" | "symlink" | "submodule";

interface LoadedDiffSide {
    readonly status: "loaded";
    readonly bytes: Uint8Array;
    readonly mode: number | undefined;
    readonly text: string;
    readonly lineCount: number;
}

type SideLoadResult =
    | LoadedDiffSide
    | { readonly status: "missing" }
    | { readonly status: "over-budget"; readonly size: number }
    | { readonly status: "ineligible"; readonly reason: SideIneligibleReason };

/** Inputs for one bounded side load. */
export interface SideLoaderOptions {
    readonly repoRoot: string;
    readonly filePath: string;
    readonly side: SideSpec;
    readonly maxBytes?: number;
    readonly executor?: Pick<GitExecutor, "runBinary">;
}

interface RawSide {
    readonly status: "loaded";
    readonly bytes: Uint8Array;
    readonly mode: number | undefined;
    readonly knownBinary?: boolean;
}

type RawIneligible = { readonly status: "ineligible"; readonly reason: SideIneligibleReason };

type RawLoadResult =
    | RawSide
    | RawIneligible
    | { readonly status: "missing" }
    | { readonly status: "over-budget"; readonly size: number };

const DEFAULT_MAX_BYTES = MAX_DIFF_BYTES;

/** Loads every supported side byte-first, applying the size probe before full content acquisition. */
export async function loadDiffSide(options: SideLoaderOptions): Promise<SideLoadResult> {
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    const filePath = assertRepoRelativePath(options.filePath);
    const raw = await loadRawSide({ ...options, filePath, maxBytes });
    if (raw.status !== "loaded") return raw;
    if (raw.knownBinary || containsNul(raw.bytes))
        return { status: "ineligible", reason: "binary" };
    if (raw.mode === 0o120000) return { status: "ineligible", reason: "symlink" };
    if (raw.mode === 0o160000) return { status: "ineligible", reason: "submodule" };

    let text: string;
    try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(raw.bytes);
    } catch {
        return { status: "ineligible", reason: "invalid-utf8" };
    }
    return {
        status: "loaded",
        bytes: raw.bytes,
        mode: raw.mode,
        text,
        lineCount: countLines(raw.bytes),
    };
}

async function loadRawSide(
    options: SideLoaderOptions & { readonly filePath: string; readonly maxBytes: number },
): Promise<RawLoadResult> {
    if (options.side.kind === "provider") return loadProvider(options.side.load, options.maxBytes);
    if (options.side.kind === "ref") {
        return loadRef(
            options.repoRoot,
            options.side.ref,
            options.filePath,
            options.maxBytes,
            options.executor,
        );
    }
    return loadWorktree(options.repoRoot, options.filePath, options.maxBytes);
}

async function loadProvider(
    load: (maxOutputBytes: number) => Promise<ProviderLoadResult>,
    maxBytes: number,
): Promise<RawLoadResult> {
    const result = await load(maxBytes);
    if (result.status === "missing" || result.status === "over-budget") return result;
    if (result.bytes.byteLength > maxBytes)
        return { status: "over-budget", size: result.bytes.byteLength };
    return {
        status: "loaded",
        bytes: result.bytes,
        mode: result.mode,
        knownBinary: result.binary,
    };
}

async function loadRef(
    repoRoot: string,
    ref: string,
    filePath: string,
    maxBytes: number,
    suppliedExecutor?: Pick<GitExecutor, "runBinary">,
): Promise<RawLoadResult> {
    const trimmedRef = ref.trim();
    if (!trimmedRef || trimmedRef.startsWith("-") || /[\0\r\n]/.test(trimmedRef)) {
        throw new Error("Rejected unsafe Git ref for diff side.");
    }
    const executor = suppliedExecutor ?? new GitExecutor(repoRoot);
    const objectPath = `${trimmedRef}:${filePath}`;
    let size: number;
    try {
        const result = await executor.runBinary(["cat-file", "-s", objectPath], {
            maxOutputBytes: 64,
        });
        size = parseSize(result.stdout);
    } catch (error) {
        if (isMissingGitPathError(getErrorMessage(error).toLowerCase()))
            return { status: "missing" };
        throw error;
    }
    if (size > maxBytes) return { status: "over-budget", size };

    const mode = await readGitMode(executor, trimmedRef, filePath);
    if (mode === 0o120000) return { status: "ineligible", reason: "symlink" };
    if (mode === 0o160000) return { status: "ineligible", reason: "submodule" };
    const content = await executor.runBinary(["cat-file", "-p", objectPath], {
        maxOutputBytes: maxBytes,
    });
    if (content.truncated || content.stdout.byteLength > maxBytes) {
        return { status: "over-budget", size: Math.max(size, content.stdout.byteLength) };
    }
    return { status: "loaded", bytes: content.stdout, mode };
}

async function readGitMode(
    executor: Pick<GitExecutor, "runBinary">,
    ref: string,
    filePath: string,
): Promise<number> {
    const result = await executor.runBinary(["ls-tree", "-z", ref.trim(), "--", filePath], {
        maxOutputBytes: 4096,
    });
    if (result.truncated) throw new Error("Git returned an incomplete file mode record.");
    const record = result.stdout.toString("utf8").split("\0")[0] ?? "";
    const modeText = record.split(" ", 1)[0];
    const mode = Number.parseInt(modeText, 8);
    if (!Number.isInteger(mode)) throw new Error("Git returned an invalid file mode record.");
    return mode;
}

async function loadWorktree(
    repoRoot: string,
    filePath: string,
    maxBytes: number,
): Promise<
    | RawSide
    | RawIneligible
    | { readonly status: "missing" }
    | { readonly status: "over-budget"; readonly size: number }
> {
    const file = vscode.Uri.joinPath(vscode.Uri.file(path.resolve(repoRoot)), filePath);
    let stat: vscode.FileStat;
    try {
        stat = await vscode.workspace.fs.stat(file);
    } catch (error) {
        if (isFileNotFoundError(error)) return { status: "missing" };
        throw error;
    }
    if ((stat.type & vscode.FileType.SymbolicLink) !== 0) {
        return { status: "loaded", bytes: new Uint8Array(), mode: 0o120000 };
    }
    if ((stat.type & vscode.FileType.Directory) !== 0) {
        return { status: "ineligible", reason: "submodule" };
    }

    const openDocument = vscode.workspace.textDocuments.find(
        (document) => document.uri.toString() === file.toString(),
    );
    if (openDocument !== undefined) {
        const text = openDocument.getText();
        const size = Buffer.byteLength(text, "utf8");
        if (size > maxBytes) return { status: "over-budget", size };
        const bytes = Buffer.from(text, "utf8");
        return { status: "loaded", bytes, mode: undefined };
    }

    if (stat.size > maxBytes) return { status: "over-budget", size: stat.size };

    try {
        const bytes = await vscode.workspace.fs.readFile(file);
        if (bytes.byteLength > maxBytes) return { status: "over-budget", size: bytes.byteLength };
        return { status: "loaded", bytes, mode: undefined };
    } catch (error) {
        if (isFileNotFoundError(error)) return { status: "missing" };
        throw error;
    }
}

function parseSize(stdout: Uint8Array): number {
    const value = Number.parseInt(Buffer.from(stdout).toString("ascii").trim(), 10);
    if (!Number.isSafeInteger(value) || value < 0)
        throw new Error("Git returned an invalid file size.");
    return value;
}

function containsNul(bytes: Uint8Array): boolean {
    return bytes.includes(0);
}

/**
 * Counts logical lines using the loader's trailing-newline convention.
 *
 * A final LF or CR is a terminator, not an additional empty line, matching the
 * line count used for viewer budget enforcement.
 */
export function countLines(bytes: Uint8Array): number {
    if (bytes.byteLength === 0) return 0;
    let lines = 1;
    for (let index = 0; index < bytes.byteLength; index++) {
        if (bytes[index] === 10) lines++;
        if (bytes[index] === 13 && bytes[index + 1] !== 10) lines++;
    }
    return bytes[bytes.byteLength - 1] === 10 || bytes[bytes.byteLength - 1] === 13
        ? lines - 1
        : lines;
}

function isFileNotFoundError(error: unknown): boolean {
    return (
        typeof error === "object" &&
        error !== null &&
        (("code" in error && error.code === "FileNotFound") ||
            ("message" in error &&
                typeof error.message === "string" &&
                error.message.includes("Unable to resolve nonexistent file")))
    );
}
