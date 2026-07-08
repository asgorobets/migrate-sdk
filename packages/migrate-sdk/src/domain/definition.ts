import { Context, Effect, Layer, type Schema } from "effect";
import type { MigrationReferenceLookup } from "../services/migration-reference-lookup.ts";
import type { MigrationStore } from "../services/migration-store.ts";
import {
  makeSourceRuntime,
  type SourceRuntime as SourceRuntimeService,
  type SourceRuntimeImplementation,
} from "../services/source.ts";
import type { Tracking } from "../services/tracking.ts";
import type { MigrationStoreError, SkipItem, SourceError } from "./errors.ts";
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
  toMigrationDefinitionId,
} from "./ids.ts";
import {
  defaultSourceVersionContractFingerprint,
  type SourceVersionContractFingerprint,
} from "./migration-contract.ts";
import type { ProcessContext } from "./pipeline.ts";
import type { RollbackPipeline } from "./rollback.ts";
import type { SourceItem, SourceItemInput } from "./source.ts";
import type { MigrationItemStateForTrackingContract } from "./state.ts";
import type { TrackingRecordContract } from "./tracking.ts";

const configuredSourceTypeId: unique symbol = Symbol.for(
  "@migrate-sdk/ConfiguredSource"
);

const configuredSourceLayerTypeId: unique symbol = Symbol.for(
  "@migrate-sdk/ConfiguredSourceLayer"
);

const migrationDefinitionTypeId: unique symbol = Symbol.for(
  "@migrate-sdk/MigrationDefinition"
);

export type SourcePayloadSchema<
  Payload,
  EncodedPayload = unknown,
> = Schema.Codec<Payload, EncodedPayload, never, never>;

export type Source<
  Payload,
  Cursor,
  EncodedPayload = Payload,
  IdentityKey extends SourceIdentitySnapshotKey = SourceIdentitySnapshotKey,
> = SourceRuntimeService<Payload, Cursor, EncodedPayload, IdentityKey>;

export type SourceRuntimeLayer<
  Payload,
  Cursor,
  IdentityKey extends SourceIdentitySnapshotKey,
  EncodedPayload = Payload,
  SourceRuntimeError = never,
  SourceRuntimeRequirements = never,
> = <ServiceId>(
  service: Context.Service<
    ServiceId,
    SourceRuntimeImplementation<EncodedPayload, Cursor, IdentityKey>
  >
) => Layer.Layer<ServiceId, SourceRuntimeError, SourceRuntimeRequirements>;

type ConfiguredSourceLayer<
  Payload,
  Cursor,
  IdentityKey extends SourceIdentitySnapshotKey,
  EncodedPayload,
  SourceImplementationError,
  SourceRequirements,
> = <ServiceId>(
  service: Context.Service<
    ServiceId,
    SourceRuntimeService<Payload, Cursor, EncodedPayload, IdentityKey>
  >
) => Layer.Layer<ServiceId, SourceImplementationError, SourceRequirements>;

declare const sourceRuntimeLayerServiceTypeId: unique symbol;

interface SourceRuntimeLayerService<
  EncodedPayload,
  Cursor,
  IdentityKey extends SourceIdentitySnapshotKey,
> {
  readonly [sourceRuntimeLayerServiceTypeId]: {
    readonly cursor: Cursor;
    readonly encodedPayload: EncodedPayload;
    readonly identityKey: IdentityKey;
  };
}

export interface ConfiguredSource<
  Payload,
  Cursor,
  IdentityKey extends SourceIdentitySnapshotKey = SourceIdentitySnapshotKey,
  EncodedPayload = Payload,
  SourceImplementationError = never,
  SourceRequirements = never,
