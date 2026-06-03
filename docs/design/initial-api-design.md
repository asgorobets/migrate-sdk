# Initial API Design

This document captures the current working design for the migration framework API. It is exploratory and should evolve with the first proof of concept.

The core direction is:

- Migration definitions are executable TypeScript objects.
- Source, destination, and migration store boundaries are Effect services.
- Plugin implementations provide Effect layers.
- The runner is shared by CLI and direct SDK invocation.
- Future YAML/UI support should compile serializable migration specs into runtime migration definitions.

## First POC Scope

The first implementation slice should prove framework semantics before integrating SQL or SaaS APIs:

- Core runner
- In-memory source plugin
- In-memory destination plugin
- File migration store

This POC should exercise cursor windows, definition locks, run modes, skip item errors, destination command execution, retry wrappers, and item state transitions. SQL source/store and ContentStack destination should come after the core semantics are stable.

## Core Runtime Shape

```ts
import { Effect, Exit, Layer, Schema } from "effect";
import * as Context from "effect/Context";

export type MigrationDefinitionId = string;

export type SourceIdentity = string;
export type SourceVersion = string;
export type SourceCursor = unknown;
export type DestinationIdentity = string;
export type DestinationVersion = string;

export interface SourceEnvelope<A> {
  readonly identity: SourceIdentity;
  readonly version?: SourceVersion;
  readonly item: A;
}

export interface SourceReadResult<A> {
  readonly items: ReadonlyArray<SourceEnvelope<A>>;
  readonly nextCursor?: SourceCursor;
}

export interface DestinationCommandResult {
  readonly destinationIdentity: DestinationIdentity;
  readonly destinationVersion?: DestinationVersion;
  readonly metadata?: Record<string, unknown>;
}

export interface DestinationCommandContext {
  readonly definitionId: MigrationDefinitionId;
  readonly runId: MigrationRunId;
  readonly sourceIdentity: SourceIdentity;
  readonly sourceVersion?: SourceVersion;
  readonly previousState?: MigrationItemState;
}

export interface PipelineContext {
  readonly definitionId: MigrationDefinitionId;
  readonly runId: MigrationRunId;
  readonly previousState?: MigrationItemState;
}

type MigrationItemStatus =
  | "migrated"
  | "skipped"
  | "failed"
  | "needs-update";

type MigrationItemOutcome =
  | "migrated"
  | "skipped"
  | "failed"
  | "needs-update"
  | "unchanged";
```

`unchanged` is a run outcome, not a persisted migration item status. The durable item state remains the prior terminal state, such as `migrated` or `skipped`.

## Discriminator Convention

Public and persisted data should use domain-friendly discriminators:

- `kind` for public command and request/result variants.
- `status` for persisted state.
- Effect `_tag` only for Effect-native errors or internals where APIs like `Effect.catchTag` are useful.

Destination commands should use plain `Schema.Struct` variants with `kind`, then `Schema.Union`. They do not need `Schema.TaggedClass`.

```ts
const UpsertEntry = Schema.Struct({
  kind: Schema.Literal("UpsertEntry"),
  contentType: Schema.String,
  fields: Schema.Record({
    key: Schema.String,
    value: Schema.Unknown,
  }),
});

const UpdateAndPublishEntry = Schema.Struct({
  kind: Schema.Literal("UpdateAndPublishEntry"),
  uid: Schema.String,
  fields: Schema.Record({
    key: Schema.String,
    value: Schema.Unknown,
  }),
  expectedVersion: Schema.optional(DestinationVersion),
  locale: Schema.optional(Schema.String),
});

const ContentStackCommand = Schema.Union([
  UpsertEntry,
  UpdateAndPublishEntry,
]);
```

`SkipItem` is the exception because it is an Effect-native typed error that benefits from `Effect.catchTag`.
Public examples should still use helper constructors such as `skipItem(...)` so `_tag` never needs to be authored by users.

Migration item state should be modeled as discriminated variants by status rather than one loose interface with many optional fields.

