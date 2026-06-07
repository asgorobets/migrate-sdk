import { Effect, Layer, Schema } from "effect";
import type { ConfiguredDestinationPlugin } from "../../domain/definition.ts";
import type {
  DestinationCommand,
  DestinationCommandContext,
  DestinationCommandResult,
  DestinationCommandResultInput,
} from "../../domain/destination.ts";
import { makeDestinationCommandResult } from "../../domain/destination.ts";
import {
  type AnyDefinedDestinationCommand,
  type AnyNonEmptyDestinationPluginDefinition,
  type DestinationPluginDefinitionCommand,
  type DestinationPluginDefinitionCommands,
  type DestinationPluginHandlers,
  type DestinationPluginHandlersFromPlugin,
  defineDestinationCommand,
  defineDestinationPlugin,
} from "../../domain/destination-plugin-definition.ts";
import { DestinationPluginError } from "../../domain/errors.ts";
import type {
  DestinationIdentity,
  DestinationVersion,
  SourceIdentity,
} from "../../domain/ids.ts";
import {
  toDestinationIdentity,
  toDestinationVersion,
} from "../../domain/ids.ts";
import { DestinationPlugin } from "../../services/destination-plugin.ts";

export interface InMemoryDestinationExecution<C extends DestinationCommand> {
  readonly command: C;
  readonly context: DestinationCommandContext;
  readonly result: DestinationCommandResult;
}

export interface InMemoryDestinationEntry {
  readonly contentType: string;
  readonly destinationIdentity: DestinationIdentity;
  readonly destinationVersion: DestinationVersion;
  readonly fields: object;
  readonly published: boolean;
  readonly sourceIdentity: SourceIdentity;
}

interface InMemoryDestinationState<C extends DestinationCommand> {
  readonly entries: Map<string, InMemoryDestinationEntry>;
  entryVersionCounter: number;
  executeAttempts: number;
  readonly executions: InMemoryDestinationExecution<C>[];
}

export type InMemoryDestinationExecute<C extends DestinationCommand> = (
  command: C,
  context: DestinationCommandContext
) =>
  | DestinationCommandResultInput
  | Effect.Effect<DestinationCommandResultInput, DestinationPluginError>;

export interface InMemoryDestinationOptions<
  Plugin extends AnyNonEmptyDestinationPluginDefinition,
> {
  readonly execute: InMemoryDestinationExecute<
    DestinationPluginDefinitionCommand<Plugin>
  >;
  readonly plugin: Plugin;
  readonly transientFailures?: InMemoryDestinationTransientFailures;
}

export type InMemoryDestination<
  Plugin extends AnyNonEmptyDestinationPluginDefinition,
> = ConfiguredDestinationPlugin<DestinationPluginDefinitionCommand<Plugin>> & {
  readonly commands: DestinationPluginDefinitionCommands<Plugin>;
};

export interface InMemoryDestinationTransientFailures {
  readonly execute?: number;
}

export interface InMemoryDestinationInspection<C extends DestinationCommand> {
  readonly entries: () => ReadonlyMap<string, InMemoryDestinationEntry>;
  readonly entry: (key: string) => InMemoryDestinationEntry | undefined;
  readonly executeAttempts: () => number;
  readonly executions: () => readonly InMemoryDestinationExecution<C>[];
}

export interface InMemoryDestinationFixture<
  Plugin extends AnyNonEmptyDestinationPluginDefinition,
> extends InMemoryDestinationInspection<
    DestinationPluginDefinitionCommand<Plugin>
  > {
  readonly destination: InMemoryDestination<Plugin>;
}

export type InMemoryEntryFieldSchema<Fields extends object = object> =
  Schema.Codec<Fields, Fields, never, never>;

type InMemoryEntryFieldSchemaFor<SchemaInput> =
  SchemaInput extends Schema.Codec<infer Fields, infer Encoded, never, never>
    ? Fields extends object
      ? [Fields] extends [Encoded]
        ? [Encoded] extends [Fields]
          ? InMemoryEntryFieldSchema<Fields>
          : never
        : never
      : never
    : never;

