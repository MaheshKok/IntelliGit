/** The repo-relative location of the environment artifact paired with pixel baselines. */
export const BASELINE_ENVIRONMENT_FILE = "tests/visual/fixtures/baselineEnvironment.json";

/** The renderer inputs that must agree before a pixel baseline can be trusted. */
export interface VisualEnvironment {
    readonly baseImage: string;
    readonly browserVersion: string;
    readonly platform: string;
    readonly osRelease: string;
    readonly fonts: readonly string[];
}

/** One environment field whose committed and observed values do not agree. */
export interface EnvironmentDifference {
    readonly field: keyof VisualEnvironment;
    readonly committed: string;
    readonly observed: string;
}

type ScalarEnvironmentField = Exclude<keyof VisualEnvironment, "fonts">;
type EnvironmentValue = VisualEnvironment[keyof VisualEnvironment];
type EnvironmentFieldDescriptor = {
    readonly field: keyof VisualEnvironment;
    readonly compared: boolean;
    readonly normalize: (value: EnvironmentValue) => EnvironmentValue;
    readonly difference: (
        committed: VisualEnvironment,
        observed: VisualEnvironment,
    ) => EnvironmentDifference | undefined;
};

function scalarDifference(field: ScalarEnvironmentField) {
    return (
        committed: VisualEnvironment,
        observed: VisualEnvironment,
    ): EnvironmentDifference | undefined => {
        const committedValue = committed[field];
        const observedValue = observed[field];
        if (committedValue === observedValue) return undefined;
        return { field, committed: committedValue, observed: observedValue };
    };
}

function previewFamilies(families: readonly string[]): string {
    if (families.length === 0) return "none";
    const preview = families.slice(0, 3).join(", ");
    return families.length > 3 ? `${preview}, ...` : preview;
}

function fontDifference(
    committed: VisualEnvironment,
    observed: VisualEnvironment,
): EnvironmentDifference | undefined {
    const committedFonts = new Set(committed.fonts);
    const observedFonts = new Set(observed.fonts);
    const removed = committed.fonts.filter((font) => !observedFonts.has(font));
    const added = observed.fonts.filter((font) => !committedFonts.has(font));
    if (removed.length === 0 && added.length === 0) return undefined;

    const changeSummary =
        `removed ${removed.length}: ${previewFamilies(removed)}; ` +
        `added ${added.length}: ${previewFamilies(added)}`;
    const summary = (families: readonly string[], includeChangeSummary: boolean): string =>
        `${families.length} families; ` +
        (includeChangeSummary ? `${changeSummary}; ` : "") +
        `sample ${previewFamilies(families)}`;

    return {
        field: "fonts",
        committed: summary(committed.fonts, true),
        observed: summary(observed.fonts, false),
    };
}

/**
 * The ordered field table is the single source of truth for environment normalization and comparison;
 * runtime assertions in the unit tests enforce that captured fields and comparison policy stay aligned.
 */
export const VISUAL_ENVIRONMENT_FIELDS = [
    {
        field: "baseImage",
        // This value is a self-reported claim; provenance checks tie it to the reviewed pin.
        compared: true,
        normalize: (value) => value,
        difference: scalarDifference("baseImage"),
    },
    {
        field: "browserVersion",
        compared: true,
        normalize: (value) => value,
        difference: scalarDifference("browserVersion"),
    },
    {
        field: "platform",
        compared: true,
        normalize: (value) => value,
        difference: scalarDifference("platform"),
    },
    {
        field: "osRelease",
        // The host kernel is shared with the container and varies between Docker hosts.
        compared: false,
        normalize: (value) => value,
        difference: scalarDifference("osRelease"),
    },
    {
        field: "fonts",
        compared: true,
        normalize: (value) => (typeof value === "string" ? value : [...new Set(value)].sort()),
        difference: fontDifference,
    },
] as const satisfies readonly EnvironmentFieldDescriptor[];

/** The scalar artifact fields, derived from the canonical environment field table. */
export const VISUAL_ENVIRONMENT_SCALAR_FIELDS = VISUAL_ENVIRONMENT_FIELDS.filter(
    ({ field }) => field !== "fonts",
).map(({ field }) => field);

type MissingEnvironmentField = Exclude<
    keyof VisualEnvironment,
    (typeof VISUAL_ENVIRONMENT_FIELDS)[number]["field"]
>;
const environmentFieldCoverage: MissingEnvironmentField extends never ? true : never = true;
void environmentFieldCoverage;

/** Returns a new environment with a sorted, deduplicated font manifest. */
export function normalizeEnvironment(raw: VisualEnvironment): VisualEnvironment {
    const knownFields = VISUAL_ENVIRONMENT_FIELDS.map(({ field }) => field);
    const unknownFields = Object.keys(raw).filter(
        (field) => !knownFields.includes(field as keyof VisualEnvironment),
    );
    if (unknownFields.length > 0) {
        throw new Error(
            `visual environment received unknown field(s): ${unknownFields.sort().join(", ")}. ` +
                `Known fields: ${knownFields.join(", ")}.`,
        );
    }

    const normalized = {} as Record<keyof VisualEnvironment, EnvironmentValue>;
    for (const descriptor of VISUAL_ENVIRONMENT_FIELDS) {
        normalized[descriptor.field] = descriptor.normalize(raw[descriptor.field]);
    }
    return normalized as VisualEnvironment;
}

/** Compares all renderer inputs in declaration order and summarizes font-set changes compactly. */
export function diffEnvironment(
    committed: VisualEnvironment,
    observed: VisualEnvironment,
): readonly EnvironmentDifference[] {
    const normalizedCommitted = normalizeEnvironment(committed);
    const normalizedObserved = normalizeEnvironment(observed);
    return VISUAL_ENVIRONMENT_FIELDS.flatMap(({ compared, difference }) => {
        if (!compared) return [];
        const environmentDifference = difference(normalizedCommitted, normalizedObserved);
        return environmentDifference === undefined ? [] : [environmentDifference];
    });
}

const REGENERATION_COMMAND =
    "./tests/e2e/docker/run.sh 'bun install --frozen-lockfile && bun run build && " +
    "UPDATE_VISUAL_BASELINE=1 npx playwright test --config playwright.visual.config.ts --workers=1'";

/** Explains environment drift and gives the exact pinned-container regeneration command. */
export function describeEnvironmentDrift(differences: readonly EnvironmentDifference[]): string {
    const lines = ["Visual environment drift detected:"];
    for (const difference of differences) {
        lines.push(
            `- ${difference.field}: committed ${difference.committed}; observed ${difference.observed}`,
        );
    }
    lines.push("Regenerate the visual baseline environment in the pinned container:");
    lines.push(REGENERATION_COMMAND);
    return lines.join("\n");
}
