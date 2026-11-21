import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setE2eControlChannelActive } from "../../../src/e2e/activationState";
import type { CiAnnotationsAccess } from "../../../src/services/commitChecks/ciDiagnostics";
import { answerOpenCiAnnotation } from "../../../src/views/ciAnnotationHandler";
import type { CommitCiDetailSource } from "../../../src/views/ciDetailHandler";

vi.mock("vscode", () => ({}));

const HASH = "a".repeat(40);

function source(): { source: CommitCiDetailSource; open: ReturnType<typeof vi.fn> } {
    const open = vi.fn(async () => undefined);
    const annotations: CiAnnotationsAccess = {
        viewFor: () => undefined,
        onDidChange: () => ({ dispose: () => undefined }),
        open,
    };
    return {
        source: { repoKey: () => "/repo", getDetail: vi.fn(), annotations },
        open,
    };
}

function request(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        type: "openCiAnnotation",
        requestId: 1,
        repoKey: "/repo",
        hash: HASH,
        path: "src/a.ts",
        line: 2,
        ...extra,
    };
}

describe("answerOpenCiAnnotation", () => {
    beforeEach(() => setE2eControlChannelActive(true));
    afterEach(() => setE2eControlChannelActive(false));

    it("opens the annotation through the host's placed list", async () => {
        const s = source();
        await answerOpenCiAnnotation(s.source, request());
        expect(s.open).toHaveBeenCalledWith("/repo", HASH, "src/a.ts", 2);
    });

    it("answers nothing while the switch is off", async () => {
        const s = source();
        setE2eControlChannelActive(false);
        await answerOpenCiAnnotation(s.source, request());
        expect(s.open).not.toHaveBeenCalled();
    });

    it("opens nothing for another repository", async () => {
        const s = source();
        await answerOpenCiAnnotation(s.source, request({ repoKey: "/other" }));
        expect(s.open).not.toHaveBeenCalled();
    });

    it.each([
        ["request id", { requestId: "1" }],
        ["repository", { repoKey: 3 }],
        ["hash", { hash: "nothex" }],
        ["path", { path: "" }],
        ["line zero", { line: 0 }],
        ["fractional line", { line: 1.5 }],
    ])("rejects a malformed %s", async (_name, extra) => {
        const s = source();
        await expect(answerOpenCiAnnotation(s.source, request(extra))).rejects.toThrow();
        expect(s.open).not.toHaveBeenCalled();
    });
});