```ts
interface MigrationItemStateBase {
  readonly definitionId: MigrationDefinitionId;
  readonly sourceIdentity: SourceIdentity;
  readonly sourceVersion?: SourceVersion;
  readonly lastRunId: MigrationRunId;
  readonly updatedAt: Date;
}

interface MigratedItemState extends MigrationItemStateBase {
  readonly status: "migrated";
  readonly destinationIdentity: DestinationIdentity;
  readonly destinationVersion?: DestinationVersion;
}

interface SkippedItemState extends MigrationItemStateBase {
  readonly status: "skipped";
  readonly skipReason: string;
}

interface FailedItemState extends MigrationItemStateBase {
  readonly status: "failed";
  readonly error: MigrationItemError;
  readonly destinationIdentity?: DestinationIdentity;
  readonly destinationVersion?: DestinationVersion;
}

interface NeedsUpdateItemState extends MigrationItemStateBase {
  readonly status: "needs-update";
  readonly destinationIdentity: DestinationIdentity;
  readonly destinationVersion?: DestinationVersion;
  readonly reason: string;
}

type MigrationItemState =
  | MigratedItemState
  | SkippedItemState
  | FailedItemState
  | NeedsUpdateItemState;
```

Migration item state should not store source item payload snapshots by default. Payloads can be large or sensitive, and the source system remains the source of truth. Retrying failed, skipped, needs-update, or single-item work uses `SourcePlugin.readByIdentity`.

Plugin APIs should expose plugin-specific typed errors. The runner normalizes those errors into durable migration item error records for storage and display.

```ts
interface MigrationItemError {
  readonly kind: "source" | "pipeline" | "destination";
  readonly tag: string;
  readonly message: string;
  readonly data?: unknown;
}
```

Migration store errors are run-level failures. If the store cannot reliably write item state, run state, locks, or cursors, the runner should stop rather than continue producing destination side effects without durable progress records.

Source cursor reads are discovery. If `SourcePlugin.read(cursor)` fails, the migration definition run fails because the runner does not know which items were selected. `SourcePlugin.readByIdentity(identity)` is different: when the source identity is already known from item state or run mode, a lookup error can be recorded as an item failure.

## Plugin Services

`SourcePlugin` and `DestinationPlugin` are generic runtime service boundaries. Concrete plugins expose configured layers that implement these tags.

```ts
export class SourcePlugin<A> extends Context.Service<
  SourcePlugin<A>,
  {
    readonly lookupStrategy: SourceLookupStrategy;

    readonly read: (
      cursor: SourceCursor | null
    ) => Effect.Effect<SourceReadResult<A>, SourcePluginError>;

    readonly readByIdentity: (
      identity: SourceIdentity
    ) => Effect.Effect<SourceEnvelope<A> | null, SourcePluginError>;
  }
>()("@migrate-sdk/SourcePlugin") {}

export class DestinationPlugin<C> extends Context.Service<
  DestinationPlugin<C>,
  {
    readonly execute: (
      command: C,
      context: DestinationCommandContext
    ) => Effect.Effect<DestinationCommandResult, DestinationPluginError>;
  }
>()("@migrate-sdk/DestinationPlugin") {}
```

Example implementation layers:

```ts
const sqlSourceLayer = SqlSourcePlugin.layer({
  table: "articles",
  identity: ["id"],
  version: "updated_at",
  cursor: ["updated_at", "id"],
});

const contentStackDestinationLayer = ContentStackDestinationPlugin.layer({
  contentType: "article",
});
```

The runner should provide these layers per migration definition. Do not provide every source plugin globally under the same `SourcePlugin` tag.

Destination versions are useful for optimistic concurrency and race detection. For example, a ContentStack destination plugin can return the entry UID as `destinationIdentity` and the entry version or ETag as `destinationVersion`. A later update can use that version to avoid overwriting another runner's write if two migration runners race on the same destination item.

Destination plugins execute commands, not generic create/update methods. This lets a destination plugin support destination-specific operations such as upsert, update, publish, or update-and-publish.

```ts
type ContentStackCommand =
  | {
      readonly kind: "UpsertEntry";
      readonly contentType: string;
      readonly fields: Record<string, unknown>;
    }
  | {
      readonly kind: "UpdateEntry";
      readonly uid: string;
      readonly fields: Record<string, unknown>;
      readonly expectedVersion?: DestinationVersion;
    }
  | {
      readonly kind: "PublishEntry";
      readonly uid: string;
      readonly locale?: string;
    }
  | {
      readonly kind: "UpdateAndPublishEntry";
      readonly uid: string;
      readonly fields: Record<string, unknown>;
      readonly expectedVersion?: DestinationVersion;
      readonly locale?: string;
    };
```

Example command execution:

```ts
const execute = Effect.fn("ContentStackDestination.execute")(function* (
  command: ContentStackCommand,
  context: DestinationCommandContext
) {
  switch (command.kind) {
    case "UpdateAndPublishEntry": {
      const updated = yield* updateEntry({
        uid: command.uid,
        fields: command.fields,
        expectedVersion: command.expectedVersion,
      });

      const published = yield* publishEntry({
        uid: updated.uid,
        version: updated.version,
        locale: command.locale,
      });

      return {
        destinationIdentity: updated.uid,
        destinationVersion: published.version,
        metadata: {
          operation: "update-and-publish",
        },
      };
    }
  }
});
```

`readByIdentity` is required. If the source system has no direct lookup API, the source plugin may implement `readByIdentity` by scanning. The plugin should expose `lookupStrategy` so callers can warn when rerunning failed, skipped, needs-update, or single-item work may be expensive.

```ts
type SourceLookupStrategy = "direct" | "scan";
```

`read` reads one cursor window. The source plugin owns cursor semantics and returns the next cursor when more source items may be available.

SQL source example:

```ts
const read = Effect.fn("SqlSource.read")(function* (
  cursor: SourceCursor | null
): Effect.Effect<SourceReadResult<SqlArticleRow>, SqlSourceError> {
  const rows = yield* queryArticles({
    after: cursor,
    limit: 500,
    orderBy: ["updated_at", "id"],
  });

  const items = rows.map((row) => ({
    identity: String(row.id),
    version: row.updated_at.toISOString(),
    item: row,
  }));

  const last = rows.at(-1);

  return {
    items,
    nextCursor: last
      ? {
          updatedAt: last.updated_at.toISOString(),
          id: String(last.id),
        }
      : undefined,
  };
});
```

Paginated API source example:

```ts
const read = Effect.fn("OrdersApiSource.read")(function* (
  cursor: SourceCursor | null
): Effect.Effect<SourceReadResult<ApiOrder>, OrdersApiError> {
  const response = yield* ordersApi.listOrders({
    pageToken: cursor?.pageToken,
    limit: 100,
  });

  return {
    items: response.orders.map((order) => ({
      identity: order.id,
      version: order.updatedAt,
      item: order,
    })),
    nextCursor: response.nextPageToken
      ? { pageToken: response.nextPageToken }
      : undefined,
  };
});
```

## Migration Store

The migration store is one public service. Implementations may split item state, run state, and cursor storage internally.

```ts
export class MigrationStore extends Context.Service<
  MigrationStore,
  {
    readonly getSourceCursor: (
      definitionId: MigrationDefinitionId
    ) => Effect.Effect<SourceCursor | null, MigrationStoreError>;

    readonly setSourceCursor: (
      definitionId: MigrationDefinitionId,
      cursor: SourceCursor
    ) => Effect.Effect<void, MigrationStoreError>;

    readonly getItemState: (
      definitionId: MigrationDefinitionId,
      identity: SourceIdentity
    ) => Effect.Effect<MigrationItemState | null, MigrationStoreError>;

    readonly upsertItemState: (
      state: MigrationItemState
    ) => Effect.Effect<void, MigrationStoreError>;

    readonly beginRun: (
      definitionIds: ReadonlyArray<MigrationDefinitionId>
    ) => Effect.Effect<MigrationRunState, MigrationStoreError>;

    readonly completeRun: (
      runId: string
    ) => Effect.Effect<void, MigrationStoreError>;

    readonly failRun: (
      runId: string
    ) => Effect.Effect<void, MigrationStoreError>;

    readonly acquireDefinitionLock: (
      definitionId: MigrationDefinitionId,
      ownerRunId: string,
      ttlMs: number
    ) => Effect.Effect<MigrationDefinitionLock, MigrationStoreError>;

    readonly refreshDefinitionLock: (
      lock: MigrationDefinitionLock,
      ttlMs: number
    ) => Effect.Effect<MigrationDefinitionLock, MigrationStoreError>;

    readonly releaseDefinitionLock: (
      lock: MigrationDefinitionLock
    ) => Effect.Effect<void, MigrationStoreError>;
  }
>()("@migrate-sdk/MigrationStore") {}
```

Example implementation layers:

```ts
const sqlStoreLayer = SqlMigrationStore.layer({
  tablePrefix: "migrate_sdk",
});

const fileStoreLayer = FileMigrationStore.layer({
  directory: ".migration-state",
});
```

## Skip Item

