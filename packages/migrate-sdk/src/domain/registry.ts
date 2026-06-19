import { Effect, Option, Schema } from "effect";
import { getMigrationStatuses } from "../runtime/get-migration-statuses.ts";
import {
  type RollbackMigrationError,
  type RunMigrationError,
  rollbackMigrationsWithEncodedSourceIdentities,
  runMigrationsWithEncodedRunMode,
} from "../runtime/run-migrations.ts";
import type {
  MigrationExecutionOptions,
  PipelineExecutionConcurrency,
} from "./execution.ts";
import { resolvePipelineExecutionOptions } from "./execution.ts";
import type {
  EncodedSourceIdentity,
  MigrationDefinitionId,
  MigrationDefinitionIdInput,
} from "./ids.ts";
import {
  EncodedSourceIdentity as EncodedSourceIdentitySchema,
  MigrationDefinitionId as MigrationDefinitionIdSchema,
  SourceIdentity,
  toMigrationDefinitionId,
} from "./ids.ts";
import type {
  AnyRollbackMigrationDefinition,
  RollbackRunSummary,
} from "./rollback.ts";
import type {
  AnyMigrationDefinition,
  MigrationRunSummary,
  RunRequestSourceLayerError,
  RunRequestSourceRequirements,
} from "./run.ts";
import type { RunModeInput } from "./run-mode.ts";
import type {
  GetMigrationStatusesError,
  MigrationStatusReport,
} from "./status.ts";

type AnyRollbackMigrationDefinitions =
  readonly AnyRollbackMigrationDefinition[];

export interface MigrationDefinitionRegistryInput<
  Definitions extends
    readonly AnyMigrationDefinition[] = readonly AnyMigrationDefinition[],
> {
  readonly definitions: Definitions;
}

export interface MigrationDefinitionRegistryEntry {
  readonly dependencies: {
    readonly optional: readonly MigrationDefinitionId[];
    readonly required: readonly MigrationDefinitionId[];
  };
  readonly hasRollback: boolean;
  readonly id: MigrationDefinitionId;
}

export type MigrationDefinitionRegistrySelectionInput =
  | {
      readonly all: true;
      readonly withDependencies?: boolean;
    }
  | {
      readonly definitionIds: readonly [
        MigrationDefinitionIdInput,
        ...MigrationDefinitionIdInput[],
      ];
      readonly withDependencies?: boolean;
    };

export type MigrationDefinitionRegistryRunInput =
  MigrationDefinitionRegistrySelectionInput & {
    readonly execution?: MigrationExecutionOptions;
    readonly mode?: Exclude<RunModeInput, { readonly kind: "item" }>;
    readonly sourceIdentities?: readonly string[];
    readonly update?: boolean;
  };

export type MigrationDefinitionRegistryRollbackInput =
  MigrationDefinitionRegistrySelectionInput & {
    readonly execution?: MigrationExecutionOptions;
    readonly sourceIdentities?: readonly string[];
  };

export type MigrationDefinitionRegistryStatusInput =
  MigrationDefinitionRegistrySelectionInput & {
    readonly concurrency?: number;
    readonly scanSource?: boolean;
  };

export type MigrationDefinitionRegistryDurableStatusInput =
  MigrationDefinitionRegistrySelectionInput & {
    readonly concurrency?: never;
    readonly scanSource?: false;
  };

export type MigrationDefinitionRegistrySourceScanStatusInput =
  MigrationDefinitionRegistrySelectionInput & {
    readonly concurrency?: number;
    readonly scanSource: true;
  };

type MigrationDefinitionRegistryStatusImplementationEffect = Effect.Effect<
  MigrationDefinitionRegistryStatusReport,
  // biome-ignore lint/suspicious/noExplicitAny: Hidden implementation signature; public overloads keep precise status errors.
  any,
  // biome-ignore lint/suspicious/noExplicitAny: Hidden implementation signature; public overloads keep precise status requirements.
  any
>;

export interface MigrationDefinitionDependencyEdge {
  readonly fromDefinitionId: MigrationDefinitionId;
  readonly kind: "required" | "optional";
  readonly toDefinitionId: MigrationDefinitionId;
}

export class MigrationDefinitionDuplicateRequestedDefinitionIgnored extends Schema.TaggedClass<MigrationDefinitionDuplicateRequestedDefinitionIgnored>()(
  "MigrationDefinitionDuplicateRequestedDefinitionIgnored",
  {
    definitionId: MigrationDefinitionIdSchema,
  }
) {}

export class MigrationDefinitionDuplicateSourceIdentityTargetIgnored extends Schema.TaggedClass<MigrationDefinitionDuplicateSourceIdentityTargetIgnored>()(
  "MigrationDefinitionDuplicateSourceIdentityTargetIgnored",
  {
    sourceIdentity: EncodedSourceIdentitySchema,
  }
) {}

export class MigrationDefinitionOptionalDependencyCycleIgnored extends Schema.TaggedClass<MigrationDefinitionOptionalDependencyCycleIgnored>()(
  "MigrationDefinitionOptionalDependencyCycleIgnored",
  {
    definitionIds: Schema.NonEmptyArray(MigrationDefinitionIdSchema),
    edges: Schema.Array(
      Schema.Struct({
        fromDefinitionId: MigrationDefinitionIdSchema,
        kind: Schema.Literals(["required", "optional"]),
        toDefinitionId: MigrationDefinitionIdSchema,
      })
    ),
  }
) {}

export const MigrationDefinitionPlanNotice = Schema.Union([
  MigrationDefinitionDuplicateRequestedDefinitionIgnored,
  MigrationDefinitionDuplicateSourceIdentityTargetIgnored,
  MigrationDefinitionOptionalDependencyCycleIgnored,
]);
export type MigrationDefinitionPlanNotice =
  typeof MigrationDefinitionPlanNotice.Type;

