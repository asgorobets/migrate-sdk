# Prebuilt Plugin Usage API

Audience: migration authors consuming packaged plugins.

This document covers plugin usage, not plugin implementation. Source and
destination plugin authoring are separate audiences:

- [Source Plugin Authoring API](./source-plugin-authoring-api.md)
- [Destination Plugin Authoring API](./destination-plugin-authoring-api.md)

Packaged plugins should feel like typed helpers that return configured plugin
values. Migration authors should not need to work with raw Effect service tags
or arbitrary destination command records.

## Usage Shape

A source plugin factory configures how source data is read and which Source
Payload Schema defines the pipeline-facing item shape:

```ts
const source = CsvSourcePlugin.plugin({
  file: "articles.csv",
  identity: "id",
  sourceSchema: CsvArticleSource,
});
```

A destination plugin factory configures destination-owned schemas once and
returns command factories for pipelines:

```ts
const destination = ContentfulDestinationPlugin.plugin({
  schemas: {
    article: ArticleEntryFields,
  },
});

const command = destination.commands.upsertEntry("article", {
  title: "Schema-first migrations",
  views: 1280,
});
```

The destination package owns supported command kinds. Migration authors should
not supply arbitrary command kind strings or hand-built command definition
records for normal migrations.

## Source And Destination Schema Boundary

Source plugins may decode source-native values. Destination plugins validate
pipeline-facing values.

```ts
const CsvArticleSource = Schema.Struct({
  title: Schema.Trim,
  views: Schema.NumberFromString,
});

const ArticleEntryFields = Schema.Struct({
  title: Schema.String,
  views: Schema.Number,
});
```

In this example the CSV source converts `views` from a string into a number.
The pipeline and destination field schema both see `views` as a number.
Destination-native encoding belongs inside the destination plugin.

```ts
pipeline: Effect.fn("articles.pipeline")(function* (source) {
  return destination.commands.upsertEntry("article", {
    title: source.item.title,
    views: source.item.views,
  });
});
```

## In-Memory Entry Destination

The in-memory destination currently provides a CMS-shaped prebuilt usage path:
`InMemoryDestinationPlugin.makeEntries(...)`.

```ts
const ArticleEntryFields = Schema.Struct({
  title: Schema.String,
  views: Schema.Number,
});

const destination = InMemoryDestinationPlugin.makeEntries({
  schemas: {
    article: ArticleEntryFields,
  },
});

const articles = defineMigration({
  id: "articles",
  source,
  destination,
  store: InMemoryMigrationStore.layer(),
  pipeline: Effect.fn("articles.pipeline")(function* (source) {
    return [
      destination.commands.upsertEntry("article", {
        title: source.item.title,
        views: source.item.views,
      }),
      destination.commands.publishEntry("article"),
    ];
  }),
});
```

This mirrors the shape expected from real CMS destination packages such as
Contentful: schemas are passed once at plugin creation, then pipelines call
destination-owned command factories.

## Lower-Level Custom Destination

`InMemoryDestinationPlugin.make(...)` remains a lower-level custom and test
destination path. It requires command definitions and an executor, so tests still
exercise the same runtime command validation as real plugins.

```ts
const IndexRecordCommand = Schema.Struct({
  kind: Schema.Literal("IndexRecord"),
  record: Schema.Struct({
    objectId: Schema.String,
    title: Schema.String,
  }),
});

const commandDefinitions = defineDestinationCommands({
  IndexRecord: {
    identity: true,
    schema: IndexRecordCommand,
  },
});

const destination = InMemoryDestinationPlugin.make({
  commandDefinitions,
  execute: (command, context) => ({
    destinationIdentity: `search:${context.sourceIdentity}`,
    metadata: {
      indexedObjectId: command.record.objectId,
    },
  }),
});
```

This is not the default prebuilt plugin usage shape. It is useful for tests,
custom destinations, and examples that need to demonstrate the lower-level
runtime boundary.

## Dynamic Registration

Dynamic TypeScript registration is still ordinary migration definition code.
Generated arrays of definitions should return configured plugin values and
typed pipelines.

```ts
const contentTypes = ["author", "article", "category"] as const;

export const migrations = contentTypes.map((contentType) => {
  const destination = ContentfulDestinationPlugin.plugin({
    schemas: {
      [contentType]: contentTypeSchemas[contentType],
    },
  });

  return defineMigration({
    id: contentType,
    source: SqlSourcePlugin.plugin({
      table: contentType,
      sourceSchema: sourceSchemas[contentType],
    }),
    destination,
    store: SqlMigrationStore.layer({
      tablePrefix: "migrate_sdk",
    }),
    pipeline: makePipelineFor(contentType, destination.commands),
  });
});
```

Future adapter packages may generate Effect schemas from external systems such
as CMS content-type configuration, JSON Schema, or Standard Schema. The
configured plugin boundary should still expose the final Effect schemas used by
the runner.