> {
  readonly identity: SourceIdentityDefinition<IdentityKey>;
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
    Payload,
    Cursor,
    IdentityKey,
    EncodedPayload,
    SourceImplementationError | ProvidedError,
    RemainingRequirements | Exclude<SourceRequirements, ProvidedRequirements>
  >;
  readonly sourceIdentityContractFingerprint: SourceIdentityDefinition<IdentityKey>["fingerprint"];
  readonly sourceSchema: SourcePayloadSchema<Payload, EncodedPayload>;
  readonly sourceVersionContractFingerprint: SourceVersionContractFingerprint;
  readonly [configuredSourceLayerTypeId]: ConfiguredSourceLayer<
    Payload,
    Cursor,
    IdentityKey,
    EncodedPayload,
    SourceImplementationError,
    SourceRequirements
  >;
  readonly [configuredSourceTypeId]: {
    readonly cursor: Cursor;
    readonly identityKey: IdentityKey;
    readonly payload: Payload;
    readonly sourceImplementationError: SourceImplementationError;
    readonly sourceRequirements: SourceRequirements;
    readonly encodedPayload: EncodedPayload;
  };
}

export type AnyConfiguredSource = ConfiguredSource<
  // biome-ignore lint/suspicious/noExplicitAny: Configured sources are existential in heterogeneous registries.
  any,
  // biome-ignore lint/suspicious/noExplicitAny: Cursor is recovered through ConfiguredSourceCursor.
  any,
  // biome-ignore lint/suspicious/noExplicitAny: Identity key is recovered through ConfiguredSourceIdentityKey.
  any,
  // biome-ignore lint/suspicious/noExplicitAny: Encoded payload is recovered through ConfiguredSourceEncodedPayload.
  any,
  // biome-ignore lint/suspicious/noExplicitAny: Source implementation error is recovered through ConfiguredSourceImplementationError.
  any,
  // biome-ignore lint/suspicious/noExplicitAny: Source requirements are recovered through ConfiguredSourceRequirements.
  any
>;

export type ConfiguredSourcePayload<Configured extends AnyConfiguredSource> =
  Configured[typeof configuredSourceTypeId]["payload"];

export type ConfiguredSourceCursor<Configured extends AnyConfiguredSource> =
  Configured[typeof configuredSourceTypeId]["cursor"];

export type ConfiguredSourceIdentityKey<
  Configured extends AnyConfiguredSource,
> = Configured[typeof configuredSourceTypeId]["identityKey"];

export type ConfiguredSourceEncodedPayload<
  Configured extends AnyConfiguredSource,
> = Configured[typeof configuredSourceTypeId]["encodedPayload"];

export type ConfiguredSourceImplementationError<
  Configured extends AnyConfiguredSource,
> = Configured[typeof configuredSourceTypeId]["sourceImplementationError"];

export type ConfiguredSourceRequirements<
  Configured extends AnyConfiguredSource,
> = Configured[typeof configuredSourceTypeId]["sourceRequirements"];

export const makeConfiguredSourceLayer = <
  Payload,
  Cursor,
  IdentityKey extends SourceIdentitySnapshotKey,
  EncodedPayload,
  SourceImplementationError,
  SourceRequirements,
  ServiceId,
>(
  source: ConfiguredSource<
    Payload,
    Cursor,
    IdentityKey,
    EncodedPayload,
    SourceImplementationError,
    SourceRequirements
  >,
  service: Context.Service<
    ServiceId,
    SourceRuntimeService<Payload, Cursor, EncodedPayload, IdentityKey>
  >
): Layer.Layer<ServiceId, SourceImplementationError, SourceRequirements> =>
  source[configuredSourceLayerTypeId](service);

export interface SourceMakeInput<
  Payload,
  Cursor,
  IdentityKey extends SourceIdentitySnapshotKey = SourceIdentitySnapshotKey,
  EncodedPayload = Payload,
> extends SourceRuntimeImplementation<EncodedPayload, Cursor, IdentityKey> {
  readonly cursorSchema: Schema.Codec<Cursor, unknown, never, never>;
  readonly identity: SourceIdentityDefinition<IdentityKey>;
  readonly sourceIdentityContractFingerprint?: SourceIdentityDefinition<IdentityKey>["fingerprint"];
  readonly sourceSchema: SourcePayloadSchema<Payload, EncodedPayload>;
  readonly sourceVersionContractFingerprint?: SourceVersionContractFingerprint;
}