export interface MigrationDefinitionPlanTarget {
  readonly definitionId: MigrationDefinitionId;
  readonly sourceIdentities: readonly [
    EncodedSourceIdentity,
    ...EncodedSourceIdentity[],
  ];
}

export interface MigrationDefinitionExecutionPolicy {
  readonly definitionId: MigrationDefinitionId;
  readonly processConcurrency: PipelineExecutionConcurrency;
  readonly rollbackConcurrency: PipelineExecutionConcurrency;
}

export interface MigrationDefinitionRunPlan {
  readonly definitions: readonly AnyMigrationDefinition[];
  readonly executionDefinitionIds: readonly MigrationDefinitionId[];
  readonly executionPolicy: readonly MigrationDefinitionExecutionPolicy[];
  readonly includedDefinitionIds: readonly MigrationDefinitionId[];
  readonly kind: "run";
  readonly notices: readonly MigrationDefinitionPlanNotice[];
  readonly optionalDependencyEdges: readonly MigrationDefinitionDependencyEdge[];
  readonly requestedDefinitionIds: "all" | readonly MigrationDefinitionId[];
  readonly target?: MigrationDefinitionPlanTarget;
  readonly update?: boolean;
  readonly withDependencies: boolean;
}

export interface MigrationDefinitionRollbackPlan {
  readonly definitions: readonly AnyRollbackMigrationDefinition[];
  readonly executionDefinitionIds: readonly MigrationDefinitionId[];
  readonly executionPolicy: readonly MigrationDefinitionExecutionPolicy[];
  readonly includedDefinitionIds: readonly MigrationDefinitionId[];
  readonly kind: "rollback";
  readonly notices: readonly MigrationDefinitionPlanNotice[];
  readonly optionalDependencyEdges: readonly MigrationDefinitionDependencyEdge[];
  readonly requestedDefinitionIds: "all" | readonly MigrationDefinitionId[];
  readonly target?: MigrationDefinitionPlanTarget;
  readonly withDependencies: boolean;
}

export interface MigrationDefinitionRegistryStatusReport
  extends MigrationStatusReport {
  readonly includedDefinitionIds: readonly MigrationDefinitionId[];
  readonly notices: readonly MigrationDefinitionPlanNotice[];
  readonly requestedDefinitionIds: "all" | readonly MigrationDefinitionId[];
}

export type MigrationDefinitionRegistryRunError =
  | MigrationDefinitionRegistryPlanningError
  | RunMigrationError;

export type MigrationDefinitionRegistryRollbackError =
  | MigrationDefinitionRegistryPlanningError
  | RollbackMigrationError;

export type MigrationDefinitionRegistryStatusError =
  | MigrationDefinitionRegistryPlanningError
  | GetMigrationStatusesError;

export class DuplicateMigrationDefinitionId extends Schema.TaggedClass<DuplicateMigrationDefinitionId>()(
  "DuplicateMigrationDefinitionId",
  {
    definitionId: MigrationDefinitionIdSchema,
  }
) {}

export class MissingRequiredMigrationDefinitionDependency extends Schema.TaggedClass<MissingRequiredMigrationDefinitionDependency>()(
  "MissingRequiredMigrationDefinitionDependency",
  {
    definitionId: MigrationDefinitionIdSchema,
    dependencyId: MigrationDefinitionIdSchema,
  }
) {}

export class RequiredMigrationDefinitionDependencyCycle extends Schema.TaggedClass<RequiredMigrationDefinitionDependencyCycle>()(
  "RequiredMigrationDefinitionDependencyCycle",
  {
    definitionIds: Schema.NonEmptyArray(MigrationDefinitionIdSchema),
  }
) {}

export const MigrationDefinitionRegistryConstructionIssue = Schema.Union([
  DuplicateMigrationDefinitionId,
  MissingRequiredMigrationDefinitionDependency,
  RequiredMigrationDefinitionDependencyCycle,
]);
export type MigrationDefinitionRegistryConstructionIssue =
  typeof MigrationDefinitionRegistryConstructionIssue.Type;

export class MigrationDefinitionRegistryConstructionError extends Schema.TaggedErrorClass<MigrationDefinitionRegistryConstructionError>()(
  "MigrationDefinitionRegistryConstructionError",
  {
    issues: Schema.NonEmptyArray(MigrationDefinitionRegistryConstructionIssue),
    message: Schema.String,
  }
) {}

export class MigrationDefinitionRegistryLookupError extends Schema.TaggedErrorClass<MigrationDefinitionRegistryLookupError>()(
  "MigrationDefinitionRegistryLookupError",
  {
    definitionId: MigrationDefinitionIdSchema,
    message: Schema.String,
  }
) {}

export class MigrationDefinitionRegistryUnknownDefinitionError extends Schema.TaggedErrorClass<MigrationDefinitionRegistryUnknownDefinitionError>()(
  "MigrationDefinitionRegistryUnknownDefinitionError",
  {
    definitionId: MigrationDefinitionIdSchema,
    message: Schema.String,
  }
) {}

export class MigrationDefinitionRegistryMissingExplicitRequiredDependenciesError extends Schema.TaggedErrorClass<MigrationDefinitionRegistryMissingExplicitRequiredDependenciesError>()(
  "MigrationDefinitionRegistryMissingExplicitRequiredDependenciesError",
  {
    definitionId: MigrationDefinitionIdSchema,
    message: Schema.String,
    missingDependencyIds: Schema.NonEmptyArray(MigrationDefinitionIdSchema),
  }
) {}

