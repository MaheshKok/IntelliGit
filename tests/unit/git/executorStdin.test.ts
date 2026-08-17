import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GitExecutor } from "../../../src/git/executor";

const spawnMock = vi.fn();

// A real `git` can be made to break its stdin pipe -- exit without reading, and the write
// fails with EPIPE, which the sibling suite does against an actual process. It cannot be made
// to fail with a full disk or a revoked descriptor on demand, and those are the cases that
// matter here: Git keeps running on a TRUNCATED input and can still exit 0. So this file
// replaces the process rather than the Git binary.
vi.mock("node:child_process", () => ({
    spawn: (...args: unknown[]): unknown => spawnMock(...args),
}));

interface FakeChild extends EventEmitter {
    stdout: PassThrough;
    stderr: PassThrough;
    stdin: Writable;
    kill: () => boolean;
}

/** A child whose stdin fails the way `failure` describes, or succeeds when it is undefined. */
function fakeChild(failure?: NodeJS.ErrnoException): FakeChild {
    const child = new EventEmitter() as FakeChild;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new Writable({
        write: (_chunk, _encoding, callback) => callback(failure),
        final: (callback) => callback(failure),
    });
    child.kill = () => true;
    return child;
}

/** Reports the exit `code` once the executor has had a turn to see any stdin failure. */
function exitWith(child: FakeChild, code: number): void {
    setImmediate(() => {
        child.stdout.end();
        child.stderr.end();
        child.emit("close", code, null);
    });
}

function streamError(code: string, message: string): NodeJS.ErrnoException {
    return Object.assign(new Error(message), { code });
}

describe("GitExecutor stdin stream failures", () => {
    beforeEach(() => {
        spawnMock.mockReset();
    });

    it("reports a stdin failure that is not the child exiting, even when Git exits 0", async () => {
        const child = fakeChild(streamError("ENOSPC", "no space left on device"));
        spawnMock.mockReturnValue(child);

        const result = new GitExecutor(process.cwd()).runBinary(["hash-object", "--stdin"], {
            input: Buffer.from("content the caller believes was hashed"),
        });
        // Exit 0 is in the default `expectedExitCodes`, so nothing downstream would question
        // this result. Git hashed whatever prefix reached it and returned a confident answer
        // for bytes that were never delivered -- a wrong hash reported as a correct one.
        exitWith(child, 0);

        await expect(result).rejects.toThrow(/no space left on device/);
    });

    it.each([
        ["EPIPE", "write EPIPE"],
        ["ERR_STREAM_DESTROYED", "cannot call write after a stream was destroyed"],
    ])("settles from the child's exit when stdin fails with %s", async (code, message) => {
        const child = fakeChild(streamError(code, message));
        spawnMock.mockReturnValue(child);

        const result = new GitExecutor(process.cwd()).runBinary(["hash-object", "--stdin"], {
            input: Buffer.from("input the child never read"),
        });
        exitWith(child, 0);

        // The counterweight to the case above: these two ARE the child having exited before
        // draining, they carry nothing the exit code does not already say, and turning them
        // into failures would break every command whose child stops reading early.
        await expect(result).resolves.toMatchObject({ exitCode: 0 });
    });

    it("still reports the child's own failure when stdin closed cleanly", async () => {
        const child = fakeChild();
        spawnMock.mockReturnValue(child);

        const result = new GitExecutor(process.cwd()).runBinary(["hash-object", "--stdin"], {
            input: Buffer.from("delivered in full"),
        });
        child.stderr.write("fatal: not a valid object name");
        exitWith(child, 128);

        await expect(result).rejects.toThrow(/exited with 128: fatal: not a valid object name/);
    });
});
