import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
    MAX_COMPRESSED_BYTES,
    MAX_ENTRY_UNCOMPRESSED_BYTES,
    MAX_UNCOMPRESSED_BYTES,
    PackageManager,
    selectSoleVsix,
    verifyVsixPackage,
} from "../../../scripts/verifyVsixPackage.js";

const REQUIRED_FILES = [
    "package.json",
    "README.md",
    "CHANGELOG.md",
    "LICENSE",
    "dist/extension.js",
    "dist/interactive-rebase-editor-helper.cjs",
    "dist/webview-commitpanel.js",
    "dist/webview-commitpanel.css",
    "l10n/bundle.l10n.json",
    "package.nls.json",
    "media/intelligit.svg",
];

type ArchiveEntry = {
    path: string;
    contents?: string;
    compression?: "STORE" | "DEFLATE";
};

let fixtureRoot: string;

beforeEach(() => {
    fixtureRoot = mkdtempSync(join(tmpdir(), "intelligit-vsix-test-"));
    for (const relativePath of REQUIRED_FILES) {
        const absolutePath = join(fixtureRoot, relativePath);
        mkdirSync(join(absolutePath, ".."), { recursive: true });
        writeFileSync(absolutePath, `fixture:${relativePath}`, "utf8");
    }
});

afterEach(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
});

async function writeArchive(entries: ArchiveEntry[]): Promise<string> {
    const zip = new JSZip();
    for (const entry of entries) {
        zip.file(entry.path, entry.contents ?? `fixture:${entry.path}`, {
            compression: entry.compression ?? "DEFLATE",
        });
    }
    const archivePath = join(fixtureRoot, "fixture.vsix");
    writeFileSync(archivePath, await zip.generateAsync({ type: "nodebuffer" }));
    return archivePath;
}

function extensionEntries(expectedFiles: string[], omitted: string[] = []): ArchiveEntry[] {
    return [
        { path: "extension.vsixmanifest", contents: "<PackageManifest />" },
        { path: "[Content_Types].xml", contents: "<Types />" },
        ...expectedFiles
            .filter((relativePath) => !omitted.includes(relativePath))
            .map((relativePath) => ({
                path: `extension/${relativePath === "LICENSE" ? "LICENSE.txt" : relativePath}`,
            })),
    ];
}

function makeListFilesStub(expectedFiles: string[]) {
    return vi.fn(async (options: { cwd: string; packageManager: PackageManager }) => {
        expect(options).toEqual({ cwd: fixtureRoot, packageManager: PackageManager.None });
        return expectedFiles;
    });
}

async function verifyFixture(
    entries: ArchiveEntry[],
    expectedFiles = REQUIRED_FILES,
    options: Record<string, unknown> = {},
) {
    const archivePath = await writeArchive(entries);
    const listFiles = makeListFilesStub(expectedFiles);
    const result = await verifyVsixPackage({
        cwd: fixtureRoot,
        vsixPath: archivePath,
        listFiles,
        ...options,
    });
    return { listFiles, result };
}

