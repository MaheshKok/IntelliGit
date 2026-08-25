import { mkdir, mkdtemp, realpath, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
    ShelfImportValidationError,
    normalizeImportedPatchPath,
    resolveValidatedImportPath,
    validateImportedPatch,
    validateImportedPatchStream,
    validateShelfManifestPath,
} from "../../../src/shelf/importValidation";
import { removeScratchDirectories } from "../../helpers/scratchDirectories";

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories.splice(0).map((directory) => removeScratchDirectories(directory)),
    );
});

async function temporaryDirectory(): Promise<string> {
    const directory = await mkdtemp(path.join(tmpdir(), "intelligit-import-validation-"));
    temporaryDirectories.push(directory);
    return directory;
}

function textPatch(file = "file.txt", addition = "after"): Buffer {
    return Buffer.from(
        [
            `diff --git a/${file} b/${file}`,
            "index 1111111..2222222 100644",
            `--- a/${file}`,
            `+++ b/${file}`,
            "@@ -1 +1 @@",
            "-before",
            `+${addition}`,
            "",
        ].join("\n"),
        "utf8",
    );
}

function twoHunkPatch(): Buffer {
    return Buffer.from(
        [
            "diff --git a/file.txt b/file.txt",
            "index 1111111..2222222 100644",
            "--- a/file.txt",
            "+++ b/file.txt",
            "@@ -1 +1 @@",
            "-before",
            "+after",
            "@@ -3 +3 @@",
            "-before again",
            "+after again",
            "",
        ].join("\n"),
        "utf8",
    );
}

