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

const destinationCommandGroupDefinitionTypeId: unique symbol = Symbol.for(
  "@migrate-sdk/DestinationCommandGroupDefinition"
);

const rootDestinationCommandGroupIdentifier = "@root";

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

type DestinationCommandGroupCommands<Group> =
  Group extends DefinedDestinationCommandGroup<
    infer Id,
    infer Definitions,
    infer TopLevel
  >
    ? TopLevel extends true
      ? DestinationPluginCommands<Definitions>
      : {
          readonly [Key in Id]: DestinationPluginCommands<Definitions>;
        }
    : never;

type DestinationPluginCommandsFromGroups<Groups> = [Groups] extends [never]
  ? NoDestinationCommandFactories
  : Simplify<UnionToIntersection<DestinationCommandGroupCommands<Groups>>>;

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

export interface DefinedDestinationCommandGroup<
  Id extends string,
  Definitions extends AnyDefinedDestinationCommand = never,
  TopLevel extends boolean = false,
> extends Pipeable {
  add<const Added extends NonEmptyDestinationCommandDefinitions>(
    ...definitions: RejectDuplicateDestinationDefinitions<Definitions, Added>
  ): DefinedDestinationCommandGroup<Id, Definitions | Added[number], TopLevel>;
  readonly commands: DestinationPluginCommands<Definitions>;
  readonly definitions: Readonly<Record<string, Definitions>>;
  readonly hasCommands: HasDestinationCommands<Definitions>;
  readonly identifier: Id;
  readonly isTopLevel: TopLevel;
  topLevel(): DefinedDestinationCommandGroup<Id, Definitions, true>;
  readonly [destinationCommandGroupDefinitionTypeId]: {
    readonly definitions: Definitions;
    readonly id: Id;
    readonly topLevel: TopLevel;
  };
}

export type AnyDefinedDestinationCommandGroup =
  | DefinedDestinationCommandGroup<
      string,
      AnyDefinedDestinationCommand,
      boolean
    >
  | DefinedDestinationCommandGroup<string, never, boolean>;

type NonEmptyDestinationCommandGroups = readonly [
  AnyDefinedDestinationCommandGroup,
  ...AnyDefinedDestinationCommandGroup[],
];

type DestinationCommandGroupDefinitions<Group> =
  Group extends DefinedDestinationCommandGroup<
    infer _Id,
    infer Definitions,
    infer _TopLevel
  >
    ? Definitions
    : never;

type DestinationCommandGroupName<Group> =
  Group extends DefinedDestinationCommandGroup<
    infer Id,
    infer _Definitions,
    infer _TopLevel
  >
    ? Id
    : never;

type DestinationCommandGroupWithName<
  Groups extends AnyDefinedDestinationCommandGroup,
  Name extends string,
> = Extract<Groups, { readonly identifier: Name }>;

type DestinationCommandGroupWithRemainingDefinitions<
  Groups extends AnyDefinedDestinationCommandGroup,
  Remaining extends AnyDefinedDestinationCommand,
> =
  Groups extends DefinedDestinationCommandGroup<
    infer _Id,
    infer Definitions,
    infer TopLevel
  >
    ? TopLevel extends true
      ? never
      : [Extract<Remaining, Definitions>] extends [never]
        ? never
        : Groups
    : never;

type DestinationCommandGroupTopLevelDefinitions<Group> =
  Group extends DefinedDestinationCommandGroup<
    infer _Id,
    infer Definitions,
    infer TopLevel
  >
    ? TopLevel extends true
      ? Definitions
      : never
    : never;

type DestinationCommandGroupDefinitionsInAdded<
  Added extends readonly AnyDefinedDestinationCommandGroup[],
> = DestinationCommandGroupDefinitions<Added[number]>;

type DestinationCommandGroupSurfaceKeys<Group> =
  Group extends DefinedDestinationCommandGroup<
    infer Id,
    infer Definitions,
    infer TopLevel
  >
    ? TopLevel extends true
      ? DestinationCommandFactoryNames<Definitions>
      : Id
    : never;

