import { Effect, Layer, Schema } from "effect";
import {
  type ExecutionStartResult,
  MigrationDefinition,
  MigrationDefinitionRegistry,
  MigrationExecutable,
  type MigrationExecutableProgressCheckpoint,
  MigrationProgress,
  type MigrationRunSummary,
  type MigrationRunTerminalResult,
  MigrationStore,
  type MigrationStoreError,
  SourceIdentity,
} from "migrate-sdk";
import { defineMigrationCliConfig } from "migrate-sdk/cli";
import { InMemorySource } from "migrate-sdk/sources/in-memory";
import { InMemoryMigrationStore } from "migrate-sdk/stores/in-memory";

const Content = Schema.Struct({ title: Schema.String });
const ContentIdentity = SourceIdentity.make({
  id: "live-progress-content@v1",
  schema: SourceIdentity.key("id", Schema.NonEmptyString),
});
const PrerequisiteIdentity = SourceIdentity.make({
  id: "live-progress-prerequisite@v1",
  schema: SourceIdentity.key("id", Schema.NonEmptyString),
});

const makeDefinition = () =>
  MigrationDefinition.make({
    id: "live-progress",
    process: () => Effect.sleep("250 millis"),
    source: InMemorySource.make({
      batchSize: 1,
      identity: ContentIdentity,
      items: [
        { identityKey: "item-1", item: { title: "One" }, version: "v1" },
        { identityKey: "item-2", item: { title: "Two" }, version: "v1" },
        {
          identityKey: "item-3",
          item: { title: "Three" },
          version: "v1",
        },
        { identityKey: "item-4", item: { title: "Four" }, version: "v1" },
      ],
      sourceSchema: Content,
    }),
    store: InMemoryMigrationStore.layer(),
  });

export const liveProgressProviderObservations: string[] = [];

interface DetachedRun {
  readonly checkpoints: MigrationExecutableProgressCheckpoint[];
  readonly listeners: Set<
    (checkpoint: MigrationExecutableProgressCheckpoint) => void
  >;
  readonly wait: Effect.Effect<MigrationRunTerminalResult<MigrationRunSummary>>;
}

const detachedRuns = new Map<string, DetachedRun>();

