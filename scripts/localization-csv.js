#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..");
const csvPath = path.join(repoRoot, "docs/localization/localization_translation_review.csv");

const locales = ["de", "es", "fr", "ja", "ko", "pl", "pt-br", "pt-pt", "ru", "zh-cn", "zh-tw"];

const metadataColumns = [
    "area",
    "source_file",
    "key",
    "plural_category",
    "plural_category_required_for_locales",
    "english_source",
    "context",
    "placeholders_keep_exact",
    "glossary_terms_to_review",
];

const sourceDefinitions = [
    {
        area: "manifest",
        sourceFile: "package.nls.json",
        targetFile: (locale) => `package.nls.${locale}.json`,
    },
    {
        area: "host",
        sourceFile: "l10n/bundle.l10n.json",
        targetFile: (locale) => `l10n/bundle.l10n.${locale}.json`,
    },
    {
        area: "webview",
        sourceFile: "src/webviews/i18n/en.json",
        targetFile: (locale) => `src/webviews/i18n/${locale}.json`,
    },
];

const preservedLiteralTokens = [
    { token: "reword", contains: containsAsciiWord },
    { token: "origin", contains: containsAsciiWord },
    { token: ".git/config", contains: (value, token) => value.includes(token) },
];
const glossaryTermCandidates = [
    "IntelliGit",
    "VS Code",
    "JetBrains",
    "GitHub",
    "GitLab",
    "Git",
    "HEAD",
    ".git/config",
    "origin",
    "remote",
    "SSH",
    "URL",
    "Branch",
    "Commit",
    "Checkout",
    "Cherry-pick",
    "Rebase",
    "Merge",
    "Push",
    "Squash Commits",
];
const spreadsheetFormulaEscapePrefix = "__INTELLIGIT_TEXT__";
const spreadsheetFormulaLiteralPrefix = "__INTELLIGIT_LITERAL_PREFIX__";
const spreadsheetFormulaPattern = /^[\t\r\n ]*[=+\-@]/;

const command = process.argv[2] ?? "validate";
const quiet = process.argv.includes("--quiet");

try {
    if (command === "validate") {
        validate({ checkCatalogSync: true });
        log("Localization CSV validation passed.");
    } else if (command === "import") {
        const result = importCsv();
        validate({ checkCatalogSync: true });
        log(
            `Imported localization CSV: ${result.updatedFiles} files updated, ${result.appliedCells} cells applied, ${result.skippedCells} non-required plural cells skipped.`,
        );
    } else if (command === "sync") {
        const result = syncCsv();
        log(
            `Synchronized localization CSV: ${result.addedRows} rows added, ${result.updatedRows} rows updated, ${result.removedRows} stale rows removed, ${result.totalRows} total rows.`,
        );
    } else if (command === "translate") {
        const result = translateMissing();
        log(
            `Localization translation check passed: ${result.checkedCells} required cells checked, no missing translations.`,
        );
    } else {
        throw new Error(
            `Unknown command "${command}". Use "validate", "import", "sync", or "translate".`,
        );
    }
} catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
}

