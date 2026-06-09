# Prebuilt Plugin Usage API

Audience: migration authors consuming first-party SDK plugins.

This document covers plugin usage, not plugin implementation. Source and
destination plugin authoring are separate audiences:

- [Source Plugin Authoring API](./source-plugin-authoring-api.md)
- [Destination Plugin Authoring API](./destination-plugin-authoring-api.md)

First-party plugins ship from the same `migrate-sdk` package as the core
runtime. They should still feel like typed helpers that return configured plugin
values. Migration authors should not need to work with raw Effect service tags
or arbitrary destination command records.

Plugins should be exported through clean public modules so callers import only
what they need. Subpath exports are allowed when they help tree-shaking or keep
heavy optional dependencies away from the default entrypoint, but they should
still belong to the same package while the SDK is small enough to support that.

## Usage Shape

A source plugin factory configures how source data is read and which Source
Payload Schema defines the pipeline-facing item shape:

```ts
const source = CsvSourcePlugin.make({
  path: "articles.csv",
  platform: csvPlatform,
  dialect: { kind: "standard" },
  emptyRows: { kind: "skip" },
  headers: { kind: "from-row", rowIndex: 0 },
  identity: { kind: "columns", columns: ["id"] },
  version: { kind: "row-hash" },
  sourceSchema: CsvArticleSource,
});
```

A destination plugin factory configures destination-owned command options once
and returns command factories for pipelines:

```ts
const destination = ContentfulDestinationPlugin.make({
  contentType: "article",
  commands: {
    publishEntry: true,
    upsertEntry: { fields: ArticleEntryFields },
  },
});

const command = destination.commands.upsertEntry("article-1", {
  title: "Schema-first migrations",
  views: 1280,
});
```

The destination plugin owns supported command kinds. Migration authors should
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
const articles = defineMigration({
  // ...
  pipeline: (source) =>
    destination.commands.upsertEntry(source.identity, {
      title: source.item.title,
      views: source.item.views,
    }),
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
  contentType: "article",
  commands: {
    publishEntry: true,
    upsertEntry: { fields: ArticleEntryFields },
  },
});

const articles = defineMigration({
  id: "articles",
  source,
  destination,
  store: InMemoryMigrationStore.layer(),
  pipeline: (source) => [
    destination.commands.upsertEntry({
      title: source.item.title,
      views: source.item.views,
    }),
    destination.commands.publishEntry(),
  ],
});
```

This mirrors the shape expected from real CMS destination plugins such as
Contentful: command options are passed once at plugin creation, then pipelines
call destination-owned command factories.

## Dynamic Registration

Dynamic TypeScript registration is still ordinary migration definition code.
Generated arrays of definitions should return configured plugin values and
typed pipelines.

```ts
const contentTypes = ["author", "article", "category"] as const;

export const migrations = contentTypes.map((contentType) => {
  const destination = ContentfulDestinationPlugin.make({
    contentType,
    commands: {
      publishEntry: true,
      upsertEntry: { fields: contentTypeSchemas[contentType] },
    },
  });

  const source = makeSqlSourceForContentType({
    client: legacySqlLayer,
    contentType,
    sourceSchema: sourceSchemas[contentType],
  });

  return defineMigration({
    id: contentType,
    source,
    destination,
    store: SqlMigrationStore.layer({
      tablePrefix: "migrate_sdk",
    }),
    pipeline: makePipelineFor(contentType, destination.commands),
  });
});
```

The raw SQL source API should be designed in the SQL source folder. It should
use configured query callbacks rather than table-name-only configuration.

Future adapters may generate Effect schemas from external systems such as CMS
content-type configuration, JSON Schema, or Standard Schema. The configured
plugin boundary should still pass those schemas through command options so each
factory receives the right field type.
