// @vitest-environment jsdom

// Verifies the `commitChecksEnabled` flag on the `setBranches` config push gates
// the commit-check callbacks each graph app hands to CommitList. When the feature
// is disabled the app must withhold onRequestCommitChecks/onOpenCommitCheckUrl/
// onSignInForCommitChecks so CommitList (and therefore CommitRow) renders no badge
// button and never polls for checks. An absent flag is treated as enabled so older
// host payloads keep rendering badges.

import React, { act } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { flush } from "../../helpers/reactDomTestUtils";
import { installWebviewI18n } from "../../helpers/webviewI18nTestUtils";

interface MockVsCodeApi {
    postMessage: ReturnType<typeof vi.fn>;
    getState: ReturnType<typeof vi.fn>;
    setState: ReturnType<typeof vi.fn>;
}

// The last set of props CommitList was rendered with, captured by the mock below.
interface CapturedCommitListProps {
    onRequestCommitChecks?: unknown;
    onOpenCommitCheckUrl?: unknown;
    onSignInForCommitChecks?: unknown;
}

let lastCommitListProps: CapturedCommitListProps | null = null;

function installVsCodeMock(initialState: Record<string, unknown> = {}): MockVsCodeApi {
    const api: MockVsCodeApi = {
        postMessage: vi.fn(),
        getState: vi.fn(() => initialState),
        setState: vi.fn(),
    };
    Object.defineProperty(globalThis, "acquireVsCodeApi", {
        configurable: true,
        value: vi.fn(() => api),
    });
    installWebviewI18n();
    return api;
}

function createRootHost(): void {
    const root = document.createElement("div");
    root.id = "root";
    document.body.appendChild(root);
}

function mockCommitList(): void {
    vi.doMock("../../../src/webviews/react/CommitList", () => ({
        CommitList: (props: CapturedCommitListProps) => {
            lastCommitListProps = props;
            return <div data-testid="commit-list-stub">Graph</div>;
        },
    }));
}

// Branches payload shared by the setBranches dispatches; only commitChecksEnabled varies.
function setBranchesData(commitChecksEnabled: boolean | undefined): Record<string, unknown> {
    const data: Record<string, unknown> = {
        type: "setBranches",
        branches: [
            {
                name: "main",
                hash: "a1",
                isRemote: false,
                isCurrent: true,
                ahead: 0,
                behind: 0,
            },
        ],
    };
    if (commitChecksEnabled !== undefined) {
        data.commitChecksEnabled = commitChecksEnabled;
    }
    return data;
}

function dispatch(data: Record<string, unknown>): void {
    act(() => {
        window.dispatchEvent(new MessageEvent("message", { data }));
    });
}

beforeAll(() => {
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
        value: true,
        configurable: true,
    });
    Object.defineProperty(window, "matchMedia", {
        value: vi.fn().mockImplementation((query: string) => ({
            matches: false,
            media: query,
            onchange: null,
            addListener: vi.fn(),
            removeListener: vi.fn(),
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
            dispatchEvent: vi.fn(),
        })),
        configurable: true,
    });
    class ResizeObserverMock {
        observe = vi.fn();
        unobserve = vi.fn();
        disconnect = vi.fn();
    }
    Object.defineProperty(globalThis, "ResizeObserver", {
        value: ResizeObserverMock,
        configurable: true,
    });
});

beforeEach(() => {
    lastCommitListProps = null;
    vi.resetModules();
    document.body.replaceChildren();
});

afterEach(() => {
    vi.clearAllMocks();
    vi.doUnmock("../../../src/webviews/react/CommitList");
});

