import { type Context, Effect, Layer, Schema, SchemaAST } from "effect";
import { type Pipeable, Prototype as PipeablePrototype } from "effect/Pipeable";
import type { DestinationPlugin } from "../services/destination-plugin.ts";
import { DestinationPlugin as DestinationPluginService } from "../services/destination-plugin.ts";
import {
  type DefinedDestinationCommands,
  type DestinationCommand,
  type DestinationCommandContext,
  type DestinationCommandDefinition,
  type DestinationCommandResult,
  type DestinationCommandResultInput,
  type DestinationCommandSchema,
  makeDefinedDestinationCommands,
  makeDestinationCommandResult,
} from "./destination.ts";
import { DestinationPluginError } from "./errors.ts";

const destinationCommandDefinitionTypeId: unique symbol = Symbol.for(
  "@migrate-sdk/DestinationCommandDefinition"
);

const destinationPluginDefinitionTypeId: unique symbol = Symbol.for(
  "@migrate-sdk/DestinationPluginDefinition"
);

export interface DefinedDestinationCommand<
  Name extends string,
  Command extends DestinationCommand,
  Factories extends
    DestinationCommandFactories<Command> = NoDestinationCommandFactories,
> extends DestinationCommandDefinition<Command>,
    Pipeable {
  readonly kind: Name;
  readonly make: Factories;
  readonly name: Name;
  readonly [destinationCommandDefinitionTypeId]: {
    readonly command: Command;
    readonly factories: Factories;
    readonly name: Name;
  };
}

export type DestinationCommandFactory<
  Command extends DestinationCommand = DestinationCommand,
  // biome-ignore lint/suspicious/noExplicitAny: Factory arguments are owned by each command definition and preserved by inference.
> = (...args: any[]) => Command;

export type DestinationCommandFactories<
  Command extends DestinationCommand = DestinationCommand,
> = Readonly<Record<string, DestinationCommandFactory<Command>>>;

type NoDestinationCommandFactories = Record<never, never>;

export type AnyDefinedDestinationCommand = DefinedDestinationCommand<
  string,
  DestinationCommand,
  NoDestinationCommandFactories
>;

export type DefinedDestinationCommandName<Definition> =
  Definition extends DefinedDestinationCommand<infer Name, infer _Command>
    ? Name
    : never;

export type DefinedDestinationCommandCommand<Definition> =
  Definition extends DefinedDestinationCommand<infer _Name, infer Command>
    ? Command
    : never;

export type DefinedDestinationCommandFactories<Definition> =
  Definition extends DefinedDestinationCommand<
    infer _Name,
    infer _Command,
    infer Factories
  >
    ? Factories
    : never;

const destinationCommandDefinitionProto = PipeablePrototype;

export const defineDestinationCommand = <
  const Name extends string,
  CommandSchema extends DestinationCommandSchema<
    DestinationCommand & { readonly kind: Name }
  >,
  Command extends DestinationCommand & {
    readonly kind: Name;
  } = CommandSchema extends DestinationCommandSchema<infer InferredCommand>
    ? InferredCommand
    : never,
  const Factories extends
    DestinationCommandFactories<Command> = NoDestinationCommandFactories,
>(
  name: NonEmptyString<Name>,
  definition: {
    readonly identity?: boolean | undefined;
    readonly make?: Factories | undefined;
    readonly schema: CommandSchema;
  }
): DefinedDestinationCommand<Name, Command, Factories> => {
  requireNonEmptyString(name, "Destination command name");
  requireDestinationCommandDefinitionInput(name, definition);

  return Object.assign(
    Object.create(destinationCommandDefinitionProto),
    definition,
    {
      [destinationCommandDefinitionTypeId]: undefined as never,
      kind: name,
      make: definition.make ?? {},
      name,
    }
  );
};

type CommandFromDefinitions<Definitions extends AnyDefinedDestinationCommand> =
  DefinedDestinationCommandCommand<Definitions>;

type DefinitionWithName<
  Definitions extends AnyDefinedDestinationCommand,
  Name extends string,
> = Extract<Definitions, { readonly name: Name }>;

type ExcludeName<
  Definitions extends AnyDefinedDestinationCommand,
  Name extends string,
> = Exclude<Definitions, { readonly name: Name }>;

