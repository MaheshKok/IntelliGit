/**
 * Proves that `tests/setup/gitEnvironment.ts` is actually wired in and actually works.
 *
 * A setup file is exactly the kind of configuration that can be deleted from `vitest.config.ts`,
 * renamed, or silently fail to load, with every other suite still passing -- they would simply go
 * back to reading the developer's `~/.gitconfig`, which on most machines happens to be harmless.
 * The guarantee would be gone and nothing would say so. These tests spawn real Git and assert on
 * what it can see, so the setting is checked by its effect rather than by reading it back.
 */

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const directories: string[] = [];

/**
 * A directory that is not a Git repository, used as the working directory for every configuration
 * probe below.
 *
 * Probing from the repository under test would read IntelliGit's own `.git/config`, which really
 * does set `user.name` -- and legitimately so. That is a LOCAL setting, it is not what this file
 * guards against, and including it made the first version of this test fail while the isolation was
 * working correctly. The hazard is the machine's global and system configuration reaching a fixture
 * repository, and the real suites all run against temporary repositories elsewhere on disk, so a
 * neutral directory is both the correct probe and the faithful one.
 */
let neutralDirectory: string;

beforeAll(async () => {
    neutralDirectory = await mkdtemp(path.join(tmpdir(), "intelligit-git-neutral-"));
    directories.push(neutralDirectory);
});

afterAll(async () => {
    await Promise.all(
        directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
    );
});

/**
 * Reads one config value the way an unprotected test module would: a bare spawn with no `env` of
 * its own, so whatever the process environment holds is what Git sees.
 */
async function readConfig(
    key: string,
    overrides: NodeJS.ProcessEnv = {},
): Promise<{ value: string; exitCode: number }> {
    try {
        const { stdout } = await execFileAsync("git", ["config", "--get", key], {
            cwd: neutralDirectory,
            ...(Object.keys(overrides).length > 0 ? { env: { ...process.env, ...overrides } } : {}),
        });
        return { value: stdout.trim(), exitCode: 0 };
    } catch (error) {
        const failure = error as { code?: number; stdout?: string };
        return { value: (failure.stdout ?? "").trim(), exitCode: failure.code ?? -1 };
    }
}

describe("git environment isolation", () => {
    it("hides the machine's global and system configuration from a bare git spawn", async () => {
        // `user.name` is the value most likely to be set globally on a developer machine, and
        // `core.autocrlf` is the one Git for Windows sets in its SYSTEM config -- the specific
        // setting that made byte-exact assertions fail across the suite on Windows.
        for (const key of ["user.name", "user.email", "core.autocrlf", "diff.renames"]) {
            const { value, exitCode } = await readConfig(key);
            expect(
                { key, value, exitCode },
                `git must not resolve ${key} from the machine's configuration; ` +
                    `tests/setup/gitEnvironment.ts is missing from vitest.config.ts or not loading`,
            ).toEqual({ key, value: "", exitCode: 1 });
        }
    });

    it("would see a global setting if one were reachable", async () => {
        // Vacuity guard for the test above. "Git reported nothing" is also what a broken probe
        // looks like -- a bad key name, a spawn that never ran, a `--get` that cannot resolve
        // anything -- and that failure mode is invisible, because the assertion it defeats is an
        // assertion of absence. Pointing the same probe at a global config that does exist proves
        // the probe can see one, so the empty result above means hidden rather than unreadable.
        const configHome = await mkdtemp(path.join(tmpdir(), "intelligit-git-visible-"));
        directories.push(configHome);
        const configFile = path.join(configHome, "gitconfig");
        await writeFile(configFile, "[user]\n\tname = Reachable Global\n");

        const seen = await readConfig("user.name", { GIT_CONFIG_GLOBAL: configFile });
        expect(seen).toEqual({ value: "Reachable Global", exitCode: 0 });
    });

    it("sets both variables the isolation depends on", () => {
        // Asserted separately from the behaviour above so a failure says WHICH half is missing:
        // `GIT_CONFIG_GLOBAL` alone still leaves the system config -- and therefore Windows'
        // `core.autocrlf=true` -- in play.
        expect(process.env.GIT_CONFIG_NOSYSTEM, "system config must be switched off").toBe("1");
        expect(process.env.GIT_CONFIG_GLOBAL, "global config must be redirected").toBeTruthy();
    });

    it("leaves a repository's own local configuration working", async () => {
        // The isolation must not be so broad that a fixture cannot configure the repository it just
        // created. Every suite here sets identity locally or per-spawn, and all of that must keep
        // working -- as must IntelliGit's own checkout, whose `.git/config` sets `user.name`.
        const repository = await mkdtemp(path.join(tmpdir(), "intelligit-git-isolation-"));
        directories.push(repository);
        await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: repository });
        await execFileAsync("git", ["config", "user.name", "Local Only"], { cwd: repository });

        const { stdout } = await execFileAsync("git", ["config", "--get", "user.name"], {
            cwd: repository,
        });
        expect(stdout.trim()).toBe("Local Only");
    });

    it("keeps line endings verbatim in the working tree through a commit and checkout", async () => {
        // The end-to-end form of the Windows failure, and the assertion has to be made against the
        // WORKING TREE rather than against `git show HEAD:eol.txt`. `core.autocrlf=true` runs in
        // two directions: CRLF collapses to LF on the way into a blob, and LF expands to CRLF on
        // the way back out to disk. Content written as LF therefore lands in the blob unchanged
        // even with autocrlf on, so a blob assertion is green on Windows whether the isolation
        // works or not. The checked-out file is where the corruption becomes visible, and reading a
        // file back from the working tree is exactly what the shelf, patch, and rebase suites do
        // when they report `expected 'third\r\n' to be 'third\n'`.
        const repository = await mkdtemp(path.join(tmpdir(), "intelligit-git-eol-"));
        directories.push(repository);
        const run = (args: readonly string[]): Promise<unknown> =>
            execFileAsync("git", [...args], {
                cwd: repository,
                env: {
                    ...process.env,
                    GIT_AUTHOR_NAME: "T",
                    GIT_AUTHOR_EMAIL: "t@example.invalid",
                    GIT_COMMITTER_NAME: "T",
                    GIT_COMMITTER_EMAIL: "t@example.invalid",
                },
            });

        await run(["init", "-q", "-b", "main"]);
        const file = path.join(repository, "eol.txt");
        await writeFile(file, "first\nsecond\n");
        await run(["add", "eol.txt"]);
        await run(["commit", "-q", "-m", "eol"]);
        await rm(file);
        await run(["checkout", "--", "eol.txt"]);

        const checkedOut = await readFile(file);
        expect(checkedOut.toString("utf8"), "checkout must not expand LF to CRLF").toBe(
            "first\nsecond\n",
        );
    });
});
