import type { HostFixture } from "./types";
import { parseStyleCustomProperties } from "./canonicalizeHostFixture";
import { serializeHostFixture } from "./hostFixtureFile";

type ComparableValue = string | number | readonly string[] | Readonly<Record<string, string>>;

/**
 * The complete fixture-field inventory. Every on-disk field must be either compared or explicitly
 * excluded; the unit ratchet checks both sets against a real committed fixture.
 */
export const HOST_FIXTURE_FIELD_INVENTORY = {
    topLevel: {
        compared: ["provenance", "documentElement", "body"],
        excluded: [],
        staleness: {
            compared: ["provenance", "documentElement", "body"],
            excluded: [],
        },
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
        staleness: {
            compared: [
                "captureSchemaVersion",
                "vscodeVersion",
                "vscodeCommit",
                "platform",
                "themeId",
                "themeName",
                "requestedTheme",
                "themeKind",
            ],
            excluded: [],
        },
    },
    // The payload sections are inventoried for the same reason as the rest: a top-level ratchet
    // only sees `provenance`/`documentElement`/`body`, so a NEW sub-field here -- which is where an
    // upstream host change actually lands -- would slip past it while the top-level keys stayed
    // identical.
    documentElement: {
        compared: ["classList", "dataset", "styleCssText"],
        excluded: [],
        staleness: {
            compared: ["classList", "dataset", "styleCssText"],
            excluded: [],
        },
    },
    body: {
        compared: ["classList", "dataset"],
        excluded: [],
        staleness: {
            compared: ["classList", "dataset"],
            excluded: [],
        },
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

/**
 * Records a `documentElement.styleCssText` difference for tokens the pinned build declares and the
 * second capture either DROPPED or REDEFINED. A token present only in the second capture is
 * ignored.
 *
 * Upstream adds theme tokens continuously -- one Insiders run added 25 (`--vscode-modernTab-*`,
 * `--vscode-modernEditorTab-*`, `--vscode-chat-findMatch*`) against two it actually changed. A
 * token nothing in this extension reads cannot change how the extension renders, so an addition is
 * not an early warning; it is what kept this canary red every night until stable caught up, which
 * is the same as having no canary. A token that disappears or changes value underneath a webview
 * can break it, so those are what get reported.
 *
 * Only the offending tokens travel into the difference. Carrying both full blocks put ~900
 * identical tokens on either side of the formatter's truncation limit, so the failure named the
 * field and then printed the same prefix twice.
 */
function recordStyleCustomPropertyDifference(
    differences: HostFixtureDifference[],
    committedCssText: string,
    capturedCssText: string,
): void {
    const captured = parseStyleCustomProperties(capturedCssText);
    const committedOffenders: Record<string, string> = {};
    const capturedOffenders: Record<string, string> = {};

    for (const [name, committedValue] of parseStyleCustomProperties(committedCssText)) {
        const capturedValue = captured.get(name);
        if (capturedValue === committedValue) continue;

        committedOffenders[name] = committedValue;
        // An absent key on the captured side IS the removal: the second build no longer declares
        // this token at all, which reads differently from a token that merely changed value.
        if (capturedValue !== undefined) {
            capturedOffenders[name] = capturedValue;
        }
    }

    if (Object.keys(committedOffenders).length > 0) {
        differences.push({
            field: "documentElement.styleCssText",
            committedValue: committedOffenders,
            capturedValue: capturedOffenders,
        });
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
    // Token-wise, not string-wise: this comparison is the cross-build canary, where the two
    // captures come from DIFFERENT VS Code builds and upstream additions are expected. The
    // staleness comparison below stays an exact string match on purpose -- there both sides come
    // from the SAME pinned build, so any drift at all means the committed fixture needs recapture.
    recordStyleCustomPropertyDifference(
        differences,
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

function utf8Bytes(value: string | Uint8Array): Uint8Array {
    return typeof value === "string" ? new TextEncoder().encode(value) : value;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
    return left.length === right.length && left.every((value, index) => value === right[index]);
}

/**
 * Compares a committed artifact's bytes with a freshly recaptured fixture.
 *
 * This is deliberately separate from `compareHostFixtures`: the pinned-vs-Insiders check is
 * expected to ignore build provenance, while a staleness recapture uses the same pinned build as
 * the artifact and must report `vscodeVersion` and `vscodeCommit` drift. The serialized bytes are
 * checked after the parsed fields so indentation, key order, and the trailing newline cannot drift
 * without a named failure.
 */
export function compareHostFixtureStaleness(
    committedBytes: string | Uint8Array,
    capturedFixture: HostFixture,
): readonly HostFixtureDifference[] {
    const committedText =
        typeof committedBytes === "string"
            ? committedBytes
            : new TextDecoder().decode(committedBytes);
    // A truncated or non-object artifact must arrive as a named difference, not as a `SyntaxError`
    // from the parse or a `TypeError` from the first `.provenance` dereference. The nightly sweep
    // formats differences; a raw throw reaches it as a stack trace that names this file rather than
    // the artifact that is actually broken. The parse itself is guarded too -- shape-checking the
    // result cannot help when `JSON.parse` never returns.
    const parsed: unknown = ((): unknown => {
        try {
            return JSON.parse(committedText);
        } catch {
            return undefined;
        }
    })();
    if (typeof parsed !== "object" || parsed === null || !("provenance" in parsed)) {
        return [
            {
                field: "committedFixture.shape",
                committedValue: committedText,
                capturedValue: serializeHostFixture(capturedFixture),
            },
        ];
    }
    const committedFixture = parsed as HostFixture;
    const differences: HostFixtureDifference[] = [];

    recordDifference(
        differences,
        "provenance.captureSchemaVersion",
        committedFixture.provenance.captureSchemaVersion,
        capturedFixture.provenance.captureSchemaVersion,
    );
    recordDifference(
        differences,
        "provenance.vscodeVersion",
        committedFixture.provenance.vscodeVersion,
        capturedFixture.provenance.vscodeVersion,
    );
    recordDifference(
        differences,
        "provenance.vscodeCommit",
        committedFixture.provenance.vscodeCommit,
        capturedFixture.provenance.vscodeCommit,
    );
    recordDifference(
        differences,
        "provenance.platform",
        committedFixture.provenance.platform,
        capturedFixture.provenance.platform,
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

    const serializedCapturedFixture = serializeHostFixture(capturedFixture);
    if (!bytesEqual(utf8Bytes(committedBytes), utf8Bytes(serializedCapturedFixture))) {
        differences.push({
            field: "serializedBytes",
            committedValue: committedText,
            capturedValue: serializedCapturedFixture,
        });
    }

    return differences;
}
