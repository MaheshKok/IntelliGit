import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PartialChanges } from "../../../src/git/partialChanges";
import { ShelfService } from "../../../src/services/shelfService";
import type { SelectedShelfInput } from "../../../src/services/shelfSelectedCapture";
import { RepositoryMutationGate } from "../../../src/git/repositoryMutationGate";
import { RepositoryMutationCoordinator } from "../../../src/git/mutationCoordinator";
import { RepositoryLock } from "../../../src/git/repositoryLock";
import { rangeSnapshot } from "../../../src/changes/rangeMapping";
import { connectedChangelists } from "../../helpers/connectedChangelists";
import { cleanTemporaryRepositories, createShelfFixture, git } from "./shelfTestHarness";

afterEach(cleanTemporaryRepositories);
const base = Array.from({ length: 30 }, (_, i) => `line ${i}\n`).join("");
const remaining = base.replace("line 24\n", "other owner\n");
const working = remaining.replace("line 4\n", "selected owner\n");

/** Two captured list paths share one immutable index containing unrelated staged and working edits. */
async function fixture() {
    const f = await createShelfFixture({
        initialFiles: { "first.txt": base, "second.txt": base, "unrelated.txt": "base\n" },
    });
    await writeFile(path.join(f.root, "unrelated.txt"), "staged\n");
    await git(f.root, ["add", "unrelated.txt"]);
    await writeFile(path.join(f.root, "unrelated.txt"), "working\n");
    const changelists = await connectedChangelists(f.root);
    await changelists.create(f.root, changelists.get(f.root).revision, "Other");
    const other = changelists.get(f.root).lists[1].id;
    const partial = new PartialChanges(f.executor, f.root);
    const selected: SelectedShelfInput["selected"][number][] = [];
    for (const file of ["first.txt", "second.txt"]) {
        await writeFile(path.join(f.root, file), working);
        const view = await partial.open(file);
        const snapshot = partial.snapshot(view.snapshotId);
        await changelists.track(f.root, file, rangeSnapshot(snapshot));
        const lines = view.blocks
            .flatMap((block) => block.lines)
            .filter((line) => line.kind !== "context");
        const selectedLines = lines.filter(
            (line) => line.text.trimEnd() === "line 4" || line.text.trimEnd() === "selected owner",
        );
        const kept = lines.filter((line) => !selectedLines.includes(line));
        await changelists.assignChanges(
            f.root,
            changelists.get(f.root).revision,
            file,
            snapshot.contentId,
            other,
            kept.map((line) => line.fingerprint),
            new Set(lines.map((line) => line.fingerprint)),
        );
        const lineIds = selectedLines.map((line) => line.id);
        selected.push({
            snapshot,
            lineIds,
            patch: await partial.exportPatch(
                { snapshotId: view.snapshotId, lineIds },
                () => undefined,
            ),
            owners: Object.fromEntries(selectedLines.map((line) => [line.fingerprint, "default"])),
        });
    }
    const state = changelists.get(f.root);
    const plan: SelectedShelfInput = {
        name: "Selected list",
        baseCommit: selected[0].snapshot.head,
        scope: "list",
        scopeDraft: "",
        sourceLists: state.lists
            .filter((list) => list.id === "default")
            .map((list) => ({
                ...list,
                description: list.description ?? "",
                draft: list.draft ?? "",
            })),
        selected,
        whole: [],
    };
    const service = new ShelfService({
        repositoryRoot: f.root,
        executor: f.executor,
        store: f.store,
        changelists,
        gate: new RepositoryMutationGate(new RepositoryMutationCoordinator(), new RepositoryLock()),
    });
    return { ...f, service, changelists, partial, plan, revision: state.revision };
}

