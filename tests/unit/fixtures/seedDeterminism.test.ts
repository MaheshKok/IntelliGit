/**
 * Phase 6 step 32: seed determinism over the fully initialized canonical snapshot. The older
 * `seed.test.ts` determinism cases intentionally remain SHA/ref-only; this suite proves the wider
 * claim over allocated copies, profiles, shelf state, ignored/untracked bytes, index data, config,
 * reflogs, and the bare origin.
 */

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { createFixtureWorkspace, type FixtureWorkspace } from "../../fixtures/repo/harness";
import { captured } from "../../fixtures/repo/snapshotTypes";
import {
    captureFixtureSnapshot,
    normalizeFixtureSnapshot,
    type FixtureSnapshot,
} from "../../fixtures/repo/phase6Snapshot";

const execFileAsync = promisify(execFile);
const FIXTURE_TIMEOUT_MS = 60_000;

async function run(
    command: string,
    args: readonly string[],
    cwd: string,
    env: NodeJS.ProcessEnv,
): Promise<string> {
    const result = await execFileAsync(command, [...args], { cwd, env, encoding: "buffer" });
    return result.stdout.toString("utf8").trim();
}

async function capturePair(
    workspacesRoot: string,
): Promise<readonly [FixtureWorkspace, FixtureWorkspace]> {
    return Promise.all([
        createFixtureWorkspace({ scenario: "shelf-populated", workspacesRoot }),
        createFixtureWorkspace({ scenario: "shelf-populated", workspacesRoot }),
    ]);
}

async function capturePairSnapshots(workspacesRoot: string): Promise<{
    readonly workspaces: readonly [FixtureWorkspace, FixtureWorkspace];
    readonly snapshots: readonly [FixtureSnapshot, FixtureSnapshot];
}> {
    const workspaces = await capturePair(workspacesRoot);
    const snapshots = await Promise.all(workspaces.map(captureFixtureSnapshot));
    return {
        workspaces,
        snapshots: snapshots as readonly [FixtureSnapshot, FixtureSnapshot],
    };
}

async function assertFullyInitialized(
    workspace: FixtureWorkspace,
    snapshot: FixtureSnapshot,
): Promise<void> {
    expect((await stat(workspace.profileDir)).isDirectory()).toBe(true);
    expect(workspace.shelfStorageRoot).toBeDefined();
    expect(snapshot.snapshot.durableState.status).toBe("captured");
    if (snapshot.snapshot.durableState.status !== "captured") return;
    expect(
        snapshot.snapshot.durableState.data.shelfFiles.some((entry) => entry.type === "file"),
    ).toBe(true);
}

