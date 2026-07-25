import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { isSafeShelfRelativePath } from "./pathValidation";

/** Limits enforced before imported patch metadata can drive storage or worktree writes. */
interface ShelfImportValidationLimits {
    readonly maxSourceBytes: number;
    readonly maxFiles: number;
    readonly maxDecodedBytesPerFile: number;
    readonly maxDecodedBytesTotal: number;
    readonly maxHunksPerFile: number;
    readonly maxLinesPerFile: number;
    readonly maxDeclaredResultBytes: number;
    readonly maxLineBytes: number;
}

/** Caller options for a hostile imported patch. */
export interface ShelfImportValidationOptions {
    readonly stripLevel?: number;
    readonly limits?: Partial<ShelfImportValidationLimits>;
}

/** Metadata retained after parsing patch bytes without materializing their payload. */
interface ValidatedImportedPatchFile {
    readonly path: string;
    readonly type: "regular";
    readonly decodedBytes: number;
    readonly declaredResultBytes: number;
    readonly hunkCount: number;
    readonly lineCount: number;
}

/** Bounded result of parsing an untrusted imported patch. */
export interface ValidatedImportedPatch {
    readonly sourceBytes: number;
    readonly decodedBytes: number;
    readonly files: readonly ValidatedImportedPatchFile[];
}

/** Stable failure raised when an imported patch crosses a hostile-input boundary. */
export class ShelfImportValidationError extends Error {
    /** Creates the stable hostile-import error without exposing patch content. */
    constructor() {
        super("Invalid imported shelf patch.");
        this.name = "ShelfImportValidationError";
    }
}

/** Conservative defaults; callers can lower, but never disable, individual bounds. */
const DEFAULT_SHELF_IMPORT_VALIDATION_LIMITS: Readonly<ShelfImportValidationLimits> = {
    maxSourceBytes: 32 * 1024 * 1024,
    maxFiles: 10_000,
    maxDecodedBytesPerFile: 16 * 1024 * 1024,
    maxDecodedBytesTotal: 64 * 1024 * 1024,
    maxHunksPerFile: 100_000,
    maxLinesPerFile: 1_000_000,
    maxDeclaredResultBytes: 16 * 1024 * 1024,
    maxLineBytes: 64 * 1024,
};

type PatchChunks = Iterable<Uint8Array> | AsyncIterable<Uint8Array>;

interface MutablePatchFile {
    readonly path: string;
    readonly type: "regular";
    readonly fromDiffHeader: boolean;
    decodedBytes: number;
    declaredResultBytes: number;
    hunkCount: number;
    lineCount: number;
    touched: boolean;
    sawUnifiedHeader: boolean;
    hunk: MutableHunk | undefined;
    binary: MutableBinary | undefined;
}

interface MutableHunk {
    sourceRemaining: number;
    destinationRemaining: number;
    lastTargetLineAddedNewline: boolean;
}

interface MutableBinary {
    needsDeclaration: boolean;
    needsPayload: boolean;
}

const UTF8 = new TextDecoder("utf-8", { fatal: true });
const REGULAR_FILE_MODES = new Set(["100644", "100755"]);

/**
 * Normalizes a patch pathname after the caller-selected Git strip level.
 * The result is always a portable repository-relative path.
 */
export function normalizeImportedPatchPath(value: string, stripLevel = 1): string {
    if (!Number.isSafeInteger(stripLevel) || stripLevel < 0 || stripLevel > 16) fail();
    if (typeof value !== "string" || value.length === 0 || value.length > 4096) fail();
    const parts = value.split("/");
    if (parts.length <= stripLevel) fail();
    return validateRelativePath(parts.slice(stripLevel).join("/"));
}

/** Validates a repository-relative path that came from a persisted manifest. */
export function validateShelfManifestPath(value: string): string {
    return validateRelativePath(value);
}

/**
 * Resolves one validated repository-relative path below a canonical root.
 * Existing symlink components are rejected even when their present target is inside the root.
 */