type HasDestinationCommands<Definitions extends AnyDefinedDestinationCommand> =
  [Definitions] extends [never] ? false : true;

type DestinationPluginCommandDefinitions<
  Definitions extends AnyDefinedDestinationCommand,
> = [Definitions] extends [never]
  ? undefined
  : DefinedDestinationCommands<CommandFromDefinitions<Definitions>>;

type UnionToIntersection<Union> = (
  Union extends unknown
    ? (value: Union) => void
    : never
) extends (value: infer Intersection) => void
  ? Intersection
  : never;

type Simplify<A> = { readonly [Key in keyof A]: A[Key] } & {};

type DestinationPluginCommands<
  Definitions extends AnyDefinedDestinationCommand,
> = [Definitions] extends [never]
  ? NoDestinationCommandFactories
  : Simplify<
      UnionToIntersection<DefinedDestinationCommandFactories<Definitions>>
    >;

type AddedDestinationCommandNames<
  Added extends readonly AnyDefinedDestinationCommand[],
> = DefinedDestinationCommandName<Added[number]>;

type DestinationCommandFactoryNames<
  Definitions extends AnyDefinedDestinationCommand,
> = keyof DefinedDestinationCommandFactories<Definitions> & string;

type AddedDestinationCommandFactoryNames<
  Added extends readonly AnyDefinedDestinationCommand[],
> = DestinationCommandFactoryNames<Added[number]>;

type DuplicateDestinationCommandFactoryNamesInAdded<
  Added extends readonly AnyDefinedDestinationCommand[],
  Seen extends string = never,
> = Added extends readonly [
  infer Head extends AnyDefinedDestinationCommand,
  ...infer Tail extends readonly AnyDefinedDestinationCommand[],
]
  ? DestinationCommandFactoryNames<Head> extends infer Names extends string
    ?
        | Extract<Names, Seen>
        | DuplicateDestinationCommandFactoryNamesInAdded<Tail, Seen | Names>
    : never
  : never;

type DuplicateDestinationCommandFactoryNames<
  Definitions extends AnyDefinedDestinationCommand,
  Added extends readonly AnyDefinedDestinationCommand[],
> =
  | Extract<
      DestinationCommandFactoryNames<Definitions>,
      AddedDestinationCommandFactoryNames<Added>
    >
  | DuplicateDestinationCommandFactoryNamesInAdded<Added>;

type DuplicateDestinationCommandNamesInAdded<
  Added extends readonly AnyDefinedDestinationCommand[],
  Seen extends string = never,
> = Added extends readonly [
  infer Head extends AnyDefinedDestinationCommand,
  ...infer Tail extends readonly AnyDefinedDestinationCommand[],
]
  ? DefinedDestinationCommandName<Head> extends infer Name extends string
    ? Name extends Seen
      ? Name | DuplicateDestinationCommandNamesInAdded<Tail, Seen>
      : DuplicateDestinationCommandNamesInAdded<Tail, Seen | Name>
    : never
  : never;

type DuplicateDestinationCommandNames<
  Definitions extends AnyDefinedDestinationCommand,
  Added extends readonly AnyDefinedDestinationCommand[],
> =
  | Extract<
      DefinedDestinationCommandName<Definitions>,
      AddedDestinationCommandNames<Added>
    >
  | DuplicateDestinationCommandNamesInAdded<Added>;

type DuplicateDestinationCommandNameError<Name extends string> =
  `Duplicate destination command definition: ${Name}`;

type RejectDuplicateDestinationCommandNames<
  Definitions extends AnyDefinedDestinationCommand,
  Added extends readonly AnyDefinedDestinationCommand[],
> = [DuplicateDestinationCommandNames<Definitions, Added>] extends [never]
  ? Added
  : readonly [
      DuplicateDestinationCommandNameError<
        DuplicateDestinationCommandNames<Definitions, Added>
      >,
    ];

type DuplicateDestinationCommandFactoryNameError<Name extends string> =
  `Duplicate destination command factory: ${Name}`;

type RejectDuplicateDestinationCommandFactoryNames<
  Definitions extends AnyDefinedDestinationCommand,
  Added extends readonly AnyDefinedDestinationCommand[],
