// @vitest-environment jsdom
// "Find where CI broke" (frame 4:2): a commit whose checks were read but list no run of the job is
// not called unread, and a result whose snapshots were all read is not said to have unread commits
// when only the re-run history could not be read.

import React from "react";
import { describe, expect, it } from "vitest";
import { BisectView } from "../../../src/webviews/react/commit-info/checks/BisectView";
import type { CiBisectResultMessage } from "../../../src/webviews/protocol/commitCiMessages";
import { initReactDomTestEnvironment, mount, unmount } from "../../helpers/reactDomTestUtils";
import { installWebviewI18n } from "../../helpers/webviewI18nTestUtils";

initReactDomTestEnvironment();
const [A, B, C, D] = ["a", "b", "c", "d"].map((letter) => letter.repeat(40));

function render(result: CiBisectResultMessage): HTMLElement {
    installWebviewI18n();
    const { root, container } = mount(
        <BisectView view={{ status: "done", requestId: 1, repoKey: "/A", result }} />,
    );
    const copy = container.cloneNode(true) as HTMLElement;
    unmount(root, container);
    return copy;
}

describe("CI bisect labels", () => {
    it("does not describe a confirmed no-job square as an unread commit", () => {
        const container = render({
            type: "ciBisectResult",
            requestId: 1,
            repoKey: "/A",
            linear: true,
            commits: [A, B, C, D],
            jobs: [
                {
                    checkName: "build",
                    brokeAt: B,
                    flaky: { n: 1, m: 3, attemptsCounted: false },
                    states: ["success", "failure", null, "success"],
                    isolated: [false, true, false, false],
                },
            ],
        });
        const label = container.querySelector(`[data-hash="${C}"]`)?.getAttribute("aria-label");
        expect(label, "a square with no result").toBe("ccccccc: no result");
        expect(label, "the read with no job left no unread commit").not.toContain("not read");
    });

    it("does not call commits unread when only re-run history failed", () => {
        const container = render({
            type: "ciBisectResult",
            requestId: 1,
            repoKey: "/A",
            linear: true,
            commits: [A, B],
            failedReads: 2,
            jobs: [
                {
                    checkName: "build",
                    brokeAt: null,
                    flaky: null,
                    states: ["success", "success"],
                    isolated: [false, false],
                },
            ],
        });
        const alert = container.querySelector('[role="alert"]')?.textContent ?? "";
        expect(alert, "the count is still shown").toContain("2");
        expect(alert, "every check snapshot was read").not.toContain("not read");
    });
});
