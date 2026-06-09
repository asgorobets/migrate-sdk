# Migration Definition Registry and CLI API

Audience: SDK users who want registry-backed execution and CLI users running
application migrations.

This design uses a static `MigrationDefinitionRegistry` as the executable
definition catalog consumed by the SDK and CLI. Future serializable specs or
low-code workflows may produce executable migration definitions before the
registry is initialized, but the registry itself is static from the runner's
point of view.

## Registry Authoring

Application code exports one registry value:

```ts
import { MigrationDefinitionRegistry } from "migrate-sdk";
import { articles } from "./migrations/articles.ts";
import { authors } from "./migrations/authors.ts";

export const migrations = MigrationDefinitionRegistry.make({
  definitions: [authors, articles],
});
```

Do not use subclassing in the first slice:

```ts
// Not first-slice public API.
class AppMigrations extends MigrationDefinitionRegistry.make({
  definitions: [authors, articles],
}) {}
```

Do not use an ambient global registry as the primary API. Discovery or low-code
flows can collect definitions elsewhere and then initialize this static registry.

## Definition Dependency Shape

Migration definitions should distinguish required and optional ordering
dependencies:

```ts
interface MigrationDefinitionDependenciesInput {
  readonly required?: readonly MigrationDefinitionIdInput[];
  readonly optional?: readonly MigrationDefinitionIdInput[];
}
```

Required dependencies are hard ordering prerequisites. Optional dependencies are
ordering preferences when both definitions participate in the same selected run
or full-registry run.

```ts
const articles = defineMigration({
  id: "articles",
  dependencies: {
    required: ["authors"],
    optional: ["asset-cleanup"],
  },
  // source, destination, store, pipeline...
});
```

The existing `dependsOn` property can remain a compatibility shorthand for
`dependencies.required` while the public API transitions:

```ts
const articles = defineMigration({
  id: "articles",
  dependsOn: ["authors"],
  // source, destination, store, pipeline...
});
```

`MigrationReferenceLookup` relationships are separate runtime reference
relationships. They may be cyclic and may use destination stubs; they are not
ordering dependencies unless the migration definition also declares them in
`dependencies`.

## Registry Construction

`MigrationDefinitionRegistry.make` is lazy and synchronous. It performs only
pure catalog validation:

- duplicate definition ids
- required dependency ids that are missing from the full registry graph
- required dependency cycles in the full registry graph

Hard catalog validation failures are collected and thrown synchronously as one
schema-backed construction error. This matches the existing static builder style
and keeps invalid executable catalogs from escaping module initialization. CLI
config loading catches the thrown error and renders all registry construction
issues at the command boundary.

```ts
type MigrationDefinitionRegistryConstructionIssue =
  | {
      readonly _tag: "DuplicateMigrationDefinitionId";
      readonly definitionId: MigrationDefinitionId;
    }
  | {
      readonly _tag: "MissingRequiredMigrationDefinitionDependency";
      readonly definitionId: MigrationDefinitionId;
      readonly dependencyId: MigrationDefinitionId;
    }
  | {
      readonly _tag: "RequiredMigrationDefinitionDependencyCycle";
      readonly definitionIds: readonly [
        MigrationDefinitionId,
        ...MigrationDefinitionId[],
      ];
    };

class MigrationDefinitionRegistryConstructionError extends Error {
  readonly _tag: "MigrationDefinitionRegistryConstructionError";
  readonly issues: readonly [
    MigrationDefinitionRegistryConstructionIssue,
    ...MigrationDefinitionRegistryConstructionIssue[],
  ];
}
```

It does not acquire locks, read migration stores, initialize source or
destination layers, inspect rollbackable state, or perform runtime preflight.
Optional dependencies are ordering preferences when both definitions participate
in the selected run. Optional dependencies do not make the registry invalid when
the referenced definition is omitted, optional dependency cycles do not make the
registry invalid, and optional dependencies do not model lookup or stub
relationships. Missing optional dependency ids are retained as unresolved
optional edges for inspection commands.

Raw `runMigrations` and `rollbackMigrations` remain public lower-level SDK
primitives. They keep request-scoped validation because callers can bypass the
registry and pass raw definitions directly.

