import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
    BASELINE_PLATFORM,
    baselineFile,
    UPDATE_ENV_VAR,
} from "../../../visual/oracles/findingsBaselineFile";

const originalUpdateValue = process.env[UPDATE_ENV_VAR];
const temporaryDirectories: string[] = [];

afterEach(async () => {
    if (originalUpdateValue === undefined) delete process.env[UPDATE_ENV_VAR];
    else process.env[UPDATE_ENV_VAR] = originalUpdateValue;
    await Promise.all(
        temporaryDirectories
            .splice(0)
            .map((directory) => rm(directory, { recursive: true, force: true })),
    );
});

async function temporaryBaselinePath(): Promise<string> {
    const directory = await mkdtemp(path.join(os.tmpdir(), "intelligit-baseline-test-"));
    temporaryDirectories.push(directory);
    return path.join(directory, "nested", "findings.json");
}

describe("baselineFile", () => {
    it("can fail: a bucket missing from the bucket list is refused instead of silently dropped", async () => {
        const filePath = await temporaryBaselinePath();
        const file = baselineFile(filePath, ["clipping"] as const);

        // The slice reaches writeSlice as a variable, so TypeScript's excess-property check does not
        // fire. Dropping the extra bucket would leave it permanently un-baselined, which reads as
        // "no findings" rather than "never recorded".
        expect(() =>
            file.writeSlice("project", "context", {
                clipping: ["a"],
                zeroSize: ["b"],
            } as Parameters<typeof file.writeSlice>[2]),
        ).toThrow(/unknown bucket\(s\): zeroSize/);
    });

    it("writes sorted projects and contexts while retaining the requested bucket order", async () => {
        const filePath = await temporaryBaselinePath();
        const file = baselineFile(filePath, ["clipping", "zeroSize"] as const);

        file.writeSlice("z-project", "b-context", {
            zeroSize: ["z"],
            clipping: ["a"],
        });
        file.writeSlice("a-project", "a-context", { clipping: ["c"] });

        expect(file.read()).toEqual({
            "a-project": { "a-context": { clipping: ["c"] } },
            "z-project": {
                "b-context": { clipping: ["a"], zeroSize: ["z"] },
            },
        });

        // Compared as raw text, not through `toEqual`, which ignores key order entirely: both the
        // project/context sort and the bucket ordering could be dropped while a structural
        // comparison stayed green. Regenerating this file has to be byte-reproducible, because that
        // is what lets an unchanged baseline be recognised by its hash after a container run.
        // z-project was written first and zeroSize was listed before clipping, so a missing sort
        // and a missing bucket ordering each change these bytes.
        await expect(readFile(filePath, "utf8")).resolves.toBe(
            `{
    "a-project": {
        "a-context": {
            "clipping": [
                "c"
            ]
        }
    },
    "z-project": {
        "b-context": {
            "clipping": [
                "a"
            ],
            "zeroSize": [
                "z"
            ]
        }
    }
}
`,
        );
    });

    it("rejects multi-worker updates", () => {
        process.env[UPDATE_ENV_VAR] = "1";
        const file = baselineFile("/tmp/unused-baseline.json", ["clipping"] as const);

        expect(() => file.assertSingleWorker(2)).toThrow(/single-threaded/);
    });

    it("checks the current platform when updates are requested", () => {
        process.env[UPDATE_ENV_VAR] = "1";
        const file = baselineFile("/tmp/unused-baseline.json", ["clipping"] as const);
        const platform = `${process.platform}-${process.arch}`;

        if (platform === BASELINE_PLATFORM) {
            expect(() => file.assertUpdatePlatform()).not.toThrow();
        } else {
            expect(() => file.assertUpdatePlatform()).toThrow(/linux-x64/);
        }
    });
});