export class MigrationDefinitionRegistryInvalidSelectionError extends Schema.TaggedErrorClass<MigrationDefinitionRegistryInvalidSelectionError>()(
  "MigrationDefinitionRegistryInvalidSelectionError",
  {
    message: Schema.String,
  }
) {}

export type MigrationDefinitionRegistryPlanningError =
  | MigrationDefinitionRegistryUnknownDefinitionError
  | MigrationDefinitionRegistryMissingExplicitRequiredDependenciesError
  | MigrationDefinitionRegistryInvalidSelectionError;

const definitionRequiredDependencies = (
  definition: AnyMigrationDefinition
): readonly MigrationDefinitionId[] =>
  definition.dependencies?.required ?? definition.dependsOn ?? [];

const definitionOptionalDependencies = (
  definition: AnyMigrationDefinition
): readonly MigrationDefinitionId[] => definition.dependencies?.optional ?? [];

const registryDefinitionOrder = (
  definitions: readonly AnyMigrationDefinition[],
  definitionIds: ReadonlySet<MigrationDefinitionId>
): readonly MigrationDefinitionId[] =>
  definitions
    .map((definition) => definition.id)
    .filter((definitionId) => definitionIds.has(definitionId));

const optionalEdgesForDefinitions = (
  definitions: readonly AnyMigrationDefinition[],
  includedDefinitionIds: ReadonlySet<MigrationDefinitionId>
): readonly MigrationDefinitionDependencyEdge[] => {
  const edges: MigrationDefinitionDependencyEdge[] = [];

  for (const definition of definitions) {
    if (!includedDefinitionIds.has(definition.id)) {
      continue;
    }

    for (const dependencyId of definitionOptionalDependencies(definition)) {
      if (includedDefinitionIds.has(dependencyId)) {
        edges.push({
          fromDefinitionId: definition.id,
          kind: "optional",
          toDefinitionId: dependencyId,
        });
      }
    }
  }

  return edges;
};

const dedupeRequestedDefinitionIds = (
  definitionIds: readonly MigrationDefinitionId[],
  notices: MigrationDefinitionPlanNotice[]
): readonly MigrationDefinitionId[] => {
  const uniqueDefinitionIds: MigrationDefinitionId[] = [];
  const seenDefinitionIds = new Set<MigrationDefinitionId>();

  for (const definitionId of definitionIds) {
    if (seenDefinitionIds.has(definitionId)) {
      notices.push(
        new MigrationDefinitionDuplicateRequestedDefinitionIgnored({
          definitionId,
        })
      );
      continue;
    }

    seenDefinitionIds.add(definitionId);
    uniqueDefinitionIds.push(definitionId);
  }

  return uniqueDefinitionIds;
};

const dedupeTargetSourceIdentities = (
  sourceIdentities: readonly EncodedSourceIdentity[],
  notices: MigrationDefinitionPlanNotice[]
): readonly EncodedSourceIdentity[] => {
  const uniqueSourceIdentities: EncodedSourceIdentity[] = [];
  const seenSourceIdentities = new Set<EncodedSourceIdentity>();

  for (const sourceIdentity of sourceIdentities) {
    if (seenSourceIdentities.has(sourceIdentity)) {
      notices.push(
        new MigrationDefinitionDuplicateSourceIdentityTargetIgnored({
          sourceIdentity,
        })
      );
      continue;
    }

    seenSourceIdentities.add(sourceIdentity);
    uniqueSourceIdentities.push(sourceIdentity);
  }

  return uniqueSourceIdentities;
};

const parseTargetSourceIdentity = (
  definition: AnyMigrationDefinition,
  target: string
): Effect.Effect<
  EncodedSourceIdentity,
  MigrationDefinitionRegistryInvalidSelectionError
> =>
  Effect.try({
    try: () =>
      SourceIdentity.fromText(definition.source.identity, target).encoded,
    catch: () =>
      new MigrationDefinitionRegistryInvalidSelectionError({
        message: `Source identity target is invalid for Migration Definition ${definition.id}: ${target}`,
      }),
  });

const normalizeTargetSourceIdentities = (
  definition: AnyMigrationDefinition,
  sourceIdentities: readonly string[],
  notices: MigrationDefinitionPlanNotice[]
): Effect.Effect<
  readonly EncodedSourceIdentity[],
  MigrationDefinitionRegistryInvalidSelectionError
> =>
  Effect.map(
    Effect.forEach(sourceIdentities, (sourceIdentity) =>
      parseTargetSourceIdentity(definition, sourceIdentity)
    ),
    (parsedSourceIdentities) =>
      dedupeTargetSourceIdentities(parsedSourceIdentities, notices)
  );

interface ResolvedRegistrySelection {
  readonly notices: MigrationDefinitionPlanNotice[];
  readonly requestedDefinitionIds: "all" | readonly MigrationDefinitionId[];
  readonly selectsAll: boolean;
  readonly uniqueRequestedDefinitionIds: readonly MigrationDefinitionId[];
  readonly withDependencies: boolean;
}

interface ResolvedDefinitionPlanDetails {
  readonly executionDefinitionIds: readonly MigrationDefinitionId[];
  readonly includedDefinitionIdsInRegistryOrder: readonly MigrationDefinitionId[];
  readonly optionalDependencyEdges: readonly MigrationDefinitionDependencyEdge[];
}

