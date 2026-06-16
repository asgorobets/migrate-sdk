import { Effect, Layer, type Schema } from "effect";
import type { DestinationPlugin } from "../services/destination-plugin.ts";
import type { MigrationReferenceLookup } from "../services/migration-reference-lookup.ts";
import type { MigrationStore } from "../services/migration-store.ts";
import {
  type AnySourcePlugin,
  type SourcePlugin,
  SourcePlugin as SourcePluginService,
} from "../services/source-plugin.ts";
import type {
  DefinedDestinationCommands,
  DestinationCommand,
  DestinationCommandPlan,
} from "./destination.ts";
import type {
  DestinationPluginError,
  MigrationStoreError,
  SkipItem,
} from "./errors.ts";
import { SourcePluginError } from "./errors.ts";
import {
  type EncodedSourceIdentity,
  type MigrationDefinitionId,
  type MigrationDefinitionIdInput,
  type MigrationRunId,
  type SourceIdentityDefinition,
  type SourceIdentitySnapshotKey,
  type SourceIdentityTarget,
  toMigrationDefinitionId,
} from "./ids.ts";
import {
  defaultSourceVersionContractFingerprint,
  type SourceVersionContractFingerprint,
} from "./migration-contract.ts";
import type { PipelineContext } from "./pipeline.ts";
import type { RollbackPipeline } from "./rollback.ts";
import type {
  SourceItem,
  SourceItemInput,
  SourceLookupStrategy,
  SourceReadResult,
} from "./source.ts";
import { makeSourceItemEffect } from "./source.ts";

const configuredSourcePluginTypeId: unique symbol = Symbol.for(
  "@migrate-sdk/ConfiguredSourcePlugin"
);

export type SourcePayloadSchema<Source, SourceInput = unknown> = Schema.Codec<
  Source,
  SourceInput,
  never,
  never
>;

export interface ConfiguredSourcePlugin<
  Source,
  Cursor,
  IdentityKey extends SourceIdentitySnapshotKey = SourceIdentitySnapshotKey,
  SourceInput = Source,
  SourceLayerError = never,
  SourceRequirements = never,
> {
  readonly identity: SourceIdentityDefinition<IdentityKey>;
  readonly layer: Layer.Layer<
    AnySourcePlugin,
    SourceLayerError,
    SourceRequirements
  >;
  readonly provide: <
    ProvidedRequirements,
    ProvidedError,
    RemainingRequirements,
  >(
    layer: Layer.Layer<
      ProvidedRequirements,
      ProvidedError,
      RemainingRequirements
    >
  ) => ConfiguredSourcePlugin<
    Source,
    Cursor,
    IdentityKey,
    SourceInput,
    SourceLayerError | ProvidedError,
    RemainingRequirements | Exclude<SourceRequirements, ProvidedRequirements>
  >;
  readonly sourceIdentityContractFingerprint: SourceIdentityDefinition<IdentityKey>["fingerprint"];
  readonly sourceSchema: SourcePayloadSchema<Source, SourceInput>;
  readonly sourceVersionContractFingerprint: SourceVersionContractFingerprint;
  readonly [configuredSourcePluginTypeId]: {
    readonly cursor: Cursor;
    readonly identityKey: IdentityKey;
    readonly source: Source;
    readonly sourceLayerError: SourceLayerError;
    readonly sourceRequirements: SourceRequirements;
    readonly sourceInput: SourceInput;
  };
}

export interface SourcePluginImplementation<
  Source,
  Cursor,
  IdentityKey extends SourceIdentitySnapshotKey = SourceIdentitySnapshotKey,
  SourceInput = Source,
> {
  readonly lookupStrategy: SourceLookupStrategy;
  readonly read: (
    cursor: Cursor | null
  ) => Effect.Effect<
    SourceReadResultInput<SourceInput, Cursor, IdentityKey>,
    SourcePluginError
  >;
  readonly readByIdentity: (
    identity: SourceIdentityTarget<IdentityKey>
  ) => Effect.Effect<
    SourceItemInput<SourceInput, IdentityKey> | null,
    SourcePluginError
  >;
}

export interface SourcePluginInput<
  Source,
  Cursor,
  IdentityKey extends SourceIdentitySnapshotKey = SourceIdentitySnapshotKey,
  SourceInput = Source,
> extends SourcePluginImplementation<Source, Cursor, IdentityKey, SourceInput> {
  readonly cursorSchema: Schema.Codec<Cursor, unknown, never, never>;
  readonly identity: SourceIdentityDefinition<IdentityKey>;
  readonly sourceIdentityContractFingerprint?: SourceIdentityDefinition<IdentityKey>["fingerprint"];
  readonly sourceSchema: SourcePayloadSchema<Source, SourceInput>;
  readonly sourceVersionContractFingerprint?: SourceVersionContractFingerprint;
}

