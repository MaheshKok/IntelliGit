const DEFAULT_DATE_OPTIONS: Intl.DateTimeFormatOptions = {
    month: "numeric",
    day: "numeric",
    year: "2-digit",
    hour: "numeric",
    minute: "2-digit",
};

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

