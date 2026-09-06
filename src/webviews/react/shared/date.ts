import { getSettings } from "./settings";

const DEFAULT_DATE_OPTIONS: Intl.DateTimeFormatOptions = {
    month: "numeric",
    day: "numeric",
    year: "2-digit",
    hour: "numeric",
    minute: "2-digit",
};

/**
 * Formats an ISO-like timestamp for commit list display.
 *
 * Invalid or unformattable inputs are returned unchanged so backend-provided
 * timestamps remain visible instead of disappearing behind a formatting error.
 *
 * The `intelligit.timeFormat` setting picks the clock: `h23` is used for 24h
 * rather than `hour12: false`, which some engines render midnight as "24:00".
 */
export function formatDateTime(
    iso: string,
    options: Intl.DateTimeFormatOptions = DEFAULT_DATE_OPTIONS,
): string {
    try {
        const d = new Date(iso);
        if (Number.isNaN(d.getTime())) return iso;
        const clock: Intl.DateTimeFormatOptions =
            getSettings().timeFormat === "24h" ? { hourCycle: "h23" } : {};
        return d.toLocaleDateString("en-US", { ...options, ...clock });
    } catch {
        return iso;
    }
}