export interface SourcePluginFactoryInput<
  Source,
  Cursor,
  IdentityKey extends SourceIdentitySnapshotKey = SourceIdentitySnapshotKey,
  SourceInput = Source,
> {
  readonly cursorSchema: Schema.Codec<Cursor, unknown, never, never>;
  readonly identity: SourceIdentityDefinition<IdentityKey>;
  readonly make: () => SourcePluginImplementation<
    Source,
    Cursor,
    IdentityKey,
    SourceInput
  >;
  readonly sourceIdentityContractFingerprint?: SourceIdentityDefinition<IdentityKey>["fingerprint"];
  readonly sourceSchema: SourcePayloadSchema<Source, SourceInput>;
  readonly sourceVersionContractFingerprint?: SourceVersionContractFingerprint;
}

export interface SourcePluginLayerInput<
  Source,
  _Cursor,
  IdentityKey extends SourceIdentitySnapshotKey = SourceIdentitySnapshotKey,
  SourceInput = Source,
  SourceLayerError = never,
  SourceRequirements = never,
> {
  readonly identity: SourceIdentityDefinition<IdentityKey>;
  readonly layer: Layer.Layer<
    AnySourcePlugin,
    SourceLayerError,
    SourceRequirements
  >;
  readonly sourceIdentityContractFingerprint?: SourceIdentityDefinition<IdentityKey>["fingerprint"];
  readonly sourceSchema: SourcePayloadSchema<Source, SourceInput>;
  readonly sourceVersionContractFingerprint?: SourceVersionContractFingerprint;
}

export interface SourceReadResultInput<
  SourceInput,
  Cursor,
  IdentityKey extends SourceIdentitySnapshotKey = SourceIdentitySnapshotKey,
> {
  readonly items: readonly SourceItemInput<SourceInput, IdentityKey>[];
  readonly nextCursor?: Cursor | undefined;
}

const makeConfiguredSourcePlugin = <
  Source,
  Cursor,
  IdentityKey extends SourceIdentitySnapshotKey = SourceIdentitySnapshotKey,
  SourceInput = Source,
  SourceLayerError = never,
  SourceRequirements = never,
>(
  input: SourcePluginLayerInput<
    Source,
    Cursor,
    IdentityKey,
    SourceInput,
    SourceLayerError,
    SourceRequirements
  >
): ConfiguredSourcePlugin<
  Source,
  Cursor,
  IdentityKey,
  SourceInput,
  SourceLayerError,
  SourceRequirements
> => ({
  [configuredSourcePluginTypeId]: undefined as never,
  identity: input.identity,
  layer: input.layer,
  provide: <ProvidedRequirements, ProvidedError, RemainingRequirements>(
    layer: Layer.Layer<
      ProvidedRequirements,
      ProvidedError,
      RemainingRequirements
    >
  ) =>
    makeConfiguredSourcePlugin<
      Source,
      Cursor,
      IdentityKey,
      SourceInput,
      SourceLayerError | ProvidedError,
      RemainingRequirements | Exclude<SourceRequirements, ProvidedRequirements>
    >({
      layer: input.layer.pipe(Layer.provide(layer)),
      identity: input.identity,
      sourceSchema: input.sourceSchema,
      ...(input.sourceIdentityContractFingerprint === undefined
        ? {}
        : {
            sourceIdentityContractFingerprint:
              input.sourceIdentityContractFingerprint,
          }),
      ...(input.sourceVersionContractFingerprint === undefined
        ? {}
        : {
            sourceVersionContractFingerprint:
              input.sourceVersionContractFingerprint,
          }),
    }),
  sourceSchema: input.sourceSchema,
  sourceIdentityContractFingerprint:
    input.sourceIdentityContractFingerprint ?? input.identity.fingerprint,
  sourceVersionContractFingerprint:
    input.sourceVersionContractFingerprint ??
    defaultSourceVersionContractFingerprint,
});

export const defineSourcePlugin = <
  Source,
  Cursor,
  IdentityKey extends SourceIdentitySnapshotKey,
  SourceInput = Source,