describe("verifyVsixPackage", () => {
    it("accepts a valid VSIX and asks VSCE for the package file list", async () => {
        const { listFiles, result } = await verifyFixture(extensionEntries(REQUIRED_FILES));

        expect(result.ok).toBe(true);
        expect(result.errors).toEqual([]);
        expect(listFiles).toHaveBeenCalledOnce();
    });

    it("rejects a missing required runtime payload", async () => {
        const expectedFiles = REQUIRED_FILES.filter(
            (file) => file !== "dist/webview-commitpanel.js",
        );
        const { result } = await verifyFixture(
            extensionEntries(REQUIRED_FILES, ["dist/webview-commitpanel.js"]),
            expectedFiles,
        );

        expect(result.ok).toBe(false);
        expect(result.errors.join("\n")).toContain(
            "Missing required VSIX payload: dist/webview-commitpanel.js",
        );
    });

    it("rejects docs while allowing the marketplace documentation files", async () => {
        const expectedFiles = [...REQUIRED_FILES, "docs/internal.md"];
        const { result } = await verifyFixture(extensionEntries(expectedFiles), expectedFiles);

        expect(result.ok).toBe(false);
        expect(result.errors.join("\n")).toContain("Forbidden package path: docs/internal.md");
    });

    it("rejects secret-like filenames", async () => {
        const expectedFiles = [...REQUIRED_FILES, "config/api-token.txt"];
        const { result } = await verifyFixture(extensionEntries(expectedFiles), expectedFiles);

        expect(result.ok).toBe(false);
        expect(result.errors.join("\n")).toContain(
            "Secret-like package path: config/api-token.txt",
        );
    });

    it("rejects source maps", async () => {
        const expectedFiles = [...REQUIRED_FILES, "dist/extension.js.map"];
        const { result } = await verifyFixture(extensionEntries(expectedFiles), expectedFiles);

        expect(result.ok).toBe(false);
        expect(result.errors.join("\n")).toContain("Forbidden source map: dist/extension.js.map");
    });

    it("enforces compressed, total uncompressed, and single-entry budgets", async () => {
        const entries = extensionEntries(REQUIRED_FILES);
        const compressed = await verifyFixture(entries, REQUIRED_FILES, {
            limits: {
                maxCompressedBytes: 1,
                maxUncompressedBytes: MAX_UNCOMPRESSED_BYTES,
                maxEntryUncompressedBytes: MAX_ENTRY_UNCOMPRESSED_BYTES,
            },
        });
        expect(compressed.result.errors.join("\n")).toContain("compressed size");

        const uncompressed = await verifyFixture(
            [...entries, { path: "extension/large.txt", contents: "x".repeat(200) }],
            [...REQUIRED_FILES, "large.txt"],
            {
                limits: {
                    maxCompressedBytes: MAX_COMPRESSED_BYTES,
                    maxUncompressedBytes: 100,
                    maxEntryUncompressedBytes: MAX_ENTRY_UNCOMPRESSED_BYTES,
                },
            },
        );
        expect(uncompressed.result.errors.join("\n")).toContain("total uncompressed size");

        const entry = await verifyFixture(
            [
                ...entries,
                { path: "extension/large.txt", contents: "x".repeat(200), compression: "STORE" },
            ],
            [...REQUIRED_FILES, "large.txt"],
            {
                limits: {
                    maxCompressedBytes: MAX_COMPRESSED_BYTES,
                    maxUncompressedBytes: MAX_UNCOMPRESSED_BYTES,
                    maxEntryUncompressedBytes: 100,
                },
            },
        );
        expect(entry.result.errors.join("\n")).toContain("single-entry uncompressed size");
    });

    it("rejects a VSCE/VSIX file-set mismatch", async () => {
        const expectedFiles = [...REQUIRED_FILES, "dist/not-in-archive.js"];
        const { result } = await verifyFixture(extensionEntries(REQUIRED_FILES), expectedFiles);

        expect(result.ok).toBe(false);
        expect(result.errors.join("\n")).toContain("VSCE expected but VSIX omitted");
    });

    it("rejects payload outside the explicit runtime allowlist", async () => {
        const expectedFiles = [...REQUIRED_FILES, "config.prod.yaml"];
        const { result } = await verifyFixture(extensionEntries(expectedFiles), expectedFiles);

        expect(result.ok).toBe(false);
        expect(result.errors.join("\n")).toContain(
            "Unexpected VSIX payload outside runtime allowlist: config.prod.yaml",
        );
    });

    it("requires both top-level VSIX metadata entries", async () => {
        const entries = extensionEntries(REQUIRED_FILES).filter(
            (entry) => entry.path !== "extension.vsixmanifest",
        );
        const { result } = await verifyFixture(entries);

        expect(result.ok).toBe(false);
        expect(result.errors.join("\n")).toContain(
            "Missing required top-level VSIX metadata: extension.vsixmanifest",
        );
    });

    it.each(["/absolute.txt", "extension\\unsafe.txt", "extension/../escape.txt"])(
        "rejects unsafe archive path %s",
        async (unsafePath) => {
            const { result } = await verifyFixture([
                ...extensionEntries(REQUIRED_FILES),
                { path: unsafePath },
            ]);

            expect(result.ok).toBe(false);
            expect(result.errors.join("\n")).toMatch(/Unsafe archive path/);
        },
    );

    it("rejects malformed archives", async () => {
        const archivePath = join(fixtureRoot, "malformed.vsix");
        writeFileSync(archivePath, "not a zip", "utf8");
        const result = await verifyVsixPackage({
            cwd: fixtureRoot,
            vsixPath: archivePath,
            listFiles: makeListFilesStub(REQUIRED_FILES),
        });

        expect(result.ok).toBe(false);
        expect(result.errors.join("\n")).toMatch(/Malformed VSIX archive/);
    });
});

describe("selectSoleVsix", () => {
    it("selects the only root VSIX", () => {
        writeFileSync(join(fixtureRoot, "one.vsix"), "archive");

        expect(selectSoleVsix(fixtureRoot)).toBe(join(fixtureRoot, "one.vsix"));
    });

    it("rejects no VSIX and multiple root VSIX files", () => {
        expect(() => selectSoleVsix(fixtureRoot)).toThrow(/exactly one root \.vsix/);
        writeFileSync(join(fixtureRoot, "one.vsix"), "archive");
        writeFileSync(join(fixtureRoot, "two.vsix"), "archive");

        expect(() => selectSoleVsix(fixtureRoot)).toThrow(/exactly one root \.vsix/);
    });
});
