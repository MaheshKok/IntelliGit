import simpleGit, { SimpleGit } from 'simple-git';

export class GitExecutor {
    private readonly git: SimpleGit;

    constructor(repoRoot: string) {
        this.git = simpleGit(repoRoot, { maxConcurrentProcesses: 6 });
    }

    async run(args: string[]): Promise<string> {
        return this.git.raw(args);
    }
}