export interface InMemoryUpsertEntryCommandOptions<
  Fields extends object = object,
> {
  readonly fields: InMemoryEntryFieldSchema<Fields>;
}

export type InMemoryPublishEntryCommandOptions = true;

export interface InMemoryEntryDestinationCommandOptions {
  readonly publishEntry?: InMemoryPublishEntryCommandOptions;
  readonly upsertEntry?: InMemoryUpsertEntryCommandOptions;
}

type NonEmptyString<Value extends string> = Value extends "" ? never : Value;

type RequireAtLeastOneEntryCommand<
  Commands extends InMemoryEntryDestinationCommandOptions,
> = Commands extends
  | { readonly publishEntry: InMemoryPublishEntryCommandOptions }
  | { readonly upsertEntry: InMemoryUpsertEntryCommandOptions }
  ? Commands
  : never;

type InMemoryEntryDestinationCommandOptionsFor<
  Commands extends InMemoryEntryDestinationCommandOptions,
> = {
  readonly [Key in keyof Commands]: Key extends "upsertEntry"
    ? NonNullable<Commands[Key]> extends { readonly fields: infer FieldSchema }
      ? { readonly fields: InMemoryEntryFieldSchemaFor<FieldSchema> }
      : never
    : Key extends "publishEntry"
      ? InMemoryPublishEntryCommandOptions
      : never;
};

type InMemoryEntryFields<CommandOptions> =
  CommandOptions extends InMemoryUpsertEntryCommandOptions<infer Fields>
    ? Fields
    : never;

export type InMemoryUpsertEntryCommand<
  ContentType extends string,
  Commands extends InMemoryEntryDestinationCommandOptions,
> = Commands extends { readonly upsertEntry?: infer CommandOptions }
  ? NonNullable<CommandOptions> extends InMemoryUpsertEntryCommandOptions
    ? {
        readonly contentType: ContentType;
        readonly fields: InMemoryEntryFields<NonNullable<CommandOptions>>;
        readonly kind: "UpsertEntry";
      }
    : never
  : never;

export type InMemoryPublishEntryCommand<
  ContentType extends string,
  Commands extends InMemoryEntryDestinationCommandOptions,
> = Commands extends { readonly publishEntry?: infer CommandOptions }
  ? NonNullable<CommandOptions> extends InMemoryPublishEntryCommandOptions
    ? {
        readonly contentType: ContentType;
        readonly kind: "PublishEntry";
      }
    : never
  : never;

export type InMemoryEntryCommand<
  ContentType extends string,
  Commands extends InMemoryEntryDestinationCommandOptions,
> =
  | InMemoryUpsertEntryCommand<ContentType, Commands>
  | InMemoryPublishEntryCommand<ContentType, Commands>;

export type InMemoryEntryDestinationCommands<
  ContentType extends string,
  Commands extends InMemoryEntryDestinationCommandOptions,
> = (Commands extends {
  readonly upsertEntry: infer CommandOptions extends
    InMemoryUpsertEntryCommandOptions;
}
  ? {
      readonly upsertEntry: (
        fields: InMemoryEntryFields<CommandOptions>
      ) => InMemoryUpsertEntryCommand<ContentType, Commands>;
    }
  : Record<never, never>) &
  (Commands extends {
    readonly publishEntry: InMemoryPublishEntryCommandOptions;
  }
    ? {
        readonly publishEntry: () => InMemoryPublishEntryCommand<
          ContentType,
          Commands
        >;
      }
    : Record<never, never>);

export interface InMemoryEntryDestinationOptions<
  ContentType extends string,
  Commands extends InMemoryEntryDestinationCommandOptions,
> {
  readonly commands: RequireAtLeastOneEntryCommand<Commands> &
    InMemoryEntryDestinationCommandOptionsFor<Commands>;
  readonly contentType: NonEmptyString<ContentType>;
  readonly transientFailures?: InMemoryDestinationTransientFailures;
}

export type InMemoryEntryDestination<
  ContentType extends string,
  Commands extends InMemoryEntryDestinationCommandOptions,