type DuplicateDestinationCommandSurfaceKeysInAdded<
  Added extends readonly AnyDefinedDestinationCommandGroup[],
  Seen extends string = never,
> = Added extends readonly [
  infer Head extends AnyDefinedDestinationCommandGroup,
  ...infer Tail extends readonly AnyDefinedDestinationCommandGroup[],
]
  ? DestinationCommandGroupSurfaceKeys<Head> extends infer Keys extends string
    ?
        | Extract<Keys, Seen>
        | DuplicateDestinationCommandSurfaceKeysInAdded<Tail, Seen | Keys>
    : never
  : never;

type DuplicateDestinationCommandSurfaceKeys<
  Groups extends AnyDefinedDestinationCommandGroup,
  Added extends readonly AnyDefinedDestinationCommandGroup[],
> =
  | Extract<
      DestinationCommandGroupSurfaceKeys<Groups>,
      DestinationCommandGroupSurfaceKeys<Added[number]>
    >
  | DuplicateDestinationCommandSurfaceKeysInAdded<Added>;

type DuplicateDestinationCommandSurfaceKeyError<Name extends string> =
  `Duplicate destination command surface: ${Name}`;

type RejectDuplicateDestinationCommandSurfaceKeys<
  Groups extends AnyDefinedDestinationCommandGroup,
  Added extends readonly AnyDefinedDestinationCommandGroup[],
> = [DuplicateDestinationCommandSurfaceKeys<Groups, Added>] extends [never]
  ? Added
  : readonly [
      DuplicateDestinationCommandSurfaceKeyError<
        DuplicateDestinationCommandSurfaceKeys<Groups, Added>
      >,
    ];

type AddedDestinationCommandGroupNames<
  Added extends readonly AnyDefinedDestinationCommandGroup[],
> = DestinationCommandGroupName<Added[number]>;

type DuplicateDestinationCommandGroupNamesInAdded<
  Added extends readonly AnyDefinedDestinationCommandGroup[],
  Seen extends string = never,
> = Added extends readonly [
  infer Head extends AnyDefinedDestinationCommandGroup,
  ...infer Tail extends readonly AnyDefinedDestinationCommandGroup[],
]
  ? DestinationCommandGroupName<Head> extends infer Name extends string
    ? Name extends Seen
      ? Name | DuplicateDestinationCommandGroupNamesInAdded<Tail, Seen>
      : DuplicateDestinationCommandGroupNamesInAdded<Tail, Seen | Name>
    : never
  : never;

type DuplicateDestinationCommandGroupNames<
  Groups extends AnyDefinedDestinationCommandGroup,
  Added extends readonly AnyDefinedDestinationCommandGroup[],
> =
  | Extract<
      DestinationCommandGroupName<Groups>,
      AddedDestinationCommandGroupNames<Added>
    >
  | DuplicateDestinationCommandGroupNamesInAdded<Added>;

type DuplicateDestinationCommandGroupNameError<Name extends string> =
  `Duplicate destination command group: ${Name}`;

type RejectDuplicateDestinationCommandGroupNames<
  Groups extends AnyDefinedDestinationCommandGroup,
  Added extends readonly AnyDefinedDestinationCommandGroup[],
> = [DuplicateDestinationCommandGroupNames<Groups, Added>] extends [never]
  ? Added
  : readonly [
      DuplicateDestinationCommandGroupNameError<
        DuplicateDestinationCommandGroupNames<Groups, Added>
      >,
    ];

type DestinationCommandGroupCommandNames<Group> = DefinedDestinationCommandName<
  DestinationCommandGroupDefinitions<Group>
>;

type DuplicateDestinationCommandNamesInGroups<
  Added extends readonly AnyDefinedDestinationCommandGroup[],
  Seen extends string = never,
> = Added extends readonly [
  infer Head extends AnyDefinedDestinationCommandGroup,
  ...infer Tail extends readonly AnyDefinedDestinationCommandGroup[],
]
  ? DestinationCommandGroupCommandNames<Head> extends infer Names extends string
    ?
        | Extract<Names, Seen>
        | DuplicateDestinationCommandNamesInGroups<Tail, Seen | Names>
    : never
  : never;

