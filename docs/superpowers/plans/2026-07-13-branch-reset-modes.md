# Branch Reset Modes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the existing commit-menu reset action run `soft`, `mixed`, `hard`, `merge`, or `keep` reset against the selected commit.

**Architecture:** Keep the webview action and protocol unchanged. The extension-host command owns the reset-mode metadata, Quick Pick, modal confirmation, Git invocation, feedback, and refresh. Localization remains CSV-driven.

**Tech Stack:** TypeScript, VS Code Quick Pick/modal APIs, Vitest, Bun, localization CSV importer.

---

## Task 1: Implement the mode-aware reset command

**Files:**
- Modify: `src/commands/commitBasicActions.ts:135-157`
- Modify: `tests/unit/commands/commitBasicActions.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
it.each([["soft", ["reset", "--soft", VALID_HASH]], ["mixed", ["reset", "--mixed", VALID_HASH]], ["hard", ["reset", "--hard", VALID_HASH]], ["merge", ["reset", "--merge", VALID_HASH]], ["keep", ["reset", "--keep", VALID_HASH]]])("runs %s reset", async (mode, expected) => {
    mockQuickPick.mockResolvedValue({ mode });
    mockWarning.mockResolvedValue("Reset");
    await resetCurrentToHere(context);
    expect(executor.run).toHaveBeenCalledWith(expected);
});
```

- [ ] **Step 2: Verify RED**

Run: `bun vitest run tests/unit/commands/commitBasicActions.test.ts`

Expected: FAIL because the current command always runs `--hard` and has no picker.

- [ ] **Step 3: Implement the minimum host-side picker**

```ts
type ResetMode = "soft" | "mixed" | "hard" | "merge" | "keep";
const selected = await vscode.window.showQuickPick(RESET_MODES, { placeHolder: vscode.l10n.t("Choose reset mode") });
if (!selected) return;
await ctx.executor.run(["reset", `--${selected.mode}`, ctx.validatedHash]);
```

Use one modal confirmation after selection. Hard warns about permanently discarding changes; the other modes explain their distinct index/working-tree behavior. Preserve existing error handling and refresh once after a selected mode completes or fails.

- [ ] **Step 4: Add cancellation/failure tests and verify GREEN**

```ts
it("does not invoke Git or refresh when the picker is cancelled", async () => {
    mockQuickPick.mockResolvedValue(undefined);
    await resetCurrentToHere(context);
    expect(executor.run).not.toHaveBeenCalled();
    expect(refreshAll).not.toHaveBeenCalled();
});
```

Run: `bun vitest run tests/unit/commands/commitBasicActions.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/commands/commitBasicActions.ts tests/unit/commands/commitBasicActions.test.ts
git commit -m "feat: add branch reset modes"
```

## Task 2: Localize the picker and reset feedback

**Files:**
- Modify: `docs/localization/localization_translation_review.csv`
- Generate: `l10n/bundle.l10n*.json`
- Test: `tests/unit/localization/manifest.test.ts`

- [ ] **Step 1: Add CSV rows**

Add `Choose reset mode`, five labels, five details, five confirmations, and mode-aware success feedback. Preserve `{short}` in every translated string.

- [ ] **Step 2: Regenerate and validate catalogs**

Run: `bun run l10n:import && bun run l10n:validate && bun scripts/localization-csv.js validate`

Expected: PASS.

- [ ] **Step 3: Run localization test and commit**

Run: `bun vitest run tests/unit/localization/manifest.test.ts`

Expected: PASS.

```bash
git add docs/localization/localization_translation_review.csv l10n tests/unit/localization/manifest.test.ts
git commit -m "feat: localize branch reset modes"
```

## Task 3: Verify integration without protocol expansion

**Files:**
- Verify: `src/commands/commitCommands.ts:81-131`
- Verify: `src/webviews/react/commit-list/commitMenu.tsx:34-102`

- [ ] **Step 1: Keep the existing `resetCurrentToHere` action**

Do not add five webview actions. The host-side picker preserves the existing menu and validated-hash trust boundary.

- [ ] **Step 2: Run integrated validation**

Run: `bun run format:check && bun run lint && bun run architecture:check && bun run typecheck && bun run build && bun run test && bun run l10n:audit`

Expected: commands pass; report unchanged localization-audit candidates separately.

- [ ] **Step 3: Review impact and commit verification adjustments**

Run GitNexus `detect_changes`, `git diff --check`, and `git status --short`. Confirm only reset command/tests, localization source/catalogs, and planning documents changed.