const orderDefinitionIds = (
  definitions: readonly AnyMigrationDefinition[],
  definitionsById: ReadonlyMap<MigrationDefinitionId, AnyMigrationDefinition>,
  includedDefinitionIds: ReadonlySet<MigrationDefinitionId>,
  includeOptionalDependencies: boolean
): readonly MigrationDefinitionId[] => {
  const orderedDefinitionIds: MigrationDefinitionId[] = [];
  const visitedDefinitionIds = new Set<MigrationDefinitionId>();

  const visit = (definitionId: MigrationDefinitionId): void => {
    if (visitedDefinitionIds.has(definitionId)) {
      return;
    }

    const definition = definitionsById.get(definitionId);

    if (definition === undefined) {
      return;
    }

    for (const dependencyId of [
      ...definitionRequiredDependencies(definition),
      ...(includeOptionalDependencies
        ? definitionOptionalDependencies(definition)
        : []),
    ]) {
      if (includedDefinitionIds.has(dependencyId)) {
        visit(dependencyId);
      }
    }

    visitedDefinitionIds.add(definitionId);
    orderedDefinitionIds.push(definitionId);
  };

  for (const definitionId of registryDefinitionOrder(
    definitions,
    includedDefinitionIds
  )) {
    visit(definitionId);
  }

  return orderedDefinitionIds;
};

const findOptionalDependencyCycle = (
  definitions: readonly AnyMigrationDefinition[],
  definitionsById: ReadonlyMap<MigrationDefinitionId, AnyMigrationDefinition>,
  includedDefinitionIds: ReadonlySet<MigrationDefinitionId>
): readonly [MigrationDefinitionId, ...MigrationDefinitionId[]] | null => {
  const visitedDefinitionIds = new Set<MigrationDefinitionId>();
  const activeDefinitionIds: MigrationDefinitionId[] = [];

  const visit = (
    definitionId: MigrationDefinitionId
  ): readonly [MigrationDefinitionId, ...MigrationDefinitionId[]] | null => {
    const activeIndex = activeDefinitionIds.indexOf(definitionId);

    if (activeIndex !== -1) {
      const cycle = [...activeDefinitionIds.slice(activeIndex), definitionId];
      const [firstDefinitionId, ...remainingDefinitionIds] = cycle;

      return firstDefinitionId === undefined
        ? null
        : [firstDefinitionId, ...remainingDefinitionIds];
    }

    if (visitedDefinitionIds.has(definitionId)) {
      return null;
    }

    const definition = definitionsById.get(definitionId);

    if (definition === undefined) {
      return null;
    }

    activeDefinitionIds.push(definitionId);

    for (const dependencyId of definitionOptionalDependencies(definition)) {
      if (!includedDefinitionIds.has(dependencyId)) {
        continue;
      }

      const cycle = visit(dependencyId);

      if (cycle !== null) {
        return cycle;
      }
    }

    activeDefinitionIds.pop();
    visitedDefinitionIds.add(definitionId);

    return null;
  };

  for (const definitionId of registryDefinitionOrder(
    definitions,
    includedDefinitionIds
  )) {
    const cycle = visit(definitionId);

    if (cycle !== null) {
      return cycle;
    }
  }

  return null;
};

const resolveSelectionInput = (
  definitions: readonly AnyMigrationDefinition[],
  definitionsById: ReadonlyMap<MigrationDefinitionId, AnyMigrationDefinition>,
  input: MigrationDefinitionRegistrySelectionInput
): Effect.Effect<
  ResolvedRegistrySelection,
  MigrationDefinitionRegistryPlanningError
> => {
  const selectsAll = "all" in input && input.all === true;
  const inputDefinitionIds =
    "definitionIds" in input ? input.definitionIds : undefined;

  if (selectsAll && inputDefinitionIds !== undefined) {
    return Effect.fail(
      new MigrationDefinitionRegistryInvalidSelectionError({
        message:
          "Registry planning cannot combine all: true with Migration Definition ids",
      })
    );
  }

  if (
    !selectsAll &&
    (inputDefinitionIds === undefined || inputDefinitionIds.length === 0)
  ) {
    return Effect.fail(
      new MigrationDefinitionRegistryInvalidSelectionError({
        message:
          "Registry planning requires all: true or at least one Migration Definition id",
      })
    );
  }

  const notices: MigrationDefinitionPlanNotice[] = [];
  const requestedDefinitionIds = selectsAll
    ? "all"
    : (inputDefinitionIds ?? []).map(toMigrationDefinitionId);
  const uniqueRequestedDefinitionIds =
    requestedDefinitionIds === "all"
      ? definitions.map((definition) => definition.id)
      : dedupeRequestedDefinitionIds(requestedDefinitionIds, notices);

  for (const definitionId of uniqueRequestedDefinitionIds) {
    if (!definitionsById.has(definitionId)) {
      return Effect.fail(
        new MigrationDefinitionRegistryUnknownDefinitionError({
          definitionId,
          message: "Migration Definition was not found in the registry",
        })
      );
    }
  }

  return Effect.succeed({
    notices,
    requestedDefinitionIds,
    selectsAll,
    uniqueRequestedDefinitionIds,
    withDependencies: input.withDependencies ?? false,
  });
};

const resolveIncludedDefinitionIds = (
  definitionsById: ReadonlyMap<MigrationDefinitionId, AnyMigrationDefinition>,
  selection: ResolvedRegistrySelection
): Effect.Effect<
  ReadonlySet<MigrationDefinitionId>,
  MigrationDefinitionRegistryMissingExplicitRequiredDependenciesError
