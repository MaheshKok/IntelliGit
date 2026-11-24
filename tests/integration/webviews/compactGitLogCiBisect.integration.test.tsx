// @vitest-environment jsdom
import React, { act } from "react";
import { expect, it, vi } from "vitest";
import { initReactDomTestEnvironment, mount, unmount } from "../../helpers/reactDomTestUtils";
import { installWebviewI18n } from "../../helpers/webviewI18nTestUtils";

const capture = vi.hoisted(() => ({ props: {} as Record<string, unknown> }));
vi.mock("../../../src/webviews/react/CommitList", () => ({
    CommitList: (props: Record<string, unknown>) => {
        capture.props = props;
        return <div />;
    },
}));

import { NativeCommitGraph } from "../../../src/webviews/react/NativeCommitGraph";

initReactDomTestEnvironment();

it("compact Git Log wires the range bisect action while Checks is enabled", () => {
    installWebviewI18n();
    window.intelligitE2E = true;
    const vscode = { postMessage: vi.fn(), getState: vi.fn(), setState: vi.fn() };
    const { root, container } = mount(
        <NativeCommitGraph vscode={vscode as never} sendReady={false} />,
    );
    try {
        act(() =>
            window.dispatchEvent(
                new MessageEvent("message", {
                    data: {
                        type: "setBranches",
                        branches: [],
                        commitChecksEnabled: true,
                        ciRepoKey: "/repo",
                    },
                }),
            ),
        );
        expect(
            capture.props.onOpenCommitInChecks,
            "control: the compact graph enables its existing Checks action",
        ).toBeTypeOf("function");
        expect(
            capture.props.onFindCiBreak,
            "a compact Git Log range needs the same bisect action as the card layout",
        ).toBeTypeOf("function");
    } finally {
        unmount(root, container);
        delete window.intelligitE2E;
    }
});
