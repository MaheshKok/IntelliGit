import type { FrameLocator, Locator } from "@playwright/test";

/** Commit-screen actions for the changed-file list and commit form. */
export class ChangesPanel {
    public constructor(private readonly frame: FrameLocator) {}

    /** Returns the changed-file row anchored by its accessible staging checkbox. */
    public changedFileRow(repositoryPath: string): Locator {
        return this.frame.getByTitle(repositoryPath).first();
    }

    /** Stages the changed path through its accessible checkbox. */
    public async stagePath(repositoryPath: string): Promise<void> {
        await this.frame
            .getByRole("checkbox", { name: repositoryPath, exact: true })
            .first()
            .check();
    }

    /** Enters the commit message in the commit screen's accessible text box. */
    public async typeCommitMessage(message: string): Promise<void> {
        await this.frame
            .getByRole("textbox", { name: "Commit Message", exact: true })
            .fill(message);
    }

    /** Invokes the commit action for the currently staged paths. */
    public async commit(): Promise<void> {
        await this.frame.getByRole("button", { name: "Commit", exact: true }).click();
    }
}
