// HEAD's CI failure annotations in the Problems panel (PLAN.md §11): one `intelligit-ci`
// collection, filled only for a complete failing HEAD whose provider reads annotations. Every
// path and line range comes from the provider and is validated before a Diagnostic exists.

import { promises as fs, realpathSync } from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import type {
    CiAnnotationLevel,
    CiAnnotationsView,
    CiCoverage,
    CiJob,
    CommitCiDetail,
} from "../../types";
import { getErrorMessage } from "../../utils/errors";
import type { CiGenerations, CiOperationContext } from "./ciGenerations";
import { HttpError } from "./http";
import type { CiAnnotation, CiAnnotations, ProviderId } from "./types";

/** The Problems panel collection the annotations live in. */
export const CI_DIAGNOSTICS_COLLECTION = "intelligit-ci";

/** What the diagnostics read and write. */
export interface CiDiagnosticsDeps {
    /** The Checks tab switch (Phase 18 removes it). */
    switchOn(): boolean;
    /** CI checks, the provider and `intelligit.commitChecks.problemsDiagnostics` are all on. */
    enabled(provider: ProviderId): boolean;
    /** Repository the window shows now. */
    repoKey(): string | undefined;
    /** HEAD's commit hash now. */
    headHash(): Promise<string | undefined>;
    generations: Pick<CiGenerations, "isCurrent">;
    /** The `intelligit-ci` collection, or a stand-in that creates it on the first `set`. */
    collection: {
        set(uri: vscode.Uri, diagnostics: vscode.Diagnostic[]): void;
        clear(): void;
    };
    /**
     * One check run's annotations; rejects on failure. `isCurrent` is the show's own check of
     * the switch, sign-in, settings and HEAD, for the reader to rerun before each request.
     */
    annotations(
        hash: string,
        checkRunId: string,
        isCurrent: () => boolean | Promise<boolean>,
    ): Promise<CiAnnotations>;
}

/** A settled HEAD's detail, with the repository and context the fetch ran in. */
export interface CiDiagnosticsTarget {
    repoKey: string;
    hash: string;
    ctx: CiOperationContext;
    detail: CommitCiDetail;
}

/** The Checks tab's view of the annotations, for the commit they belong to. */
export interface CiAnnotationsAccess {
    viewFor(repoKey: string, hash: string): CiAnnotationsView | undefined;
    /** Fires when the view is published or cleared. */
    onDidChange(listener: () => void): { dispose(): void };
    /** Opens a placed annotation's file at its line; anything not placed opens nothing. */
    open(repoKey: string, hash: string, filePath: string, line: number): Promise<void>;
    /** The Checks tab's Refresh: reads HEAD's annotations again, even after a failed read. */
    refresh(target: CiDiagnosticsTarget): Promise<void>;
}

// Read at call time, not import time: importing this module needs no Diagnostic API.
function severityOf(level: CiAnnotationLevel): vscode.DiagnosticSeverity {
    if (level === "failure") return vscode.DiagnosticSeverity.Error;
    return level === "warning"
        ? vscode.DiagnosticSeverity.Warning
        : vscode.DiagnosticSeverity.Information;
}

interface Placed {
    /** Relative path with `/` separators, as the tab lists it. */
    relPath: string;
    /** The file's real path inside the repository, as validated; the Problems entry's URI. */
    real: string;
    level: CiAnnotationLevel;
    /** 0-based, clamped to the file. */
    startLine: number;
    endLine: number;
    endCharacter: number;
    message: string;
    job: string;
}

/** HEAD's CI annotations in the Problems panel and the Checks tab. */
export class CiDiagnostics implements CiAnnotationsAccess {
    // Bumped by every show and clear; only the newest show may publish.
    private sequence = 0;
    // The commit the newest show ran for, so a later poll of the same HEAD sends nothing again.
    private target?: string;
    // `current` is the publishing show's own check, rerun when a click opens a file.
    private published?: {
        repoKey: string;
        hash: string;
        view: CiAnnotationsView;
        current: () => Promise<boolean>;
    };
    private readonly listeners = new Set<() => void>();

    /**
     * Holds no state beyond the newest show and the published view.
     *
     * @param deps - The switch, settings, HEAD, generations, collection and reader it uses.
     */
    constructor(private readonly deps: CiDiagnosticsDeps) {}

