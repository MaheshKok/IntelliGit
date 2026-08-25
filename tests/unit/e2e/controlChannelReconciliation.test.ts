import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const watcherMock = vi.hoisted(() => ({ close: vi.fn() }));

vi.mock("node:fs", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:fs")>();
    return {
        ...actual,
        watch: vi.fn(() => ({ close: watcherMock.close })),
    };
});

import { removeRequestFile, watchChannelDir } from "../../../src/e2e/transportFs";
import { removeScratchDirectoriesSync } from "../../helpers/scratchDirectories";

describe("watchChannelDir reconciliation", () => {
    let channelDir: string;

    beforeEach(() => {
        channelDir = mkdtempSync(join(tmpdir(), "intelligit-e2e-reconciliation-test-"));
        watcherMock.close.mockClear();
    });

    afterEach(() => {
        removeScratchDirectoriesSync(channelDir);
    });

    it("answers a later request after an earlier request when fs.watch sends no notification", async () => {
        const received: string[] = [];
        const watcher = watchChannelDir(channelDir, (nonce) => {
            received.push(nonce);
            removeRequestFile(channelDir, nonce);
        });

        try {
            writeFileSync(join(channelDir, "first.request.json"), '{"served":1}', "utf8");
            await vi.waitFor(() => expect(received).toEqual(["first"]), {
                timeout: 1_000,
                interval: 10,
            });

            writeFileSync(join(channelDir, "second.request.json"), '{"served":2}', "utf8");
            await vi.waitFor(() => expect(received).toEqual(["first", "second"]), {
                timeout: 1_000,
                interval: 10,
            });
        } finally {
            watcher.dispose();
        }
    });
});