> = ConfiguredDestinationPlugin<InMemoryEntryCommand<ContentType, Commands>> & {
  readonly commands: InMemoryEntryDestinationCommands<ContentType, Commands>;
};

export interface InMemoryEntryDestinationFixture<
  ContentType extends string,
  Commands extends InMemoryEntryDestinationCommandOptions,
> extends InMemoryDestinationInspection<
    InMemoryEntryCommand<ContentType, Commands>
  > {
  readonly destination: InMemoryEntryDestination<ContentType, Commands>;
}

const makeState = <
  C extends DestinationCommand,
>(): InMemoryDestinationState<C> => ({
  entries: new Map(),
  entryVersionCounter: 0,
  executeAttempts: 0,
  executions: [],
});

const isRecord = (value: unknown): value is Record<PropertyKey, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const assertTransientFailures = (value: unknown): void => {
  if (value === undefined) {
    return;
  }

  if (!isRecord(value)) {
    throw new Error(
      "In-memory destination transientFailures must be an object"
    );
  }

  const execute = value.execute;

  if (
    execute !== undefined &&
    (typeof execute !== "number" || !Number.isInteger(execute) || execute < 0)
  ) {
    throw new Error(
      "In-memory destination transientFailures.execute must be a non-negative integer"
    );
  }
};

const assertInMemoryDestinationOptions = <
  Plugin extends AnyNonEmptyDestinationPluginDefinition,
>(
  options: InMemoryDestinationInternalOptions<Plugin>
): void => {
  const input = options as unknown;

  if (!isRecord(input)) {
    throw new Error("In-memory destination options must be an object");
  }

  if (
    !isRecord(input.plugin) ||
    input.plugin.hasCommands !== true ||
    input.plugin.commandDefinitions === undefined
  ) {
    throw new Error(
      "In-memory destination requires a plugin with at least one command"
    );
  }

  if (typeof input.execute !== "function") {
    throw new Error("In-memory destination execute must be a function");
  }

  assertTransientFailures(input.transientFailures);
};

const assertInMemoryEntryDestinationOptions = <
  ContentType extends string,
  Commands extends InMemoryEntryDestinationCommandOptions,
>(
  options: InMemoryEntryDestinationInternalOptions<ContentType, Commands>
): void => {
  const input = options as unknown;

  if (!isRecord(input)) {
    throw new Error("In-memory entry destination options must be an object");
  }

  if (typeof input.contentType !== "string" || input.contentType.length === 0) {
    throw new Error(
      "In-memory entry destination contentType must be a non-empty string"
    );
  }

  if (!isRecord(input.commands)) {
    throw new Error("In-memory entry destination commands must be an object");
  }

  for (const commandName of Reflect.ownKeys(input.commands)) {
    if (commandName !== "publishEntry" && commandName !== "upsertEntry") {
      throw new Error(
        `In-memory entry destination command is not supported: ${String(commandName)}`
      );
    }
  }

  if (
    input.commands.upsertEntry === undefined &&
    input.commands.publishEntry === undefined
  ) {
    throw new Error(
      "In-memory entry destination must define at least one command"
    );
  }

  if (
    input.commands.publishEntry !== undefined &&
    input.commands.publishEntry !== true
  ) {
    throw new Error("In-memory publishEntry command option must be true");
  }

  if (input.commands.upsertEntry !== undefined) {
    if (!isRecord(input.commands.upsertEntry)) {
      throw new Error(
        "In-memory upsertEntry command options must be an object"
      );
    }

    if (!Schema.isSchema(input.commands.upsertEntry.fields)) {
      throw new Error("In-memory upsertEntry command requires a fields schema");
    }
  }

  assertTransientFailures(input.transientFailures);
};

interface InMemoryDestinationInternalOptions<
  Plugin extends AnyNonEmptyDestinationPluginDefinition,
> extends InMemoryDestinationOptions<Plugin> {
  readonly state?: InMemoryDestinationState<
    DestinationPluginDefinitionCommand<Plugin>
  >;
}