function validate({ checkCatalogSync }) {
    const { rows, header } = readTranslationRows();
    const expectedRows = collectExpectedRows();
    const expectedById = new Map(expectedRows.map((row) => [row.id, row]));
    const seenRows = new Set();
    const errors = [];

    validateHeader(header, errors);

    for (const [index, row] of rows.entries()) {
        const rowNumber = index + 2;
        if (row.length !== header.length) {
            errors.push(
                `Row ${rowNumber}: expected ${header.length} columns, found ${row.length}.`,
            );
            continue;
        }

        const record = recordFromRow(header, row);
        for (const [column, value] of Object.entries(record)) {
            if (hasReplacementCharacter(value)) {
                errors.push(`Row ${rowNumber}: ${column} contains U+FFFD replacement characters.`);
            }
        }

        const id = rowId(record);
        if (seenRows.has(id))
            errors.push(
                `Row ${rowNumber}: duplicate row ${record.area}/${record.source_file}/${record.key}.`,
            );
        seenRows.add(id);

        const expected = expectedById.get(id);
        if (!expected) {
            errors.push(
                `Row ${rowNumber}: unknown source row ${record.area}/${record.source_file}/${record.key}.`,
            );
            continue;
        }

        if (record.plural_category !== expected.pluralCategory) {
            errors.push(
                `Row ${rowNumber}: plural_category for ${record.key} should be "${expected.pluralCategory}".`,
            );
        }
        if (record.plural_category_required_for_locales !== expected.requiredLocaleText) {
            errors.push(
                `Row ${rowNumber}: plural_category_required_for_locales for ${record.key} should be "${expected.requiredLocaleText}".`,
            );
        }
        if (record.english_source !== expected.englishSource) {
            errors.push(
                `Row ${rowNumber}: english_source does not match ${record.source_file}:${record.key}.`,
            );
        }
        if (record.placeholders_keep_exact !== placeholders(expected.englishSource).join(" ")) {
            errors.push(`Row ${rowNumber}: placeholders_keep_exact is stale for ${record.key}.`);
        }

        for (const locale of locales) {
            const value = record[`current_${locale}`];
            const localeRequiresPlural =
                expected.requiredLocales.length === 0 || expected.requiredLocales.includes(locale);
            if (!localeRequiresPlural) {
                if (value !== "") {
                    errors.push(
                        `Row ${rowNumber}: ${locale} must leave non-required plural category ${record.key} blank.`,
                    );
                }
                continue;
            }

            if (expected.englishSource !== "" && value === "") {
                errors.push(`Row ${rowNumber}: current_${locale} is required for ${record.key}.`);
                continue;
            }

            compareTokens({
                errors,
                rowNumber,
                locale,
                key: record.key,
                sourceValue: expected.englishSource,
                translatedValue: value,
            });
            comparePreservedLiterals({
                errors,
                rowNumber,
                locale,
                key: record.key,
                sourceValue: expected.englishSource,
                translatedValue: value,
            });
        }
    }

    for (const expected of expectedRows) {
        if (!seenRows.has(expected.id)) {
            errors.push(`Missing row: ${expected.area}/${expected.sourceFile}/${expected.key}.`);
        }
    }

    if (checkCatalogSync) {
        errors.push(...catalogSyncErrors(rows, header));
    }

    if (errors.length > 0) {
        throw new Error(
            `Localization CSV validation failed:\n${errors.map((error) => `- ${error}`).join("\n")}`,
        );
    }
}

function importCsv() {
    validate({ checkCatalogSync: false });

    const { rows, header } = readTranslationRows();
    const expectedById = new Map(collectExpectedRows().map((row) => [row.id, row]));
    const targetCatalogs = new Map();
    const allowedTargetKeys = new Map();
    let appliedCells = 0;
    let skippedCells = 0;

    for (const row of rows) {
        const record = recordFromRow(header, row);
        const expected = expectedById.get(rowId(record));
        if (!expected)
            throw new Error(
                `Unexpected source row ${record.area}/${record.source_file}/${record.key}.`,
            );

        for (const locale of locales) {
            if (expected.requiredLocales.length > 0 && !expected.requiredLocales.includes(locale)) {
                skippedCells += 1;
                continue;
            }

            const targetPath = path.join(repoRoot, expected.targetFile(locale));
            if (!allowedTargetKeys.has(targetPath)) allowedTargetKeys.set(targetPath, new Set());
            allowedTargetKeys.get(targetPath).add(expected.pluralParentKey || expected.key);

            if (!targetCatalogs.has(targetPath)) {
                targetCatalogs.set(targetPath, readJsonAbsolute(targetPath));
            }

            const catalog = targetCatalogs.get(targetPath);
            if (expected.pluralParentKey) {
                if (
                    !catalog[expected.pluralParentKey] ||
                    typeof catalog[expected.pluralParentKey] !== "object"
                ) {
                    catalog[expected.pluralParentKey] = {};
                }
                catalog[expected.pluralParentKey][expected.pluralCategory] =
                    record[`current_${locale}`];
            } else {
                catalog[expected.key] = record[`current_${locale}`];
            }
            appliedCells += 1;
        }
    }

    let updatedFiles = 0;
    for (const [targetPath, catalog] of targetCatalogs.entries()) {
        const allowedKeys = allowedTargetKeys.get(targetPath) ?? new Set();
        for (const key of Object.keys(catalog)) {
            if (!allowedKeys.has(key)) delete catalog[key];
        }

        const original = fs.readFileSync(targetPath, "utf8");
        const formatted = `${JSON.stringify(catalog, null, detectIndent(original))}\n`;
        if (formatted !== original) {
            fs.writeFileSync(targetPath, formatted, "utf8");
            updatedFiles += 1;
        }
    }

    return { appliedCells, skippedCells, updatedFiles };
}

