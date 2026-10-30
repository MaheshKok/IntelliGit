import { writeFile } from "node:fs/promises";
import path from "node:path";
import { runGitRaw } from "../../fixtures/repo/gitRun";

/** Creates three independently dated source-line owners in an already-disposable repository. */
export async function createBlameAgeFixture(
    root: string,
    environment: NodeJS.ProcessEnv,
): Promise<string> {
    const file = "blame-age-smoke.ts";
    for (const [date, middle, recent] of [
        ["2000-01-01T00:00:00+00:00", "original", "original"],
        ["2013-01-01T00:00:00+00:00", "middle", "original"],
        ["2020-01-01T00:00:00+00:00", "middle", "recent"],
    ]) {
        await writeFile(
            path.join(root, file),
            `export const oldest = "old";\nexport const middle = "${middle}";\nexport const recent = "${recent}";\n`,
        );
        await runGitRaw(root, ["add", "--", file], environment);
        await runGitRaw(root, ["commit", "-m", `Blame age fixture ${date.slice(0, 4)}`], {
            ...environment,
            GIT_AUTHOR_DATE: date,
            GIT_COMMITTER_DATE: date,
        });
    }
    return file;
}
