import { Effect } from "effect";
import type { MigrationExecutionOptions } from "../domain/execution.ts";
import type {
  MigrationDefinitionIdInput,
  SourceIdentitySnapshotKey,
} from "../domain/ids.ts";
import type {
  MigrationDefinitionRegistryConstructionError,
  MigrationDefinitionRegistryRollbackInput,
  MigrationDefinitionRegistryRunInput,
} from "../domain/registry.ts";
import { MigrationDefinitionRegistry } from "../domain/registry.ts";
import type {
  AnyRollbackMigrationDefinition,
  RollbackMigrationDefinitionSourceIdentityKey,
} from "../domain/rollback.ts";
import type {
  AnyMigrationDefinition,
  ExecutionStartResult,
  MigrationDefinitionSourceIdentityKey,
} from "../domain/run.ts";
import type { RunModeInput } from "../domain/run-mode.ts";
import { MigrationExecution } from "../services/migration-execution.ts";

type InlineRegistrySelectionInput =
  | {
      readonly all?: true;
      readonly definitionIds?: undefined;
      readonly withDependencies?: boolean;
    }
  | {
      readonly all?: undefined;
      readonly definitionIds: readonly MigrationDefinitionIdInput[];
      readonly withDependencies?: boolean;
    };

export type InlineRegistryRunInput<
  Definitions extends
    readonly AnyMigrationDefinition[] = readonly AnyMigrationDefinition[],
> = InlineRegistrySelectionInput & {
  readonly definitions: Definitions;
  readonly execution?: MigrationExecutionOptions;
  readonly mode?: RunModeInput<
    MigrationDefinitionSourceIdentityKey<Definitions[number]>
  >;
  readonly sourceIdentities?: readonly string[];
  readonly update?: boolean;
};

export type InlineRegistryRollbackInput<
  Definitions extends
    readonly AnyRollbackMigrationDefinition[] = readonly AnyRollbackMigrationDefinition[],
> = InlineRegistrySelectionInput & {
  readonly definitions: Definitions;
  readonly execution?: MigrationExecutionOptions;
  readonly sourceIdentities?: readonly string[];
  readonly sourceIdentityKeys?: readonly RollbackMigrationDefinitionSourceIdentityKey<
    Definitions[number]
  >[];
};

const sourceIdentityKeyToText = (key: SourceIdentitySnapshotKey): string =>
  Array.isArray(key)
    ? key.map((part) => encodeURIComponent(String(part))).join(":")
    : String(key);

const completed = <Summary, Error, Requirements>(
  effect: Effect.Effect<ExecutionStartResult<Summary>, Error, Requirements>
): Effect.Effect<Summary, Error, Requirements> =>
  Effect.flatMap(effect, (result) =>
    result.kind === "completed"
      ? Effect.succeed(result.summary)
      : Effect.die("Inline registry execution unexpectedly started")
  );

const selectionInput = (
  input: InlineRegistrySelectionInput,
  definitions: readonly AnyMigrationDefinition[],
  inferSingleDefinitionId: boolean
): MigrationDefinitionRegistryRunInput => {
  const definitionIds =
    input.definitionIds ??
    (inferSingleDefinitionId && definitions.length === 1
      ? [definitions[0]?.id].filter((id) => id !== undefined)
      : undefined);

  return definitionIds === undefined
    ? {
        all: true,
        ...(input.withDependencies === undefined
          ? {}
          : { withDependencies: input.withDependencies }),
      }
    : {
        definitionIds: definitionIds as readonly [
          MigrationDefinitionIdInput,
          ...MigrationDefinitionIdInput[],
        ],
        ...(input.withDependencies === undefined
          ? {}
          : { withDependencies: input.withDependencies }),
      };
};

const runRequestInput = <Definitions extends readonly AnyMigrationDefinition[]>(
  input: InlineRegistryRunInput<Definitions>
): MigrationDefinitionRegistryRunInput => {
  const targetsSourceIdentities =
    input.sourceIdentities !== undefined || input.mode?.kind === "item";
  const selection = selectionInput(
    input,
    input.definitions,
    targetsSourceIdentities
  );

  if (input.mode?.kind === "item") {
    return {
      ...selection,
      ...(input.execution === undefined ? {} : { execution: input.execution }),
      sourceIdentities: [sourceIdentityKeyToText(input.mode.sourceIdentityKey)],
      ...(input.update === undefined ? {} : { update: input.update }),
    };
  }

  return {
    ...selection,
    ...(input.execution === undefined ? {} : { execution: input.execution }),
    ...(input.mode === undefined ? {} : { mode: input.mode }),
    ...(input.sourceIdentities === undefined
      ? {}
      : { sourceIdentities: input.sourceIdentities }),
    ...(input.update === undefined ? {} : { update: input.update }),
  };
};

const rollbackRequestInput = <
  Definitions extends readonly AnyRollbackMigrationDefinition[],
>(
  input: InlineRegistryRollbackInput<Definitions>
): MigrationDefinitionRegistryRollbackInput => {
  const sourceIdentities =
    input.sourceIdentities ??
    input.sourceIdentityKeys?.map((sourceIdentityKey) =>
      sourceIdentityKeyToText(sourceIdentityKey)
    );
  const selection = selectionInput(
    input,
    input.definitions,
    sourceIdentities !== undefined
  );

  return {
    ...selection,
    ...(input.execution === undefined ? {} : { execution: input.execution }),
    ...(sourceIdentities === undefined ? {} : { sourceIdentities }),
  };
};

export const runInlineRegistry = <
  const Definitions extends readonly AnyMigrationDefinition[],
>(
  input: InlineRegistryRunInput<Definitions>
) =>
  Effect.flatMap(
    Effect.try({
      try: () =>
        MigrationDefinitionRegistry.make({
          definitions: input.definitions,
        }),
      catch: (cause) => cause as MigrationDefinitionRegistryConstructionError,
    }),
    (registry) => {
      const execution = MigrationExecution.make({ registry });

      return completed(execution.run(runRequestInput(input)));
    }
  );

export const runInlineDefinition = <
  const Definition extends AnyMigrationDefinition,
>(
  definition: Definition,
  options: Pick<InlineRegistryRunInput<readonly [Definition]>, "execution"> = {}
) =>
  runInlineRegistry({
    definitions: [definition] as const,
    ...options,
  });

export const rollbackInlineRegistry = <
  const Definitions extends readonly AnyRollbackMigrationDefinition[],
>(
  input: InlineRegistryRollbackInput<Definitions>
) =>
  Effect.flatMap(
    Effect.try({
      try: () =>
        MigrationDefinitionRegistry.make({
          definitions: input.definitions,
        }),
      catch: (cause) => cause as MigrationDefinitionRegistryConstructionError,
    }),
    (registry) => {
      const execution = MigrationExecution.make({ registry });

      return completed(execution.rollback(rollbackRequestInput(input)));
    }
  );

export const rollbackInlineDefinition = <
  const Definition extends AnyRollbackMigrationDefinition,
>(
  definition: Definition,
  options: Pick<
    InlineRegistryRollbackInput<readonly [Definition]>,
    "execution" | "sourceIdentities" | "sourceIdentityKeys"
  > = {}
) =>
  rollbackInlineRegistry({
    definitions: [definition] as const,
    ...options,
  });
