import { describe, expect, it } from "vitest";
import { parseMergeDraft } from "../../../src/webviews/protocol/mergeWorkbench";

const hunk = { id: 0, from: 0, to: 4, resolved: false };
const draft = { snapshotId: "a".repeat(64), content: "text", hunks: [hunk] };

describe("merge draft protocol", () => {
    it.each([
        ["PR-shape", draft],
        ...["ours", "theirs", "both", "both-reversed", "base", "none"].map((decision) => [
            `decision ${decision}`,
            { ...draft, hunks: [{ ...hunk, decision }] },
        ]),
        ...[false, true].flatMap((value) => [
            [`ignoreWhitespace ${value}`, { ...draft, ignoreWhitespace: value }],
            ...["edited", "dismissedOurs", "dismissedTheirs"].map((field) => [
                `${field} ${value}`,
                { ...draft, hunks: [{ ...hunk, [field]: value }] },
            ]),
        ]),
    ])("round-trips %s without adding keys", (_name, input) => {
        expect(parseMergeDraft(input)).toEqual(input);
        expect(parseMergeDraft(input)).toStrictEqual(input);
    });

    it.each([
        ["decision", "nope"],
        ["decision", null],
        ["dismissedOurs", "yes"],
        ["edited", 1],
        ["dismissedTheirs", null],
    ])("rejects invalid hunk %s = %s", (field, value) => {
        expect(parseMergeDraft({ ...draft, hunks: [{ ...hunk, [field]: value }] })).toBeNull();
    });

    it.each([1, null])("rejects ignoreWhitespace = %s", (ignoreWhitespace) => {
        expect(parseMergeDraft({ ...draft, ignoreWhitespace })).toBeNull();
    });

    it.each(["decision", "edited", "dismissedOurs", "dismissedTheirs"])(
        "omits undefined hunk %s",
        (field) => {
            const parsed = parseMergeDraft({ ...draft, hunks: [{ ...hunk, [field]: undefined }] });
            expect(parsed).toStrictEqual(draft);
            expect(Object.hasOwn(parsed!.hunks[0], field)).toBe(false);
        },
    );

    it("omits undefined ignoreWhitespace", () => {
        const parsed = parseMergeDraft({ ...draft, ignoreWhitespace: undefined });
        expect(parsed).toStrictEqual(draft);
        expect(Object.hasOwn(parsed!, "ignoreWhitespace")).toBe(false);
    });

    it("rejects the whole draft when one hunk among valid hunks is invalid", () => {
        expect(
            parseMergeDraft({
                ...draft,
                hunks: [
                    { ...hunk, to: 1 },
                    { ...hunk, id: 1, from: 1, to: 2, edited: "yes" },
                    { ...hunk, id: 2, from: 2 },
                ],
            }),
        ).toBeNull();
    });

    it("round-trips every new field through JSON and parsing", () => {
        const complete = {
            ...draft,
            ignoreWhitespace: true,
            hunks: [
                {
                    ...hunk,
                    decision: "ours",
                    edited: true,
                    dismissedOurs: true,
                    dismissedTheirs: false,
                },
            ],
        };
        expect(parseMergeDraft(JSON.parse(JSON.stringify(complete)))).toStrictEqual(complete);
    });
});
