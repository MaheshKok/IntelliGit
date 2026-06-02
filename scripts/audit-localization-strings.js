#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const ts = require("typescript");

const repoRoot = path.resolve(__dirname, "..");
const strict = process.argv.includes("--strict");
const reportIndex = process.argv.indexOf("--write-report");
let reportPath = "";
if (reportIndex !== -1) {
    const reportArg = process.argv[reportIndex + 1];
    if (!reportArg || reportArg.startsWith("--")) {
        console.error("--write-report requires a file path argument.");
        process.exit(1);
    }
    reportPath = path.resolve(repoRoot, reportArg);
}

const userTextPropertyNames = new Set([
    "aria-label",
    "description",
    "detail",
    "label",
    "openLabel",
    "placeHolder",
    "placeholder",
    "prompt",
    "title",
]);

const messageMethods = new Set([
    "showErrorMessage",
    "showInformationMessage",
    "showWarningMessage",
]);

const skippedPathParts = [
    `${path.sep}src${path.sep}webviews${path.sep}i18n${path.sep}`,
    `${path.sep}src${path.sep}webviews${path.sep}react${path.sep}shared${path.sep}i18n.ts`,
];

const findings = [];

for (const filePath of sourceFiles(path.join(repoRoot, "src"))) {
    if (skippedPathParts.some((part) => filePath.includes(part))) continue;
    auditFile(filePath);
}

const report = renderReport(findings);
if (reportPath) {
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, report, "utf8");
}

console.log(
    `Hardcoded localization audit: ${findings.length} candidate${findings.length === 1 ? "" : "s"} found.`,
);
if (reportPath) console.log(`Report written to ${path.relative(repoRoot, reportPath)}.`);
if (!reportPath && findings.length > 0) console.log(report);
if (strict && findings.length > 0) process.exit(1);

function auditFile(filePath) {
    const text = fs.readFileSync(filePath, "utf8");
    const sourceFile = ts.createSourceFile(
        filePath,
        text,
        ts.ScriptTarget.Latest,
        true,
        filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );

    visit(sourceFile);

    function visit(node) {
        if (ts.isCallExpression(node)) {
            auditMessageCall(filePath, sourceFile, node);
            auditObjectArgument(filePath, sourceFile, node);
        }
        if (ts.isJsxAttribute(node)) auditJsxAttribute(filePath, sourceFile, node);
        if (ts.isJsxText(node)) auditJsxText(filePath, sourceFile, node);
        ts.forEachChild(node, visit);
    }
}

function auditMessageCall(filePath, sourceFile, node) {
    const methodName = callMethodName(node.expression);
    if (!messageMethods.has(methodName)) return;

    const firstArg = node.arguments[0];
    if (!firstArg || isLocalizedExpression(firstArg)) return;

    const text = expressionText(firstArg, sourceFile);
    if (!looksUserFacing(text)) return;

    addFinding({
        filePath,
        sourceFile,
        node: firstArg,
        surface: `vscode.window.${methodName}`,
        text,
    });
}

function auditObjectArgument(filePath, sourceFile, node) {
    for (const argument of node.arguments) {
        if (!ts.isObjectLiteralExpression(argument)) continue;
        auditObjectLiteral(filePath, sourceFile, argument);
    }
}

function auditObjectLiteral(filePath, sourceFile, objectLiteral) {
    for (const property of objectLiteral.properties) {
        if (!ts.isPropertyAssignment(property)) continue;
        const name = propertyName(property.name);
        if (!userTextPropertyNames.has(name)) continue;
        const initializer = property.initializer;
        if (isLocalizedExpression(initializer)) continue;

        const text = expressionText(initializer, sourceFile);
        if (!looksUserFacing(text)) continue;

        addFinding({
            filePath,
            sourceFile,
            node: initializer,
            surface: `object.${name}`,
            text,
        });
    }
}