type DuplicateDestinationCommandNamesForGroups<
  Definitions extends AnyDefinedDestinationCommand,
  Added extends readonly AnyDefinedDestinationCommandGroup[],
> =
  | Extract<
      DefinedDestinationCommandName<Definitions>,
      DestinationCommandGroupCommandNames<Added[number]>
    >
  | DuplicateDestinationCommandNamesInGroups<Added>;

type RejectDuplicateDestinationCommandNamesForGroups<
  Definitions extends AnyDefinedDestinationCommand,
  Added extends readonly AnyDefinedDestinationCommandGroup[],
> = [DuplicateDestinationCommandNamesForGroups<Definitions, Added>] extends [
  never,
]
  ? Added
  : readonly [
      DuplicateDestinationCommandNameError<
        DuplicateDestinationCommandNamesForGroups<Definitions, Added>
      >,
    ];

type RejectDuplicateDestinationCommandGroups<
  Definitions extends AnyDefinedDestinationCommand,
  Groups extends AnyDefinedDestinationCommandGroup,
  Added extends readonly AnyDefinedDestinationCommandGroup[],
> =
  RejectDuplicateDestinationCommandGroupNames<
    Groups,
    Added
  > extends infer GroupNameResult extends
    readonly AnyDefinedDestinationCommandGroup[]
    ? RejectDuplicateDestinationCommandSurfaceKeys<
        Groups,
        GroupNameResult
      > extends infer SurfaceKeyResult extends
        readonly AnyDefinedDestinationCommandGroup[]
      ? RejectDuplicateDestinationCommandNamesForGroups<
          Definitions,
          SurfaceKeyResult
        >
      : RejectDuplicateDestinationCommandSurfaceKeys<Groups, GroupNameResult>
    : RejectDuplicateDestinationCommandGroupNames<Groups, Added>;

type NonEmptyString<Value extends string> = Value extends "" ? never : Value;

type PublicDestinationCommandGroupIdentifier<Value extends string> =
  NonEmptyString<Value> extends never
    ? never
    : Value extends typeof rootDestinationCommandGroupIdentifier
      ? never
      : Value;

type DuplicateDestinationRootCommandSurfaceNames<
  Groups extends AnyDefinedDestinationCommandGroup,
  Added extends readonly AnyDefinedDestinationCommand[],
> =
  | Extract<
      DestinationCommandGroupSurfaceKeys<Groups>,
      AddedDestinationCommandFactoryNames<Added>
    >
  | DuplicateDestinationCommandFactoryNamesInAdded<Added>;

type RejectDuplicateDestinationRootCommandSurfaceNames<
  Groups extends AnyDefinedDestinationCommandGroup,
  Added extends readonly AnyDefinedDestinationCommand[],
> = [DuplicateDestinationRootCommandSurfaceNames<Groups, Added>] extends [never]
  ? Added
  : readonly [
      DuplicateDestinationCommandFactoryNameError<
        DuplicateDestinationRootCommandSurfaceNames<Groups, Added>
      >,
    ];

type RejectDuplicateDestinationRootDefinitions<
  Definitions extends AnyDefinedDestinationCommand,
  Groups extends AnyDefinedDestinationCommandGroup,
  Added extends readonly AnyDefinedDestinationCommand[],
> =
  RejectDuplicateDestinationCommandNames<
    Definitions,
    Added
  > extends infer CommandNameResult extends
    readonly AnyDefinedDestinationCommand[]
    ? RejectDuplicateDestinationRootCommandSurfaceNames<
        Groups,
        CommandNameResult
      >
    : RejectDuplicateDestinationCommandNames<Definitions, Added>;

const isRecord = (value: unknown): value is Record<PropertyKey, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const requireNonEmptyString = (value: unknown, label: string): void => {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
};