> = [DuplicateDestinationCommandFactoryNames<Definitions, Added>] extends [
  never,
]
  ? Added
  : readonly [
      DuplicateDestinationCommandFactoryNameError<
        DuplicateDestinationCommandFactoryNames<Definitions, Added>
      >,
    ];

type RejectDuplicateDestinationDefinitions<
  Definitions extends AnyDefinedDestinationCommand,
  Added extends readonly AnyDefinedDestinationCommand[],
> =
  RejectDuplicateDestinationCommandNames<
    Definitions,
    Added
  > extends infer CommandNameResult extends
    readonly AnyDefinedDestinationCommand[]
    ? RejectDuplicateDestinationCommandFactoryNames<
        Definitions,
        CommandNameResult
      >
    : RejectDuplicateDestinationCommandNames<Definitions, Added>;

type NonEmptyDestinationCommandDefinitions = readonly [
  AnyDefinedDestinationCommand,
  ...AnyDefinedDestinationCommand[],
];

type NonEmptyString<Value extends string> = Value extends "" ? never : Value;

const isRecord = (value: unknown): value is Record<PropertyKey, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const requireNonEmptyString = (value: unknown, label: string): void => {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
};

const destinationCommandSchemaKind = (
  schema: Schema.Top
): string | undefined => {
  const ast = SchemaAST.toType(schema.ast);

  if (!SchemaAST.isObjects(ast)) {
    return;
  }

  const kind = ast.propertySignatures.find(
    (signature) => signature.name === "kind"
  )?.type;

  return kind !== undefined &&
    SchemaAST.isLiteral(kind) &&
    typeof kind.literal === "string"
    ? kind.literal
    : undefined;
};

function requireDestinationCommandDefinitionInput(
  name: string,
  definition: unknown
): asserts definition is {
  readonly identity?: boolean;
  readonly make?: DestinationCommandFactories<DestinationCommand>;
  readonly schema: DestinationCommandSchema<DestinationCommand>;
} {
  if (!isRecord(definition)) {
    throw new Error("Destination command definition must be an object");
  }

  if (!Schema.isSchema(definition.schema)) {
    throw new Error("Destination command definition requires a schema");
  }

  const schemaKind = destinationCommandSchemaKind(definition.schema);

  if (schemaKind === undefined) {
    throw new Error("Destination command schema must define a kind literal");
  }

  if (schemaKind !== name) {
    throw new Error(
      `Destination command schema kind "${schemaKind}" must match command name "${name}"`
    );
  }

  if (
    definition.identity !== undefined &&
    typeof definition.identity !== "boolean"
  ) {
    throw new Error("Destination command identity must be a boolean");
  }

  if (definition.make !== undefined) {
    if (!isRecord(definition.make)) {
      throw new Error("Destination command factories must be an object");
    }

    for (const [factoryName, factory] of Object.entries(definition.make)) {
      requireNonEmptyString(factoryName, "Destination command factory name");

      if (typeof factory !== "function") {
        throw new Error(
          `Destination command factory "${factoryName}" must be a function`
        );
      }
    }
  }
}

function requireDefinedDestinationCommand(
  definition: unknown
): asserts definition is AnyDefinedDestinationCommand {
  if (
    !(isRecord(definition) && destinationCommandDefinitionTypeId in definition)
  ) {
    throw new Error("Destination plugin add requires destination commands");
  }
}

export interface ImplementedDestinationPlugin<
  Command extends DestinationCommand,
  Commands,
  R = never,
> {
  readonly commandDefinitions: DefinedDestinationCommands<Command>;
  readonly commands: Commands;
  readonly layer: Layer.Layer<DestinationPlugin, DestinationPluginError, R>;
  provide<RProvided, Remainder>(
    layer: Layer.Layer<RProvided, DestinationPluginError, Remainder>
  ): ImplementedDestinationPlugin<
    Command,
    Commands,
    Remainder | Exclude<R, RProvided>
  >;
}

export interface DestinationPluginDefinition<
  Id extends string,
  Definitions extends AnyDefinedDestinationCommand = never,