    /**
     * Reads and places the annotations of a settled failing HEAD. Never throws: a failed read
     * clears the collection and shows "unavailable" in the Checks tab.
     */
    async show({ repoKey, hash, ctx, detail }: CiDiagnosticsTarget): Promise<void> {
        const jobs = annotatedJobs(detail);
        if (jobs.length === 0) return;
        const key = `${repoKey}\0${hash}`;
        if (this.target === key) return;
        const sequence = ++this.sequence;
        this.target = key;
        // The one check before every outside effect (a request, a page, a publish, an open):
        // the switch (ships hidden until Phase 18), the settings, the sign-in and lifecycle
        // generations, the newest show, and HEAD only. HEAD is read first, so nothing it awaits
        // can change the rest before the caller acts.
        const current = async (): Promise<boolean> =>
            (await this.deps.headHash()) === hash &&
            sequence === this.sequence &&
            this.deps.switchOn() &&
            this.deps.enabled(detail.provider) &&
            this.deps.generations.isCurrent(ctx, this.deps.repoKey() ?? "");
        const read: { job: CiJob; result: CiAnnotations }[] = [];
        try {
            for (const job of jobs) {
                // react-doctor-disable-next-line react-doctor/async-await-in-loop
                if (!(await current())) return;
                // Serial: each request takes a slot of the provider's request gate.
                // react-doctor-disable-next-line react-doctor/async-await-in-loop
                const result = await this.deps.annotations(hash, job.checkRunId as string, current);
                read.push({ job, result });
            }
        } catch (error) {
            // The same final check as a success: the failure belongs to this HEAD only while it is HEAD.
            if (!(await current())) return;
            this.deps.collection.clear();
            const forbidden = error instanceof HttpError && error.statusCode === 403;
            this.publish(repoKey, hash, current, {
                items: [],
                rejected: 0,
                coverage: "full",
                unavailable: forbidden ? { forbidden: true } : { reason: getErrorMessage(error) },
            });
            return;
        }
        const all = await placeAll(repoKey, read);
        // Ships hidden until Phase 18: nothing reaches the Problems panel while the switch is off.
        if (!(await current())) return;
        // A file swapped for a symlink since placement no longer resolves to itself. Synchronous,
        // so nothing can change between this check and the publish below.
        const placed = all.placed.filter((item) => resolvesToItself(item.real));
        const rejected = all.rejected + all.placed.length - placed.length;
        this.deps.collection.clear();
        const byFile = new Map<string, vscode.Diagnostic[]>();
        for (const item of placed) {
            const diagnostic = new vscode.Diagnostic(
                new vscode.Range(item.startLine, 0, item.endLine, item.endCharacter),
                item.message,
                severityOf(item.level),
            );
            diagnostic.source = `CI: ${item.job}`;
            const list = byFile.get(item.real) ?? [];
            list.push(diagnostic);
            byFile.set(item.real, list);
        }
        // The contained real path, never the provider's own spelling of it (K28).
        for (const [real, diagnostics] of byFile) {
            this.deps.collection.set(vscode.Uri.file(real), diagnostics);
        }
        this.publish(repoKey, hash, current, {
            items: placed.map((item) => ({
                path: item.relPath,
                line: item.startLine + 1,
                level: item.level,
                message: item.message,
                job: item.job,
            })),
            rejected,
            coverage: worstCoverage(read.map(({ result }) => result.coverage)),
        });
    }

    async refresh(target: CiDiagnosticsTarget): Promise<void> {
        if ((await this.deps.headHash()) !== target.hash) return;
        // Forget that this commit was shown, so `show` reads it again instead of returning.
        if (this.target === `${target.repoKey}\0${target.hash}`) this.target = undefined;
        await this.show(target);
    }

    /** Empties the collection and drops any show still running (HEAD move, sign-out, settings). */
    clear(): void {
        this.sequence += 1;
        this.target = undefined;
        this.deps.collection.clear();
        if (this.published) {
            this.published = undefined;
            this.fire();
        }
    }

    /**
     * The Checks tab's view of the annotations for one commit.
     *
     * @param repoKey - Repository the tab shows.
     * @param hash - Commit the tab shows.
     * @returns The published view when it belongs to that commit.
     */
    viewFor(repoKey: string, hash: string): CiAnnotationsView | undefined {
        const published = this.published;
        return published?.repoKey === repoKey && published.hash === hash
            ? published.view
            : undefined;
    }

    onDidChange(listener: () => void): { dispose(): void } {
        this.listeners.add(listener);
        return { dispose: () => this.listeners.delete(listener) };
    }

    async open(repoKey: string, hash: string, filePath: string, line: number): Promise<void> {
        const published = this.published;
        const listed =
            published?.repoKey === repoKey &&
            published.hash === hash &&
            published.view.items.some((item) => item.path === filePath && item.line === line);
        if (!listed) return;
        // The file may have changed since it was placed: contain it again and open what that finds.
        const real = await realInside(repoKey, filePath);
        // A clear, a newer show, a sign-out, the switch or a HEAD move during the awaits retires
        // the click.
        if (!real || !(await published.current())) return;
        // No await from here to the open: a file swapped for a symlink during the awaits above
        // no longer resolves to itself (K28).
        if (!resolvesToItself(real)) return;
        await vscode.window.showTextDocument(vscode.Uri.file(real), {
            selection: new vscode.Range(line - 1, 0, line - 1, 0),
        });
    }

    private publish(
        repoKey: string,
        hash: string,
        current: () => Promise<boolean>,
        view: CiAnnotationsView,
    ): void {
        this.published = { repoKey, hash, view, current };
        this.fire();
    }

    private fire(): void {
        for (const listener of [...this.listeners]) listener();
    }
}