function syncCsv() {
    const { rows, header } = readTranslationRows();
    validateHeaderOrThrow(header);

    const expectedRows = collectExpectedRows();
    const expectedById = new Map(expectedRows.map((row) => [row.id, row]));
    const existingById = new Map();
    for (const row of rows) {
        const record = recordFromRow(header, row);
        existingById.set(rowId(record), record);
    }

    const targetCatalogs = new Map();
    const syncedRecords = [];
    const syncedExpectedIds = new Set();
    let addedRows = 0;
    let updatedRows = 0;
    let removedRows = 0;

    for (const row of rows) {
        const existing = recordFromRow(header, row);
        const expected = expectedById.get(rowId(existing));
        if (!expected) {
            removedRows += 1;
            continue;
        }

        const record = syncExistingRecord(existing, expected, targetCatalogs);
        if (serializeRecord(header, existing) !== serializeRecord(header, record)) {
            updatedRows += 1;
        }

        syncedRecords.push(record);
        syncedExpectedIds.add(expected.id);
    }

    for (const expected of expectedRows) {
        if (syncedExpectedIds.has(expected.id)) continue;
        syncedRecords.push(createRecord(expected, targetCatalogs));
        addedRows += 1;
    }

    writeTranslationRecords(header, syncedRecords);
    return { addedRows, updatedRows, removedRows, totalRows: syncedRecords.length };
}

function translateMissing() {
    if (!process.argv.includes("--only-missing")) {
        throw new Error(
            'Localization translate currently supports only "--only-missing". Run "bun run l10n:translate -- --only-missing".',
        );
    }

    const missing = missingRequiredTranslations();
    if (missing.length > 0) {
        const shown = missing.slice(0, 40);
        const remaining = missing.length - shown.length;
        throw new Error(
            [
                "Automatic machine translation is not configured for this repository.",
                "Fill the missing required translation cells in docs/localization/localization_translation_review.csv with an approved translation source, then run the import/validation pipeline.",
                "Missing required translations:",
                ...shown.map(
                    (item) =>
                        `- Row ${item.rowNumber}: current_${item.locale} for ${item.area}/${item.key}`,
                ),
                remaining > 0 ? `- ...and ${remaining} more missing cells.` : "",
            ]
                .filter(Boolean)
                .join("\n"),
        );
    }

    const { rows, header } = readTranslationRows();
    let checkedCells = 0;
    const expectedById = new Map(collectExpectedRows().map((row) => [row.id, row]));
    for (const row of rows) {
        const record = recordFromRow(header, row);
        const expected = expectedById.get(rowId(record));
        if (!expected) continue;
        for (const locale of locales) {
            if (
                expected.requiredLocales.length === 0 ||
                expected.requiredLocales.includes(locale)
            ) {
                checkedCells += 1;
            }
        }
    }

    return { checkedCells };
}

function syncExistingRecord(existing, expected, targetCatalogs) {
    const record = {
        ...existing,
        area: expected.area,
        source_file: expected.sourceFile,
        key: expected.key,
        plural_category: expected.pluralCategory,
        plural_category_required_for_locales: expected.requiredLocaleText,
        english_source: expected.englishSource,
        placeholders_keep_exact: placeholders(expected.englishSource).join(" "),
    };

    for (const locale of locales) {
        const column = `current_${locale}`;
        if (expected.requiredLocales.length > 0 && !expected.requiredLocales.includes(locale)) {
            record[column] = "";
            continue;
        }

        if (record[column] === "") {
            record[column] = localeValueFromCatalog(expected, locale, targetCatalogs);
        }
    }

    return record;
}

