// Acceptance test: the merge parser must group changes the way PyCharm's
// merge editor does. The fixture reproduces the config-loader scenario used
// to diagnose the old algorithm (which fragmented one logical change into
// many conflicts anchored on braces and blank lines).
import { describe, expect, it } from "vitest";

import {
    parseConflictVersions,
    type ConflictSegment,
    type MergeSegment,
} from "../../../src/mergeEditor/conflictParser";

const base = `loadFromFile(): AppConfig {
  if (!fs.existsSync(this.configPath)) {
    throw new Error(\`Config file not found: \${this.configPath}\`);
  }

  const raw = fs.readFileSync(this.configPath, "utf-8");
  const parsed = JSON.parse(raw) as Partial<AppConfig>;

  this.config = {
    ...this.config,
    ...parsed,
    database: {
      ...this.config.database,
      ...(parsed.database ?? {}),
    },
  };

  return this.config;
}

loadFromEnv(): void {
  const envPort = process.env[\`\${ENV_PREFIX}PORT\`];
  if (envPort) {
    this.config.port = parseInt(envPort, 10);
  }
}
`;

const ours = `loadFromFile(): AppConfig {
  if (!fs.existsSync(this.configPath)) {
    console.warn(\`Config file not found, using defaults\`);
    return this.config;
  }

  const raw = fs.readFileSync(this.configPath, "utf-8");
  const parsed = yaml.parse(raw) as Partial<AppConfig>;

  this.config = this.mergeConfig(this.config, parsed);
  return this.config;
}

private mergeConfig(base: AppConfig, override: Partial<AppConfig>): AppConfig {
  return {
    ...base,
    ...override,
    database: {
      ...base.database,
      ...(override.database ?? {}),
    },
    features: {
      ...base.features,
      ...(override.features ?? {}),
    },
  };
}

loadFromEnv(): void {
  const envPort = process.env[\`\${ENV_PREFIX}PORT\`];
  if (envPort) {
    this.config.port = parseInt(envPort, 10);
  }
}
`;

const theirs = `loadFromFile(): AppConfig {
  if (!fs.existsSync(this.configPath)) {
    this.config = this.loadDefaults();
    return this.config;
  }

  const raw = fs.readFileSync(this.configPath, "utf-8");
  const parsed = toml.parse(raw) as Partial<AppConfig>;

  // Deep merge with validation
  const merged: AppConfig = {
    port: parsed.port ?? this.config.port,
    host: parsed.host ?? this.config.host,
    logLevel: parsed.logLevel ?? this.config.logLevel,
    database: {
      url: parsed.database?.url ?? this.config.database.url,
      poolSize: Math.min(parsed.database?.poolSize ?? 10, 100),
      timeout: parsed.database?.timeout ?? this.config.database.timeout,
    },
    features: { ...this.config.features, ...parsed.features },
  };

  this.config = merged;
  return this.config;
}

loadFromEnv(): void {
  const envPort = process.env[\`\${ENV_PREFIX}PORT\`];
  if (envPort) {
    this.config.port = parseInt(envPort, 10);
  }
}
`;

function conflictsOf(segments: MergeSegment[]): ConflictSegment[] {
    return segments.filter((s): s is ConflictSegment => s.type === "conflict");
}

function reconstructSide(segments: MergeSegment[], side: "oursLines" | "theirsLines"): string[] {
    return segments.flatMap((s) => (s.type === "common" ? s.lines : s[side]));
}

describe("PyCharm parity — config loader scenario", () => {
    const segments = parseConflictVersions(base, ours, theirs);
    const conflicts = conflictsOf(segments);

    it("produces exactly four change segments (three conflicts + one ours-only)", () => {
        expect(conflicts.map((c) => c.changeKind)).toEqual([
            "conflict",
            "conflict",
            "conflict",
            "ours-only",
        ]);
    });

    it("trims the shared `return this.config;` insertion out of the first conflict", () => {
        const first = conflicts[0];
        expect(first.baseLines).toEqual([
            "    throw new Error(`Config file not found: ${this.configPath}`);",
        ]);
        expect(first.oursLines).toEqual([
            "    console.warn(`Config file not found, using defaults`);",
        ]);
        expect(first.theirsLines).toEqual(["    this.config = this.loadDefaults();"]);
        // The identical insertion must land in the following common segment.
        const idx = segments.indexOf(first);
        const next = segments[idx + 1];
        expect(next.type).toBe("common");
        expect((next as { lines: string[] }).lines[0]).toBe("    return this.config;");
    });

    it("keeps the parse-line conflict to a single line per side", () => {
        const second = conflicts[1];
        expect(second.baseLines).toEqual(["  const parsed = JSON.parse(raw) as Partial<AppConfig>;"]);
        expect(second.oursLines).toEqual(["  const parsed = yaml.parse(raw) as Partial<AppConfig>;"]);
        expect(second.theirsLines).toEqual([
            "  const parsed = toml.parse(raw) as Partial<AppConfig>;",
        ]);
    });

    it("keeps the config-assignment rewrite as one contiguous conflict", () => {
        const third = conflicts[2];
        // No fragmentation at `database: {`, `},`, or `};` boundaries.
        expect(third.baseLines[0]).toBe("  this.config = {");
        expect(third.baseLines).toContain("    database: {");
        expect(third.baseLines).toContain("  };");
        expect(third.oursLines).toEqual([
            "  this.config = this.mergeConfig(this.config, parsed);",
        ]);
        expect(third.theirsLines[0]).toBe("  // Deep merge with validation");
        expect(third.theirsLines[third.theirsLines.length - 1]).toBe("  this.config = merged;");
    });

    it("emits the new mergeConfig function as a one-sided ours insertion", () => {
        const fourth = conflicts[3];
        expect(fourth.changeKind).toBe("ours-only");
        expect(fourth.baseLines).toEqual([]);
        expect(fourth.theirsLines).toEqual([]);
        expect(fourth.oursLines[0]).toBe(
            "private mergeConfig(base: AppConfig, override: Partial<AppConfig>): AppConfig {",
        );
        expect(fourth.oursLines).toContain("    features: {");
    });

    it("never places a segment boundary that splits the rewritten block on noise lines", () => {
        // Common segments between the conflicts must not consist of lines
        // from inside the rewritten `this.config = { ... }` block.
        for (const seg of segments) {
            if (seg.type !== "common") continue;
            expect(seg.lines).not.toContain("    ...parsed,");
            expect(seg.lines).not.toContain("      ...this.config.database,");
        }
    });

    it("reconstructs both sides losslessly from the segment stream", () => {
        expect(reconstructSide(segments, "oursLines").join("\n") + "\n").toBe(ours);
        expect(reconstructSide(segments, "theirsLines").join("\n") + "\n").toBe(theirs);
    });
});
