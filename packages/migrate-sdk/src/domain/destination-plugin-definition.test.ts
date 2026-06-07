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
  defineDestinationCommandGroup,
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

const UpsertProduct = Schema.Struct({
  kind: Schema.Literal("UpsertProduct"),
  key: Schema.String,
});
type UpsertProduct = typeof UpsertProduct.Type;

const PublishProduct = Schema.Struct({
  kind: Schema.Literal("PublishProduct"),
  key: Schema.String,
});
type PublishProduct = typeof PublishProduct.Type;

const UpsertInventory = Schema.Struct({
  kind: Schema.Literal("UpsertInventory"),
  quantity: Schema.Number,
  sku: Schema.String,
});
type UpsertInventory = typeof UpsertInventory.Type;

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

const upsertProduct = defineDestinationCommand("UpsertProduct", {
  identity: true,
  make: {
    upsertProduct: (key: string): UpsertProduct => ({
      key,
      kind: "UpsertProduct",
    }),
  },
  schema: UpsertProduct,
});

const publishProduct = defineDestinationCommand("PublishProduct", {
  identity: false,
  make: {
    publishProduct: (key: string): PublishProduct => ({
      key,
      kind: "PublishProduct",
    }),
  },
  schema: PublishProduct,
});

const upsertInventory = defineDestinationCommand("UpsertInventory", {
  identity: false,
  make: {
    upsertInventory: (sku: string, quantity: number): UpsertInventory => ({
      kind: "UpsertInventory",
      quantity,
      sku,
    }),
  },
  schema: UpsertInventory,
});

const catalogDestination = defineDestinationPlugin("catalog").addGroup(
  defineDestinationCommandGroup("products").add(upsertProduct, publishProduct),
  defineDestinationCommandGroup("inventory").add(upsertInventory)
);

