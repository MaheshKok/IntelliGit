// Isolated proof of the E2E control channel transport's partial-write-safety *mechanism*:
// "the extension writes <nonce>.response.json by temp-file-plus-rename so a reader never
// sees a partial write" (PLAN.md Phase 1 step 10). POSIX and NTFS both guarantee that a
// same-directory rename is atomic, which is what actually delivers the "never partial"
// property -- a Node unit test cannot independently re-verify an OS guarantee, so this test
// instead proves the code takes the only path that guarantee covers: a full write to a
// differently-named temp file, followed by exactly one rename into the final path.
//
// This lives in its own file (rather than alongside transportFs.test.ts's real-filesystem
// tests) because intercepting node:fs must happen via a module-scope `vi.mock`, hoisted
// above every import -- including transportFs.ts's own `import ... from "node:fs"` -- so
// that its destructured references bind to the mocked functions rather than the originals.
// Mixing that with other tests in the same file that need the real filesystem risks the two
// interfering with each other.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ calls: [] as string[] }));

vi.mock("node:fs", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:fs")>();
    return {
        ...actual,
        writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
            mocks.calls.push(`write:${String(args[0])}`);
            return actual.writeFileSync(...args);
        },
        renameSync: (...args: Parameters<typeof actual.renameSync>) => {
            mocks.calls.push(`rename:${String(args[0])}->${String(args[1])}`);
            return actual.renameSync(...args);
        },
    };
});

import { writeResponseFileAtomic } from "../../../src/e2e/transportFs";

describe("writeResponseFileAtomic: temp-file-plus-rename mechanism", () => {
    let channelDir: string;

    beforeEach(() => {
        mocks.calls.length = 0;
        channelDir = mkdtempSync(join(tmpdir(), "intelligit-e2e-transport-atomic-test-"));
    });

    afterEach(() => {
        rmSync(channelDir, { recursive: true, force: true });
    });

    it("writes the full payload to a temp file, then moves it into place with exactly one rename", () => {
        writeResponseFileAtomic(channelDir, "abc123", {
            nonce: "abc123",
            ok: true,
            big: "x".repeat(500),
        });

        expect(mocks.calls).toHaveLength(2);
        expect(mocks.calls[0]).toMatch(/^write:/);
        expect(mocks.calls[1]).toMatch(/^rename:/);
    });

    it("never writes directly to the final response path -- only the rename call ever touches it", () => {
        writeResponseFileAtomic(channelDir, "abc123", { nonce: "abc123", ok: true });

        const finalPath = join(channelDir, "abc123.response.json");
        const writeCall = mocks.calls[0] ?? "";
        const renameCall = mocks.calls[1] ?? "";

        expect(writeCall).not.toContain(finalPath);
        expect(renameCall).toContain(`->${finalPath}`);
    });

    it("uses a temp path in the same directory as the final path (same-directory rename is what makes it atomic)", () => {
        writeResponseFileAtomic(channelDir, "abc123", { nonce: "abc123", ok: true });

        const writeCall = mocks.calls[0] ?? "";
        const tempPath = writeCall.slice("write:".length);
        expect(tempPath.startsWith(channelDir)).toBe(true);
    });
});
