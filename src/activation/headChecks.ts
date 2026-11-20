// Wires the HEAD CI monitor (status bar item and settle notification) into repository mode.

import * as path from "path";
import * as vscode from "vscode";
import { isE2eControlChannelActive } from "../e2e/activationState";
import type { GitExecutor } from "../git/executor";
import type { GitOps } from "../git/operations";
import type { CiActionFenceStore } from "../services/commitChecks/ciActionFence";
import type { CiGenerations } from "../services/commitChecks/ciGenerations";
import type { CiTrace } from "../services/commitChecks/ciTrace";
import {
    HeadCiStatus,
    readHeadStatusSettings,
    REFRESH_HEAD_CHECKS_COMMAND,
    SHOW_HEAD_CHECKS_COMMAND,
    TOAST_CLAIMS_FOLDER,
} from "../services/commitChecks/headStatus";
import type { CommitChecksRequestGateRegistry } from "../services/commitChecks/requestGate";
import { normalizeCommitChecksSettings } from "../services/commitChecks/settingsConfig";
import type { CommitGraphViewProvider } from "../views/CommitGraphViewProvider";
import { answerCiLogMessage } from "../views/ciLogHandler";

/** What the HEAD monitor needs from repository mode. */
export interface HeadChecksOptions {
    context: vscode.ExtensionContext;
    commitGraph: CommitGraphViewProvider;
    gitOps: GitOps;
    executor: GitExecutor;
    repoRoot: () => string;
    generations: CiGenerations;
    requestGates: CommitChecksRequestGateRegistry;
    fences: CiActionFenceStore | undefined;
    trace: CiTrace;
}

/**
 * Registers both HEAD commands (always: the e2e inventories list them) and, when the
 * extension has workspace and global storage, the monitor with its focus and settings
 * listeners.
 *
 * @returns The monitor, or undefined when storage is missing (activation test contexts).
 */
export function registerHeadChecks(options: HeadChecksOptions): HeadCiStatus | undefined {
    const { context, commitGraph, executor, gitOps, repoRoot } = options;
    const storage = context.globalStorageUri?.fsPath;
    const source = commitGraph.ciDetailSource(repoRoot);
    const checks = commitGraph.headChecksSource();
    const monitor =
        context.workspaceState && storage
            ? new HeadCiStatus({
                  switchOn: isE2eControlChannelActive,
                  enabled: () =>
                      normalizeCommitChecksSettings(
                          vscode.workspace.getConfiguration("intelligit").get("commitChecks"),
                      ).enabled,
                  settings: () =>
                      readHeadStatusSettings(vscode.workspace.getConfiguration("intelligit")),
                  repoKey: repoRoot,
                  headHash: async () => {
                      try {
                          return (
                              (await executor.run(["rev-parse", "--verify", "HEAD"])).trim() ||
                              undefined
                          );
                      } catch {
                          // An empty repository has no HEAD commit.
                          return undefined;
                      }
                  },
                  isUnpushed: async (hash) =>
                      (await gitOps.getUnpushedCommitHashes()).includes(hash),
                  capabilities: (hash) => checks.capabilities(hash),
                  snapshot: (hash, fetch) => checks.getChecks(hash, fetch),
                  detail: (hash, fetch, ctx) => checks.getDetail(hash, fetch, ctx),
                  invalidateDetail: (hash) => checks.invalidateDetail(hash),
                  // Any bucket's cooldown pauses the monitor: in a workspace whose repositories
                  // use different forges, another forge's cooldown also pauses it. Key the read
                  // by HEAD's provider and API origin if that ever matters.
                  cooldownUntil: () => options.requestGates.latestCooldownEnd(),
                  isFenced: (hash) => options.fences?.isFenced(hash) ?? false,
                  generations: options.generations,
                  workspaceState: context.workspaceState,
                  claimDir: path.join(storage, TOAST_CLAIMS_FOLDER),
                  focused: () => vscode.window.state.focused,
                  createStatusBarItem: () =>
                      vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left),
                  showInformationMessage: (message, ...buttons) =>
                      vscode.window.showInformationMessage(message, ...buttons),
                  openChecks: async (hash) => {
                      await vscode.commands.executeCommand("intelligit.showGitLog");
                      commitGraph.openChecksTab(hash);
                  },
                  openLog: (hash, run, job) =>
                      answerCiLogMessage(
                          source,
                          {
                              type: "openCiLog",
                              requestId: 0,
                              repoKey: repoRoot(),
                              hash,
                              runId: run.id,
                              jobId: job.id,
                              attempt: job.attempt ?? run.attempt,
                          },
                          (reply) => {
                              if (reply.outcome === "failed" && reply.message) {
                                  void vscode.window.showErrorMessage(reply.message);
                              }
                          },
                      ),
                  rerunFailed: async (hash, runIds, ctx) => {
                      const actions = source.actions;
                      if (!actions) return;
                      for (const runId of runIds) {
                          const result = await actions.run(
                              hash,
                              { action: "rerunFailed", runId },
                              ctx,
                              repoRoot,
                          );
                          if (result.outcome === "failed" || result.outcome === "signedOut") {
                              void vscode.window.showErrorMessage(result.message);
                          } else if (result.outcome === "forbidden") {
                              void vscode.window.showErrorMessage(
                                  vscode.l10n.t("Your sign-in cannot re-run this CI run."),
                              );
                          }
                      }
                      // The new fence keeps HEAD polling until the re-run finishes.
                      await monitor?.restart();
                  },
                  trace: options.trace,
              })
            : undefined;
    context.subscriptions.push(
        vscode.commands.registerCommand(SHOW_HEAD_CHECKS_COMMAND, () => monitor?.showHeadChecks()),
        vscode.commands.registerCommand(REFRESH_HEAD_CHECKS_COMMAND, () => monitor?.refresh()),
    );
    if (monitor) {
        context.subscriptions.push(
            monitor,
            vscode.window.onDidChangeWindowState((state) => {
                if (state.focused) void monitor.onWindowFocused();
            }),
            vscode.workspace.onDidChangeConfiguration((event) => {
                if (event.affectsConfiguration("intelligit.commitChecks")) void monitor.restart();
            }),
        );
    }
    return monitor;
}