> extends Pipeable {
  add<const Added extends NonEmptyDestinationCommandDefinitions>(
    ...definitions: RejectDuplicateDestinationDefinitions<Definitions, Added>
  ): DestinationPluginDefinition<Id, Definitions | Added[number]>;
  readonly commandDefinitions: DestinationPluginCommandDefinitions<Definitions>;
  readonly commands: DestinationPluginCommands<Definitions>;
  readonly definitions: Readonly<Record<string, Definitions>>;
  readonly hasCommands: HasDestinationCommands<Definitions>;
  readonly identifier: Id;
  implement<Return>(
    this: NonEmptyDestinationPluginDefinition<Id, Definitions>,
    build: (
      handlers: DestinationPluginHandlersFromPlugin<
        NonEmptyDestinationPluginDefinition<Id, Definitions>
      >
    ) => ValidateDestinationPluginHandlersReturn<Return>
  ): ImplementedDestinationPlugin<
    CommandFromDefinitions<Definitions>,
    DestinationPluginCommands<Definitions>,
    DestinationPluginHandlersContext<Return>
  >;
  readonly [destinationPluginDefinitionTypeId]: {
    readonly definitions: Definitions;
    readonly id: Id;
  };
}

export type AnyDestinationPluginDefinition =
  | DestinationPluginDefinition<string, AnyDefinedDestinationCommand>
  | DestinationPluginDefinition<string, never>;

export type NonEmptyDestinationPluginDefinition<
  Id extends string = string,
  Definitions extends
    AnyDefinedDestinationCommand = AnyDefinedDestinationCommand,
> = DestinationPluginDefinition<Id, Definitions> & {
  readonly commandDefinitions: DefinedDestinationCommands<
    CommandFromDefinitions<Definitions>
  >;
  readonly commands: DestinationPluginCommands<Definitions>;
  readonly hasCommands: true;
};

export type AnyNonEmptyDestinationPluginDefinition =
  NonEmptyDestinationPluginDefinition<string, AnyDefinedDestinationCommand>;

export type DestinationPluginDefinitionDefinitions<Plugin> =
  Plugin extends DestinationPluginDefinition<infer _Id, infer Definitions>
    ? Definitions
    : never;

export type DestinationPluginDefinitionCommand<Plugin> = CommandFromDefinitions<
  DestinationPluginDefinitionDefinitions<Plugin>
>;

export type DestinationPluginDefinitionCommands<Plugin> =
  DestinationPluginCommands<DestinationPluginDefinitionDefinitions<Plugin>>;

const makeCommandDefinitions = <
  Definitions extends AnyDefinedDestinationCommand,
>(
  definitions: Readonly<Record<string, Definitions>>
): DefinedDestinationCommands<CommandFromDefinitions<Definitions>> => {
  const input: Record<
    string,
    DestinationCommandDefinition<DestinationCommand>
  > = {};

  for (const definition of Object.values(definitions)) {
    input[definition.name] = {
      ...(definition.identity === undefined
        ? {}
        : { identity: definition.identity }),
      schema: definition.schema,
    };
  }

  return makeDefinedDestinationCommands(input) as DefinedDestinationCommands<
    CommandFromDefinitions<Definitions>
  >;
};

const makeCommands = <Definitions extends AnyDefinedDestinationCommand>(
  definitions: Readonly<Record<string, Definitions>>
): DestinationPluginCommands<Definitions> => {
  const commands: Record<string, DestinationCommandFactory> = {};

  for (const definition of Object.values(definitions)) {
    const factories = definition.make as DestinationCommandFactories;

    for (const [name, factory] of Object.entries(factories)) {
      if (Object.hasOwn(commands, name)) {
        throw new Error(`Duplicate destination command factory: ${name}`);
      }

      commands[name] = factory;
    }
  }

  return commands as DestinationPluginCommands<Definitions>;
};

