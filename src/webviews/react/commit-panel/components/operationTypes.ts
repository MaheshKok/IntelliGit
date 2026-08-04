/** Git operations that can temporarily block or alter commit-panel actions. */
export type CommitPanelActiveOperation = "none" | "merge" | "cherry-pick" | "revert" | "rebase";

/** IntelliGit's authority to continue or abort the active interactive rebase. */
export type CommitPanelRebaseControl = "owned" | "unowned" | "foreign";