Registry-backed rollback helpers delegate to `rollbackMigrations` with the full
registry definition graph and the planned selected definition ids. This keeps
dependent rollback safety in the existing lower-level preflight, where
rollbackable durable item state and unselected dependents are visible.

## Public SDK Shape

```ts
import type { Effect, Option } from "effect";

interface MigrationDefinitionRegistryInput<
  Definitions extends readonly AnyMigrationDefinition[],
> {
  readonly definitions: Definitions;
}

class MigrationDefinitionRegistry<
  Definitions extends
    readonly AnyMigrationDefinition[] = readonly AnyMigrationDefinition[],
> {
  static make<const Definitions extends readonly AnyMigrationDefinition[]>(
    input: MigrationDefinitionRegistryInput<Definitions>
  ): MigrationDefinitionRegistry<Definitions>;

  list(): readonly MigrationDefinitionRegistryEntry[];
  definitions(): Definitions;

  get(
    definitionId: MigrationDefinitionIdInput
  ): Option.Option<AnyMigrationDefinition>;

  require(
    definitionId: MigrationDefinitionIdInput
  ): Effect.Effect<
    AnyMigrationDefinition,
    MigrationDefinitionRegistryLookupError
  >;

  planRun(
    input: MigrationDefinitionRegistryRunInput
  ): Effect.Effect<
    MigrationDefinitionRunPlan,
    MigrationDefinitionRegistryPlanningError
  >;

  run(
    input: MigrationDefinitionRegistryRunInput
  ): Effect.Effect<MigrationRunSummary, MigrationDefinitionRegistryRunError>;

  planRollback(
    input: MigrationDefinitionRegistryRollbackInput
  ): Effect.Effect<
    MigrationDefinitionRollbackPlan,
    MigrationDefinitionRegistryPlanningError
  >;

  rollback(
    input: MigrationDefinitionRegistryRollbackInput
  ): Effect.Effect<
    RollbackRunSummary,
    MigrationDefinitionRegistryRollbackError
  >;
}
```

`MigrationDefinitionRegistryLookupError` is a typed Effect error with the
missing `definitionId`.

`list()` is metadata-oriented for CLI and UI rendering:

```ts
interface MigrationDefinitionRegistryEntry {
  readonly id: MigrationDefinitionId;
  readonly dependencies: {
    readonly required: readonly MigrationDefinitionId[];
    readonly optional: readonly MigrationDefinitionId[];
  };
  readonly hasRollback: boolean;
}
```

`dependencies.optional` includes declared optional dependency ids even when the
referenced definition is not registered in this registry. That lets inspection
commands render unresolved optional edges without treating them as runtime
scope.

`definitions()` returns executable definitions for SDK integrations and tests.

## Selection Input

Registry-backed execution requires explicit scope. Use `all: true` for full
registry execution, or provide at least one definition id.

```ts
type MigrationDefinitionRegistrySelectionInput =
  | {
      readonly all: true;
      readonly withDependencies?: boolean;
    }
  | {
      readonly definitionIds: readonly [
        MigrationDefinitionIdInput,
        ...MigrationDefinitionIdInput[],
      ];
      readonly withDependencies?: boolean;
    };
```

`withDependencies` defaults to `false`. When `all: true` is used,
`withDependencies` is accepted but redundant.

`withDependencies` expands only required dependencies. Optional dependencies do
not expand command scope; they only affect ordering when the optional dependency
is already included by explicit selection or by `all: true`.

The CLI exposes this as `--with-dependencies` only. The first slice does not add
a short alias because this flag expands execution scope.

Run input also carries failed/skipped run modes:

```ts
type MigrationDefinitionRegistryRunInput =
  MigrationDefinitionRegistrySelectionInput & {
    readonly mode?: Exclude<RunModeInput, { readonly kind: "item" }>;
    readonly sourceIdentities?: readonly SourceIdentityInput[];
  };
```

The CLI does not expose a generic `--mode` flag. It maps explicit run-mode flags
to registry input:

- no run-mode flag -> normal mode
- `--failed` -> `mode: { kind: "failed" }`
- `--skipped` -> `mode: { kind: "skipped" }`
- `--ids <identity>` -> `sourceIdentities: [identity]`

Only one run-mode flag may be used at a time. Future modes should follow the
same flag pattern, for example a future `--needs-update` flag.