describe.each([
    {
        name: "NativeCommitGraph",
        load: async () => {
            const mod = await import("../../../src/webviews/react/NativeCommitGraph");
            return mod.NativeCommitGraph;
        },
    },
    {
        name: "CommitGraphPanel",
        load: async () => {
            const mod = await import("../../../src/webviews/react/CommitGraphPanel");
            return mod.CommitGraphPanel;
        },
    },
])("commitChecksEnabled gating: $name", ({ load }) => {
    async function mountApp(): Promise<void> {
        mockCommitList();
        installVsCodeMock();
        const { createRoot } = await import("react-dom/client");
        const Component = await load();
        const acquire = (globalThis as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi;
        const vscode = acquire();
        const host = document.getElementById("root") as HTMLElement;
        act(() => {
            createRoot(host).render(<Component vscode={vscode as never} sendReady={false} />);
        });
        await flush();
    }

    it("withholds the check callbacks when commitChecksEnabled is false", async () => {
        createRootHost();
        await mountApp();

        dispatch(setBranchesData(false));
        await flush();

        expect(lastCommitListProps?.onRequestCommitChecks).toBeUndefined();
        expect(lastCommitListProps?.onOpenCommitCheckUrl).toBeUndefined();
        expect(lastCommitListProps?.onSignInForCommitChecks).toBeUndefined();
    });

    it("passes the check callbacks when commitChecksEnabled is true", async () => {
        createRootHost();
        await mountApp();

        dispatch(setBranchesData(true));
        await flush();

        expect(lastCommitListProps?.onRequestCommitChecks).toBeTypeOf("function");
        expect(lastCommitListProps?.onOpenCommitCheckUrl).toBeTypeOf("function");
        expect(lastCommitListProps?.onSignInForCommitChecks).toBeTypeOf("function");
    });

    it("treats an absent commitChecksEnabled flag as enabled (backward compatible)", async () => {
        createRootHost();
        await mountApp();

        dispatch(setBranchesData(undefined));
        await flush();

        expect(lastCommitListProps?.onRequestCommitChecks).toBeTypeOf("function");
    });
});

// UndockedApp renders itself to #root on import, so it cannot take a vscode prop;
// it is exercised by importing the module after installing the mock + host.
describe("commitChecksEnabled gating: UndockedApp", () => {
    async function mountUndocked(): Promise<void> {
        mockCommitList();
        // UndockedApp also renders BranchColumn and CommitInfoPane; stub them so the
        // mount does not pull in unrelated canvas/icon machinery for this prop check.
        vi.doMock("../../../src/webviews/react/BranchColumn", () => ({
            BranchColumn: () => <div>Branches</div>,
        }));
        vi.doMock("../../../src/webviews/react/commit-info/CommitInfoPane", () => ({
            CommitInfoPane: () => <div>Info</div>,
        }));
        installVsCodeMock();
        await import("../../../src/webviews/react/UndockedApp");
        await flush();
    }

    afterEach(() => {
        vi.doUnmock("../../../src/webviews/react/BranchColumn");
        vi.doUnmock("../../../src/webviews/react/commit-info/CommitInfoPane");
    });

    it("withholds the check callbacks when commitChecksEnabled is false", async () => {
        createRootHost();
        await mountUndocked();

        dispatch(setBranchesData(false));
        await flush();

        expect(lastCommitListProps?.onRequestCommitChecks).toBeUndefined();
        expect(lastCommitListProps?.onOpenCommitCheckUrl).toBeUndefined();
        expect(lastCommitListProps?.onSignInForCommitChecks).toBeUndefined();
    });

    it("passes the check callbacks when commitChecksEnabled is true", async () => {
        createRootHost();
        await mountUndocked();

        dispatch(setBranchesData(true));
        await flush();

        expect(lastCommitListProps?.onRequestCommitChecks).toBeTypeOf("function");
        expect(lastCommitListProps?.onOpenCommitCheckUrl).toBeTypeOf("function");
        expect(lastCommitListProps?.onSignInForCommitChecks).toBeTypeOf("function");
    });

    it("treats an absent commitChecksEnabled flag as enabled (backward compatible)", async () => {
        createRootHost();
        await mountUndocked();

        dispatch(setBranchesData(undefined));
        await flush();

        expect(lastCommitListProps?.onRequestCommitChecks).toBeTypeOf("function");
    });
});