interface InMemoryEntryDestinationInternalOptions<
  ContentType extends string,
  Commands extends InMemoryEntryDestinationCommandOptions,
> extends InMemoryEntryDestinationOptions<ContentType, Commands> {
  readonly state?: InMemoryDestinationState<
    InMemoryEntryCommand<ContentType, Commands>
  >;
}

const makeInspection = <C extends DestinationCommand>(
  state: InMemoryDestinationState<C>
): InMemoryDestinationInspection<C> => ({
  entries: () => state.entries,
  entry: (key) => state.entries.get(key),
  executeAttempts: () => state.executeAttempts,
  executions: () => state.executions,
});

const transientDestinationError = (): DestinationPluginError =>
  new DestinationPluginError({
    message: "In-memory destination execute failed transiently",
  });

const inMemoryEntryKey = (
  contentType: string,
  sourceIdentity: SourceIdentity
) => `${contentType}:${sourceIdentity}`;

const nextEntryVersion = <C extends DestinationCommand>(
  state: InMemoryDestinationState<C>
): DestinationVersion => {
  state.entryVersionCounter += 1;
  return toDestinationVersion(`version:${state.entryVersionCounter}`);
};

const missingEntryPublishError = (
  contentType: string,
  context: DestinationCommandContext
): DestinationPluginError =>
  new DestinationPluginError({
    message: "Cannot publish an in-memory entry before it is upserted",
    cause: {
      contentType,
      sourceIdentity: context.sourceIdentity,
    },
  });

const addInMemoryDestinationHandlers = <
  Plugin extends AnyNonEmptyDestinationPluginDefinition,
>(
  plugin: Plugin,
  initialHandlers: DestinationPluginHandlersFromPlugin<Plugin>,
  execute: (
    command: DestinationPluginDefinitionCommand<Plugin>,
    context: DestinationCommandContext
  ) => Effect.Effect<DestinationCommandResultInput, DestinationPluginError>
): DestinationPluginHandlers<Plugin, never, never> => {
  let handlers = initialHandlers as unknown as DestinationPluginHandlers<
    Plugin,
    never,
    AnyDefinedDestinationCommand
  >;

  for (const definition of Object.values(plugin.definitions)) {
    handlers = handlers.handle(definition.name, ({ command, context }) =>
      execute(command as DestinationPluginDefinitionCommand<Plugin>, context)
    ) as unknown as DestinationPluginHandlers<
      Plugin,
      never,
      AnyDefinedDestinationCommand
    >;
  }

  return handlers as unknown as DestinationPluginHandlers<Plugin, never, never>;
};

const makeLayerWithState = <
  Plugin extends AnyNonEmptyDestinationPluginDefinition,
>(
  options: InMemoryDestinationInternalOptions<Plugin>
): Layer.Layer<DestinationPlugin, DestinationPluginError> => {
  assertInMemoryDestinationOptions(options);

  const state =
    options.state ?? makeState<DestinationPluginDefinitionCommand<Plugin>>();
  let remainingExecuteFailures = options.transientFailures?.execute ?? 0;
  const executeWithState = (
    command: DestinationPluginDefinitionCommand<Plugin>,
    context: DestinationCommandContext
  ): Effect.Effect<DestinationCommandResultInput, DestinationPluginError> =>
    Effect.gen(function* () {
      if (remainingExecuteFailures > 0) {
        remainingExecuteFailures -= 1;
        return yield* transientDestinationError();
      }

      const executeResult = options.execute(command, context);
      const resultInput = yield* Effect.isEffect(executeResult)
        ? executeResult
        : Effect.succeed(executeResult);
      const result = makeDestinationCommandResult(resultInput);

      state.executions.push({
        command,
        context,
        result,
      });

      return resultInput;
    });
  const destinationPlugin = options.plugin.implement((handlers) =>
    addInMemoryDestinationHandlers(
      options.plugin,
      handlers as DestinationPluginHandlersFromPlugin<Plugin>,
      executeWithState
    )
  );

  return Layer.effect(
    DestinationPlugin,
    Effect.gen(function* () {
      const destinationPlugin = yield* DestinationPlugin;

      return {
        execute: Effect.fn("InMemoryDestination.execute")((command, context) =>
          Effect.sync(() => {
            state.executeAttempts += 1;
          }).pipe(
            Effect.flatMap(() => destinationPlugin.execute(command, context))
          )
        ),
      };
    })
  ).pipe(Layer.provide(destinationPlugin.layer));
};

