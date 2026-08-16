#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const JSZip = require("jszip");
const { listFiles: vsceListFiles, PackageManager } = require("@vscode/vsce");

const DEFAULT_CWD = path.resolve(__dirname, "..");
const MAX_COMPRESSED_BYTES = 2.5 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 8 * 1024 * 1024;
const MAX_ENTRY_UNCOMPRESSED_BYTES = 2 * 1024 * 1024;
const REQUIRED_PAYLOAD = new Set([
    "package.json",
    "README.md",
    "CHANGELOG.md",
    "LICENSE.txt",
    "dist/extension.js",
    "dist/interactive-rebase-editor-helper.cjs",
]);
const OUTER_METADATA = new Set(["extension.vsixmanifest", "[Content_Types].xml"]);
const FORBIDDEN_DIRECTORY_NAMES = new Set([
    ".agents",
    ".cache",
    ".claude",
    ".claude-flow",
    ".codebase-memory",
    ".codex",
    ".git",
    ".github",
    ".gitnexus",
    ".hermes",
    ".idea",
    ".impeccable",
    ".mcp",
    ".ruff_cache",
    ".serena",
    ".vscode",
    ".vscode-test",
    "coverage",
    "docs",
    "graphify-out",
    "node_modules",
    "playwright-report",
    "scripts",
    "src",
    "test-results",
    "tests",
]);
const FORBIDDEN_ROOT_CONFIGS = new Set([
    ".coderabbit.yaml",
    ".dependency-cruiser.cjs",
    ".editorconfig",
    ".env.example",
    ".gitattributes",
    ".gitignore",
    ".pre-commit-config.yaml",
    ".prettierignore",
    ".prettierrc",
    "doctor.config.json",
    "eslint.config.mjs",
    "knip.jsonc",
    "playwright.e2e.config.ts",
    "playwright.visual.config.ts",
    "tsconfig.json",
    "tsconfig.tests.json",
    "tsconfig.tests-negative.json",
    "tsconfig.webview.json",
    "vitest.config.ts",
]);
const SECRET_LIKE_NAME = /(?:api[-_]?key|credential|password|private[-_]?key|secret|token)/i;

/**
 * Converts an archive or VSCE path to the one slash-separated spelling used by
 * the extension payload comparison.
 *
 * @param {string} value Path to normalize.
 * @returns {string} Normalized relative path.
 */
function normalizePath(value) {
    return value.replace(/\\/g, "/");
}

/**
 * Reports path forms that must never be accepted from an archive.
 *
 * @param {string} value Original ZIP entry name.
 * @returns {string|null} Actionable error text, or null for a safe path.
 */
function unsafePathError(value) {
    const normalized = normalizePath(value);
    const pathForSegments = normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
    const segments = pathForSegments.split("/");
    if (
        value.includes("\\") ||
        normalized.startsWith("/") ||
        /^[A-Za-z]:\//.test(normalized) ||
        segments.some((segment) => segment === "" || segment === "." || segment === "..")
    ) {
        return `Unsafe archive path: ${value}`;
    }
    return null;
}

/**
 * Maps VSCE's source license spelling to the filename emitted by its license
 * processor in the VSIX archive.
 *
 * @param {string} value VSCE file path.
 * @returns {string} Payload-relative archive path.
 */
function normalizeExpectedPath(value) {
    const normalized = normalizePath(value).replace(/^extension\//, "");
    return normalized === "LICENSE" ? "LICENSE.txt" : normalized;
}

/**
 * Walks a source directory and returns relative regular-file paths.
 *
 * @param {string} root Absolute directory to walk.
 * @param {(relativePath: string) => boolean} include Predicate for files.
 * @returns {string[]} Slash-separated relative paths.
 */
function collectFiles(root, include) {
    if (!fs.existsSync(root)) {
        return [];
    }
    const result = [];
    const visit = (current, relative) => {
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            const nextRelative = relative ? `${relative}/${entry.name}` : entry.name;
            const nextAbsolute = path.join(current, entry.name);
            if (entry.isDirectory()) {
                visit(nextAbsolute, nextRelative);
            } else if (entry.isFile() && include(nextRelative)) {
                result.push(nextRelative);
            }
        }
    };
    visit(root, "");
    return result;
}

