import {
  beginMigrationRunExecutionEnvelope,
  completeMigrationRunExecutionEnvelope,
  executeMigrationRollbackExecutionEnvelope,
  executeMigrationRunCursorWindow,
  failMigrationRunExecutionEnvelope,
} from "@migrate-sdk/workflow-sdk/steps";
import { Effect, Layer, Schema } from "effect";
import {
  MigrationDefinition,
  type MigrationDefinitionId,
  MigrationDefinitionRegistry,
  MigrationDefinitionRegistryCatalog,
  type MigrationRollbackExecutionEnvelopeType,
  MigrationRollbackExecutor,
  type MigrationRunCursorWindowState,
  type MigrationRunExecutionEnvelopeType,
  MigrationRunStepExecutor,
  type MigrationRunSummary,
  type RollbackRunSummary,
  SourceIdentity,
  toMigrationDefinitionId,
} from "migrate-sdk/core";
import { InMemorySourcePlugin } from "migrate-sdk/sources/in-memory";
import {
  InMemoryMigrationStore,
  type InMemoryMigrationStoreState,
} from "migrate-sdk/stores/in-memory";
import type {
  WorkflowSdkMigrationRunCursorWindowResult,
  WorkflowSdkMigrationRunCursorWindowState,
  WorkflowSdkMigrationRunEnvelope,
  WorkflowSdkMigrationRunSummary,
} from "../migration-execution-workflow.ts";
import type {
  WorkflowSdkMigrationRollbackEnvelope,
  WorkflowSdkMigrationRollbackSummary,
} from "../migration-rollback-workflow.ts";

const ArticleSource = Schema.Struct({
  title: Schema.String,
});

const ArticleSourceIdentity = SourceIdentity.make({
  id: "workflow-in-memory-article@v1",
  schema: SourceIdentity.key("id", Schema.NonEmptyString),
});

const articleDefinitionId = toMigrationDefinitionId("articles");
const sourceItems = Array.from({ length: 100 }, (_, index) => ({
  identityKey: `article-${String(index + 1).padStart(3, "0")}`,
  item: {
    title: `Article ${index + 1}`,
  },
  version: `source-version-${index + 1}`,
}));

const storeStateKey = "__migrateSdkWorkflowInMemoryStoreState";
const getStoreState = (): InMemoryMigrationStoreState => {
  const scope = globalThis as typeof globalThis & {
    [storeStateKey]?: InMemoryMigrationStoreState;
  };

  scope[storeStateKey] ??= InMemoryMigrationStore.makeState();

  return scope[storeStateKey];
};

const resetStoreState = (state: InMemoryMigrationStoreState) => {
  state.definitionLocks.clear();
  state.itemStates.clear();
  state.latestRunStates.clear();
  state.migrationContracts.clear();
  state.sourceCursorCommits.splice(0);
  state.sourceCursors.clear();
  state.nextLockNumber = 1;
  state.nextRunNumber = 1;
};

const storeState = getStoreState();
const storeLayer = InMemoryMigrationStore.layer(storeState);
const articles = MigrationDefinition.make({
  id: articleDefinitionId,
  process: () => Effect.void,
  rollback: () => undefined,
  source: InMemorySourcePlugin.make({
    batchSize: 50,
    identity: ArticleSourceIdentity,
    items: sourceItems,
    sourceSchema: ArticleSource,
  }),
  store: storeLayer,
});
const registry = MigrationDefinitionRegistry.make({
  definitions: [articles] as const,
  id: "workflow-in-memory-catalog",
});
const runtimeLayer = Layer.mergeAll(
  MigrationDefinitionRegistryCatalog.layer({
    registries: [registry],
  }),
  MigrationRollbackExecutor.layer,
  MigrationRunStepExecutor.defaultLayer
);

const runEffect = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    | MigrationDefinitionRegistryCatalog
    | MigrationRollbackExecutor
    | MigrationRunStepExecutor
  >
) => Effect.runPromise(effect.pipe(Effect.provide(runtimeLayer)));

interface WorkflowRetryMetadata {
  maxRetries: number;
}

const disableWorkflowRetries = <Step>(step: Step) => {
  (step as Step & WorkflowRetryMetadata).maxRetries = 0;
};

