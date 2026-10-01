/** One source line attributed by Git's porcelain blame format. */
export interface BlameLine {
    readonly commit: string;
    readonly line: number;
    readonly author: string;
    readonly authorTime: number;
    readonly authorTimezone: string;
    readonly summary: string;
}

/** Parses porcelain records, reusing commit metadata without interpreting source text. */
export function parseBlame(output: string): BlameLine[] {
    const result: BlameLine[] = [];
    const commits = new Map<string, BlameLine>();
    let record: BlameLine | undefined;
    for (const raw of output.split("\n")) {
        if (raw.startsWith("\t")) {
            if (!record) throw new Error("Missing Git blame record.");
            result.push(record);
            commits.set(record.commit, record);
            record = undefined;
            continue;
        }
        const header = /^([a-f0-9]{40}|[a-f0-9]{64}) (\d+) (\d+)(?: (\d+))?$/.exec(raw);
        if (header) {
            if (record) throw new Error("Incomplete Git blame record.");
            record = {
                author: "",
                authorTime: 0,
                authorTimezone: "+0000",
                summary: "",
                ...commits.get(header[1]),
                commit: header[1],
                line: Number(header[3]) - 1,
            };
        } else if (record) {
            const separator = raw.indexOf(" ");
            const key = raw.slice(0, separator);
            const value = raw.slice(separator + 1);
            switch (key) {
                case "author":
                    record = { ...record, author: value };
                    break;
                case "author-time":
                    record = { ...record, authorTime: Number(value) };
                    break;
                case "author-tz":
                    record = { ...record, authorTimezone: value };
                    break;
                case "summary":
                    record = { ...record, summary: value };
                    break;
            }
        } else if (raw !== "") {
            throw new Error("Invalid Git blame output.");
        }
    }
    if (record) throw new Error("Incomplete Git blame record.");
    return result;
}

/** Formats the author's calendar date in the commit's recorded timezone. */
export function blameDate(line: BlameLine): string {
    const timezone = /^([+-])(\d{2})(\d{2})$/.exec(line.authorTimezone);
    const minutes = timezone ? Number(timezone[2]) * 60 + Number(timezone[3]) : 0;
    const offset = timezone?.[1] === "-" ? -minutes : minutes;
    const date = new Date((line.authorTime + offset * 60) * 1000);
    return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : "";
}