function auditJsxAttribute(filePath, sourceFile, node) {
    const name = node.name.getText(sourceFile);
    if (!userTextPropertyNames.has(name)) return;
    if (!node.initializer) return;

    if (ts.isStringLiteral(node.initializer)) {
        if (!looksUserFacing(node.initializer.text)) return;
        addFinding({
            filePath,
            sourceFile,
            node: node.initializer,
            surface: `jsx.${name}`,
            text: node.initializer.text,
        });
        return;
    }

    if (!ts.isJsxExpression(node.initializer)) return;
    const expression = node.initializer.expression;
    if (!expression || isLocalizedExpression(expression)) return;

    const text = expressionText(expression, sourceFile);
    if (!looksUserFacing(text)) return;

    addFinding({
        filePath,
        sourceFile,
        node: expression,
        surface: `jsx.${name}`,
        text,
    });
}

function auditJsxText(filePath, sourceFile, node) {
    const text = node.getText(sourceFile).replace(/\s+/g, " ").trim();
    if (!looksUserFacing(text)) return;
    addFinding({
        filePath,
        sourceFile,
        node,
        surface: "jsx.text",
        text,
    });
}

function addFinding({ filePath, sourceFile, node, surface, text }) {
    const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    findings.push({
        file: path.relative(repoRoot, filePath),
        line: position.line + 1,
        surface,
        text: collapse(text),
    });
}

function callMethodName(expression) {
    if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
    return "";
}

function propertyName(name) {
    if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
    return name.getText();
}

function isLocalizedExpression(expression) {
    if (ts.isCallExpression(expression)) {
        return isLocalizationCallee(expression.expression);
    }

    if (ts.isConditionalExpression(expression)) {
        return (
            isLocalizedExpression(expression.whenTrue) &&
            isLocalizedExpression(expression.whenFalse)
        );
    }

    return false;
}

function isLocalizationCallee(expression) {
    if (ts.isIdentifier(expression)) return expression.text === "t";

    if (!ts.isPropertyAccessExpression(expression) || expression.name.text !== "t") {
        return false;
    }

    const receiver = expression.expression;
    if (ts.isIdentifier(receiver)) return receiver.text === "l10n";

    return (
        ts.isPropertyAccessExpression(receiver) &&
        receiver.name.text === "l10n" &&
        ts.isIdentifier(receiver.expression) &&
        receiver.expression.text === "vscode"
    );
}

function expressionText(expression, sourceFile) {
    if (ts.isStringLiteralLike(expression)) return expression.text;
    if (ts.isNoSubstitutionTemplateLiteral(expression)) return expression.text;
    if (ts.isTemplateExpression(expression)) return expression.getText(sourceFile);
    if (ts.isConditionalExpression(expression)) return expression.getText(sourceFile);
    return "";
}

function looksUserFacing(text) {
    if (!text) return false;
    const collapsed = collapse(text);
    if (!/[A-Za-z]{2,}/.test(collapsed)) return false;
    if (/^git@[^:\s]+:[^\s]+$/i.test(collapsed)) return false;
    if (/^HEAD(?:[~^]\d*)?$/i.test(collapsed)) return false;
    if (/^(data-|aria-|--|#|\.|\/|[a-z]+:\/\/)/i.test(collapsed)) return false;
    if (/^[a-z0-9_.:-]+$/i.test(collapsed)) return false;
    return true;
}

function collapse(text) {
    return text.replace(/\s+/g, " ").trim();
}

function renderReport(items) {
    const lines = [
        "# Localization Hardcoded String Audit",
        "",
        "This report is generated by `bun run l10n:audit -- --write-report docs/localization_hardcoded_string_audit.md`.",
        "It lists candidate user-facing English strings that are not obviously wrapped in `vscode.l10n.t(...)` or webview `t(...)`.",
        "",
        `Candidate count: ${items.length}`,
        "",
    ];

    if (items.length === 0) {
        lines.push("No candidates found.", "");
        return lines.join("\n");
    }

    lines.push("| File | Line | Surface | Candidate |", "|---|---:|---|---|");
    for (const item of items) {
        lines.push(
            `| \`${item.file}\` | ${item.line} | \`${item.surface}\` | ${escapeMarkdown(item.text)} |`,
        );
    }
    lines.push("");
    return lines.join("\n");
}

function escapeMarkdown(text) {
    return text.replace(/\|/g, "\\|").replace(/`/g, "\\`");
}

function sourceFiles(directory) {
    const files = [];
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            files.push(...sourceFiles(entryPath));
        } else if (/\.(ts|tsx)$/.test(entry.name)) {
            files.push(entryPath);
        }
    }
    return files.sort();
}