`--ids` is the CLI shorthand for source identities. The SDK and registry plan
types keep the domain term `sourceIdentities`. The first slice exposes only
`--ids`, with no longer source-identity alias.

Supplying `sourceIdentities` on run input triggers item mode. It is valid only
with exactly one explicit definition id and exactly one unique source identity.
It cannot combine with `all: true`, multiple definition ids,
`withDependencies`, failed mode, or skipped mode.
Registry-backed run input does not accept `mode: { kind: "item" }`; item mode is
requested through `sourceIdentities` so the registry can validate definition
scope and target identity count before delegating to the lower-level runtime.

Rollback identity targeting is allowed only when exactly one definition id is
requested. The target identity belongs to that requested definition.

```ts
type MigrationDefinitionRegistryRollbackInput =
  MigrationDefinitionRegistrySelectionInput & {
    readonly sourceIdentities?: readonly SourceIdentityInput[];
  };
```

Supplying `sourceIdentities` on rollback input is valid only with exactly one
explicit definition id and one or more unique source identities. It rejects
`all: true`, multiple explicit definition ids, and `withDependencies`.

## Plans

Planning methods return structured data, not preformatted CLI messages.

```ts
interface MigrationDefinitionRunPlan {
  readonly kind: "run";
  readonly requestedDefinitionIds:
    | "all"
    | readonly MigrationDefinitionId[];
  readonly includedDefinitionIds: readonly MigrationDefinitionId[];
  readonly executionDefinitionIds: readonly MigrationDefinitionId[];
  readonly optionalDependencyEdges: readonly MigrationDefinitionDependencyEdge[];
  readonly definitions: readonly AnyMigrationDefinition[];
  readonly target?: MigrationDefinitionPlanTarget;
  readonly notices: readonly MigrationDefinitionPlanNotice[];
  readonly withDependencies: boolean;
}

interface MigrationDefinitionRollbackPlan {
  readonly kind: "rollback";
  readonly requestedDefinitionIds:
    | "all"
    | readonly MigrationDefinitionId[];
  readonly includedDefinitionIds: readonly MigrationDefinitionId[];
  readonly executionDefinitionIds: readonly MigrationDefinitionId[];
  readonly optionalDependencyEdges: readonly MigrationDefinitionDependencyEdge[];
  readonly definitions: readonly AnyRollbackMigrationDefinition[];
  readonly target?: MigrationDefinitionPlanTarget;
  readonly notices: readonly MigrationDefinitionPlanNotice[];
  readonly withDependencies: boolean;
}

interface MigrationDefinitionPlanTarget {
  readonly definitionId: MigrationDefinitionId;
  readonly sourceIdentities: readonly [SourceIdentity, ...SourceIdentity[]];
}

interface MigrationDefinitionDependencyEdge {
  readonly fromDefinitionId: MigrationDefinitionId;
  readonly toDefinitionId: MigrationDefinitionId;
  readonly kind: "required" | "optional";
}

type MigrationDefinitionPlanNotice =
  | MigrationDefinitionDuplicateRequestedDefinitionIgnored
  | MigrationDefinitionDuplicateTargetIdIgnored
  | MigrationDefinitionOptionalDependencyCycleIgnored;

interface MigrationDefinitionDuplicateRequestedDefinitionIgnored {
  readonly _tag: "MigrationDefinitionDuplicateRequestedDefinitionIgnored";
  readonly definitionId: MigrationDefinitionId;
}

interface MigrationDefinitionDuplicateTargetIdIgnored {
  readonly _tag: "MigrationDefinitionDuplicateTargetIdIgnored";
  readonly sourceIdentity: SourceIdentity;
}

interface MigrationDefinitionOptionalDependencyCycleIgnored {
  readonly _tag: "MigrationDefinitionOptionalDependencyCycleIgnored";
  readonly definitionIds: readonly MigrationDefinitionId[];
  readonly edges: readonly MigrationDefinitionDependencyEdge[];
}

type MigrationDefinitionRegistryRunError =
  | MigrationDefinitionRegistryPlanningError
  | RunMigrationError;

type MigrationDefinitionRegistryRollbackError =
  | MigrationDefinitionRegistryPlanningError
  | RollbackMigrationError;
```

For run plans, `executionDefinitionIds` are in forward dependency order. For
rollback plans, `executionDefinitionIds` are in reverse dependency order.
`optionalDependencyEdges` records optional dependency edges that participated in
ordering because both sides were already included in the plan.

