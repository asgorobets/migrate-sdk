import { Effect, Layer, type Schema } from "effect";
import type { MigrationReferenceLookup } from "../services/migration-reference-lookup.ts";
import type { MigrationStore } from "../services/migration-store.ts";
import {
  type AnySource,
  type Source as SourceContract,
  Source as SourceService,
} from "../services/source.ts";
import type { Tracking } from "../services/tracking.ts";
import type { MigrationStoreError, SkipItem } from "./errors.ts";
import { SourceError } from "./errors.ts";
import type {
  MigrationExecutionOptions,
  NormalizedMigrationExecutionOptions,
} from "./execution.ts";
import { normalizeMigrationExecutionOptions } from "./execution.ts";
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
import type { ProcessContext } from "./pipeline.ts";
import type { RollbackPipeline } from "./rollback.ts";
import type {
  SourceItem,
  SourceItemInput,
  SourceItemTotalInput,
  SourceLookupStrategy,
  SourceReadResult,
} from "./source.ts";
import {
  makeSourceItemEffect,
  normalizeSourceItemTotalInput,
} from "./source.ts";
import type { MigrationItemStateForTrackingContract } from "./state.ts";
import type { TrackingRecordContract } from "./tracking.ts";

const configuredSourceTypeId: unique symbol = Symbol.for(
  "@migrate-sdk/ConfiguredSource"
);

const migrationDefinitionTypeId: unique symbol = Symbol.for(
  "@migrate-sdk/MigrationDefinition"
);

export type SourcePayloadSchema<A, SourceInput = unknown> = Schema.Codec<
  A,
  SourceInput,
  never,
  never
>;

export type Source<
  A,
  Cursor,
  SourceInput = A,
  IdentityKey extends SourceIdentitySnapshotKey = SourceIdentitySnapshotKey,
> = SourceContract<A, Cursor, SourceInput, IdentityKey>;

export interface ConfiguredSource<
  A,
  Cursor,
  IdentityKey extends SourceIdentitySnapshotKey = SourceIdentitySnapshotKey,
  SourceInput = A,
  SourceLayerError = never,
  SourceRequirements = never,
> {
  readonly identity: SourceIdentityDefinition<IdentityKey>;
  readonly layer: Layer.Layer<AnySource, SourceLayerError, SourceRequirements>;
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
  ) => ConfiguredSource<
    A,
    Cursor,
    IdentityKey,
    SourceInput,
    SourceLayerError | ProvidedError,
    RemainingRequirements | Exclude<SourceRequirements, ProvidedRequirements>
  >;
  readonly sourceIdentityContractFingerprint: SourceIdentityDefinition<IdentityKey>["fingerprint"];
  readonly sourceSchema: SourcePayloadSchema<A, SourceInput>;
  readonly sourceVersionContractFingerprint: SourceVersionContractFingerprint;
  readonly [configuredSourceTypeId]: {
    readonly cursor: Cursor;
    readonly identityKey: IdentityKey;
    readonly source: A;
    readonly sourceLayerError: SourceLayerError;
    readonly sourceRequirements: SourceRequirements;
    readonly sourceInput: SourceInput;
  };
}

export type AnyConfiguredSource = ConfiguredSource<
  // biome-ignore lint/suspicious/noExplicitAny: Configured sources are existential in heterogeneous registries.
  any,
  // biome-ignore lint/suspicious/noExplicitAny: Cursor is recovered through ConfiguredSourceCursor.
  any,
  // biome-ignore lint/suspicious/noExplicitAny: Identity key is recovered through ConfiguredSourceIdentityKey.
  any,
  // biome-ignore lint/suspicious/noExplicitAny: Source input is recovered through ConfiguredSourceInput.
  any,
  // biome-ignore lint/suspicious/noExplicitAny: Source layer error is recovered through ConfiguredSourceLayerError.
  any,
  // biome-ignore lint/suspicious/noExplicitAny: Source requirements are recovered through ConfiguredSourceRequirements.
  any