/**
 * Derives the runtime payload floor from the source tree so a newly added
 * runtime bundle or media asset cannot silently disappear from a package.
 *
 * @param {string} cwd Extension repository root.
 * @returns {Set<string>} Required payload-relative paths.
 */
function requiredPayload(cwd) {
    const required = new Set(REQUIRED_PAYLOAD);
    for (const relativePath of collectFiles(path.join(cwd, "dist"), (relativePath) => {
        return /^webview-[^/]+\.(?:css|js)$/.test(relativePath);
    })) {
        required.add(`dist/${relativePath}`);
    }
    for (const relativePath of collectFiles(path.join(cwd, "l10n"), (relativePath) => {
        return relativePath.endsWith(".json");
    })) {
        required.add(`l10n/${relativePath}`);
    }
    for (const entry of fs.existsSync(cwd) ? fs.readdirSync(cwd, { withFileTypes: true }) : []) {
        if (entry.isFile() && /^package\.nls(?:\..+)?\.json$/i.test(entry.name)) {
            required.add(entry.name);
        }
    }
    for (const relativePath of collectFiles(path.join(cwd, "media"), (relativePath) => {
        return !relativePath.startsWith("screenshots/");
    })) {
        required.add(`media/${relativePath}`);
    }
    return required;
}

/**
 * Identifies package paths that are not allowed in a published extension.
 *
 * @param {string} relativePath Payload-relative path.
 * @returns {string|null} Violation text, or null when allowed.
 */
function forbiddenPathError(relativePath) {
    const normalized = normalizePath(relativePath);
    const segments = normalized.split("/");
    const lower = normalized.toLowerCase();
    const basename = segments.at(-1) ?? "";
    if (segments.some((segment) => FORBIDDEN_DIRECTORY_NAMES.has(segment.toLowerCase()))) {
        return `Forbidden package path: ${normalized}`;
    }
    if (lower === "media/icons/collapse-all.svg" || lower === "media/icons/expand-all.svg") {
        return `Obsolete package path: ${normalized}`;
    }
    if (lower.endsWith(".map")) {
        return `Forbidden source map: ${normalized}`;
    }
    if (
        lower.endsWith(".lock") ||
        /(?:^|\/)(?:package-lock|yarn|pnpm|bun)\.lock$/i.test(normalized)
    ) {
        return `Forbidden lockfile: ${normalized}`;
    }
    if (
        lower.endsWith(".db") ||
        lower.endsWith(".db-shm") ||
        lower.endsWith(".db-wal") ||
        lower.endsWith(".sqlite") ||
        lower.endsWith(".sqlite3")
    ) {
        return `Forbidden database: ${normalized}`;
    }
    if (
        segments.some((segment) => SECRET_LIKE_NAME.test(segment)) ||
        /^\.env(?:\.|$)/i.test(basename)
    ) {
        return `Secret-like package path: ${normalized}`;
    }
    if (segments.length === 1 && FORBIDDEN_ROOT_CONFIGS.has(basename)) {
        return `Forbidden root config: ${normalized}`;
    }
    if (
        segments.length === 1 &&
        lower.endsWith(".json") &&
        basename !== "package.json" &&
        !/^package\.nls(?:\..+)?\.json$/i.test(basename)
    ) {
        return `Forbidden root config: ${normalized}`;
    }
    if (segments.length === 1 && /^(?:[^.]+\.)?(?:cjs|mjs|ts|tsx|toml|ya?ml)$/i.test(basename)) {
        return `Forbidden root config: ${normalized}`;
    }
    return null;
}

/**
 * Reads ZIP metadata sizes without inflating entry content. JSZip exposes the
 * central-directory sizes on its loaded entry object; they are used before any
 * decompression so a declared oversized archive is rejected cheaply.
 *
 * @param {object} entry Loaded JSZip entry.
 * @returns {{compressedSize: number, uncompressedSize: number}} Entry sizes.
 */
function entrySizes(entry) {
    const data = entry._data;
    return {
        compressedSize: Number(data?.compressedSize ?? 0),
        uncompressedSize: Number(data?.uncompressedSize ?? 0),
    };
}

