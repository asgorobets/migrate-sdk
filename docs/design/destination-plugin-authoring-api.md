# Destination Plugin Authoring API

Audience: people implementing destination plugins.

Destination plugins execute destination commands. They own command definitions,
command validation, command factories, destination-native encoding, and the
Effect service layer used by the runner.

## Command Definitions

Destination commands use a public `kind` discriminator:

```ts
interface DestinationCommand {
  readonly kind: string;
}
```

Use plain `Schema.Struct` variants and `defineDestinationCommands`:

```ts
const UpsertEntry = Schema.Struct({
  contentType: Schema.String,
  fields: Schema.Record(Schema.String, Schema.Unknown),
  kind: Schema.Literal("UpsertEntry"),
});

const PublishEntry = Schema.Struct({
  contentType: Schema.String,
  kind: Schema.Literal("PublishEntry"),
});

const ContentfulCommands = defineDestinationCommands({
  UpsertEntry: {
    identity: true,
    schema: UpsertEntry,
  },
  PublishEntry: {
    identity: false,
    schema: PublishEntry,
  },
});
```

The object key must match the command schema's `kind` literal. The `identity`
flag marks the command kind that can create or update the destination identity
for the source item.

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

This rule also applies to `DestinationCommandSchema`:

```ts
type DestinationCommandSchema<Command extends DestinationCommand> =
  Schema.Codec<Command, Command, never, never>;
```

The encoded and decoded TypeScript shapes are intentionally the same.

## Command Factories

Migration authors should normally call destination-owned command factories
instead of constructing arbitrary command records.

```ts
const contentful = ContentfulDestinationPlugin.plugin({
  schemas: {
    article: ArticleEntryFields,
  },
});

const command = contentful.commands.upsertEntry("article", {
  title: "Schema-first migrations",
  views: 1280,
});
```

Factories provide autocomplete for supported content types, fields, and command
kinds. They also prevent callers from inventing unsupported `kind` strings.

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

## Execution Service

The runtime service boundary is one `execute` method:

```ts
interface DestinationPlugin {
  readonly execute: (
    command: DestinationCommand,
    context: DestinationCommandContext
  ) => Effect.Effect<DestinationCommandResult, DestinationPluginError>;
}
```

`DestinationCommandContext` gives the executor the migration definition id, run
id, source identity, source version, and previous item state when one exists.

```ts
const execute = Effect.fn("ContentfulDestination.execute")(function* (
  command: ContentfulCommand,
  context: DestinationCommandContext
) {
  switch (command.kind) {
    case "UpsertEntry": {
      const fields = encodeFieldsForContentful(command.fields);
      const updated = yield* upsertEntry({
        contentType: command.contentType,
        fields,
        sourceIdentity: context.sourceIdentity,
      });

      return {
        destinationIdentity: updated.sys.id,
        destinationVersion: String(updated.sys.version),
      };
    }

    case "PublishEntry": {
      yield* publishEntry({
        contentType: command.contentType,
        sourceIdentity: context.sourceIdentity,
      });

      return {};
    }
  }
});
```

Destination plugins may classify transient failures with typed
`DestinationPluginError` values. The migration definition chooses whether and
how those effects are retried.

## Configured Destination Plugin

A first-party destination plugin module should return a configured plugin with
command definitions and a layer:

```ts
interface ConfiguredDestinationPlugin<
  Command extends DestinationCommand,
> {
  readonly commandDefinitions: DefinedDestinationCommands<Command>;
  readonly layer: Layer.Layer<DestinationPlugin>;
}
```

Plugin-specific factories may attach typed command factories alongside the
configured plugin:

```ts
type ContentfulDestination = ConfiguredDestinationPlugin<ContentfulCommand> & {
  readonly commands: ContentfulCommandFactories;
};
```

The runner uses `commandDefinitions` to validate plans and uses the layer to
provide the destination service for one migration definition.