>;

export type ConfiguredSourceSource<Source extends AnyConfiguredSource> =
  Source[typeof configuredSourceTypeId]["source"];

export type ConfiguredSourceCursor<Source extends AnyConfiguredSource> =
  Source[typeof configuredSourceTypeId]["cursor"];

export type ConfiguredSourceIdentityKey<Source extends AnyConfiguredSource> =
  Source[typeof configuredSourceTypeId]["identityKey"];

export type ConfiguredSourceInput<Source extends AnyConfiguredSource> =
  Source[typeof configuredSourceTypeId]["sourceInput"];

export type ConfiguredSourceLayerError<Source extends AnyConfiguredSource> =
  Source[typeof configuredSourceTypeId]["sourceLayerError"];

export type ConfiguredSourceRequirements<Source extends AnyConfiguredSource> =
  Source[typeof configuredSourceTypeId]["sourceRequirements"];

export interface SourceImplementation<
  A,
  Cursor,
  IdentityKey extends SourceIdentitySnapshotKey = SourceIdentitySnapshotKey,
  SourceInput = A,
> {
  readonly countTotal?: () => Effect.Effect<SourceItemTotalInput, SourceError>;
  readonly lookupStrategy: SourceLookupStrategy;
  readonly read: (
    cursor: Cursor | null
  ) => Effect.Effect<
    SourceReadResultInput<SourceInput, Cursor, IdentityKey>,
    SourceError
  >;
  readonly readByIdentity: (
    identity: SourceIdentityTarget<IdentityKey>
  ) => Effect.Effect<
    SourceItemInput<SourceInput, IdentityKey> | null,
    SourceError
  >;
}

export interface SourceMakeInput<
  A,
  Cursor,
  IdentityKey extends SourceIdentitySnapshotKey = SourceIdentitySnapshotKey,
  SourceInput = A,
> extends SourceImplementation<A, Cursor, IdentityKey, SourceInput> {
  readonly cursorSchema: Schema.Codec<Cursor, unknown, never, never>;
  readonly identity: SourceIdentityDefinition<IdentityKey>;
  readonly sourceIdentityContractFingerprint?: SourceIdentityDefinition<IdentityKey>["fingerprint"];
  readonly sourceSchema: SourcePayloadSchema<A, SourceInput>;
  readonly sourceVersionContractFingerprint?: SourceVersionContractFingerprint;
}

export interface SourceFactoryInput<
  A,
  Cursor,
  IdentityKey extends SourceIdentitySnapshotKey = SourceIdentitySnapshotKey,
  SourceInput = A,
> {
  readonly cursorSchema: Schema.Codec<Cursor, unknown, never, never>;
  readonly identity: SourceIdentityDefinition<IdentityKey>;
  readonly make: () => SourceImplementation<
    A,
    Cursor,
    IdentityKey,
    SourceInput
  >;
  readonly sourceIdentityContractFingerprint?: SourceIdentityDefinition<IdentityKey>["fingerprint"];
  readonly sourceSchema: SourcePayloadSchema<A, SourceInput>;
  readonly sourceVersionContractFingerprint?: SourceVersionContractFingerprint;
}

export interface SourceLayerInput<
  A,
  Cursor,
  IdentityKey extends SourceIdentitySnapshotKey = SourceIdentitySnapshotKey,
  SourceInput = A,
  SourceLayerError = never,
  SourceRequirements = never,