describe("Phase 6 step 32 -- canonical snapshot seed determinism", () => {
    let workspaces: FixtureWorkspace[] = [];
    let cleanupDirs: string[] = [];

    afterEach(async () => {
        await Promise.all(workspaces.map((workspace) => workspace.dispose()));
        await Promise.all(
            cleanupDirs.map((directory) => rm(directory, { recursive: true, force: true })),
        );
        workspaces = [];
        cleanupDirs = [];
    }, FIXTURE_TIMEOUT_MS);

    it(
        "compares two fully initialized workspaces by their normalized canonical snapshots",
        async () => {
            const workspacesRoot = await mkdtemp(
                path.join(tmpdir(), "intelligit-phase6-seed-pair-"),
            );
            cleanupDirs.push(workspacesRoot);
            const result = await capturePairSnapshots(workspacesRoot);
            workspaces.push(...result.workspaces);

            await Promise.all(
                result.workspaces.map((workspace, index) =>
                    assertFullyInitialized(workspace, result.snapshots[index]!),
                ),
            );

            expect(normalizeFixtureSnapshot(result.snapshots[0]!)).toEqual(
                normalizeFixtureSnapshot(result.snapshots[1]!),
            );
        },
        FIXTURE_TIMEOUT_MS,
    );

    it(
        "seeds identically under two different ambient timezones, because the pinned dates carry an explicit offset",
        async () => {
            const workspacesRoot = await mkdtemp(path.join(tmpdir(), "intelligit-phase6-seed-tz-"));
            cleanupDirs.push(workspacesRoot);

            // The hostile-environment case below runs BOTH workspaces under the SAME hostile
            // ambient value, so a setting that leaks identically into both still compares equal --
            // that comparison cannot witness a timezone leak at all. Only a cross-environment pair
            // can. `seed.ts` pins commit dates as "2000-01-01T00:00:00 +0000"; drop that explicit
            // offset and the ambient zone shifts every commit, and therefore every SHA, in exactly
            // one of these two workspaces.
            const underTimezone = async (timezone: string): Promise<FixtureSnapshot> => {
                const savedTimezone = process.env.TZ;
                process.env.TZ = timezone;
                try {
                    const workspace = await createFixtureWorkspace({
                        scenario: "shelf-populated",
                        workspacesRoot,
                    });
                    workspaces.push(workspace);
                    // Proves the ambient zone actually reached the seeding boundary. Without this
                    // the test passes just as happily on a machine where TZ never took effect.
                    expect(workspace.env.TZ).toBe(timezone);
                    return await captureFixtureSnapshot(workspace);
                } finally {
                    if (savedTimezone === undefined) delete process.env.TZ;
                    else process.env.TZ = savedTimezone;
                }
            };

            const utcSnapshot = await underTimezone("UTC");
            const aucklandSnapshot = await underTimezone("Pacific/Auckland");

            expect(normalizeFixtureSnapshot(utcSnapshot)).toEqual(
                normalizeFixtureSnapshot(aucklandSnapshot),
            );
        },
        FIXTURE_TIMEOUT_MS,
    );

    it(
        "RED-proof #1: a substantive index flag survives canonical normalization",
        async () => {
            const workspacesRoot = await mkdtemp(
                path.join(tmpdir(), "intelligit-phase6-normalization-red-"),
            );
            cleanupDirs.push(workspacesRoot);
            const result = await capturePairSnapshots(workspacesRoot);
            workspaces.push(...result.workspaces);

            const original = result.snapshots[0]!;
            const index = original.snapshot.workspace.index;
            expect(index.status).toBe("captured");
            if (index.status !== "captured" || index.data.length === 0) return;

            const first = index.data[0]!;
            const badSnapshot: FixtureSnapshot = {
                ...original,
                snapshot: {
                    ...original.snapshot,
                    workspace: {
                        ...original.snapshot.workspace,
                        index: captured([
                            { ...first, flag: first.flag === "H" ? "h" : "H" },
                            ...index.data.slice(1),
                        ]),
                    },
                },
            };

            expect(normalizeFixtureSnapshot(original)).not.toEqual(
                normalizeFixtureSnapshot(badSnapshot),
            );
        },
        FIXTURE_TIMEOUT_MS,
    );

    it(
        "RED-proof #2: changed untracked and ignored bytes survive canonical normalization",
        async () => {
            const workspacesRoot = await mkdtemp(
                path.join(tmpdir(), "intelligit-phase6-working-tree-red-"),
            );
            cleanupDirs.push(workspacesRoot);
            const result = await capturePairSnapshots(workspacesRoot);
            workspaces.push(...result.workspaces);

            const [workspaceA, workspaceB] = result.workspaces;
            await writeFile(
                path.join(workspaceA.root, "phase6-untracked.txt"),
                "same bytes\n",
                "utf8",
            );
            await writeFile(
                path.join(workspaceB.root, "phase6-untracked.txt"),
                "same bytes\n",
                "utf8",
            );
            await writeFile(
                path.join(workspaceA.root, "ignored", "phase6-build.log"),
                "same ignored bytes\n",
                "utf8",
            );
            await writeFile(
                path.join(workspaceB.root, "ignored", "phase6-build.log"),
                "same ignored bytes\n",
                "utf8",
            );

            const beforeA = await captureFixtureSnapshot(workspaceA);
            const beforeB = await captureFixtureSnapshot(workspaceB);
            await writeFile(
                path.join(workspaceB.root, "phase6-untracked.txt"),
                "different bytes\n",
                "utf8",
            );
            await writeFile(
                path.join(workspaceB.root, "ignored", "phase6-build.log"),
                "different ignored bytes\n",
                "utf8",
            );
            const afterB = await captureFixtureSnapshot(workspaceB);

            expect(normalizeFixtureSnapshot(beforeA)).not.toEqual(normalizeFixtureSnapshot(afterB));
            expect(normalizeFixtureSnapshot(beforeA)).toEqual(normalizeFixtureSnapshot(beforeB));
        },
        FIXTURE_TIMEOUT_MS,
    );

    it(
        "RED-proof #3: a changed repository config value survives canonical normalization",
        async () => {
            const workspacesRoot = await mkdtemp(
                path.join(tmpdir(), "intelligit-phase6-config-red-"),
            );
            cleanupDirs.push(workspacesRoot);
            const result = await capturePairSnapshots(workspacesRoot);
            workspaces.push(...result.workspaces);
            const beforeA = await captureFixtureSnapshot(result.workspaces[0]!);
            const beforeB = await captureFixtureSnapshot(result.workspaces[1]!);

            await run(
                "git",
                ["config", "phase6.oracle", "changed-value"],
                result.workspaces[1]!.root,
                result.workspaces[1]!.env,
            );
            const after = await captureFixtureSnapshot(result.workspaces[1]!);

            expect(normalizeFixtureSnapshot(beforeA)).toEqual(normalizeFixtureSnapshot(beforeB));
            expect(normalizeFixtureSnapshot(beforeA)).not.toEqual(normalizeFixtureSnapshot(after));
        },
        FIXTURE_TIMEOUT_MS,
    );

    it(
        "RED-proof #4: hostile global config and timezone reach an unsanitized control, then stay out of the pair",
        async () => {
            const workspacesRoot = await mkdtemp(
                path.join(tmpdir(), "intelligit-phase6-hostile-env-"),
            );
            const ambientRoot = await mkdtemp(
                path.join(tmpdir(), "intelligit-phase6-hostile-global-"),
            );
            cleanupDirs.push(workspacesRoot, ambientRoot);
            const globalConfig = path.join(ambientRoot, ".gitconfig");
            await writeFile(
                globalConfig,
                "[user]\n\tname = Ambient Hostile User\n\temail = hostile@example.invalid\n[core]\n\tautocrlf = true\n",
                "utf8",
            );
            // The system half of the hostile env is "nothing", but it still has to be expressible
            // on Windows, where `/dev/null` is unopenable. An empty real file says the same thing
            // everywhere.
            const emptySystemConfig = path.join(ambientRoot, "empty-system-gitconfig");
            await writeFile(emptySystemConfig, "");

            const savedEnvironment = {
                GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
                GIT_CONFIG_SYSTEM: process.env.GIT_CONFIG_SYSTEM,
                HOME: process.env.HOME,
                TZ: process.env.TZ,
            };
            const hostileEnvironment: NodeJS.ProcessEnv = {
                ...process.env,
                GIT_CONFIG_GLOBAL: globalConfig,
                GIT_CONFIG_SYSTEM: emptySystemConfig,
                HOME: ambientRoot,
                TZ: "Pacific/Auckland",
            };
            delete hostileEnvironment.GIT_AUTHOR_NAME;
            delete hostileEnvironment.GIT_AUTHOR_EMAIL;
            delete hostileEnvironment.GIT_COMMITTER_NAME;
            delete hostileEnvironment.GIT_COMMITTER_EMAIL;
            delete hostileEnvironment.GIT_AUTHOR_DATE;
            delete hostileEnvironment.GIT_COMMITTER_DATE;
            Object.assign(process.env, {
                GIT_CONFIG_GLOBAL: globalConfig,
                GIT_CONFIG_SYSTEM: emptySystemConfig,
                HOME: ambientRoot,
                TZ: "Pacific/Auckland",
            });

            try {
                const controlRoot = await mkdtemp(path.join(ambientRoot, "control-"));
                cleanupDirs.push(controlRoot);
                const controlName = await run(
                    "git",
                    ["config", "--global", "--get", "user.name"],
                    controlRoot,
                    hostileEnvironment,
                );
                const controlAutocrlf = await run(
                    "git",
                    ["config", "--global", "--get", "core.autocrlf"],
                    controlRoot,
                    hostileEnvironment,
                );
                // Node, not `date`. `date` is not a Windows program at all, and the MSYS
                // `date.exe` Git for Windows puts on PATH answers `+0000` for an IANA zone name it
                // has no tzdata for -- so this control claimed the ambient zone never reached the
                // child on a runner where it plainly had, and failed the one assertion whose whole
                // job is to stop the rest of the test passing vacuously. `process.execPath` is the
                // one interpreter guaranteed present on every leg, and its bundled ICU resolves
                // `Pacific/Auckland` identically on all three.
                const controlTimezone = await run(
                    process.execPath,
                    ["-e", "process.stdout.write(String(new Date().getTimezoneOffset()))"],
                    controlRoot,
                    hostileEnvironment,
                );
                expect(controlName).toBe("Ambient Hostile User");
                expect(controlAutocrlf).toBe("true");
                // UTC is 0; Pacific/Auckland is -720 or -780 depending on DST. A zero here
                // means the hostile TZ never reached the child and everything below is vacuous.
                expect(controlTimezone).not.toBe("0");

                const result = await capturePairSnapshots(workspacesRoot);
                workspaces.push(...result.workspaces);
                for (const workspace of result.workspaces) {
                    // By content, not by literal path: `/dev/null` reads as empty on POSIX but is
                    // unopenable on Windows, and only reading it can tell those two apart.
                    expect(
                        await readFile(workspace.env.GIT_CONFIG_GLOBAL as string, "utf8"),
                        "GIT_CONFIG_GLOBAL must point at a real, EMPTY config file",
                    ).toBe("");
                    expect(workspace.env.TZ).toBe("Pacific/Auckland");
                    await expect(
                        run(
                            "git",
                            ["config", "--global", "--get", "user.name"],
                            workspace.root,
                            workspace.env,
                        ),
                    ).rejects.toBeDefined();
                    expect(
                        await run(
                            "git",
                            ["config", "--get", "core.autocrlf"],
                            workspace.root,
                            workspace.env,
                        ),
                    ).toBe("false");
                }
                expect(normalizeFixtureSnapshot(result.snapshots[0]!)).toEqual(
                    normalizeFixtureSnapshot(result.snapshots[1]!),
                );
            } finally {
                for (const [key, value] of Object.entries(savedEnvironment)) {
                    if (value === undefined) delete process.env[key];
                    else process.env[key] = value;
                }
            }
        },
        FIXTURE_TIMEOUT_MS,
    );
});
