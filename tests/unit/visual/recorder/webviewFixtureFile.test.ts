/**
 * Spec-derived tests for `tests/visual/recorder/webviewFixtureFile.ts` (deliverable 3 of Phase
 * 2b): byte-identical formatting to `serializeHostFixture`
 * (`tests/e2e/hostFixtures/hostFixtureFile.ts`) -- 4-space indent, one trailing newline, key order
 * following the `WebviewFixture` type declaration rather than sorted -- plus the
 * `<repo>/tests/visual/fixtures/<contextId>/<scenario>.json` path convention PLAN.md step 11
 * establishes.
 */

import path from "node:path";

import { describe, expect, it } from "vitest";

import type { CapturedWebviewMessage } from "../../../../src/e2e/webviewCapture";
import {
    buildWebviewFixture,
    serializeWebviewFixture,
    webviewFixtureFilePath,
    webviewFixtureOutputDir,
} from "../../../visual/recorder/webviewFixtureFile";

describe("serializeWebviewFixture -- exact bytes", () => {
    it("matches a literal 4-space-indented, trailing-newline string with declaration key order", () => {
        const messages: readonly CapturedWebviewMessage[] = [
            { contextId: "commit-panel", message: { type: "state", label: "<ROOT>" } },
        ];
        const fixture = buildWebviewFixture("commit-panel", "clean", messages);

        const expected =
            "{\n" +
            '    "schemaVersion": 1,\n' +
            '    "contextId": "commit-panel",\n' +
            '    "scenario": "clean",\n' +
            '    "messages": [\n' +
            "        {\n" +
            '            "contextId": "commit-panel",\n' +
            '            "message": {\n' +
            '                "type": "state",\n' +
            '                "label": "<ROOT>"\n' +
            "            }\n" +
            "        }\n" +
            "    ]\n" +
            "}\n";

        expect(serializeWebviewFixture(fixture)).toBe(expected);
    });

    it("ends in exactly one trailing newline, never zero or two", () => {
        const fixture = buildWebviewFixture("commit-info", "empty", []);
        const bytes = serializeWebviewFixture(fixture);
        expect(bytes.endsWith("\n")).toBe(true);
        expect(bytes.endsWith("\n\n")).toBe(false);
    });
});

describe("webviewFixtureFilePath -- <repo>/tests/visual/fixtures/<contextId>/<scenario>.json", () => {
    it("builds the path under the contextId directory, named after the scenario", () => {
        const repoRoot = "/repo";
        expect(webviewFixtureFilePath(repoRoot, "merge-editor", "conflicted")).toBe(
            path.join(repoRoot, "tests", "visual", "fixtures", "merge-editor", "conflicted.json"),
        );
    });

    it("webviewFixtureOutputDir is the fixture path's own parent directory", () => {
        const repoRoot = "/repo";
        const dir = webviewFixtureOutputDir(repoRoot, "undocked");
        const filePath = webviewFixtureFilePath(repoRoot, "undocked", "dirty");
        expect(filePath).toBe(path.join(dir, "dirty.json"));
    });
});
