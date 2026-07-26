const WINDOWS_DEVICE_SEGMENT = /^(?:con|prn|aux|nul|clock\$|com[1-9]|lpt[1-9])(?:\..*)?$/i;

/** Validates portable repository-relative paths without relying on Node APIs. */
export function isSafeShelfRelativePath(value: unknown): value is string {
    if (
        typeof value !== "string" ||
        value.length === 0 ||
        value.length > 4096 ||
        value.includes("\0") ||
        value.startsWith("/") ||
        value.startsWith("\\") ||
        /^[A-Za-z]:/.test(value) ||
        /^[/\\]{2}/.test(value) ||
        value.includes("\\")
    )
        return false;
    return value.split("/").every((segment) => isSafeShelfPathSegment(segment));
}

function isSafeShelfPathSegment(segment: string): boolean {
    if (!segment || segment === "." || segment === ".." || segment.includes(":")) return false;
    if (containsUnsafeUnicode(segment)) return false;
    const canonicalWindowsSegment = segment.replace(/[. ]+$/, "");
    if (!canonicalWindowsSegment || canonicalWindowsSegment.toLowerCase() === ".git") return false;
    return !WINDOWS_DEVICE_SEGMENT.test(canonicalWindowsSegment);
}

function containsUnsafeUnicode(value: string): boolean {
    for (let index = 0; index < value.length; index += 1) {
        const first = value.charCodeAt(index);
        if (first >= 0xd800 && first <= 0xdbff) {
            const second = value.charCodeAt(index + 1);
            if (second < 0xdc00 || second > 0xdfff) return true;
            const codePoint = 0x10000 + (first - 0xd800) * 0x400 + second - 0xdc00;
            if (isUnsafeUnicodeScalar(codePoint)) return true;
            index += 1;
            continue;
        }
        if (first >= 0xdc00 && first <= 0xdfff) return true;
        if (isUnsafeUnicodeScalar(first)) return true;
    }
    return false;
}

function isUnsafeUnicodeScalar(codePoint: number): boolean {
    return (
        codePoint <= 0x1f ||
        (codePoint >= 0x7f && codePoint <= 0x9f) ||
        (codePoint >= 0xfdd0 && codePoint <= 0xfdef) ||
        (codePoint & 0xffff) >= 0xfffe
    );
}