/**
 * Applies archive path and entry-size policy without inflating file contents.
 *
 * @param {object[]} entries Loaded JSZip entries.
 * @param {{maxEntryUncompressedBytes: number}} budget Active package budget.
 * @param {{uncompressedBytes: number}} archive Mutable archive totals.
 * @param {string[]} errors Mutable validation errors.
 * @returns {{archivePayload: Set<string>, outerMetadata: Set<string>}} Classified archive paths.
 */
function scanArchiveEntries(entries, budget, archive, errors) {
    const archivePayload = new Set();
    const outerMetadata = new Set();
    for (const entry of entries) {
        const originalName = entry.unsafeOriginalName ?? entry.name;
        const unsafeError = unsafePathError(originalName);
        if (unsafeError) {
            errors.push(unsafeError);
            continue;
        }
        const normalizedName = normalizePath(entry.name);
        const sizes = entrySizes(entry);
        archive.uncompressedBytes += sizes.uncompressedSize;
        if (sizes.uncompressedSize > budget.maxEntryUncompressedBytes) {
            errors.push(
                `VSIX entry ${normalizedName} single-entry uncompressed size ${sizes.uncompressedSize} bytes exceeds budget of ${budget.maxEntryUncompressedBytes} bytes.`,
            );
        }
        if (normalizedName.startsWith("extension/")) {
            const payloadPath = normalizedName.slice("extension/".length).replace(/\/$/, "");
            if (entry.dir && payloadPath === "") continue;
            if (!entry.dir) archivePayload.add(payloadPath);
            const forbiddenError = forbiddenPathError(payloadPath);
            if (forbiddenError) errors.push(forbiddenError);
        } else if (OUTER_METADATA.has(normalizedName)) {
            outerMetadata.add(normalizedName);
        } else {
            const forbiddenError = forbiddenPathError(normalizedName);
            errors.push(forbiddenError ?? `Unexpected top-level VSIX entry: ${normalizedName}`);
        }
    }
    return { archivePayload, outerMetadata };
}

/**
 * Finds the only VSIX directly under a repository root.
 *
 * @param {string} cwd Repository root.
 * @returns {string} Absolute VSIX path.
 * @throws {Error} If zero or more than one root VSIX exists.
 */
function selectSoleVsix(cwd = DEFAULT_CWD) {
    const candidates = fs
        .readdirSync(cwd, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".vsix"))
        .map((entry) => path.join(cwd, entry.name));
    if (candidates.length !== 1) {
        throw new Error(
            `Expected exactly one root .vsix in ${cwd}; found ${candidates.length}. ` +
                "Remove stale artifacts or package the extension first.",
        );
    }
    return candidates[0];
}

/**
 * Verifies one VSIX against VSCE's package file selection, runtime payload
 * floor, path policy, and explicit archive-size budgets.
 *
 * @param {object} [input] Verification inputs.
 * @param {string} [input.cwd] Repository root passed to VSCE.
 * @param {string} [input.vsixPath] VSIX to inspect; defaults to the sole root VSIX.
 * @param {(options: object) => Promise<string[]>} [input.listFiles] VSCE listFiles implementation, injectable for focused tests.
 * @param {{maxCompressedBytes?: number, maxUncompressedBytes?: number, maxEntryUncompressedBytes?: number}} [input.limits] Test-only budget overrides.
 * @returns {Promise<{ok: boolean, errors: string[], archive: {compressedBytes: number, uncompressedBytes: number, entryCount: number}}>} Verification result.
 */