>(
  input:
    | SourcePluginFactoryInput<Source, Cursor, IdentityKey, SourceInput>
    | SourcePluginInput<Source, Cursor, IdentityKey, SourceInput>
): ConfiguredSourcePlugin<Source, Cursor, IdentityKey, SourceInput> => {
  const makeImplementation =
    "make" in input
      ? input.make
      : () => ({
          lookupStrategy: input.lookupStrategy,
          read: input.read,
          readByIdentity: input.readByIdentity,
        });

  return makeConfiguredSourcePlugin({
    layer: Layer.sync(
      SourcePluginService,
      (): SourcePlugin<Source, Cursor, SourceInput, IdentityKey> => {
        const implementation = makeImplementation();

        return {
          cursorSchema: input.cursorSchema,
          identity: input.identity,
          lookupStrategy: implementation.lookupStrategy,
          read: (cursor) =>
            implementation
              .read(cursor)
              .pipe(
                Effect.flatMap((result) =>
                  normalizeSourceReadResult(result, input.identity)
                )
              ),
          readByIdentity: (identity) =>
            implementation
              .readByIdentity(identity)
              .pipe(
                Effect.flatMap((sourceItem) =>
                  sourceItem === null
                    ? Effect.succeed(null)
                    : normalizeSourceLookupResult(
                        sourceItem,
                        input.identity,
                        identity
                      )
                )
              ),
          sourceSchema: input.sourceSchema,
        };
      }
    ),
    identity: input.identity,
    sourceSchema: input.sourceSchema,
    ...(input.sourceIdentityContractFingerprint === undefined
      ? {}
      : {
          sourceIdentityContractFingerprint:
            input.sourceIdentityContractFingerprint,
        }),
    ...(input.sourceVersionContractFingerprint === undefined
      ? {}
      : {
          sourceVersionContractFingerprint:
            input.sourceVersionContractFingerprint,
        }),
  });
};

export const defineSourcePluginLayer = <
  Source,
  Cursor,
  IdentityKey extends SourceIdentitySnapshotKey,
  SourceInput = Source,
  SourceLayerError = never,
  SourceRequirements = never,
>(
  input: SourcePluginLayerInput<
    Source,
    Cursor,
    IdentityKey,
    SourceInput,
    SourceLayerError,
    SourceRequirements
  >
): ConfiguredSourcePlugin<
  Source,
  Cursor,
  IdentityKey,
  SourceInput,
  SourceLayerError,
  SourceRequirements
> => makeConfiguredSourcePlugin(input);

const normalizeSourceReadResult = <
  SourceInput,
  Cursor,
  IdentityKey extends SourceIdentitySnapshotKey,
>(
  result: SourceReadResultInput<SourceInput, Cursor, IdentityKey>,
  identity: SourceIdentityDefinition<IdentityKey>
): Effect.Effect<
  SourceReadResult<SourceInput, Cursor, IdentityKey>,
  SourcePluginError
> =>
  Effect.gen(function* () {
    const items = yield* Effect.forEach(result.items, (item) =>
      makeSourceItemEffect(item, identity)
    );

    return {
      items,
      ...(result.nextCursor === undefined
        ? {}
        : { nextCursor: result.nextCursor }),
    };
  });

const normalizeSourceLookupResult = <
  SourceInput,
  IdentityKey extends SourceIdentitySnapshotKey,
>(
  item: SourceItemInput<SourceInput, IdentityKey>,
  definition: SourceIdentityDefinition<IdentityKey>,
  target: SourceIdentityTarget<IdentityKey>
): Effect.Effect<SourceItem<SourceInput, IdentityKey>, SourcePluginError> =>
  makeSourceItemEffect(item, definition).pipe(
    Effect.flatMap((sourceItem) =>
      sourceItem.identity.encoded === target.encoded
        ? Effect.succeed(sourceItem)
        : Effect.fail(
            new SourcePluginError({
              message:
                "Source identity lookup returned a different Source Identity",
              cause: {
                requestedSourceIdentity: target.encoded,
                returnedSourceIdentity: sourceItem.identity.encoded,
              },
            })
          )
    )
  );

export interface ConfiguredDestinationPlugin<
  Command extends DestinationCommand,
> {
  readonly commandDefinitions: DefinedDestinationCommands<Command>;
  readonly layer: Layer.Layer<DestinationPlugin, DestinationPluginError>;
}

export type DestinationRetryStrategy = <A>(
  effect: Effect.Effect<A, DestinationPluginError>
) => Effect.Effect<A, DestinationPluginError>;

export type SourceRetryStrategy = <A>(
  effect: Effect.Effect<A, SourcePluginError>
) => Effect.Effect<A, SourcePluginError>;

export interface DestinationStubInput {
  readonly sourceIdentity: EncodedSourceIdentity;
}

export interface DestinationStubContext {
  readonly definitionId: MigrationDefinitionId;
  readonly runId: MigrationRunId;
}

export interface MigrationDefinition<
  Source,
  Command extends DestinationCommand,
  PipelineError = never,
  Cursor = unknown,
  IdentityKey extends SourceIdentitySnapshotKey = SourceIdentitySnapshotKey,
  RollbackPipelineError = PipelineError,
  SourceInput = Source,
  SourceLayerError = never,
  SourceRequirements = never,
