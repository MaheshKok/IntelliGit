import { readFileSync, readdirSync } from "node:fs";
import * as path from "node:path";
import { computeDiffSegments } from "../src/diff/diffSegments";

interface Fixture {
    readonly name: string;
    readonly left: string;
    readonly right: string;
    readonly sourceFile?: string;
}

interface Measurement {
    readonly name: string;
    readonly sourceFile?: string;
    readonly leftBytes: number;
    readonly rightBytes: number;
    readonly leftLines: number;
    readonly rightLines: number;
    readonly dpCells: number;
    readonly computeMs: number;
    readonly payloadBytes: number;
    readonly heapDeltaBytes: number | "unmeasured";
}

interface SourceFileMeasurement {
    readonly path: string;
    readonly bytes: number;
    readonly lines: number;
}

function buildLines(count: number, prefix: string, width = 0): string {
    return Array.from({ length: count }, (_, index) => {
        const suffix = `${prefix}-${index}`;
        return width > suffix.length ? suffix + "x".repeat(width - suffix.length) : suffix;
    }).join("\n");
}

/** Mirrors src/diff/sideLoader.ts countLines for reproducible budget measurements. */
function countLines(bytes: Uint8Array): number {
    if (bytes.byteLength === 0) return 0;
    let lines = 1;
    for (let index = 0; index < bytes.byteLength; index++) {
        if (bytes[index] === 10) lines++;
        if (bytes[index] === 13 && bytes[index + 1] !== 10) lines++;
    }
    return bytes[bytes.byteLength - 1] === 10 || bytes[bytes.byteLength - 1] === 13
        ? lines - 1
        : lines;
}

function modifiedCopy(source: string, marker: string): string {
    const lines = source.split("\n");
    const lineCount = lines.at(-1) === "" ? lines.length - 1 : lines.length;
    const editCount = Math.max(1, Math.ceil(lineCount * 0.02));
    const start = Math.floor(lineCount * 0.37);
    for (let offset = 0; offset < editCount; offset++) {
        const index = Math.min(start + offset, lineCount - 1);
        lines[index] = `${lines[index]} // measured ${marker} edit ${offset}`;
    }
    return lines.join("\n");
}

function readRepositoryFile(relativePath: string): string {
    return readFileSync(path.resolve(process.cwd(), relativePath), "utf8");
}

function buildCorpus(): Fixture[] {
    const small = readRepositoryFile("src/diff/wordDiff.ts");
    const typical = readRepositoryFile("src/services/diffService.ts");
    const large = readRepositoryFile("src/views/CommitPanelViewProvider.ts");
    return [
        {
            name: "small",
            sourceFile: "src/diff/wordDiff.ts",
            left: small,
            right: modifiedCopy(small, "small"),
        },
        {
            name: "typical",
            sourceFile: "src/services/diffService.ts",
            left: typical,
            right: modifiedCopy(typical, "typical"),
        },
        {
            name: "large",
            sourceFile: "src/views/CommitPanelViewProvider.ts",
            left: large,
            right: modifiedCopy(large, "large"),
        },
        {
            name: "pathological-many-lines",
            left: buildLines(3_500, "many-left"),
            right: buildLines(3_500, "many-right"),
        },
        {
            name: "pathological-long-lines",
            left: buildLines(1_200, "long-left", 2_048),
            right: buildLines(1_200, "long-right", 2_048),
        },
    ];
}

function buildPayload(fixture: Fixture): Record<string, unknown> {
    const computed = computeDiffSegments(fixture.left, fixture.right);
    return {
        path: fixture.sourceFile ?? "src/measurement.ts",
        leftLabel: "left",
        rightLabel: "right",
        languageId: "typescript",
        ...computed,
        ignoreWhitespace: false,
    };
}

function getSourceFiles(directory: string): SourceFileMeasurement[] {
    const files: SourceFileMeasurement[] = [];
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            files.push(...getSourceFiles(entryPath));
            continue;
        }
        if (!entry.isFile() || !/\.(?:ts|tsx)$/.test(entry.name)) continue;
        const source = readFileSync(entryPath, "utf8");
        files.push({
            path: path.relative(process.cwd(), entryPath),
            bytes: Buffer.byteLength(source),
            lines: source.split(/\r\n|\r|\n/).length,
        });
    }
    return files;
}

function measureRealSourceBytesPerLine(): number {
    const sourceFiles = getSourceFiles(path.resolve(process.cwd(), "src"))
        .sort((left, right) => right.bytes - left.bytes)
        .slice(0, 200);
    const bytes = sourceFiles.reduce((total, file) => total + file.bytes, 0);
    const lines = sourceFiles.reduce((total, file) => total + file.lines, 0);
    return bytes / lines;
}

function forceCollection(): (() => void) | undefined {
    return (globalThis as typeof globalThis & { gc?: () => void }).gc;
}

function measure(fixture: Fixture): Measurement {
    buildPayload(fixture);
    const gc = forceCollection();
    gc?.();
    const heapBefore = gc ? process.memoryUsage().heapUsed : undefined;
    const startedAt = performance.now();
    const payload = buildPayload(fixture);
    const computeMs = performance.now() - startedAt;
    gc?.();
    const heapDeltaBytes = gc
        ? process.memoryUsage().heapUsed - (heapBefore as number)
        : "unmeasured";
    const leftLines = countLines(Buffer.from(fixture.left, "utf8"));
    const rightLines = countLines(Buffer.from(fixture.right, "utf8"));
    return {
        name: fixture.name,
        sourceFile: fixture.sourceFile,
        leftBytes: Buffer.byteLength(fixture.left),
        rightBytes: Buffer.byteLength(fixture.right),
        leftLines,
        rightLines,
        dpCells: leftLines * rightLines,
        computeMs,
        payloadBytes: Buffer.byteLength(JSON.stringify(payload), "utf8"),
        heapDeltaBytes,
    };
}

console.log(JSON.stringify({ realSourceBytesPerLine: measureRealSourceBytesPerLine() }));
for (const measurement of buildCorpus().map(measure)) {
    console.log(JSON.stringify(measurement));
}
