# Package Export Architecture

Status: follow-up after CSV source plugin tracer bullet

Audience: maintainers shaping the public SDK surface.

This document captures the package and export architecture to refactor toward
after the CSV source plugin proves the first real plugin shape.

## Reference Pattern

Effect smol is the architectural reference:

- one main domain package for core modules
- focused subpath exports for public modules
- `sideEffects: []` for tree-shaking
- blocked `internal/*` paths in package exports
- separate platform packages only for real runtime or dependency boundaries

For `migrate-sdk`, the equivalent is one installable package for the migration
runtime, domain types, stores, and first-party plugins while the dependency
graph allows it.

## Target Shape

The SDK package remains:

```txt
migrate-sdk
```

First-party plugins live under feature folders inside that package:

```txt
packages/migrate-sdk/src/sources/csv/
packages/migrate-sdk/src/destinations/in-memory/
packages/migrate-sdk/src/stores/file/
```

Each public feature folder owns an `index.ts` entrypoint. Private implementation
helpers should live under local `internal/` folders or remain unexported from
the feature entrypoint.

## Public Imports

The default entrypoint stays the ergonomic public surface:

```ts
import { CsvSourcePlugin, defineMigration, runMigration } from "migrate-sdk";
```

Subpath exports are allowed for focused imports and optional dependency
isolation:

```ts
import { CsvSourcePlugin } from "migrate-sdk/sources/csv";
import { FileMigrationStore } from "migrate-sdk/stores/file";
```

These subpaths still point into the same package.

## Export Map Direction

After the CSV source plugin lands, refactor `packages/migrate-sdk/package.json`
toward a curated export map:

```json
{
  "sideEffects": [],
  "exports": {
    ".": "./src/index.ts",
    "./sources/csv": "./src/sources/csv/index.ts",
    "./destinations/in-memory": "./src/destinations/in-memory/index.ts",
    "./stores/file": "./src/stores/file/index.ts",
    "./stores/in-memory": "./src/stores/in-memory/index.ts",
    "./internal/*": null,
    "./*/internal/*": null
  }
}
```

Use curated subpaths instead of Effect's broad `./*` export pattern for now.
Effect's top-level source files are already shaped as public modules; this SDK
still has domain, runtime, service, store, and plugin implementation details in
folder trees that should not all become public by accident.

## Split-Package Rule

Do not create separate packages for first-party plugins merely because they are
plugins. Split only when a platform or dependency boundary makes one package
materially worse.

Examples that may justify a separate package later:

- a browser-only or Node-only runtime implementation
- a destination plugin with a heavy vendor SDK dependency that should stay
  optional for most users
- a store implementation that depends on a database driver or platform runtime

CSV does not cross that line. It belongs in the main `migrate-sdk` package.

## Follow-Up Scope

Do this refactor after the CSV source plugin tracer bullet:

- add public `index.ts` files for plugin/store feature folders
- add curated package subpath exports
- block `internal/*` package imports
- keep the root `src/index.ts` explicit and user-oriented
- avoid export-surface tests; verify through examples and behavior tests
