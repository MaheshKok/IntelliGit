import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { blameDate, parseBlame, type BlameLine } from "../../../src/git/blame";
import { GitExecutor } from "../../../src/git/executor";
import { removeScratchDirectories } from "../../helpers/scratchDirectories";

const maxOutputBytes = 4 * 1024 * 1024;
const filename = "file with spaces.ts";
const pseudoCommit = "0".repeat(40);

/** Git stamps the --contents pseudo-commit with the wall clock, ignoring GIT_AUTHOR_DATE. */
function withoutPseudoCommitClock(lines: readonly BlameLine[]): BlameLine[] {
    return lines.map((line) => (line.commit === pseudoCommit ? { ...line, authorTime: 0 } : line));
}

/** Copies blame lines, moving the author clock one second later where `shifted` holds. */
function nextSecond(
    lines: readonly BlameLine[],
    shifted: (line: BlameLine) => boolean,
): BlameLine[] {
    return lines.map((line) =>
        shifted(line) ? { ...line, authorTime: line.authorTime + 1 } : line,
    );
}

describe("porcelain blame with real Git", () => {
    let directory: string;
    let executor: GitExecutor;

    beforeEach(async () => {
        directory = await mkdtemp(path.join(tmpdir(), "intelligit-blame-"));
        executor = new GitExecutor(directory);
        await executor.run(["init", "-b", "main"]);
        await executor.run(["config", "user.name", "Blame Author"]);
        await executor.run(["config", "user.email", "author@example.invalid"]);
    });

    afterEach(async () => {
        await removeScratchDirectories(directory);
    });

    /** Commits the on-disk fixture with stable author metadata. */
    async function commit(text: string, author: string, subject: string): Promise<string> {
        await writeFile(path.join(directory, filename), text);
        await executor.run(["add", "--", filename]);
        await executor.run(["commit", "-m", subject], {
            env: {
                GIT_AUTHOR_NAME: author,
                GIT_AUTHOR_DATE: "2000-01-01T00:00:00-08:00",
                GIT_COMMITTER_DATE: "2000-01-01T00:00:00-08:00",
            },
        });
        return (await executor.run(["rev-parse", "HEAD"])).trim();
    }

    it("blames 20,000 lines within the cap that line-porcelain exceeds", async () => {
        const count = 20_000;
        const text = Array.from({ length: count }, (_, index) => `line ${index}\n`).join("");
        const hash = await commit(text, "Ada Lovelace", "Seed medium-sized file");
        const options = { input: Buffer.from(text), maxOutputBytes };
        const repeated = await executor.runBinary(
            ["blame", "--line-porcelain", "--contents", "-", "--", filename],
            options,
        );
        expect(repeated.truncated).toBe(true);

        const compact = await executor.runBinary(
            ["blame", "--porcelain", "--contents", "-", "--", filename],
            options,
        );
        expect(compact.truncated).toBe(false);
        expect(compact.stdout.length).toBeLessThan(maxOutputBytes);
        const lines = parseBlame(compact.stdout.toString("utf8"));
        expect(lines).toHaveLength(count);
        expect(lines.every((line, index) => line.commit === hash && line.line === index)).toBe(
            true,
        );
        expect(
            lines.every(
                (line) =>
                    line.author === "Ada Lovelace" && line.summary === "Seed medium-sized file",
            ),
        ).toBe(true);
        expect(blameDate(lines.at(-1)!)).toBe("2000-01-01");
    });

    it("matches line-porcelain for interleaved commits, blank lines and unsaved edits", async () => {
        const first = await commit(
            "first\n\nthird\nfourth\nfifth\n",
            "Ada Lovelace",
            "Initial source",
        );
        const disk = "first\n\nGrace\nfourth\nfifth\n";
        const second = await commit(disk, "Grace Hopper", String.raw`Fix \[source] *format*`);
        const text = disk.replace("fifth", "unsaved");
        const options = {
            input: Buffer.from(text),
            maxOutputBytes,
            env: { GIT_AUTHOR_DATE: "2000-01-01T00:00:00-08:00" },
        };
        const compact = await executor.runBinary(
            ["blame", "--porcelain", "--contents", "-", "--", filename],
            options,
        );
        const repeated = await executor.runBinary(
            ["blame", "--line-porcelain", "--contents", "-", "--", filename],
            options,
        );
        const lines = withoutPseudoCommitClock(parseBlame(compact.stdout.toString("utf8")));
        const lineLines = parseBlame(repeated.stdout.toString("utf8"));
        expect(lines).toEqual(withoutPseudoCommitClock(lineLines));
        // The two runs may straddle a second boundary; only the pseudo-commit's clock may differ.
        const isPseudo = (line: BlameLine) => line.commit === pseudoCommit;
        expect(lines).toEqual(withoutPseudoCommitClock(nextSecond(lineLines, isPseudo)));
        expect(lines).not.toEqual(
            withoutPseudoCommitClock(nextSecond(lineLines, (line) => !isPseudo(line))),
        );
        expect(lines.map((line) => line.commit)).toEqual([
            first,
            first,
            second,
            first,
            pseudoCommit,
        ]);
        // Git's pseudo-author for --contents varies by version; the zero hash is stable.
        expect(lines.slice(0, 4).map((line) => line.author)).toEqual([
            "Ada Lovelace",
            "Ada Lovelace",
            "Grace Hopper",
            "Ada Lovelace",
        ]);
        expect(lines[2].summary).toBe(String.raw`Fix \[source] *format*`);
        expect(await readFile(path.join(directory, filename), "utf8")).toBe(disk);
    });
});