/** Captures both index and working layers of one mixed-owner file, with another mixed file untouched. */
async function wholeFixture() {
    const f = await fixture();
    await git(f.root, ["add", "first.txt"]);
    await writeFile(path.join(f.root, "first.txt"), working + "working layer\n");
    const view = await f.partial.open("first.txt");
    const snapshot = f.partial.snapshot(view.snapshotId);
    await f.changelists.track(f.root, "first.txt", rangeSnapshot(snapshot));
    const state = f.changelists.get(f.root);
    const owners = Object.fromEntries(
        view.blocks
            .flatMap((block) => block.lines)
            .filter((line) => line.kind !== "context")
            .map((line) => [
                line.fingerprint,
                state.changes["first.txt"].lines[line.fingerprint] ?? "default",
            ]),
    );
    const plan: SelectedShelfInput = {
        ...f.plan,
        scope: "files",
        sourceLists: state.lists.map((list) => ({
            ...list,
            description: list.description ?? "",
            draft: list.draft ?? "",
        })),
        selected: [],
        whole: [
            {
                path: "first.txt",
                sourceListIds: [...new Set(Object.values(owners))],
                ownership: { snapshot, owners },
            },
        ],
    };
    return { ...f, plan, revision: state.revision };
}

describe("scoped whole-file removal", () => {
    it("removes saved whole-file index and working layers without recapture or touching other files", async () => {
        const f = await wholeFixture();
        let lease = await f.changelists.acquireTargetOperationLease(f.root);
        const saved = await f.service.saveSelectedChanges(
            f.plan,
            lease,
            f.revision,
            "default",
            () => undefined,
        );
        await lease.release();
        const publish = vi.spyOn(f.store, "writeShelfGeneration");
        const legacy = vi.spyOn(f.service, "shelve");
        const unrelatedIndex = await git(f.root, ["show", ":unrelated.txt"]);
        lease = await f.changelists.acquireTargetOperationLease(f.root);
        try {
            const result = await f.service.removeScopedChanges(
                f.plan,
                saved.shelfId!,
                f.partial,
                lease,
                f.revision,
                "default",
                () => undefined,
            );
            expect(result).toMatchObject({
                shelfId: saved.shelfId,
                completedPaths: ["first.txt"],
                retainedPaths: [],
            });
            expect(result.error).toBeUndefined();
        } finally {
            await lease.release();
        }
        expect(await readFile(path.join(f.root, "first.txt"), "utf8")).toBe(base);
        expect(await git(f.root, ["show", ":first.txt"])).toEqual(Buffer.from(base));
        expect(await readFile(path.join(f.root, "second.txt"), "utf8")).toBe(working);
        expect(await readFile(path.join(f.root, "unrelated.txt"), "utf8")).toBe("working\n");
        expect(await git(f.root, ["show", ":unrelated.txt"])).toEqual(unrelatedIndex);
        expect(publish, "Removal must not recapture a second shelf").not.toHaveBeenCalled();
        expect(legacy).not.toHaveBeenCalled();
        expect(await f.store.readCurrentShelfManifest(saved.shelfId!)).toMatchObject({
            generation: 1,
        });
    });

    it("refuses whole-file source edits after Save and preserves the saved identity", async () => {
        const f = await wholeFixture();
        let lease = await f.changelists.acquireTargetOperationLease(f.root);
        const saved = await f.service.saveSelectedChanges(
            f.plan,
            lease,
            f.revision,
            "default",
            () => undefined,
        );
        await lease.release();
        await writeFile(path.join(f.root, "first.txt"), "external after preview\n");
        const index = await readFile(path.join(f.root, ".git/index"));
        lease = await f.changelists.acquireTargetOperationLease(f.root);
        try {
            await expect(
                f.service.removeScopedChanges(
                    f.plan,
                    saved.shelfId!,
                    f.partial,
                    lease,
                    f.revision,
                    "default",
                    () => undefined,
                ),
            ).rejects.toThrow("source changed");
        } finally {
            await lease.release();
        }
        expect(await readFile(path.join(f.root, "first.txt"), "utf8")).toBe(
            "external after preview\n",
        );
        expect(await readFile(path.join(f.root, ".git/index"))).toEqual(index);
        expect(await f.store.readCurrentShelfManifest(saved.shelfId!)).toMatchObject({
            generation: 1,
        });
    });
});

