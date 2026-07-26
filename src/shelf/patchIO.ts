import { stat } from "node:fs/promises";
import { classifyPatchHeader } from "./patchClassification";

/** Frozen Git diff switches required for applyable shelf artifacts. */
export const PATCH_GENERATION_FLAGS = [
    "--binary",
    "--full-index",
    "-M",
    "--no-textconv",
    "--no-ext-diff",
    "--no-color",
] as const;

/** Minimal byte-safe Git surface used by shelf patch primitives. */
export interface ShelfPatchGit {
    runBinary(
        args: string[],
        options: { outputFile?: string; expectedExitCodes?: readonly number[] },
    ): Promise<{ readonly stdout: Buffer; readonly stderr: Buffer; readonly exitCode: number }>;
    run(args: string[]): Promise<string>;
}

/** Destination paths for independent staged and worktree patch streams. */
export interface LayerPatchPaths {
    readonly indexPatchPath: string;
    readonly worktreePatchPath: string;
    readonly paths?: readonly string[];
}

/** Destination for one untracked-file patch, a labeled IntelliGit extension. */
export interface UntrackedPatchPath {
    readonly patchPath: string;
    readonly relativePath: string;
}

/**
 * Streams two applyable patch layers directly from Git into caller-owned files.
 *
 * Patch bytes never enter a JavaScript string: runBinary streams stdout to each
 * output path and only Git arguments are represented as strings here.
 */
export async function generateLayerPatches(
    git: ShelfPatchGit,
    destinations: LayerPatchPaths,
): Promise<void> {
    const pathspec = destinations.paths?.length ? ["--", ...destinations.paths] : [];
    await git.runBinary(["diff", "--cached", ...PATCH_GENERATION_FLAGS, ...pathspec], {
        outputFile: destinations.indexPatchPath,
    });
    await git.runBinary(["diff", ...PATCH_GENERATION_FLAGS, ...pathspec], {
        outputFile: destinations.worktreePatchPath,
    });
}

/**
 * Streams an untracked-file creation patch without decoding its bytes.
 *
 * `diff --no-index` reports a difference with exit status one; that result is
 * expected and not a failed capture. The caller must pass a repository-relative
 * path so Git emits applyable `a/`/`b/` patch names rather than host paths.
 */
export async function generateUntrackedPatch(
    git: ShelfPatchGit,
    destination: UntrackedPatchPath,
): Promise<void> {
    if (!destination.relativePath || destination.relativePath.startsWith("/")) {
        throw new Error("Untracked patch path must be repository-relative.");
    }
    await git.runBinary(
        [
            "diff",
            "--no-index",
            ...PATCH_GENERATION_FLAGS,
            "--",
            "/dev/null",
            destination.relativePath,
        ],
        { expectedExitCodes: [0, 1], outputFile: destination.patchPath },
    );
}

/**
 * Materializes layers in captured order for fidelity checks.
 *
 * Index patch first reconstructs captured index. checkout-index then makes that
 * index worktree preimage before applying index-to-worktree bytes. This never
 * uses Git three-way apply mode.
 */
export async function materializeLayerPatches(
    git: ShelfPatchGit,
    patches: Pick<LayerPatchPaths, "indexPatchPath" | "worktreePatchPath">,
): Promise<void> {
    if (await hasPatchBytes(patches.indexPatchPath)) {
        // The mutation is permitted only after its matching check succeeds on the same index state.
        // react-doctor-disable-next-line react-doctor/async-parallel
        await git.run(["apply", "--check", "--cached", patches.indexPatchPath]);
        await git.run(["apply", "--cached", patches.indexPatchPath]);
        // Apply the same base-to-index bytes to the clean worktree before checkout-index:
        // checkout-index does not remove paths absent from the materialized index.
        await git.run(["apply", "--check", patches.indexPatchPath]);
        await git.run(["apply", patches.indexPatchPath]);
    }
    await git.run(["checkout-index", "--all", "--force"]);
    if (await hasPatchBytes(patches.worktreePatchPath)) {
        await git.run(["apply", "--check", patches.worktreePatchPath]);
        await git.run(["apply", patches.worktreePatchPath]);
    }
}

