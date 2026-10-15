import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import type { PartialChanges } from "../git/partialChanges";
import { PartialChangesUnsupportedError } from "../git/partialSnapshot";
import type { WorkingFile } from "../types";
import { assertContainedParent } from "../shelf/recoveryPaths";
import { assertRepoRelativePath } from "../utils/repoRelativePath";
import { mapWithConcurrency } from "../utils/concurrency";
import { changeFingerprint } from "./parseDiff";
import { rangeSnapshot } from "./rangeMapping";
import { rangeObservation } from "./rangeObservation";
import { ChangelistRevisionError, type ChangelistStore } from "./changelistStore";
import type { ChangelistState, RangeSnapshot } from "../webviews/protocol/changeSelection";

/** Refreshes changed text from host snapshots; cached evidence is invalidated by Git or file bytes. */
export class ChangeRangeTracker {
    private readonly observed = new Map<string, string>();
    private pending = Promise.resolve();
    private directories?: { gitDir: string; commonDir: string };

    /** Both services are bound to the same validated worktree by the workflow host. */
    constructor(
        private readonly root: string,
        private readonly partial: PartialChanges,
        private readonly store: ChangelistStore,
    ) {}

    /** Serialize status observations so an older scan cannot overwrite a newer ownership decision. */
    reconcile(files: readonly WorkingFile[]): Promise<void> {
        const operation = this.pending.then(() => this.refresh(files));
        this.pending = operation.catch(() => undefined);
        return operation;
    }

    /** Absent paths are inspected too: clean content can consume ownership, status absence alone cannot. */
    private async refresh(files: readonly WorkingFile[]): Promise<void> {
        const state = this.store.get(this.root);
        const current = new Map(files.map((file) => [file.path, file]));
        let observation = this.directories
            ? await rangeObservation(this.directories.gitDir, this.directories.commonDir)
            : undefined;
        const attributesChanged = files.some(
            (file) => path.basename(file.path) === ".gitattributes",
        );
        const candidates = new Set(
            files.filter((file) => file.status === "M").map((file) => file.path),
        );
        for (const file of Object.keys(state.changes)) candidates.add(file);
        await mapWithConcurrency([...candidates], 1, async (file) => {
            let capturedContentId: string | undefined;
            try {
                const status = current.get(file);
                if (status && status.status !== "M")
                    throw new Error("Structural change requires review.");
                // Snapshot acquisition revalidates HEAD/index/attributes even if worktree text is unchanged.
                // This early hash only avoids redundant metadata revisions, never a Git safety fence.
                const target = path.join(this.root, assertRepoRelativePath(file));
                await assertContainedParent(this.root, target);
                const stat = await lstat(target);
                if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024)
                    throw new PartialChangesUnsupportedError("Unsupported tracked range content.");
                const hash = changeFingerprint(await readFile(target));
                if (
                    observation &&
                    !attributesChanged &&
                    this.observed.get(file) === `${hash}:${observation}`
                )
                    return;
                const before = this.store.get(this.root);
                const view = await this.partial.open(file);
                const snapshot = this.partial.snapshot(view.snapshotId);
                capturedContentId = snapshot.contentId;
                this.directories = { gitDir: snapshot.gitDir, commonDir: snapshot.commonDir };
                observation ??= await rangeObservation(snapshot.gitDir, snapshot.commonDir);
                await this.track(file, rangeSnapshot(snapshot), before);
                this.observed.set(file, `${hash}:${observation}`);
            } catch (error) {
                this.observed.delete(file);
                if (error instanceof ChangelistRevisionError) {
                    if (this.store.get(this.root).changes[file]?.contentId !== capturedContentId)
                        await this.store.requireReview(this.root, file, true);
                    return;
                }
                await this.store.requireReview(
                    this.root,
                    file,
                    !(error instanceof PartialChangesUnsupportedError),
                );
            }
        });
        for (const file of files) {
            if (file.sourcePath && state.changes[file.sourcePath]) {
                // react-doctor-disable-next-line react-doctor/async-await-in-loop -- Rename review markers are ordered metadata transactions.
                await this.store.requireReview(this.root, file.path, true);
            }
        }
    }

    /** A draft-only race cannot change attribution; retry once only if ownership context is identical. */
    private async track(
        file: string,
        snapshot: RangeSnapshot,
        before: ChangelistState,
    ): Promise<void> {
        try {
            await this.store.track(this.root, file, snapshot, before.revision);
        } catch (error) {
            const latest = this.store.get(this.root);
            if (
                !(error instanceof ChangelistRevisionError) ||
                latest.activeId !== before.activeId ||
                latest.files[file] !== before.files[file] ||
                JSON.stringify(latest.changes[file]) !== JSON.stringify(before.changes[file])
            )
                throw error;
            await this.store.track(this.root, file, snapshot, latest.revision);
        }
    }
}
