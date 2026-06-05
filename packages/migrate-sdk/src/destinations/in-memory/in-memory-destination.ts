import { Effect, Layer, Schema } from "effect";
import type { ConfiguredDestinationPlugin } from "../../domain/definition.ts";
import type {
  DefinedDestinationCommands,
  DestinationCommand,
  DestinationCommandContext,
  DestinationCommandResult,
  DestinationCommandResultInput,
  DestinationCommandSchema,
} from "../../domain/destination.ts";
import {
  defineDestinationCommands,
  makeDestinationCommandResult,
} from "../../domain/destination.ts";
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

export interface InMemoryDestinationState<C extends DestinationCommand> {
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

export interface InMemoryDestinationOptions<C extends DestinationCommand> {
  readonly commandDefinitions: DefinedDestinationCommands<C>;
  readonly execute: InMemoryDestinationExecute<C>;
  readonly state?: InMemoryDestinationState<C>;
  readonly transientFailures?: InMemoryDestinationTransientFailures;
}

export interface InMemoryDestinationTransientFailures {
  readonly execute?: number;
}

export type InMemoryEntryFieldSchema<Fields extends object = object> =
  Schema.Codec<Fields, Fields, never, never>;

type InMemoryEntryFieldSchemaFor<SchemaInput> =
  SchemaInput extends Schema.Schema<infer Fields>
    ? Fields extends object
      ? InMemoryEntryFieldSchema<Fields>
      : never
    : InMemoryEntryFieldSchema;

type InMemoryEntryFields<SchemaInput> =
  SchemaInput extends Schema.Schema<infer Fields>
    ? Fields extends object
      ? Fields
      : never
    : object;

export type InMemoryEntryFieldSchemas<Schemas> = {
  readonly [ContentType in keyof Schemas]: InMemoryEntryFieldSchemaFor<
    Schemas[ContentType]
  >;
};

type InMemoryEntryContentType<
  Schemas extends InMemoryEntryFieldSchemas<Schemas>,
> = Extract<keyof Schemas, string>;

export type InMemoryUpsertEntryCommand<
  Schemas extends InMemoryEntryFieldSchemas<Schemas>,
> = {
  readonly [ContentType in InMemoryEntryContentType<Schemas>]: {
    readonly contentType: ContentType;
    readonly fields: InMemoryEntryFields<Schemas[ContentType]>;
    readonly kind: "UpsertEntry";
  };
}[InMemoryEntryContentType<Schemas>];

export type InMemoryPublishEntryCommand<
  Schemas extends InMemoryEntryFieldSchemas<Schemas>,
> = {
  readonly [ContentType in InMemoryEntryContentType<Schemas>]: {
    readonly contentType: ContentType;
    readonly kind: "PublishEntry";
  };
}[InMemoryEntryContentType<Schemas>];

export type InMemoryEntryCommand<
  Schemas extends InMemoryEntryFieldSchemas<Schemas>,
> = InMemoryUpsertEntryCommand<Schemas> | InMemoryPublishEntryCommand<Schemas>;

export interface InMemoryEntryDestinationCommands<
  Schemas extends InMemoryEntryFieldSchemas<Schemas>,
> {
  readonly publishEntry: <
    ContentType extends InMemoryEntryContentType<Schemas>,
  >(
    contentType: ContentType
  ) => Extract<
    InMemoryPublishEntryCommand<Schemas>,
    { readonly contentType: ContentType }
  >;
  readonly upsertEntry: <ContentType extends InMemoryEntryContentType<Schemas>>(
    contentType: ContentType,
    fields: InMemoryEntryFields<Schemas[ContentType]>
  ) => Extract<
    InMemoryUpsertEntryCommand<Schemas>,
    { readonly contentType: ContentType }
  >;
}

export interface InMemoryEntryDestinationOptions<
  Schemas extends InMemoryEntryFieldSchemas<Schemas>,
> {
  readonly schemas: Schemas;
  readonly state?: InMemoryDestinationState<InMemoryEntryCommand<Schemas>>;
  readonly transientFailures?: InMemoryDestinationTransientFailures;
}

export type InMemoryEntryDestination<
  Schemas extends InMemoryEntryFieldSchemas<Schemas>,
> = ConfiguredDestinationPlugin<InMemoryEntryCommand<Schemas>> & {
  readonly commands: InMemoryEntryDestinationCommands<Schemas>;
};

const makeState = <
  C extends DestinationCommand,
>(): InMemoryDestinationState<C> => ({
  entries: new Map(),
  entryVersionCounter: 0,
  executeAttempts: 0,
  executions: [],
});

const nonEmptySchemaUnion = <C extends DestinationCommand>(
  schemas: readonly DestinationCommandSchema<C>[]
): DestinationCommandSchema<C> => {
  const [firstSchema, ...remainingSchemas] = schemas;

  if (firstSchema === undefined) {
    throw new Error("In-memory destination must define at least one schema");
  }

  return (
    remainingSchemas.length === 0
      ? firstSchema
      : Schema.Union([firstSchema, ...remainingSchemas])
  ) as DestinationCommandSchema<C>;
};

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

const makeLayer = <C extends DestinationCommand>(
  options: InMemoryDestinationOptions<C>
): Layer.Layer<DestinationPlugin> =>
  Layer.sync(DestinationPlugin, (): DestinationPlugin => {
    const state = options.state ?? makeState<C>();
    const decodeCommand = Schema.decodeUnknownEffect(
      Schema.toType(options.commandDefinitions.commandSchema)
    );
    let remainingExecuteFailures = options.transientFailures?.execute ?? 0;

    const execute = Effect.fn("InMemoryDestination.execute")(
      (
        command: DestinationCommand,
        context: DestinationCommandContext
      ): Effect.Effect<DestinationCommandResult, DestinationPluginError> =>
        Effect.gen(function* () {
          state.executeAttempts += 1;

          const typedCommand = yield* decodeCommand(command).pipe(
            Effect.mapError(
              (cause) =>
                new DestinationPluginError({
                  message: "Destination command did not match command schema",
                  cause,
                })
            )
          );

          if (remainingExecuteFailures > 0) {
            remainingExecuteFailures -= 1;
            return yield* transientDestinationError();
          }

          const executeResult = options.execute(typedCommand, context);
          const resultInput = yield* Effect.isEffect(executeResult)
            ? executeResult
            : Effect.succeed(executeResult);
          const result = makeDestinationCommandResult(resultInput);

          state.executions.push({
            command: typedCommand,
            context,
            result,
          });

          return result;
        })
    );

    return { execute };
  });

const make = <C extends DestinationCommand>(
  options: InMemoryDestinationOptions<C>
): ConfiguredDestinationPlugin<C> => ({
  commandDefinitions: options.commandDefinitions,
  layer: makeLayer(options),
});

const makeEntries = <const Schemas extends InMemoryEntryFieldSchemas<Schemas>>(
  options: InMemoryEntryDestinationOptions<Schemas>
): InMemoryEntryDestination<Schemas> => {
  const state = options.state ?? makeState<InMemoryEntryCommand<Schemas>>();
  const schemaEntries = Object.entries(options.schemas) as unknown as readonly [
    InMemoryEntryContentType<Schemas>,
    InMemoryEntryFieldSchema,
  ][];
  const upsertSchemas = schemaEntries.map(([contentType, fields]) =>
    Schema.Struct({
      contentType: Schema.Literal(contentType),
      fields: Schema.toType(fields),
      kind: Schema.Literal("UpsertEntry"),
    })
  ) as unknown as readonly DestinationCommandSchema<
    InMemoryUpsertEntryCommand<Schemas>
  >[];
  const publishSchemas = schemaEntries.map(([contentType]) =>
    Schema.Struct({
      contentType: Schema.Literal(contentType),
      kind: Schema.Literal("PublishEntry"),
    })
  ) as unknown as readonly DestinationCommandSchema<
    InMemoryPublishEntryCommand<Schemas>
  >[];
  const commandDefinitions = defineDestinationCommands({
    UpsertEntry: {
      identity: true,
      schema: nonEmptySchemaUnion(upsertSchemas),
    },
    PublishEntry: {
      identity: false,
      schema: nonEmptySchemaUnion(publishSchemas),
    },
  });
  const execute = (
    command: InMemoryEntryCommand<Schemas>,
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
  const configured = make({
    commandDefinitions,
    execute,
    state,
    ...(options.transientFailures === undefined
      ? {}
      : { transientFailures: options.transientFailures }),
  });

  return {
    ...configured,
    commands: {
      publishEntry: (contentType) =>
        ({
          contentType,
          kind: "PublishEntry",
        }) as Extract<
          InMemoryPublishEntryCommand<Schemas>,
          { readonly contentType: typeof contentType }
        >,
      upsertEntry: (contentType, fields) =>
        ({
          contentType,
          fields,
          kind: "UpsertEntry",
        }) as unknown as Extract<
          InMemoryUpsertEntryCommand<Schemas>,
          { readonly contentType: typeof contentType }
        >,
    },
  };
};

export const InMemoryDestinationPlugin = {
  make,
  makeEntries,
  makeState,
  layer: makeLayer,
} as const;