export async function resolveValidatedImportPath(
    repositoryRoot: string,
    relativePath: string,
): Promise<string> {
    const safeRelativePath = validateShelfManifestPath(relativePath);
    const root = await realpath(repositoryRoot);
    const target = path.resolve(root, ...safeRelativePath.split("/"));
    assertLexicallyContained(root, target);

    let current = root;
    for (const segment of safeRelativePath.split("/")) {
        const candidate = path.join(current, segment);
        let details: Awaited<ReturnType<typeof lstat>>;
        try {
            details = await lstat(candidate);
        } catch (error) {
            if (isNotFound(error)) return target;
            throw error;
        }
        if (details.isSymbolicLink()) fail();
        current = await realpath(candidate);
        assertLexicallyContained(root, current);
    }
    return target;
}

/** Parses a complete byte buffer without converting its payload into a JavaScript string. */
export function validateImportedPatch(
    patch: Uint8Array,
    options: ShelfImportValidationOptions = {},
): ValidatedImportedPatch {
    const validator = new PatchStreamValidator(options);
    validator.write(patch);
    return validator.finish();
}

/** Parses sync or async byte chunks with bounded line buffering and strict header decoding. */
export async function validateImportedPatchStream(
    chunks: PatchChunks,
    options: ShelfImportValidationOptions = {},
): Promise<ValidatedImportedPatch> {
    const validator = new PatchStreamValidator(options);
    for await (const chunk of chunks) validator.write(chunk);
    return validator.finish();
}

class PatchStreamValidator {
    private readonly limits: ShelfImportValidationLimits;
    private readonly stripLevel: number;
    private readonly line: number[] = [];
    private readonly files: MutablePatchFile[] = [];
    private current: MutablePatchFile | undefined;
    private pendingUnifiedSource: string | undefined;
    private sawUnifiedSource = false;
    private sourceBytes = 0;
    private decodedBytes = 0;

    constructor(options: ShelfImportValidationOptions) {
        this.limits = mergedLimits(options.limits);
        this.stripLevel = options.stripLevel ?? 1;
        if (!Number.isSafeInteger(this.stripLevel) || this.stripLevel < 0 || this.stripLevel > 16) {
            fail();
        }
    }

    write(chunk: Uint8Array): void {
        for (const byte of chunk) {
            this.sourceBytes += 1;
            if (this.sourceBytes > this.limits.maxSourceBytes) fail();
            if (byte === 0x0a) {
                this.processLine(Uint8Array.from(this.line));
                this.line.length = 0;
                continue;
            }
            this.line.push(byte);
            if (this.line.length > this.limits.maxLineBytes) fail();
        }
    }

    finish(): ValidatedImportedPatch {
        if (this.line.length > 0) {
            this.processLine(Uint8Array.from(this.line));
            this.line.length = 0;
        }
        this.finishCurrent();
        if (this.sawUnifiedSource || this.files.length === 0) {
            fail();
        }
        return {
            sourceBytes: this.sourceBytes,
            decodedBytes: this.decodedBytes,
            files: this.files.map((file) => ({
                path: file.path,
                type: file.type,
                decodedBytes: file.decodedBytes,
                declaredResultBytes: file.declaredResultBytes,
                hunkCount: file.hunkCount,
                lineCount: file.lineCount,
            })),
        };
    }

    private processLine(line: Uint8Array): void {
        const current = this.current;
        if (this.processActiveLine(current, line)) return;
        this.processPatchHeader(line);
    }

    private processActiveLine(current: MutablePatchFile | undefined, line: Uint8Array): boolean {
        if (current?.binary) {
            this.processBinaryLine(current, line);
            return true;
        }
        if (
            current?.hunk &&
            (line[0] === 0x20 || line[0] === 0x2b || line[0] === 0x2d || line[0] === 0x5c)
        ) {
            this.processHunkLine(current, line);
            return true;
        }
        if (current?.hunk) this.assertHunkComplete(current);
        return false;
    }