Skipping is modeled as a typed pipeline error. This lets any helper inside the pipeline decide to skip without threading a skip union through every return type.

```ts
export class SkipItem extends Schema.TaggedErrorClass<SkipItem>()(
  "SkipItem",
  {
    reason: Schema.String,
  }
) {
  static make = (reason: string) => new SkipItem({ reason });
}

export const skipItem = (reason: string) => SkipItem.make(reason);
```

Pipeline helper:

```ts
const requireGroup = Effect.fn("offers.requireGroup")(function* (
  offer: SqlOfferRow
) {
  if (offer.groupId == null) {
    yield* skipItem("Offer is not assigned to a group");
  }

  return offer.groupId;
});
```

Runner behavior:

```ts
const destinationCommand = yield* definition.pipeline(source).pipe(
  Effect.catchTag("SkipItem", (skip) =>
    store.upsertItemState({
      definitionId: definition.id,
      sourceIdentity: source.identity,
      sourceVersion: source.version,
      status: "skipped",
      skipReason: skip.reason,
    }).pipe(Effect.as(null))
  )
);

if (destinationCommand === null) {
  return;
}
```

The destination plugin is not called for skipped items.

## Destination Retry Strategy

Destination plugins may classify retryable errors, but the migration definition chooses the retry wrapper. This avoids baking a retry DSL into plugin config.

```ts
import { Schedule } from "effect";

export type DestinationRetryStrategy = <A, E, R>(
  effect: Effect.Effect<A, E, R>
) => Effect.Effect<A, E, R>;

export type SourceRetryStrategy = <A, E, R>(
  effect: Effect.Effect<A, E, R>
) => Effect.Effect<A, E, R>;

const contentStackRetry: DestinationRetryStrategy = (effect) =>
  effect.pipe(
    Effect.retry(
      Schedule.exponential("500 millis").pipe(
        Schedule.jittered,
        Schedule.compose(Schedule.recurs(5))
      )
    )
  );
```

Runner application:

```ts
const execute = destination.execute(destinationCommand, context);

const executeWithRetry = definition.destinationRetry
  ? definition.destinationRetry(execute)
  : execute;

const result = yield* executeWithRetry;
```

Source cursor reads and source identity lookups can use separate retry strategies because cursor reads are discovery and identity lookups are item-specific.

```ts
const read = source.read(cursor);

const readWithRetry = definition.sourceCursorRetry
  ? definition.sourceCursorRetry(read)
  : read;

const result = yield* readWithRetry;
```

```ts
const lookup = source.readByIdentity(identity);

const lookupWithRetry = definition.sourceLookupRetry
  ? definition.sourceLookupRetry(lookup)
  : lookup;

const sourceItem = yield* lookupWithRetry;
```

## Migration Definition

A migration definition is an executable runtime object. It may be written by hand or generated in TypeScript.

```ts
export interface MigrationDefinition<Source, Command, PipelineRequirements = never> {
  readonly id: MigrationDefinitionId;

  readonly source: Layer.Layer<SourcePlugin<Source>>;
  readonly destination: Layer.Layer<DestinationPlugin<Command>>;
  readonly store: Layer.Layer<MigrationStore>;

  readonly pipeline: (
    source: SourceEnvelope<Source>,
    context: PipelineContext
  ) => Effect.Effect<Command, PipelineError | SkipItem, PipelineRequirements>;

  readonly pipelineLayer?: Layer.Layer<PipelineRequirements>;

  readonly sourceCursorRetry?: SourceRetryStrategy;
  readonly sourceLookupRetry?: SourceRetryStrategy;
  readonly destinationRetry?: DestinationRetryStrategy;

  readonly dependsOn?: ReadonlyArray<MigrationDefinitionId>;
}
```

Example:

```ts
const articlesMigration = {
  id: "articles",

  source: SqlSourcePlugin.layer({
    table: "articles",
    identity: ["id"],
    version: "updated_at",
    cursor: ["updated_at", "id"],
  }),

  destination: ContentStackDestinationPlugin.layer({
    contentType: "article",
  }),

  store: SqlMigrationStore.layer({
    tablePrefix: "migrate_sdk",
  }),

  destinationRetry: contentStackRetry,

  pipeline: Effect.fn("articles.pipeline")(function* (source) {
    return {
      title: source.item.title,
      body: source.item.body,
      slug: source.item.slug,
    };
  }),

  dependsOn: ["authors"],
} satisfies MigrationDefinition<SqlArticleRow, ContentStackArticleInput>;
```