> => {
  const includedDefinitionIds = new Set<MigrationDefinitionId>(
    selection.uniqueRequestedDefinitionIds
  );

  if (selection.withDependencies) {
    const includeRequiredDependencies = (
      definitionId: MigrationDefinitionId
    ): void => {
      const definition = definitionsById.get(definitionId);

      if (definition === undefined) {
        return;
      }

      for (const dependencyId of definitionRequiredDependencies(definition)) {
        if (!includedDefinitionIds.has(dependencyId)) {
          includedDefinitionIds.add(dependencyId);
          includeRequiredDependencies(dependencyId);
        }
      }
    };

    for (const definitionId of selection.uniqueRequestedDefinitionIds) {
      includeRequiredDependencies(definitionId);
    }

    return Effect.succeed(includedDefinitionIds);
  }

  for (const definitionId of selection.uniqueRequestedDefinitionIds) {
    const definition = definitionsById.get(definitionId);

    if (definition === undefined) {
      continue;
    }

    const missingDependencyIds = definitionRequiredDependencies(
      definition
    ).filter((dependencyId) => !includedDefinitionIds.has(dependencyId));
    const [firstDependencyId, ...remainingDependencyIds] = missingDependencyIds;

    if (firstDependencyId !== undefined) {
      return Effect.fail(
        new MigrationDefinitionRegistryMissingExplicitRequiredDependenciesError(
          {
            definitionId,
            message:
              "Migration Definition selection is missing required dependencies",
            missingDependencyIds: [
              firstDependencyId,
              ...remainingDependencyIds,
            ],
          }
        )
      );
    }
  }

  return Effect.succeed(includedDefinitionIds);
};

const resolveDefinitionPlanDetails = (
  definitions: readonly AnyMigrationDefinition[],
  definitionsById: ReadonlyMap<MigrationDefinitionId, AnyMigrationDefinition>,
  includedDefinitionIds: ReadonlySet<MigrationDefinitionId>,
  notices: MigrationDefinitionPlanNotice[]
): ResolvedDefinitionPlanDetails => {
  const includedDefinitionIdsInRegistryOrder = registryDefinitionOrder(
    definitions,
    includedDefinitionIds
  );
  const optionalDependencyEdges = optionalEdgesForDefinitions(
    definitions,
    includedDefinitionIds
  );
  const optionalDependencyCycle = findOptionalDependencyCycle(
    definitions,
    definitionsById,
    includedDefinitionIds
  );

  if (optionalDependencyCycle !== null) {
    notices.push(
      new MigrationDefinitionOptionalDependencyCycleIgnored({
        definitionIds: optionalDependencyCycle,
        edges: optionalDependencyEdges,
      })
    );
  }

  return {
    executionDefinitionIds: orderDefinitionIds(
      definitions,
      definitionsById,
      includedDefinitionIds,
      optionalDependencyCycle === null
    ),
    includedDefinitionIdsInRegistryOrder,
    optionalDependencyEdges,
  };
};

const resolveDefinitionExecutionPolicy = (
  definitions: readonly AnyMigrationDefinition[],
  execution: MigrationExecutionOptions | undefined
): Effect.Effect<
  readonly MigrationDefinitionExecutionPolicy[],
  MigrationDefinitionRegistryInvalidSelectionError
> =>
  Effect.try({
    try: () =>
      definitions.map((definition) => ({
        definitionId: definition.id,
        processConcurrency: resolvePipelineExecutionOptions(
          execution?.process,
          definition.execution?.process,
          "Process Pipeline Execution"
        ).concurrency,
        rollbackConcurrency: resolvePipelineExecutionOptions(
          execution?.rollback,
          definition.execution?.rollback,
          "Rollback Pipeline Execution"
        ).concurrency,
      })),
    catch: (cause) =>
      new MigrationDefinitionRegistryInvalidSelectionError({
        message:
          cause instanceof Error
            ? cause.message
            : 'Migration execution concurrency must be a positive integer or "unbounded"',
      }),
  });

const normalizeRunTarget = (
  input: MigrationDefinitionRegistryRunInput,
  selection: ResolvedRegistrySelection,
  definitionsById: ReadonlyMap<MigrationDefinitionId, AnyMigrationDefinition>
): Effect.Effect<
  Option.Option<MigrationDefinitionPlanTarget>,
  MigrationDefinitionRegistryInvalidSelectionError
> => {
  const mode = input.mode as RunModeInput | undefined;

  if (mode?.kind === "item") {
    return Effect.fail(
      new MigrationDefinitionRegistryInvalidSelectionError({
        message:
          "Registry run item mode must be requested with sourceIdentities",
      })
    );
  }

  if (input.sourceIdentities === undefined) {
    return Effect.succeed(Option.none());
  }

  if (
    selection.selectsAll ||
    selection.uniqueRequestedDefinitionIds.length !== 1
  ) {
    return Effect.fail(
      new MigrationDefinitionRegistryInvalidSelectionError({
        message:
          "Run source identity targeting requires exactly one explicit Migration Definition id",
      })
    );
  }

  if (selection.withDependencies) {
    return Effect.fail(
      new MigrationDefinitionRegistryInvalidSelectionError({
        message:
          "Run source identity targeting cannot expand required dependencies",
      })
    );
  }

  if (input.mode !== undefined && input.mode.kind !== "normal") {
    return Effect.fail(
      new MigrationDefinitionRegistryInvalidSelectionError({
        message:
          "Run source identity targeting cannot combine with another run mode",
      })
    );
  }

  const [definitionId] = selection.uniqueRequestedDefinitionIds;

  if (definitionId === undefined) {
    return Effect.fail(
      new MigrationDefinitionRegistryInvalidSelectionError({
        message:
          "Run source identity targeting requires exactly one explicit Migration Definition id",
      })
    );
  }

  const definition = definitionsById.get(definitionId);

  if (definition === undefined) {
    return Effect.fail(
      new MigrationDefinitionRegistryInvalidSelectionError({
        message:
          "Run source identity targeting requires a registered Migration Definition",
      })
    );
  }

  return Effect.flatMap(
    normalizeTargetSourceIdentities(
      definition,
      input.sourceIdentities,
      selection.notices
    ),
    (sourceIdentities) => {
      const [firstSourceIdentity, ...remainingSourceIdentities] =
        sourceIdentities;

      if (
        firstSourceIdentity === undefined ||
        remainingSourceIdentities.length > 0
      ) {
        return Effect.fail(
          new MigrationDefinitionRegistryInvalidSelectionError({
            message:
              "Run source identity targeting requires exactly one source identity",
          })
        );
      }

      return Effect.succeed(
        Option.some({
          definitionId,
          sourceIdentities: [firstSourceIdentity],
        })
      );
    }
  );
};