describe("shelf import validation", () => {
    it("accepts Git patch names only after strip-level normalization", async () => {
        const patch = textPatch("src/file.txt");

        await expect(
            validateImportedPatchStream([patch.subarray(0, 13), patch.subarray(13)], {
                stripLevel: 1,
            }),
        ).resolves.toMatchObject({
            files: [
                {
                    path: "src/file.txt",
                    type: "regular",
                    hunkCount: 1,
                },
            ],
        });
        expect(normalizeImportedPatchPath("a/src/file.txt", 1)).toBe("src/file.txt");
        expect(() => normalizeImportedPatchPath("a/file.txt", 2)).toThrow(
            ShelfImportValidationError,
        );
    });

    it("accepts valid Unicode scalars and rejects unsafe Unicode path code points", () => {
        for (const pathname of ["emoji/\u{1f600}.txt", "supplementary/\u{20000}.txt"]) {
            expect(validateShelfManifestPath(pathname)).toBe(pathname);
            expect(normalizeImportedPatchPath(`a/${pathname}`)).toBe(pathname);
        }

        for (const pathname of [
            "control/\u0001.txt",
            "control/\u0085.txt",
            "surrogate/\ud800.txt",
            "surrogate/\udc00.txt",
            "noncharacter/\ufdd0.txt",
            "noncharacter/\uffff.txt",
            "noncharacter/\u{1fffe}.txt",
            "noncharacter/\u{10ffff}.txt",
        ]) {
            expect(() => validateShelfManifestPath(pathname)).toThrow(ShelfImportValidationError);
            expect(() => normalizeImportedPatchPath(`a/${pathname}`)).toThrow(
                ShelfImportValidationError,
            );
        }
    });

    it("rejects traversal and platform-unsafe patch and manifest paths on every host", () => {
        for (const value of [
            "a/../outside.txt",
            "a/.git/hooks/pre-commit",
            "a/.GiT/config",
            "a/normal:stream",
            "a/CON",
            "a/aux.txt",
            "a/LPT1/log.txt",
            "a/C:/drive.txt",
            "a/\\\\server/share.txt",
            "/absolute.txt",
        ]) {
            expect(() => normalizeImportedPatchPath(value, 0)).toThrow(ShelfImportValidationError);
        }
        for (const value of [
            "../outside.txt",
            ".GIT/config",
            "x:stream",
            "COM1.txt",
            "C:/drive.txt",
            "\\\\host\\share\\x",
        ]) {
            expect(() => validateShelfManifestPath(value)).toThrow(ShelfImportValidationError);
        }
        for (const file of [
            "../outside.txt",
            ".git/hooks/pre-commit",
            ".GiT/config",
            "x:stream",
            "CON",
            "C:/drive.txt",
            "\\\\host\\share.txt",
        ]) {
            expect(() => validateImportedPatch(textPatch(file))).toThrow(
                ShelfImportValidationError,
            );
        }
        expect(() =>
            validateImportedPatch(
                Buffer.from(
                    [
                        "diff --git a/old.txt b/new.txt",
                        "similarity index 100%",
                        "rename from ../outside.txt",
                        "rename to new.txt",
                        "",
                    ].join("\n"),
                ),
            ),
        ).toThrow(ShelfImportValidationError);
    });

    it("allows only regular file modes", () => {
        const executable = Buffer.from(
            [
                "diff --git a/run.sh b/run.sh",
                "new file mode 100755",
                "index 0000000..1111111",
                "--- /dev/null",
                "+++ b/run.sh",
                "@@ -0,0 +1 @@",
                "+echo run",
                "",
            ].join("\n"),
        );

        expect(validateImportedPatch(executable).files[0]?.type).toBe("regular");
        expect(
            validateImportedPatch(
                Buffer.from(
                    [
                        "diff --git a/image.bin b/image.bin",
                        "new file mode 100644",
                        "GIT binary patch",
                        "literal 1",
                        "A!",
                        "",
                    ].join("\n"),
                ),
            ).files[0]?.declaredResultBytes,
        ).toBe(1);
        expect(
            validateImportedPatch(
                Buffer.from(
                    [
                        "diff --git a/image.bin b/image.bin",
                        "new file mode 100644",
                        "GIT binary patch",
                        "literal 1",
                        "A!",
                        "literal 1",
                        "A!",
                        "",
                    ].join("\n"),
                ),
            ).files[0]?.declaredResultBytes,
        ).toBe(2);
        for (const mode of ["120000", "160000", "040000"]) {
            expect(() =>
                validateImportedPatch(
                    Buffer.from(
                        [
                            "diff --git a/file b/file",
                            `new file mode ${mode}`,
                            "index 0000000..1111111",
                            "GIT binary patch",
                            "literal 1",
                            "A!",
                            "",
                        ].join("\n"),
                    ),
                ),
            ).toThrow(ShelfImportValidationError);
        }
    });

    it("rejects symlink escapes while resolving a validated path below a repository root", async () => {
        const temporary = await temporaryDirectory();
        const root = path.join(temporary, "repository");
        const outside = path.join(temporary, "outside");
        await Promise.all([mkdir(root), mkdir(outside)]);
        await mkdir(path.join(root, "inside"));
        await symlink(outside, path.join(root, "escape"));

        await expect(resolveValidatedImportPath(root, "escape/payload.txt")).rejects.toThrow(
            ShelfImportValidationError,
        );
        await expect(resolveValidatedImportPath(root, "inside/payload.txt")).resolves.toBe(
            path.join(await realpath(root), "inside", "payload.txt"),
        );
    });

    it("rejects source, binary, decoded-output, hunk, and aggregate expansion bombs before allocation", () => {
        expect(() => validateImportedPatch(textPatch(), { limits: { maxSourceBytes: 4 } })).toThrow(
            ShelfImportValidationError,
        );
        expect(() =>
            validateImportedPatch(
                Buffer.from(
                    [
                        "diff --git a/image.bin b/image.bin",
                        "new file mode 100644",
                        "GIT binary patch",
                        "literal 999999",
                        "A!",
                        "",
                    ].join("\n"),
                ),
                { limits: { maxDeclaredResultBytes: 8 } },
            ),
        ).toThrow(ShelfImportValidationError);
        expect(() =>
            validateImportedPatch(twoHunkPatch(), { limits: { maxHunksPerFile: 1 } }),
        ).toThrow(ShelfImportValidationError);
        expect(() =>
            validateImportedPatch(textPatch(), { limits: { maxLinesPerFile: 1 } }),
        ).toThrow(ShelfImportValidationError);
        expect(() =>
            validateImportedPatch(textPatch("file.txt", "long decoded output"), {
                limits: { maxDecodedBytesPerFile: 4 },
            }),
        ).toThrow(ShelfImportValidationError);
        expect(() =>
            validateImportedPatch(
                Buffer.concat([textPatch("one.txt", "a"), textPatch("two.txt", "b")]),
                {
                    limits: { maxDecodedBytesTotal: 3 },
                },
            ),
        ).toThrow(ShelfImportValidationError);
    });

    it("rejects malformed binary payloads, incomplete hunks, and malformed UTF-8 headers", () => {
        expect(() =>
            validateImportedPatch(
                Buffer.from(
                    [
                        "diff --git a/image.bin b/image.bin",
                        "new file mode 100644",
                        "GIT binary patch",
                        "literal 1",
                        "",
                    ].join("\n"),
                ),
            ),
        ).toThrow(ShelfImportValidationError);
        expect(() =>
            validateImportedPatch(
                Buffer.from(
                    [
                        "diff --git a/file.txt b/file.txt",
                        "--- a/file.txt",
                        "+++ b/file.txt",
                        "@@ -1,2 +1,2 @@",
                        "-before",
                        "",
                    ].join("\n"),
                ),
            ),
        ).toThrow(ShelfImportValidationError);
        const malformedHeader = Buffer.concat([
            Buffer.from("diff --git a/file.txt b/", "utf8"),
            Buffer.from([0xff]),
            Buffer.from("\n", "utf8"),
        ]);
        expect(() => validateImportedPatch(malformedHeader)).toThrow(ShelfImportValidationError);
    });
});