## Schemas and Inference

Effect Schema is the canonical v1 schema mechanism. Source plugins expose or use source item schemas, and destination plugins expose or use destination command schemas. Migration definitions connect them through typed pipelines.

```ts
const articles = defineMigration({
  id: "articles",

  source: SqlSourcePlugin.layer({
    table: "articles",
    schema: SqlArticleRow,
    identity: ["id"],
    version: "updated_at",
  }),

  destination: ContentStackDestinationPlugin.layer({
    commandSchema: ContentStackArticleCommand,
  }),

  pipeline: Effect.fn("articles.pipeline")(function* (source) {
    // source.item is inferred from SqlArticleRow
    return {
      kind: "UpsertEntry" as const,
      contentType: "article",
      fields: {
        title: source.item.title,
      },
    };
  }),
});
```

Future plugins may generate schemas from external systems, such as ContentStack content type configuration, and may bridge to JSON Schema or Standard Schema when useful.

Pipeline context can use previous item state to select a different destination command for first migration versus update or stub completion:

```ts
pipeline: Effect.fn("articles.pipeline")(function* (source, context) {
  const fields = {
    title: source.item.title,
    body: source.item.body,
    slug: source.item.slug,
  };

  if (context.previousState?.status === "needs-update") {
    return {
      kind: "UpdateAndPublishEntry" as const,
      uid: context.previousState.destinationIdentity,
      fields,
      expectedVersion: context.previousState.destinationVersion,
    };
  }

  return {
    kind: "UpsertEntry" as const,
    contentType: "article",
    fields,
  };
});
```

Dynamic TypeScript registration is still a migration definition:

```ts
const contentTypes = ["author", "article", "category"] as const;

export const migrations = contentTypes.map((contentType) =>
  defineMigration({
    id: contentType,
    source: SqlSourcePlugin.layer({ table: contentType }),
    destination: ContentStackDestinationPlugin.layer({ contentType }),
    store: SqlMigrationStore.layer({ tablePrefix: "migrate_sdk" }),
    pipeline: makePipelineFor(contentType),
  })
);
```

## Runner Sketch

The runner provides source, destination, store, and optional pipeline layers once per migration definition.

```ts
const runMigrationDefinition = <S, D, R>(
  definition: MigrationDefinition<S, D, R>
) =>
  Effect.gen(function* () {
    const source = yield* SourcePlugin<S>;
    const destination = yield* DestinationPlugin<D>;
    const store = yield* MigrationStore;

    const cursor = yield* store.getSourceCursor(definition.id);
    const result = yield* source.read(cursor);

    let failedCount = 0;

    for (const sourceItem of result.items) {
      const itemResult = yield* processSourceItem({
        definition,
        sourceItem,
        destination,
        store,
      }).pipe(Effect.exit);

      if (Exit.isFailure(itemResult)) {
        failedCount += 1;
      }
    }

    if (failedCount > 0) {
      // Mark run failed, but only after processing all selected source items.
    }

    if (result.nextCursor !== undefined) {
      yield* store.setSourceCursor(definition.id, result.nextCursor);
    }
  }).pipe(
    Effect.provide(definition.source),
    Effect.provide(definition.destination),
    Effect.provide(definition.store),
    definition.pipelineLayer
      ? Effect.provide(definition.pipelineLayer)
      : (effect) => effect
  );
```

Production runner shape should loop cursor windows:

```ts
const processCursorWindows = Effect.fn("processCursorWindows")(function* <
  S,
  D,
  R,
>(definition: MigrationDefinition<S, D, R>) {
  const source = yield* SourcePlugin<S>;
  const store = yield* MigrationStore;

  let cursor = yield* store.getSourceCursor(definition.id);

  while (true) {
    const result = yield* source.read(cursor);

    if (result.items.length === 0) {
      break;
    }

    for (const sourceItem of result.items) {
      yield* processSourceItem({ definition, sourceItem }).pipe(Effect.exit);
    }

    if (result.nextCursor === undefined) {
      break;
    }

    cursor = result.nextCursor;
    yield* store.setSourceCursor(definition.id, cursor);
  }
});
```

The next cursor is committed after a cursor window is processed, even when some items in that window failed. Failed items are retried from migration item state backlog using `readByIdentity`, so a permanently bad item does not pin cursor advancement forever.

Many-definition runner:

