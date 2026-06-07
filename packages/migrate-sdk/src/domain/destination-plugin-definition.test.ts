import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import { Service } from "effect/Context";
import {
  type DestinationCommand,
  type DestinationCommandContext,
  type DestinationCommandHandler,
  type DestinationCommandResultInput,
  DestinationPlugin,
  DestinationPluginError,
  defineDestinationCommand,
  defineDestinationPlugin,
  makeDestinationCommandResult,
  toDestinationIdentity,
  toDestinationVersion,
  toMigrationDefinitionId,
  toMigrationRunId,
  toSourceIdentity,
  toSourceVersion,
} from "migrate-sdk";
import { expectTypeOf } from "vitest";
import { DestinationPluginBuilder } from "./destination-plugin-definition.ts";

const UpsertArticle = Schema.Struct({
  kind: Schema.Literal("UpsertArticle"),
  fields: Schema.Struct({
    title: Schema.String,
    views: Schema.Number,
  }),
});
type UpsertArticle = typeof UpsertArticle.Type;

const PublishArticle = Schema.Struct({
  kind: Schema.Literal("PublishArticle"),
});
type PublishArticle = typeof PublishArticle.Type;

const ArchiveArticle = Schema.Struct({
  kind: Schema.Literal("ArchiveArticle"),
});
type ArchiveArticle = typeof ArchiveArticle.Type;

const CommandWithoutKind = Schema.Struct({
  value: Schema.String,
});

const upsertArticle = defineDestinationCommand("UpsertArticle", {
  identity: true,
  make: {
    upsertArticle: (fields: UpsertArticle["fields"]): UpsertArticle => ({
      fields,
      kind: "UpsertArticle",
    }),
  },
  schema: UpsertArticle,
});

const publishArticle = defineDestinationCommand("PublishArticle", {
  identity: false,
  make: {
    publishArticle: (): PublishArticle => ({
      kind: "PublishArticle",
    }),
  },
  schema: PublishArticle,
});

const archiveArticleWithDuplicateFactory = defineDestinationCommand(
  "ArchiveArticle",
  {
    identity: false,
    make: {
      publishArticle: (): ArchiveArticle => ({
        kind: "ArchiveArticle",
      }),
    },
    schema: ArchiveArticle,
  }
);

const articleDestination = defineDestinationPlugin("articles")
  .add(upsertArticle)
  .add(publishArticle);

interface UnsafeDestinationHandlers {
  readonly handle: (
    name: string,
    handler: DestinationCommandHandler<
      typeof upsertArticle | typeof publishArticle
    >
  ) => UnsafeDestinationHandlers;
}

const destinationPluginLayerUnsafe =
  DestinationPluginBuilder.layer as unknown as (
    plugin: unknown,
    build: (handlers: UnsafeDestinationHandlers) => unknown
  ) => Layer.Layer<DestinationPlugin, DestinationPluginError>;

const destinationPluginLayerFailure = (
  layer: Layer.Layer<DestinationPlugin, DestinationPluginError>
) => DestinationPlugin.pipe(Effect.provide(layer), Effect.flip);

class ArticleDestinationApi extends Service<
  ArticleDestinationApi,
  {
    readonly publish: (
      input: PublishArticle,
      context: DestinationCommandContext
    ) => Effect.Effect<DestinationCommandResultInput, DestinationPluginError>;
    readonly upsert: (
      input: UpsertArticle,
      context: DestinationCommandContext
    ) => Effect.Effect<DestinationCommandResultInput, DestinationPluginError>;
  }
>()("@migrate-sdk/test/ArticleDestinationApi") {}

const failingArticleApiLayer: Layer.Layer<
  ArticleDestinationApi,
  DestinationPluginError
> = Layer.effect(
  ArticleDestinationApi,
  Effect.fail(
    new DestinationPluginError({
      message: "Article destination API layer failed",
    })
  )
);