const destinationPluginDefinitionProto = Object.assign(
  Object.create(PipeablePrototype),
  {
    add(
      this: AnyDestinationPluginDefinition,
      ...toAdd: readonly AnyDefinedDestinationCommand[]
    ) {
      if (toAdd.length === 0) {
        throw new Error("Destination plugin add requires at least one command");
      }

      const definitions: Record<string, AnyDefinedDestinationCommand> = {
        ...this.definitions,
      };

      for (const definition of toAdd) {
        requireDefinedDestinationCommand(definition);

        if (Object.hasOwn(definitions, definition.name)) {
          throw new Error(
            `Duplicate destination command definition: ${definition.name}`
          );
        }

        for (const factoryName of Object.keys(definition.make)) {
          if (
            Object.values(definitions).some((existingDefinition) =>
              Object.hasOwn(existingDefinition.make, factoryName)
            )
          ) {
            throw new Error(
              `Duplicate destination command factory: ${factoryName}`
            );
          }
        }

        definitions[definition.name] = definition;
      }

      return makeDestinationPluginDefinition({
        definitions,
        identifier: this.identifier,
      });
    },
    implement(
      this: AnyDestinationPluginDefinition,
      build: (
        handlers: DestinationPluginHandlersFromPlugin<AnyNonEmptyDestinationPluginDefinition>
      ) => unknown
    ) {
      requireDestinationPluginCommands(this);

      return makeImplementedDestinationPlugin({
        layer: DestinationPluginBuilder.layer(
          this,
          build as (
            handlers: DestinationPluginHandlersFromPlugin<AnyNonEmptyDestinationPluginDefinition>
          ) => ValidateDestinationPluginHandlersReturn<
            DestinationPluginHandlers<
              AnyNonEmptyDestinationPluginDefinition,
              unknown,
              never
            >
          >
        ),
        plugin: this,
      });
    },
  }
);

function requireDestinationPluginCommands(
  plugin: AnyDestinationPluginDefinition
): asserts plugin is AnyNonEmptyDestinationPluginDefinition {
  if (!(plugin.hasCommands && plugin.commandDefinitions !== undefined)) {
    throw new Error("Destination plugins must define at least one command");
  }
}

const makeDestinationPluginDefinition = <
  const Id extends string,
  Definitions extends AnyDefinedDestinationCommand,
>(options: {
  readonly definitions: Readonly<Record<string, Definitions>>;
  readonly identifier: Id;
}): DestinationPluginDefinition<Id, Definitions> => {
  const hasCommands = Object.keys(options.definitions).length > 0;

  return Object.assign(Object.create(destinationPluginDefinitionProto), {
    [destinationPluginDefinitionTypeId]: undefined as never,
    commandDefinitions: hasCommands
      ? makeCommandDefinitions(options.definitions)
      : undefined,
    commands: makeCommands(options.definitions),
    definitions: options.definitions,
    hasCommands,
    identifier: options.identifier,
  }) as DestinationPluginDefinition<Id, Definitions>;
};

export const defineDestinationPlugin = <const Id extends string>(
  identifier: NonEmptyString<Id>
): DestinationPluginDefinition<Id, never> => {
  requireNonEmptyString(identifier, "Destination plugin identifier");

  return makeDestinationPluginDefinition({
    definitions: {},
    identifier,
  });
};

export interface DestinationCommandHandlerContext<
  Definition extends AnyDefinedDestinationCommand,
  Plugin = unknown,
> {
  readonly command: DefinedDestinationCommandCommand<Definition>;
  readonly context: DestinationCommandContext;
  readonly definition: Definition;
  readonly plugin: Plugin;
}

export type DestinationCommandHandler<
  Definition extends AnyDefinedDestinationCommand,
  R = never,
  Plugin = unknown,
> = (
  input: DestinationCommandHandlerContext<Definition, Plugin>
) => Effect.Effect<DestinationCommandResultInput, DestinationPluginError, R>;

export interface DestinationPluginHandlers<
  Plugin extends AnyNonEmptyDestinationPluginDefinition,
  R,
  Remaining extends AnyDefinedDestinationCommand,
> extends Pipeable {
  handle<
    const Name extends DefinedDestinationCommandName<Remaining>,
    R1 = never,
  >(
    name: Name,
    handler: DestinationCommandHandler<
      DefinitionWithName<Remaining, Name>,
      R1,
      Plugin
    >
  ): DestinationPluginHandlers<Plugin, R | R1, ExcludeName<Remaining, Name>>;
  readonly handlers: ReadonlyMap<string, DestinationPluginHandlerItem>;
  readonly plugin: Plugin;
}

export interface DestinationPluginHandlerItem {
  readonly definition: AnyDefinedDestinationCommand;
  readonly handler: DestinationCommandHandler<
    AnyDefinedDestinationCommand,
    unknown,
    AnyNonEmptyDestinationPluginDefinition
  >;
}

export type AnyDestinationPluginHandlers = DestinationPluginHandlers<
  AnyNonEmptyDestinationPluginDefinition,
  unknown,
  AnyDefinedDestinationCommand