const makeDetachedExecutableLayer = (observationFails: boolean) =>
  Layer.succeed(MigrationExecutable, {
    startRollback: (plan) =>
      MigrationExecutable.inlineService.startRollback(plan).pipe(
        Effect.map((result) =>
          result.kind === "started"
            ? {
                execution: {
                  adapter: "test-detached",
                  executionId: `detached-${result.runId}`,
                },
                kind: "started" as const,
                runId: result.runId,
              }
            : result
        )
      ),
    startRun: (plan) => {
      const checkpoints: MigrationExecutableProgressCheckpoint[] = [];
      const listeners = new Set<
        (checkpoint: MigrationExecutableProgressCheckpoint) => void
      >();
      const providerProgress = Layer.succeed(MigrationProgress, {
        emit: (event) =>
          Effect.sync(() => {
            if (event.kind !== "source-cursor-window-completed") {
              return;
            }

            const checkpoint = {
              counts: event.counts,
              definitionId: event.definitionId,
              kind: event.kind,
              runId: event.runId,
            } as const;
            checkpoints.push(checkpoint);
            for (const listener of listeners) {
              listener(checkpoint);
            }
          }),
      });

      return MigrationExecutable.inlineService.startRun(plan).pipe(
        Effect.provide(providerProgress),
        Effect.flatMap(
          (
            result
          ): Effect.Effect<
            ExecutionStartResult<MigrationRunSummary>,
            MigrationStoreError
          > => {
            if (result.kind !== "started" || result.handle === undefined) {
              return Effect.succeed(result);
            }

            const executionId = `detached-${result.runId}`;
            const execution = {
              adapter: "test-detached",
              executionId,
            };
            const definition = plan.definitions[0];

            if (definition === undefined) {
              return Effect.die(
                "Detached test execution requires a definition"
              );
            }

            detachedRuns.set(executionId, {
              checkpoints,
              listeners,
              wait: result.handle.wait,
            });
            Effect.runFork(
              result.handle.wait.pipe(
                Effect.ensuring(
                  Effect.sync(() => {
                    detachedRuns.delete(executionId);
                  })
                )
              )
            );

            return MigrationStore.pipe(
              Effect.flatMap((migrationStore) =>
                migrationStore.attachRunExecution(
                  result.runId,
                  plan.executionDefinitionIds,
                  execution
                )
              ),
              Effect.provide(definition.store),
              Effect.as({
                execution,
                kind: "started" as const,
                runId: result.runId,
              })
            );
          }
        )
      );
    },
    waitForExecution: (execution, options) =>
      Effect.gen(function* () {
        liveProgressProviderObservations.push(execution.executionId);

        if (observationFails) {
          return yield* Effect.fail({ _tag: "TestProviderObservationError" });
        }

        const run = detachedRuns.get(execution.executionId);
        const context = yield* Effect.context();

        if (run === undefined) {
          return { kind: "failed" as const };
        }

        const publish = (checkpoint: MigrationExecutableProgressCheckpoint) => {
          if (options?.onProgressCheckpoint !== undefined) {
            Effect.runForkWith(context)(
              options.onProgressCheckpoint(checkpoint)
            );
          }
        };
        for (const checkpoint of run.checkpoints) {
          publish(checkpoint);
        }
        run.listeners.add(publish);

        const terminal = yield* run.wait.pipe(
          Effect.ensuring(
            Effect.sync(() => {
              run.listeners.delete(publish);
            })
          )
        );

        switch (terminal.kind) {
          case "cancelled":
            return { kind: "cancelled" as const };
          case "execution-failed":
            return { cause: terminal.cause, kind: "failed" as const };
          case "finished":
            return {
              kind: "succeeded" as const,
              summary: terminal.summary,
            };
          default: {
            const unhandled: never = terminal;
            return unhandled;
          }
        }
      }),
  });

export const makeLiveProgressConfig = (
  detached: boolean,
  observationFails = false
) => {
  const definition = makeDefinition();

  return defineMigrationCliConfig({
    ...(detached
      ? {
          executableLayer: makeDetachedExecutableLayer(observationFails),
        }
      : {}),
    registry: MigrationDefinitionRegistry.make({
      definitions: [definition],
    }),
  });
};

export const makeDependentLiveProgressConfig = () => {
  const store = InMemoryMigrationStore.layer();
  const prerequisite = MigrationDefinition.make({
    id: "live-progress-prerequisite",
    process: () => Effect.void,
    source: InMemorySource.make({
      batchSize: 1,
      identity: PrerequisiteIdentity,
      items: [
        {
          identityKey: "prerequisite",
          item: { title: "Prerequisite" },
          version: "v1",
        },
      ],
      sourceSchema: Content,
    }),
    store,
  });
  const definition = MigrationDefinition.make({
    dependencies: { required: [prerequisite.id] },
    id: "live-progress",
    process: () => Effect.sleep("250 millis"),
    source: InMemorySource.make({
      batchSize: 1,
      identity: ContentIdentity,
      items: [
        { identityKey: "item-1", item: { title: "One" }, version: "v1" },
        { identityKey: "item-2", item: { title: "Two" }, version: "v1" },
        {
          identityKey: "item-3",
          item: { title: "Three" },
          version: "v1",
        },
        { identityKey: "item-4", item: { title: "Four" }, version: "v1" },
      ],
      sourceSchema: Content,
    }),
    store,
  });

  return defineMigrationCliConfig({
    registry: MigrationDefinitionRegistry.make({
      definitions: [prerequisite, definition],
    }),
  });
};
