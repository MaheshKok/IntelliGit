// @vitest-environment jsdom

import React, { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkingFile } from "../../../src/types";

Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    value: true,
    configurable: true,
});

type CommitFileCheckMode = "allChecked" | "noneChecked" | "preserveSelection";

interface CheckedFilesSnapshot {
    checkedPaths: Set<string>;
    toggleFile: (path: string) => void;
}

let webviewState: Record<string, unknown>;
let setState: ReturnType<typeof vi.fn>;

function workingFile(path: string, status: WorkingFile["status"] = "M"): WorkingFile {
    return { path, status, staged: false, additions: 1, deletions: 0 };
}

async function flush(): Promise<void> {
    await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
    });
}

async function createHarness(mode: CommitFileCheckMode): Promise<{
    render: (
        files: WorkingFile[],
        repositoryRoot?: string,
        filesHydrated?: boolean,
    ) => Promise<void>;
    current: () => CheckedFilesSnapshot;
    unmount: () => void;
}> {
    vi.doMock("../../../src/webviews/react/commit-panel/hooks/useVsCodeApi", () => ({
        getVsCodeApi: () => ({
            postMessage: vi.fn(),
            getState: () => webviewState,
            setState: (next: Record<string, unknown>) => {
                webviewState = next;
                setState(next);
            },
        }),
    }));
    vi.doMock("../../../src/webviews/react/shared/settings", () => ({
        getSettings: () => ({ commitCheckState: mode }),
    }));

    const { createRoot } = await import("react-dom/client");
    const { useCheckedFiles } =
        await import("../../../src/webviews/react/commit-panel/hooks/useCheckedFiles");
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    let latest: CheckedFilesSnapshot | undefined;

    function Harness({
        files,
        repositoryRoot,
        filesHydrated = true,
    }: {
        files: WorkingFile[];
        repositoryRoot?: string;
        filesHydrated?: boolean;
    }): null {
        latest = useCheckedFiles(files, repositoryRoot, filesHydrated);
        return null;
    }

    return {
        render: async (files, repositoryRoot, filesHydrated = true) => {
            await act(async () => {
                root.render(
                    <Harness
                        files={files}
                        repositoryRoot={repositoryRoot}
                        filesHydrated={filesHydrated}
                    />,
                );
            });
            await flush();
        },
        current: () => {
            if (!latest) throw new Error("Hook did not render");
            return latest;
        },
        unmount: () => {
            act(() => root.unmount());
            host.remove();
        },
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    webviewState = {};
    setState = vi.fn();
});

afterEach(() => {
    document.body.innerHTML = "";
});

