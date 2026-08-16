import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const localTypeScriptCli = path.join(repoRoot, "node_modules/typescript/bin/tsc");
const compilerTimeoutMs = 120_000;

interface CompilerRun {
    readonly status: number | null;
    readonly output: string;
}

interface Diagnostic {
    readonly file: string;
    readonly code: string;
    readonly message: string;
}

/** Runs the repository-local TypeScript CLI with a bounded subprocess lifetime. */
function runTypeScript(configFile: string, ...arguments_: string[]): CompilerRun {
    const result = spawnSync(
        process.execPath,
        [localTypeScriptCli, "-p", configFile, ...arguments_],
        {
            cwd: repoRoot,
            encoding: "utf8",
            timeout: compilerTimeoutMs,
            // `tsc --listFiles` prints every source and `.d.ts` path the project pulls in, including
            // `node_modules` typings, which passes Node's 1 MiB default on a full checkout. Overflow
            // is not a truncated list: Node sets `error` to ENOBUFS and `status` to null, so the run
            // fails with a buffer message instead of the coverage failure this file exists to report.
            maxBuffer: 64 * 1024 * 1024,
        },
    );

    return {
        status: result.status,
        output: [result.stdout, result.stderr, result.error?.message]
            .filter((part): part is string => typeof part === "string" && part.length > 0)
            .join("\n"),
    };
}

/** Converts compiler-listed paths into slash-separated paths relative to this repository. */
function relativeRepoPath(filePath: string): string {
    return path.relative(repoRoot, path.resolve(repoRoot, filePath)).split(path.sep).join("/");
}

/** Extracts the path, TypeScript code, and complete message from non-pretty compiler diagnostics. */
function parseDiagnostics(output: string): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];
    const pattern = /^(.*?)\(\d+,\d+\): error (TS\d+): (.*)$/gm;

    for (const match of output.matchAll(pattern)) {
        diagnostics.push({
            file: relativeRepoPath(match[1]),
            code: match[2],
            message: match[3],
        });
    }

    return diagnostics;
}

/** Compares diagnostics as a set while keeping every path, code, and full message exact. */
function sortDiagnostics(diagnostics: readonly Diagnostic[]): Diagnostic[] {
    return [...diagnostics].sort((left, right) => {
        const leftKey = `${left.file}\u0000${left.code}\u0000${left.message}`;
        const rightKey = `${right.file}\u0000${right.code}\u0000${right.message}`;
        return leftKey.localeCompare(rightKey);
    });
}

describe("tsconfig.tests.json coverage", () => {
    it(
        "covers the positive test tree and isolates exact negative fixture diagnostics",
        () => {
            const listedFilesRun = runTypeScript(
                "tsconfig.tests.json",
                "--listFiles",
                "--pretty",
                "false",
            );
            expect(listedFilesRun.status, "the positive listFiles compilation must succeed").toBe(
                0,
            );

            const listedFiles = new Set(
                listedFilesRun.output
                    .split(/\r?\n/)
                    .filter((line) => line.length > 0 && !line.startsWith("error "))
                    .map(relativeRepoPath),
            );
            for (const expectedFile of [
                "tests/fixtures/repo/harness.ts",
                "tests/e2e/coverage-manifest.ts",
                "tests/visual/harness/renderHarnessDocument.ts",
                "tests/helpers/reactDomTestUtils.tsx",
                "src/webviews/react/css-modules.d.ts",
            ]) {
                expect(
                    listedFiles.has(expectedFile),
                    `${expectedFile} must be listed by tsconfig.tests.json`,
                ).toBe(true);
            }

            for (const excludedFile of [
                "tests/typecheck-negative/fixtures/invalid-schema-version.ts",
                "tests/typecheck-negative/fixtures/invalid-messages.ts",
            ]) {
                expect(
                    listedFiles.has(excludedFile),
                    `${excludedFile} must stay out of the positive project`,
                ).toBe(false);
            }

            const positiveCompilation = runTypeScript("tsconfig.tests.json", "--pretty", "false");
            expect(positiveCompilation.status, "the positive project must compile cleanly").toBe(0);
            expect(
                positiveCompilation.output,
                "the clean positive compilation must not emit diagnostics",
            ).toBe("");

            const negativeCompilation = runTypeScript(
                "tsconfig.tests-negative.json",
                "--pretty",
                "false",
            );
            expect(
                negativeCompilation.status,
                "the negative project must fail because its fixtures are deliberately malformed",
                // `not.toBe(0)` is also satisfied by `null`, which is what `runTypeScript` reports
                // when the compiler is killed by the timeout or by a signal -- so a hung or crashed
                // run would read as the deliberate failure this asserts. A real compiler rejection
                // is a positive exit status.
            ).toBeGreaterThan(0);
            expect(
                sortDiagnostics(parseDiagnostics(negativeCompilation.output)),
                `negative compiler diagnostics must match exactly; output:\n${negativeCompilation.output}`,
            ).toEqual(
                sortDiagnostics([
                    {
                        file: "tests/typecheck-negative/fixtures/invalid-schema-version.ts",
                        code: "TS2322",
                        message: "Type 'string' is not assignable to type 'number'.",
                    },
                    {
                        file: "tests/typecheck-negative/fixtures/invalid-messages.ts",
                        code: "TS2322",
                        message:
                            "Type 'string' is not assignable to type 'readonly CapturedWebviewMessage[]'.",
                    },
                ]),
            );
        },
        // Three full compilations of the test tree run inside ONE test, while vitest's global
        // `testTimeout` is 30s (`vitest.config.ts:14`). Without this the 120s `compilerTimeoutMs`
        // guard can never fire -- vitest would kill the test first and report a generic timeout
        // instead of the compiler hang the guard exists to surface. Measured warm: 4.4s.
        compilerTimeoutMs * 3,
    );
});