const makeLayer = <Plugin extends AnyNonEmptyDestinationPluginDefinition>(
  options: InMemoryDestinationOptions<Plugin>
): Layer.Layer<DestinationPlugin, DestinationPluginError> =>
  makeLayerWithState(options);

const makeWithState = <Plugin extends AnyNonEmptyDestinationPluginDefinition>(
  options: InMemoryDestinationInternalOptions<Plugin>
): InMemoryDestination<Plugin> => {
  assertInMemoryDestinationOptions(options);

  return {
    commandDefinitions: options.plugin
      .commandDefinitions as ConfiguredDestinationPlugin<
      DestinationPluginDefinitionCommand<Plugin>
    >["commandDefinitions"],
    commands: options.plugin
      .commands as DestinationPluginDefinitionCommands<Plugin>,
    layer: makeLayerWithState(options),
  };
};

const make = <Plugin extends AnyNonEmptyDestinationPluginDefinition>(
  options: InMemoryDestinationOptions<Plugin>
): InMemoryDestination<Plugin> => makeWithState(options);

const fixture = <Plugin extends AnyNonEmptyDestinationPluginDefinition>(
  options: InMemoryDestinationOptions<Plugin>
): InMemoryDestinationFixture<Plugin> => {
  const state = makeState<DestinationPluginDefinitionCommand<Plugin>>();
  const destination = makeWithState({
    ...options,
    state,
  });

  return {
    destination,
    ...makeInspection(state),
  };
};

const makeEntriesWithState = <
  const ContentType extends string,
  const Commands extends InMemoryEntryDestinationCommandOptions,
