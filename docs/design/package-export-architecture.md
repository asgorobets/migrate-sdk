# Package Export Architecture

Status: implemented for current first-party source and store subpaths

Audience: maintainers shaping the public SDK surface.

This document captures the package and export architecture used after the CSV
source proved the first real source shape.

## Reference Pattern

Effect smol is the architectural reference:

- one main domain package for core modules
- focused subpath exports for public modules
- `sideEffects: []` for tree-shaking
- blocked `internal/*` paths in package exports
- separate platform packages only for real runtime or dependency boundaries

For `migrate-sdk`, the equivalent is one installable package for the migration
runtime, domain types, stores, and first-party sources while the dependency
graph allows it.

## Current Shape

The SDK package remains:

```txt
migrate-sdk
```

First-party sources live under feature folders inside that package:

```txt
packages/migrate-sdk/src/sources/csv/
packages/migrate-sdk/src/destinations/in-memory/
packages/migrate-sdk/src/stores/file/
```

Each public feature folder owns an `index.ts` entrypoint. Private implementation
helpers should live under local `internal/` folders or remain unexported from
the feature entrypoint.

Testing helpers, fixtures, and inspection-only types must not be exported from
the root entrypoint or the normal feature entrypoint. If they are intentionally
supported, expose them from an explicit testing subpath.

Runnable examples live outside `src/` under `packages/migrate-sdk/examples/` so
the library source tree contains only package implementation and public
entrypoints. The library `tsconfig.json` remains scoped to publishable source
files; examples and tests are typechecked through `tsconfig.check.json`.

## Public Imports

The default entrypoint stays the ergonomic public surface:

```ts
import {
  MigrationDefinition,
  MigrationDefinitionRegistry,
  MigrationExecution,
} from "migrate-sdk";
```

Subpath exports are allowed for focused imports and optional dependency
isolation:

```ts
import { MigrationDefinition, Source } from "migrate-sdk/core";
import { CsvSource } from "migrate-sdk/sources/csv";
import { FileMigrationStore } from "migrate-sdk/stores/file";
```

The `core` subpath carries domain definitions, service tags, and authoring
helpers such as `Source.make` without re-exporting concrete source or
store implementations. Adapter-facing execution engine services, such as
`MigrationRunStepExecutor`, also live there instead of the root entrypoint.
These subpaths still point into the same package.

Lower-level runtime primitives remain available from the runtime subpath, but
direct definition run/rollback helpers are not part of the public path:

```ts
import {
  emptyMigrationRunCursorWindowState,
  type MigrationRunCursorWindowInput,
  type MigrationRunExecutionLease,
} from "migrate-sdk/runtime";
```

Testing helpers use explicit testing subpaths:

```ts
import { InMemoryDestinationTesting } from "migrate-sdk/destinations/in-memory/testing";
import { TestDurableMigrationExecutable } from "migrate-sdk/testing";
```

## Export Map

`packages/migrate-sdk/package.json` uses a curated export map:

```json
{
  "sideEffects": [],
  "exports": {
    ".": "./src/index.ts",
    "./core": "./src/core.ts",
    "./destinations/in-memory": "./src/destinations/in-memory/index.ts",
    "./destinations/in-memory/testing": "./src/destinations/in-memory/testing.ts",
    "./internal/*": null,
    "./sources/csv": "./src/sources/csv/index.ts",
    "./sources/document": "./src/sources/document/index.ts",
    "./sources/in-memory": "./src/sources/in-memory/index.ts",
    "./sources/sql": "./src/sources/sql/index.ts",
    "./runtime": "./src/runtime/index.ts",
    "./stores/file": "./src/stores/file/index.ts",
    "./stores/in-memory": "./src/stores/in-memory/index.ts",
    "./testing": "./src/testing.ts",
    "./*/internal/*": null
  }
}
```

Use curated subpaths instead of Effect's broad `./*` export pattern for now.
Effect's top-level source files are already shaped as public modules; this SDK
still has domain, runtime, service, store, and source implementation details in
folder trees that should not all become public by accident.

## Split-Package Rule

Do not create separate packages for first-party sources merely because they are
sources. Split only when a platform or dependency boundary makes one package
materially worse.

Examples that may justify a separate package later:

- a browser-only or Node-only runtime implementation
- a destination with a heavy vendor SDK dependency that should stay
  optional for most users
- a store implementation that depends on a database driver or platform runtime

CSV does not cross that line. It belongs in the main `migrate-sdk` package.

## Compatibility Rules

Keep the public surface compatible for the SDK's two core audiences:

- Migration authors get the ergonomic root entrypoint for definitions,
  registries, domain types, and the registry-bound `MigrationExecution` facade.
- Raw runtime helpers stay available for compatibility and small tests from
  `migrate-sdk/runtime`, not from the root entrypoint.
- Source authors continue to get definition helpers, service tags, domain types,
  and typed errors from the root entrypoint.
- Adapter authors use `migrate-sdk/core` for lower-level execution services and
  workflow/cursor-window primitives.
- First-party sources and stores also expose focused subpaths, such as
  `migrate-sdk/sources/csv` and `migrate-sdk/stores/file`.
- Testing and inspection helpers use explicit `*/testing` subpaths and stay out
  of root and normal feature entrypoints.
- Feature entrypoints should explicitly re-export their public API rather than
  using wildcard barrels.
- Avoid export-surface tests; verify the public shape through examples,
  behavior tests, and typecheck.
