import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildRebaseTodo } from "../../../../src/git/interactiveRebase/todo";
import type {
    RebaseSessionPaths,
    RebaseTodoEntry,
} from "../../../../src/git/interactiveRebase/types";
import { writeInteractiveRebaseSession } from "../../../../src/git/interactiveRebase/session";
import { removeScratchDirectories } from "../../../helpers/scratchDirectories";

const HASH_A = "a".repeat(40);
const HASH_B = "B".repeat(40);
const directories: string[] = [];

afterEach(async () => {
    await Promise.all(
        directories.splice(0).map((directory) => removeScratchDirectories(directory)),
    );
});

describe("writeInteractiveRebaseSession", () => {
    it("writes the generated todo and only complete reword and squash messages keyed by lowercase hash", async () => {
        const directory = await mkdtemp(path.join(os.tmpdir(), "intelligit-rebase-session-"));
        directories.push(directory);
        const paths: RebaseSessionPaths = {
            directory,
            todoPath: path.join(directory, "todo"),
            messageMapPath: path.join(directory, "messages.json"),
            consumptionDirectory: path.join(directory, "consumed"),
        };
        const entries: readonly RebaseTodoEntry[] = [
            { hash: HASH_A, action: "pick", message: "keep out" },
            {
                hash: HASH_B,
                action: "reword",
                message: "subject\n\nfirst body line\nsecond body line\n",
            },
            { hash: "c".repeat(40), action: "squash", message: "squash subject\n\nfull body" },
            { hash: "f".repeat(40), action: "reword" },
            { hash: "d".repeat(40), action: "fixup", message: "keep out" },
            { hash: "e".repeat(40), action: "drop", message: "keep out" },
        ];

        await writeInteractiveRebaseSession(paths, entries);

        await expect(readFile(paths.todoPath, "utf8")).resolves.toBe(buildRebaseTodo(entries));
        expect(JSON.parse(await readFile(paths.messageMapPath, "utf8"))).toEqual({
            [HASH_B.toLowerCase()]: {
                action: "reword",
                message: "subject\n\nfirst body line\nsecond body line\n",
            },
            ["c".repeat(40)]: { action: "squash", message: "squash subject\n\nfull body" },
        });
    });
});