const makeArticleApiLayer = (
  events: string[]
): Layer.Layer<ArticleDestinationApi> =>
  Layer.succeed(ArticleDestinationApi, {
    publish: (input, context) =>
      Effect.sync(() => {
        events.push(`${input.kind}:${context.sourceIdentity}`);
        return {};
      }),
    upsert: (input, context) =>
      Effect.sync(() => {
        events.push(`${input.kind}:${input.fields.title}`);
        return {
          destinationIdentity: `entry:${context.sourceIdentity}`,
          destinationVersion: `version:${input.fields.views}`,
        };
      }),
  });

const commandContext: DestinationCommandContext = {
  definitionId: toMigrationDefinitionId("articles"),
  runId: toMigrationRunId("run-1"),
  sourceIdentity: toSourceIdentity("article-1"),
  sourceVersion: toSourceVersion("source-version-1"),
};

const assertDestinationPluginDefinitionTypes = () => {
  // @ts-expect-error command names must be non-empty.
  defineDestinationCommand("", {
    identity: true,
    schema: UpsertArticle,
  });

  defineDestinationCommand("UpsertArticle", {
    identity: true,
    // @ts-expect-error command definition names must match their schema kind.
    schema: PublishArticle,
  });

  defineDestinationCommand("UpsertArticle", {
    identity: true,
    make: {
      // @ts-expect-error command factories must return the command schema type.
      upsertArticle: (): PublishArticle => ({ kind: "PublishArticle" }),
    },
    schema: UpsertArticle,
  });

  // @ts-expect-error destination plugin identifiers must be non-empty.
  defineDestinationPlugin("");

  const pluginWithOneCommand =
    defineDestinationPlugin("duplicate-existing").add(upsertArticle);
  // @ts-expect-error command names must be unique within a destination plugin.
  pluginWithOneCommand.add(upsertArticle);

  // @ts-expect-error destination plugins require at least one command to be added.
  defineDestinationPlugin("empty-add").add();

  // @ts-expect-error command names must be unique within one add call.
  defineDestinationPlugin("duplicate-added").add(upsertArticle, upsertArticle);

  const pluginWithPublishFactory = defineDestinationPlugin(
    "duplicate-factory-existing"
  ).add(publishArticle);
  // @ts-expect-error command factory names must be unique within a destination plugin.
  pluginWithPublishFactory.add(archiveArticleWithDuplicateFactory);

  defineDestinationPlugin("duplicate-factories-added").add(
    publishArticle,
    // @ts-expect-error command factory names must be unique within one add call.
    archiveArticleWithDuplicateFactory
  );

  DestinationPluginBuilder.layer(
    // @ts-expect-error destination plugin layers require at least one command.
    defineDestinationPlugin("empty"),
    (handlers) => handlers
  );

  DestinationPluginBuilder.layer(articleDestination, (handlers) =>
    // @ts-expect-error every destination command must have a handler.
    handlers.handle("UpsertArticle", () => Effect.succeed({}))
  );

  // @ts-expect-error destination plugin implementations require at least one command.
  defineDestinationPlugin("empty").implement((handlers) => handlers);

  articleDestination.implement((handlers) =>
    // @ts-expect-error every destination command must have a handler.
    handlers.handle("UpsertArticle", () => Effect.succeed({}))
  );
};