export interface SourceFactoryInput<
  Payload,
  Cursor,
  IdentityKey extends SourceIdentitySnapshotKey = SourceIdentitySnapshotKey,
  EncodedPayload = Payload,
> {
  readonly cursorSchema: Schema.Codec<Cursor, unknown, never, never>;
  readonly identity: SourceIdentityDefinition<IdentityKey>;
  readonly make: () => SourceRuntimeImplementation<
    EncodedPayload,
    Cursor,
    IdentityKey
  >;
  readonly sourceIdentityContractFingerprint?: SourceIdentityDefinition<IdentityKey>["fingerprint"];
  readonly sourceSchema: SourcePayloadSchema<Payload, EncodedPayload>;
  readonly sourceVersionContractFingerprint?: SourceVersionContractFingerprint;
}

export interface SourceLayerInput<
  Payload,
  Cursor,
  IdentityKey extends SourceIdentitySnapshotKey = SourceIdentitySnapshotKey,
  EncodedPayload = Payload,
  SourceLayerError = never,
  SourceRequirements = never,
> {
  readonly cursorSchema: Schema.Codec<Cursor, unknown, never, never>;
  readonly identity: SourceIdentityDefinition<IdentityKey>;
  readonly layer: SourceRuntimeLayer<
    NoInfer<Payload>,
    NoInfer<Cursor>,
    NoInfer<IdentityKey>,
    NoInfer<EncodedPayload>,
    SourceLayerError,
    SourceRequirements
  >;
  readonly sourceIdentityContractFingerprint?: SourceIdentityDefinition<IdentityKey>["fingerprint"];
  readonly sourceSchema: SourcePayloadSchema<Payload, EncodedPayload>;
  readonly sourceVersionContractFingerprint?: SourceVersionContractFingerprint;
}

interface ConfiguredSourceUseInput<
  Payload,
  Cursor,
  IdentityKey extends SourceIdentitySnapshotKey = SourceIdentitySnapshotKey,
  EncodedPayload = Payload,
  SourceImplementationError = never,
  SourceRequirements = never,
> {
  readonly cursorSchema: Schema.Codec<Cursor, unknown, never, never>;
  readonly identity: SourceIdentityDefinition<IdentityKey>;
  readonly sourceIdentityContractFingerprint?: SourceIdentityDefinition<IdentityKey>["fingerprint"];
  readonly sourceSchema: SourcePayloadSchema<Payload, EncodedPayload>;
  readonly sourceVersionContractFingerprint?: SourceVersionContractFingerprint;
  readonly toLayer: ConfiguredSourceLayer<
    Payload,
    Cursor,
    IdentityKey,
    EncodedPayload,
    SourceImplementationError,
    SourceRequirements
  >;
}

export interface SourceReadResultInput<
  EncodedPayload,
  Cursor,
  IdentityKey extends SourceIdentitySnapshotKey = SourceIdentitySnapshotKey,
> {
  readonly items: readonly SourceItemInput<EncodedPayload, IdentityKey>[];
  readonly nextCursor?: Cursor | undefined;
}

const makeConfiguredSource = <
  Payload,
  Cursor,
  IdentityKey extends SourceIdentitySnapshotKey = SourceIdentitySnapshotKey,
  EncodedPayload = Payload,
  SourceImplementationError = never,
  SourceRequirements = never,
>(
  input: ConfiguredSourceUseInput<
    Payload,
    Cursor,
    IdentityKey,
    EncodedPayload,
    SourceImplementationError,
    SourceRequirements
  >
): ConfiguredSource<
  Payload,
  Cursor,
  IdentityKey,
  EncodedPayload,
  SourceImplementationError,
  SourceRequirements