async function hasPatchBytes(filePath: string): Promise<boolean> {
    return (await stat(filePath)).size > 0;
}

/** Byte ranges for a logical patch change; rename source and destination stay together. */
export interface IndexedPatchBlock {
    readonly changeId: string;
    readonly start: number;
    readonly end: number;
    readonly path: string;
    readonly renamedFrom: string | undefined;
}

const DIFF_HEADER = Buffer.from("diff --git ");
const RENAME_TO_HEADER = Buffer.from("\nrename to ");
const PLAIN_UNIFIED_SOURCE_HEADER = Buffer.from("--- ");
const DESTINATION_HEADER = Buffer.from("\n+++ ");
const HUNK_HEADER = Buffer.from("@@ ");
const LINE_FEED = 0x0a;
const SPACE = 0x20;
const TAB = 0x09;
const QUOTE = 0x22;
const BACKSLASH = 0x5c;

/** Raised when a patch header cannot provide a safe, unambiguous destination path. */
class ShelfPatchPathError extends Error {
    /** Creates a metadata-only parse failure without exposing patch content. */
    constructor() {
        super("Patch block has no safe destination path.");
        this.name = "ShelfPatchPathError";
    }
}

/**
 * Locates logical Git diff blocks without converting patch payloads to text.
 *
 * Header fields are decoded only for metadata; callers select raw byte ranges,
 * so binary hunks and their offsets are preserved verbatim.
 */
export function indexPatchBlocks(patch: Buffer): readonly IndexedPatchBlock[] {
    const starts = findDiffHeaderOffsets(patch);
    if (starts.length === 0) starts.push(...findPlainUnifiedHeaderOffsets(patch));
    return starts.map((start, index) => {
        const end = starts[index + 1] ?? patch.length;
        const block = patch.subarray(start, end);
        const renamedFrom = classifyPatchHeader(block).renamedFrom;
        const path =
            readDestinationPath(block) ??
            readHeaderValue(block, RENAME_TO_HEADER) ??
            readDiffHeaderDestination(block) ??
            readDeletionSourcePath(block);
        if (!path) throw new ShelfPatchPathError();
        return {
            changeId: `patch-${index}`,
            start,
            end,
            path,
            renamedFrom,
        };
    });
}

/** Selects whole diff blocks only, retaining atomic rename pairs and raw bytes. */
export function selectPatchBlocks(
    patch: Buffer,
    blocks: readonly IndexedPatchBlock[],
    selectedChangeIds: readonly string[],
): Buffer {
    const selected = new Set(selectedChangeIds);
    const selectedBlocks: Buffer[] = [];
    for (const block of blocks) {
        if (selected.has(block.changeId))
            selectedBlocks.push(patch.subarray(block.start, block.end));
    }
    return Buffer.concat(selectedBlocks);
}

/**
 * Reads the unified-diff destination before falling back to rename and diff headers.
 *
 * Git C-style quoted paths from core.quotePath are decoded for metadata only.
 * Invalid UTF-8 or ambiguous unquoted binary headers are rejected rather than
 * silently assigning a wrong path to a raw patch block.
 */
function readDestinationPath(block: Buffer): string | undefined {
    const destination = readHeaderValue(block, DESTINATION_HEADER);
    return destination ? stripDestinationPrefix(destination) : undefined;
}

function readDeletionSourcePath(block: Buffer): string | undefined {
    if (readHeaderValue(block, DESTINATION_HEADER) !== "/dev/null") return undefined;
    const source = readHeaderValue(block, PLAIN_UNIFIED_SOURCE_HEADER);
    return source ? stripSourcePrefix(source) : undefined;
}

function readHeaderValue(block: Buffer, header: Buffer): string | undefined {
    const line = readLineAfterHeader(block, header);
    return line ? decodePatchLinePath(line) : undefined;
}

