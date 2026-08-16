/**
 * Phase 6 helpers for capturing and comparing the canonical fixture snapshot across allocated
 * workspaces. The existing snapshot modules own repository coverage and path normalization; this
 * file only supplies the durable shelf provider that a plain Vitest process can capture.
 */

import { createHash } from "node:crypto";

import { resolveShelfPaths } from "../../../src/shelf/paths";
import { inventoryDirectory } from "./fsInventory";
import type { FixtureWorkspace } from "./harness";
import { type PlaceholderRoots, snapshotWorkspace } from "./snapshot";
import { buildPlaceholderReplacements, normalizeString } from "./placeholderCanonicalization";
import { normalizeSnapshot } from "./snapshotNormalize";
import { captured, type FsEntry, type WorkspaceSnapshot } from "./snapshotTypes";

/** A raw workspace snapshot paired with the concrete roots required for normalization. */
export interface FixtureSnapshot {
    readonly snapshot: WorkspaceSnapshot;
    readonly roots: PlaceholderRoots;
}

const UUID_TOKEN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
const COMPACT_UUID_TOKEN = /\b[0-9a-f]{32}\b/gi;

/**
 * Captures one allocated workspace, including shelf files when the selected harness scenario owns
 * a shelf store. The profile directory is passed through as a snapshot root and is checked by the
 * caller; VS Code Memento/SecretStorage state is unavailable in this plain test process.
 */
export async function captureFixtureSnapshot(
    workspace: FixtureWorkspace,
): Promise<FixtureSnapshot> {
    const roots: PlaceholderRoots = {
        root: workspace.root,
        originRoot: workspace.originRoot,
        profileDir: workspace.profileDir,
    };
    const durableState = workspace.shelfStorageRoot
        ? {
              snapshotDurableState: async () => ({
                  shelfFiles: await captureShelfFiles(workspace, roots),
                  memento: { global: {}, workspace: {} },
                  secrets: {},
                  configuration: {},
                  webviewState: {},
              }),
          }
        : undefined;

    return {
        roots,
        snapshot: await snapshotWorkspace({ ...roots, env: workspace.env, durableState }),
    };
}

/**
 * Produces the comparison form of a captured snapshot. UUID-like shelf allocation tokens are
 * legitimate per-allocation variance, while file bytes, modes, paths, and all repository sections
 * remain substantive and are preserved by the canonical normalizer.
 */
export function normalizeFixtureSnapshot(capturedSnapshot: FixtureSnapshot): WorkspaceSnapshot {
    const normalized = normalizeSnapshot(capturedSnapshot.snapshot, capturedSnapshot.roots);
    const withAdministrativeVarianceRemoved = {
        ...normalized,
        workspace: {
            ...normalized.workspace,
            gitDirState: normalizeGitDirStateVariance(normalized.workspace.gitDirState),
            worktrees: normalizeWorktreePathVariance(normalized.workspace.worktrees),
        },
        origin: {
            ...normalized.origin,
            worktrees: normalizeWorktreePathVariance(normalized.origin.worktrees),
        },
    };
    if (withAdministrativeVarianceRemoved.durableState.status !== "captured") {
        return withAdministrativeVarianceRemoved;
    }

    return {
        ...withAdministrativeVarianceRemoved,
        durableState: captured({
            ...withAdministrativeVarianceRemoved.durableState.data,
            shelfFiles: withAdministrativeVarianceRemoved.durableState.data.shelfFiles.map(
                (entry) => normalizeShelfEntry(entry, capturedSnapshot.roots),
            ),
        }),
    };
}

async function captureShelfFiles(
    workspace: FixtureWorkspace,
    roots: PlaceholderRoots,
): Promise<readonly FsEntry[]> {
    if (!workspace.shelfStorageRoot) return [];
    const shelfPaths = await resolveShelfPaths({
        repositoryRoot: workspace.root,
        globalStoragePath: workspace.shelfStorageRoot,
    });
    const entries = await inventoryDirectory({ root: shelfPaths.root });
    return entries.map((entry) => normalizeShelfEntry(entry, roots));
}

function normalizeShelfEntry(entry: FsEntry, roots: PlaceholderRoots): FsEntry {
    const replacements = buildPlaceholderReplacements(roots);
    const relativePath = normalizeShelfToken(entry.relativePath);
    const text = normalizeShelfText(entry.text, replacements);
    const symlinkTarget =
        entry.symlinkTarget === null ? null : normalizeShelfText(entry.symlinkTarget, replacements);
    const digest = text !== null && text !== entry.text ? digestText(text) : entry.digest;
    return { ...entry, relativePath, text, symlinkTarget, digest };
}

function normalizeShelfText(
    value: string | null,
    replacements: ReturnType<typeof buildPlaceholderReplacements>,
): string | null {
    if (value === null) return null;
    const normalized = normalizeString(normalizeShelfToken(value), replacements);
    return normalizeShelfMetadata(normalized);
}

function normalizeShelfToken(value: string): string {
    return value.replace(UUID_TOKEN, "<SHELF-ID>").replace(COMPACT_UUID_TOKEN, "<SHELF-ID>");
}

function digestText(value: string): string {
    return createHash("sha256").update(Buffer.from(value, "utf8")).digest("hex");
}

function normalizeGitDirStateVariance(
    section: WorkspaceSnapshot["workspace"]["gitDirState"],
): WorkspaceSnapshot["workspace"]["gitDirState"] {
    if (section.status !== "captured") return section;
    const data = Object.fromEntries(
        Object.entries(section.data).map(([root, entries]) => [
            root,
            entries.map((entry) => {
                const relativePath = normalizeShelfToken(entry.relativePath);
                const text = entry.text === null ? null : normalizeShelfToken(entry.text);
                return {
                    ...entry,
                    relativePath,
                    text,
                    digest:
                        relativePath === "index"
                            ? "<INDEX-STAT-CACHE>"
                            : text !== entry.text && text !== null
                              ? digestText(text)
                              : entry.digest,
                };
            }),
        ]),
    );
    return { status: "captured", data };
}

function normalizeWorktreePathVariance(
    section: WorkspaceSnapshot["workspace"]["worktrees"],
): WorkspaceSnapshot["workspace"]["worktrees"] {
    if (section.status !== "captured") return section;
    const normalizePath = (value: string): string =>
        value
            .replaceAll("/private<ROOT>", "<ROOT>")
            .replaceAll("/private<ORIGIN>", "<ORIGIN>")
            .replaceAll("/private<PROFILE>", "<PROFILE>");
    return {
        status: "captured",
        data: section.data.map((worktree) => ({
            ...worktree,
            path: normalizePath(worktree.path),
            gitDir: normalizePath(worktree.gitDir),
            locked: worktree.locked === null ? null : normalizePath(worktree.locked),
            prunable: worktree.prunable === null ? null : normalizePath(worktree.prunable),
        })),
    };
}

function normalizeShelfMetadata(value: string): string {
    try {
        const parsed: unknown = JSON.parse(value);
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return value;
        const record = parsed as Record<string, unknown>;
        const metadata = record.metadata;
        if (metadata !== null && typeof metadata === "object" && !Array.isArray(metadata)) {
            (metadata as Record<string, unknown>).createdAt = 0;
        }
        if (typeof record.checksum === "string") {
            record.checksum = digestText(JSON.stringify({ ...record, checksum: "" }));
        }
        return JSON.stringify(record);
    } catch {
        return value;
    }
}
