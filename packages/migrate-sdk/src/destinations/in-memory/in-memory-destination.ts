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
  type DefinedDestinationCommand,
  type DefinedDestinationCommandCommand,
  defineDestinationCommand,
  defineDestinationCommandGroup,
  defineDestinationPlugin,
  isDefinedDestinationCommand,
  makeImplementedSingleCommandDestinationPlugin,
  makeSingleCommandDestinationPluginDefinition,
} from "../../domain/destination-plugin-definition.ts";
import { DestinationPluginError } from "../../domain/errors.ts";
import type {
  DestinationIdentity,
  DestinationVersion,
  EncodedSourceIdentity,
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
  readonly sourceIdentity: EncodedSourceIdentity;
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
  Definition extends AnyDefinedDestinationCommand,
> {
  readonly command: Definition;
  readonly execute: InMemoryDestinationExecute<
    InMemoryDestinationCommandFromDefinition<Definition>
  >;
  readonly transientFailures?: InMemoryDestinationTransientFailures;
}

export type InMemoryDestination<
  Definition extends AnyDefinedDestinationCommand,
> = ConfiguredDestinationPlugin<
  InMemoryDestinationCommandFromDefinition<Definition>
> & {
  readonly commands: InMemoryDestinationFactoriesFromDefinition<Definition>;
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
  Definition extends AnyDefinedDestinationCommand,
> extends InMemoryDestinationInspection<
    InMemoryDestinationCommandFromDefinition<Definition>
  > {
  readonly destination: InMemoryDestination<Definition>;
}

type InMemoryDestinationCommandFromDefinition<Definition> =
  DefinedDestinationCommandCommand<Definition>;

type InMemoryDestinationFactoriesFromDefinition<Definition> =
  Definition extends DefinedDestinationCommand<
    infer _Name,
    infer _Command,
    infer Factories
  >
    ? Factories
    : never;

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
export type InMemoryDeleteEntryCommandOptions = true;

export interface InMemoryEntryDestinationCommandOptions {
  readonly deleteEntry?: InMemoryDeleteEntryCommandOptions;
  readonly publishEntry?: InMemoryPublishEntryCommandOptions;
  readonly upsertEntry?: InMemoryUpsertEntryCommandOptions;
}

type NonEmptyString<Value extends string> = Value extends "" ? never : Value;

type RequireAtLeastOneEntryCommand<
  Commands extends InMemoryEntryDestinationCommandOptions,
> = Commands extends
  | { readonly deleteEntry: InMemoryDeleteEntryCommandOptions }
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
      : Key extends "deleteEntry"
        ? InMemoryDeleteEntryCommandOptions
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

export type InMemoryDeleteEntryCommand<
  ContentType extends string,
  Commands extends InMemoryEntryDestinationCommandOptions,
> = Commands extends { readonly deleteEntry?: infer CommandOptions }
  ? NonNullable<CommandOptions> extends InMemoryDeleteEntryCommandOptions
    ? {
        readonly contentType: ContentType;
        readonly kind: "DeleteEntry";
      }
    : never
  : never;

export type InMemoryEntryCommand<
  ContentType extends string,
  Commands extends InMemoryEntryDestinationCommandOptions,
> =
  | InMemoryUpsertEntryCommand<ContentType, Commands>
  | InMemoryPublishEntryCommand<ContentType, Commands>
  | InMemoryDeleteEntryCommand<ContentType, Commands>;

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
    : Record<never, never>) &
  (Commands extends {
    readonly deleteEntry: InMemoryDeleteEntryCommandOptions;
  }
    ? {
        readonly deleteEntry: () => InMemoryDeleteEntryCommand<
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
  Definition extends AnyDefinedDestinationCommand,
>(
  options: InMemoryDestinationInternalOptions<Definition>
): void => {
  const input = options as unknown;

  if (!isRecord(input)) {
    throw new Error("In-memory destination options must be an object");
  }

  if (!isDefinedDestinationCommand(input.command)) {
    throw new Error(
      "In-memory destination requires a destination command definition"
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
    if (
      commandName !== "deleteEntry" &&
      commandName !== "publishEntry" &&
      commandName !== "upsertEntry"
    ) {
      throw new Error(
        `In-memory entry destination command is not supported: ${String(commandName)}`
      );
    }
  }

  if (
    input.commands.deleteEntry === undefined &&
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

  if (
    input.commands.deleteEntry !== undefined &&
    input.commands.deleteEntry !== true
  ) {
    throw new Error("In-memory deleteEntry command option must be true");
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
  Definition extends AnyDefinedDestinationCommand,
> extends InMemoryDestinationOptions<Definition> {
  readonly state?: InMemoryDestinationState<
    InMemoryDestinationCommandFromDefinition<Definition>
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
  sourceIdentity: EncodedSourceIdentity
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

type InMemoryRuntimeEntryCommand =
  | {
      readonly contentType: string;
      readonly fields: object;
      readonly kind: "UpsertEntry";
    }
  | {
      readonly contentType: string;
      readonly kind: "PublishEntry";
    }
  | {
      readonly contentType: string;
      readonly kind: "DeleteEntry";
    };

const makeUpsertEntryCommand = <
  const ContentType extends string,
  const Fields extends object,
>(
  contentType: ContentType,
  options: InMemoryUpsertEntryCommandOptions<Fields>
) => {
  const UpsertEntry = Schema.Struct({
    contentType: Schema.Literal(contentType),
    fields: options.fields,
    kind: Schema.Literal("UpsertEntry"),
  });
  type UpsertEntry = typeof UpsertEntry.Type;

  return defineDestinationCommand("UpsertEntry", {
    identity: true,
    make: {
      upsertEntry: (fields: Fields): UpsertEntry => ({
        contentType,
        fields,
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
    kind: Schema.Literal("PublishEntry"),
  });
  type PublishEntry = typeof PublishEntry.Type;

  return defineDestinationCommand("PublishEntry", {
    identity: false,
    make: {
      publishEntry: (): PublishEntry => ({
        contentType,
        kind: "PublishEntry",
      }),
    },
    schema: PublishEntry,
  });
};

const makeDeleteEntryCommand = <const ContentType extends string>(
  contentType: ContentType
) => {
  const DeleteEntry = Schema.Struct({
    contentType: Schema.Literal(contentType),
    kind: Schema.Literal("DeleteEntry"),
  });
  type DeleteEntry = typeof DeleteEntry.Type;

  return defineDestinationCommand("DeleteEntry", {
    identity: false,
    make: {
      deleteEntry: (): DeleteEntry => ({
        contentType,
        kind: "DeleteEntry",
      }),
    },
    schema: DeleteEntry,
  });
};

const makeOneCommandPluginDefinition = <
  Definition extends AnyDefinedDestinationCommand,
>(
  command: Definition
) =>
  makeSingleCommandDestinationPluginDefinition(
    "in-memory-command",
    "commands",
    command
  );

const makeImplementedOneCommandDestination = <
  Definition extends AnyDefinedDestinationCommand,
>(
  options: InMemoryDestinationInternalOptions<Definition>,
  state: InMemoryDestinationState<
    InMemoryDestinationCommandFromDefinition<Definition>
  >
) => {
  const plugin = makeOneCommandPluginDefinition(options.command);
  let remainingExecuteFailures = options.transientFailures?.execute ?? 0;
  const executeWithState = (
    command: InMemoryDestinationCommandFromDefinition<Definition>,
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

  return makeImplementedSingleCommandDestinationPlugin(
    plugin,
    options.command,
    ({ command, context }) => executeWithState(command, context)
  );
};

const makeLayerWithState = <Definition extends AnyDefinedDestinationCommand>(
  options: InMemoryDestinationInternalOptions<Definition>
): Layer.Layer<DestinationPlugin, DestinationPluginError> => {
  assertInMemoryDestinationOptions(options);

  const state =
    options.state ??
    makeState<InMemoryDestinationCommandFromDefinition<Definition>>();
  const destinationPlugin = makeImplementedOneCommandDestination(
    options,
    state
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

const makeLayer = <Definition extends AnyDefinedDestinationCommand>(
  options: InMemoryDestinationOptions<Definition>
): Layer.Layer<DestinationPlugin, DestinationPluginError> =>
  makeLayerWithState(options);

const makeWithState = <Definition extends AnyDefinedDestinationCommand>(
  options: InMemoryDestinationInternalOptions<Definition>
): InMemoryDestination<Definition> => {
  assertInMemoryDestinationOptions(options);

  const state =
    options.state ??
    makeState<InMemoryDestinationCommandFromDefinition<Definition>>();
  const implementedPlugin = makeImplementedOneCommandDestination(
    options,
    state
  );

  return {
    commandDefinitions:
      implementedPlugin.commandDefinitions as ConfiguredDestinationPlugin<
        InMemoryDestinationCommandFromDefinition<Definition>
      >["commandDefinitions"],
    commands: options.command
      .make as InMemoryDestinationFactoriesFromDefinition<Definition>,
    layer: Layer.effect(
      DestinationPlugin,
      Effect.gen(function* () {
        const destinationPlugin = yield* DestinationPlugin;

        return {
          execute: Effect.fn("InMemoryDestination.execute")(
            (command, context) =>
              Effect.sync(() => {
                state.executeAttempts += 1;
              }).pipe(
                Effect.flatMap(() =>
                  destinationPlugin.execute(command, context)
                )
              )
          ),
        };
      })
    ).pipe(Layer.provide(implementedPlugin.layer)),
  };
};

const make = <Definition extends AnyDefinedDestinationCommand>(
  options: InMemoryDestinationOptions<Definition>
): InMemoryDestination<Definition> => makeWithState(options);

const fixture = <Definition extends AnyDefinedDestinationCommand>(
  options: InMemoryDestinationOptions<Definition>
): InMemoryDestinationFixture<Definition> => {
  const state =
    makeState<InMemoryDestinationCommandFromDefinition<Definition>>();
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
  const upsertEntryOptions = options.commands.upsertEntry;
  const hasDeleteEntry = options.commands.deleteEntry === true;
  const hasPublishEntry = options.commands.publishEntry === true;
  const execute = (
    command: InMemoryRuntimeEntryCommand,
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

      if (command.kind === "DeleteEntry") {
        state.entries.delete(key);

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
    command: InMemoryRuntimeEntryCommand,
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
        command: command as InMemoryEntryCommand<ContentType, Commands>,
        context,
        result,
      });

      return resultInput;
    });
  let implementedPlugin: {
    readonly commandDefinitions: ConfiguredDestinationPlugin<
      InMemoryEntryCommand<ContentType, Commands>
    >["commandDefinitions"];
    readonly commands: unknown;
    readonly layer: Layer.Layer<DestinationPlugin, DestinationPluginError>;
  };

  if (upsertEntryOptions !== undefined && hasPublishEntry && hasDeleteEntry) {
    const upsertEntry = makeUpsertEntryCommand(
      options.contentType,
      upsertEntryOptions
    );
    const publishEntry = makePublishEntryCommand(options.contentType);
    const deleteEntry = makeDeleteEntryCommand(options.contentType);
    const pluginDefinition = defineDestinationPlugin(
      "in-memory-entries"
    ).addGroup(
      defineDestinationCommandGroup("entries")
        .topLevel()
        .add(upsertEntry, publishEntry, deleteEntry)
    );

    implementedPlugin = pluginDefinition.implement((handlers) =>
      handlers
        .handle("UpsertEntry", ({ command, context }) =>
          executeWithState(command, context)
        )
        .handle("PublishEntry", ({ command, context }) =>
          executeWithState(command, context)
        )
        .handle("DeleteEntry", ({ command, context }) =>
          executeWithState(command, context)
        )
    ) as unknown as typeof implementedPlugin;
  } else if (upsertEntryOptions !== undefined && hasPublishEntry) {
    const upsertEntry = makeUpsertEntryCommand(
      options.contentType,
      upsertEntryOptions
    );
    const publishEntry = makePublishEntryCommand(options.contentType);
    const pluginDefinition = defineDestinationPlugin(
      "in-memory-entries"
    ).addGroup(
      defineDestinationCommandGroup("entries")
        .topLevel()
        .add(upsertEntry, publishEntry)
    );

    implementedPlugin = pluginDefinition.implement((handlers) =>
      handlers
        .handle("UpsertEntry", ({ command, context }) =>
          executeWithState(command, context)
        )
        .handle("PublishEntry", ({ command, context }) =>
          executeWithState(command, context)
        )
    ) as unknown as typeof implementedPlugin;
  } else if (upsertEntryOptions !== undefined && hasDeleteEntry) {
    const upsertEntry = makeUpsertEntryCommand(
      options.contentType,
      upsertEntryOptions
    );
    const deleteEntry = makeDeleteEntryCommand(options.contentType);
    const pluginDefinition = defineDestinationPlugin(
      "in-memory-entries"
    ).addGroup(
      defineDestinationCommandGroup("entries")
        .topLevel()
        .add(upsertEntry, deleteEntry)
    );

    implementedPlugin = pluginDefinition.implement((handlers) =>
      handlers
        .handle("UpsertEntry", ({ command, context }) =>
          executeWithState(command, context)
        )
        .handle("DeleteEntry", ({ command, context }) =>
          executeWithState(command, context)
        )
    ) as unknown as typeof implementedPlugin;
  } else if (hasPublishEntry && hasDeleteEntry) {
    const publishEntry = makePublishEntryCommand(options.contentType);
    const deleteEntry = makeDeleteEntryCommand(options.contentType);
    const pluginDefinition = defineDestinationPlugin(
      "in-memory-entries"
    ).addGroup(
      defineDestinationCommandGroup("entries")
        .topLevel()
        .add(publishEntry, deleteEntry)
    );

    implementedPlugin = pluginDefinition.implement((handlers) =>
      handlers
        .handle("PublishEntry", ({ command, context }) =>
          executeWithState(command, context)
        )
        .handle("DeleteEntry", ({ command, context }) =>
          executeWithState(command, context)
        )
    ) as unknown as typeof implementedPlugin;
  } else if (upsertEntryOptions !== undefined) {
    const upsertEntry = makeUpsertEntryCommand(
      options.contentType,
      upsertEntryOptions
    );
    const pluginDefinition = defineDestinationPlugin(
      "in-memory-entries"
    ).addGroup(
      defineDestinationCommandGroup("entries").topLevel().add(upsertEntry)
    );

    implementedPlugin = pluginDefinition.implement((handlers) =>
      handlers.handle("UpsertEntry", ({ command, context }) =>
        executeWithState(command, context)
      )
    ) as unknown as typeof implementedPlugin;
  } else if (hasPublishEntry) {
    const publishEntry = makePublishEntryCommand(options.contentType);
    const pluginDefinition = defineDestinationPlugin(
      "in-memory-entries"
    ).addGroup(
      defineDestinationCommandGroup("entries").topLevel().add(publishEntry)
    );

    implementedPlugin = pluginDefinition.implement((handlers) =>
      handlers.handle("PublishEntry", ({ command, context }) =>
        executeWithState(command, context)
      )
    ) as unknown as typeof implementedPlugin;
  } else if (hasDeleteEntry) {
    const deleteEntry = makeDeleteEntryCommand(options.contentType);
    const pluginDefinition = defineDestinationPlugin(
      "in-memory-entries"
    ).addGroup(
      defineDestinationCommandGroup("entries").topLevel().add(deleteEntry)
    );

    implementedPlugin = pluginDefinition.implement((handlers) =>
      handlers.handle("DeleteEntry", ({ command, context }) =>
        executeWithState(command, context)
      )
    ) as unknown as typeof implementedPlugin;
  } else {
    throw new Error(
      "In-memory entry destination must define at least one command"
    );
  }

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
