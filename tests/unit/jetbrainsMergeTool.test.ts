import * as os from "os";
import * as path from "path";
import { promises as fsp } from "fs";
import { describe, expect, it } from "vitest";
import {
    containsConflictMarkers,
    launchJetBrainsMergeTool,
    resolveJetBrainsMergeBinaryPath,
} from "../../src/utils/jetbrainsMergeTool";

async function pathExists(filePath: string): Promise<boolean> {
    try {
        await fsp.access(filePath);
        return true;
    } catch {
        return false;
    }
}

describe("containsConflictMarkers", () => {
    it("detects a complete conflict marker block", () => {
        expect(
            containsConflictMarkers(
                [
                    "before",
                    "<<<<<<< HEAD",
                    "ours",
                    "=======",
                    "theirs",
                    ">>>>>>> feature",
                    "after",
                ].join("\n"),
            ),
        ).toBe(true);
    });

    it("detects CRLF conflict marker blocks", () => {
        expect(
            containsConflictMarkers(
                ["<<<<<<< HEAD", "ours", "=======", "theirs", ">>>>>>> feature"].join("\r\n"),
            ),
        ).toBe(true);
    });

    it("rejects incomplete or out-of-order conflict markers", () => {
        expect(containsConflictMarkers("<<<<<<< HEAD\nours\n=======\nstill missing end\n")).toBe(
            false,
        );
        expect(containsConflictMarkers(">>>>>>> feature\n=======\n<<<<<<< HEAD\n")).toBe(false);
    });

    it("handles large non-conflicted content without reporting a conflict", () => {
        const largeContent = Array.from({ length: 20_000 }, (_, index) => {
            if (index === 100) return "<<<<<<< not a complete conflict";
            if (index === 10_000) return "regular content separator ======= inline";
            return `line ${index}`;
        }).join("\n");

        expect(containsConflictMarkers(largeContent)).toBe(false);
    });
});

describe("launchJetBrainsMergeTool", () => {
    it("writes temp merge inputs, launches without shell expansion, and cleans temp files", async () => {
        const testRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "intelligit-merge-tool-test-"));
        const scriptPath = path.join(testRoot, "fake-merge.sh");
        const outputFileFsPath = path.join(testRoot, "merged.txt");
        try {
            await fsp.writeFile(
                scriptPath,
                [
                    "#!/bin/sh",
                    'printf \'%s\\n\' "$@" > "$5.args"',
                    'cat "$3" > "$5"',
                    "exit 0",
                    "",
                ].join("\n"),
                "utf8",
            );
            await fsp.chmod(scriptPath, 0o755);

            const result = await launchJetBrainsMergeTool({
                binaryPath: scriptPath,
                repoRootFsPath: testRoot,
                relativeFilePath: "src/feature file.txt",
                outputFileFsPath,
                baseContent: "base TOKEN_SHOULD_STAY_IN_FILE_CONTENT",
                oursContent: "ours content",
                theirsContent: "theirs content",
            });

            expect(result).toEqual({ exitCode: 0, signal: null });
            await expect(fsp.readFile(outputFileFsPath, "utf8")).resolves.toBe("theirs content");

            const args = (await fsp.readFile(`${outputFileFsPath}.args`, "utf8"))
                .trim()
                .split("\n");
            expect(args[0]).toBe("merge");
            expect(args[1]).toContain(".intelligit-ours-feature_file.txt");
            expect(args[2]).toContain(".intelligit-theirs-feature_file.txt");
            expect(args[3]).toContain(".intelligit-base-feature_file.txt");
            expect(args[4]).toBe(outputFileFsPath);
            expect(args.join("\n")).not.toContain("TOKEN_SHOULD_STAY_IN_FILE_CONTENT");
            await expect(pathExists(args[1])).resolves.toBe(false);
            await expect(pathExists(args[2])).resolves.toBe(false);
            await expect(pathExists(args[3])).resolves.toBe(false);
        } finally {
            await fsp.rm(testRoot, { recursive: true, force: true });
        }
    });

    it("surfaces non-zero stderr and still removes temporary merge inputs", async () => {
        const testRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "intelligit-merge-tool-fail-"));
        const scriptPath = path.join(testRoot, "fake-merge-fail.sh");
        const outputFileFsPath = path.join(testRoot, "merged.txt");
        try {
            await fsp.writeFile(
                scriptPath,
                [
                    "#!/bin/sh",
                    'printf \'%s\\n\' "$@" > "$5.args"',
                    "printf '%s\\n' 'merge failed loudly' >&2",
                    "exit 2",
                    "",
                ].join("\n"),
                "utf8",
            );
            await fsp.chmod(scriptPath, 0o755);

            await expect(
                launchJetBrainsMergeTool({
                    binaryPath: scriptPath,
                    repoRootFsPath: testRoot,
                    relativeFilePath: "conflicted.ts",
                    outputFileFsPath,
                    baseContent: "base",
                    oursContent: "ours",
                    theirsContent: "theirs",
                }),
            ).rejects.toThrow("JetBrains merge tool exited with code 2: merge failed loudly");

            const args = (await fsp.readFile(`${outputFileFsPath}.args`, "utf8"))
                .trim()
                .split("\n");
            await expect(pathExists(args[1])).resolves.toBe(false);
            await expect(pathExists(args[2])).resolves.toBe(false);
            await expect(pathExists(args[3])).resolves.toBe(false);
        } finally {
            await fsp.rm(testRoot, { recursive: true, force: true });
        }
    });

    it("rejects blank merge tool paths before spawning", async () => {
        await expect(resolveJetBrainsMergeBinaryPath("   ")).rejects.toThrow(
            "JetBrains merge tool path is empty.",
        );
    });

    it("rejects relative merge tool paths before spawning", async () => {
        await expect(resolveJetBrainsMergeBinaryPath("pycharm")).rejects.toThrow(
            "JetBrains merge tool path must be absolute.",
        );
    });
});