const topLevelCatalogDestination = defineDestinationPlugin(
  "top-level-catalog"
).addGroup(
  defineDestinationCommandGroup("products")
    .topLevel()
    .add(upsertProduct, publishProduct)
);

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

  // @ts-expect-error command group identifiers must be non-empty.
  defineDestinationCommandGroup("");
  // @ts-expect-error command group identifiers must not use the reserved root identifier.
  defineDestinationCommandGroup("@root");

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

  articleDestination.implement((handlers) => {
    // @ts-expect-error root commands are implemented with handlers.handle(...).
    handlers.group("@root", (root) => root);

    return handlers
      .handle("UpsertArticle", () => Effect.succeed({}))
      .handle("PublishArticle", () => Effect.succeed({}));
  });

  catalogDestination.commands.products.upsertProduct("product-key");
  catalogDestination.commands.products.publishProduct("product-key");
  catalogDestination.commands.inventory.upsertInventory("sku-1", 5);
  // @ts-expect-error grouped commands are not exposed at the root by default.
  catalogDestination.commands.upsertProduct("product-key");

  topLevelCatalogDestination.commands.upsertProduct("product-key");
  topLevelCatalogDestination.commands.publishProduct("product-key");
  // @ts-expect-error top-level groups expose factories at the root.
  topLevelCatalogDestination.commands.products.upsertProduct("product-key");

  topLevelCatalogDestination.implement((handlers) => {
    // @ts-expect-error top-level command groups are implemented with handlers.handle(...).
    handlers.group("products", (products) => products);

    return handlers
      .handle("UpsertProduct", () => Effect.succeed({}))
      .handle("PublishProduct", () => Effect.succeed({}));
  });

  const namespacedFactoryReuse = defineDestinationPlugin(
    "namespaced-factory-reuse"
  )
    .addGroup(
      defineDestinationCommandGroup("archives").add(
        archiveArticleWithDuplicateFactory
      )
    )
    .add(publishArticle);
  namespacedFactoryReuse.commands.publishArticle();
  namespacedFactoryReuse.commands.archives.publishArticle();

  const productsGroup =
    defineDestinationCommandGroup("duplicate-products").add(upsertProduct);
  const productsGroupV2 = defineDestinationCommandGroup(
    "duplicate-products-v2"
  ).add(upsertProduct);
  const pluginWithProductsGroup = defineDestinationPlugin(
    "duplicate-group-existing"
  ).addGroup(productsGroup);
  // @ts-expect-error command group identifiers must be unique within a destination plugin.
  pluginWithProductsGroup.addGroup(productsGroup);
  defineDestinationPlugin("duplicate-groups-added").addGroup(
    productsGroup,
    // @ts-expect-error command group identifiers must be unique within one addGroup call.
    productsGroup
  );
  defineDestinationPlugin("duplicate-commands-across-groups").addGroup(
    productsGroup,
    // @ts-expect-error command names must be unique across destination command groups.
    productsGroupV2
  );
  defineDestinationPlugin("duplicate-top-level-factory").addGroup(
    defineDestinationCommandGroup("publish").topLevel().add(publishArticle),
    // @ts-expect-error top-level command factory names must be unique.
    defineDestinationCommandGroup("archive")
      .topLevel()
      .add(archiveArticleWithDuplicateFactory)
  );
  defineDestinationPlugin("top-level-factory-group-collision").addGroup(
    defineDestinationCommandGroup("products").topLevel().add(upsertProduct),
    // @ts-expect-error named command group identifiers must not collide with top-level factory names.
    defineDestinationCommandGroup("upsertProduct").add(upsertInventory)
  );

  catalogDestination.implement((handlers) =>
    handlers
      .group("products", (products) =>
        // @ts-expect-error every command in a group must have a handler.
        products.handle("UpsertProduct", () => Effect.succeed({}))
      )
      .group("inventory", (inventory) =>
        inventory.handle("UpsertInventory", () => Effect.succeed({}))
      )
  );

  catalogDestination.implement((handlers) => {
    const afterProducts = handlers.group("products", (products) =>
      products
        .handle("UpsertProduct", () => Effect.succeed({}))
        .handle("PublishProduct", () => Effect.succeed({}))
    );

    // @ts-expect-error handled command groups are no longer available.
    afterProducts.group("products", (products) => products);

    return afterProducts.group("inventory", (inventory) =>
      inventory.handle("UpsertInventory", () => Effect.succeed({}))
    );
  });
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

  it.effect("executes grouped command handlers", () =>
    Effect.gen(function* () {
      const events: string[] = [];
      const destination = catalogDestination.implement((handlers) =>
        handlers
          .group("products", (products) =>
            products
              .handle("UpsertProduct", ({ command }) =>
                Effect.sync(() => {
                  events.push(`product-upsert:${command.key}`);
                  return {
                    destinationIdentity: `product:${command.key}`,
                  };
                })
              )
              .handle("PublishProduct", ({ command }) =>
                Effect.sync(() => {
                  events.push(`product-publish:${command.key}`);
                  return {};
                })
              )
          )
          .group("inventory", (inventory) =>
            inventory.handle("UpsertInventory", ({ command }) =>
              Effect.sync(() => {
                events.push(
                  `inventory-upsert:${command.sku}:${command.quantity}`
                );
                return {};
              })
            )
          )
      );
      const plugin = yield* DestinationPlugin.pipe(
        Effect.provide(destination.layer)
      );
      const result = yield* plugin.execute(
        destination.commands.products.upsertProduct("product-key"),
        commandContext
      );

      yield* plugin.execute(
        destination.commands.products.publishProduct("product-key"),
        commandContext
      );
      yield* plugin.execute(
        destination.commands.inventory.upsertInventory("sku-1", 5),
        commandContext
      );

      expect(result).toEqual(
        makeDestinationCommandResult({
          destinationIdentity: "product:product-key",
        })
      );
      expect(events).toEqual([
        "product-upsert:product-key",
        "product-publish:product-key",
        "inventory-upsert:sku-1:5",
      ]);
      expectTypeOf(destination.commands.products.upsertProduct).toEqualTypeOf<
        (key: string) => UpsertProduct
      >();
      expectTypeOf(
        destination.commands.inventory.upsertInventory
      ).toEqualTypeOf<(sku: string, quantity: number) => UpsertInventory>();
    })
  );

  it("flattens top-level command group factories onto the plugin definition", () => {
    expect(
      topLevelCatalogDestination.commands.upsertProduct("product-key")
    ).toEqual({
      key: "product-key",
      kind: "UpsertProduct",
    });
    expectTypeOf(
      topLevelCatalogDestination.commands.publishProduct
    ).toEqualTypeOf<(key: string) => PublishProduct>();
  });

  it("allows named group factories to reuse root command factory names", () => {
    const destination = defineDestinationPlugin("runtime-factory-reuse")
      .addGroup(
        defineDestinationCommandGroup("archives").add(
          archiveArticleWithDuplicateFactory
        )
      )
      .add(publishArticle);

    expect(destination.commands.publishArticle()).toEqual({
      kind: "PublishArticle",
    });
    expect(destination.commands.archives.publishArticle()).toEqual({
      kind: "ArchiveArticle",
    });
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
    const defineDestinationCommandGroupUnsafe =
      defineDestinationCommandGroup as unknown as (
        identifier: unknown
      ) => unknown;

    expect(() => defineDestinationPluginUnsafe("")).toThrow(
      "Destination plugin identifier must be a non-empty string"
    );
    expect(() => defineDestinationCommandGroupUnsafe("")).toThrow(
      "Destination command group identifier must be a non-empty string"
    );
    expect(() => defineDestinationCommandGroupUnsafe("@root")).toThrow(
      'Destination command group identifier "@root" is reserved'
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

  it("throws when command groups are unsafe through an untyped boundary", () => {
    const plugin = defineDestinationPlugin("runtime-command-groups");
    const addGroupUnsafe = plugin.addGroup.bind(plugin) as unknown as (
      ...groups: readonly unknown[]
    ) => unknown;
    const productsGroup =
      defineDestinationCommandGroup("runtime-products").add(upsertProduct);

    expect(addGroupUnsafe).toThrow(
      "Destination plugin addGroup requires at least one command group"
    );
    expect(() =>
      addGroupUnsafe({
        identifier: "not-a-command-group",
      })
    ).toThrow("Destination plugin addGroup requires command groups");
    expect(() =>
      addGroupUnsafe(defineDestinationCommandGroup("runtime-empty-group"))
    ).toThrow(
      'Destination command group "runtime-empty-group" must define at least one command'
    );

    const pluginWithProductsGroup = defineDestinationPlugin(
      "runtime-duplicate-command-groups"
    ).addGroup(productsGroup);
    const addDuplicateGroupUnsafe = pluginWithProductsGroup.addGroup.bind(
      pluginWithProductsGroup
    ) as unknown as (...groups: readonly unknown[]) => unknown;

    expect(() => addDuplicateGroupUnsafe(productsGroup)).toThrow(
      "Duplicate destination command group: runtime-products"
    );
    expect(() =>
      addGroupUnsafe(
        productsGroup,
        defineDestinationCommandGroup("runtime-products-v2").add(upsertProduct)
      )
    ).toThrow("Duplicate destination command definition: UpsertProduct");
    expect(() =>
      addGroupUnsafe(
        defineDestinationCommandGroup("runtime-publish")
          .topLevel()
          .add(publishArticle),
        defineDestinationCommandGroup("runtime-archive")
          .topLevel()
          .add(archiveArticleWithDuplicateFactory)
      )
    ).toThrow("Duplicate destination command factory: publishArticle");
    expect(() =>
      addGroupUnsafe(
        defineDestinationCommandGroup("runtime-products")
          .topLevel()
          .add(upsertProduct),
        defineDestinationCommandGroup("upsertProduct").add(upsertInventory)
      )
    ).toThrow("Duplicate destination command namespace: upsertProduct");
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