function readDiffHeaderDestination(block: Buffer): string | undefined {
    if (!block.subarray(0, DIFF_HEADER.length).equals(DIFF_HEADER)) return undefined;
    const end = block.indexOf(LINE_FEED, DIFF_HEADER.length);
    const line = block.subarray(DIFF_HEADER.length, end < 0 ? block.length : end);
    const source = readDiffHeaderToken(line, 0);
    const destination = source ? readDiffHeaderToken(line, source.next) : undefined;
    if (source && destination && onlySpaces(line, destination.next)) {
        return stripDestinationPrefix(destination.value);
    }
    return readUnquotedSamePathDestination(line);
}

/**
 * Handles mode-only headers whose unquoted path contains spaces or ` b/`.
 *
 * Git's unquoted `diff --git` header has no delimiter distinct from a path
 * space, so this fallback only accepts a single split where both sides encode
 * the same path. Rename headers and quoted paths use their explicit parsers.
 */
function readUnquotedSamePathDestination(line: Buffer): string | undefined {
    if (line[0] === QUOTE || line[0] !== 0x61 || line[1] !== 0x2f) return undefined;
    const matches: string[] = [];
    for (
        let separator = line.indexOf(Buffer.from(" b/"));
        separator >= 0;
        separator = line.indexOf(Buffer.from(" b/"), separator + 1)
    ) {
        const source = decodeUtf8(line.subarray(0, separator));
        const destination = decodeUtf8(line.subarray(separator + 1));
        const sourcePath = source ? stripSourcePrefix(source) : undefined;
        const destinationPath = destination ? stripDestinationPrefix(destination) : undefined;
        if (sourcePath && destinationPath && sourcePath === destinationPath) {
            matches.push(destinationPath);
        }
    }
    return matches.length === 1 ? matches[0] : undefined;
}

function findDiffHeaderOffsets(patch: Buffer): number[] {
    const offsets: number[] = [];
    for (
        // This is an ordered byte-stream delimiter scan; a Set cannot represent repeated offsets.
        // react-doctor-disable-next-line react-doctor/js-set-map-lookups
        let offset = patch.indexOf(DIFF_HEADER);
        offset >= 0;
        // The next occurrence advances the same byte-stream cursor rather than looking up collection members.
        // react-doctor-disable-next-line react-doctor/js-set-map-lookups
        offset = patch.indexOf(DIFF_HEADER, offset + 1)
    ) {
        if (!isDiffHeaderStart(patch, offset)) continue;
        offsets.push(offset);
    }
    return offsets;
}

function findPlainUnifiedHeaderOffsets(patch: Buffer): number[] {
    const offsets: number[] = [];
    for (
        // This is an ordered byte-stream delimiter scan; a Set cannot represent repeated offsets.
        // react-doctor-disable-next-line react-doctor/js-set-map-lookups
        let offset = patch.indexOf(PLAIN_UNIFIED_SOURCE_HEADER);
        offset >= 0;
        // The next occurrence advances the same byte-stream cursor rather than looking up collection members.
        // react-doctor-disable-next-line react-doctor/js-set-map-lookups
        offset = patch.indexOf(PLAIN_UNIFIED_SOURCE_HEADER, offset + 1)
    ) {
        if (!isPlainUnifiedHeaderStart(patch, offset)) continue;
        offsets.push(offset);
    }
    return offsets;
}

function isPlainUnifiedHeaderStart(patch: Buffer, offset: number): boolean {
    if (offset > 0 && patch[offset - 1] !== LINE_FEED) return false;
    const sourceEnd = patch.indexOf(LINE_FEED, offset);
    if (sourceEnd < 0 || patch.indexOf(DESTINATION_HEADER, sourceEnd) !== sourceEnd) return false;
    const destinationEnd = patch.indexOf(LINE_FEED, sourceEnd + DESTINATION_HEADER.length);
    return (
        destinationEnd >= 0 && patch.indexOf(HUNK_HEADER, destinationEnd + 1) === destinationEnd + 1
    );
}

