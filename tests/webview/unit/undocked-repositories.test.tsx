// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ChakraProvider } from "@chakra-ui/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { installWebviewI18n } from "../../helpers/webviewI18nTestUtils";

let reactRoot: Root | undefined;
let postMessage: ReturnType<typeof vi.fn>;

function setupRoot(): HTMLElement {
    document.body.innerHTML = "";
    const root = document.createElement("div");
    root.id = "root";
    document.body.appendChild(root);
    return root;
}

async function render(element: React.ReactElement): Promise<void> {
    const rootElement = document.getElementById("root");
    if (!rootElement) throw new Error("Missing root");
    await act(async () => {
        reactRoot = createRoot(rootElement);
        reactRoot.render(element);
        await Promise.resolve();
    });
}

function click(element: Element | null): void {
    if (!element) throw new Error("Missing clickable element");
    act(() => {
        element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
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
});

beforeEach(() => {
    reactRoot = undefined;
    vi.clearAllMocks();
    vi.resetModules();
    postMessage = vi.fn();
    setupRoot();
});

afterEach(() => {
    if (!reactRoot) return;
    act(() => {
        reactRoot?.unmount();
    });
    reactRoot = undefined;
});

describe("undocked repository selector", () => {
    it("renders known repositories and emits the selected root", async () => {
        const onSelectRepository = vi.fn();
        const { RepositoryColumn } = await import(
            "../../../src/webviews/react/undocked/RepositoryColumn"
        );

        await render(
            <ChakraProvider>
                <RepositoryColumn
                    width={168}
                    repositories={[
                        { root: "/repo-a", label: "Repo A" },
                        { root: "/repo-b", label: "Repo B" },
                    ]}
                    selectedRepositoryRoot="/repo-a"
                    onSelectRepository={onSelectRepository}
                />
            </ChakraProvider>,
        );

        const rows = document.querySelectorAll('[data-testid="undocked-repository-row"]');
        expect(rows).toHaveLength(2);
        expect(rows[0]?.textContent).toContain("Repo A");
        expect(rows[0]?.getAttribute("aria-current")).toBe("true");

        click(document.querySelector('[data-repository-root="/repo-b"]'));

        expect(onSelectRepository).toHaveBeenCalledWith("/repo-b");
    });

    it("posts selectRepository and clears selected-repository webview state", async () => {
        vi.doMock("../../../src/webviews/react/shared/vscodeApi", () => ({
            getVsCodeApi: () => ({
                postMessage,
            }),
        }));
        const { useUndockedActions } = await import(
            "../../../src/webviews/react/undocked/useUndockedActions"
        );
        const graphDispatch = vi.fn();
        const cpDispatch = vi.fn();
        const loadingMore = { current: true };

        function Harness(): React.ReactElement {
            const actions = useUndockedActions({
                graphDispatch,
                cpDispatch,
                loadingMore,
                commitChecks: new Map(),
                commitMessage: "",
                isAmend: false,
                checkedPaths: new Set(),
                shouldPublishBranch: false,
            });
            return (
                <button
                    id="select-repository"
                    type="button"
                    onClick={() => actions.handleSelectRepository("/repo-b")}
                />
            );
        }

        await render(<Harness />);
        click(document.getElementById("select-repository"));

        expect(loadingMore.current).toBe(false);
        expect(graphDispatch).toHaveBeenCalledWith({ type: "resetRepository" });
        expect(cpDispatch).toHaveBeenCalledWith({ type: "RESET_REPOSITORY" });
        expect(postMessage).toHaveBeenCalledWith({
            type: "selectRepository",
            repositoryRoot: "/repo-b",
        });
    });

    it("renders a Dock action in the existing transport row only when requested", async () => {
        installWebviewI18n();
        const onDock = vi.fn();
        const { TabBar } = await import(
            "../../../src/webviews/react/commit-panel/components/TabBar"
        );

        await render(
            <ChakraProvider>
                <TabBar
                    stashCount={0}
                    onSync={vi.fn()}
                    onFetch={vi.fn()}
                    onPull={vi.fn()}
                    onPush={vi.fn()}
                    onDock={onDock}
                    commitContent={<div>Commit content</div>}
                    stashContent={<div>Stash content</div>}
                />
            </ChakraProvider>,
        );

        const tabRow = document.querySelector('[data-testid="commit-panel-tab-row"]');
        const labels = Array.from(tabRow?.querySelectorAll("button") ?? []).map(
            (button) => button.getAttribute("aria-label"),
        );

        const dockButton = Array.from(tabRow?.querySelectorAll("button") ?? []).find(
            (button) => button.getAttribute("aria-label") === "Dock IntelliGit",
        );
        expect(labels.filter((label) => label === "Dock IntelliGit")).toHaveLength(1);
        expect(labels.indexOf("Dock IntelliGit")).toBeGreaterThan(labels.indexOf("Push"));
        expect(dockButton?.getAttribute("title")).toBe("Dock IntelliGit");
        click(dockButton ?? null);
        expect(onDock).toHaveBeenCalledTimes(1);
    });

    it("omits Dock from the normal docked TabBar", async () => {
        installWebviewI18n();
        const { TabBar } = await import(
            "../../../src/webviews/react/commit-panel/components/TabBar"
        );

        await render(
            <ChakraProvider>
                <TabBar
                    stashCount={0}
                    onSync={vi.fn()}
                    onFetch={vi.fn()}
                    onPull={vi.fn()}
                    onPush={vi.fn()}
                    commitContent={<div>Commit content</div>}
                    stashContent={<div>Stash content</div>}
                />
            </ChakraProvider>,
        );

        expect(document.querySelector('[aria-label="Dock IntelliGit"]')).toBeNull();
    });
});