Optional dependency cycles do not fail planning. When any optional cycle is
present, the planner ignores optional ordering for the whole plan, preserves
required-dependency ordering and registry order for optional relationships, and
records a `MigrationDefinitionOptionalDependencyCycleIgnored` notice. The plan
still reports every optional dependency edge whose endpoints are included.

Missing optional dependency ids do not fail planning and do not produce run or
rollback plan notices. They are registry inspection concerns, not command scope
concerns.

Registry errors should be structured enough for CLI renderers. Construction
errors are thrown by `MigrationDefinitionRegistry.make` as one aggregate error;
lookup and planning errors remain in Effect error channels:

```ts
type MigrationDefinitionRegistryError =
  | MigrationDefinitionRegistryConstructionError
  | MigrationDefinitionRegistryLookupError
  | MigrationDefinitionRegistryPlanningError;

interface MigrationDefinitionRegistryConstructionError {
  readonly _tag: "MigrationDefinitionRegistryConstructionError";
  readonly issues: readonly MigrationDefinitionRegistryConstructionIssue[];
}

type MigrationDefinitionRegistryConstructionIssue =
  | DuplicateMigrationDefinitionId
  | MissingRequiredMigrationDefinitionDependency
  | RequiredMigrationDefinitionDependencyCycle;

interface MigrationDefinitionRegistryLookupError {
  readonly _tag: "MigrationDefinitionRegistryLookupError";
  readonly definitionId: MigrationDefinitionId;
  readonly message: string;
}

type MigrationDefinitionRegistryPlanningError =
  | MigrationDefinitionRegistryUnknownDefinitionError
  | MigrationDefinitionRegistryMissingExplicitRequiredDependenciesError
  | MigrationDefinitionRegistryInvalidSelectionError;
```

Example missing explicit required dependency error:

```ts
interface MigrationDefinitionRegistryMissingExplicitRequiredDependenciesError {
  readonly definitionId: MigrationDefinitionId;
  readonly missingDependencyIds: readonly MigrationDefinitionId[];
}
```

For missing explicit required dependency errors, CLI renderers should include a
safe fixed-command suggestion:

```text
Cannot plan run.

articles requires authors.

Run one of:
migrate run authors articles
migrate run articles --with-dependencies
```

For rollback, prefer the scope-expanding flag first because required dependency
scope is easier to omit manually. The planner still normalizes execution order
for both explicit definitions and `--with-dependencies`.

```text
Cannot plan rollback.

articles requires authors.

Run one of:
migrate rollback articles --with-dependencies
migrate rollback authors articles
```

For errors where no safe automatic correction exists, render the structured
error without a suggested command.

## CLI Config

The CLI uses a CLI-only executable config module. The SDK exposes
`MigrationDefinitionRegistry`; the CLI package/export exposes
`defineMigrationCliConfig`.

```ts
// migrate.config.ts
import { defineMigrationCliConfig } from "migrate-sdk/cli";
import { migrations } from "./src/migrations.ts";

export default defineMigrationCliConfig({
  registry: migrations,
});
```

The first slice accepts only the config module's default export. Named config
exports are out of scope.

Public config shape:

```ts
interface MigrationCliConfig {
  readonly registry: MigrationDefinitionRegistry;
}

const defineMigrationCliConfig = <Config extends MigrationCliConfig>(
  config: Config
): Config => config;
```

`defineMigrationCliConfig` accepts a config object, not an async factory. Async
setup belongs in Effect layers and execution-time services, not CLI config
loading.

The first slice keeps CLI config to the registry only. Rendering options,
default flags, command aliases, and output customization are out of scope.

The first CLI config format is executable TS/JS module config. The CLI supports
loading `migrate.config.ts` and `migrate.config.mts` directly; users do not need
to precompile config files to JavaScript. The exact TypeScript loader is an
internal CLI implementation detail.

JSON, YAML, TOML, and INI config files are not suitable for the registry because
they cannot hold executable definitions, Effect layers, or functions. Those
structured file formats may be useful later for serializable Migration Specs.

Config loading catches errors thrown while importing the config module. Known
`MigrationDefinitionRegistryConstructionError` values are rendered with all
catalog issues:

```text
Failed to load migrate.config.ts

Registry has 3 hard errors:
- Duplicate migration definition id: articles
- articles requires authors, but authors is not registered
- Required dependency cycle: books -> offers -> books
```

Unknown config import failures are wrapped as config-load failures with the
config path and underlying cause.

One config file contains one registry. Multiple registries are modeled with
multiple config files:

```sh
migrate --config ./packages/cms/migrate.config.ts list
migrate --config ./packages/commerce/migrate.config.ts list
```

## Config Discovery

Config discovery rules:

1. If `--config` is passed, use exactly that file.
2. Otherwise, start from the process current working directory and search
   upward.
3. The nearest config wins.
4. Stop after checking the workspace root when it can be detected; otherwise
   stop at the filesystem root.
5. Never search downward into child packages.

Discovery checks these filenames in order:

```text
migrate.config.ts
migrate.config.mts
migrate.config.js
migrate.config.mjs
```

CommonJS config files are out of scope for the first slice. When `--config` is
passed, the CLI accepts any path and lets the config loader decide whether it can
import it.

In a monorepo:

```text
repo/
  migrate.config.ts
  packages/
    cms/
      migrate.config.ts
    commerce/
      migrate.config.ts
```

From `packages/cms`, the package config wins:

```sh
cd packages/cms
migrate list
# uses packages/cms/migrate.config.ts
```

From the repository root, the root config is used if present:

```sh
cd repo
migrate list
# uses repo/migrate.config.ts
```

If the root has no config, the CLI errors instead of choosing among nested
package configs.

`--config` paths resolve relative to the process current working directory.
Relative imports inside the config file resolve normally from the config file
location:

```ts
// packages/cms/migrate.config.ts
import { migrations } from "./src/migrations.ts";
```

## CLI Commands

The desired CLI ergonomics allow command flags after definition ids. Effect CLI
documents flag parsing before positional arguments, so implementation must
validate whether this requires a small argv normalization step before invoking
the Effect command parser.

Inspection commands:

```sh
migrate list
migrate graph
migrate graph articles
```

`list` renders static registry discovery metadata from `registry.list()`. It
does not run planning, read stores, initialize plugin layers, or inspect runtime
status. The default table includes definition id, rollback availability,
required dependencies, and optional dependencies:

```text
ID        Rollback  Required   Optional
authors   yes       -          -
articles  yes       authors    asset-cleanup
```

Unresolved optional dependencies are marked without failing the command:

```text
articles  yes       authors    legacy-assets (unresolved)
```

`list` does not include source or destination plugin columns in the first slice.
Those columns require explicit static plugin metadata and can be added when the
catalog view needs them.

`graph` is read-only dependency inspection. `migrate graph` renders the full
registry dependency graph. `migrate graph articles` renders the direct incoming
and outgoing dependency relationships around `articles`; it does not run
planning and does not use `--with-dependencies`. Unresolved optional dependency
edges are shown as unresolved optional edges.

A focused graph includes both directions:

- outgoing edges from the selected definition to its required and optional
  dependencies
- incoming edges from definitions that declare the selected definition as a
  required or optional dependency
- only one-hop direct edges, not transitive closure

Edges are labeled as required, optional, or unresolved optional.

The first slice renders graph output as a simple directional edge list:

```text
articles (required) --> authors
articles (optional) --> asset-cleanup
offers (required) --> articles
articles (optional unresolved) --> legacy-assets
```

Use an edge list instead of a visual tree because dependency graphs may contain
cycles and are not necessarily hierarchical.

Run commands:

```sh
migrate run articles
migrate run articles --plan
migrate run authors articles
migrate run articles --with-dependencies
migrate run articles --with-dependencies --plan
migrate run --all
migrate run --all --plan
migrate run --all --with-dependencies
migrate run articles --failed
migrate run articles --skipped
migrate run articles --ids article-1
migrate run articles --ids article-1 --plan
```

Rollback commands:

```sh
migrate rollback articles
migrate rollback articles --plan
migrate rollback authors articles
migrate rollback articles --with-dependencies
migrate rollback --all
migrate rollback --all --plan
migrate rollback --all --with-dependencies
migrate rollback articles --ids article-1
migrate rollback articles --ids article-1 --plan
migrate rollback articles --ids article-1,article-2
```

