import type { ShelfChangeStatus } from "./model";

/** Header-derived properties for one isolated Git patch block. */
export interface PatchHeaderClassification {
    readonly status: ShelfChangeStatus;
    readonly renamedFrom: string | undefined;
    readonly binary: boolean;
}

const LINE_FEED = 0x0a;
const CARRIAGE_RETURN = 0x0d;
const SPACE = 0x20;
const TAB = 0x09;
const QUOTE = 0x22;
const BACKSLASH = 0x5c;

/**
 * Classifies only Git patch headers, never hunk or binary payload bytes.
 *
 * A hunk or `GIT binary patch` line ends header inspection. Metadata is
 * line-anchored, so literal changed text cannot become patch metadata.
 */
export function classifyPatchHeader(patch: Uint8Array): PatchHeaderClassification {
    let renamed = false;
    let added = false;
    let deleted = false;
    let modeChanged = false;
    let binary = false;
    let renamedFrom: string | undefined;
    for (let start = 0; start < patch.length; ) {
        // This is an ordered patch-stream delimiter scan; a Set cannot represent repeated line feeds.
        // react-doctor-disable-next-line react-doctor/js-set-map-lookups
        const lineEnd = patch.indexOf(LINE_FEED, start);
        const end = lineEnd < 0 ? patch.length : lineEnd;
        const line = withoutTerminalCarriageReturn(patch.subarray(start, end));
        if (equalsAscii(line, "GIT binary patch")) {
            binary = true;
            break;
        }
        if (hasAsciiPrefix(line, "@@ ")) break;
        if (hasAsciiPrefix(line, "rename from ")) {
            renamed = true;
            renamedFrom ??= decodePatchPath(line.subarray("rename from ".length));
        } else if (hasAsciiPrefix(line, "new file mode ")) {
            added = true;
        } else if (hasAsciiPrefix(line, "deleted file mode ")) {
            deleted = true;
        } else if (hasAsciiPrefix(line, "old mode ")) {
            modeChanged = true;
        } else if (isBinaryFilesLine(line)) {
            binary = true;
            break;
        }
        start = lineEnd < 0 ? patch.length : lineEnd + 1;
    }
    return {
        status: renamed ? "R" : added ? "A" : deleted ? "D" : modeChanged ? "T" : "M",
        renamedFrom,
        binary,
    };
}

function withoutTerminalCarriageReturn(line: Uint8Array): Uint8Array {
    return line[line.length - 1] === CARRIAGE_RETURN ? line.subarray(0, -1) : line;
}

function isBinaryFilesLine(line: Uint8Array): boolean {
    return hasAsciiPrefix(line, "Binary files ") && hasAsciiSuffix(line, " differ");
}

function hasAsciiPrefix(line: Uint8Array, value: string): boolean {
    if (line.length < value.length) return false;
    for (let index = 0; index < value.length; index += 1) {
        if (line[index] !== value.charCodeAt(index)) return false;
    }
    return true;
}

function hasAsciiSuffix(line: Uint8Array, value: string): boolean {
    if (line.length < value.length) return false;
    const start = line.length - value.length;
    for (let index = 0; index < value.length; index += 1) {
        if (line[start + index] !== value.charCodeAt(index)) return false;
    }
    return true;
}

function equalsAscii(line: Uint8Array, value: string): boolean {
    return line.length === value.length && hasAsciiPrefix(line, value);
}

function decodePatchPath(line: Uint8Array): string | undefined {
    if (line[0] === QUOTE) {
        const token = decodeQuotedToken(line, 0);
        return token && onlySpaces(line, token.next) ? token.value : undefined;
    }
    const tab = line.indexOf(TAB);
    return decodeUtf8(line.subarray(0, tab < 0 ? line.length : tab));
}

function decodeQuotedToken(
    line: Uint8Array,
    start: number,
): { readonly value: string; readonly next: number } | undefined {
    const bytes: number[] = [];
    for (let index = start + 1; index < line.length; index += 1) {
        const value = line[index];
        if (value === QUOTE) {
            const decoded = decodeUtf8(Uint8Array.from(bytes));
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
        0x72: CARRIAGE_RETURN,
        0x74: TAB,
        0x76: 0x0b,
    };
    return replacements[value];
}

function isOctal(value: number | undefined): value is number {
    return value !== undefined && value >= 0x30 && value <= 0x37;
}

function onlySpaces(value: Uint8Array, offset: number): boolean {
    for (let index = offset; index < value.length; index += 1) {
        if (value[index] !== SPACE) return false;
    }
    return true;
}

function decodeUtf8(value: Uint8Array): string | undefined {
    try {
        return new TextDecoder("utf-8", { fatal: true }).decode(value);
    } catch {
        return undefined;
    }
}
