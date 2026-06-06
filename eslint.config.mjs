import js from "@eslint/js";
import globals from "globals";
import path from "node:path";
import { fileURLToPath } from "node:url";
import jsdoc from "eslint-plugin-jsdoc";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import sonarjs from "eslint-plugin-sonarjs";
import tsdoc from "eslint-plugin-tsdoc";
import tseslint from "typescript-eslint";
import { defineConfig } from "eslint/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const EXTENSION_TS_FILES = ["src/**/*.ts"];
const WEBVIEW_REACT_FILES = ["src/webviews/react/**/*.{ts,tsx}"];
const TSDOC_LOCKED_EXTENSION_FILES = [
    "src/types.ts",
    "src/git/**/*.ts",
    "src/webviews/protocol/**/*.ts",
    "src/services/**/*.ts",
    "src/extension.ts",
    "src/activation/**/*.ts",
    "src/commands/**/*.ts",
    "src/views/**/*.ts",
    "src/utils/**/*.ts",
    "src/mergeEditor/**/*.ts",
    "src/webviews/i18n/**/*.ts",
];
const TSDOC_LOCKED_REACT_FILES = ["src/webviews/react/**/*.{ts,tsx}"];
const SCRIPT_FILES = ["scripts/**/*.js"];
const TYPED_TS_FILES = ["src/**/*.ts", "src/webviews/react/**/*.{ts,tsx}"];

const typeCheckedConfigs = tseslint.configs.recommendedTypeChecked.map((config) => ({
    ...config,
    files: TYPED_TS_FILES,
}));

const typeAwareSafetyRules = {
    "@typescript-eslint/await-thenable": "error",
    "@typescript-eslint/no-base-to-string": "error",
    "@typescript-eslint/no-floating-promises": "error",
    "@typescript-eslint/no-misused-promises": "error",
    "@typescript-eslint/no-unnecessary-type-assertion": "error",
    "@typescript-eslint/no-unsafe-argument": "error",
    "@typescript-eslint/no-unsafe-assignment": "error",
    "@typescript-eslint/no-unsafe-call": "error",
    "@typescript-eslint/no-unsafe-member-access": "error",
    "@typescript-eslint/no-unsafe-return": "error",
    "@typescript-eslint/require-await": "error",
};

const tsdocSyntaxRules = {
    "tsdoc/syntax": "error",
};

const jsdocTypeScriptSettings = {
    jsdoc: {
        mode: "typescript",
    },
};

const jsdocContractRules = {
    "jsdoc/check-param-names": "error",
    "jsdoc/check-tag-names": "off",
    "jsdoc/no-types": "error",
    "jsdoc/require-description": "error",
    "jsdoc/require-param": "off",
    "jsdoc/require-returns": "off",
};

const requireExportDocsRules = {
    "jsdoc/require-jsdoc": [
        "error",
        {
            publicOnly: {
                esm: true,
                cjs: false,
                window: false,
            },
            require: {
                ClassDeclaration: true,
                FunctionDeclaration: true,
                MethodDefinition: true,
            },
            contexts: [
                "ExportNamedDeclaration > TSInterfaceDeclaration",
                "ExportNamedDeclaration > TSTypeAliasDeclaration",
                "ExportNamedDeclaration > TSEnumDeclaration",
                "ExportNamedDeclaration > VariableDeclaration",
            ],
        },
    ],
};

const requireReactExportDocsRules = {
    "jsdoc/require-jsdoc": [
        "error",
        {
            require: {
                ArrowFunctionExpression: false,
                ClassDeclaration: false,
                ClassExpression: false,
                FunctionDeclaration: false,
                FunctionExpression: false,
                MethodDefinition: false,
            },
            contexts: [
                "ExportNamedDeclaration > TSInterfaceDeclaration",
                "ExportNamedDeclaration > TSTypeAliasDeclaration",
                "ExportNamedDeclaration > TSEnumDeclaration",
                "ExportNamedDeclaration > FunctionDeclaration[id.name=/^use[A-Z]/]",
            ],
        },
    ],
};

const sonarRules = {
    "sonarjs/cognitive-complexity": ["error", 40],
    "sonarjs/no-all-duplicated-branches": "warn",
    "sonarjs/no-collapsible-if": "warn",
    "sonarjs/no-duplicated-branches": "warn",
    "sonarjs/no-identical-conditions": "warn",
    "sonarjs/no-identical-expressions": "warn",
    "sonarjs/no-inverted-boolean-check": "warn",
    "sonarjs/no-nested-switch": "warn",
    "sonarjs/no-redundant-boolean": "warn",
    "sonarjs/prefer-single-boolean-return": "warn",
};

export default defineConfig([
    {
        ignores: ["dist/**", "coverage/**", "node_modules/**", "*.vsix"],
    },
    {
        files: SCRIPT_FILES,
        ...js.configs.recommended,
        languageOptions: {
            ...js.configs.recommended.languageOptions,
            ecmaVersion: "latest",
            sourceType: "commonjs",
            globals: globals.node,
        },
        plugins: {
            sonarjs,
        },
        rules: {
            ...js.configs.recommended.rules,
            ...sonarRules,
        },
    },
    ...typeCheckedConfigs,
    {
        files: EXTENSION_TS_FILES,
        ignores: ["src/webviews/react/**"],
        languageOptions: {
            parserOptions: {
                project: "./tsconfig.json",
                tsconfigRootDir: __dirname,
            },
            globals: globals.node,
        },
        plugins: {
            jsdoc,
            sonarjs,
            tsdoc,
        },
        settings: jsdocTypeScriptSettings,
        rules: {
            "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
            ...typeAwareSafetyRules,
            ...tsdocSyntaxRules,
            ...sonarRules,
        },
    },
    {
        files: TSDOC_LOCKED_EXTENSION_FILES,
        ignores: ["src/webviews/react/**"],
        settings: jsdocTypeScriptSettings,
        rules: {
            ...jsdocContractRules,
            ...requireExportDocsRules,
        },
    },
    {
        files: WEBVIEW_REACT_FILES,
        languageOptions: {
            parserOptions: {
                project: "./tsconfig.webview.json",
                tsconfigRootDir: __dirname,
                ecmaFeatures: {
                    jsx: true,
                },
            },
            globals: globals.browser,
        },
        plugins: {
            jsdoc,
            react,
            "react-hooks": reactHooks,
            sonarjs,
            tsdoc,
        },
        settings: {
            ...jsdocTypeScriptSettings,
            react: {
                version: "18.2.0",
            },
        },
        rules: {
            ...react.configs.flat.recommended.rules,
            ...react.configs.flat["jsx-runtime"].rules,
            "react/prop-types": "off",
            "react-hooks/rules-of-hooks": "error",
            "react-hooks/exhaustive-deps": "warn",
            "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
            ...typeAwareSafetyRules,
            ...tsdocSyntaxRules,
            ...sonarRules,
            "@typescript-eslint/no-misused-promises": [
                "error",
                {
                    checksVoidReturn: {
                        attributes: false,
                    },
                },
            ],
        },
    },
    {
        files: TSDOC_LOCKED_REACT_FILES,
        settings: {
            ...jsdocTypeScriptSettings,
            react: {
                version: "18.2.0",
            },
        },
        rules: {
            ...jsdocContractRules,
            ...requireReactExportDocsRules,
        },
    },
]);
