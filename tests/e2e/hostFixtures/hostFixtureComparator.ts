import type { HostFixture } from "./types";

type ComparableValue = string | number | readonly string[] | Readonly<Record<string, string>>;

/**
 * The complete fixture-field inventory. Every on-disk field must be either compared or explicitly
 * excluded; the unit ratchet checks both sets against a real committed fixture.
 */
export const HOST_FIXTURE_FIELD_INVENTORY = {
    topLevel: {
        compared: ["provenance", "documentElement", "body"],
        excluded: [],
    },
    provenance: {
        compared: [
            "captureSchemaVersion",
            "platform",
            "themeId",
            "themeName",
            "requestedTheme",
            "themeKind",
        ],
        excluded: ["vscodeVersion", "vscodeCommit"],
    },
    // The payload sections are inventoried for the same reason as the rest: a top-level ratchet
    // only sees `provenance`/`documentElement`/`body`, so a NEW sub-field here -- which is where an
    // upstream host change actually lands -- would slip past it while the top-level keys stayed
    // identical.
    documentElement: {
        compared: ["classList", "dataset", "styleCssText"],
        excluded: [],
    },
    body: {
        compared: ["classList", "dataset"],
        excluded: [],
    },
} as const;

/** Maximum serialized length of either value in a formatted difference line, including truncation. */
const HOST_FIXTURE_DIFFERENCE_VALUE_LIMIT = 512;

/** One actionable difference between the first fixture and the second fixture. */
export interface HostFixtureDifference {
    readonly field: string;
    readonly committedValue: ComparableValue;
    readonly capturedValue: ComparableValue;
}

function isRecord(value: ComparableValue): value is Readonly<Record<string, string>> {
    return typeof value === "object" && !Array.isArray(value);
}

function valuesEqual(left: ComparableValue, right: ComparableValue): boolean {
    if (Array.isArray(left) || Array.isArray(right)) {
        if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
            return false;
        }
        return left.every((value, index) => value === right[index]);
    }

    if (isRecord(left) || isRecord(right)) {
        if (!isRecord(left) || !isRecord(right)) {
            return false;
        }
        const leftKeys = Object.keys(left);
        const rightKeys = Object.keys(right);
        return (
            leftKeys.length === rightKeys.length &&
            leftKeys.every(
                (key) =>
                    Object.prototype.hasOwnProperty.call(right, key) && left[key] === right[key],
            )
        );
    }

    return left === right;
}

function recordDifference(
    differences: HostFixtureDifference[],
    field: string,
    committedValue: ComparableValue,
    capturedValue: ComparableValue,
): void {
    if (!valuesEqual(committedValue, capturedValue)) {
        differences.push({ field, committedValue, capturedValue });
    }
}

function formatDifferenceValue(value: ComparableValue, maxValueLength: number): string {
    const serialized = JSON.stringify(value);
    if (serialized.length <= maxValueLength) {
        return serialized;
    }

    return `${serialized.slice(0, Math.max(0, maxValueLength - 1))}…`;
}

/** Formats every difference with a bounded excerpt for each value so CI logs stay readable. */
export function formatHostFixtureDifferences(
    differences: readonly HostFixtureDifference[],
    maxValueLength = HOST_FIXTURE_DIFFERENCE_VALUE_LIMIT,
): string {
    return differences
        .map(
            ({ field, committedValue, capturedValue }) =>
                `${field}: committed=${formatDifferenceValue(committedValue, maxValueLength)}, ` +
                `captured=${formatDifferenceValue(capturedValue, maxValueLength)}`,
        )
        .join("\n");
}

/**
 * Compares the observable host payload and comparable provenance of two captures without reading
 * files, launching VS Code, or consulting the environment.
 */
export function compareHostFixtures(
    committedFixture: HostFixture,
    capturedFixture: HostFixture,
): readonly HostFixtureDifference[] {
    const differences: HostFixtureDifference[] = [];

    recordDifference(
        differences,
        "provenance.captureSchemaVersion",
        committedFixture.provenance.captureSchemaVersion,
        capturedFixture.provenance.captureSchemaVersion,
    );
    if (differences.length > 0) {
        return differences;
    }

    recordDifference(
        differences,
        "provenance.platform",
        committedFixture.provenance.platform,
        capturedFixture.provenance.platform,
    );

    recordDifference(
        differences,
        "documentElement.classList",
        committedFixture.documentElement.classList,
        capturedFixture.documentElement.classList,
    );
    recordDifference(
        differences,
        "documentElement.dataset",
        committedFixture.documentElement.dataset,
        capturedFixture.documentElement.dataset,
    );
    recordDifference(
        differences,
        "documentElement.styleCssText",
        committedFixture.documentElement.styleCssText,
        capturedFixture.documentElement.styleCssText,
    );
    recordDifference(
        differences,
        "body.classList",
        committedFixture.body.classList,
        capturedFixture.body.classList,
    );
    recordDifference(
        differences,
        "body.dataset",
        committedFixture.body.dataset,
        capturedFixture.body.dataset,
    );

    recordDifference(
        differences,
        "provenance.themeId",
        committedFixture.provenance.themeId,
        capturedFixture.provenance.themeId,
    );
    recordDifference(
        differences,
        "provenance.themeName",
        committedFixture.provenance.themeName,
        capturedFixture.provenance.themeName,
    );
    recordDifference(
        differences,
        "provenance.requestedTheme",
        committedFixture.provenance.requestedTheme,
        capturedFixture.provenance.requestedTheme,
    );
    recordDifference(
        differences,
        "provenance.themeKind",
        committedFixture.provenance.themeKind,
        capturedFixture.provenance.themeKind,
    );
    // `vscodeVersion` is excluded because the pinned and Insiders captures are expected to resolve
    // different builds, even when the host payload is unchanged.
    // `vscodeCommit` is excluded because those builds necessarily have different upstream commits.

    return differences;
}