    private processPatchHeader(line: Uint8Array): void {
        const current = this.current;
        if (hasPrefix(line, "diff --git ")) {
            this.finishCurrent();
            const [source, destination] = parseDiffHeader(line, this.stripLevel);
            if (source === undefined || destination === undefined) fail();
            this.startFile(destination, true);
            return;
        }
        if (hasPrefix(line, "--- ")) {
            this.startUnifiedSource(line);
            return;
        }
        if (hasPrefix(line, "+++ ")) {
            this.startUnifiedDestination(line);
            return;
        }
        if (hasPrefix(line, "@@ ")) {
            this.startHunk(line);
            return;
        }
        if (hasPrefix(line, "GIT binary patch")) {
            if (!current || !equalsAscii(line, "GIT binary patch")) fail();
            current.touched = true;
            current.binary = { needsDeclaration: true, needsPayload: false };
            return;
        }
        if (hasPrefix(line, "Binary files ")) fail();
        const metadataPathPrefix = patchMetadataPathPrefix(line);
        if (metadataPathPrefix !== undefined) {
            if (!current) fail();
            validateShelfManifestPath(decodeHeader(line.subarray(metadataPathPrefix.length)));
            current.touched = true;
            return;
        }
        if (
            hasPrefix(line, "new file mode ") ||
            hasPrefix(line, "deleted file mode ") ||
            hasPrefix(line, "old mode ") ||
            hasPrefix(line, "new mode ")
        ) {
            if (!current) fail();
            assertRegularMode(lastAsciiToken(line));
            current.touched = true;
            return;
        }
        if (hasPrefix(line, "index ")) {
            if (!current) fail();
            const token = lastAsciiToken(line);
            if (/^[0-7]{6}$/.test(token)) assertRegularMode(token);
        }
    }

    private startUnifiedSource(line: Uint8Array): void {
        const current = this.current;
        if (current?.sawUnifiedHeader && !current.fromDiffHeader) {
            this.finishCurrent();
            this.current = undefined;
        }
        if (this.sawUnifiedSource) fail();
        this.pendingUnifiedSource = parseUnifiedHeaderPath(line, "--- ", this.stripLevel);
        this.sawUnifiedSource = true;
    }

    private startUnifiedDestination(line: Uint8Array): void {
        if (!this.sawUnifiedSource) fail();
        const destination = parseUnifiedHeaderPath(line, "+++ ", this.stripLevel);
        const selected = destination ?? this.pendingUnifiedSource;
        if (selected === undefined) fail();
        if (!this.current) this.startFile(selected, false);
        const current = this.current;
        if (!current || current.path !== selected) fail();
        current.sawUnifiedHeader = true;
        this.pendingUnifiedSource = undefined;
        this.sawUnifiedSource = false;
    }

    private startHunk(line: Uint8Array): void {
        const current = this.current;
        if (!current || current.hunk || !current.sawUnifiedHeader) fail();
        const hunk = parseHunkHeader(decodeHeader(line));
        if (
            hunk.sourceRemaining > this.limits.maxLinesPerFile ||
            hunk.destinationRemaining > this.limits.maxLinesPerFile
        ) {
            fail();
        }
        current.hunkCount += 1;
        if (current.hunkCount > this.limits.maxHunksPerFile) fail();
        current.touched = true;
        current.hunk = { ...hunk, lastTargetLineAddedNewline: false };
    }

    private processHunkLine(file: MutablePatchFile, line: Uint8Array): void {
        const hunk = file.hunk;
        if (!hunk) fail();
        if (line.includes(0)) fail();
        if (line[0] === 0x5c) {
            if (!equalsAscii(line, "\\ No newline at end of file")) fail();
            if (hunk.lastTargetLineAddedNewline) {
                this.addDecoded(file, -1);
                hunk.lastTargetLineAddedNewline = false;
            }
            return;
        }
        if (hunk.sourceRemaining === 0 && hunk.destinationRemaining === 0) fail();
        const kind = line[0];
        const consumesSource = kind === 0x20 || kind === 0x2d;
        const consumesDestination = kind === 0x20 || kind === 0x2b;
        if (
            (!consumesSource && !consumesDestination) ||
            (consumesSource && hunk.sourceRemaining === 0) ||
            (consumesDestination && hunk.destinationRemaining === 0)
        ) {
            fail();
        }
        file.lineCount += 1;
        if (file.lineCount > this.limits.maxLinesPerFile) fail();
        if (consumesSource) hunk.sourceRemaining -= 1;
        if (consumesDestination) {
            hunk.destinationRemaining -= 1;
            this.addDecoded(file, line.length);
            hunk.lastTargetLineAddedNewline = true;
        } else {
            hunk.lastTargetLineAddedNewline = false;
        }
    }