describe("scoped list removal", () => {
    it("refuses changed captured line IDs after Save before removing uncaptured content", async () => {
        const f = await fixture();
        let lease = await f.changelists.acquireTargetOperationLease(f.root);
        const saved = await f.service.saveSelectedChanges(
            f.plan,
            lease,
            f.revision,
            "default",
            () => undefined,
        );
        await lease.release();
        const entry = f.plan.selected[0];
        (entry.lineIds as string[]).push(
            ...entry.snapshot.view.blocks
                .flatMap((block) => block.lines)
                .filter((line) => line.kind !== "context" && !entry.lineIds.includes(line.id))
                .map((line) => line.id),
        );
        lease = await f.changelists.acquireTargetOperationLease(f.root);
        try {
            await expect(
                f.service.removeScopedChanges(
                    f.plan,
                    saved.shelfId!,
                    f.partial,
                    lease,
                    f.revision,
                    "default",
                    () => undefined,
                ),
                "Saved identity must not authorize mutated removal intent",
            ).rejects.toThrow("captured removal plan changed");
        } finally {
            await lease.release();
        }
        expect(await readFile(path.join(f.root, "first.txt"), "utf8")).toBe(working);
    });

    it("refuses removal before durable Save", async () => {
        const f = await fixture();
        const lease = await f.changelists.acquireTargetOperationLease(f.root);
        try {
            await expect(
                f.service.removeScopedChanges(
                    f.plan,
                    "unsaved",
                    f.partial,
                    lease,
                    f.revision,
                    "default",
                    () => undefined,
                ),
                "Removal requires the durably saved identity",
            ).rejects.toThrow("saved removal plan");
        } finally {
            await lease.release();
        }
        expect(await readFile(path.join(f.root, "first.txt"), "utf8")).toBe(working);
    });

    it.each(["source edit", "ownership revision"])(
        "refuses stale %s before removing any captured path",
        async (fault) => {
            const f = await fixture();
            let lease = await f.changelists.acquireTargetOperationLease(f.root);
            const saved = await f.service.saveSelectedChanges(
                f.plan,
                lease,
                f.revision,
                "default",
                () => undefined,
            );
            await lease.release();
            if (fault === "source edit")
                await writeFile(path.join(f.root, "second.txt"), working + "external\n");
            else await f.changelists.saveDraft(f.root, "default", "", "Changed after preview");
            lease = await f.changelists.acquireTargetOperationLease(f.root);
            const remove = vi.spyOn(f.partial, "rollbackCaptured");
            try {
                await expect(
                    f.service.removeScopedChanges(
                        f.plan,
                        saved.shelfId!,
                        f.partial,
                        lease,
                        f.revision,
                        "default",
                        () => undefined,
                    ),
                    "Stale captured plans must refuse before first removal",
                ).rejects.toThrow();
                expect(
                    remove,
                    "No path may be removed when a later snapshot was already stale",
                ).not.toHaveBeenCalled();
            } finally {
                await lease.release();
            }
            expect(await readFile(path.join(f.root, "first.txt"), "utf8")).toBe(working);
            expect(await readFile(path.join(f.root, "second.txt"), "utf8")).toBe(
                fault === "source edit" ? working + "external\n" : working,
            );
            expect(await f.store.readCurrentShelfManifest(saved.shelfId!)).toMatchObject({
                generation: 1,
            });
        },
    );

    it("reports completed and retained paths when the later path changes during removal and forbids replay", async () => {
        const f = await fixture();
        let lease = await f.changelists.acquireTargetOperationLease(f.root);
        const saved = await f.service.saveSelectedChanges(
            f.plan,
            lease,
            f.revision,
            "default",
            () => undefined,
        );
        await lease.release();
        const original = f.partial.rollbackCaptured.bind(f.partial);
        vi.spyOn(f.partial, "rollbackCaptured").mockImplementation(async (...args) => {
            if (args[0].view.path === "second.txt")
                await writeFile(path.join(f.root, "second.txt"), working + "external\n");
            return original(...args);
        });
        const index = await readFile(path.join(f.root, ".git/index"));
        lease = await f.changelists.acquireTargetOperationLease(f.root);
        try {
            const result = await f.service.removeScopedChanges(
                f.plan,
                saved.shelfId!,
                f.partial,
                lease,
                f.revision,
                "default",
                () => undefined,
            );
            expect(result).toMatchObject({
                completedPaths: ["first.txt"],
                retainedPaths: ["second.txt"],
            });
            expect(result.error).toBeTruthy();
            await expect(
                f.service.removeScopedChanges(
                    f.plan,
                    saved.shelfId!,
                    f.partial,
                    lease,
                    f.revision,
                    "default",
                    () => undefined,
                ),
            ).rejects.toThrow("already attempted");
        } finally {
            await lease.release();
        }
        expect(await readFile(path.join(f.root, "first.txt"), "utf8")).toBe(remaining);
        expect(await readFile(path.join(f.root, "second.txt"), "utf8")).toBe(
            working + "external\n",
        );
        expect(await readFile(path.join(f.root, ".git/index"))).toEqual(index);
        expect(await f.store.readCurrentShelfManifest(saved.shelfId!)).toMatchObject({
            generation: 1,
        });
    });

    it("durably saves once then removes both captured paths preserving other owners and exact index bytes", async () => {
        const f = await fixture();
        const index = await readFile(path.join(f.root, ".git/index"));
        let lease = await f.changelists.acquireTargetOperationLease(f.root);
        const saved = await f.service.saveSelectedChanges(
            f.plan,
            lease,
            f.revision,
            "default",
            () => undefined,
        );
        await lease.release();
        expect(
            await readFile(path.join(f.root, "first.txt"), "utf8"),
            "Save must not remove before confirmation",
        ).toBe(working);
        expect(await f.store.readCurrentShelfManifest(saved.shelfId!)).toMatchObject({
            generation: 1,
        });
        lease = await f.changelists.acquireTargetOperationLease(f.root);
        try {
            const result = await f.service.removeScopedChanges(
                f.plan,
                saved.shelfId!,
                f.partial,
                lease,
                f.revision,
                "default",
                () => undefined,
            );
            expect(result.completedPaths).toEqual(["first.txt", "second.txt"]);
        } finally {
            await lease.release();
        }
        for (const file of ["first.txt", "second.txt"])
            expect(
                await readFile(path.join(f.root, file), "utf8"),
                "Non-selected owner's bytes must survive both removals",
            ).toBe(remaining);
        expect(
            await readFile(path.join(f.root, ".git/index")),
            "Unrelated staged index bytes must survive",
        ).toEqual(index);
        expect(await readFile(path.join(f.root, "unrelated.txt"), "utf8")).toBe("working\n");
        expect(await f.store.readCurrentShelfManifest(saved.shelfId!)).toMatchObject({
            generation: 1,
        });
    });

    it("refuses a partial selection of a file absent from HEAD before any removal can start", async () => {
        const f = await createShelfFixture({ initialFiles: { "first.txt": base } });
        const added = path.join(f.root, "added.txt");
        await writeFile(added, "staged line\n");
        await git(f.root, ["add", "added.txt"]);
        await writeFile(added, "staged line\nselected line\nkept line\n");
        const index = await readFile(path.join(f.root, ".git/index"));
        // Worktree removal reaches recovery only via a partial snapshot, which needs a HEAD blob.
        await expect(new PartialChanges(f.executor, f.root).open("added.txt")).rejects.toThrow(
            "Added, deleted, renamed and mode-changing files require whole-file handling.",
        );
        expect(await readFile(added, "utf8")).toBe("staged line\nselected line\nkept line\n");
        expect(await readFile(path.join(f.root, ".git/index"))).toEqual(index);
    });
});