/** The failed jobs of a complete failing detail whose check run has annotations. */
function annotatedJobs(detail: CommitCiDetail): CiJob[] {
    if (!detail.complete || detail.outcome !== "failure" || !detail.capabilities.annotations) {
        return [];
    }
    return detail.runs.flatMap((run) =>
        run.jobs.filter(
            (job) =>
                job.state === "failure" &&
                job.checkRunId !== undefined &&
                (job.annotationCount ?? 0) > 0,
        ),
    );
}

/** Validates every annotation (K28): rejected ones are counted, valid ones kept. */
async function placeAll(
    repoKey: string,
    read: readonly { job: CiJob; result: CiAnnotations }[],
): Promise<{ placed: Placed[]; rejected: number }> {
    const placed: Placed[] = [];
    let rejected = 0;
    let rootReal: string;
    try {
        rootReal = await fs.realpath(repoKey);
    } catch {
        return { placed, rejected: read.reduce((n, r) => n + r.result.annotations.length, 0) };
    }
    const files = new Map<string, Promise<InsideFile | undefined>>();
    for (const { job, result } of read) {
        for (const annotation of result.annotations) {
            // react-doctor-disable-next-line react-doctor/async-await-in-loop
            const item = await place(annotation, job.name, rootReal, files);
            if (item) placed.push(item);
            else rejected += 1;
        }
    }
    return { placed, rejected };
}

/** One annotation placed inside the repository, or undefined when it must be dropped. */
async function place(
    annotation: CiAnnotation,
    job: string,
    rootReal: string,
    files: Map<string, Promise<InsideFile | undefined>>,
): Promise<Placed | undefined> {
    const relPath = safeRelativePath(annotation.path);
    const { startLine, endLine } = annotation;
    if (relPath === undefined || !isLine(startLine) || !isLine(endLine) || endLine < startLine) {
        return undefined;
    }
    let read = files.get(relPath);
    if (!read) {
        read = readInside(rootReal, relPath);
        files.set(relPath, read);
    }
    const file = await read;
    if (!file) return undefined;
    const text = file.lines;
    const last = text.length;
    const start = Math.min(startLine, last) - 1;
    const end = Math.min(endLine, last) - 1;
    return {
        relPath,
        real: file.real,
        level: levelOf(annotation.level),
        startLine: start,
        endLine: end,
        endCharacter: text[end].length,
        message: typeof annotation.message === "string" ? annotation.message : "",
        job,
    };
}

/**
 * The path with `/` separators when it is relative and names no parent; undefined for an
 * absolute path, a drive letter, a UNC prefix or any `..` segment.
 */
function safeRelativePath(raw: unknown): string | undefined {
    if (typeof raw !== "string" || raw.length === 0) return undefined;
    const relPath = raw.replace(/\\/g, "/");
    // A UNC prefix (`\\server`) starts with `/` once normalised.
    if (relPath.startsWith("/") || /^[A-Za-z]:/.test(relPath)) return undefined;
    if (relPath.split("/").includes("..")) return undefined;
    return relPath;
}

/**
 * The file's real path, symlinks resolved, when it exists and stays inside the repository's
 * real path; undefined otherwise. The repository path itself is resolved here, so a caller
 * holding only `repoKey` gets the same containment check as placement.
 */
async function realInside(repoKey: string, relPath: string): Promise<string | undefined> {
    try {
        return await realInsideRoot(await fs.realpath(repoKey), relPath);
    } catch {
        return undefined;
    }
}

async function realInsideRoot(rootReal: string, relPath: string): Promise<string | undefined> {
    const real = await fs.realpath(path.join(rootReal, relPath));
    return real.startsWith(rootReal + path.sep) ? real : undefined;
}

interface InsideFile {
    real: string;
    lines: string[];
}

/** The file's real path and lines when it exists and stays inside the repository. */
async function readInside(rootReal: string, relPath: string): Promise<InsideFile | undefined> {
    try {
        const real = await realInsideRoot(rootReal, relPath);
        if (!real) return undefined;
        return { real, lines: (await fs.readFile(real, "utf8")).split(/\r?\n/) };
    } catch {
        return undefined;
    }
}

/** Whether a validated real path still names itself (no part of it became a symlink). */
function resolvesToItself(real: string): boolean {
    try {
        // The native resolver, as `fs.promises.realpath` uses: Node's JS one can spell a Windows
        // path differently, which would drop every annotation.
        return realpathSync.native(real) === real;
    } catch {
        return false;
    }
}

/** A refused continuation outranks a page bound; "full" only when every read was complete. */
function worstCoverage(coverages: readonly CiCoverage[]): CiCoverage {
    const partial = coverages.filter((coverage) => coverage !== "full");
    return partial.find((coverage) => coverage.reason === "rejectedNext") ?? partial[0] ?? "full";
}

function isLine(value: unknown): value is number {
    return Number.isInteger(value) && (value as number) >= 1;
}

function levelOf(level: string): CiAnnotationLevel {
    return level === "failure" || level === "warning" ? level : "notice";
}
