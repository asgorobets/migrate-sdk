# Migration Author API

Audience: users writing migrations.

Status: pre-ADR-0006 command-plan authoring design. This document describes the
older public authoring model where pipelines return destination command plans
through a configured destination plugin. The target public API is refined by
[ADR 0006](../adr/0006-scoped-pipeline-tracking-with-composite-identities.md),
[Scoped Pipeline Tracking API](./scoped-pipeline-tracking-api.md), and
[Effectful Pipeline Destination Capabilities](./effectful-pipeline-destination-capabilities.md):
pipelines execute destination effects inline, destination helpers record typed
changes into a scoped journal, and tracking mode decides what durable
destination tracking is persisted.

Migration authors compose configured plugins, a migration store, and a typed
pipeline into an executable `MigrationDefinition`. Plugin implementation details
and Effect layers are hidden behind configured plugin values.

Start here when writing SDK code directly. Use
[Prebuilt Plugin Usage API](./prebuilt-plugin-usage-api.md) when the question is
how an SDK-provided source or destination plugin should feel to its consumers.

## Authoring Model

A migration definition connects:

- a configured source plugin that emits source items
- a configured destination plugin that accepts destination commands
- one migration store layer
- a transformation pipeline from one source item to one destination command plan
- optional run dependencies and retry wrappers

The public edge accepts plain strings for ids. The SDK normalizes those values
to branded internal ids at the definition and run-request boundaries.

```ts
import { Effect, Schema } from "effect";
import {
  defineMigration,
  InMemoryDestinationPlugin,
  InMemoryMigrationStore,
  InMemorySourcePlugin,
  runMigration,
  skipItem,
  SourceIdentity,
} from "migrate-sdk";

const ArticleSource = Schema.Struct({
  publish: Schema.Boolean,
  title: Schema.String,
});

const ArticleEntryFields = Schema.Struct({
  title: Schema.String,
});

const ArticleSourceIdentity = SourceIdentity.make({
  id: "article@v1",
  schema: SourceIdentity.key("articleId", Schema.NonEmptyString),
});

const sourceItems = [
  {
    identityKey: "article-1",
    version: "source-version-1",
    item: {
      publish: true,
      title: "Hello, migration",
    },
  },
  {
    identityKey: "article-2",
    version: "source-version-1",
    item: {
      publish: false,
      title: "Draft article",
    },
  },
] as const;

const destination = InMemoryDestinationPlugin.makeEntries({
  contentType: "article",
  commands: {
    publishEntry: true,
    upsertEntry: { fields: ArticleEntryFields },
  },
});

const articles = defineMigration({
  id: "articles",
  source: InMemorySourcePlugin.make({
    identity: ArticleSourceIdentity,
    items: sourceItems,
    sourceSchema: ArticleSource,
  }),
  destination,
  store: InMemoryMigrationStore.layer(),
  pipeline: Effect.fn("articles.pipeline")(function* (source) {
    if (!source.item.publish) {
      return yield* skipItem("Article is not published");
    }

    return destination.commands.upsertEntry({
      title: source.item.title,
    });
  }),
});

await Effect.runPromise(runMigration(articles));
```

## Source Items

Migration authors see source items after the source boundary:

```ts
interface SourceItem<A> {
  readonly identity: SourceIdentity;
  readonly item: A;
  readonly version: SourceVersion;
}
```

`identity` is stable within one migration definition. `version` is the source
version or fingerprint used to decide whether a previously migrated or skipped
item is unchanged. `item` is the pipeline-facing value inferred from the Source
Payload Schema.

## Pipeline Shape

Pipelines return a `DestinationCommandPlan`:

```ts
type DestinationCommandPlan<Command extends DestinationCommand> =
  | Command
  | readonly Command[];
```

A plan must contain at least one command. It may contain one identity-bearing
command and any number of side-effect-only commands. The runner records the one
destination identity produced by the plan as the migrated item state.

```ts
const articles = defineMigration({
  // ...
  pipeline: (source) => [
    destination.commands.upsertEntry({
      title: source.item.title,
    }),
    destination.commands.publishEntry(),
  ],
});
```

Use an Effect pipeline when the transformation itself needs Effect services,
skips, or typed failures:

```ts
const articles = defineMigration({
  // ...
  pipeline: Effect.fn("articles.pipeline")(function* (source) {
    if (!source.item.publish) {
      return yield* skipItem("Article is not published");
    }

    return destination.commands.upsertEntry({
      title: source.item.title,
    });
  }),
});
```

The pipeline receives a `PipelineContext` with the current definition id, run id,
and any previous item state:

```ts
const articles = defineMigration({
  // ...
  pipeline: (source, context) => {
    if (context.previousState?.status === "needs-update") {
      return destination.commands.upsertEntry({
        title: source.item.title,
      });
    }

    return destination.commands.upsertEntry({
      title: source.item.title,
    });
  },
});
```

## Skip Behavior

Skipping is a typed pipeline error. It records a skipped item state and does not
call the destination plugin.

```ts
const requireTitle = Effect.fn("articles.requireTitle")(function* (
  article: ArticleSource
) {
  if (article.title.trim() === "") {
    return yield* skipItem("Article title is blank");
  }

  return article.title;
});
```