```ts
const runMigrations = (
  definitions: ReadonlyArray<MigrationDefinition<any, any, any>>
) =>
  Effect.gen(function* () {
    const ordered = topologicalSort(definitions);

    for (const definition of ordered) {
      yield* runMigrationDefinition(definition);
    }
  });

const runMigration = (definition: MigrationDefinition<any, any, any>) =>
  runMigrations([definition]);
```

First version behavior:

- Accept many migration definitions.
- Order them by declared dependencies.
- Execute ordered definitions sequentially.
- Acquire a migration definition lock before executing each definition.
- Reject concurrent execution of the same migration definition.
- Continue after item failures.
- Mark the run failed if any item failed.
- Treat migrated and skipped item states as terminal for a given source version.
- Retry failed item states on rerun.
- Require an explicit run mode to reprocess unchanged skipped items when skip logic changes.
- Include required dependencies automatically when a run request selects specific migration definitions.

## Run Modes

V1 run modes are runtime concepts. The SDK and CLI should expose them, but CLI flag names can be decided later.

```txt
normal:
Process source items that are new, changed, or previously failed.
Do not reprocess unchanged migrated or skipped items.
Process failed and needs-update backlog before cursor discovery.

failed:
Reprocess only items currently marked failed.
Does not include needs-update items.

skipped:
Reprocess only items currently marked skipped.
Used when skip logic changed.
Reprocess skipped items regardless of source version.

item:
Reprocess one source item by Source Identity, regardless of current state.
```

`all` is intentionally omitted in v1 because it is ambiguous and potentially destructive.

`needs-update` is also omitted as a v1 run mode. Normal mode already processes needs-update backlog, and needs-update is tied to future destination stubbing behavior.

## Run Request

The run request is the shared invocation object for SDK, CLI, serverless, or another host.

```ts
type RunMode =
  | { readonly kind: "normal" }
  | { readonly kind: "failed" }
  | { readonly kind: "skipped" }
  | { readonly kind: "item"; readonly sourceIdentity: SourceIdentity };

interface RunRequest {
  readonly definitions: ReadonlyArray<MigrationDefinition<any, any, any>>;
  readonly mode?: RunMode;
  readonly cursor?: SourceCursor;
  readonly definitionIds?: ReadonlyArray<MigrationDefinitionId>;
}
```

When `definitionIds` is provided, the runner includes required dependencies automatically and orders the expanded set by dependency order. Missing dependencies or dependency cycles fail before running anything.

Examples:

```ts
yield* runMigrations({
  definitions: migrations,
});

yield* runMigrations({
  definitions: migrations,
  mode: { kind: "failed" },
});

yield* runMigrations({
  definitions: migrations,
  mode: {
    kind: "item",
    sourceIdentity: "article:123",
  },
});
```

## Migration Run Summary

A completed migration run produces a structured summary for SDK callers, CLI rendering, and tests.

```ts
interface MigrationRunSummary {
  readonly runId: MigrationRunId;
  readonly status: "succeeded" | "failed";
  readonly startedAt: Date;
  readonly finishedAt: Date;
  readonly definitions: ReadonlyArray<MigrationDefinitionRunSummary>;
}

interface MigrationDefinitionRunSummary {
  readonly definitionId: MigrationDefinitionId;
  readonly status: "succeeded" | "failed" | "skipped";
  readonly counts: {
    readonly migrated: number;
    readonly skipped: number;
    readonly failed: number;
    readonly unchanged: number;
    readonly needsUpdate: number;
  };
  readonly cursor?: SourceCursor;
}
```

Inline execution can return a completed summary immediately. Durable execution may only return a run id and let callers observe the run later.

```ts
type ExecutionStartResult =
  | {
      readonly kind: "Completed";
      readonly summary: MigrationRunSummary;
    }
  | {
      readonly kind: "Started";
      readonly runId: MigrationRunId;
    };
```

Durable run summaries are derived from persisted run state and item outcomes.

## Execution Adapter Seam

Execution is a runtime strategy. The first implementation should use an inline adapter, but execution adapters are a supported extension point. Users may provide their own adapter when they know how to schedule, partition, batch, queue, or parallelize a migration better than the built-in adapters.

The adapter owns scheduling:

- sequential versus parallel execution
- in-process versus queued execution
- partitioning
- worker fan-out
- serverless continuation
- timeout handling

The adapter should preserve core migration semantics:

- source identity and source version handling
- migration item state statuses
- destination command result persistence
- dependency ordering unless it explicitly takes responsibility for equivalent safety
- lock or claim safety rules

```txt
InlineExecutionAdapter:
  read cursor window
  process source items in-process
  execute destination commands
  persist item state

InlineParallelExecutionAdapter:
  read cursor window
  process source items in-process with bounded concurrency
  execute destination commands with bounded concurrency
  persist item state

DurableExecutionAdapter:
  read cursor window
  enqueue migration work items
  workers process work items
  persist item state
```

The inline adapter can gain bounded concurrency without changing migration definitions:

```ts
yield* Effect.forEach(result.items, processSourceItem, {
  concurrency: definition.concurrency ?? 1,
});
```

Durable execution needs a work item payload policy. Identity-only work items are small and fresh but require `readByIdentity`; source snapshots avoid expensive re-lookup but can be large or sensitive.

```ts
type WorkItemPayload<Source> =
  | {
      readonly kind: "IdentityOnly";
      readonly sourceIdentity: SourceIdentity;
      readonly discoveredSourceVersion?: SourceVersion;
    }
  | {
      readonly kind: "SourceSnapshot";
      readonly source: SourceEnvelope<Source>;
      readonly capturedAt: Date;
    };
```

Source snapshots are execution queue payloads, not migration item state. They should have retention, encryption, and expiry policies if implemented.

Future durable execution should split the current definition-level lock into:

```txt
Discovery lock:
  one scanner advances the source cursor for a migration definition

Item claim:
  one worker owns a source identity for a short lease
```

V1 should still use the simpler definition-level lock.

Execution adapter shape:

```ts
interface ExecutionAdapter {
  readonly start: (
    request: RunRequest,
    context: ExecutionContext
  ) => Effect.Effect<ExecutionStartResult, ExecutionError>;

  readonly getRunSummary?: (
    runId: MigrationRunId
  ) => Effect.Effect<MigrationRunSummary, ExecutionError>;
}

interface ExecutionContext {
  readonly clock: Clock.Clock;
  readonly random: Random.Random;
  readonly logger: Logger;
}
```

Default usage:

```ts
yield* runMigrations({
  definitions,
  mode: { kind: "normal" },
});
```

Inline adapters can return:

```ts
{
  kind: "Completed",
  summary,
}
```

Durable adapters can return:

```ts
{
  kind: "Started",
  runId,
}
```

The SDK or CLI can then support fire-and-forget, wait/poll, and status commands.

Custom adapter usage:

```ts
yield* runMigrations({
  definitions,
  mode: { kind: "normal" },
  execution: CustomParallelAdapter,
});
```

Custom partitioned adapter example:

```ts
const PartitionedAdapter = makePartitionedExecutionAdapter({
  partitions: [
    { cursor: { shard: "A" } },
    { cursor: { shard: "B" } },
    { cursor: { shard: "C" } },
  ],
  concurrency: 3,
});
```

Custom serverless adapter example:

```ts
const VercelDurableAdapter = makeDurableExecutionAdapter({
  enqueue: VercelQueue.enqueue,
  maxDuration: "50 seconds",
  payloadPolicy: "source-snapshot",
});
```

## Migration Reference Lookup

Complex migrations across multiple destination systems should be modeled as separate migration definitions per identity boundary, then stitched by another migration definition.

Example:

```txt
migrate-companies-to-ct
migrate-customers-to-ct
migrate-users-to-clerk
stitch-ct-customers-to-clerk-users
```

The stitch migration depends on prior migrations and reads their item states through a migration reference lookup capability.

```ts
const stitchCustomers = defineMigration({
  id: "stitch-ct-customers-to-clerk-users",
  dependsOn: ["migrate-customers-to-ct", "migrate-users-to-clerk"],

  source: MagentoCustomersSource.layer(magentoConfig),
  destination: CommerceToolsCustomerDestination.layer(ctConfig),
  store: SqlMigrationStore.layer(storeConfig),

  pipeline: Effect.fn("stitch.pipeline")(function* (source) {
    const references = yield* MigrationReferenceLookup;

    const ctCustomer = yield* references.requireMigrated({
      definitionId: "migrate-customers-to-ct",
      sourceIdentity: source.identity,
    });

    const clerkUser = yield* references.requireMigrated({
      definitionId: "migrate-users-to-clerk",
      sourceIdentity: source.identity,
    });

    return {
      kind: "LinkCustomerToUser" as const,
      customerId: ctCustomer.destinationIdentity,
      clerkUserId: clerkUser.destinationIdentity,
    };
  }),
});
```

