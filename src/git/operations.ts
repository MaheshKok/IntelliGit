import { GitExecutor } from './executor';
import type { Branch, Commit, CommitDetail, CommitFile } from '../types';

const FIELD_SEP = '<<|>>';
const RECORD_SEP = '<<||>>';

export class GitOps {
    constructor(private readonly executor: GitExecutor) {}

    async isRepository(): Promise<boolean> {
        try {
            await this.executor.run(['rev-parse', '--is-inside-work-tree']);
            return true;
        } catch {
            return false;
        }
    }

    async getBranches(): Promise<Branch[]> {
        const format = '%(refname)\t%(refname:short)\t%(objectname:short)\t%(upstream:track,nobracket)\t%(HEAD)';
        const result = await this.executor.run(['branch', '-a', `--format=${format}`]);

        const branches: Branch[] = [];
        for (const line of result.trim().split('\n')) {
            if (!line.trim()) continue;
            const [refname, name, hash, track, head] = line.split('\t');

            const isRemote = refname.startsWith('refs/remotes/');
            let remote: string | undefined;
            if (isRemote) {
                // refname:short for remote is "origin/main", first segment is the remote name
                remote = name.split('/')[0];
            }

            let ahead = 0, behind = 0;
            if (track) {
                const a = track.match(/ahead (\d+)/);
                const b = track.match(/behind (\d+)/);
                if (a) ahead = parseInt(a[1]);
                if (b) behind = parseInt(b[1]);
            }

            branches.push({ name, hash, isRemote, isCurrent: head === '*', remote, ahead, behind });
        }
        return branches;
    }

    async getLog(maxCount: number = 500, branch?: string, filterText?: string): Promise<Commit[]> {
        const format = [
            '%H', '%h', '%s', '%an', '%ae', '%aI', '%P', '%D',
        ].join(FIELD_SEP) + RECORD_SEP;

        const args = ['log', `--max-count=${maxCount}`, `--pretty=format:${format}`];

        if (branch) {
            args.push(branch);
        } else {
            args.push('--all');
        }

        if (filterText) {
            args.push(`--grep=${filterText}`, '-i');
        }

        const result = await this.executor.run(args);
        const commits: Commit[] = [];

        for (const record of result.split(RECORD_SEP)) {
            const trimmed = record.trim();
            if (!trimmed) continue;

            const parts = trimmed.split(FIELD_SEP);
            if (parts.length < 7) continue;

            commits.push({
                hash: parts[0],
                shortHash: parts[1],
                message: parts[2],
                author: parts[3],
                email: parts[4],
                date: parts[5],
                parentHashes: parts[6] ? parts[6].split(' ').filter(Boolean) : [],
                refs: parts[7] ? parts[7].split(',').map(r => r.trim()).filter(Boolean) : [],
            });
        }
        return commits;
    }

    async getCommitDetail(hash: string): Promise<CommitDetail> {
        const format = [
            '%H', '%h', '%s', '%b', '%an', '%ae', '%aI', '%P', '%D',
        ].join(FIELD_SEP);

        const info = await this.executor.run(['show', `--format=${format}`, '--no-patch', hash]);
        const parts = info.trim().split(FIELD_SEP);

        const nameStatus = await this.executor.run([
            'diff-tree', '--no-commit-id', '-r', '--name-status', hash,
        ]);

        const files: CommitFile[] = [];
        for (const line of nameStatus.trim().split('\n')) {
            if (!line.trim()) continue;
            const cols = line.split('\t');
            if (cols.length >= 2) {
                files.push({
                    path: cols[cols.length - 1],
                    status: cols[0].charAt(0) as CommitFile['status'],
                    additions: 0,
                    deletions: 0,
                });
            }
        }

        try {
            const numstat = await this.executor.run([
                'diff-tree', '--no-commit-id', '-r', '--numstat', hash,
            ]);
            for (const line of numstat.trim().split('\n')) {
                if (!line.trim()) continue;
                const [add, del, filePath] = line.split('\t');
                const file = files.find(f => f.path === filePath);
                if (file) {
                    file.additions = add === '-' ? 0 : parseInt(add);
                    file.deletions = del === '-' ? 0 : parseInt(del);
                }
            }
        } catch { /* numstat may fail for binary files */ }

        return {
            hash: parts[0] || hash,
            shortHash: parts[1] || hash.slice(0, 7),
            message: parts[2] || '',
            body: parts[3] || '',
            author: parts[4] || '',
            email: parts[5] || '',
            date: parts[6] || '',
            parentHashes: parts[7] ? parts[7].split(' ').filter(Boolean) : [],
            refs: parts[8] ? parts[8].split(',').map(r => r.trim()).filter(Boolean) : [],
            files,
        };
    }
}
