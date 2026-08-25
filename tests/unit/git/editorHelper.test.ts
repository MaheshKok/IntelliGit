import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
    createGitEditorCommand,
    quoteGitEditorArgument,
} from "../../../src/git/interactiveRebase/editorCommand";
import { supportsPosixShell } from "../../helpers/platformCapabilities";
import { removeScratchDirectories } from "../../helpers/scratchDirectories";

const HASH_A = "a".repeat(40);
const HASH_B = "b".repeat(40);
const HASH_C = "c".repeat(40);
const HELPER_PATH = path.resolve(process.cwd(), "dist/interactive-rebase-editor-helper.cjs");
const directories: string[] = [];
const itPosix = supportsPosixShell ? it : it.skip;

afterEach(async () => {
    await Promise.all(
        directories.splice(0).map((directory) => removeScratchDirectories(directory)),
    );
});

interface HelperFixture {
    consumptionDirectory: string;
    gitDirectory: string;
    messagePath: string;
    rebaseMergeDirectory: string;
    sequencePath: string;
    sessionDirectory: string;
    sessionId: string;
}

interface MessageFixtureOptions {
    done?: string;
    markerSessionId?: string;
    messageMap?: Record<string, { action: "reword" | "squash"; message: string }>;
    msgnum?: string;
    todo?: string;
}

/** Creates a Git-like rebase state directory and Phase 1-compatible session artifacts. */
async function createFixture(options: MessageFixtureOptions = {}): Promise<HelperFixture> {
    const root = await mkdtemp(path.join(tmpdir(), "intelligit-editor-helper-"));
    directories.push(root);

    const sessionId = "session-helper";
    const gitDirectory = path.join(root, "git");
    const rebaseMergeDirectory = path.join(gitDirectory, "rebase-merge");
    const sessionDirectory = path.join(root, "sessions", sessionId);
    const consumptionDirectory = path.join(sessionDirectory, "consumed");
    const sequencePath = path.join(rebaseMergeDirectory, "git-rebase-todo");
    const messagePath = path.join(gitDirectory, "COMMIT_EDITMSG");

    await mkdir(rebaseMergeDirectory, { recursive: true });
    await mkdir(consumptionDirectory, { recursive: true });
    await writeFile(
        path.join(sessionDirectory, "todo"),
        options.todo ?? `reword ${HASH_A} replace\npick ${HASH_B} retain\n`,
        "utf8",
    );
    await writeFile(
        path.join(sessionDirectory, "messages.json"),
        JSON.stringify(
            options.messageMap ?? {
                [HASH_A]: { action: "reword", message: "replacement message" },
            },
        ),
        "utf8",
    );
    await writeFile(
        path.join(rebaseMergeDirectory, "done"),
        options.done ?? `reword ${HASH_A}\n`,
        "utf8",
    );
    await writeFile(path.join(rebaseMergeDirectory, "msgnum"), options.msgnum ?? "1\n", "utf8");
    if (options.markerSessionId !== undefined) {
        await writeFile(
            path.join(rebaseMergeDirectory, "intelligit-session"),
            options.markerSessionId,
            "utf8",
        );
    }
    await writeFile(messagePath, "untouched message", "utf8");

    return {
        consumptionDirectory,
        gitDirectory,
        messagePath,
        rebaseMergeDirectory,
        sequencePath,
        sessionDirectory,
        sessionId,
    };
}

/** Invokes the built CommonJS helper exactly as Git invokes an editor command. */
function runHelper(
    role: "message" | "sequence",
    sessionDirectory: string,
    editorPath: string,
): ReturnType<typeof spawnSync> {
    return spawnSync(process.execPath, [HELPER_PATH, role, sessionDirectory, editorPath], {
        encoding: "utf8",
    });
}