    private processBinaryLine(file: MutablePatchFile, line: Uint8Array): void {
        const binary = file.binary;
        if (!binary) fail();
        if (line.length === 0) {
            if (binary.needsDeclaration || binary.needsPayload) fail();
            file.binary = undefined;
            return;
        }
        const declared = parseBinaryDeclaration(decodeHeader(line));
        if (declared !== undefined) {
            if (binary.needsPayload) fail();
            file.declaredResultBytes += declared;
            if (file.declaredResultBytes > this.limits.maxDeclaredResultBytes) fail();
            this.addDecoded(file, declared);
            binary.needsDeclaration = false;
            binary.needsPayload = true;
            return;
        }
        if (binary.needsDeclaration || !isPlausibleGitBinaryPayload(line)) fail();
        binary.needsPayload = false;
    }

    private addDecoded(file: MutablePatchFile, amount: number): void {
        if (!Number.isSafeInteger(amount)) fail();
        if (amount < 0) {
            if (file.decodedBytes < -amount || this.decodedBytes < -amount) fail();
            file.decodedBytes += amount;
            this.decodedBytes += amount;
            return;
        }
        if (
            file.decodedBytes + amount > this.limits.maxDecodedBytesPerFile ||
            this.decodedBytes + amount > this.limits.maxDecodedBytesTotal
        ) {
            fail();
        }
        file.decodedBytes += amount;
        this.decodedBytes += amount;
    }

    private startFile(pathname: string, fromDiffHeader: boolean): void {
        if (this.files.length >= this.limits.maxFiles) fail();
        const file: MutablePatchFile = {
            path: pathname,
            type: "regular",
            fromDiffHeader,
            decodedBytes: 0,
            declaredResultBytes: 0,
            hunkCount: 0,
            lineCount: 0,
            touched: false,
            sawUnifiedHeader: false,
            hunk: undefined,
            binary: undefined,
        };
        this.files.push(file);
        this.current = file;
    }

    private finishCurrent(): void {
        if (!this.current) return;
        this.assertHunkComplete(this.current);
        if (this.current.binary?.needsDeclaration || this.current.binary?.needsPayload) fail();
        if (!this.current.touched) fail();
        this.current = undefined;
    }

    private assertHunkComplete(file: MutablePatchFile): void {
        const hunk = file.hunk;
        if (!hunk) return;
        if (hunk.sourceRemaining !== 0 || hunk.destinationRemaining !== 0) fail();
        file.hunk = undefined;
    }
}

function mergedLimits(
    overrides: Partial<ShelfImportValidationLimits> | undefined,
): ShelfImportValidationLimits {
    const limits = { ...DEFAULT_SHELF_IMPORT_VALIDATION_LIMITS, ...overrides };
    for (const value of Object.values(limits)) {
        if (!Number.isSafeInteger(value) || value <= 0) fail();
    }
    if (limits.maxDecodedBytesPerFile > limits.maxDecodedBytesTotal) fail();
    return limits;
}

function parseDiffHeader(
    line: Uint8Array,
    stripLevel: number,
): readonly [string | undefined, string | undefined] {
    const tokens = parseGitTokens(decodeHeader(line).slice("diff --git ".length));
    if (tokens.length !== 2) fail();
    return [
        normalizeImportedPatchPath(tokens[0] ?? "", stripLevel),
        normalizeImportedPatchPath(tokens[1] ?? "", stripLevel),
    ];
}

function parseUnifiedHeaderPath(
    line: Uint8Array,
    prefix: "--- " | "+++ ",
    stripLevel: number,
): string | undefined {
    const value = decodeHeader(line.subarray(prefix.length));
    const pathname = value.slice(0, value.indexOf("\t") >= 0 ? value.indexOf("\t") : value.length);
    if (pathname === "/dev/null") return undefined;
    return normalizeImportedPatchPath(pathname, stripLevel);
}