Skipped states are terminal for the same source version in normal mode. Use the
`skipped` run mode when skip logic changes and unchanged skipped items should be
processed again.

## Run Requests

`runMigration(definition)` is the single-definition convenience path.
`runMigrations(request)` accepts multiple definitions, optional definition
selection, and an optional run mode.

```ts
yield* runMigrations({
  definitions: [authors, articles],
});

yield* runMigrations({
  definitions: [authors, articles],
  definitionIds: ["articles"],
  mode: { kind: "failed" },
});

yield* runMigrations({
  definitions: [authors, articles],
  definitionIds: ["articles"],
  mode: {
    kind: "item",
    sourceIdentityKey: "article-123",
  },
});
```

Rollback-capable migrations use a separate rollback operation and rollback
pipeline. See [Rollback API](./rollback-api.md).

When `definitionIds` is provided, the runner includes required dependencies and
orders the expanded set before running. Missing dependencies and dependency
cycles fail before any destination side effects happen.

V1 run modes:

- `normal` processes new, changed, failed, and needs-update work.
- `failed` reprocesses failed item states only.
- `skipped` reprocesses skipped item states regardless of source version.
- `item` reprocesses one source identity regardless of current state.

There is no `all` mode in V1 because that name is ambiguous and potentially
destructive.

## Retry Wrappers

The migration definition chooses retry behavior. Plugins expose typed errors;
they do not own the caller's retry policy.

```ts
import { Schedule } from "effect";
import type { DestinationRetryStrategy } from "migrate-sdk";

const destinationRetry: DestinationRetryStrategy = (effect) =>
  effect.pipe(
    Effect.retry(
      Schedule.exponential("500 millis").pipe(
        Schedule.jittered,
        Schedule.compose(Schedule.recurs(5))
      )
    )
  );

const articles = defineMigration({
  // ...
  destinationRetry,
});
```

Source cursor reads and source identity lookups have separate retry wrappers:
`sourceCursorRetry` and `sourceLookupRetry`. Cursor reads are discovery and fail
the definition run. Identity lookups are item-specific when the identity is
already known, so lookup failures can be recorded as item failures.

## Reference Lookup

Use `MigrationReferenceLookup` when one migration needs destination identities
created by another migration. Dependencies provide same-run ordering and lock
safety, but lookup itself reads durable item state through the referenced
definition's store.

Lookup accepts the referenced migration definition object and a decoded source
identity key for that definition. The runtime validates and encodes the key with
the referenced definition's `source.identity` contract before reading the
Migration Store. Authors do not hand-author encoded composite source identity
strings.

```ts
import { MigrationReferenceLookup } from "migrate-sdk";

const stitchCustomers = defineMigration({
  id: "stitch-customers-to-user-accounts",
  dependsOn: ["migrate-customers", "migrate-user-accounts"],
  // ...
  pipeline: Effect.fn("stitch.pipeline")(function* (source) {
    const references = yield* MigrationReferenceLookup;

    const customer = yield* references.lookup({
      definition: migrateCustomers,
      sourceIdentityKey: source.item.customerKey,
    });

    const userAccount = yield* references.lookup({
      definition: migrateUserAccounts,
      sourceIdentityKey: source.item.userAccountKey,
    });

    if (customer === null || userAccount === null) {
      return yield* skipItem("Customer is missing required references");
    }

    return destination.commands.linkCustomerToUser({
      customerId: customer.destinationIdentity,
      userAccountId: userAccount.destinationIdentity,
    });
  }),
});
```

Composite referenced identities pass the decoded tuple key:

```ts
const address = yield* references.lookup({
  definition: migrateBusinessAddresses,
  sourceIdentityKey: [source.item.businessUnitKey, source.item.addressIndex],
});
```

When a lookup may resolve through one of several referenced migrations, provide
ordered target pairs. Each target carries its own definition and decoded source
identity key, so heterogeneous source identity schemas are supported:

```ts
const author = yield* references.lookup({
  targets: [
    references.target(migrateStaffAuthors, source.item.staffAuthorId),
    references.target(migrateGuestAuthors, [
      source.item.publisherId,
      source.item.guestAuthorId,
    ]),
  ],
});
```

Lookup can also be configured with `stub: true` when the referenced migration
definition owns a `stub` hook. Stubbed references have status `needs-update` and
carry a usable destination identity.

For ordered targets, `stub: true` creates the stub from the first target when no
existing reference is found. Use `stub: { definition }` to choose a later target
explicitly.

## Run Summary

Completed inline runs return a structured summary:

```ts
interface MigrationRunSummary {
  readonly definitions: readonly MigrationDefinitionRunSummary[];
  readonly finishedAt: Date;
  readonly runId: MigrationRunId;
  readonly startedAt: Date;
  readonly status: "succeeded" | "failed";
}

interface MigrationDefinitionRunSummary {
  readonly counts: {
    readonly migrated: number;
    readonly skipped: number;
    readonly failed: number;
    readonly unchanged: number;
    readonly needsUpdate: number;
  };
  readonly definitionId: MigrationDefinitionId;
  readonly status: "succeeded" | "failed" | "skipped";
}
```

The run status is failed when any definition records failed item work, even when
other items completed successfully.