>;

export type DestinationPluginHandlersFromPlugin<
  Plugin extends AnyNonEmptyDestinationPluginDefinition,
> = DestinationPluginHandlers<
  Plugin,
  never,
  DestinationPluginDefinitionDefinitions<Plugin>
>;

export type ValidateDestinationPluginHandlersReturn<A> =
  A extends DestinationPluginHandlers<infer _Plugin, infer _R, infer Remaining>
    ? [Remaining] extends [never]
      ? A
      : `Destination command not handled: ${DefinedDestinationCommandName<Remaining>}`
    : "Must return destination command handlers";

export type DestinationPluginHandlersContext<A> =
  A extends DestinationPluginHandlers<infer _Plugin, infer R, infer _Remaining>
    ? R
    : never;

const destinationPluginHandlersProto = Object.assign(
  Object.create(PipeablePrototype),
  {
    handle(
      this: {
        readonly handlers: Map<string, DestinationPluginHandlerItem>;
        readonly plugin: AnyNonEmptyDestinationPluginDefinition;
      },
      name: string,
      handler: DestinationCommandHandler<
        AnyDefinedDestinationCommand,
        unknown,
        AnyNonEmptyDestinationPluginDefinition
      >
    ) {
      const definition = this.plugin.definitions[name];

      if (definition === undefined) {
        throw new Error(`Destination command "${name}" is not defined`);
      }

      if (this.handlers.has(name)) {
        throw new Error(`Destination command "${name}" already has a handler`);
      }

      this.handlers.set(name, {
        definition,
        handler,
      });

      return this;
    },
  }
);

const makeHandlers = <Plugin extends AnyNonEmptyDestinationPluginDefinition>(
  plugin: Plugin
): DestinationPluginHandlersFromPlugin<Plugin> =>
  Object.assign(Object.create(destinationPluginHandlersProto), {
    handlers: new Map<string, DestinationPluginHandlerItem>(),
    plugin,
  });

const isDestinationPluginHandlers = (
  value: unknown
): value is DestinationPluginHandlers<
  AnyNonEmptyDestinationPluginDefinition,
  unknown,
  never
> =>
  typeof value === "object" &&
  value !== null &&
  "handlers" in value &&
  (value as { readonly handlers?: unknown }).handlers instanceof Map;

const isDefinedDestinationCommand = (
  definition: unknown
): definition is AnyDefinedDestinationCommand =>
  isRecord(definition) && destinationCommandDefinitionTypeId in definition;

const isDestinationPluginHandlerItem = (
  value: unknown
): value is DestinationPluginHandlerItem =>
  isRecord(value) &&
  isDefinedDestinationCommand(value.definition) &&
  typeof value.handler === "function";

const validateDestinationPluginHandlers = <
  Plugin extends AnyNonEmptyDestinationPluginDefinition,
  R,
>(
  plugin: Plugin,
  value: unknown
): Effect.Effect<
  DestinationPluginHandlers<Plugin, R, never>,
  DestinationPluginError
> => {
  if (!isDestinationPluginHandlers(value)) {
    return Effect.fail(
      destinationPluginDefinitionError(
        "Must return destination command handlers"
      )
    );
  }

  for (const name of value.handlers.keys()) {
    if (!Object.hasOwn(plugin.definitions, name)) {
      return Effect.fail(
        destinationPluginDefinitionError(
          `Destination command handler is not defined: ${name}`
        )
      );
    }
  }

  for (const definition of Object.values(plugin.definitions)) {
    const item = value.handlers.get(definition.name);

    if (item === undefined) {
      return Effect.fail(
        destinationPluginDefinitionError(
          `Destination command not handled: ${definition.name}`
        )
      );
    }

    if (!isDestinationPluginHandlerItem(item)) {
      return Effect.fail(
        destinationPluginDefinitionError(
          `Destination command handler item is invalid: ${definition.name}`
        )
      );
    }

    if (item.definition !== definition) {
      return Effect.fail(
        destinationPluginDefinitionError(
          `Destination command handler item does not match command definition: ${definition.name}`
        )
      );
    }
  }

  return Effect.succeed(value as DestinationPluginHandlers<Plugin, R, never>);
};