function isDiffHeaderStart(patch: Buffer, offset: number): boolean {
    if (offset > 0 && patch[offset - 1] !== LINE_FEED) return false;
    const pathStart = offset + DIFF_HEADER.length;
    return (
        patch[pathStart] === QUOTE || (patch[pathStart] === 0x61 && patch[pathStart + 1] === 0x2f)
    );
}

function readLineAfterHeader(block: Buffer, header: Buffer): Buffer | undefined {
    const start = block.indexOf(header);
    if (start < 0) return undefined;
    const valueStart = start + header.length;
    const end = block.indexOf(LINE_FEED, valueStart);
    return block.subarray(valueStart, end < 0 ? block.length : end);
}

function decodePatchLinePath(line: Buffer): string | undefined {
    if (line[0] === QUOTE) {
        const token = readDiffHeaderToken(line, 0);
        return token && onlySpaces(line, token.next) ? token.value : undefined;
    }
    const tab = line.indexOf(TAB);
    return decodeUtf8(line.subarray(0, tab < 0 ? line.length : tab));
}

function readDiffHeaderToken(
    line: Buffer,
    offset: number,
): { readonly value: string; readonly next: number } | undefined {
    let start = offset;
    while (line[start] === SPACE) start += 1;
    if (start >= line.length) return undefined;
    if (line[start] === QUOTE) return decodeQuotedToken(line, start);

    let end = start;
    while (end < line.length && line[end] !== SPACE) end += 1;
    const value = decodeUtf8(line.subarray(start, end));
    return value === undefined ? undefined : { value, next: end };
}

function decodeQuotedToken(
    line: Buffer,
    start: number,
): { readonly value: string; readonly next: number } | undefined {
    const bytes: number[] = [];
    for (let index = start + 1; index < line.length; index += 1) {
        const value = line[index];
        if (value === QUOTE) {
            const decoded = decodeUtf8(Buffer.from(bytes));
            return decoded === undefined ? undefined : { value: decoded, next: index + 1 };
        }
        if (value !== BACKSLASH) {
            bytes.push(value);
            continue;
        }

        const escaped = line[index + 1];
        if (escaped === undefined) return undefined;
        index += 1;
        if (isOctal(escaped)) {
            let octal = String.fromCharCode(escaped);
            while (octal.length < 3 && isOctal(line[index + 1])) {
                index += 1;
                octal += String.fromCharCode(line[index]);
            }
            bytes.push(Number.parseInt(octal, 8));
            continue;
        }
        const replacement = escapedCharacter(escaped);
        if (replacement === undefined) return undefined;
        bytes.push(replacement);
    }
    return undefined;
}

function escapedCharacter(value: number): number | undefined {
    const replacements: Readonly<Record<number, number>> = {
        [BACKSLASH]: BACKSLASH,
        [QUOTE]: QUOTE,
        0x61: 0x07,
        0x62: 0x08,
        0x66: 0x0c,
        0x6e: LINE_FEED,
        0x72: 0x0d,
        0x74: TAB,
        0x76: 0x0b,
    };
    return replacements[value];
}

function isOctal(value: number | undefined): value is number {
    return value !== undefined && value >= 0x30 && value <= 0x37;
}

function onlySpaces(value: Buffer, offset: number): boolean {
    for (let index = offset; index < value.length; index += 1) {
        if (value[index] !== SPACE) return false;
    }
    return true;
}

function stripDestinationPrefix(value: string): string | undefined {
    return value.startsWith("b/") ? value.slice(2) : undefined;
}

function stripSourcePrefix(value: string): string | undefined {
    return value.startsWith("a/") ? value.slice(2) : undefined;
}

function decodeUtf8(value: Buffer): string | undefined {
    const decoded = value.toString("utf8");
    return Buffer.from(decoded, "utf8").equals(value) ? decoded : undefined;
}
