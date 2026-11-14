// What a commit-check provider can show or do. Shared by the extension host and the
// React webview, so this file imports neither `vscode` nor Node built-ins. The UI reads
// these flags instead of branching on which provider served the data.

/** Per-provider CI feature declaration, attached to every served detail at read time. */
export interface ProviderCiCapabilities {
    /** Workflow or pipeline grouping exists. */
    readonly runs: boolean;
    /** Jobs under a run. */
    readonly jobs: boolean;
    /** Steps under a job. */
    readonly steps: boolean;
    /** Event, actor, ref and run number. */
    readonly runHeader: boolean;
    /** Per-job log download. */
    readonly logs: boolean;
    /** Provider failure text per job. */
    readonly failureSummary: boolean;
    /** File and line annotations. */
    readonly annotations: boolean;
    /**
     * Re-run the failed jobs of a run. GitLab's pipeline retry, which this maps to there,
     * also restarts canceled jobs; `rerunFailedLabel` names that on the button.
     */
    readonly rerunFailed: boolean;
    /** Re-run one job. */
    readonly rerunJob: boolean;
    /** Cancel a running run. */
    readonly cancel: boolean;
    /** The provider can say which checks are required. */
    readonly requiredChecks: boolean;
    /** The provider marks allowed-to-fail jobs. */
    readonly optionalJobs: boolean;
    /** A previous successful run can be queried. */
    readonly usualDuration: boolean;
    /** The provider lists re-run attempts of a job on one commit. */
    readonly attemptHistory: boolean;
    /** l10n key of the 403 explanation for write actions. */
    readonly writeScopeHelp?: string;
    /** l10n key of the re-run button when the retry restarts more than failed jobs; unset = "Re-run failed". */
    readonly rerunFailedLabel?: string;
}

/**
 * Capabilities with every flag off. A flag turns on only in the phase that implements
 * it, so the UI never shows a control that does nothing.
 */
export const NO_CI_CAPABILITIES: ProviderCiCapabilities = Object.freeze({
    runs: false,
    jobs: false,
    steps: false,
    runHeader: false,
    logs: false,
    failureSummary: false,
    annotations: false,
    rerunFailed: false,
    rerunJob: false,
    cancel: false,
    requiredChecks: false,
    optionalJobs: false,
    usualDuration: false,
    attemptHistory: false,
});
