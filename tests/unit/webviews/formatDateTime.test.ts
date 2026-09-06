// formatDateTime honors the `intelligit.timeFormat` setting (issue #155): the
// default stays the 12-hour clock, "24h" drops the AM/PM marker.

import { afterEach, describe, expect, it, vi } from "vitest";
import { formatDateTime } from "../../../src/webviews/react/shared/date";

const ISO = "2026-02-19T13:05:00Z";
const local = new Date(ISO);
const hour24 = local.getHours();
const hour12 = hour24 % 12 || 12;

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("formatDateTime time format", () => {
    it("uses the 12-hour clock with a day-period marker by default", () => {
        const out = formatDateTime(ISO);
        expect(out).toMatch(/[AP]M/);
        expect(out).toContain(`${hour12}:05`);
    });

    it("keeps the 12-hour output identical when the setting says 12h", () => {
        const expected = formatDateTime(ISO);
        vi.stubGlobal("window", { intelligitSettings: { timeFormat: "12h" } });
        expect(formatDateTime(ISO)).toBe(expected);
    });

    it("uses the 24-hour clock without a day-period marker when the setting says 24h", () => {
        vi.stubGlobal("window", { intelligitSettings: { timeFormat: "24h" } });
        const out = formatDateTime(ISO);
        expect(out).not.toMatch(/[AP]M/);
        expect(out).toMatch(new RegExp(`\\b0?${hour24}:05\\b`));
    });

    it("applies the 24-hour clock to caller-supplied options too", () => {
        vi.stubGlobal("window", { intelligitSettings: { timeFormat: "24h" } });
        const out = formatDateTime(ISO, { hour: "numeric", minute: "2-digit" });
        expect(out).not.toMatch(/[AP]M/);
        expect(out).toMatch(new RegExp(`\\b0?${hour24}:05\\b`));
    });
});
