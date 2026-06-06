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
 */
export function formatDateTime(
    iso: string,
    options: Intl.DateTimeFormatOptions = DEFAULT_DATE_OPTIONS,
): string {
    try {
        const d = new Date(iso);
        if (Number.isNaN(d.getTime())) return iso;
        return d.toLocaleDateString("en-US", options);
    } catch {
        return iso;
    }
}