async function verifyVsixPackage({
    cwd = DEFAULT_CWD,
    vsixPath = selectSoleVsix(cwd),
    listFiles = vsceListFiles,
    limits = {},
} = {}) {
    const budget = {
        maxCompressedBytes: limits.maxCompressedBytes ?? MAX_COMPRESSED_BYTES,
        maxUncompressedBytes: limits.maxUncompressedBytes ?? MAX_UNCOMPRESSED_BYTES,
        maxEntryUncompressedBytes: limits.maxEntryUncompressedBytes ?? MAX_ENTRY_UNCOMPRESSED_BYTES,
    };
    const archive = { compressedBytes: 0, uncompressedBytes: 0, entryCount: 0 };
    const errors = [];
    let bytes;
    let zip;
    try {
        bytes = fs.readFileSync(vsixPath);
        archive.compressedBytes = bytes.length;
        if (archive.compressedBytes > budget.maxCompressedBytes) {
            errors.push(
                `VSIX compressed size ${archive.compressedBytes} bytes exceeds budget of ${budget.maxCompressedBytes} bytes.`,
            );
        }
        // Inspect central-directory budgets before CRC validation inflates every entry.
        zip = await JSZip.loadAsync(bytes, { checkCRC32: false, createFolders: false });
    } catch (error) {
        return {
            ok: false,
            errors: [`Malformed VSIX archive ${vsixPath}: ${error.message}`],
            archive,
        };
    }

    const entries = Object.values(zip.files);
    archive.entryCount = entries.length;
    const { archivePayload, outerMetadata } = scanArchiveEntries(entries, budget, archive, errors);
    for (const requiredMetadata of OUTER_METADATA) {
        if (!outerMetadata.has(requiredMetadata)) {
            errors.push(`Missing required top-level VSIX metadata: ${requiredMetadata}`);
        }
    }
    if (archive.uncompressedBytes > budget.maxUncompressedBytes) {
        errors.push(
            `VSIX total uncompressed size ${archive.uncompressedBytes} bytes exceeds budget of ${budget.maxUncompressedBytes} bytes.`,
        );
    }

    let expectedFiles;
    try {
        expectedFiles = new Set(
            (await listFiles({ cwd, packageManager: PackageManager.None })).map(
                normalizeExpectedPath,
            ),
        );
    } catch (error) {
        errors.push(`Unable to obtain VSCE package file list: ${error.message}`);
        expectedFiles = new Set();
    }
    for (const expected of expectedFiles) {
        if (!archivePayload.has(expected)) {
            errors.push(`VSCE expected but VSIX omitted: ${expected}`);
        }
    }
    for (const actual of archivePayload) {
        if (!expectedFiles.has(actual)) {
            errors.push(`VSIX contains file not selected by VSCE: ${actual}`);
        }
    }
    const allowedPayload = requiredPayload(cwd);
    for (const actual of archivePayload) {
        if (!allowedPayload.has(actual)) {
            errors.push(`Unexpected VSIX payload outside runtime allowlist: ${actual}`);
        }
    }
    for (const required of allowedPayload) {
        if (!archivePayload.has(required)) {
            errors.push(`Missing required VSIX payload: ${required}`);
        }
    }

    if (errors.length === 0) {
        try {
            // CRC validation intentionally happens only after size/path checks pass.
            await JSZip.loadAsync(bytes, { checkCRC32: true, createFolders: false });
        } catch (error) {
            errors.push(`Malformed VSIX archive ${vsixPath}: ${error.message}`);
        }
    }
    return { ok: errors.length === 0, errors, archive };
}

/**
 * CLI entry point for the package:verify script.
 *
 * @returns {Promise<void>} Resolves after reporting the verification result.
 */
async function main() {
    const vsixPath = selectSoleVsix();
    const result = await verifyVsixPackage({ vsixPath });
    if (!result.ok) {
        console.error("verifyVsixPackage: package integrity check failed:");
        for (const error of result.errors) {
            console.error(`  - ${error}`);
        }
        process.exitCode = 1;
        return;
    }
    console.log(
        `verifyVsixPackage: ${vsixPath} passed (${result.archive.entryCount} entries, ${result.archive.compressedBytes} compressed bytes, ${result.archive.uncompressedBytes} uncompressed bytes).`,
    );
}

if (require.main === module) {
    main().catch((error) => {
        console.error(`verifyVsixPackage: ${error.message}`);
        process.exitCode = 1;
    });
}

module.exports = {
    MAX_COMPRESSED_BYTES,
    MAX_ENTRY_UNCOMPRESSED_BYTES,
    MAX_UNCOMPRESSED_BYTES,
    PackageManager,
    selectSoleVsix,
    verifyVsixPackage,
};
