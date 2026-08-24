import {
  beginMigrationRunExecutionEnvelope,
  completeMigrationRunExecutionEnvelope,
  executeMigrationRollbackExecutionEnvelope,
  executeMigrationRunCursorWindow,
  executeMigrationRunRollbackOrphansPage,
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
  type MigrationRunRollbackOrphansState,
  MigrationRunStepExecutor,
  type MigrationRunSummary,
  type RollbackRunSummary,
  SourceIdentity,
  toMigrationDefinitionId,
} from "migrate-sdk/core";
import { InMemorySource } from "migrate-sdk/sources/in-memory";
import {
  InMemoryMigrationStore,
  type InMemoryMigrationStoreState,
} from "migrate-sdk/stores/in-memory";
import type {
  WorkflowSdkMigrationRunCursorWindowResult,
  WorkflowSdkMigrationRunCursorWindowState,
  WorkflowSdkMigrationRunEnvelope,
  WorkflowSdkMigrationRunRollbackOrphansPageResult,
  WorkflowSdkMigrationRunRollbackOrphansState,
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
const makeSourceItems = (count = 100) =>
  Array.from({ length: count }, (_, index) => ({
    identityKey: `article-${String(index + 1).padStart(3, "0")}`,
    item: {
      title: `Article ${index + 1}`,
    },
    version: `source-version-${index + 1}`,
  }));
type ArticleSourceItem = ReturnType<typeof makeSourceItems>[number];
const sourceItemsKey = "__migrateSdkWorkflowInMemorySourceItems";
const getSourceItems = (): ArticleSourceItem[] => {
  const scope = globalThis as typeof globalThis & {
    [sourceItemsKey]?: ArticleSourceItem[];
  };

  scope[sourceItemsKey] ??= makeSourceItems();

  return scope[sourceItemsKey];
};
const sourceItems = getSourceItems();
const rollbackCallsKey = "__migrateSdkWorkflowInMemoryRollbackCalls";
const getRollbackCalls = (): string[] => {
  const scope = globalThis as typeof globalThis & {
    [rollbackCallsKey]?: string[];
  };

  scope[rollbackCallsKey] ??= [];

  return scope[rollbackCallsKey];
};
const rollbackCalls = getRollbackCalls();
const processConcurrencyKey = "__migrateSdkWorkflowInMemoryProcessConcurrency";
interface ProcessConcurrencyState {
  active: number;
  max: number;
}
const getProcessConcurrencyState = (): ProcessConcurrencyState => {
  const scope = globalThis as typeof globalThis & {
    [processConcurrencyKey]?: ProcessConcurrencyState;
  };

  scope[processConcurrencyKey] ??= { active: 0, max: 0 };

  return scope[processConcurrencyKey];
};
const processConcurrencyState = getProcessConcurrencyState();

type InterruptionPoint =
  | "after-source-window"
  | "before-rollback-orphans"
  | "after-rollback-orphans-page";

interface InterruptionState {
  point: InterruptionPoint | undefined;
}

const interruptionStateKey = "__migrateSdkWorkflowInMemoryInterruptionState";
const getInterruptionState = (): InterruptionState => {
  const scope = globalThis as typeof globalThis & {
    [interruptionStateKey]?: InterruptionState;
  };

  scope[interruptionStateKey] ??= { point: undefined };

  return scope[interruptionStateKey];
};
const interruptionState = getInterruptionState();

const interruptAt = (point: InterruptionPoint) => {
  if (interruptionState.point !== point) {
    return;
  }

  interruptionState.point = undefined;
  throw new Error(`Interrupted in-memory workflow ${point}`);
};

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
  processConcurrencyState.active = 0;
  processConcurrencyState.max = 0;
};