>(
  options: InMemoryEntryDestinationInternalOptions<ContentType, Commands>
): InMemoryEntryDestination<ContentType, Commands> => {
  assertInMemoryEntryDestinationOptions(options);

  const state =
    options.state ?? makeState<InMemoryEntryCommand<ContentType, Commands>>();
  const definitions: AnyDefinedDestinationCommand[] = [];
  const upsertEntryOptions = options.commands.upsertEntry;

  if (upsertEntryOptions !== undefined) {
    const fieldsSchema = upsertEntryOptions.fields as InMemoryEntryFieldSchema;
    const upsertEntrySchema = Schema.Struct({
      contentType: Schema.Literal(options.contentType),
      fields: fieldsSchema,
      kind: Schema.Literal("UpsertEntry"),
    });
    const upsertEntry = defineDestinationCommand("UpsertEntry", {
      identity: true,
      make: {
        upsertEntry: (fields: object) => ({
          contentType: options.contentType,
          fields,
          kind: "UpsertEntry" as const,
        }),
      },
      schema: upsertEntrySchema,
    });

    definitions.push(upsertEntry);
  }

  if (options.commands.publishEntry === true) {
    const publishEntrySchema = Schema.Struct({
      contentType: Schema.Literal(options.contentType),
      kind: Schema.Literal("PublishEntry"),
    });
    const publishEntry = defineDestinationCommand("PublishEntry", {
      identity: false,
      make: {
        publishEntry: () => ({
          contentType: options.contentType,
          kind: "PublishEntry" as const,
        }),
      },
      schema: publishEntrySchema,
    });

    definitions.push(publishEntry);
  }

  const [firstDefinition, ...remainingDefinitions] = definitions;

  if (firstDefinition === undefined) {
    throw new Error(
      "In-memory entry destination must define at least one command"
    );
  }

  const pluginDefinition = defineDestinationPlugin("in-memory-entries").add(
    firstDefinition,
    ...remainingDefinitions
  );
  const execute = (
    command: InMemoryEntryCommand<ContentType, Commands>,
    context: DestinationCommandContext
  ): Effect.Effect<DestinationCommandResultInput, DestinationPluginError> =>
    Effect.gen(function* () {
      const key = inMemoryEntryKey(command.contentType, context.sourceIdentity);

      if (command.kind === "PublishEntry") {
        const existing = state.entries.get(key);

        if (existing === undefined) {
          return yield* missingEntryPublishError(command.contentType, context);
        }

        state.entries.set(key, {
          ...existing,
          published: true,
        });

        return {};
      }

      const existing = state.entries.get(key);
      const previousDestinationIdentity =
        context.previousState !== undefined &&
        "destinationIdentity" in context.previousState
          ? context.previousState.destinationIdentity
          : undefined;
      const destinationIdentity =
        existing?.destinationIdentity ??
        previousDestinationIdentity ??
        toDestinationIdentity(
          `entry:${command.contentType}:${context.sourceIdentity}`
        );
      const destinationVersion = nextEntryVersion(state);

      state.entries.set(key, {
        contentType: command.contentType,
        destinationIdentity,
        destinationVersion,
        fields: command.fields,
        published: existing?.published ?? false,
        sourceIdentity: context.sourceIdentity,
      });

      return { destinationIdentity, destinationVersion };
    });
  let remainingExecuteFailures = options.transientFailures?.execute ?? 0;
  const executeWithState = (
    command: InMemoryEntryCommand<ContentType, Commands>,
    context: DestinationCommandContext
  ): Effect.Effect<DestinationCommandResultInput, DestinationPluginError> =>
    Effect.gen(function* () {
      if (remainingExecuteFailures > 0) {
        remainingExecuteFailures -= 1;
        return yield* transientDestinationError();
      }

      const resultInput = yield* execute(command, context);
      const result = makeDestinationCommandResult(resultInput);

      state.executions.push({
        command,
        context,
        result,
      });

      return resultInput;
    });
  const implementedPlugin = pluginDefinition.implement((handlers) =>
    addInMemoryDestinationHandlers(
      pluginDefinition,
      handlers as DestinationPluginHandlersFromPlugin<typeof pluginDefinition>,
      (command, context) =>
        executeWithState(
          command as InMemoryEntryCommand<ContentType, Commands>,
          context
        )
    )
  );
  const layer = Layer.effect(
    DestinationPlugin,
    Effect.gen(function* () {
      const destinationPlugin = yield* DestinationPlugin;

      return {
        execute: Effect.fn("InMemoryEntryDestination.execute")(
          (command, context) =>
            Effect.sync(() => {
              state.executeAttempts += 1;
            }).pipe(
              Effect.flatMap(() => destinationPlugin.execute(command, context))
            )
        ),
      };
    })
  ).pipe(Layer.provide(implementedPlugin.layer));

  return {
    commandDefinitions:
      implementedPlugin.commandDefinitions as ConfiguredDestinationPlugin<
        InMemoryEntryCommand<ContentType, Commands>
      >["commandDefinitions"],
    commands: implementedPlugin.commands as InMemoryEntryDestinationCommands<
      ContentType,
      Commands
    >,
    layer,
  };
};

const makeEntries = <
  const ContentType extends string,
  const Commands extends InMemoryEntryDestinationCommandOptions,
>(
  options: InMemoryEntryDestinationOptions<ContentType, Commands>
): InMemoryEntryDestination<ContentType, Commands> =>
  makeEntriesWithState(options);

const fixtureEntries = <
  const ContentType extends string,
  const Commands extends InMemoryEntryDestinationCommandOptions,
>(
  options: InMemoryEntryDestinationOptions<ContentType, Commands>
): InMemoryEntryDestinationFixture<ContentType, Commands> => {
  const state = makeState<InMemoryEntryCommand<ContentType, Commands>>();
  const destination = makeEntriesWithState({
    ...options,
    state,
  });

  return {
    destination,
    ...makeInspection(state),
  };
};

export const InMemoryDestinationPlugin = {
  makeEntries,
} as const;

export const InMemoryDestinationTesting = {
  fixture,
  fixtureEntries,
  layer: makeLayer,
  make,
} as const;
