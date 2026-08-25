import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { supportsUnreadableDirectories } from "../../../helpers/platformCapabilities";
import { REBASE_SESSION_MARKER } from "../../../../src/git/interactiveRebase/editorCommand";
import {
    deriveRebaseControl,
    type LiveRebaseManifest,
} from "../../../../src/git/interactiveRebase/rebaseControl";
import { removeScratchDirectories } from "../../../helpers/scratchDirectories";

const directories: string[] = [];
const canAssertUnreadableDirectory = supportsUnreadableDirectories;

afterEach(async () => {
    await Promise.all(
        directories.splice(0).map(async (directory) => {
            await chmod(directory, 0o700).catch(() => undefined);
            await removeScratchDirectories(directory);
        }),
    );
});

/** Creates an isolated Git directory for direct operation-state fixtures. */
async function gitDirectory(): Promise<string> {
    const root = await mkdtemp(path.join(tmpdir(), "intelligit-rebase-control-"));
    directories.push(root);
    return root;
}

/** Builds the only manifest shape this pure ownership derivation needs. */
function liveManifest(sessionId: string = "session-one"): LiveRebaseManifest {
    return { sessionId, lifecycle: "paused" };
}

/** Creates the sequence-rebase directory, optionally identifying an IntelliGit session. */
async function rebaseMerge(gitDir: string, marker?: string): Promise<void> {
    const directory = path.join(gitDir, "rebase-merge");
    await mkdir(directory);
    if (marker !== undefined) await writeFile(path.join(directory, REBASE_SESSION_MARKER), marker);
}

describe("deriveRebaseControl", () => {
    it("returns none when no live rebase directory exists", async () => {
        await expect(deriveRebaseControl({ gitDir: await gitDirectory() })).resolves.toBe("none");
    });

    it("returns owned only for a matching live manifest marker", async () => {
        const gitDir = await gitDirectory();
        await rebaseMerge(gitDir, "session-one\n");

        await expect(deriveRebaseControl({ gitDir, liveManifest: liveManifest() })).resolves.toBe(
            "owned",
        );
    });

    it("returns unowned when a rebase has no live manifest", async () => {
        const gitDir = await gitDirectory();
        await rebaseMerge(gitDir);

        await expect(deriveRebaseControl({ gitDir })).resolves.toBe("unowned");
    });

    it.each([
        ["missing marker", undefined],
        ["mismatched marker", "session-two\n"],
        ["empty marker", ""],
    ])("returns foreign for a %s with a live manifest", async (_name, marker) => {
        const gitDir = await gitDirectory();
        await rebaseMerge(gitDir, marker);

        await expect(deriveRebaseControl({ gitDir, liveManifest: liveManifest() })).resolves.toBe(
            "foreign",
        );
    });

    it("returns foreign for an oversized marker", async () => {
        const gitDir = await gitDirectory();
        await rebaseMerge(gitDir, "x".repeat(8_192));

        await expect(deriveRebaseControl({ gitDir, liveManifest: liveManifest() })).resolves.toBe(
            "foreign",
        );
    });

    it("refuses to authorize an oversized marker that opens with the session id", async () => {
        // Truncating at the ceiling and comparing what fits would authorize this file, because
        // trimming its padding leaves exactly the session id. The read must reject on length
        // before any comparison happens.
        const gitDir = await gitDirectory();
        await rebaseMerge(gitDir, `session-one${" ".repeat(8_192)}`);

        await expect(deriveRebaseControl({ gitDir, liveManifest: liveManifest() })).resolves.toBe(
            "foreign",
        );
    });

    it("treats a rebase-apply directory as foreign even with a live manifest", async () => {
        const gitDir = await gitDirectory();
        await mkdir(path.join(gitDir, "rebase-apply"));

        await expect(deriveRebaseControl({ gitDir, liveManifest: liveManifest() })).resolves.toBe(
            "foreign",
        );
    });

    it("treats a rebase-apply directory as foreign even beside our own matching marker", async () => {
        // Our sequence helper only ever writes into rebase-merge, so a second backend's state
        // sitting alongside it means the live rebase is not the one this session started.
        const gitDir = await gitDirectory();
        await rebaseMerge(gitDir, "session-one\n");
        await mkdir(path.join(gitDir, "rebase-apply"));

        await expect(deriveRebaseControl({ gitDir, liveManifest: liveManifest() })).resolves.toBe(
            "foreign",
        );
    });

    it.skipIf(!canAssertUnreadableDirectory)(
        "fails closed when the live rebase directory is unreadable",
        async () => {
            const gitDir = await gitDirectory();
            await rebaseMerge(gitDir, "session-one\n");
            await chmod(gitDir, 0o000);

            await expect(
                deriveRebaseControl({ gitDir, liveManifest: liveManifest() }),
            ).resolves.toBe("foreign");
            await chmod(gitDir, 0o700);
        },
    );
});