const toMigrationRunEnvelope = (
  envelope: WorkflowSdkMigrationRunEnvelope
): MigrationRunExecutionEnvelopeType =>
  envelope as unknown as MigrationRunExecutionEnvelopeType;

const toMigrationRollbackEnvelope = (
  envelope: WorkflowSdkMigrationRollbackEnvelope
): MigrationRollbackExecutionEnvelopeType =>
  envelope as unknown as MigrationRollbackExecutionEnvelopeType;

export async function beginMigrationRunStep(
  envelope: WorkflowSdkMigrationRunEnvelope
): Promise<unknown> {
  "use step";

  return await runEffect(
    beginMigrationRunExecutionEnvelope(toMigrationRunEnvelope(envelope))
  );
}

export async function executeMigrationRunCursorWindowStep(input: {
  readonly definitionId: string;
  readonly envelope: WorkflowSdkMigrationRunEnvelope;
  readonly runId: WorkflowSdkMigrationRunEnvelope["runId"];
  readonly state: WorkflowSdkMigrationRunCursorWindowState;
}): Promise<WorkflowSdkMigrationRunCursorWindowResult> {
  "use step";

  return (await runEffect(
    executeMigrationRunCursorWindow({
      definitionId: input.definitionId as MigrationDefinitionId,
      envelope: toMigrationRunEnvelope(input.envelope),
      runId: input.runId as MigrationRunExecutionEnvelopeType["runId"],
      state: input.state as MigrationRunCursorWindowState,
    })
  )) as WorkflowSdkMigrationRunCursorWindowResult;
}

export async function completeMigrationRunStep(input: {
  readonly definitions: WorkflowSdkMigrationRunSummary["definitions"];
  readonly envelope: WorkflowSdkMigrationRunEnvelope;
}): Promise<WorkflowSdkMigrationRunSummary> {
  "use step";

  return (await runEffect(
    completeMigrationRunExecutionEnvelope({
      definitions: input.definitions as MigrationRunSummary["definitions"],
      envelope: toMigrationRunEnvelope(input.envelope),
    })
  )) as WorkflowSdkMigrationRunSummary;
}

export async function failMigrationRunStep(input: {
  readonly envelope: WorkflowSdkMigrationRunEnvelope;
  readonly error: unknown;
}): Promise<void> {
  "use step";

  return await runEffect(
    failMigrationRunExecutionEnvelope({
      envelope: toMigrationRunEnvelope(input.envelope),
      error: input.error,
    })
  );
}

disableWorkflowRetries(beginMigrationRunStep);
disableWorkflowRetries(executeMigrationRunCursorWindowStep);
disableWorkflowRetries(completeMigrationRunStep);
disableWorkflowRetries(failMigrationRunStep);

export async function executeMigrationRollbackStep(
  envelope: WorkflowSdkMigrationRollbackEnvelope
): Promise<WorkflowSdkMigrationRollbackSummary> {
  "use step";

  return (await runEffect(
    executeMigrationRollbackExecutionEnvelope(
      toMigrationRollbackEnvelope(envelope)
    )
  )) as RollbackRunSummary as WorkflowSdkMigrationRollbackSummary;
}

disableWorkflowRetries(executeMigrationRollbackStep);

export async function inspectMigrationStoreStep(): Promise<{
  readonly definitionLockCount: number;
  readonly itemStateCount: number;
  readonly latestRunStatus: string | undefined;
  readonly migratedItemStateCount: number;
  readonly sourceCursorCommitCount: number;
}> {
  "use step";

  const itemStates = Array.from(storeState.itemStates.values());

  return await Promise.resolve({
    definitionLockCount: storeState.definitionLocks.size,
    itemStateCount: itemStates.length,
    latestRunStatus:
      storeState.latestRunStates.get(articleDefinitionId)?.status,
    migratedItemStateCount: itemStates.filter(
      (itemState) => itemState.status === "migrated"
    ).length,
    sourceCursorCommitCount: storeState.sourceCursorCommits.length,
  });
}

export const inMemoryMigrationTestRegistry = registry;
export const inMemoryMigrationTestStoreState = storeState;
export const resetInMemoryMigrationTestState = () =>
  resetStoreState(storeState);