function parseGitTokens(value: string): string[] {
    const tokens: string[] = [];
    let offset = 0;
    while (offset < value.length) {
        while (value[offset] === " ") offset += 1;
        if (offset >= value.length) break;
        if (value[offset] !== '"') {
            const end = value.indexOf(" ", offset);
            tokens.push(value.slice(offset, end < 0 ? value.length : end));
            offset = end < 0 ? value.length : end + 1;
            continue;
        }
        const decoded = decodeGitQuotedPath(value, offset);
        tokens.push(decoded.value);
        offset = decoded.next;
        if (offset < value.length && value[offset] !== " ") fail();
    }
    return tokens;
}

function decodeGitQuotedPath(
    value: string,
    start: number,
): { readonly value: string; readonly next: number } {
    const bytes: number[] = [];
    for (let index = start + 1; index < value.length; index += 1) {
        const character = value[index];
        if (character === '"')
            return { value: decodeHeader(Uint8Array.from(bytes)), next: index + 1 };
        if (character !== "\\") {
            const encoded = new TextEncoder().encode(character);
            bytes.push(...encoded);
            continue;
        }
        const escaped = value[index + 1];
        if (escaped === undefined) fail();
        index += 1;
        if (escaped >= "0" && escaped <= "7") {
            const digits = value.slice(index, index + 3);
            if (!/^[0-7]{3}$/.test(digits)) fail();
            bytes.push(Number.parseInt(digits, 8));
            index += 2;
            continue;
        }
        if (escaped === "\\" || escaped === '"') {
            bytes.push(escaped.charCodeAt(0));
            continue;
        }
        fail();
    }
    fail();
}

function parseHunkHeader(
    value: string,
): Pick<MutableHunk, "sourceRemaining" | "destinationRemaining"> {
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/.exec(value);
    if (!match) fail();
    const source = parseHunkCount(match[2]);
    const destination = parseHunkCount(match[4]);
    if (source === undefined || destination === undefined) fail();
    return { sourceRemaining: source, destinationRemaining: destination };
}

function parseHunkCount(value: string | undefined): number | undefined {
    if (value === undefined) return 1;
    if (!/^\d+$/.test(value)) return undefined;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function parseBinaryDeclaration(value: string): number | undefined {
    const match = /^(?:literal|delta) (\d+)$/.exec(value);
    if (!match) return undefined;
    const parsed = Number(match[1]);
    return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function validateRelativePath(value: string): string {
    if (!isSafeShelfRelativePath(value)) fail();
    return value;
}

function assertRegularMode(value: string): void {
    if (!REGULAR_FILE_MODES.has(value)) fail();
}

function isPlausibleGitBinaryPayload(line: Uint8Array): boolean {
    if (line.length < 2 || line.length > 53) return false;
    const lengthCode = line[0];
    if (!((lengthCode >= 0x41 && lengthCode <= 0x5a) || (lengthCode >= 0x61 && lengthCode <= 0x7a)))
        return false;
    for (let index = 1; index < line.length; index += 1) {
        if (line[index] < 0x21 || line[index] > 0x7e) return false;
    }
    return true;
}

function decodeHeader(value: Uint8Array): string {
    try {
        return UTF8.decode(value);
    } catch {
        fail();
    }
}

function hasPrefix(value: Uint8Array, prefix: string): boolean {
    if (value.length < prefix.length) return false;
    for (let index = 0; index < prefix.length; index += 1) {
        if (value[index] !== prefix.charCodeAt(index)) return false;
    }
    return true;
}

function equalsAscii(value: Uint8Array, expected: string): boolean {
    return value.length === expected.length && hasPrefix(value, expected);
}

function lastAsciiToken(value: Uint8Array): string {
    let start = value.length;
    while (start > 0 && value[start - 1] !== 0x20) start -= 1;
    return decodeHeader(value.subarray(start));
}

function patchMetadataPathPrefix(line: Uint8Array): string | undefined {
    for (const prefix of ["rename from ", "rename to ", "copy from ", "copy to "]) {
        if (hasPrefix(line, prefix)) return prefix;
    }
    return undefined;
}

function assertLexicallyContained(root: string, target: string): void {
    const relation = path.relative(root, target);
    if (
        relation === "" ||
        relation === ".." ||
        relation.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relation)
    )
        fail();
}

function isNotFound(error: unknown): boolean {
    return (
        typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
    );
}

function fail(): never {
    throw new ShelfImportValidationError();
}