const validateUpdateRunInput = (
  input: MigrationDefinitionRegistryRunInput
): Effect.Effect<void, MigrationDefinitionRegistryInvalidSelectionError> => {
  if (input.update !== true) {
    return Effect.void;
  }

  if (input.mode?.kind === "failed") {
    return Effect.fail(
      new MigrationDefinitionRegistryInvalidSelectionError({
        message: "Update run planning cannot combine with failed mode",
      })
    );
  }

  if (input.mode?.kind === "skipped") {
    return Effect.fail(
      new MigrationDefinitionRegistryInvalidSelectionError({
        message: "Update run planning cannot combine with skipped mode",
      })
    );
  }

  if (input.sourceIdentities !== undefined) {
    return Effect.fail(
      new MigrationDefinitionRegistryInvalidSelectionError({
        message: "Update run planning cannot target source identities",
      })
    );
  }

  return Effect.void;
};

const normalizeRollbackTarget = (
  input: MigrationDefinitionRegistryRollbackInput,
  selection: ResolvedRegistrySelection,
  definitionsById: ReadonlyMap<MigrationDefinitionId, AnyMigrationDefinition>
): Effect.Effect<
  Option.Option<MigrationDefinitionPlanTarget>,
  MigrationDefinitionRegistryInvalidSelectionError
> => {
  if (input.sourceIdentities === undefined) {
    return Effect.succeed(Option.none());
  }

  if (
    selection.selectsAll ||
    selection.uniqueRequestedDefinitionIds.length !== 1
  ) {
    return Effect.fail(
      new MigrationDefinitionRegistryInvalidSelectionError({
        message:
          "Rollback source identity targeting requires exactly one explicit Migration Definition id",
      })
    );
  }

  if (selection.withDependencies) {
    return Effect.fail(
      new MigrationDefinitionRegistryInvalidSelectionError({
        message:
          "Rollback source identity targeting cannot expand required dependencies",
      })
    );
  }

  const [definitionId] = selection.uniqueRequestedDefinitionIds;

  if (definitionId === undefined) {
    return Effect.fail(
      new MigrationDefinitionRegistryInvalidSelectionError({
        message:
          "Rollback source identity targeting requires exactly one explicit Migration Definition id",
      })
    );
  }

  const definition = definitionsById.get(definitionId);

  if (definition === undefined) {
    return Effect.fail(
      new MigrationDefinitionRegistryInvalidSelectionError({
        message:
          "Rollback source identity targeting requires a registered Migration Definition",
      })
    );
  }

  return Effect.flatMap(
    normalizeTargetSourceIdentities(
      definition,
      input.sourceIdentities,
      selection.notices
    ),
    (sourceIdentities) => {
      const [firstSourceIdentity, ...remainingSourceIdentities] =
        sourceIdentities;

      if (firstSourceIdentity === undefined) {
        return Effect.fail(
          new MigrationDefinitionRegistryInvalidSelectionError({
            message:
              "Rollback source identity targeting requires at least one source identity",
          })
        );
      }

      return Effect.succeed(
        Option.some({
          definitionId,
          sourceIdentities: [firstSourceIdentity, ...remainingSourceIdentities],
        })
      );
    }
  );
};

const collectConstructionIssues = (
  definitions: readonly AnyMigrationDefinition[]
): readonly MigrationDefinitionRegistryConstructionIssue[] => {
  const issues: MigrationDefinitionRegistryConstructionIssue[] = [];
  const definitionIds = new Set<MigrationDefinitionId>();
  const duplicateDefinitionIds = new Set<MigrationDefinitionId>();

  for (const definition of definitions) {
    if (definitionIds.has(definition.id)) {
      duplicateDefinitionIds.add(definition.id);
    }

    definitionIds.add(definition.id);
  }

  for (const definitionId of duplicateDefinitionIds) {
    issues.push(new DuplicateMigrationDefinitionId({ definitionId }));
  }

  for (const definition of definitions) {
    for (const dependencyId of definitionRequiredDependencies(definition)) {
      if (!definitionIds.has(dependencyId)) {
        issues.push(
          new MissingRequiredMigrationDefinitionDependency({
            definitionId: definition.id,
            dependencyId,
          })
        );
      }
    }
  }

  const definitionsById = new Map<
    MigrationDefinitionId,
    AnyMigrationDefinition
  >();

  for (const definition of definitions) {
    if (!definitionsById.has(definition.id)) {
      definitionsById.set(definition.id, definition);
    }
  }

  const visitedDefinitionIds = new Set<MigrationDefinitionId>();
  const activeDefinitionIds: MigrationDefinitionId[] = [];

  const visit = (definitionId: MigrationDefinitionId): void => {
    const activeIndex = activeDefinitionIds.indexOf(definitionId);

    if (activeIndex !== -1) {
      const cycleDefinitionIds = [
        ...activeDefinitionIds.slice(activeIndex),
        definitionId,
      ];
      const [firstDefinitionId, ...remainingDefinitionIds] = cycleDefinitionIds;

      if (firstDefinitionId !== undefined) {
        issues.push(
          new RequiredMigrationDefinitionDependencyCycle({
            definitionIds: [firstDefinitionId, ...remainingDefinitionIds],
          })
        );
      }

      return;
    }

    if (visitedDefinitionIds.has(definitionId)) {
      return;
    }

    const definition = definitionsById.get(definitionId);

    if (definition === undefined) {
      return;
    }

    activeDefinitionIds.push(definitionId);

    for (const dependencyId of definitionRequiredDependencies(definition)) {
      visit(dependencyId);
    }

    activeDefinitionIds.pop();
    visitedDefinitionIds.add(definitionId);
  };

  for (const definition of definitions) {
    visit(definition.id);
  }

  return issues;
};