> => {
  return {
    [configuredSourceTypeId]: undefined as never,
    identity: input.identity,
    provide: <ProvidedRequirements, ProvidedError, RemainingRequirements>(
      layer: Layer.Layer<
        ProvidedRequirements,
        ProvidedError,
        RemainingRequirements
      >
    ) =>
      makeConfiguredSource<
        Payload,
        Cursor,
        IdentityKey,
        EncodedPayload,
        SourceImplementationError | ProvidedError,
        | RemainingRequirements
        | Exclude<SourceRequirements, ProvidedRequirements>
      >({
        cursorSchema: input.cursorSchema,
        identity: input.identity,
        sourceSchema: input.sourceSchema,
        toLayer: (service) => input.toLayer(service).pipe(Layer.provide(layer)),
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
    [configuredSourceLayerTypeId]: input.toLayer,
  };
};

const makeSource = <
  Payload,
  Cursor,
  IdentityKey extends SourceIdentitySnapshotKey,
  EncodedPayload = Payload,
>(
  input:
    | SourceFactoryInput<Payload, Cursor, IdentityKey, EncodedPayload>
    | SourceMakeInput<Payload, Cursor, IdentityKey, EncodedPayload>
): ConfiguredSource<Payload, Cursor, IdentityKey, EncodedPayload> => {
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
    toLayer: (service) =>
      Layer.sync(service, () =>
        makeSourceRuntime<Payload, Cursor, IdentityKey, EncodedPayload>({
          cursorSchema: input.cursorSchema,
          identity: input.identity,
          implementation: makeImplementation(),
          sourceSchema: input.sourceSchema,
        })
      ),
    cursorSchema: input.cursorSchema,
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
  Payload,
  Cursor,
  IdentityKey extends SourceIdentitySnapshotKey,
  EncodedPayload = Payload,
  SourceLayerError = never,
  SourceRequirements = never,
>(
  input: SourceLayerInput<
    Payload,
    Cursor,
    IdentityKey,
    EncodedPayload,
    SourceLayerError,
    SourceRequirements
  >
): ConfiguredSource<
  Payload,
  Cursor,
  IdentityKey,
  EncodedPayload,
  SourceLayerError,
  SourceRequirements
> =>
  makeConfiguredSource({
    cursorSchema: input.cursorSchema,
    identity: input.identity,
    sourceSchema: input.sourceSchema,
    toLayer: (service) => {
      const runtimeService = Context.Service<
        SourceRuntimeLayerService<EncodedPayload, Cursor, IdentityKey>,
        SourceRuntimeImplementation<EncodedPayload, Cursor, IdentityKey>
      >(`${service.key}/SourceRuntime`);

      return Layer.effect(
        service,
        runtimeService.pipe(
          Effect.map((runtime) =>
            makeSourceRuntime<Payload, Cursor, IdentityKey, EncodedPayload>({
              cursorSchema: input.cursorSchema,
              identity: input.identity,
              implementation: runtime,
              sourceSchema: input.sourceSchema,
            })
          )
        )
      ).pipe(Layer.provide(input.layer(runtimeService)));
    },
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

export const Source = {
  fromLayer: sourceFromLayer,
  make: makeSource,
};

export type SourceRetryStrategy = <Payload>(
  effect: Effect.Effect<Payload, SourceError>
) => Effect.Effect<Payload, SourceError>;

export type ProcessPipeline<
  Payload,
  ProcessError,
  IdentityKey extends SourceIdentitySnapshotKey,
  TrackingContract extends TrackingRecordContract | undefined = undefined,
> = (
  source: SourceItem<Payload, IdentityKey>,
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
  Payload,
  PipelineError = never,
  Cursor = unknown,
  IdentityKey extends SourceIdentitySnapshotKey = SourceIdentitySnapshotKey,
  RollbackPipelineError = PipelineError,
  EncodedPayload = Payload,
  SourceImplementationError = never,
  SourceRequirements = never,
  TrackingContract extends TrackingRecordContract | undefined = undefined,
> {
  readonly dependencies?: MigrationDefinitionDependencies;
  readonly execution?: NormalizedMigrationExecutionOptions;
  readonly id: MigrationDefinitionId;
  readonly process: ProcessPipeline<
    Payload,
    PipelineError,
    IdentityKey,
    TrackingContract
  >;
  readonly rollback?: RollbackPipeline<
    RollbackPipelineError,
    MigrationItemStateForTrackingContract<TrackingContract>
  >;
  readonly source: ConfiguredSource<
    Payload,
    Cursor,
    IdentityKey,
    EncodedPayload,
    SourceImplementationError,
    SourceRequirements
  >;
  readonly sourceCursorRetry?: SourceRetryStrategy;
  readonly sourceLookupRetry?: SourceRetryStrategy;
  readonly store: Layer.Layer<MigrationStore, MigrationStoreError>;
  readonly stub?: (
    input: DestinationStubInput,
    context: DestinationStubContext
  ) => void | Effect.Effect<void, PipelineError | SkipItem, Tracking>;
  readonly [migrationDefinitionTypeId]: {
    readonly processError: PipelineError;
    readonly rollbackError: RollbackPipelineError;
    readonly source: ConfiguredSource<
      Payload,
      Cursor,
      IdentityKey,
      EncodedPayload,
      SourceImplementationError,
      SourceRequirements
    >;
    readonly tracking: TrackingContract;
  };
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
  Payload,
  PipelineError = never,
  Cursor = unknown,
  IdentityKey extends SourceIdentitySnapshotKey = SourceIdentitySnapshotKey,
  RollbackPipelineError = PipelineError,
  EncodedPayload = Payload,
  SourceImplementationError = never,
  SourceRequirements = never,
  TrackingContract extends TrackingRecordContract | undefined = undefined,
> = MigrationDefinitionBase<
  Payload,
  PipelineError,
  Cursor,
  IdentityKey,
  RollbackPipelineError,
  EncodedPayload,
  SourceImplementationError,
  SourceRequirements,
  TrackingContract
> &
  MigrationDefinitionTracking<TrackingContract>;

export type AnyMigrationDefinition = Omit<
  MigrationDefinitionBase<
    // biome-ignore lint/suspicious/noExplicitAny: Payload is existential across heterogeneous definition collections.
    any,
    // biome-ignore lint/suspicious/noExplicitAny: Process error is recovered through MigrationDefinitionProcessError.
    any,
    // biome-ignore lint/suspicious/noExplicitAny: Cursor is recovered through the definition source.
    any,
    // biome-ignore lint/suspicious/noExplicitAny: Identity key is recovered through MigrationDefinitionSourceIdentityKey.
    any,
    // biome-ignore lint/suspicious/noExplicitAny: Rollback error is recovered through MigrationDefinitionRollbackError.
    any,
    // biome-ignore lint/suspicious/noExplicitAny: Encoded payload is recovered through the definition source.
    any,
    // biome-ignore lint/suspicious/noExplicitAny: Source implementation error is recovered through the definition source.
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

export type MigrationDefinitionSourceImplementationError<
  Definition extends AnyMigrationDefinition,
> = ConfiguredSourceImplementationError<MigrationDefinitionSource<Definition>>;

export type MigrationDefinitionSourceRequirements<
  Definition extends AnyMigrationDefinition,
> = ConfiguredSourceRequirements<MigrationDefinitionSource<Definition>>;

export type MigrationDefinitionSourceIdentityKey<
  Definition extends AnyMigrationDefinition,
> = ConfiguredSourceIdentityKey<MigrationDefinitionSource<Definition>>;

export type MigrationDefinitionInputForSource<
  SourceDefinition extends AnyConfiguredSource,
  PipelineError = never,
  RollbackPipelineError = PipelineError,
  TrackingContract extends TrackingRecordContract | undefined = undefined,
> = MigrationDefinitionInput<
  ConfiguredSourcePayload<SourceDefinition>,
  PipelineError,
  ConfiguredSourceCursor<SourceDefinition>,
  ConfiguredSourceIdentityKey<SourceDefinition>,
  RollbackPipelineError,
  ConfiguredSourceEncodedPayload<SourceDefinition>,
  ConfiguredSourceImplementationError<SourceDefinition>,
  ConfiguredSourceRequirements<SourceDefinition>,
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
  Payload,
  PipelineError = never,
  Cursor = unknown,
  IdentityKey extends SourceIdentitySnapshotKey = SourceIdentitySnapshotKey,
  RollbackPipelineError = PipelineError,
  EncodedPayload = Payload,
  SourceImplementationError = never,
  SourceRequirements = never,
  TrackingContract extends TrackingRecordContract | undefined = undefined,
> = Omit<
  MigrationDefinitionBase<
    Payload,
    PipelineError,
    Cursor,
    IdentityKey,
    RollbackPipelineError,
    EncodedPayload,
    SourceImplementationError,
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
  Payload,
  PipelineError = never,
  Cursor = unknown,
  IdentityKey extends SourceIdentitySnapshotKey = SourceIdentitySnapshotKey,
  RollbackPipelineError = PipelineError,
  EncodedPayload = Payload,
  SourceImplementationError = never,
  SourceRequirements = never,
>(
  definition: MigrationDefinitionInput<
    Payload,
    PipelineError,
    Cursor,
    IdentityKey,
    RollbackPipelineError,
    EncodedPayload,
    SourceImplementationError,
    SourceRequirements,
    undefined
  >
): MigrationDefinition<
  Payload,
  PipelineError,
  Cursor,
  IdentityKey,
  RollbackPipelineError,
  EncodedPayload,
  SourceImplementationError,
  SourceRequirements,
  undefined
>;
function makeMigrationDefinition<
  Payload,
  PipelineError = never,
  Cursor = unknown,
  IdentityKey extends SourceIdentitySnapshotKey = SourceIdentitySnapshotKey,
  RollbackPipelineError = PipelineError,
  EncodedPayload = Payload,
  SourceImplementationError = never,
  SourceRequirements = never,
  TrackingContract extends TrackingRecordContract = TrackingRecordContract,
>(
  definition: MigrationDefinitionInput<
    Payload,
    PipelineError,
    Cursor,
    IdentityKey,
    RollbackPipelineError,
    EncodedPayload,
    SourceImplementationError,
    SourceRequirements,
    TrackingContract
  >
): MigrationDefinition<
  Payload,
  PipelineError,
  Cursor,
  IdentityKey,
  RollbackPipelineError,
  EncodedPayload,
  SourceImplementationError,
  SourceRequirements,
  TrackingContract
>;
function makeMigrationDefinition<
  Payload,
  PipelineError = never,
  Cursor = unknown,
  IdentityKey extends SourceIdentitySnapshotKey = SourceIdentitySnapshotKey,
  RollbackPipelineError = PipelineError,
  EncodedPayload = Payload,
  SourceImplementationError = never,
  SourceRequirements = never,
  TrackingContract extends TrackingRecordContract | undefined = undefined,
>(
  definition: MigrationDefinitionInput<
    Payload,
    PipelineError,
    Cursor,
    IdentityKey,
    RollbackPipelineError,
    EncodedPayload,
    SourceImplementationError,
    SourceRequirements,
    TrackingContract
  >
): MigrationDefinition<
  Payload,
  PipelineError,
  Cursor,
  IdentityKey,
  RollbackPipelineError,
  EncodedPayload,
  SourceImplementationError,
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
    Payload,
    PipelineError,
    Cursor,
    IdentityKey,
    RollbackPipelineError,
    EncodedPayload,
    SourceImplementationError,
    SourceRequirements,
    TrackingContract
  >;
  return normalizedDefinition;
}

export const MigrationDefinition = {
  make: makeMigrationDefinition,
} as const;