const requirePublicDestinationCommandGroupIdentifier = (
  value: string
): void => {
  if (value === rootDestinationCommandGroupIdentifier) {
    throw new Error(
      `Destination command group identifier "${rootDestinationCommandGroupIdentifier}" is reserved`
    );
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

function requireDefinedDestinationCommandGroup(
  group: unknown
): asserts group is AnyDefinedDestinationCommandGroup {
  if (
    !(
      isRecord(group) &&
      destinationCommandGroupDefinitionTypeId in group &&
      typeof group.identifier === "string"
    )
  ) {
    throw new Error("Destination plugin addGroup requires command groups");
  }
}

function requireDestinationCommandGroupCommands(
  group: AnyDefinedDestinationCommandGroup
): void {
  if (!group.hasCommands) {
    throw new Error(
      `Destination command group "${group.identifier}" must define at least one command`
    );
  }
}

const destinationCommandGroupProto = Object.assign(
  Object.create(PipeablePrototype),
  {
    add(
      this: AnyDefinedDestinationCommandGroup,
      ...toAdd: readonly AnyDefinedDestinationCommand[]
    ) {
      if (toAdd.length === 0) {
        throw new Error(
          "Destination command group add requires at least one command"
        );
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

      return makeDestinationCommandGroup({
        definitions,
        identifier: this.identifier,
        isTopLevel: this.isTopLevel,
      });
    },
    topLevel(this: AnyDefinedDestinationCommandGroup) {
      return makeDestinationCommandGroup({
        definitions: this.definitions,
        identifier: this.identifier,
        isTopLevel: true,
      });
    },
  }
);

const makeDestinationCommandGroup = <
  const Id extends string,
  Definitions extends AnyDefinedDestinationCommand,
  const TopLevel extends boolean,
>(options: {
  readonly definitions: Readonly<Record<string, Definitions>>;
  readonly identifier: Id;
  readonly isTopLevel: TopLevel;
}): DefinedDestinationCommandGroup<Id, Definitions, TopLevel> => {
  const hasCommands = Object.keys(options.definitions).length > 0;

  return Object.assign(Object.create(destinationCommandGroupProto), {
    [destinationCommandGroupDefinitionTypeId]: undefined as never,
    commands: makeGroupCommands(options.definitions),
    definitions: options.definitions,
    hasCommands,
    identifier: options.identifier,
    isTopLevel: options.isTopLevel,
  }) as DefinedDestinationCommandGroup<Id, Definitions, TopLevel>;
};

export const defineDestinationCommandGroup = <const Id extends string>(
  identifier: PublicDestinationCommandGroupIdentifier<Id>
): DefinedDestinationCommandGroup<Id, never, false> => {
  requireNonEmptyString(identifier, "Destination command group identifier");
  requirePublicDestinationCommandGroupIdentifier(identifier);

  return makeDestinationCommandGroup({
    definitions: {},
    identifier,
    isTopLevel: false,
  });
};

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
  Groups extends AnyDefinedDestinationCommandGroup = never,
> extends Pipeable {
  add<const Added extends NonEmptyDestinationCommandDefinitions>(
    ...definitions: RejectDuplicateDestinationRootDefinitions<
      Definitions,
      Groups,
      Added
    >
  ): DestinationPluginDefinition<
    Id,
    Definitions | Added[number],
    | Groups
    | DefinedDestinationCommandGroup<
        typeof rootDestinationCommandGroupIdentifier,
        Added[number],
        true
      >
  >;
  addGroup<const Added extends NonEmptyDestinationCommandGroups>(
    ...groups: RejectDuplicateDestinationCommandGroups<
      Definitions,
      Groups,
      Added
    >
  ): DestinationPluginDefinition<
    Id,
    Definitions | DestinationCommandGroupDefinitionsInAdded<Added>,
    Groups | Added[number]
  >;
  readonly commandDefinitions: DestinationPluginCommandDefinitions<Definitions>;
  readonly commands: DestinationPluginCommandsFromGroups<Groups>;
  readonly definitions: Readonly<Record<string, Definitions>>;
  readonly groups: Readonly<Record<string, Groups>>;
  readonly hasCommands: HasDestinationCommands<Definitions>;
  readonly identifier: Id;
  implement<Return>(
    this: NonEmptyDestinationPluginDefinition<Id, Definitions, Groups>,
    build: (
      handlers: DestinationPluginHandlersFromPlugin<
        NonEmptyDestinationPluginDefinition<Id, Definitions, Groups>
      >
    ) => ValidateDestinationPluginHandlersReturn<Return>
  ): ImplementedDestinationPlugin<
    CommandFromDefinitions<Definitions>,
    DestinationPluginCommandsFromGroups<Groups>,
    DestinationPluginHandlersContext<Return>
  >;
  readonly [destinationPluginDefinitionTypeId]: {
    readonly definitions: Definitions;
    readonly id: Id;
  };
}

export interface AnyDestinationPluginDefinition extends Pipeable {
  readonly commandDefinitions:
    | DefinedDestinationCommands<DestinationCommand>
    | undefined;
  readonly commands: unknown;
  readonly definitions: Readonly<Record<string, AnyDefinedDestinationCommand>>;
  readonly groups: Readonly<Record<string, AnyDefinedDestinationCommandGroup>>;
  readonly hasCommands: boolean;
  readonly identifier: string;
  readonly [destinationPluginDefinitionTypeId]: {
    readonly definitions: AnyDefinedDestinationCommand;
    readonly id: string;
  };
}

export type NonEmptyDestinationPluginDefinition<
  Id extends string = string,
  Definitions extends
    AnyDefinedDestinationCommand = AnyDefinedDestinationCommand,
  Groups extends
    AnyDefinedDestinationCommandGroup = AnyDefinedDestinationCommandGroup,
> = DestinationPluginDefinition<Id, Definitions, Groups> & {
  readonly commandDefinitions: DefinedDestinationCommands<
    CommandFromDefinitions<Definitions>
  >;
  readonly commands: DestinationPluginCommandsFromGroups<Groups>;
  readonly hasCommands: true;
};

export interface AnyNonEmptyDestinationPluginDefinition
  extends AnyDestinationPluginDefinition {
  readonly commandDefinitions: DefinedDestinationCommands<DestinationCommand>;
  readonly hasCommands: true;
}

export type DestinationPluginDefinitionDefinitions<Plugin> =
  Plugin extends DestinationPluginDefinition<
    infer _Id,
    infer Definitions,
    infer _Groups
  >
    ? Definitions
    : Plugin extends {
          readonly definitions: Readonly<Record<string, infer Definitions>>;
        }
      ? Definitions extends AnyDefinedDestinationCommand
        ? Definitions
        : never
      : never;

export type DestinationPluginDefinitionGroups<Plugin> =
  Plugin extends DestinationPluginDefinition<
    infer _Id,
    infer _Definitions,
    infer Groups
  >
    ? Groups
    : Plugin extends {
          readonly groups: Readonly<Record<string, infer Groups>>;
        }
      ? Groups extends AnyDefinedDestinationCommandGroup
        ? Groups
        : never
      : never;

export type DestinationPluginDefinitionCommand<Plugin> = CommandFromDefinitions<
  DestinationPluginDefinitionDefinitions<Plugin>
>;

export type DestinationPluginDefinitionCommands<Plugin> =
  DestinationPluginCommandsFromGroups<
    DestinationPluginDefinitionGroups<Plugin>
  >;

type DestinationPluginTopLevelDefinitions<Plugin> =
  DestinationCommandGroupTopLevelDefinitions<
    DestinationPluginDefinitionGroups<Plugin>
  >;

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

const makeGroupCommands = <Definitions extends AnyDefinedDestinationCommand>(
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

const makeCommands = <Groups extends AnyDefinedDestinationCommandGroup>(
  groups: Readonly<Record<string, Groups>>
): DestinationPluginCommandsFromGroups<Groups> => {
  const commands: Record<string, unknown> = {};

  for (const group of Object.values(groups)) {
    if (group.isTopLevel) {
      for (const [name, factory] of Object.entries(group.commands)) {
        if (Object.hasOwn(commands, name)) {
          throw new Error(`Duplicate destination command factory: ${name}`);
        }

        commands[name] = factory;
      }

      continue;
    }

    if (Object.hasOwn(commands, group.identifier)) {
      throw new Error(
        `Duplicate destination command namespace: ${group.identifier}`
      );
    }

    commands[group.identifier] = group.commands;
  }

  return commands as DestinationPluginCommandsFromGroups<Groups>;
};

const destinationCommandSurfaceNames = (
  groups: Readonly<Record<string, AnyDefinedDestinationCommandGroup>>
): Set<string> => {
  const names = new Set<string>();

  for (const group of Object.values(groups)) {
    if (group.isTopLevel) {
      for (const name of Object.keys(group.commands)) {
        names.add(name);
      }

      continue;
    }

    names.add(group.identifier);
  }

  return names;
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
      const groups: Record<string, AnyDefinedDestinationCommandGroup> = {
        ...this.groups,
      };
      const commandSurfaceNames = destinationCommandSurfaceNames(groups);

      for (const definition of toAdd) {
        requireDefinedDestinationCommand(definition);

        if (Object.hasOwn(definitions, definition.name)) {
          throw new Error(
            `Duplicate destination command definition: ${definition.name}`
          );
        }

        for (const factoryName of Object.keys(definition.make)) {
          if (commandSurfaceNames.has(factoryName)) {
            throw new Error(
              `Duplicate destination command factory: ${factoryName}`
            );
          }

          commandSurfaceNames.add(factoryName);
        }

        definitions[definition.name] = definition;
      }

      const rootGroup =
        groups[rootDestinationCommandGroupIdentifier] ??
        makeDestinationCommandGroup({
          definitions: {},
          identifier: rootDestinationCommandGroupIdentifier,
          isTopLevel: true,
        });
      const addRootDefinitions = rootGroup.add.bind(rootGroup) as unknown as (
        ...definitions: readonly AnyDefinedDestinationCommand[]
      ) => AnyDefinedDestinationCommandGroup;
      groups[rootDestinationCommandGroupIdentifier] = addRootDefinitions(
        ...toAdd
      );

      return makeDestinationPluginDefinition({
        definitions,
        groups,
        identifier: this.identifier,
      });
    },
    addGroup(
      this: AnyDestinationPluginDefinition,
      ...toAdd: readonly AnyDefinedDestinationCommandGroup[]
    ) {
      if (toAdd.length === 0) {
        throw new Error(
          "Destination plugin addGroup requires at least one command group"
        );
      }

      const definitions: Record<string, AnyDefinedDestinationCommand> = {
        ...this.definitions,
      };
      const groups: Record<string, AnyDefinedDestinationCommandGroup> = {
        ...this.groups,
      };

      for (const group of toAdd) {
        requireDefinedDestinationCommandGroup(group);
        requireDestinationCommandGroupCommands(group);

        if (Object.hasOwn(groups, group.identifier)) {
          throw new Error(
            `Duplicate destination command group: ${group.identifier}`
          );
        }

        for (const definition of Object.values(group.definitions)) {
          if (Object.hasOwn(definitions, definition.name)) {
            throw new Error(
              `Duplicate destination command definition: ${definition.name}`
            );
          }

          definitions[definition.name] = definition;
        }

        groups[group.identifier] = group;
      }

      return makeDestinationPluginDefinition({
        definitions,
        groups,
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
  Groups extends AnyDefinedDestinationCommandGroup,
>(options: {
  readonly definitions: Readonly<Record<string, Definitions>>;
  readonly groups: Readonly<Record<string, Groups>>;
  readonly identifier: Id;
}): DestinationPluginDefinition<Id, Definitions, Groups> => {
  const hasCommands = Object.keys(options.definitions).length > 0;

  return Object.assign(Object.create(destinationPluginDefinitionProto), {
    [destinationPluginDefinitionTypeId]: undefined as never,
    commandDefinitions: hasCommands
      ? makeCommandDefinitions(options.definitions)
      : undefined,
    commands: makeCommands(options.groups),
    definitions: options.definitions,
    groups: options.groups,
    hasCommands,
    identifier: options.identifier,
  }) as DestinationPluginDefinition<Id, Definitions, Groups>;
};

export const defineDestinationPlugin = <const Id extends string>(
  identifier: NonEmptyString<Id>
): DestinationPluginDefinition<Id, never> => {
  requireNonEmptyString(identifier, "Destination plugin identifier");

  return makeDestinationPluginDefinition({
    definitions: {},
    groups: {},
    identifier,
  });
};

export const makeSingleCommandDestinationPluginDefinition = <
  const Id extends string,
  const GroupId extends string,
  Definition extends AnyDefinedDestinationCommand,
>(
  identifier: NonEmptyString<Id>,
  groupIdentifier: PublicDestinationCommandGroupIdentifier<GroupId>,
  command: Definition
): NonEmptyDestinationPluginDefinition<
  Id,
  Definition,
  DefinedDestinationCommandGroup<GroupId, Definition, true>
> => {
  requireNonEmptyString(identifier, "Destination plugin identifier");
  requireNonEmptyString(
    groupIdentifier,
    "Destination command group identifier"
  );
  requirePublicDestinationCommandGroupIdentifier(groupIdentifier);
  requireDefinedDestinationCommand(command);

  const definitions: Record<string, Definition> = {};
  definitions[command.name] = command;

  const group = makeDestinationCommandGroup({
    definitions,
    identifier: groupIdentifier,
    isTopLevel: true,
  });
  const groups: Record<string, typeof group> = {};
  groups[group.identifier] = group;

  const plugin = makeDestinationPluginDefinition({
    definitions,
    groups,
    identifier,
  });

  // A single branded command makes the plugin non-empty by construction; this
  // narrows the generic result that TypeScript cannot prove from the record.
  return plugin as NonEmptyDestinationPluginDefinition<
    Id,
    Definition,
    DefinedDestinationCommandGroup<GroupId, Definition, true>
  >;
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
  group<
    const Name extends DestinationCommandGroupName<
      DestinationCommandGroupWithRemainingDefinitions<
        DestinationPluginDefinitionGroups<Plugin>,
        Remaining
      >
    >,
    Return,
  >(
    name: Name,
    build: (
      handlers: DestinationCommandGroupHandlers<
        DestinationCommandGroupWithName<
          DestinationCommandGroupWithRemainingDefinitions<
            DestinationPluginDefinitionGroups<Plugin>,
            Remaining
          >,
          Name
        >,
        never,
        Extract<
          Remaining,
          DestinationCommandGroupDefinitions<
            DestinationCommandGroupWithName<
              DestinationCommandGroupWithRemainingDefinitions<
                DestinationPluginDefinitionGroups<Plugin>,
                Remaining
              >,
              Name
            >
          >
        >,
        Plugin
      >
    ) => ValidateDestinationCommandGroupHandlersReturn<Return>
  ): DestinationPluginHandlers<
    Plugin,
    R | DestinationCommandGroupHandlersContext<Return>,
    Exclude<
      Remaining,
      DestinationCommandGroupDefinitions<
        DestinationCommandGroupWithName<
          DestinationCommandGroupWithRemainingDefinitions<
            DestinationPluginDefinitionGroups<Plugin>,
            Remaining
          >,
          Name
        >
      >
    >
  >;
  handle<
    const Name extends DefinedDestinationCommandName<
      Extract<Remaining, DestinationPluginTopLevelDefinitions<Plugin>>
    >,
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

export interface DestinationCommandGroupHandlers<
  Group extends AnyDefinedDestinationCommandGroup,
  R,
  Remaining extends AnyDefinedDestinationCommand,
  Plugin extends AnyNonEmptyDestinationPluginDefinition,
> extends Pipeable {
  readonly group: Group;
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
  ): DestinationCommandGroupHandlers<
    Group,
    R | R1,
    ExcludeName<Remaining, Name>,
    Plugin
  >;
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

export type ValidateDestinationCommandGroupHandlersReturn<A> =
  A extends DestinationCommandGroupHandlers<
    infer _Group,
    infer _R,
    infer Remaining,
    infer _Plugin
  >
    ? [Remaining] extends [never]
      ? A
      : `Destination command not handled: ${DefinedDestinationCommandName<Remaining>}`
    : "Must return destination command group handlers";

export type DestinationCommandGroupHandlersContext<A> =
  A extends DestinationCommandGroupHandlers<
    infer _Group,
    infer R,
    infer _Remaining,
    infer _Plugin
  >
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
      const definition = Object.values(this.plugin.groups).find(
        (group) => group.isTopLevel && Object.hasOwn(group.definitions, name)
      )?.definitions[name];

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
    group(
      this: {
        readonly handlers: Map<string, DestinationPluginHandlerItem>;
        readonly plugin: AnyNonEmptyDestinationPluginDefinition;
      },
      name: string,
      build: (
        handlers: DestinationCommandGroupHandlers<
          AnyDefinedDestinationCommandGroup,
          unknown,
          AnyDefinedDestinationCommand,
          AnyNonEmptyDestinationPluginDefinition
        >
      ) => unknown
    ) {
      const group = this.plugin.groups[name];

      if (group === undefined) {
        throw new Error(`Destination command group "${name}" is not defined`);
      }

      if (group.isTopLevel) {
        throw new Error(
          `Destination command group "${name}" is top-level; use handlers.handle(...)`
        );
      }

      build(makeGroupHandlers(this.plugin, group, this.handlers));

      return this;
    },
  }
);

const destinationCommandGroupHandlersProto = Object.assign(
  Object.create(PipeablePrototype),
  {
    handle(
      this: {
        readonly group: AnyDefinedDestinationCommandGroup;
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
      const definition = this.group.definitions[name];

      if (definition === undefined) {
        throw new Error(
          `Destination command "${name}" is not defined in group "${this.group.identifier}"`
        );
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

const makeGroupHandlers = <
  Plugin extends AnyNonEmptyDestinationPluginDefinition,
  Group extends AnyDefinedDestinationCommandGroup,
>(
  plugin: Plugin,
  group: Group,
  handlers: Map<string, DestinationPluginHandlerItem>
): DestinationCommandGroupHandlers<
  Group,
  never,
  DestinationCommandGroupDefinitions<Group>,
  Plugin
> =>
  Object.assign(Object.create(destinationCommandGroupHandlersProto), {
    group,
    handlers,
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

export const isDefinedDestinationCommand = (
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
  DestinationPluginDefinitionCommands<Plugin>,
  R
> => ({
  commandDefinitions: options.plugin
    .commandDefinitions as DefinedDestinationCommands<
    DestinationPluginDefinitionCommand<Plugin>
  >,
  commands: options.plugin
    .commands as DestinationPluginDefinitionCommands<Plugin>,
  layer: options.layer,
  provide: (providedLayer) =>
    makeImplementedDestinationPlugin({
      layer: options.layer.pipe(Layer.provide(providedLayer)),
      plugin: options.plugin,
    }),
});

export const makeImplementedSingleCommandDestinationPlugin = <
  Definition extends AnyDefinedDestinationCommand,
  Plugin extends NonEmptyDestinationPluginDefinition<
    string,
    Definition,
    DefinedDestinationCommandGroup<string, Definition, true>
  >,
  R,
>(
  plugin: Plugin,
  command: Definition,
  handler: DestinationCommandHandler<Definition, R, Plugin>
): ImplementedDestinationPlugin<
  DefinedDestinationCommandCommand<Definition>,
  DestinationPluginDefinitionCommands<Plugin>,
  R
> => {
  requireDestinationPluginCommands(plugin);
  requireDefinedDestinationCommand(command);

  if (plugin.definitions[command.name] !== command) {
    throw new Error(
      `Destination plugin does not define command: ${command.name}`
    );
  }

  return makeImplementedDestinationPlugin({
    layer: Layer.effect(
      DestinationPluginService,
      Effect.gen(function* () {
        const services = yield* Effect.context<R>();
        const handlers = new Map<string, DestinationPluginHandlerItem>([
          [
            command.name,
            {
              definition: command,
              // The runtime handler map erases the specific command name; the
              // single-command helper preserves it at the public handler input.
              handler: handler as DestinationPluginHandlerItem["handler"],
            },
          ],
        ]);

        return {
          execute: makeExecute(plugin, handlers, services),
        };
      })
    ),
    plugin,
  });
};

export const DestinationPluginBuilder = {
  layer,
} as const;
