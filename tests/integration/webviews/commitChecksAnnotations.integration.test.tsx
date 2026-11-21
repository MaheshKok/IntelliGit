// @vitest-environment jsdom
// The Checks tab's "Annotations" section (PLAN.md section 11, Phase 14): HEAD's CI failure notes
// the host placed in the Problems panel, each opening its file at its line, with the count it
// could not place, the page-bound note, and why they could not be read.

import React, { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NO_CI_CAPABILITIES } from "../../../src/shared/ci/capabilities";
import type { CiAnnotationsView, CommitCiDetail, CommitDetail } from "../../../src/types";
import { CommitInfoPane } from "../../../src/webviews/react/commit-info/CommitInfoPane";
import { initReactDomTestEnvironment, mount } from "../../helpers/reactDomTestUtils";
import { installWebviewI18n } from "../../helpers/webviewI18nTestUtils";

const mockVscodeApi = vi.hoisted(() => ({
    postMessage: vi.fn(),
    getState: vi.fn((): unknown => undefined),
    setState: vi.fn(),
}));

vi.mock("../../../src/webviews/react/shared/vscodeApi", () => ({
    getVsCodeApi: () => mockVscodeApi,
}));

initReactDomTestEnvironment();

const HASH = "a".repeat(40);
const P1 = "b".repeat(40);

beforeEach(() => {
    installWebviewI18n();
    mockVscodeApi.postMessage.mockReset();
    mockVscodeApi.getState.mockReset();
    mockVscodeApi.getState.mockReturnValue({ commitInfoTab: "checks" });
    window.intelligitE2E = true;
});

afterEach(() => {
    delete window.intelligitE2E;
});

function commit(): CommitDetail {
    return {
        hash: HASH,
        shortHash: HASH.slice(0, 7),
        message: "Commit",
        body: "",
        author: "Mahesh Kokare",
        email: "mahesh@example.com",
        date: "2026-11-07T12:00:00.000Z",
        parentHashes: [P1],
        refs: [],
        files: [],
    };
}

function detail(annotations?: CiAnnotationsView): CommitCiDetail {
    return {
        hash: HASH,
        provider: "github",
        complete: true,
        outcome: "failure",
        runs: [
            {
                id: "1",
                name: "CI",
                state: "failure",
                jobs: [
                    {
                        id: "11",
                        logicalId: "job\0CI\0test",
                        name: "test",
                        checkName: "test",
                        state: "failure",
                        steps: [],
                    },
                ],
                jobsCoverage: "full",
            },
        ],
        runsCoverage: "full",
        otherChecks: [],
        otherChecksCoverage: "full",
        capabilities: { ...NO_CI_CAPABILITIES, runs: true, jobs: true, annotations: true },
        repoKey: "/repo",
        ...(annotations && { annotations }),
    };
}

function posted<T extends { type: string }>(type: string): T[] {
    return mockVscodeApi.postMessage.mock.calls
        .map(([message]) => message as T)
        .filter((message) => message.type === type);
}

function show(build: CommitCiDetail): HTMLElement {
    const { container } = mount(
        <CommitInfoPane detail={commit()} ciRepoKey="/repo" commitChecksEnabled />,
    );
    const request = posted<{ type: string; requestId: number; hash: string }>(
        "requestCommitCiDetail",
    ).at(-1)!;
    act(() => {
        window.dispatchEvent(
            new MessageEvent("message", {
                data: {
                    type: "commitCiDetail",
                    requestId: request.requestId,
                    repoKey: "/repo",
                    hash: request.hash,
                    detail: build,
                },
            }),
        );
    });
    return container;
}

function section(container: HTMLElement): HTMLElement | null {
    return container.querySelector('[data-testid="ci-annotations"]');
}

const ITEMS: CiAnnotationsView["items"] = [
    { path: "src/a.ts", line: 2, level: "failure", message: "expected 1", job: "test" },
    { path: "src/b.ts", line: 9, level: "warning", message: "unused", job: "test" },
];

describe("Checks tab annotations", () => {
    it("lists each placed note and clicking one asks the host to open its line", () => {
        const container = show(detail({ items: ITEMS, rejected: 0, truncated: false }));
        const rows = [...container.querySelectorAll('[data-testid="ci-annotation"]')];
        expect(rows.map((row) => row.textContent)).toEqual(["src/a.ts:2", "src/b.ts:9"]);
        expect(section(container)?.textContent).toContain("expected 1");
        expect(container.querySelector('[data-testid="ci-annotations-rejected"]')).toBeNull();
        expect(container.querySelector('[data-testid="ci-annotations-truncated"]')).toBeNull();
        act(() => {
            (rows[1] as HTMLButtonElement).click();
        });
        expect(posted("openCiAnnotation").at(-1)).toMatchObject({
            type: "openCiAnnotation",
            repoKey: "/repo",
            hash: HASH,
            path: "src/b.ts",
            line: 9,
        });
    });

    it("discloses the notes it could not place and the page bound", () => {
        const container = show(detail({ items: ITEMS, rejected: 3, truncated: true }));
        expect(
            container.querySelector('[data-testid="ci-annotations-rejected"]')?.textContent,
        ).toBe("3 annotations could not be placed");
        expect(
            container.querySelector('[data-testid="ci-annotations-truncated"]')?.textContent,
        ).toBe("Showing the first 1 000 annotations");
    });

    it("a token without the scope says so", () => {
        const container = show(
            detail({ items: [], rejected: 0, truncated: false, unavailable: { forbidden: true } }),
        );
        expect(section(container)?.querySelector('[role="alert"]')?.textContent).toBe(
            "Annotations unavailable with this token",
        );
    });

    it("another failure names its reason", () => {
        const container = show(
            detail({
                items: [],
                rejected: 0,
                truncated: false,
                unavailable: { reason: "network down" },
            }),
        );
        expect(section(container)?.querySelector('[role="alert"]')?.textContent).toBe(
            "Annotations unavailable: network down",
        );
    });

    it("a commit without annotations shows no section", () => {
        const container = show(detail());
        expect(container.querySelector('[data-testid="ci-job-row"]')).not.toBeNull();
        expect(section(container)).toBeNull();
    });
});
