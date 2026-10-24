# Shipped schema-1 shelf service adversary

The checked-in `shelfService.cjs` is the exact shipped-service bundle. The integration test verifies its SHA-256 and byte count against `manifest.json` before loading it. Normal test runs require no historical Git objects, including shallow CI checkouts and source copies without `.git`.

For manual reproducibility, `node tests/fixtures/shelf-v1/build.mjs OUTPUT_DIRECTORY` rebuilds the service and its 46 transitive source files from Git objects at `23464b48c7d47ae4f83429898c6df49b56faf0d3`. This recipe requires that revision in local Git history and the manifest's esbuild version. It does not read current implementation files. Compare the rebuilt bundle SHA-256 and byte count with the checked-in manifest; do not format or rewrite the fixture bytes.

The generated CommonJS file exposes the actual old service, store, executor, shared mutation gate, lock, coordinator, and path resolver. Runtime external imports remain external; no implementation or parser is mocked. The `vscode` import is optional in this baseline and the fixture invokes no VS Code API.

`catalog-only upgrade lets old cached rename replace current before refusing` proves why catalog publication alone is unsafe. It is a baseline counterexample, not proof of the pending all-pointer migration. Restore/delete, interrupted migration, and foreign new-ID capture adversaries remain part of Task 3's migration seam.