describe("interactive rebase editor helper", () => {
    it("ships the built helper in dist", () => {
        expect(existsSync(HELPER_PATH)).toBe(true);
    });

    it("exposes the command builders from a module the extension host can import safely", () => {
        // `editorHelper.ts` runs `main()` on import, so importing it from the host reports an
        // invalid invocation and sets the host's exit code. The builders therefore live in a
        // side-effect-free sibling. Both halves are probed in a clean child process, because the
        // property under test is what a bare import does to the process that performs it.
        const probe = (target: string): ReturnType<typeof spawnSync> =>
            spawnSync(
                process.execPath,
                [
                    "-e",
                    `require(${JSON.stringify(
                        target,
                    )});process.stdout.write(String(process.exitCode));`,
                ],
                { encoding: "utf8" },
            );

        // The builder module is probed from source because it is the host-facing half and imports
        // nothing at runtime, so Node's type stripping resolves it unaided.
        const safe = probe(
            path.resolve(process.cwd(), "src/git/interactiveRebase/editorCommand.ts"),
        );
        expect(safe.status).toBe(0);
        expect(safe.stdout).toBe("undefined");
        expect(safe.stderr).toBe("");

        // The CLI half must keep executing on import — that is how Git runs it as an editor. It is
        // probed as the bundled artifact because that is the only form Git ever loads, and because
        // the source form imports the shared marker constant through a relative specifier that
        // Node's type stripping does not resolve.
        const cli = probe(HELPER_PATH);
        expect(cli.stdout).toBe("1");
        expect(cli.stderr).toContain("invalid-invocation");
    });

    it("writes the submitted todo and ownership marker in sequence mode", async () => {
        const fixture = await createFixture({ markerSessionId: "session-helper" });
        const todo = `pick ${HASH_B} retain\nreword ${HASH_A} replace\n`;
        await writeFile(path.join(fixture.sessionDirectory, "todo"), todo, "utf8");

        const result = runHelper("sequence", fixture.sessionDirectory, fixture.sequencePath);

        expect(result.status).toBe(0);
        await expect(readFile(fixture.sequencePath, "utf8")).resolves.toBe(todo);
        await expect(
            readFile(path.join(fixture.rebaseMergeDirectory, "intelligit-session"), "utf8"),
        ).resolves.toBe(fixture.sessionId);
    });

    it("writes a resolved prepared message and records its consumption", async () => {
        const fixture = await createFixture({ markerSessionId: "session-helper" });

        const result = runHelper("message", fixture.sessionDirectory, fixture.messagePath);

        expect(result.status).toBe(0);
        await expect(readFile(fixture.messagePath, "utf8")).resolves.toBe("replacement message");
        expect(existsSync(path.join(fixture.consumptionDirectory, HASH_A))).toBe(true);
    });

    it("leaves a positively resolved message-free pick untouched", async () => {
        const fixture = await createFixture({
            done: `pick ${HASH_B}\n`,
            markerSessionId: "session-helper",
            messageMap: { [HASH_A]: { action: "reword", message: "later replacement" } },
        });

        const result = runHelper("message", fixture.sessionDirectory, fixture.messagePath);

        expect(result.status).toBe(0);
        await expect(readFile(fixture.messagePath, "utf8")).resolves.toBe("untouched message");
        expect(existsSync(path.join(fixture.consumptionDirectory, HASH_A))).toBe(false);
    });

    it("uses msgnum when done does not identify the current step", async () => {
        const fixture = await createFixture({
            done: "",
            markerSessionId: "session-helper",
            msgnum: "1\n",
        });

        const result = runHelper("message", fixture.sessionDirectory, fixture.messagePath);

        expect(result.status).toBe(0);
        await expect(readFile(fixture.messagePath, "utf8")).resolves.toBe("replacement message");
    });

    it("fails closed for an unresolvable step with an unconsumed prepared message", async () => {
        const fixture = await createFixture({
            done: `reword ${HASH_C}\n`,
            markerSessionId: "session-helper",
            msgnum: "99\n",
        });

        const result = runHelper("message", fixture.sessionDirectory, fixture.messagePath);

        expect(result.status).toBe(1);
        expect(result.stderr).toContain("intelligit-rebase-editor: step-unresolved");
        await expect(readFile(fixture.messagePath, "utf8")).resolves.toBe("untouched message");
        expect(existsSync(path.join(fixture.consumptionDirectory, HASH_A))).toBe(false);
    });

    it.each([
        ["absent", undefined],
        ["mismatched", "another-session"],
    ])("fails closed when the ownership marker is %s", async (_name, markerSessionId) => {
        const fixture = await createFixture({ markerSessionId });

        const result = runHelper("message", fixture.sessionDirectory, fixture.messagePath);

        expect(result.status).toBe(1);
        expect(result.stderr).toContain("intelligit-rebase-editor: session-marker-mismatch");
        await expect(readFile(fixture.messagePath, "utf8")).resolves.toBe("untouched message");
        expect(existsSync(path.join(fixture.consumptionDirectory, HASH_A))).toBe(false);
    });

    it("does not write a resolved key that was already consumed", async () => {
        const fixture = await createFixture({ markerSessionId: "session-helper" });
        await writeFile(path.join(fixture.consumptionDirectory, HASH_A), "", "utf8");

        const result = runHelper("message", fixture.sessionDirectory, fixture.messagePath);

        expect(result.status).toBe(0);
        await expect(readFile(fixture.messagePath, "utf8")).resolves.toBe("untouched message");
    });

    it("matches an uppercase hash from Git against the lowercase session map", async () => {
        const fixture = await createFixture({
            done: `reword ${HASH_A.toUpperCase()}\n`,
            markerSessionId: "session-helper",
        });

        const result = runHelper("message", fixture.sessionDirectory, fixture.messagePath);

        expect(result.status).toBe(0);
        await expect(readFile(fixture.messagePath, "utf8")).resolves.toBe("replacement message");
    });
});

describe("Git editor command quoting", () => {
    itPosix.each([
        ["spaces", "a path with spaces"],
        ["backslashes", "a\\path\\with\\backslashes"],
        ["apostrophes", "a'quoted'path"],
        ["double quotes", 'a"quoted"path'],
        ["dollar", "a$variable"],
        ["backticks", "a`command`path"],
        ["newlines", "a\nmultiline\npath"],
        ["non-ASCII", "café/東京"],
    ])("round-trips %s through a real sh child", (_name, value) => {
        const command = `${quoteGitEditorArgument(process.execPath)} -e ${quoteGitEditorArgument(
            "process.stdout.write(process.argv[1])",
        )} ${quoteGitEditorArgument(value)}`;
        const result = spawnSync("sh", ["-c", command], { encoding: "buffer" });

        expect(result.status).toBe(0);
        expect(result.stdout).toEqual(Buffer.from(value.replace(/\\/g, "/")));
    });

    it("scopes Electron's Node mode to a quoted editor command", () => {
        const command = createGitEditorCommand(
            "C:\\editor helpers\\helper's.cjs",
            "message",
            "/session directory",
        );

        expect(command).toBe(
            "env ELECTRON_RUN_AS_NODE=1 '" +
                process.execPath.replace(/\\/g, "/").replace(/'/g, "'\\''") +
                "' 'C:/editor helpers/helper'\\''s.cjs' 'message' '/session directory'",
        );
    });
});
