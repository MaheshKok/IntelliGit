## Localization Workflow

- This repository ships static localization catalogs. Do not add runtime translation inside the VS Code extension.
- The localization CSV is the source of truth for reviewed translations:
  - `docs/localization_translation_review.csv`
- Use Google Sheets with `GOOGLETRANSLATE` for low-cost draft translations when needed, then pull the resolved values back into the CSV and import through the repo validation pipeline.
- Do not trust spreadsheet output directly. Google Sheets can translate or remove protected runtime tokens such as `{message}`, `{path}`, `{count}`, `$(edit)`, `$(add)`, `origin`, `.git/config`, `Git`, `VS Code`, and `IntelliGit`.
- Always import through `scripts/localization-csv.js` so placeholder, codicon, plural, literal-token, and catalog-sync validation can catch broken translations.

## Localization Alternatives

- Google Sheets is the preferred low-cost draft translation path for this repository.
- Local/offline translation tools such as Argos Translate, LibreTranslate, Marian, or NLLB can avoid API cost, but quality and setup are weaker for product/UI strings.
- Translation platforms such as Weblate, Crowdin, and Transifex are useful for human review and glossary workflows, but may introduce cost or process overhead.
- Paid APIs such as Google Cloud Translation, DeepL, or Azure Translator are suitable for automation but should not be added unless explicitly approved.
- Native/screenshot review is still required before calling machine-generated translations production-quality.

## Commit Checklist For English UI Strings

- Before committing changes that add or modify user-facing English strings, run the localization pipeline before final validation/build checks.
- Required localization commands, once available in the repo, are:
  - `bun run l10n:sync`
  - `bun run l10n:translate -- --only-missing`
  - `bun run l10n:import`
  - `bun scripts/localization-csv.js validate`
- If any listed localization command is missing from `package.json`, do not pretend it ran. State that the command is unavailable and run the closest existing localization validation command instead.
- Current existing commands include:
  - `bun run l10n:import`
  - `bun run l10n:validate`
  - `bun scripts/localization-csv.js validate`

## Pre-Commit Validation

- Before committing code changes, run the smallest relevant focused tests first, then run the standard validation set:
  - `bun run format:check`
  - `bun run lint`
  - `bun run react-doctor`
  - `bun run typecheck`
  - `bun run build`
  - `bun run test`
- For localization or user-facing string changes, also run:
  - `bun run l10n:validate`
  - `bun run l10n:audit`
- For release, marketplace, packaging, or production-bundle changes, also run:
  - `bun run build:prod`
  - `bun run package`
- `bun run test:coverage` is not required for every commit. Run it when changes affect shared behavior, test coverage is in question, or coverage-sensitive work is requested.
- Do not run `bun run publish` unless the user explicitly asks to publish the extension.
- Do not claim a validation passed unless it actually ran. If a command cannot run, state the reason and the risk.