> {
  readonly dependencies?: MigrationDefinitionDependencies;
  readonly dependsOn?: readonly MigrationDefinitionId[];
  readonly destination: ConfiguredDestinationPlugin<Command>;
  readonly destinationRetry?: DestinationRetryStrategy;
  readonly id: MigrationDefinitionId;
  readonly pipeline: (
    source: SourceItem<Source, IdentityKey>,
    context: PipelineContext
  ) =>
    | DestinationCommandPlan<Command>
    | Effect.Effect<
        DestinationCommandPlan<Command>,
        PipelineError | SkipItem,
        MigrationReferenceLookup
      >;
  readonly rollback?: RollbackPipeline<Command, RollbackPipelineError>;
  readonly source: ConfiguredSourcePlugin<
    Source,
    Cursor,
    IdentityKey,
    SourceInput,
    SourceLayerError,
    SourceRequirements
  >;
  readonly sourceCursorRetry?: SourceRetryStrategy;
  readonly sourceLookupRetry?: SourceRetryStrategy;
  readonly store: Layer.Layer<MigrationStore, MigrationStoreError>;
  readonly stub?: (
    input: DestinationStubInput,
    context: DestinationStubContext
  ) =>
    | DestinationCommandPlan<Command>
    | Effect.Effect<DestinationCommandPlan<Command>, PipelineError | SkipItem>;
}

export interface MigrationDefinitionDependencies {
  readonly optional: readonly MigrationDefinitionId[];
  readonly required: readonly MigrationDefinitionId[];
}

export interface MigrationDefinitionDependenciesInput {
  readonly optional?: readonly MigrationDefinitionIdInput[];
  readonly required?: readonly MigrationDefinitionIdInput[];
}

export interface MigrationDefinitionInput<
  Source,
  Command extends DestinationCommand,
  PipelineError = never,
  Cursor = unknown,
  IdentityKey extends SourceIdentitySnapshotKey = SourceIdentitySnapshotKey,
  RollbackPipelineError = PipelineError,
  SourceInput = Source,
  SourceLayerError = never,
  SourceRequirements = never,
> extends Omit<
    MigrationDefinition<
      Source,
      Command,
      PipelineError,
      Cursor,
      IdentityKey,
      RollbackPipelineError,
      SourceInput,
      SourceLayerError,
      SourceRequirements
    >,
    "dependencies" | "dependsOn" | "id"
  > {
  readonly dependencies?: MigrationDefinitionDependenciesInput;
  readonly dependsOn?: readonly MigrationDefinitionIdInput[];
  readonly id: MigrationDefinitionIdInput;
}

const normalizeMigrationDefinitionIds = (
  values: readonly MigrationDefinitionIdInput[]
): readonly MigrationDefinitionId[] => {
  const ids: MigrationDefinitionId[] = [];
  const seenIds = new Set<MigrationDefinitionId>();

  for (const value of values) {
    const id = toMigrationDefinitionId(value);

    if (seenIds.has(id)) {
      continue;
    }

    seenIds.add(id);
    ids.push(id);
  }

  return ids;
};

export const defineMigration = <
  Source,
  Command extends DestinationCommand,
  PipelineError = never,
  Cursor = unknown,
  IdentityKey extends SourceIdentitySnapshotKey = SourceIdentitySnapshotKey,
  RollbackPipelineError = PipelineError,
  SourceInput = Source,
  SourceLayerError = never,
  SourceRequirements = never,
>(
  definition: MigrationDefinitionInput<
    Source,
    Command,
    PipelineError,
    Cursor,
    IdentityKey,
    RollbackPipelineError,
    SourceInput,
    SourceLayerError,
    SourceRequirements
  >
): MigrationDefinition<
  Source,
  Command,
  PipelineError,
  Cursor,
  IdentityKey,
  RollbackPipelineError,
  SourceInput,
  SourceLayerError,
  SourceRequirements
> => {
  const { dependencies, dependsOn, id, ...rest } = definition;
  const requiredDependencies = normalizeMigrationDefinitionIds([
    ...(dependencies?.required ?? []),
    ...(dependsOn ?? []),
  ]);
  const optionalDependencies = normalizeMigrationDefinitionIds(
    dependencies?.optional ?? []
  );
  const hasDependencies =
    requiredDependencies.length > 0 || optionalDependencies.length > 0;

  return {
    ...rest,
    id: toMigrationDefinitionId(id),
    ...(hasDependencies
      ? {
          dependencies: {
            optional: optionalDependencies,
            required: requiredDependencies,
          },
        }
      : {}),
    ...(requiredDependencies.length === 0
      ? {}
      : { dependsOn: requiredDependencies }),
  };
};
