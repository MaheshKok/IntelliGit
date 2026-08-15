import { describe, expect, it } from "vitest";

import { resolveVSCodeVersion } from "../../e2e/hostFixtures/resolveVSCodeExecutable";
import { VSCODE_VERSION } from "../../e2e/hostFixtures/vscodeVersion";

describe("resolveVSCodeVersion", () => {
    it("uses the pinned version when the override is unset", () => {
        expect(resolveVSCodeVersion({})).toBe(VSCODE_VERSION);
    });

    it.each(["", " ", " \t\n "])(
        "uses the pinned version for whitespace-only value %j",
        (value) => {
            expect(resolveVSCodeVersion({ INTELLIGIT_VSCODE_VERSION: value })).toBe(VSCODE_VERSION);
        },
    );

    it("uses a non-empty override without downloading VS Code", () => {
        expect(resolveVSCodeVersion({ INTELLIGIT_VSCODE_VERSION: "insiders" })).toBe("insiders");
    });

    // A padded value is judged non-empty by the same `trim()` the emptiness check uses, so
    // returning the raw string would hand the downloader " insiders " and resolve no build at all.
    it.each([" insiders", "insiders ", " insiders\n"])(
        "returns the trimmed override for padded value %j",
        (value) => {
            expect(resolveVSCodeVersion({ INTELLIGIT_VSCODE_VERSION: value })).toBe("insiders");
        },
    );
});