const validateConstruction = (
  definitions: readonly AnyMigrationDefinition[]
): void => {
  const issues = collectConstructionIssues(definitions);
  const [firstIssue, ...remainingIssues] = issues;

  if (firstIssue === undefined) {
    return;
  }

  throw new MigrationDefinitionRegistryConstructionError({
    issues: [firstIssue, ...remainingIssues],
    message: "Migration Definition Registry contains invalid definitions",
  });
};

const freezeEntry = (
  entry: MigrationDefinitionRegistryEntry
): MigrationDefinitionRegistryEntry =>
  Object.freeze({
    ...entry,
    dependencies: Object.freeze({
      optional: Object.freeze([...entry.dependencies.optional]),
      required: Object.freeze([...entry.dependencies.required]),
    }),
  });

export class MigrationDefinitionRegistry<
  Definitions extends
    readonly AnyMigrationDefinition[] = readonly AnyMigrationDefinition[],
> {
  readonly #definitions: Definitions;
  readonly #definitionsById: ReadonlyMap<
    MigrationDefinitionId,
    AnyMigrationDefinition
  >;
  readonly #entries: readonly MigrationDefinitionRegistryEntry[];

  private constructor(definitions: Definitions) {
    validateConstruction(definitions);

    this.#definitions = Object.freeze([
      ...definitions,
    ]) as unknown as Definitions;
    this.#definitionsById = new Map(
      this.#definitions.map((definition) => [definition.id, definition])
    );
    this.#entries = Object.freeze(
      this.#definitions.map((definition) =>
        freezeEntry({
          id: definition.id,
          dependencies: {
            optional: definitionOptionalDependencies(definition),
            required: definitionRequiredDependencies(definition),
          },
          hasRollback: definition.rollback !== undefined,
        })
      )
    );
  }

  static make<const Definitions extends readonly AnyMigrationDefinition[]>(
    input: MigrationDefinitionRegistryInput<Definitions>
  ): MigrationDefinitionRegistry<Definitions> {
    return new MigrationDefinitionRegistry(input.definitions);
  }

  definitions(): Definitions {
    return this.#definitions;
  }

  get(
    definitionId: MigrationDefinitionIdInput
  ): Option.Option<AnyMigrationDefinition> {
    return Option.fromUndefinedOr(
      this.#definitionsById.get(toMigrationDefinitionId(definitionId))
    );
  }

  list(): readonly MigrationDefinitionRegistryEntry[] {
    return this.#entries;
  }

  planRun(
    input: MigrationDefinitionRegistryRunInput
  ): Effect.Effect<
    MigrationDefinitionRunPlan,
    MigrationDefinitionRegistryPlanningError
  > {
    const definitions = this.#definitions;
    const definitionsById = this.#definitionsById;

    return Effect.gen(function* () {
      const selection = yield* resolveSelectionInput(
        definitions,
        definitionsById,
        input
      );
      yield* validateUpdateRunInput(input);
      const targetOption = yield* normalizeRunTarget(
        input,
        selection,
        definitionsById
      );
      const includedDefinitionIds = yield* resolveIncludedDefinitionIds(
        definitionsById,
        selection
      );
      const planDetails = resolveDefinitionPlanDetails(
        definitions,
        definitionsById,
        includedDefinitionIds,
        selection.notices
      );
      const planDefinitions = planDetails.executionDefinitionIds.map(
        (definitionId) => definitionsById.get(definitionId)
      ) as readonly AnyMigrationDefinition[];
      const executionPolicy = yield* resolveDefinitionExecutionPolicy(
        planDefinitions,
        input.execution
      );
      const target = Option.getOrUndefined(targetOption);

      return {
        kind: "run",
        requestedDefinitionIds: selection.requestedDefinitionIds,
        includedDefinitionIds: planDetails.includedDefinitionIdsInRegistryOrder,
        executionDefinitionIds: planDetails.executionDefinitionIds,
        executionPolicy,
        optionalDependencyEdges: planDetails.optionalDependencyEdges,
        definitions: planDefinitions,
        ...(target === undefined ? {} : { target }),
        notices: selection.notices,
        ...(input.update === undefined ? {} : { update: input.update }),
        withDependencies: selection.withDependencies,
      };
    });
  }

  planRollback(
    input: MigrationDefinitionRegistryRollbackInput
  ): Effect.Effect<
    MigrationDefinitionRollbackPlan,
    MigrationDefinitionRegistryPlanningError
  > {
    const definitions = this.#definitions;
    const definitionsById = this.#definitionsById;

    return Effect.gen(function* () {
      const selection = yield* resolveSelectionInput(
        definitions,
        definitionsById,
        input
      );
      const targetOption = yield* normalizeRollbackTarget(
        input,
        selection,
        definitionsById
      );
      const includedDefinitionIds = yield* resolveIncludedDefinitionIds(
        definitionsById,
        selection
      );
      const planDetails = resolveDefinitionPlanDetails(
        definitions,
        definitionsById,
        includedDefinitionIds,
        selection.notices
      );
      const executionDefinitionIds = [
        ...planDetails.executionDefinitionIds,
      ].reverse();
      const planDefinitions = executionDefinitionIds.map((definitionId) =>
        definitionsById.get(definitionId)
      ) as readonly AnyRollbackMigrationDefinition[];
      const executionPolicy = yield* resolveDefinitionExecutionPolicy(
        planDefinitions,
        input.execution
      );
      const target = Option.getOrUndefined(targetOption);

      return {
        kind: "rollback",
        requestedDefinitionIds: selection.requestedDefinitionIds,
        includedDefinitionIds: planDetails.includedDefinitionIdsInRegistryOrder,
        executionDefinitionIds,
        executionPolicy,
        optionalDependencyEdges: planDetails.optionalDependencyEdges,
        definitions: planDefinitions,
        ...(target === undefined ? {} : { target }),
        notices: selection.notices,
        withDependencies: selection.withDependencies,
      };
    });
  }

  run(
    input: MigrationDefinitionRegistryRunInput
  ): Effect.Effect<
    MigrationRunSummary,
    | MigrationDefinitionRegistryRunError
    | RunRequestSourceLayerError<Definitions>,
    RunRequestSourceRequirements<Definitions>
  > {
    return Effect.flatMap(this.planRun(input), (plan) =>
      runMigrationsWithEncodedRunMode<Definitions>(
        plan.target === undefined
          ? {
              definitions: plan.definitions as Definitions,
              ...(input.execution === undefined
                ? {}
                : { execution: input.execution }),
              ...(input.mode === undefined ? {} : { mode: input.mode }),
              ...(input.update === undefined ? {} : { update: input.update }),
            }
          : {
              definitions: plan.definitions as Definitions,
              ...(input.execution === undefined
                ? {}
                : { execution: input.execution }),
              mode: {
                kind: "item" as const,
                encodedSourceIdentity: plan.target.sourceIdentities[0],
              },
            }
      )
    );
  }

  rollback(
    input: MigrationDefinitionRegistryRollbackInput
  ): Effect.Effect<
    RollbackRunSummary,
    MigrationDefinitionRegistryRollbackError
  > {
    const definitions = this
      .#definitions as unknown as AnyRollbackMigrationDefinitions;

    return Effect.flatMap(this.planRollback(input), (plan) =>
      rollbackMigrationsWithEncodedSourceIdentities({
        definitions,
        definitionIds: [...plan.executionDefinitionIds].reverse(),
        ...(input.execution === undefined
          ? {}
          : { execution: input.execution }),
        ...(plan.target === undefined
          ? {}
          : { encodedSourceIdentities: plan.target.sourceIdentities }),
      })
    );
  }

  status(
    input: MigrationDefinitionRegistryDurableStatusInput
  ): Effect.Effect<
    MigrationDefinitionRegistryStatusReport,
    MigrationDefinitionRegistryStatusError,
    never
  >;
  // biome-ignore lint/style/useUnifiedTypeSignatures: overloads preserve precise source-scan requirements.
  status(
    input: MigrationDefinitionRegistrySourceScanStatusInput
  ): Effect.Effect<
    MigrationDefinitionRegistryStatusReport,
    | MigrationDefinitionRegistryStatusError
    | RunRequestSourceLayerError<Definitions>,
    RunRequestSourceRequirements<Definitions>
  >;
  status(
    input: MigrationDefinitionRegistryStatusInput
  ): Effect.Effect<
    MigrationDefinitionRegistryStatusReport,
    | MigrationDefinitionRegistryStatusError
    | RunRequestSourceLayerError<Definitions>,
    RunRequestSourceRequirements<Definitions>
  >;
  status(
    input:
      | MigrationDefinitionRegistryDurableStatusInput
      | MigrationDefinitionRegistrySourceScanStatusInput
      | MigrationDefinitionRegistryStatusInput
  ): MigrationDefinitionRegistryStatusImplementationEffect {
    const definitions = this.#definitions;
    const definitionsById = this.#definitionsById;

    return Effect.gen(function* () {
      const selection = yield* resolveSelectionInput(
        definitions,
        definitionsById,
        input
      );
      const includedDefinitionIds = yield* resolveIncludedDefinitionIds(
        definitionsById,
        selection
      );
      const planDetails = resolveDefinitionPlanDetails(
        definitions,
        definitionsById,
        includedDefinitionIds,
        selection.notices
      );
      const includedDefinitionIdSet = new Set(
        planDetails.includedDefinitionIdsInRegistryOrder
      );
      const statusDefinitions = definitions.filter((definition) =>
        includedDefinitionIdSet.has(definition.id)
      );
      const report = yield* getMigrationStatuses({
        definitions: statusDefinitions,
        ...(input.concurrency === undefined
          ? {}
          : { concurrency: input.concurrency }),
        ...(input.scanSource === undefined
          ? {}
          : { scanSource: input.scanSource }),
      });

      return {
        ...report,
        includedDefinitionIds: planDetails.includedDefinitionIdsInRegistryOrder,
        notices: selection.notices,
        requestedDefinitionIds: selection.requestedDefinitionIds,
      };
    }) as MigrationDefinitionRegistryStatusImplementationEffect;
  }

  require(
    definitionId: MigrationDefinitionIdInput
  ): Effect.Effect<
    AnyMigrationDefinition,
    MigrationDefinitionRegistryLookupError
  > {
    const id = toMigrationDefinitionId(definitionId);

    return Option.match(this.get(id), {
      onNone: () =>
        Effect.fail(
          new MigrationDefinitionRegistryLookupError({
            definitionId: id,
            message: "Migration Definition was not found in the registry",
          })
        ),
      onSome: (definition) => Effect.succeed(definition),
    });
  }
}