function createRecord(expected, targetCatalogs) {
    const record = {
        area: expected.area,
        source_file: expected.sourceFile,
        key: expected.key,
        plural_category: expected.pluralCategory,
        plural_category_required_for_locales: expected.requiredLocaleText,
        english_source: expected.englishSource,
        context: defaultContext(expected),
        placeholders_keep_exact: placeholders(expected.englishSource).join(" "),
        glossary_terms_to_review: glossaryTerms(expected.englishSource).join("; "),
    };

    for (const locale of locales) {
        if (expected.requiredLocales.length > 0 && !expected.requiredLocales.includes(locale)) {
            record[`current_${locale}`] = "";
        } else {
            record[`current_${locale}`] = localeValueFromCatalog(expected, locale, targetCatalogs);
        }
    }

    return record;
}

function localeValueFromCatalog(expected, locale, targetCatalogs) {
    const targetPath = path.join(repoRoot, expected.targetFile(locale));
    if (!fs.existsSync(targetPath)) return "";

    if (!targetCatalogs.has(targetPath)) {
        targetCatalogs.set(targetPath, readJsonAbsolute(targetPath));
    }

    const catalog = targetCatalogs.get(targetPath);
    const value = expected.pluralParentKey
        ? catalog[expected.pluralParentKey]?.[expected.pluralCategory]
        : catalog[expected.key];
    return typeof value === "string" ? value : "";
}

function defaultContext(expected) {
    if (expected.area === "manifest") {
        return "VS Code extension manifest string.";
    }
    if (expected.area === "host") {
        return "Extension-host runtime notification, command label, prompt, or status message.";
    }
    return "Webview UI string.";
}

function glossaryTerms(sourceValue) {
    return glossaryTermCandidates.filter((term) => {
        if (term === ".git/config") return sourceValue.includes(term);
        return containsAsciiWord(sourceValue, term);
    });
}

function missingRequiredTranslations() {
    const { rows, header } = readTranslationRows();
    validateHeaderOrThrow(header);

    const expectedById = new Map(collectExpectedRows().map((row) => [row.id, row]));
    const missing = [];
    for (const [index, row] of rows.entries()) {
        const record = recordFromRow(header, row);
        const expected = expectedById.get(rowId(record));
        if (!expected) continue;

        for (const locale of locales) {
            if (expected.requiredLocales.length > 0 && !expected.requiredLocales.includes(locale)) {
                continue;
            }
            if (expected.englishSource !== "" && record[`current_${locale}`] === "") {
                missing.push({
                    rowNumber: index + 2,
                    locale,
                    area: record.area,
                    key: record.key,
                });
            }
        }
    }
    return missing;
}

function collectExpectedRows() {
    const rows = [];

    for (const definition of sourceDefinitions) {
        const sourcePath = path.join(repoRoot, definition.sourceFile);
        const catalog = readJsonAbsolute(sourcePath);

        for (const [key, value] of Object.entries(catalog)) {
            if (typeof value === "string") {
                rows.push({
                    id: `${definition.area}\0${definition.sourceFile}\0${key}`,
                    area: definition.area,
                    sourceFile: definition.sourceFile,
                    key,
                    englishSource: value,
                    pluralCategory: "",
                    pluralParentKey: "",
                    requiredLocales: [],
                    requiredLocaleText: "",
                    targetFile: definition.targetFile,
                });
                continue;
            }

            if (!isStringMap(value)) {
                throw new Error(`Unsupported catalog value at ${definition.sourceFile}:${key}.`);
            }

            for (const [category, template] of Object.entries(value)) {
                const requiredLocales = locales.filter((locale) =>
                    new Intl.PluralRules(locale)
                        .resolvedOptions()
                        .pluralCategories.includes(category),
                );
                rows.push({
                    id: `${definition.area}\0${definition.sourceFile}\0${key}.${category}`,
                    area: definition.area,
                    sourceFile: definition.sourceFile,
                    key: `${key}.${category}`,
                    englishSource: template,
                    pluralCategory: category,
                    pluralParentKey: key,
                    requiredLocales,
                    requiredLocaleText: requiredLocales.join(" "),
                    targetFile: definition.targetFile,
                });
            }
        }
    }

    return rows;
}

