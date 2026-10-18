# Schema 4 baseline client fixture

`changelistStore.cjs` is built from Git object
`23464b48c7d47ae4f83429898c6df49b56faf0d3`. The generator begins at
`src/changes/changelistStore.ts` and resolves every relative transitive source
from that same Git object with `git show`; it never reads current TypeScript
sources.

With that Git object and the repository dependencies already available, rebuild
the fixture offline from the repository root:

```sh
bun tests/fixtures/changes/schema4/generate.mjs
```

The generator requires esbuild `0.28.2`, writes the CommonJS bundle and
manifest, and records the bundle SHA-256. Tests independently assert the pinned
revision and checksum before loading the old client.
