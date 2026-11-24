// "Find where CI broke" in the Changed Files view (PLAN.md section 13): a repository switch ends
// the sidebar bisect on the host, whether or not the Checks tab is mounted, so switching back to
// the first repository cannot revive a run whose view was retired.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createCommitInfoVscodeDouble } from "../../visual/recorder/commitInfoVscodeDouble";

vi.mock("vscode", () => createCommitInfoVscodeDouble());

import type * as vscode from "vscode";
import { createFakeExtensionUri } from "../../visual/recorder/commitInfoVscodeDouble";
import { setE2eControlChannelActive } from "../../../src/e2e/activationState";
import type { CiBisectSource } from "../../../src/services/commitChecks/ciBisect";
import { CiGenerations } from "../../../src/services/commitChecks/ciGenerations";
import { CommitInfoViewProvider } from "../../../src/views/CommitInfoViewProvider";

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const [A, B] = ["a", "b"].map((letter) => letter.repeat(40));
const RANGE = [
    { hash: A, parents: [B] },
    { hash: B, parents: [] },
];

async function pane(open = true) {
    let repo = "/A";
    const posted: Array<Record<string, unknown>> = [];
    let receive!: (message: unknown) => Promise<void>;
    const queued: Array<{ guard: () => boolean; release: () => void }> = [];
    const source: CiBisectSource = {
        capabilities: async () => undefined,
        attemptHistory: async () => [],
        getChecks: async (hash, options) => {
            // Held as a request queued behind the gate would be.
            await new Promise<void>((release) =>
                queued.push({ guard: options.sendGuard, release }),
            );
            return { hash, state: "none", items: [], summary: "" };
        },
    };
    const provider = new CommitInfoViewProvider(createFakeExtensionUri());
    provider.setCiSource({
        enabled: true,
        repoKey: () => repo,
        getDetail: vi.fn(),
        generations: new CiGenerations(),
        bisect: { source, loaded: () => RANGE },
    } as never);
    const resolve = async (): Promise<void> => {
        provider.resolveWebviewView(
            {
                webview: {
                    options: {},
                    html: "",
                    cspSource: "vscode-webview://fake",
                    asWebviewUri: (uri: vscode.Uri) => uri,
                    onDidReceiveMessage: (listener: typeof receive) => {
                        receive = listener;
                        return { dispose(): void {} };
                    },
                    postMessage: async (message: Record<string, unknown>) => {
                        posted.push(message);
                        return true;
                    },
                },
                onDidDispose: () => ({ dispose(): void {} }),
            } as unknown as vscode.WebviewView,
            {} as never,
            {} as never,
        );
        await receive({ type: "ready" });
    };
    if (open) await resolve();
    return {
        provider,
        resolve,
        posted,
        queued,
        start: (requestId: number) =>
            receive({ type: "startCiBisect", requestId, repoKey: repo, commits: RANGE }),
        // What repositoryMode.ts does on a switch: the root moves, then every pane is cleared.
        switchTo: (key: string) => {
            repo = key;
            provider.clear();
        },
        release: () => queued.splice(0).forEach((item) => item.release()),
        bisectPosts: () => posted.filter(({ type }) => String(type).startsWith("ciBisect")),
    };
}

beforeEach(() => setE2eControlChannelActive(true));
afterEach(() => setE2eControlChannelActive(false));

describe("CommitInfoViewProvider repository switch", () => {
    it("retires a queued sidebar bisect across A to B to A without the Checks tab", async () => {
        const p = await pane();
        const running = p.start(1);
        await flush();
        expect(p.queued, "both reads are queued").toHaveLength(2);

        p.switchTo("/B");
        p.switchTo("/A");
        const refused = p.queued.map(({ guard }) => guard());
        p.release();
        await running;

        expect(refused, "queued reads of the retired A run stay refused back in A").toEqual([
            false,
            false,
        ]);
        expect(p.bisectPosts(), "the retired A run posts nothing to A").toEqual([]);
    });

    it("a clear within the same repository keeps the bisect running", async () => {
        const p = await pane();
        const running = p.start(1);
        await flush();
        // A branch filter clears the pane while staying in A.
        p.provider.clear({ loading: true });
        expect(p.queued.map(({ guard }) => guard())).toEqual([true, true]);
        p.release();
        await running;
        expect(p.bisectPosts().at(-1)).toMatchObject({ type: "ciBisectResult", requestId: 1 });
    });

    it("drops a range held for A when the host switches to B before the view is ready", async () => {
        const p = await pane(false);
        p.provider.startCiBisect(RANGE);
        p.switchTo("/B");
        await p.resolve();
        expect(
            p.posted.filter(({ type }) => type === "startCiBisectInChecks"),
            "A's held range must not reach B's Checks tab",
        ).toEqual([]);
    });

    it("tells the webview which repository a cleared pane belongs to", async () => {
        const p = await pane();
        p.switchTo("/B");
        expect(p.posted.at(-1)).toEqual({ type: "clear", ciRepoKey: "/B" });
    });
});