function catalogSyncErrors(rows, header) {
    const errors = [];
    const catalogCache = new Map();
    const expectedById = new Map(collectExpectedRows().map((row) => [row.id, row]));

    for (const [index, row] of rows.entries()) {
        const rowNumber = index + 2;
        const record = recordFromRow(header, row);
        const expected = expectedById.get(rowId(record));
        if (!expected) continue;

        for (const locale of locales) {
            const expectedValue = record[`current_${locale}`];
            const localeRequiresPlural =
                expected.requiredLocales.length === 0 || expected.requiredLocales.includes(locale);
            if (!localeRequiresPlural) continue;

            const targetPath = path.join(repoRoot, expected.targetFile(locale));
            if (!catalogCache.has(targetPath)) {
                catalogCache.set(targetPath, readJsonAbsolute(targetPath));
            }
            const catalog = catalogCache.get(targetPath);
            const actualValue = expected.pluralParentKey
                ? catalog[expected.pluralParentKey]?.[expected.pluralCategory]
                : catalog[expected.key];

            if (actualValue !== expectedValue) {
                errors.push(
                    `Row ${rowNumber}: current_${locale} for ${record.key} does not match ${path.relative(repoRoot, targetPath)}. Run "bun run l10n:import".`,
                );
            }
        }
    }

    return errors;
}

function readTranslationRows() {
    const parsed = parseCsv(fs.readFileSync(csvPath, "utf8"));
    if (parsed.length < 2)
        throw new Error(
            `${path.relative(repoRoot, csvPath)} must include a header and at least one row.`,
        );
    return { header: parsed[0], rows: parsed.slice(1) };
}

function writeTranslationRecords(header, records) {
    const lines = [
        header.map(formatCsvField).join(","),
        ...records.map((record) => serializeRecord(header, record)),
    ];
    fs.writeFileSync(csvPath, `${lines.join("\n")}\n`, "utf8");
}

function serializeRecord(header, record) {
    return header.map((column) => formatCsvField(record[column] ?? "")).join(",");
}