describe("useCheckedFiles commit check modes", () => {
    it("noneChecked ignores stored selections and leaves initial and new paths unchecked", async () => {
        webviewState = {
            unrelated: "keep",
            checkedByRepository: { "/repo-a": ["src/a.ts"], "/repo-b": ["src/b.ts"] },
        };
        const harness = await createHarness("noneChecked");

        try {
            await harness.render([], "/repo-a", false);
            expect(Array.from(harness.current().checkedPaths)).toEqual([]);
            expect(setState).not.toHaveBeenCalled();

            await harness.render([workingFile("src/a.ts")], "/repo-a", true);
            expect(Array.from(harness.current().checkedPaths)).toEqual([]);
            expect(webviewState).toEqual({
                unrelated: "keep",
                checkedByRepository: { "/repo-a": [], "/repo-b": ["src/b.ts"] },
            });

            act(() => harness.current().toggleFile("src/a.ts"));
            await flush();
            expect(Array.from(harness.current().checkedPaths)).toEqual(["src/a.ts"]);

            await harness.render(
                [workingFile("src/a.ts"), workingFile("src/new.ts")],
                "/repo-a",
                true,
            );
            expect(Array.from(harness.current().checkedPaths)).toEqual(["src/a.ts"]);
        } finally {
            harness.unmount();
        }
    });

    it("allChecked checks authoritative initial and new paths but preserves explicit unchecks", async () => {
        const harness = await createHarness("allChecked");

        try {
            await harness.render([], "/repo-a", false);
            expect(Array.from(harness.current().checkedPaths)).toEqual([]);

            await harness.render(
                [workingFile("src/a.ts"), workingFile("ignored.log", "!")],
                "/repo-a",
                true,
            );
            expect(Array.from(harness.current().checkedPaths)).toEqual(["src/a.ts"]);

            act(() => harness.current().toggleFile("src/a.ts"));
            await flush();
            expect(Array.from(harness.current().checkedPaths)).toEqual([]);

            await harness.render(
                [workingFile("src/a.ts"), workingFile("src/new.ts")],
                "/repo-a",
                true,
            );
            expect(Array.from(harness.current().checkedPaths)).toEqual(["src/new.ts"]);
        } finally {
            harness.unmount();
        }
    });

    it("preserveSelection restores scoped paths while treating reappearing paths as new", async () => {
        webviewState = {
            unrelated: 42,
            checked: ["src/legacy.ts"],
            checkedByRepository: { "/repo-a": ["src/a.ts"] },
        };
        const harness = await createHarness("preserveSelection");

        try {
            await harness.render([], "/repo-a", false);
            expect(setState).not.toHaveBeenCalled();

            await harness.render(
                [workingFile("src/a.ts"), workingFile("src/new.ts")],
                "/repo-a",
                true,
            );
            expect(Array.from(harness.current().checkedPaths)).toEqual(["src/a.ts"]);

            await harness.render([], "/repo-a", true);
            expect(Array.from(harness.current().checkedPaths)).toEqual([]);
            expect(webviewState).toMatchObject({
                unrelated: 42,
                checked: ["src/legacy.ts"],
                checkedByRepository: { "/repo-a": [] },
            });

            await harness.render([workingFile("src/a.ts")], "/repo-a", true);
            expect(Array.from(harness.current().checkedPaths)).toEqual([]);
        } finally {
            harness.unmount();
        }
    });

    it("isolates equal relative paths when the selected repository changes", async () => {
        webviewState = {
            checked: ["src/shared.ts"],
            checkedByRepository: {
                "/repo-a": ["src/shared.ts"],
                "/repo-b": ["src/b-only.ts"],
            },
        };
        const harness = await createHarness("preserveSelection");

        try {
            await harness.render([workingFile("src/shared.ts")], "/repo-a", true);
            expect(Array.from(harness.current().checkedPaths)).toEqual(["src/shared.ts"]);

            await harness.render([], "/repo-b", false);
            expect(Array.from(harness.current().checkedPaths)).toEqual([]);

            await harness.render(
                [workingFile("src/shared.ts"), workingFile("src/b-only.ts")],
                "/repo-b",
                true,
            );
            expect(Array.from(harness.current().checkedPaths)).toEqual(["src/b-only.ts"]);
            expect(webviewState).toMatchObject({
                checkedByRepository: {
                    "/repo-a": ["src/shared.ts"],
                    "/repo-b": ["src/b-only.ts"],
                },
            });
        } finally {
            harness.unmount();
        }
    });

    it.each([
        ["allChecked", true],
        ["noneChecked", false],
    ] as const)(
        "%s reapplies its initial policy after switching away from and back to a repository",
        async (mode, checkedAfterSwitch) => {
            const harness = await createHarness(mode);

            try {
                await harness.render([workingFile("src/shared.ts")], "/repo-a", true);
                act(() => harness.current().toggleFile("src/shared.ts"));
                await flush();

                await harness.render([], "/repo-b", false);
                await harness.render([workingFile("src/shared.ts")], "/repo-b", true);
                expect(harness.current().checkedPaths.has("src/shared.ts")).toBe(
                    checkedAfterSwitch,
                );

                await harness.render([], "/repo-a", false);
                await harness.render([workingFile("src/shared.ts")], "/repo-a", true);
                expect(harness.current().checkedPaths.has("src/shared.ts")).toBe(
                    checkedAfterSwitch,
                );
            } finally {
                harness.unmount();
            }
        },
    );

    it("does not expose or persist selections before a repository root is known", async () => {
        webviewState = { checked: ["src/shared.ts"], unrelated: true };
        const harness = await createHarness("preserveSelection");

        try {
            await harness.render([workingFile("src/shared.ts")], undefined, true);
            expect(Array.from(harness.current().checkedPaths)).toEqual([]);
            expect(setState).not.toHaveBeenCalled();
            expect(webviewState).toEqual({ checked: ["src/shared.ts"], unrelated: true });
        } finally {
            harness.unmount();
        }
    });
});