describe("destination plugin definitions", () => {
  it("aggregates command factories onto the plugin definition", () => {
    const upsert = articleDestination.commands.upsertArticle({
      title: "Factory-defined commands",
      views: 3,
    });
    const publish = articleDestination.commands.publishArticle();

    expect(upsert).toEqual({
      fields: {
        title: "Factory-defined commands",
        views: 3,
      },
      kind: "UpsertArticle",
    });
    expect(publish).toEqual({ kind: "PublishArticle" });
    expectTypeOf(articleDestination.commands.upsertArticle).toEqualTypeOf<
      (fields: UpsertArticle["fields"]) => UpsertArticle
    >();
    expectTypeOf(articleDestination.commands.publishArticle).toEqualTypeOf<
      () => PublishArticle
    >();
  });

  it("infers handler command input from the command schema", () => {
    expect(assertDestinationPluginDefinitionTypes).toBeInstanceOf(Function);

    expectTypeOf<DestinationCommandHandler<typeof upsertArticle>>()
      .parameter(0)
      .toEqualTypeOf<{
        readonly command: UpsertArticle;
        readonly context: DestinationCommandContext;
        readonly definition: typeof upsertArticle;
        readonly plugin: unknown;
      }>();

    DestinationPluginBuilder.layer(articleDestination, (handlers) =>
      handlers
        .handle("UpsertArticle", ({ command }) =>
          Effect.succeed({
            destinationIdentity: command.fields.title,
          })
        )
        .handle("PublishArticle", ({ command }) => {
          expectTypeOf(command).toEqualTypeOf<PublishArticle>();
          return Effect.succeed({});
        })
    );
  });

  it("throws when duplicate command names are added through an untyped boundary", () => {
    const plugin =
      defineDestinationPlugin("runtime-duplicates").add(upsertArticle);
    const addUnsafe = plugin.add.bind(plugin) as unknown as (
      ...definitions: readonly [typeof upsertArticle]
    ) => unknown;

    expect(() => addUnsafe(upsertArticle)).toThrow(
      "Duplicate destination command definition: UpsertArticle"
    );
  });

  it("throws when duplicate command factory names are added through an untyped boundary", () => {
    const plugin = defineDestinationPlugin("runtime-duplicate-factories").add(
      publishArticle
    );
    const addUnsafe = plugin.add.bind(plugin) as unknown as (
      ...definitions: readonly [typeof archiveArticleWithDuplicateFactory]
    ) => unknown;

    expect(() => addUnsafe(archiveArticleWithDuplicateFactory)).toThrow(
      "Duplicate destination command factory: publishArticle"
    );
  });

  it("throws when command definitions are unsafe through an untyped boundary", () => {
    const defineDestinationCommandUnsafe =
      defineDestinationCommand as unknown as (
        name: unknown,
        definition: unknown
      ) => unknown;

    expect(() =>
      defineDestinationCommandUnsafe("", {
        schema: UpsertArticle,
      })
    ).toThrow("Destination command name must be a non-empty string");
    expect(() =>
      defineDestinationCommandUnsafe("UnsafeCommand", undefined)
    ).toThrow("Destination command definition must be an object");
    expect(() => defineDestinationCommandUnsafe("UnsafeCommand", {})).toThrow(
      "Destination command definition requires a schema"
    );
    expect(() =>
      defineDestinationCommandUnsafe("UnsafeCommand", {
        schema: CommandWithoutKind,
      })
    ).toThrow("Destination command schema must define a kind literal");
    expect(() =>
      defineDestinationCommandUnsafe("UnsafeCommand", {
        schema: UpsertArticle,
      })
    ).toThrow(
      'Destination command schema kind "UpsertArticle" must match command name "UnsafeCommand"'
    );
    expect(() =>
      defineDestinationCommandUnsafe("UpsertArticle", {
        make: null,
        schema: UpsertArticle,
      })
    ).toThrow("Destination command factories must be an object");
    expect(() =>
      defineDestinationCommandUnsafe("UpsertArticle", {
        make: {
          "": () => ({ kind: "UpsertArticle" }),
        },
        schema: UpsertArticle,
      })
    ).toThrow("Destination command factory name must be a non-empty string");
    expect(() =>
      defineDestinationCommandUnsafe("UpsertArticle", {
        make: {
          unsafeCommand: "not a function",
        },
        schema: UpsertArticle,
      })
    ).toThrow('Destination command factory "unsafeCommand" must be a function');
  });

  it("throws when a plugin identifier is unsafe through an untyped boundary", () => {
    const defineDestinationPluginUnsafe =
      defineDestinationPlugin as unknown as (identifier: unknown) => unknown;

    expect(() => defineDestinationPluginUnsafe("")).toThrow(
      "Destination plugin identifier must be a non-empty string"
    );
  });

  it("throws when a non-command is added through an untyped boundary", () => {
    const plugin = defineDestinationPlugin("runtime-non-command");
    const addUnsafe = plugin.add.bind(plugin) as unknown as (
      ...definitions: readonly unknown[]
    ) => unknown;

    expect(() =>
      addUnsafe({
        name: "NotACommand",
      })
    ).toThrow("Destination plugin add requires destination commands");
  });

  it("throws when no commands are added through an untyped boundary", () => {
    const plugin = defineDestinationPlugin("runtime-empty-add");
    const addUnsafe = plugin.add.bind(plugin) as unknown as () => unknown;

    expect(addUnsafe).toThrow(
      "Destination plugin add requires at least one command"
    );
  });

  it("throws when an empty plugin is implemented through an untyped boundary", () => {
    const plugin = defineDestinationPlugin(
      "runtime-empty-implement"
    ) as unknown as {
      readonly implement: (build: (handlers: unknown) => unknown) => unknown;
    };

    expect(() => plugin.implement((handlers) => handlers)).toThrow(
      "Destination plugins must define at least one command"
    );
  });

  it.effect(
    "fails when an empty plugin layer is built through an untyped boundary",
    () =>
      Effect.gen(function* () {
        const error = yield* destinationPluginLayerFailure(
          destinationPluginLayerUnsafe(
            defineDestinationPlugin("runtime-empty-layer"),
            (handlers) => handlers
          )
        );

        expect(error).toBeInstanceOf(DestinationPluginError);
        expect(error.message).toBe(
          "Destination plugins must define at least one command"
        );
      })
  );

  it.effect(
    "fails when a plugin implementation omits a command handler through an untyped boundary",
    () =>
      Effect.gen(function* () {
        const error = yield* destinationPluginLayerFailure(
          destinationPluginLayerUnsafe(articleDestination, (handlers) =>
            handlers.handle("UpsertArticle", () => Effect.succeed({}))
          )
        );

        expect(error).toBeInstanceOf(DestinationPluginError);
        expect(error.message).toBe(
          "Destination command not handled: PublishArticle"
        );
      })
  );

  it.effect(
    "fails when a command handler is registered twice through an untyped boundary",
    () =>
      Effect.gen(function* () {
        const error = yield* destinationPluginLayerFailure(
          destinationPluginLayerUnsafe(articleDestination, (handlers) =>
            handlers
              .handle("UpsertArticle", () => Effect.succeed({}))
              .handle("UpsertArticle", () => Effect.succeed({}))
              .handle("PublishArticle", () => Effect.succeed({}))
          )
        );

        expect(error).toBeInstanceOf(DestinationPluginError);
        expect(error.message).toBe(
          'Destination command "UpsertArticle" already has a handler'
        );
      })
  );

  it.effect(
    "fails when a plugin implementation returns an unsafe handler shape",
    () =>
      Effect.gen(function* () {
        const error = yield* destinationPluginLayerFailure(
          destinationPluginLayerUnsafe(articleDestination, () => ({
            handlers: [],
          }))
        );

        expect(error).toBeInstanceOf(DestinationPluginError);
        expect(error.message).toBe("Must return destination command handlers");
      })
  );

  it.effect(
    "fails when a plugin implementation returns unsafe handler items",
    () =>
      Effect.gen(function* () {
        const error = yield* destinationPluginLayerFailure(
          destinationPluginLayerUnsafe(articleDestination, () => ({
            handlers: new Map([
              ["UpsertArticle", {}],
              [
                "PublishArticle",
                {
                  definition: publishArticle,
                  handler: () => Effect.succeed({}),
                },
              ],
            ]),
            plugin: articleDestination,
          }))
        );

        expect(error).toBeInstanceOf(DestinationPluginError);
        expect(error.message).toBe(
          "Destination command handler item is invalid: UpsertArticle"
        );
      })
  );

  it.effect(
    "fails when a plugin implementation returns extra handler items",
    () =>
      Effect.gen(function* () {
        const error = yield* destinationPluginLayerFailure(
          destinationPluginLayerUnsafe(articleDestination, () => ({
            handlers: new Map([
              [
                "UpsertArticle",
                {
                  definition: upsertArticle,
                  handler: () => Effect.succeed({}),
                },
              ],
              [
                "PublishArticle",
                {
                  definition: publishArticle,
                  handler: () => Effect.succeed({}),
                },
              ],
              [
                "TypoCommand",
                {
                  definition: publishArticle,
                  handler: () => Effect.succeed({}),
                },
              ],
            ]),
            plugin: articleDestination,
          }))
        );

        expect(error).toBeInstanceOf(DestinationPluginError);
        expect(error.message).toBe(
          "Destination command handler is not defined: TypoCommand"
        );
      })
  );

  it.effect(
    "executes schema-decoded command handlers through the runtime service",
    () =>
      Effect.gen(function* () {
        const events: string[] = [];
        const destination = articleDestination
          .implement((handlers) =>
            handlers
              .handle("UpsertArticle", ({ command, context }) =>
                Effect.gen(function* () {
                  const api = yield* ArticleDestinationApi;
                  return yield* api.upsert(command, context);
                })
              )
              .handle("PublishArticle", ({ command, context }) =>
                Effect.gen(function* () {
                  const api = yield* ArticleDestinationApi;
                  return yield* api.publish(command, context);
                })
              )
          )
          .provide(makeArticleApiLayer(events));

        const command = destination.commands.upsertArticle({
          title: "Schema-first migrations",
          views: 7,
        });
        const plugin = yield* DestinationPlugin.pipe(
          Effect.provide(destination.layer)
        );
        const result = yield* plugin.execute(command, commandContext);

        yield* plugin.execute(
          destination.commands.publishArticle(),
          commandContext
        );

        expect(result).toEqual(
          makeDestinationCommandResult({
            destinationIdentity: toDestinationIdentity("entry:article-1"),
            destinationVersion: toDestinationVersion("version:7"),
          })
        );
        expect(events).toEqual([
          "UpsertArticle:Schema-first migrations",
          "PublishArticle:article-1",
        ]);
      })
  );

  it.effect(
    "allows provided dependency layers to fail as destination errors",
    () =>
      Effect.gen(function* () {
        const destination = articleDestination
          .implement((handlers) =>
            handlers
              .handle("UpsertArticle", ({ command, context }) =>
                Effect.gen(function* () {
                  const api = yield* ArticleDestinationApi;
                  return yield* api.upsert(command, context);
                })
              )
              .handle("PublishArticle", ({ command, context }) =>
                Effect.gen(function* () {
                  const api = yield* ArticleDestinationApi;
                  return yield* api.publish(command, context);
                })
              )
          )
          .provide(failingArticleApiLayer);

        const error = yield* DestinationPlugin.pipe(
          Effect.provide(destination.layer),
          Effect.flip
        );

        expect(error).toBeInstanceOf(DestinationPluginError);
        expect(error.message).toBe("Article destination API layer failed");
      })
  );

  it.effect(
    "fails before the handler when a raw command does not match its schema",
    () =>
      Effect.gen(function* () {
        const layer = DestinationPluginBuilder.layer(
          articleDestination,
          (handlers) =>
            handlers
              .handle("UpsertArticle", () => Effect.succeed({}))
              .handle("PublishArticle", () => Effect.succeed({}))
        );
        const plugin = yield* DestinationPlugin.pipe(Effect.provide(layer));
        const error = yield* plugin
          .execute(
            {
              kind: "UpsertArticle",
              fields: {
                title: "Missing views",
              },
            } as DestinationCommand,
            commandContext
          )
          .pipe(Effect.flip);

        expect(error).toBeInstanceOf(DestinationPluginError);
        expect(error.message).toBe(
          "Destination command did not match command schema"
        );
      })
  );
});
