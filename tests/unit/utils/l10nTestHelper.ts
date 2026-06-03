export function interpolateL10n(
    message: string,
    args?: Record<string, string | number | boolean> | Array<string | number | boolean>,
): string {
    if (!args) return message;
    if (Array.isArray(args)) {
        return args.reduce(
            (current, value, index) =>
                current.replace(new RegExp(`\\{${index}\\}`, "g"), String(value)),
            message,
        );
    }
    return message.replace(/\{([A-Za-z0-9_]+)\}/g, (match, key) =>
        Object.prototype.hasOwnProperty.call(args, key) ? String(args[key]) : match,
    );
}
