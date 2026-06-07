# Destination Plugin Authoring API

Audience: people implementing destination plugins.

Destination plugins execute destination commands. They own command validation,
command factories, destination-native encoding, and the Effect dependencies used
by their implementation.

## Public Factory Shape

Destination plugin modules should expose a factory that configures one
destination shape for one migration definition. Command-specific options live in
the `commands` object:

```ts
const contentful = ContentfulDestinationPlugin.make({
  contentType: "article",
  commands: {
    publishEntry: true,
    upsertEntry: { fields: ArticleEntryFields },
  },
});

const upsert = contentful.commands.upsertEntry("article-1", {
  title: "Schema-first migrations",
  views: 1280,
});

const publish = contentful.commands.publishEntry("article-1");
```

The plugin owns supported command names and which command options are required.
Migration authors should not disassemble plugins or rebuild command definitions.

The options object is plain TypeScript, but schema-valued options are the
contract. In the example above, `upsertEntry.fields` is not an arbitrary sample
object; it is the schema that determines the command factory input and the
runtime command validation. If `ArticleEntryFields` requires `title` and
`views`, then `contentful.commands.upsertEntry(...)` requires both fields and
the destination command decoder rejects commands that omit either field.

Source-to-destination mapping still belongs in the migration pipeline. To force
a destination-required field to be mapped, make that field required in the
schema accepted by the command option, or expose an explicit command option for
that mapping. Do not rely on plugin internals to infer required source mappings
that are not represented in the public command schema or options.

## Command Definitions

Inside the plugin factory, build command definitions from the configured command
options. Command factories should close over plugin-level options such as
`contentType` and expose only the command-specific inputs the pipeline needs.

```ts
const makeUpsertEntryCommand = <
  const ContentType extends string,
  const Fields extends object,
>(
  contentType: ContentType,
  options: { readonly fields: Schema.Codec<Fields, Fields, never, never> }
) => {
  const UpsertEntry = Schema.Struct({
    contentType: Schema.Literal(contentType),
    fields: options.fields,
    id: Schema.String,
    kind: Schema.Literal("UpsertEntry"),
  });
  type UpsertEntry = typeof UpsertEntry.Type;

  return defineDestinationCommand("UpsertEntry", {
    identity: true,
    make: {
      upsertEntry: (id: string, fields: Fields): UpsertEntry => ({
        contentType,
        fields,
        id,
        kind: "UpsertEntry",
      }),
    },
    schema: UpsertEntry,
  });
};

const makePublishEntryCommand = <const ContentType extends string>(
  contentType: ContentType
) => {
  const PublishEntry = Schema.Struct({
    contentType: Schema.Literal(contentType),
    id: Schema.String,
    kind: Schema.Literal("PublishEntry"),
  });
  type PublishEntry = typeof PublishEntry.Type;

  return defineDestinationCommand("PublishEntry", {
    identity: false,
    make: {
      publishEntry: (id: string): PublishEntry => ({
        contentType,
        id,
        kind: "PublishEntry",
      }),
    },
    schema: PublishEntry,
  });
};
```

The command name must match the command schema's `kind` literal. The `identity`
flag marks the command kind that can create or update the destination identity
for the source item. The optional `make` object defines command factories once,
beside the schema that validates their return values.

## Plugin Definitions

A destination plugin definition groups command definitions and exposes their
factories as one `commands` object.

```ts
const upsertEntry = makeUpsertEntryCommand(
  options.contentType,
  options.commands.upsertEntry
);
const publishEntry = makePublishEntryCommand(options.contentType);

const ContentfulPlugin = defineDestinationPlugin("contentful").add(
  upsertEntry,
  publishEntry
);
```

The plugin definition exposes `ContentfulPlugin.commands`, which contains
`upsertEntry(...)` and `publishEntry(...)`.

`defineDestinationPlugin(...)` starts as an empty declaration so authors can add
commands fluently. A plugin must contain at least one command before it can be
implemented, and command names must be unique within the plugin. Duplicate
command names and duplicate factory names are rejected by TypeScript and also
fail at the `.add(...)` runtime boundary.

## Destination Schemas

Destination schemas validate pipeline-facing values. They must not perform
representation-changing decoding.

For example, destination field schemas should use `Schema.Number` when the
pipeline works with numbers:

```ts
const ArticleEntryFields = Schema.Struct({
  title: Schema.String,
  views: Schema.Number,
});
```