const destinationPluginDefinitionError = (
  message: string,
  cause?: unknown
): DestinationPluginError =>
  new DestinationPluginError({
    message,
    ...(cause === undefined ? {} : { cause }),
  });

const unsafeDestinationPluginDefinitionError = (
  cause: unknown
): DestinationPluginError =>
  destinationPluginDefinitionError(
    cause instanceof Error
      ? cause.message
      : "Destination plugin implementation failed",
    cause
  );

const commandSchemaError = (cause: unknown): DestinationPluginError =>
  new DestinationPluginError({
    message: "Destination command did not match command schema",
    cause,
  });

const missingHandlerError = (kind: string): DestinationPluginError =>
  new DestinationPluginError({
    message: "Destination command handler was not found",
    cause: { kind },
  });

const makeExecute = <Plugin extends AnyNonEmptyDestinationPluginDefinition, R>(
  plugin: Plugin,
  handlers: ReadonlyMap<string, DestinationPluginHandlerItem>,
  services: Context.Context<R>
): DestinationPlugin["execute"] => {
  const decodeCommand = Schema.decodeUnknownEffect(
    Schema.toType(plugin.commandDefinitions.commandSchema)
  );

  return Effect.fn("DestinationPluginBuilder.execute")(
    (
      command: DestinationCommand,
      context: DestinationCommandContext
    ): Effect.Effect<DestinationCommandResult, DestinationPluginError> =>
      Effect.gen(function* () {
        const decodedCommand = yield* decodeCommand(command).pipe(
          Effect.mapError(commandSchemaError)
        );
        const item = handlers.get(decodedCommand.kind);

        if (item === undefined) {
          return yield* missingHandlerError(decodedCommand.kind);
        }

        const result = yield* (
          item.handler({
            command: decodedCommand,
            context,
            definition: item.definition,
            plugin,
          }) as Effect.Effect<
            DestinationCommandResultInput,
            DestinationPluginError,
            R
          >
        ).pipe(Effect.provideContext(services));

        return makeDestinationCommandResult(result);
      })
  );
};

const layer = <Plugin extends AnyNonEmptyDestinationPluginDefinition, Return>(
  plugin: Plugin,
  build: (
    handlers: DestinationPluginHandlersFromPlugin<Plugin>
  ) => ValidateDestinationPluginHandlersReturn<Return>
): Layer.Layer<
  DestinationPlugin,
  DestinationPluginError,
  DestinationPluginHandlersContext<Return>
> =>
  Layer.effect(
    DestinationPluginService,
    Effect.gen(function* () {
      yield* Effect.try({
        try: () => requireDestinationPluginCommands(plugin),
        catch: unsafeDestinationPluginDefinitionError,
      });
      const builtHandlers = yield* Effect.try({
        try: () => build(makeHandlers(plugin)),
        catch: unsafeDestinationPluginDefinitionError,
      });
      const handlers = yield* validateDestinationPluginHandlers<
        Plugin,
        DestinationPluginHandlersContext<Return>
      >(plugin, builtHandlers);
      const services =
        yield* Effect.context<DestinationPluginHandlersContext<Return>>();

      return {
        execute: makeExecute(plugin, handlers.handlers, services),
      };
    })
  );

const makeImplementedDestinationPlugin = <
  Plugin extends AnyNonEmptyDestinationPluginDefinition,
  R,
>(options: {
  readonly layer: Layer.Layer<DestinationPlugin, DestinationPluginError, R>;
  readonly plugin: Plugin;
}): ImplementedDestinationPlugin<
  DestinationPluginDefinitionCommand<Plugin>,
  DestinationPluginCommands<DestinationPluginDefinitionDefinitions<Plugin>>,
  R
> => ({
  commandDefinitions: options.plugin
    .commandDefinitions as DefinedDestinationCommands<
    DestinationPluginDefinitionCommand<Plugin>
  >,
  commands: options.plugin.commands as DestinationPluginCommands<
    DestinationPluginDefinitionDefinitions<Plugin>
  >,
  layer: options.layer,
  provide: (providedLayer) =>
    makeImplementedDestinationPlugin({
      layer: options.layer.pipe(Layer.provide(providedLayer)),
      plugin: options.plugin,
    }),
});

export const DestinationPluginBuilder = {
  layer,
} as const;