const storeState = getStoreState();
const storeLayer = InMemoryMigrationStore.layer(storeState);
const articles = MigrationDefinition.make({
  id: articleDefinitionId,
  process: () =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        processConcurrencyState.active += 1;
        processConcurrencyState.max = Math.max(
          processConcurrencyState.max,
          processConcurrencyState.active
        );
      }),
      () => Effect.sleep("5 millis"),
      () =>
        Effect.sync(() => {
          processConcurrencyState.active -= 1;
        })
    ),
  rollback: (state) => {
    rollbackCalls.push(state.sourceIdentity.encoded);
  },
  source: InMemorySource.make({
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
): Promise<{ readonly rollbackOrphans: boolean }> {
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

  const result = (await runEffect(
    executeMigrationRunCursorWindow({
      definitionId: input.definitionId as MigrationDefinitionId,
      envelope: toMigrationRunEnvelope(input.envelope),
      runId: input.runId as MigrationRunExecutionEnvelopeType["runId"],
      state: input.state as MigrationRunCursorWindowState,
    })
  )) as WorkflowSdkMigrationRunCursorWindowResult;

  interruptAt("after-source-window");

  return result;
}

export async function executeMigrationRunRollbackOrphansPageStep(input: {
  readonly definitionId: string;
  readonly envelope: WorkflowSdkMigrationRunEnvelope;
  readonly runId: WorkflowSdkMigrationRunEnvelope["runId"];
  readonly state: WorkflowSdkMigrationRunRollbackOrphansState;
}): Promise<WorkflowSdkMigrationRunRollbackOrphansPageResult> {
  "use step";

  interruptAt("before-rollback-orphans");

  const result = (await runEffect(
    executeMigrationRunRollbackOrphansPage({
      definitionId: input.definitionId as MigrationDefinitionId,
      envelope: toMigrationRunEnvelope(input.envelope),
      runId: input.runId as MigrationRunExecutionEnvelopeType["runId"],
      state: input.state as MigrationRunRollbackOrphansState,
    })
  )) as WorkflowSdkMigrationRunRollbackOrphansPageResult;

  interruptAt("after-rollback-orphans-page");

  return result;
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
  readonly definitions: WorkflowSdkMigrationRunSummary["definitions"];
  readonly envelope: WorkflowSdkMigrationRunEnvelope;
  readonly error: unknown;
  readonly failedDefinitionId?: string;
}): Promise<void> {
  "use step";

  return await runEffect(
    failMigrationRunExecutionEnvelope({
      definitions: input.definitions as MigrationRunSummary["definitions"],
      envelope: toMigrationRunEnvelope(input.envelope),
      error: input.error,
      ...(input.failedDefinitionId === undefined
        ? {}
        : {
            failedDefinitionId: toMigrationDefinitionId(
              input.failedDefinitionId
            ),
          }),
    })
  );
}

disableWorkflowRetries(beginMigrationRunStep);
disableWorkflowRetries(executeMigrationRunCursorWindowStep);
disableWorkflowRetries(executeMigrationRunRollbackOrphansPageStep);
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
  readonly rollbackCallCount: number;
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
    rollbackCallCount: rollbackCalls.length,
    sourceCursorCommitCount: storeState.sourceCursorCommits.length,
  });
}

export const inMemoryMigrationTestRegistry = registry;
export const inMemoryMigrationTestStoreState = storeState;
export const inMemoryMigrationTestProcessConcurrency = () =>
  processConcurrencyState.max;
export const removeInMemoryMigrationTestSourceItem = (identity: string) => {
  const index = sourceItems.findIndex((item) => item.identityKey === identity);
  if (index >= 0) {
    sourceItems.splice(index, 1);
  }
};
export const setInMemoryMigrationTestSourceItemCount = (count: number) => {
  sourceItems.splice(0, sourceItems.length, ...makeSourceItems(count));
};
export const interruptInMemoryMigrationTestWorkflowAt = (
  point: InterruptionPoint
) => {
  interruptionState.point = point;
};
export const resetInMemoryMigrationTestState = () => {
  sourceItems.splice(0, sourceItems.length, ...makeSourceItems());
  rollbackCalls.splice(0);
  interruptionState.point = undefined;
  resetStoreState(storeState);
};