Do not use decoding schemas such as `Schema.NumberFromString` in destination
field schemas. If the source representation is a string, decode it in the Source
Payload Schema before the pipeline runs. Destination-native formatting, API
payload conversion, locale wrapping, or CMS field encoding belongs inside the
destination plugin implementation.

The command schemas built by the plugin should follow the same rule: they
validate already-decoded command values instead of transforming them.

## Command Factories

Migration authors should normally call destination-owned command factories
instead of constructing arbitrary command records.

```ts
const contentful = ContentfulDestinationPlugin.make({
  contentType: "article",
  commands: {
    publishEntry: true,
    upsertEntry: { fields: ArticleEntryFields },
  },
});

const command = contentful.commands.upsertEntry("article-1", {
  title: "Schema-first migrations",
  views: 1280,
});
```

Factories provide autocomplete for configured fields and supported command
kinds. They also prevent callers from inventing unsupported `kind` strings or
passing options for commands the plugin did not configure.

## Command Plans

Pipelines return one command or an ordered command array. The runner validates
the plan before and during execution:

- the plan must contain at least one command
- the plan may include at most one identity-bearing command
- execution may produce at most one destination identity
- side-effect-only commands may omit destination identity and version

Identity-bearing command results are persisted as the migrated item's
destination identity and version:

```ts
return {
  destinationIdentity: updated.uid,
  destinationVersion: updated.version,
  metadata: {
    operation: "upsert-entry",
  },
};
```

Side-effect-only commands can return `{}`:

```ts
return {};
```

## Command Handlers

Implement command handlers with `plugin.implement(...)`. The handler input is
inferred from the command definition schema.

```ts
const ContentfulDestinationPlugin = {
  make: (options: ContentfulOptions) => {
    const upsertEntry = makeUpsertEntryCommand(
      options.contentType,
      options.commands.upsertEntry
    );
    const publishEntry = makePublishEntryCommand(options.contentType);
    const plugin = defineDestinationPlugin("contentful").add(
      upsertEntry,
      publishEntry
    );

    return plugin
      .implement((handlers) =>
        handlers
          .handle("UpsertEntry", ({ command }) =>
            Effect.gen(function* () {
              const contentful = yield* ContentfulClient;
              const fields = encodeFieldsForContentful(command.fields);
              const updated = yield* contentful.upsertEntry({
                contentType: command.contentType,
                fields,
                id: command.id,
              });

              return {
                destinationIdentity: updated.sys.id,
                destinationVersion: String(updated.sys.version),
              };
            })
          )
          .handle("PublishEntry", ({ command }) =>
            Effect.gen(function* () {
              const contentful = yield* ContentfulClient;
              const published = yield* contentful.publishEntry({
                id: command.id,
              });

              return {
                metadata: {
                  publishedVersion: published.sys.version,
                },
              };
            })
          )
      )
      .provide(ContentfulClient.live(options));
  },
};
```

`DestinationCommandContext` gives each handler the migration definition id, run
id, source identity, source version, and previous item state when one exists.
Handlers return destination identity, version, and metadata for the command they
executed. Every command in the plugin definition must have exactly one handler.

Handlers should use ordinary Effect services for destination capabilities:

```ts
class ContentfulClient extends Context.Service<
  ContentfulClient,
  {
    readonly publishEntry: (
      input: ContentfulPublishInput
    ) => Effect.Effect<ContentfulEntry, DestinationPluginError>;
    readonly upsertEntry: (
      input: ContentfulUpsertInput
    ) => Effect.Effect<ContentfulEntry, DestinationPluginError>;
  }
>()("@migrate-sdk/contentful/ContentfulClient") {}
```

`plugin.implement(...)` returns a configured destination plugin. Its
`.provide(...)` method supplies the services used by the handlers before the
destination is returned to migration authors.

Destination plugins may classify transient failures with typed
`DestinationPluginError` values. The migration definition chooses whether and
how those effects are retried.

## Configured Destination Plugin

A first-party destination plugin module should return the value produced by
`plugin.implement(...).provide(...)`:

```ts
const contentful = ContentfulDestinationPlugin.make({
  accessToken,
  commands: {
    publishEntry: true,
    upsertEntry: { fields: ArticleEntryFields },
  },
  contentType: "article",
  environmentId: "master",
  spaceId,
});

contentful.commands.upsertEntry("article-1", {
  title: "Schema-first migrations",
  views: 1280,
});

contentful.commands.publishEntry("article-1");
```

Migration authors use `commands` to create destination-owned command records.