This keeps each migration definition focused on one destination identity boundary while still allowing cross-system stitching.

## Definition Locks

V1 uses definition-level locks for correctness. Two runners must not execute the same migration definition at the same time.

The lock is part of the `MigrationStore` service contract, but the storage shape is an implementation detail.

```ts
interface MigrationDefinitionLock {
  readonly definitionId: MigrationDefinitionId;
  readonly ownerRunId: string;
  readonly token: string;
  readonly expiresAt: Date;
}
```

Runner behavior:

```txt
begin migration run
for each ordered migration definition:
  acquire definition lock
  execute migration definition
  release definition lock
complete migration run
```

Locks should be leases, not permanent flags. A TTL prevents abandoned CLI or serverless runs from blocking the migration forever. Long-running migrations can refresh the lease while processing.

SQL implementation sketch:

```sql
CREATE TABLE migration_definition_locks (
  definition_id text PRIMARY KEY,
  owner_run_id text NOT NULL,
  token text NOT NULL,
  expires_at timestamptz NOT NULL,
  acquired_at timestamptz NOT NULL
);
```

Acquire can be implemented as an atomic insert or an update of an expired lock. Refresh and release should match both `definition_id` and `token`, so an old runner cannot release a newer runner's lock after its lease expired.

KV implementation sketch:

```txt
SET migration-lock:<definitionId> <ownerRunId>:<token> NX PX <ttl>
```

File implementation sketch:

```txt
.migration-state/locks/<definitionId>.lock
```

Use exclusive creation plus expiry metadata. This is acceptable for local development, but SQL/KV stores are better for distributed runners.

## Future Migration Spec

Migration specs are serializable and can support YAML, DB, UI, or low-code workflows later. They compile into migration definitions through a future plugin registry.

```ts
type MigrationSpec = {
  readonly id: "articles";
  readonly source: {
    readonly plugin: "sql";
    readonly config: {
      readonly table: "articles";
      readonly identity: readonly ["id"];
      readonly version: "updated_at";
      readonly cursor: readonly ["updated_at", "id"];
    };
  };
  readonly destination: {
    readonly plugin: "contentstack";
    readonly config: {
      readonly contentType: "article";
    };
  };
  readonly pipeline: {
    readonly steps: readonly [
      { readonly type: "mapField"; readonly from: "title"; readonly to: "title" },
      { readonly type: "mapField"; readonly from: "body"; readonly to: "body" },
      { readonly type: "slugify"; readonly from: "title"; readonly to: "slug" },
    ];
  };
  readonly store: {
    readonly plugin: "sql";
    readonly config: {
      readonly tablePrefix: "migrate_sdk";
    };
  };
};
```

Future compile flow:

```ts
const registry = {
  sources: {
    sql: SqlSourcePlugin.fromConfig,
  },
  destinations: {
    contentstack: ContentStackDestinationPlugin.fromConfig,
  },
  stores: {
    sql: SqlMigrationStore.fromConfig,
  },
  pipelineSteps: {
    mapField,
    slugify,
  },
};

const definition = compileMigrationSpec(spec, registry);
```

The plugin registry is future DSL infrastructure. It is not required for the first code path.

## Future Stubbing

Dependency cycles should fail before running anything in v1. Future plugins may support stubbing to break destination-reference cycles.

A destination stub is a placeholder destination item created to reserve a destination identity before the full destination item can be written.

Example scenario:

```txt
Migration Definition A depends on B.
Migration Definition B depends on A.
```

Future stubbing flow:

```txt
1. While processing A, the pipeline needs destination identity for B.
2. B has not been fully migrated yet.
3. The runner delegates placeholder creation to B's destination plugin.
4. B's destination plugin creates a placeholder destination item and returns its destination identity.
5. The migration store records B's migration item state as `needs-update`.
6. A continues using B's destination identity.
7. Later, B is fully migrated and replaces or completes the placeholder.
```

`needs-update` means the destination identity exists, but the destination item is not complete and must be updated on the next run even when the source version is unchanged.

Use `needs-update` as the persisted/domain status string. Code may use `NeedsUpdate` as a TypeScript variant or `needsUpdate` as an object property.

This is future behavior, not part of the first code path.

## Open Questions

- What should the CLI flag spelling be for run modes?