function formatCsvField(value) {
    const safeValue = escapeSpreadsheetFormula(value);
    if (/[",\r\n]/.test(safeValue)) return `"${safeValue.replace(/"/g, '""')}"`;
    return safeValue;
}

function escapeSpreadsheetFormula(value) {
    if (
        value.startsWith(spreadsheetFormulaEscapePrefix) ||
        value.startsWith(spreadsheetFormulaLiteralPrefix)
    ) {
        return `${spreadsheetFormulaLiteralPrefix}${value}`;
    }
    if (!spreadsheetFormulaPattern.test(value)) return value;
    return `${spreadsheetFormulaEscapePrefix}${value}`;
}

function unescapeSpreadsheetFormula(value) {
    if (value.startsWith(spreadsheetFormulaLiteralPrefix)) {
        return value.slice(spreadsheetFormulaLiteralPrefix.length);
    }
    if (!value.startsWith(spreadsheetFormulaEscapePrefix)) return value;
    const unescaped = value.slice(spreadsheetFormulaEscapePrefix.length);
    return spreadsheetFormulaPattern.test(unescaped) ? unescaped : value;
}

function validateHeader(header, errors) {
    const expectedHeader = [...metadataColumns, ...locales.map((locale) => `current_${locale}`)];
    if (JSON.stringify(header) !== JSON.stringify(expectedHeader)) {
        errors.push(`CSV header must be exactly: ${expectedHeader.join(",")}.`);
    }
}

function validateHeaderOrThrow(header) {
    const errors = [];
    validateHeader(header, errors);
    if (errors.length > 0) throw new Error(errors.join("\n"));
}

function compareTokens({ errors, rowNumber, locale, key, sourceValue, translatedValue }) {
    const sourcePlaceholders = placeholders(sourceValue).sort();
    const translatedPlaceholders = placeholders(translatedValue).sort();
    if (JSON.stringify(translatedPlaceholders) !== JSON.stringify(sourcePlaceholders)) {
        errors.push(
            `Row ${rowNumber}: current_${locale} placeholder mismatch for ${key}: expected ${sourcePlaceholders.join(",") || "(none)"}, got ${translatedPlaceholders.join(",") || "(none)"}.`,
        );
    }

    const sourceCodicons = codicons(sourceValue);
    const translatedCodicons = codicons(translatedValue);
    if (JSON.stringify(translatedCodicons) !== JSON.stringify(sourceCodicons)) {
        errors.push(
            `Row ${rowNumber}: current_${locale} codicon mismatch for ${key}: expected ${sourceCodicons.join(",") || "(none)"}, got ${translatedCodicons.join(",") || "(none)"}.`,
        );
    }

    if (/\bZXQ\d+ZX\b/i.test(translatedValue)) {
        errors.push(
            `Row ${rowNumber}: current_${locale} contains generated placeholder artifact for ${key}.`,
        );
    }
}

function comparePreservedLiterals({
    errors,
    rowNumber,
    locale,
    key,
    sourceValue,
    translatedValue,
}) {
    for (const { token, contains } of preservedLiteralTokens) {
        if (contains(sourceValue, token) && !contains(translatedValue, token)) {
            errors.push(
                `Row ${rowNumber}: current_${locale} must preserve literal token "${token}" for ${key}.`,
            );
        }
    }
}

function containsAsciiWord(value, token) {
    return new RegExp(`(^|[^A-Za-z0-9_])${escapeRegExp(token)}($|[^A-Za-z0-9_])`).test(value);
}

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasReplacementCharacter(value) {
    return value.includes("\uFFFD");
}

function parseCsv(text) {
    const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
    const rows = [];
    let row = [];
    let field = "";
    let inQuotes = false;

    for (let index = 0; index < input.length; index += 1) {
        const char = input[index];
        if (inQuotes) {
            if (char === '"') {
                if (input[index + 1] === '"') {
                    field += '"';
                    index += 1;
                } else {
                    inQuotes = false;
                }
            } else {
                field += char;
            }
            continue;
        }

        if (char === '"') {
            inQuotes = true;
        } else if (char === ",") {
            row.push(field);
            field = "";
        } else if (char === "\n") {
            row.push(field);
            rows.push(row);
            row = [];
            field = "";
        } else if (char === "\r") {
            if (input[index + 1] === "\n") index += 1;
            row.push(field);
            rows.push(row);
            row = [];
            field = "";
        } else {
            field += char;
        }
    }

    if (inQuotes) throw new Error("CSV has an unclosed quoted field.");
    if (field.length > 0 || row.length > 0) {
        row.push(field);
        rows.push(row);
    }
    return rows.filter((candidate) => candidate.length > 1 || candidate[0] !== "");
}

function recordFromRow(header, row) {
    return Object.fromEntries(
        header.map((column, index) => [column, unescapeSpreadsheetFormula(row[index] ?? "")]),
    );
}

function rowId(record) {
    return `${record.area}\0${record.source_file}\0${record.key}`;
}

function placeholders(value) {
    return Array.from(value.matchAll(/\{([A-Za-z0-9_]+)\}/g), (match) => match[0]);
}

function codicons(value) {
    return Array.from(value.matchAll(/\$\([^)]+\)/g), (match) => match[0]).sort();
}

function readJsonAbsolute(filePath) {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function detectIndent(text) {
    const match = text.match(/\n( +)"/);
    return match ? match[1].length : 4;
}

function isStringMap(value) {
    return (
        value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        Object.values(value).every((item) => typeof item === "string")
    );
}

function log(message) {
    if (!quiet) console.log(message);
}