`--plan` is a CLI-only execution mode. It resolves command selection and
dependency ordering, prints what would be executed, and exits. It does not
acquire locks, read migration stores, initialize source or destination systems,
scan source items, inspect rollbackable state, or calculate migrated item
counts. Durable state inspection belongs to a future `status` command, not to
planning. `--plan` uses the same registry planning path as execution, so invalid
selection and dependency policy errors fail the same way they would without
`--plan`.

The first slice does not expose `--json` or another machine-readable output flag
for plan output. Tests should assert `registry.planRun(...)` and
`registry.planRollback(...)` directly for structured plan behavior. CLI tests
should cover exit codes, key rendered text, and that `--plan` exits before
execution.

Human plan output is compact and command-specific. It shows requested
definitions, target ids when present, included definitions, execution order, and
notices:

```text
Run plan

Requested:
articles

Included:
authors
articles

Execution order:
1. authors
2. articles
```

When users provide multiple explicit definition ids, preserve their requested
order in `Requested` and show normalized dependency order separately:

```text
Requested:
articles
authors

Execution order:
1. authors
2. articles
```

Duplicate requested definition ids are deduplicated for inclusion and execution,
but preserved in `Requested` and surfaced as notices:

```text
Requested:
articles
articles

Included:
articles

Notices:
- Duplicate requested definition ignored: articles
```

For all-registry plans, preserve the operator's original scope choice and expand
the included definitions separately:

```text
Requested:
all

Included:
authors
articles
offers
```

```text
Rollback plan

Requested:
articles

Target ids:
article-1, article-2

Included:
articles

Execution order:
1. articles
```

```text
Notices:
- Ignored optional dependency cycle: articles -> offers -> articles
```

No command silently selects every definition:

```sh
migrate run
migrate rollback
```

Both commands are invalid without `--all` or at least one definition id.

No command silently expands required dependency scope:

```sh
migrate run articles
# errors if articles depends on authors and authors was not requested

migrate run authors articles
# valid

migrate run articles --with-dependencies
# valid
```

Forward `--ids` targeting is item mode. It is valid only for exactly one
explicit definition id and exactly one parsed source identity. It cannot be
combined with `--all`, multiple definition ids, `--with-dependencies`,
`--failed`, or `--skipped`:

```sh
migrate run articles --ids article-1
# valid

migrate run articles --ids article-1,article-2
# invalid

migrate run articles authors --ids article-1
# invalid

migrate run --all --ids article-1
# invalid

migrate run articles --with-dependencies --ids article-1
# invalid
```

Rollback uses the same explicit required dependency policy. `--ids` is valid
only when exactly one definition id is requested and may contain one or more
source identities:

```sh
migrate rollback articles --ids article-1
# valid

migrate rollback articles --ids article-1,article-2
# valid

migrate rollback authors articles --ids article-1
# invalid

migrate rollback --all --ids article-1
# invalid

migrate rollback articles --with-dependencies --ids article-1
# invalid
```

`--ids` splits on literal commas, rejects empty parts, and percent-decodes each
part. Source identities containing commas must encode them:

```sh
migrate rollback articles --ids article%2C1,article-2
```

Duplicate parsed `--ids` values are deduplicated and surfaced as notices:

```text
Target ids:
article-1

Notices:
- Duplicate target id ignored: article-1
```

For forward run item mode, duplicate parsed ids that collapse to one unique id
are accepted with a notice. More than one unique parsed id remains invalid.

## Effect CLI Integration

Effect CLI provides typed flags, arguments, subcommands, global flags, and
command-scoped service provisioning. It does not provide a full
`migrate.config.ts` discovery and module-import primitive.

The CLI should use Effect CLI primitives for:

- `--config` as a global file/path flag
- `--with-dependencies`, `--all`, `--failed`, `--skipped`, `--ids`, and
  `--plan` flags
- variadic definition id arguments
- subcommands such as `list`, `graph`, `run`, and `rollback`
- providing a loaded CLI config service to command handlers

The migrate CLI owns:

- discovering `migrate.config.ts`
- importing the executable config module
- validating the default export created by `defineMigrationCliConfig`
- catching and rendering registry construction errors thrown during config
  module evaluation
- rendering registry planning and execution errors

## Open Questions

- Whether trailing command flags require argv normalization before invoking
  Effect CLI's parser.