> {
  readonly cursorSchema: Schema.Codec<Cursor, unknown, never, never>;
  readonly identity: SourceIdentityDefinition<IdentityKey>;
  readonly layer: Layer.Layer<AnySource, SourceLayerError, SourceRequirements>;
  readonly sourceIdentityContractFingerprint?: SourceIdentityDefinition<IdentityKey>["fingerprint"];
  readonly sourceSchema: SourcePayloadSchema<A, SourceInput>;
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

const makeConfiguredSource = <
  A,
  Cursor,
  IdentityKey extends SourceIdentitySnapshotKey = SourceIdentitySnapshotKey,
  SourceInput = A,
  SourceLayerError = never,
  SourceRequirements = never,
>(
  input: SourceLayerInput<
    A,
    Cursor,
    IdentityKey,
    SourceInput,
    SourceLayerError,
    SourceRequirements
  >
): ConfiguredSource<
  A,
  Cursor,
  IdentityKey,
  SourceInput,
  SourceLayerError,
  SourceRequirements
> => ({
  [configuredSourceTypeId]: undefined as never,
  identity: input.identity,
  layer: input.layer,
  provide: <ProvidedRequirements, ProvidedError, RemainingRequirements>(
    layer: Layer.Layer<
      ProvidedRequirements,
      ProvidedError,
      RemainingRequirements
    >
  ) =>
    makeConfiguredSource<
      A,
      Cursor,
      IdentityKey,
      SourceInput,
      SourceLayerError | ProvidedError,
      RemainingRequirements | Exclude<SourceRequirements, ProvidedRequirements>
    >({
      cursorSchema: input.cursorSchema,
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

const makeSource = <
  A,
  Cursor,
  IdentityKey extends SourceIdentitySnapshotKey,
  SourceInput = A,
>(
  input:
    | SourceFactoryInput<A, Cursor, IdentityKey, SourceInput>
    | SourceMakeInput<A, Cursor, IdentityKey, SourceInput>
): ConfiguredSource<A, Cursor, IdentityKey, SourceInput> => {
  const makeImplementation =
    "make" in input
      ? input.make
      : () => ({
          lookupStrategy: input.lookupStrategy,
          read: input.read,
          readByIdentity: input.readByIdentity,
          ...(input.countTotal === undefined
            ? {}
            : { countTotal: input.countTotal }),
        });

  return makeConfiguredSource({
    cursorSchema: input.cursorSchema,
    layer: Layer.sync(
      SourceService,
      (): SourceContract<A, Cursor, SourceInput, IdentityKey> => {
        const implementation = makeImplementation();
        const countTotal = implementation.countTotal;

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
          ...(countTotal === undefined
            ? {}
            : {
                countTotal: () =>
                  countTotal().pipe(
                    Effect.flatMap(normalizeSourceItemTotalInput)
                  ),
              }),
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

const sourceFromLayer = <
  A,
  Cursor,
  IdentityKey extends SourceIdentitySnapshotKey,
  SourceInput = A,
  SourceLayerError = never,
  SourceRequirements = never,
>(
  input: SourceLayerInput<
    A,
    Cursor,
    IdentityKey,
    SourceInput,
    SourceLayerError,
    SourceRequirements
  >
): ConfiguredSource<
  A,
  Cursor,
  IdentityKey,
  SourceInput,
  SourceLayerError,
  SourceRequirements
> => makeConfiguredSource(input);

export const Source = Object.assign(SourceService, {
  fromLayer: sourceFromLayer,
  make: makeSource,
});

const normalizeSourceReadResult = <
  SourceInput,
  Cursor,
  IdentityKey extends SourceIdentitySnapshotKey,
>(
  result: SourceReadResultInput<SourceInput, Cursor, IdentityKey>,
  identity: SourceIdentityDefinition<IdentityKey>
): Effect.Effect<
  SourceReadResult<SourceInput, Cursor, IdentityKey>,
  SourceError
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
): Effect.Effect<SourceItem<SourceInput, IdentityKey>, SourceError> =>
  makeSourceItemEffect(item, definition).pipe(
    Effect.flatMap((sourceItem) =>
      sourceItem.identity.encoded === target.encoded
        ? Effect.succeed(sourceItem)
        : Effect.fail(
            new SourceError({
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

export type SourceRetryStrategy = <A>(
  effect: Effect.Effect<A, SourceError>
) => Effect.Effect<A, SourceError>;

export type ProcessPipeline<
  Source,
  ProcessError,
  IdentityKey extends SourceIdentitySnapshotKey,
  TrackingContract extends TrackingRecordContract | undefined = undefined,
> = (
  source: SourceItem<Source, IdentityKey>,
  context: ProcessContext<TrackingContract>
) => void | Effect.Effect<
  void,
  ProcessError | SkipItem,
  MigrationReferenceLookup | Tracking
>;

export interface DestinationStubInput {
  readonly sourceIdentity: EncodedSourceIdentity;
}

export interface DestinationStubContext {
  readonly definitionId: MigrationDefinitionId;
  readonly runId: MigrationRunId;
}

interface MigrationDefinitionBase<
  Source,
  PipelineError = never,
  Cursor = unknown,
  IdentityKey extends SourceIdentitySnapshotKey = SourceIdentitySnapshotKey,
  RollbackPipelineError = PipelineError,
  SourceInput = Source,
  SourceLayerError = never,
  SourceRequirements = never,
  TrackingContract extends TrackingRecordContract | undefined = undefined,
> {
  readonly [migrationDefinitionTypeId]: {
    readonly processError: PipelineError;
    readonly rollbackError: RollbackPipelineError;
    readonly source: ConfiguredSource<
      Source,
      Cursor,
      IdentityKey,
      SourceInput,
      SourceLayerError,
      SourceRequirements
    >;
    readonly tracking: TrackingContract;
  };
  readonly dependencies?: MigrationDefinitionDependencies;
  readonly execution?: NormalizedMigrationExecutionOptions;
  readonly id: MigrationDefinitionId;
  readonly process: ProcessPipeline<
    Source,
    PipelineError,
    IdentityKey,
    TrackingContract
  >;
  readonly rollback?: RollbackPipeline<
    RollbackPipelineError,
    MigrationItemStateForTrackingContract<TrackingContract>
  >;
  readonly source: ConfiguredSource<
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
  ) => void | Effect.Effect<void, PipelineError | SkipItem, Tracking>;
}

type MigrationDefinitionTracking<
  TrackingContract extends TrackingRecordContract | undefined,
> = TrackingContract extends TrackingRecordContract
  ? { readonly tracking: TrackingContract }
  : { readonly tracking?: undefined };

type MigrationDefinitionTrackingInput<
  TrackingContract extends TrackingRecordContract | undefined,
> = TrackingContract extends TrackingRecordContract
  ? { readonly tracking: TrackingContract }
  : { readonly tracking?: undefined };

export type MigrationDefinition<
  Source,
  PipelineError = never,
  Cursor = unknown,
  IdentityKey extends SourceIdentitySnapshotKey = SourceIdentitySnapshotKey,
  RollbackPipelineError = PipelineError,
  SourceInput = Source,
  SourceLayerError = never,
  SourceRequirements = never,
  TrackingContract extends TrackingRecordContract | undefined = undefined,
> = MigrationDefinitionBase<
  Source,
  PipelineError,
  Cursor,
  IdentityKey,
  RollbackPipelineError,
  SourceInput,
  SourceLayerError,
  SourceRequirements,
  TrackingContract
> &
  MigrationDefinitionTracking<TrackingContract>;

export type AnyMigrationDefinition = Omit<
  MigrationDefinitionBase<
    // biome-ignore lint/suspicious/noExplicitAny: Source is existential across heterogeneous definition collections.
    any,
    // biome-ignore lint/suspicious/noExplicitAny: Process error is recovered through MigrationDefinitionProcessError.
    any,
    // biome-ignore lint/suspicious/noExplicitAny: Cursor is recovered through the definition source.
    any,
    // biome-ignore lint/suspicious/noExplicitAny: Identity key is recovered through MigrationDefinitionSourceIdentityKey.
    any,
    // biome-ignore lint/suspicious/noExplicitAny: Rollback error is recovered through MigrationDefinitionRollbackError.
    any,
    // biome-ignore lint/suspicious/noExplicitAny: Source input is recovered through the definition source.
    any,
    // biome-ignore lint/suspicious/noExplicitAny: Source layer error is recovered through the definition source.
    any,
    // biome-ignore lint/suspicious/noExplicitAny: Source requirements are recovered through the definition source.
    any,
    // biome-ignore lint/suspicious/noExplicitAny: Tracking contract is recovered through MigrationDefinitionTrackingContract.
    any
  >,
  "rollback"
> & {
  // biome-ignore lint/suspicious/noExplicitAny: Any definition is the heterogeneous registry boundary; concrete rollback state is preserved on individual definitions.
  readonly rollback?: RollbackPipeline<any, any>;
  readonly tracking?: TrackingRecordContract | undefined;
};

export type MigrationDefinitionSource<
  Definition extends AnyMigrationDefinition,
> = Definition[typeof migrationDefinitionTypeId]["source"];

export type MigrationDefinitionProcessError<
  Definition extends AnyMigrationDefinition,
> = Definition[typeof migrationDefinitionTypeId]["processError"];

export type MigrationDefinitionRollbackError<
  Definition extends AnyMigrationDefinition,
> = Definition[typeof migrationDefinitionTypeId]["rollbackError"];

export type MigrationDefinitionTrackingContract<
  Definition extends AnyMigrationDefinition,
> = Definition[typeof migrationDefinitionTypeId]["tracking"];

export type MigrationDefinitionSourceLayerError<
  Definition extends AnyMigrationDefinition,
> = ConfiguredSourceLayerError<MigrationDefinitionSource<Definition>>;

export type MigrationDefinitionSourceRequirements<
  Definition extends AnyMigrationDefinition,
> = ConfiguredSourceRequirements<MigrationDefinitionSource<Definition>>;

export type MigrationDefinitionSourceIdentityKey<
  Definition extends AnyMigrationDefinition,
> = ConfiguredSourceIdentityKey<MigrationDefinitionSource<Definition>>;

export type MigrationDefinitionInputForSource<
  Source extends AnyConfiguredSource,
  PipelineError = never,
  RollbackPipelineError = PipelineError,
  TrackingContract extends TrackingRecordContract | undefined = undefined,
> = MigrationDefinitionInput<
  ConfiguredSourceSource<Source>,
  PipelineError,
  ConfiguredSourceCursor<Source>,
  ConfiguredSourceIdentityKey<Source>,
  RollbackPipelineError,
  ConfiguredSourceInput<Source>,
  ConfiguredSourceLayerError<Source>,
  ConfiguredSourceRequirements<Source>,
  TrackingContract
>;

export interface MigrationDefinitionDependencies {
  readonly optional: readonly MigrationDefinitionId[];
  readonly required: readonly MigrationDefinitionId[];
}

export interface MigrationDefinitionDependenciesInput {
  readonly optional?: readonly MigrationDefinitionIdInput[];
  readonly required?: readonly MigrationDefinitionIdInput[];
}

export type MigrationDefinitionInput<
  Source,
  PipelineError = never,
  Cursor = unknown,
  IdentityKey extends SourceIdentitySnapshotKey = SourceIdentitySnapshotKey,
  RollbackPipelineError = PipelineError,
  SourceInput = Source,
  SourceLayerError = never,
  SourceRequirements = never,
  TrackingContract extends TrackingRecordContract | undefined = undefined,
> = Omit<
  MigrationDefinitionBase<
    Source,
    PipelineError,
    Cursor,
    IdentityKey,
    RollbackPipelineError,
    SourceInput,
    SourceLayerError,
    SourceRequirements,
    TrackingContract
  >,
  "dependencies" | "execution" | "id" | typeof migrationDefinitionTypeId
> &
  MigrationDefinitionTrackingInput<TrackingContract> & {
    readonly dependencies?: MigrationDefinitionDependenciesInput;
    readonly execution?: MigrationExecutionOptions;
    readonly id: MigrationDefinitionIdInput;
  };

const validateProcessAuthoring = (definition: {
  readonly process?: unknown;
}) => {
  if (definition.process === undefined) {
    throw new Error("Migration Definition must declare a process");
  }
};

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

function makeMigrationDefinition<
  Source,
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
    PipelineError,
    Cursor,
    IdentityKey,
    RollbackPipelineError,
    SourceInput,
    SourceLayerError,
    SourceRequirements,
    undefined
  >
): MigrationDefinition<
  Source,
  PipelineError,
  Cursor,
  IdentityKey,
  RollbackPipelineError,
  SourceInput,
  SourceLayerError,
  SourceRequirements,
  undefined
>;
function makeMigrationDefinition<
  Source,
  PipelineError = never,
  Cursor = unknown,
  IdentityKey extends SourceIdentitySnapshotKey = SourceIdentitySnapshotKey,
  RollbackPipelineError = PipelineError,
  SourceInput = Source,
  SourceLayerError = never,
  SourceRequirements = never,
  TrackingContract extends TrackingRecordContract = TrackingRecordContract,
>(
  definition: MigrationDefinitionInput<
    Source,
    PipelineError,
    Cursor,
    IdentityKey,
    RollbackPipelineError,
    SourceInput,
    SourceLayerError,
    SourceRequirements,
    TrackingContract
  >
): MigrationDefinition<
  Source,
  PipelineError,
  Cursor,
  IdentityKey,
  RollbackPipelineError,
  SourceInput,
  SourceLayerError,
  SourceRequirements,
  TrackingContract
>;
function makeMigrationDefinition<
  Source,
  PipelineError = never,
  Cursor = unknown,
  IdentityKey extends SourceIdentitySnapshotKey = SourceIdentitySnapshotKey,
  RollbackPipelineError = PipelineError,
  SourceInput = Source,
  SourceLayerError = never,
  SourceRequirements = never,
  TrackingContract extends TrackingRecordContract | undefined = undefined,
>(
  definition: MigrationDefinitionInput<
    Source,
    PipelineError,
    Cursor,
    IdentityKey,
    RollbackPipelineError,
    SourceInput,
    SourceLayerError,
    SourceRequirements,
    TrackingContract
  >
): MigrationDefinition<
  Source,
  PipelineError,
  Cursor,
  IdentityKey,
  RollbackPipelineError,
  SourceInput,
  SourceLayerError,
  SourceRequirements,
  TrackingContract
> {
  const {
    dependencies,
    execution: executionInput,
    id,
    tracking,
    ...rest
  } = definition;
  validateProcessAuthoring(definition);
  const execution =
    executionInput === undefined
      ? undefined
      : normalizeMigrationExecutionOptions(executionInput);
  const requiredDependencies = normalizeMigrationDefinitionIds([
    ...(dependencies?.required ?? []),
  ]);
  const optionalDependencies = normalizeMigrationDefinitionIds(
    dependencies?.optional ?? []
  );
  const hasDependencies =
    requiredDependencies.length > 0 || optionalDependencies.length > 0;

  const normalizedDefinition = {
    [migrationDefinitionTypeId]: undefined as never,
    ...rest,
    ...(execution === undefined ? {} : { execution }),
    id: toMigrationDefinitionId(id),
    ...(tracking === undefined ? {} : { tracking }),
    ...(hasDependencies
      ? {
          dependencies: {
            optional: optionalDependencies,
            required: requiredDependencies,
          },
        }
      : {}),
  } as unknown as MigrationDefinition<
    Source,
    PipelineError,
    Cursor,
    IdentityKey,
    RollbackPipelineError,
    SourceInput,
    SourceLayerError,
    SourceRequirements,
    TrackingContract
  >;
  return normalizedDefinition;
}

export const MigrationDefinition = {
  make: makeMigrationDefinition,
} as const;
