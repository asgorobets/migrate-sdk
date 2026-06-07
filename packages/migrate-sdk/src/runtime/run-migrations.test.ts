import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Schedule, Schema } from "effect";
import {
  type InMemoryDestinationEntry,
  type InMemoryDestinationExecute,
  type InMemoryDestinationExecution,
  type InMemoryDestinationInspection,
  InMemoryDestinationTesting,
} from "migrate-sdk/destinations/in-memory/testing";
import { expectTypeOf } from "vitest";
import {
  type DestinationCommand,
  type DestinationCommandContext,
  type DestinationCommandResultInput,
  type DestinationCommandSchema,
  DestinationPlugin,
  DestinationPluginError,
  defineDestinationCommand,
  defineDestinationCommandGroup,
  defineDestinationPlugin,
  defineMigration,
  defineSourcePlugin,
  InMemoryDestinationPlugin,
  type InMemoryDestinationTransientFailures,
  type InMemoryEntryCommand,
  InMemoryMigrationStore,
  InMemorySourceCursor,
  type InMemorySourceOptions,
  InMemorySourcePlugin,
  MigrationDefinitionLock,
  MigrationItemState,
  MigrationReferenceLookup,
  MigrationRunState,
  type MigrationRunSummary,
  MigrationStore,
  MigrationStoreError,
  makeDestinationCommandResult,
  type RunMigrationError,
  runMigration,
  runMigrations,
  SourcePlugin,
  SourcePluginError,
  type SourcePluginImplementation,
  skipItem,
  toDestinationIdentity,
  toDestinationVersion,
  toEncodedSourceCursor,
  toMigrationDefinitionId,
  toMigrationDefinitionLockToken,
  toMigrationRunId,
  toSourceIdentity,
  toSourceVersion,
} from "../index.ts";

const UpsertEntryCommand = Schema.Struct({
  kind: Schema.Literal("UpsertEntry"),
  contentType: Schema.String,
  fields: Schema.Record(Schema.String, Schema.Unknown),
});

type UpsertEntryCommand = typeof UpsertEntryCommand.Type;

const PublishEntryCommand = Schema.Struct({
  kind: Schema.Literal("PublishEntry"),
  contentType: Schema.String,
});

const EntryCommand = Schema.Union([UpsertEntryCommand, PublishEntryCommand]);

const upsertEntryCommand = defineDestinationCommand("UpsertEntry", {
  identity: true,
  schema: UpsertEntryCommand,
});

const publishEntryCommand = defineDestinationCommand("PublishEntry", {
  identity: false,
  schema: PublishEntryCommand,
});

const identityPublishEntryCommand = defineDestinationCommand("PublishEntry", {
  identity: true,
  schema: PublishEntryCommand,
});

const UpsertEntryPlugin = defineDestinationPlugin("test-upsert-entry").addGroup(
  defineDestinationCommandGroup("entries").topLevel().add(upsertEntryCommand)
);

const EntryPlugin = defineDestinationPlugin("test-entry").addGroup(
  defineDestinationCommandGroup("entries")
    .topLevel()
    .add(upsertEntryCommand, publishEntryCommand)
);

const MultiIdentityEntryPlugin = defineDestinationPlugin(
  "test-multi-identity-entry"
).addGroup(
  defineDestinationCommandGroup("entries")
    .topLevel()
    .add(upsertEntryCommand, identityPublishEntryCommand)
);

expectTypeOf<DestinationCommandSchema<UpsertEntryCommand>>().toEqualTypeOf<
  Schema.Codec<UpsertEntryCommand, UpsertEntryCommand, never, never>
>();

type EntryCommand = typeof EntryCommand.Type;

const ArticleSource = Schema.Struct({
  title: Schema.String,
  publish: Schema.optional(Schema.Boolean),
});
type ArticleSource = typeof ArticleSource.Type;

const ArticleEntryFields = Schema.Struct({
  title: Schema.String,
});
const ArticleStatsEntryFields = Schema.Struct({
  title: Schema.String,
  views: Schema.Number,
});
const DecodingArticleEntryFields = Schema.Struct({
  views: Schema.NumberFromString,
});
interface ArticleEntryCommands {
  readonly publishEntry: true;
  readonly upsertEntry: { readonly fields: typeof ArticleEntryFields };
}
interface ArticleStatsEntryCommands {
  readonly publishEntry: true;
  readonly upsertEntry: { readonly fields: typeof ArticleStatsEntryFields };
}
type ArticleEntryCommand = InMemoryEntryCommand<
  "article",
  ArticleEntryCommands
>;
type ArticleStatsEntryCommand = InMemoryEntryCommand<
  "article",
  ArticleStatsEntryCommands
>;
const ArticleEntryDestinationForTypes = InMemoryDestinationPlugin.makeEntries({
  contentType: "article",
  commands: {
    publishEntry: true,
    upsertEntry: { fields: ArticleEntryFields },
  },
});
ArticleEntryDestinationForTypes.commands.upsertEntry({
  title: "Typed article",
});
ArticleEntryDestinationForTypes.commands.publishEntry();
// @ts-expect-error command factories close over the configured content type.
ArticleEntryDestinationForTypes.commands.publishEntry("offer");
ArticleEntryDestinationForTypes.commands.upsertEntry({
  // @ts-expect-error upsert fields must match the configured content type schema.
  headline: "Wrong field",
});
InMemoryDestinationPlugin.makeEntries({
  contentType: "article",
  commands: {
    upsertEntry: {
      // @ts-expect-error destination entry schemas validate pipeline values without decoding.
      fields: DecodingArticleEntryFields,
    },
  },
});

const ArticleStatsSource = Schema.Struct({
  title: Schema.Trim,
  views: Schema.NumberFromString,
});
type ArticleStatsSource = typeof ArticleStatsSource.Type;

const ManyFieldSource = Schema.Struct({
  a: Schema.String,
  b: Schema.String,
  c: Schema.String,
  d: Schema.String,
  e: Schema.String,
  f: Schema.String,
});
type ManyFieldSource = typeof ManyFieldSource.Type;

const asArticleSource = (item: unknown): ArticleSource => item as ArticleSource;

const asArticleStatsSource = (item: unknown): ArticleStatsSource =>
  item as ArticleStatsSource;

const asManyFieldSource = (item: unknown): ManyFieldSource =>
  item as ManyFieldSource;

const makeTestInMemorySource = <A>(
  options: Omit<InMemorySourceOptions<A>, "sourceSchema"> &
    Partial<Pick<InMemorySourceOptions<A>, "sourceSchema">>
) =>
  InMemorySourcePlugin.make({
    sourceSchema: Schema.Unknown as Schema.Codec<A, unknown, never, never>,
    ...options,
  });

interface TestDestinationState<C extends DestinationCommand> {
  readonly bind: (inspection: InMemoryDestinationInspection<C>) => void;
  readonly entries: ReadonlyMap<string, InMemoryDestinationEntry>;
  readonly executeAttempts: number;
  readonly executions: readonly InMemoryDestinationExecution<C>[];
  readonly record: (execution: InMemoryDestinationExecution<C>) => void;
}

const makeTestDestinationState = <
  C extends DestinationCommand,
>(): TestDestinationState<C> => {
  const inspections: InMemoryDestinationInspection<C>[] = [];
  const executions: InMemoryDestinationExecution<C>[] = [];
  const boundInspections = () => {
    if (inspections.length === 0) {
      throw new Error("Destination fixture was not bound to the test state");
    }

    return inspections;
  };

  return {
    get entries() {
      const entries = new Map<string, InMemoryDestinationEntry>();

      for (const inspection of boundInspections()) {
        for (const [key, entry] of inspection.entries()) {
          entries.set(key, entry);
        }
      }

      return entries;
    },
    get executeAttempts() {
      return boundInspections().reduce(
        (attempts, inspection) => attempts + inspection.executeAttempts(),
        0
      );
    },
    get executions() {
      return executions.length === 0
        ? boundInspections().flatMap((inspection) => [
            ...inspection.executions(),
          ])
        : executions;
    },
    bind: (inspection) => {
      inspections.push(inspection);
    },
    record: (execution) => {
      executions.push(execution);
    },
  };
};

interface TestDestinationOptions<C extends DestinationCommand> {
  readonly execute?: InMemoryDestinationExecute<C>;
  readonly state?: TestDestinationState<C>;
  readonly transientFailures?: InMemoryDestinationTransientFailures;
}

const trackDestinationExecute =
  <C extends DestinationCommand>(
    state: TestDestinationState<C> | undefined,
    execute: InMemoryDestinationExecute<C>
  ): InMemoryDestinationExecute<C> =>
  (command, context) => {
    const resultInput = execute(command, context);
    const recordExecution = (input: DestinationCommandResultInput) => {
      state?.record({
        command,
        context,
        result: makeDestinationCommandResult(input),
      });

      return input;
    };

    return Effect.isEffect(resultInput)
      ? resultInput.pipe(Effect.map(recordExecution))
      : recordExecution(resultInput);
  };

const executeTestUpsertEntryCommand = (
  _command: UpsertEntryCommand,
  context: DestinationCommandContext
): DestinationCommandResultInput => ({
  destinationIdentity: `entry-${context.sourceIdentity}`,
  destinationVersion: "destination-version-1",
});

const executeTestEntryCommand = (
  command: EntryCommand,
  context: DestinationCommandContext
): DestinationCommandResultInput =>
  command.kind === "UpsertEntry"
    ? executeTestUpsertEntryCommand(command, context)
    : {};

const makeTestUpsertEntryDestination = (
  options: TestDestinationOptions<UpsertEntryCommand> = {}
) => {
  const fixture = InMemoryDestinationTesting.fixture({
    command: upsertEntryCommand,
    execute: trackDestinationExecute(
      options.state,
      options.execute ?? executeTestUpsertEntryCommand
    ),
    ...(options.transientFailures === undefined
      ? {}
      : { transientFailures: options.transientFailures }),
  });
  options.state?.bind(fixture);

  return fixture.destination;
};

const makeTestEntryDestination = (
  options: TestDestinationOptions<EntryCommand> = {}
) => makeTestImplementedEntryDestination(EntryPlugin, options);

const makeTestMultiIdentityEntryDestination = (
  options: TestDestinationOptions<EntryCommand> = {}
) => makeTestImplementedEntryDestination(MultiIdentityEntryPlugin, options);

const makeTestImplementedEntryDestination = (
  plugin: typeof EntryPlugin | typeof MultiIdentityEntryPlugin,
  options: TestDestinationOptions<EntryCommand>
) => {
  let executeAttempts = 0;
  let remainingExecuteFailures = options.transientFailures?.execute ?? 0;
  const execute = trackDestinationExecute(
    options.state,
    options.execute ?? executeTestEntryCommand
  );
  const executeWithState = (
    command: EntryCommand,
    context: DestinationCommandContext
  ): Effect.Effect<DestinationCommandResultInput, DestinationPluginError> =>
    Effect.gen(function* () {
      if (remainingExecuteFailures > 0) {
        remainingExecuteFailures -= 1;
        return yield* new DestinationPluginError({
          message: "In-memory destination execute failed transiently",
        });
      }

      const resultInput = execute(command, context);

      return yield* Effect.isEffect(resultInput)
        ? resultInput
        : Effect.succeed(resultInput);
    });
  const implementedPlugin = (plugin as typeof EntryPlugin).implement(
    (handlers) =>
      handlers
        .handle("UpsertEntry", ({ command, context }) =>
          executeWithState(command, context)
        )
        .handle("PublishEntry", ({ command, context }) =>
          executeWithState(command, context)
        )
  );
  const inspection: InMemoryDestinationInspection<EntryCommand> = {
    entries: () => new Map(),
    entry: () => undefined,
    executeAttempts: () => executeAttempts,
    executions: () => [],
  };
  options.state?.bind(inspection);

  return {
    commandDefinitions: implementedPlugin.commandDefinitions,
    commands: implementedPlugin.commands,
    layer: Layer.effect(
      DestinationPlugin,
      Effect.gen(function* () {
        const destinationPlugin = yield* DestinationPlugin;

        return {
          execute: Effect.fn("TestEntryDestination.execute")(
            (command, context) =>
              Effect.sync(() => {
                executeAttempts += 1;
              }).pipe(
                Effect.flatMap(() =>
                  destinationPlugin.execute(command, context)
                )
              )
          ),
        };
      })
    ).pipe(Layer.provide(implementedPlugin.layer)),
  };
};

interface PipelineTestError {
  readonly _tag: "PipelineTestError";
}

interface OtherPipelineTestError {
  readonly _tag: "OtherPipelineTestError";
}

interface PipelineFailureTestError {
  readonly _tag: "PipelineFailureTestError";
  readonly code: string;
  readonly message: string;
}

interface StructuralSkipItem {
  readonly _tag: "SkipItem";
  readonly reason: string;
}

const encodedInMemoryCursor = (offset: number) =>
  toEncodedSourceCursor(JSON.stringify({ offset }));

const roundTripRunState = (runState: MigrationRunState) =>
  Effect.gen(function* () {
    const encoded = yield* Schema.encodeEffect(MigrationRunState)(runState);

    return yield* Schema.decodeUnknownEffect(MigrationRunState)(encoded);
  });

const roundTripDefinitionLock = (lock: MigrationDefinitionLock) =>
  Effect.gen(function* () {
    const encoded = yield* Schema.encodeEffect(MigrationDefinitionLock)(lock);

    return yield* Schema.decodeUnknownEffect(MigrationDefinitionLock)(encoded);
  });

const releaseFailingStoreLayer = (
  state: ReturnType<typeof InMemoryMigrationStore.makeState>,
  error: MigrationStoreError,
  onRelease?: (lock: MigrationDefinitionLock) => void
) =>
  Layer.effect(
    MigrationStore,
    Effect.gen(function* () {
      const store = yield* MigrationStore;

      return {
        ...store,
        releaseDefinitionLock: (lock: MigrationDefinitionLock) =>
          Effect.sync(() => {
            onRelease?.(lock);
          }).pipe(Effect.andThen(Effect.fail(error))),
      };
    })
  ).pipe(Layer.provide(InMemoryMigrationStore.layer(state)));

const failRunFailingStoreLayer = (
  state: ReturnType<typeof InMemoryMigrationStore.makeState>,
  error: MigrationStoreError
) =>
  Layer.effect(
    MigrationStore,
    Effect.gen(function* () {
      const store = yield* MigrationStore;

      return {
        ...store,
        failRun: () => Effect.fail(error),
      };
    })
  ).pipe(Layer.provide(InMemoryMigrationStore.layer(state)));

const makePublishFailingDestination = (
  attempts: EntryCommand[]
): {
  readonly commandDefinitions: typeof EntryPlugin.commandDefinitions;
  readonly layer: Layer.Layer<DestinationPlugin>;
} => ({
  commandDefinitions: EntryPlugin.commandDefinitions,
  layer: Layer.sync(DestinationPlugin, () => ({
    execute: (command, context) =>
      Effect.gen(function* () {
        const typedCommand = yield* Schema.decodeUnknownEffect(EntryCommand)(
          command
        ).pipe(
          Effect.mapError(
            (cause) =>
              new DestinationPluginError({
                message: "Destination command did not match command schema",
                cause,
              })
          )
        );

        attempts.push(typedCommand);

        if (typedCommand.kind === "PublishEntry") {
          return yield* new DestinationPluginError({
            message: "Publish failed",
          });
        }

        return {
          destinationIdentity: toDestinationIdentity(
            `entry-${context.sourceIdentity}`
          ),
          destinationVersion: toDestinationVersion(
            `version-${attempts.length}`
          ),
        };
      }),
  })),
});

const makeEffectEntryDestination = (
  execute: (
    command: EntryCommand,
    context: DestinationCommandContext
  ) => Effect.Effect<DestinationCommandResultInput, DestinationPluginError>
): {
  readonly commandDefinitions: typeof EntryPlugin.commandDefinitions;
  readonly layer: Layer.Layer<DestinationPlugin>;
} => ({
  commandDefinitions: EntryPlugin.commandDefinitions,
  layer: Layer.sync(DestinationPlugin, () => ({
    execute: (command, context) =>
      Effect.gen(function* () {
        const typedCommand = yield* Schema.decodeUnknownEffect(EntryCommand)(
          command
        ).pipe(
          Effect.mapError(
            (cause) =>
              new DestinationPluginError({
                message: "Destination command did not match command schema",
                cause,
              })
          )
        );
        const result = yield* execute(typedCommand, context);

        return makeDestinationCommandResult(result);
      }),
  })),
});

describe("MigrationStore durable records", () => {
  it.effect("schema-round-trips beginRun state", () =>
    Effect.gen(function* () {
      const store = yield* MigrationStore;
      const runId = yield* store.createRunId;
      const runState = yield* store.beginRun(runId, [
        toMigrationDefinitionId("articles"),
      ]);

      const decoded = yield* roundTripRunState(runState);

      expect(decoded).toEqual(runState);
    }).pipe(Effect.provide(InMemoryMigrationStore.layer()))
  );

  it.effect("schema-round-trips completeRun state", () =>
    Effect.gen(function* () {
      const store = yield* MigrationStore;
      const runId = yield* store.createRunId;
      const runState = yield* store.beginRun(runId, [
        toMigrationDefinitionId("articles"),
      ]);

      const completed = yield* store.completeRun(runState.runId, [
        toMigrationDefinitionId("articles"),
      ]);
      const decoded = yield* roundTripRunState(completed);

      expect(completed.status).toBe("succeeded");
      expect(completed.finishedAt).toBeInstanceOf(Date);
      expect(decoded).toEqual(completed);
    }).pipe(Effect.provide(InMemoryMigrationStore.layer()))
  );

  it.effect("schema-round-trips failRun state", () =>
    Effect.gen(function* () {
      const store = yield* MigrationStore;
      const runId = yield* store.createRunId;
      const runState = yield* store.beginRun(runId, [
        toMigrationDefinitionId("articles"),
      ]);

      const failed = yield* store.failRun(runState.runId, [
        toMigrationDefinitionId("articles"),
      ]);
      const decoded = yield* roundTripRunState(failed);

      expect(failed.status).toBe("failed");
      expect(failed.finishedAt).toBeInstanceOf(Date);
      expect(decoded).toEqual(failed);
    }).pipe(Effect.provide(InMemoryMigrationStore.layer()))
  );

  it.effect("schema-round-trips acquired definition locks", () =>
    Effect.gen(function* () {
      const store = yield* MigrationStore;
      const lock = yield* store.acquireDefinitionLock(
        toMigrationDefinitionId("articles"),
        toMigrationRunId("run-1")
      );

      const decoded = yield* roundTripDefinitionLock(lock);

      expect(lock.token).toBe("lock-1");
      expect(lock.createdAt).toBeInstanceOf(Date);
      expect(decoded).toEqual(lock);
    }).pipe(Effect.provide(InMemoryMigrationStore.layer()))
  );

  it.effect("rejects releasing a definition lock with a mismatched token", () =>
    Effect.gen(function* () {
      const storeState = InMemoryMigrationStore.makeState();
      const definitionId = toMigrationDefinitionId("articles");
      const lock = yield* Effect.gen(function* () {
        const store = yield* MigrationStore;

        return yield* store.acquireDefinitionLock(
          definitionId,
          toMigrationRunId("run-1")
        );
      }).pipe(Effect.provide(InMemoryMigrationStore.layer(storeState)));

      const error = yield* Effect.gen(function* () {
        const store = yield* MigrationStore;

        return yield* Effect.flip(
          store.releaseDefinitionLock({
            ...lock,
            ownerRunId: toMigrationRunId("run-2"),
            token: toMigrationDefinitionLockToken("lock-other"),
          })
        );
      }).pipe(Effect.provide(InMemoryMigrationStore.layer(storeState)));

      expect(error).toEqual(
        expect.objectContaining({
          _tag: "MigrationStoreError",
          message: "Migration definition lock is owned by another runner",
        })
      );
      expect(storeState.definitionLocks.get(definitionId)).toEqual(lock);
    })
  );
});

describe("runMigration", () => {
  it("keeps item-level pipeline error types out of public run errors", () => {
    const pipelineTestError: PipelineTestError = { _tag: "PipelineTestError" };
    const store = InMemoryMigrationStore.layer();
    const definition = defineMigration({
      id: "articles",
      source: makeTestInMemorySource({
        items: [
          {
            identity: "article-1",
            version: "source-version-1",
            item: { title: "Hello, migration" },
          },
        ],
      }),
      destination: makeTestUpsertEntryDestination({}),
      store,
      pipeline: (): Effect.Effect<UpsertEntryCommand, PipelineTestError> =>
        Effect.fail(pipelineTestError),
    });
    const otherPipelineTestError: OtherPipelineTestError = {
      _tag: "OtherPipelineTestError",
    };
    const otherDefinition = defineMigration({
      id: "articles-copy",
      source: makeTestInMemorySource({
        items: [
          {
            identity: "article-1",
            version: "source-version-1",
            item: { title: "Hello, migration" },
          },
        ],
      }),
      destination: makeTestUpsertEntryDestination({}),
      store,
      pipeline: (): Effect.Effect<UpsertEntryCommand, OtherPipelineTestError> =>
        Effect.fail(otherPipelineTestError),
    });

    expectTypeOf(runMigration(definition)).toEqualTypeOf<
      Effect.Effect<MigrationRunSummary, RunMigrationError>
    >();
    expectTypeOf(
      runMigrations({ definitions: [definition, otherDefinition] })
    ).toEqualTypeOf<Effect.Effect<MigrationRunSummary, RunMigrationError>>();
  });

  it.effect("returns typed runtime errors for invalid Run Request input", () =>
    Effect.gen(function* () {
      const definition = defineMigration({
        id: "articles",
        source: makeTestInMemorySource({
          items: [
            {
              identity: "article-1",
              version: "source-version-1",
              item: { title: "Invalid request article" },
            },
          ],
        }),
        destination: makeTestUpsertEntryDestination({}),
        store: InMemoryMigrationStore.layer(),
        pipeline: (source) =>
          Effect.succeed({
            kind: "UpsertEntry" as const,
            contentType: "article",
            fields: {
              title: source.item.title,
            },
          }),
      });

      const error = yield* Effect.flip(
        runMigrations({ definitions: [definition], definitionIds: [""] })
      );

      expect(error).toEqual(
        expect.objectContaining({
          _tag: "MigrationRuntimeError",
          message: "Run request contains invalid input",
        })
      );
    })
  );

  it.effect(
    "keeps configured Source Cursor schema bound to the source layer",
    () =>
      Effect.gen(function* () {
        const cursorSchema = Schema.Number;
        const implementationWithConflictingSchema = {
          cursorSchema: Schema.String,
          lookupStrategy: "scan" as const,
          read: () =>
            Effect.succeed({
              items: [],
            }),
          readByIdentity: () => Effect.succeed(null),
        };
        const source = defineSourcePlugin({
          cursorSchema,
          sourceSchema: Schema.Struct({ title: Schema.String }),
          make: () =>
            implementationWithConflictingSchema as unknown as SourcePluginImplementation<
              { readonly title: string },
              number
            >,
        });

        const plugin = yield* SourcePlugin.pipe(Effect.provide(source.layer));

        expect(plugin.cursorSchema).toBe(cursorSchema);
        expect(plugin.sourceSchema).toBe(source.sourceSchema);
      })
  );

  it.effect("runs one Source Item through in-memory runtime", () =>
    Effect.gen(function* () {
      const destinationState = makeTestDestinationState<UpsertEntryCommand>();
      const storeState = InMemoryMigrationStore.makeState();

      const definition = defineMigration({
        id: "articles",
        source: makeTestInMemorySource({
          items: [
            {
              identity: "article-1",
              version: "source-version-1",
              item: {
                title: "Hello, migration",
              },
            },
          ],
        }),
        destination: makeTestUpsertEntryDestination({
          state: destinationState,
          execute: (_command, context) => ({
            destinationIdentity: `entry-${context.sourceIdentity}`,
            destinationVersion: "destination-version-1",
          }),
        }),
        store: InMemoryMigrationStore.layer(storeState),
        pipeline: (source) => ({
          kind: "UpsertEntry" as const,
          contentType: "article",
          fields: {
            title: source.item.title,
          },
        }),
      });

      const summary = yield* runMigration(definition);

      expect(summary.status).toBe("succeeded");
      expect(summary.definitions).toHaveLength(1);
      expect(summary.definitions[0]?.counts).toEqual({
        migrated: 1,
        skipped: 0,
        failed: 0,
        unchanged: 0,
        needsUpdate: 0,
      });

      expect(destinationState.executions).toHaveLength(1);
      expect(destinationState.executions[0]?.command).toEqual({
        kind: "UpsertEntry",
        contentType: "article",
        fields: {
          title: "Hello, migration",
        },
      });
      expect(destinationState.executions[0]?.context.sourceIdentity).toBe(
        "article-1"
      );

      const itemState = storeState.itemStates.get(
        InMemoryMigrationStore.itemStateKey("articles", "article-1")
      );

      expect(itemState).toEqual(
        expect.objectContaining({
          status: "migrated",
          sourceVersion: "source-version-1",
          destinationIdentity: "entry-article-1",
          destinationVersion: "destination-version-1",
          lastRunId: summary.runId,
        })
      );
    })
  );

  it.effect(
    "persists skipped Source Items without executing a Destination Command",
    () =>
      Effect.gen(function* () {
        const destinationState = makeTestDestinationState<UpsertEntryCommand>();
        const storeState = InMemoryMigrationStore.makeState();

        const definition = defineMigration({
          id: "articles",
          source: makeTestInMemorySource({
            items: [
              {
                identity: "article-1",
                version: "source-version-1",
                item: {
                  publish: false,
                  title: "Draft article",
                },
              },
              {
                identity: "article-2",
                version: "source-version-1",
                item: {
                  publish: true,
                  title: "Published article",
                },
              },
            ],
          }),
          destination: makeTestUpsertEntryDestination({
            state: destinationState,
          }),
          store: InMemoryMigrationStore.layer(storeState),
          pipeline: (source) =>
            Effect.gen(function* () {
              if (!source.item.publish) {
                return yield* skipItem("Article is not published");
              }

              return {
                kind: "UpsertEntry" as const,
                contentType: "article",
                fields: {
                  title: source.item.title,
                },
              };
            }),
        });

        const summary = yield* runMigration(definition);

        expect(summary.status).toBe("succeeded");
        expect(summary.definitions[0]?.counts).toEqual({
          migrated: 1,
          skipped: 1,
          failed: 0,
          unchanged: 0,
          needsUpdate: 0,
        });
        expect(
          destinationState.executions.map(
            (execution) => execution.context.sourceIdentity
          )
        ).toEqual(["article-2"]);

        expect(
          storeState.itemStates.get(
            InMemoryMigrationStore.itemStateKey("articles", "article-1")
          )
        ).toEqual(
          expect.objectContaining({
            status: "skipped",
            sourceVersion: "source-version-1",
            skipReason: "Article is not published",
            lastRunId: summary.runId,
          })
        );
      })
  );

  it.effect("recognizes structurally tagged Skip Item errors", () =>
    Effect.gen(function* () {
      const destinationState = makeTestDestinationState<UpsertEntryCommand>();
      const storeState = InMemoryMigrationStore.makeState();

      const definition = defineMigration({
        id: "articles",
        source: makeTestInMemorySource({
          items: [
            {
              identity: "article-1",
              version: "source-version-1",
              item: { title: "Draft article" },
            },
          ],
        }),
        destination: makeTestUpsertEntryDestination({
          state: destinationState,
        }),
        store: InMemoryMigrationStore.layer(storeState),
        pipeline: (): Effect.Effect<UpsertEntryCommand, StructuralSkipItem> =>
          Effect.fail({
            _tag: "SkipItem",
            reason: "Structurally tagged skip",
          }),
      });

      const summary = yield* runMigration(definition);

      expect(summary.status).toBe("succeeded");
      expect(summary.definitions[0]?.counts).toEqual({
        migrated: 0,
        skipped: 1,
        failed: 0,
        unchanged: 0,
        needsUpdate: 0,
      });
      expect(destinationState.executions).toEqual([]);
      expect(
        storeState.itemStates.get(
          InMemoryMigrationStore.itemStateKey("articles", "article-1")
        )
      ).toEqual(
        expect.objectContaining({
          status: "skipped",
          skipReason: "Structurally tagged skip",
        })
      );
    })
  );

  it.effect(
    "persists pipeline failures and continues processing Source Items",
    () =>
      Effect.gen(function* () {
        const destinationState = makeTestDestinationState<UpsertEntryCommand>();
        const storeState = InMemoryMigrationStore.makeState();
        const pipelineError: PipelineFailureTestError = {
          _tag: "PipelineFailureTestError",
          message: "Article cannot be transformed",
          code: "missing-title",
        };

        const definition = defineMigration({
          id: "articles",
          source: makeTestInMemorySource({
            items: [
              {
                identity: "article-1",
                version: "source-version-1",
                item: {
                  title: null,
                },
              },
              {
                identity: "article-2",
                version: "source-version-1",
                item: {
                  title: "Published article",
                },
              },
            ],
          }),
          destination: makeTestUpsertEntryDestination({
            state: destinationState,
          }),
          store: InMemoryMigrationStore.layer(storeState),
          pipeline: (source) =>
            source.identity === "article-1"
              ? Effect.fail(pipelineError)
              : {
                  kind: "UpsertEntry" as const,
                  contentType: "article",
                  fields: {
                    title: source.item.title,
                  },
                },
        });

        const summary = yield* runMigration(definition);

        expect(summary.status).toBe("failed");
        expect(summary.definitions[0]?.status).toBe("failed");
        expect(summary.definitions[0]?.counts).toEqual({
          migrated: 1,
          skipped: 0,
          failed: 1,
          unchanged: 0,
          needsUpdate: 0,
        });
        expect(
          destinationState.executions.map(
            (execution) => execution.context.sourceIdentity
          )
        ).toEqual(["article-2"]);

        expect(
          storeState.itemStates.get(
            InMemoryMigrationStore.itemStateKey("articles", "article-1")
          )
        ).toEqual(
          expect.objectContaining({
            status: "failed",
            sourceVersion: "source-version-1",
            lastRunId: summary.runId,
            error: {
              kind: "pipeline",
              errorTag: "PipelineFailureTestError",
              message: "Article cannot be transformed",
            },
          })
        );
        const failedState = storeState.itemStates.get(
          InMemoryMigrationStore.itemStateKey("articles", "article-1")
        );
        if (failedState === undefined) {
          throw new Error("Expected failed item state to be persisted");
        }
        const encodedState =
          yield* Schema.encodeEffect(MigrationItemState)(failedState);
        const decodedState =
          yield* Schema.decodeUnknownEffect(MigrationItemState)(encodedState);
        expect(decodedState).toEqual(
          expect.objectContaining({
            status: "failed",
            sourceVersion: "source-version-1",
            lastRunId: summary.runId,
            error: expect.objectContaining({
              kind: "pipeline",
              errorTag: "PipelineFailureTestError",
              message: "Article cannot be transformed",
            }),
          })
        );
        expect(
          storeState.itemStates.get(
            InMemoryMigrationStore.itemStateKey("articles", "article-2")
          )
        ).toEqual(
          expect.objectContaining({
            status: "migrated",
            lastRunId: summary.runId,
          })
        );
      })
  );

  it.effect(
    "persists destination failures and continues processing Source Items",
    () =>
      Effect.gen(function* () {
        const destinationExecutions: string[] = [];
        const storeState = InMemoryMigrationStore.makeState();

        const definition = defineMigration({
          id: "articles",
          source: makeTestInMemorySource({
            items: [
              {
                identity: "article-1",
                version: "source-version-1",
                item: {
                  title: "Invalid article",
                },
              },
              {
                identity: "article-2",
                version: "source-version-1",
                item: {
                  title: "Published article",
                },
              },
            ],
          }),
          destination: {
            commandDefinitions: UpsertEntryPlugin.commandDefinitions,
            layer: Layer.sync(DestinationPlugin, () => ({
              execute: (_command, context) => {
                if (context.sourceIdentity === "article-1") {
                  return Effect.fail(
                    new DestinationPluginError({
                      message: "Destination command failed",
                      cause: new Error("Destination write failed"),
                    })
                  );
                }

                destinationExecutions.push(context.sourceIdentity);

                return Effect.succeed({
                  destinationIdentity: toDestinationIdentity(
                    `entry-${context.sourceIdentity}`
                  ),
                });
              },
            })),
          },
          store: InMemoryMigrationStore.layer(storeState),
          pipeline: () =>
            Effect.succeed({
              kind: "UpsertEntry" as const,
              contentType: "article",
              fields: {},
            }),
        });

        const summary = yield* runMigration(definition);

        expect(summary.status).toBe("failed");
        expect(summary.definitions[0]?.status).toBe("failed");
        expect(summary.definitions[0]?.counts).toEqual({
          migrated: 1,
          skipped: 0,
          failed: 1,
          unchanged: 0,
          needsUpdate: 0,
        });
        expect(destinationExecutions).toEqual(["article-2"]);

        expect(
          storeState.itemStates.get(
            InMemoryMigrationStore.itemStateKey("articles", "article-1")
          )
        ).toEqual(
          expect.objectContaining({
            status: "failed",
            sourceVersion: "source-version-1",
            lastRunId: summary.runId,
            error: expect.objectContaining({
              kind: "destination",
              errorTag: "DestinationPluginError",
              message: "Destination command failed",
            }),
          })
        );
        expect(
          storeState.itemStates.get(
            InMemoryMigrationStore.itemStateKey("articles", "article-2")
          )
        ).toEqual(
          expect.objectContaining({
            status: "migrated",
            lastRunId: summary.runId,
          })
        );
      })
  );

  it.effect("wraps Destination Command execution with Destination Retry", () =>
    Effect.gen(function* () {
      const destinationState = makeTestDestinationState<UpsertEntryCommand>();
      const storeState = InMemoryMigrationStore.makeState();

      const definition = defineMigration({
        id: "articles",
        source: makeTestInMemorySource({
          items: [
            {
              identity: "article-1",
              version: "source-version-1",
              item: { title: "Retryable article" },
            },
          ],
        }),
        destination: makeTestUpsertEntryDestination({
          state: destinationState,
          transientFailures: { execute: 1 },
          execute: (_command, context) => ({
            destinationIdentity: `entry-${context.sourceIdentity}`,
          }),
        }),
        destinationRetry: (effect) =>
          effect.pipe(Effect.retry(Schedule.recurs(1))),
        store: InMemoryMigrationStore.layer(storeState),
        pipeline: () =>
          Effect.succeed({
            kind: "UpsertEntry" as const,
            contentType: "article",
            fields: {},
          }),
      });

      const summary = yield* runMigration(definition);

      expect(summary.status).toBe("succeeded");
      expect(summary.definitions[0]?.counts).toEqual({
        migrated: 1,
        skipped: 0,
        failed: 0,
        unchanged: 0,
        needsUpdate: 0,
      });
      expect(destinationState.executeAttempts).toBe(2);
      expect(
        destinationState.executions.map(
          (execution) => execution.context.sourceIdentity
        )
      ).toEqual(["article-1"]);
      expect(
        storeState.itemStates.get(
          InMemoryMigrationStore.itemStateKey("articles", "article-1")
        )
      ).toEqual(
        expect.objectContaining({
          status: "migrated",
          destinationIdentity: "entry-article-1",
        })
      );
    })
  );

  it.effect("wraps Source Cursor reads with Source Cursor Retry", () =>
    Effect.gen(function* () {
      const destinationState = makeTestDestinationState<UpsertEntryCommand>();
      const sourceState = InMemorySourcePlugin.makeState();
      const storeState = InMemoryMigrationStore.makeState();

      const definition = defineMigration({
        id: "articles",
        source: makeTestInMemorySource({
          state: sourceState,
          transientFailures: { read: 1 },
          items: [
            {
              identity: "article-1",
              version: "source-version-1",
              item: { title: "Retryable article" },
            },
          ],
        }),
        sourceCursorRetry: (effect) =>
          effect.pipe(Effect.retry(Schedule.recurs(1))),
        destination: makeTestUpsertEntryDestination({
          state: destinationState,
        }),
        store: InMemoryMigrationStore.layer(storeState),
        pipeline: () =>
          Effect.succeed({
            kind: "UpsertEntry" as const,
            contentType: "article",
            fields: {},
          }),
      });

      const summary = yield* runMigration(definition);

      expect(summary.status).toBe("succeeded");
      expect(summary.definitions[0]?.counts).toEqual({
        migrated: 1,
        skipped: 0,
        failed: 0,
        unchanged: 0,
        needsUpdate: 0,
      });
      expect(sourceState.readAttempts).toBe(2);
      expect(
        destinationState.executions.map(
          (execution) => execution.context.sourceIdentity
        )
      ).toEqual(["article-1"]);
    })
  );

  it.effect("wraps Source Identity lookups with Source Lookup Retry", () =>
    Effect.gen(function* () {
      const destinationState = makeTestDestinationState<UpsertEntryCommand>();
      const sourceState = InMemorySourcePlugin.makeState();
      const storeState = InMemoryMigrationStore.makeState();

      const definition = defineMigration({
        id: "articles",
        source: makeTestInMemorySource({
          state: sourceState,
          transientFailures: { readByIdentity: 1 },
          items: [
            {
              identity: "article-1",
              version: "source-version-1",
              item: { title: "Retryable article" },
            },
          ],
        }),
        sourceLookupRetry: (effect) =>
          effect.pipe(Effect.retry(Schedule.recurs(1))),
        destination: makeTestUpsertEntryDestination({
          state: destinationState,
        }),
        store: InMemoryMigrationStore.layer(storeState),
        pipeline: () =>
          Effect.succeed({
            kind: "UpsertEntry" as const,
            contentType: "article",
            fields: {},
          }),
      });

      const summary = yield* runMigrations({
        definitions: [definition],
        mode: { kind: "item", sourceIdentity: "article-1" },
      });

      expect(summary.status).toBe("succeeded");
      expect(summary.definitions[0]?.counts).toEqual({
        migrated: 1,
        skipped: 0,
        failed: 0,
        unchanged: 0,
        needsUpdate: 0,
      });
      expect(sourceState.readByIdentityAttempts).toBe(2);
      expect(
        destinationState.executions.map(
          (execution) => execution.context.sourceIdentity
        )
      ).toEqual(["article-1"]);
    })
  );

  it.effect(
    "records cursor-discovered source payload validation failures as durable item failures",
    () =>
      Effect.gen(function* () {
        const destinationState = makeTestDestinationState<UpsertEntryCommand>();
        const storeState = InMemoryMigrationStore.makeState();
        const pipelineCalls: string[] = [];

        const definition = defineMigration({
          id: "articles",
          source: InMemorySourcePlugin.make({
            sourceSchema: ArticleSource,
            items: [
              {
                identity: "article-invalid",
                version: "source-version-1",
                item: asArticleSource({ title: null }),
              },
              {
                identity: "article-valid",
                version: "source-version-1",
                item: { title: "Valid article" },
              },
            ],
          }),
          destination: makeTestUpsertEntryDestination({
            state: destinationState,
          }),
          store: InMemoryMigrationStore.layer(storeState),
          pipeline: (source) =>
            Effect.sync(() => {
              pipelineCalls.push(source.identity);

              return {
                kind: "UpsertEntry" as const,
                contentType: "article",
                fields: {
                  title: source.item.title,
                },
              };
            }),
        });

        const summary = yield* runMigration(definition);

        expect(summary.status).toBe("failed");
        expect(summary.definitions[0]?.counts).toEqual({
          migrated: 1,
          skipped: 0,
          failed: 1,
          unchanged: 0,
          needsUpdate: 0,
        });
        expect(pipelineCalls).toEqual(["article-valid"]);
        expect(
          destinationState.executions.map(
            (execution) => execution.context.sourceIdentity
          )
        ).toEqual(["article-valid"]);
        expect(
          storeState.itemStates.get(
            InMemoryMigrationStore.itemStateKey("articles", "article-invalid")
          )
        ).toEqual(
          expect.objectContaining({
            status: "failed",
            sourceVersion: "source-version-1",
            error: expect.objectContaining({
              kind: "source",
              errorTag: "SourcePayloadSchemaError",
              message: "Source payload did not match Source Payload Schema",
              details: expect.arrayContaining([
                expect.objectContaining({
                  path: "title",
                  message: expect.stringContaining("Expected string"),
                }),
              ]),
            }),
          })
        );
      })
  );

  it.effect("validates source payloads before unchanged detection", () =>
    Effect.gen(function* () {
      const destinationState = makeTestDestinationState<UpsertEntryCommand>();
      const storeState = InMemoryMigrationStore.makeState();
      const pipelineCalls: string[] = [];

      const definition = defineMigration({
        id: "articles",
        source: InMemorySourcePlugin.make({
          sourceSchema: ArticleSource,
          items: [
            {
              identity: "article-unchanged-invalid",
              version: "source-version-1",
              item: asArticleSource({ title: null }),
            },
          ],
        }),
        destination: makeTestUpsertEntryDestination({
          state: destinationState,
        }),
        store: InMemoryMigrationStore.layer(storeState),
        pipeline: (source) =>
          Effect.sync(() => {
            pipelineCalls.push(source.identity);

            return {
              kind: "UpsertEntry" as const,
              contentType: "article",
              fields: {},
            };
          }),
      });

      storeState.itemStates.set(
        InMemoryMigrationStore.itemStateKey(
          "articles",
          "article-unchanged-invalid"
        ),
        {
          definitionId: toMigrationDefinitionId("articles"),
          sourceIdentity: toSourceIdentity("article-unchanged-invalid"),
          sourceVersion: toSourceVersion("source-version-1"),
          lastRunId: toMigrationRunId("run-previous"),
          updatedAt: new Date("2026-01-01T00:00:00.000Z"),
          status: "migrated",
          destinationIdentity: toDestinationIdentity(
            "entry-article-unchanged-invalid"
          ),
          destinationVersion: toDestinationVersion("destination-version-1"),
        }
      );

      const summary = yield* runMigration(definition);

      expect(summary.status).toBe("failed");
      expect(summary.definitions[0]?.counts).toEqual({
        migrated: 0,
        skipped: 0,
        failed: 1,
        unchanged: 0,
        needsUpdate: 0,
      });
      expect(pipelineCalls).toEqual([]);
      expect(destinationState.executions).toEqual([]);
      expect(
        storeState.itemStates.get(
          InMemoryMigrationStore.itemStateKey(
            "articles",
            "article-unchanged-invalid"
          )
        )
      ).toEqual(
        expect.objectContaining({
          status: "failed",
          lastRunId: summary.runId,
          sourceVersion: "source-version-1",
          destinationIdentity: "entry-article-unchanged-invalid",
          destinationVersion: "destination-version-1",
          error: expect.objectContaining({
            kind: "source",
            errorTag: "SourcePayloadSchemaError",
          }),
        })
      );
    })
  );

  it.effect("bounds persisted source payload schema error details", () =>
    Effect.gen(function* () {
      const destinationState = makeTestDestinationState<UpsertEntryCommand>();
      const storeState = InMemoryMigrationStore.makeState();

      const definition = defineMigration({
        id: "articles",
        source: InMemorySourcePlugin.make({
          sourceSchema: ManyFieldSource,
          items: [
            {
              identity: "article-many-errors",
              version: "source-version-1",
              item: asManyFieldSource({}),
            },
          ],
        }),
        destination: makeTestUpsertEntryDestination({
          state: destinationState,
        }),
        store: InMemoryMigrationStore.layer(storeState),
        pipeline: () =>
          Effect.succeed({
            kind: "UpsertEntry" as const,
            contentType: "article",
            fields: {},
          }),
      });

      yield* runMigration(definition);

      const itemState = storeState.itemStates.get(
        InMemoryMigrationStore.itemStateKey("articles", "article-many-errors")
      );

      expect(itemState).toEqual(
        expect.objectContaining({
          status: "failed",
          error: expect.objectContaining({
            kind: "source",
            errorTag: "SourcePayloadSchemaError",
            details: expect.arrayContaining([
              expect.objectContaining({
                message: "1 additional schema issue(s) omitted",
              }),
            ]),
          }),
        })
      );
      if (itemState?.status !== "failed") {
        throw new Error("Expected failed item state to be persisted");
      }
      expect(itemState.error.details).toHaveLength(6);
    })
  );

  it.effect("validates targeted source identity lookup payloads", () =>
    Effect.gen(function* () {
      const destinationState = makeTestDestinationState<UpsertEntryCommand>();
      const storeState = InMemoryMigrationStore.makeState();
      const pipelineCalls: string[] = [];

      const definition = defineMigration({
        id: "articles",
        source: InMemorySourcePlugin.make({
          sourceSchema: ArticleSource,
          items: [
            {
              identity: "article-target-invalid",
              version: "source-version-1",
              item: asArticleSource({ title: null }),
            },
          ],
        }),
        destination: makeTestUpsertEntryDestination({
          state: destinationState,
        }),
        store: InMemoryMigrationStore.layer(storeState),
        pipeline: (source) =>
          Effect.sync(() => {
            pipelineCalls.push(source.identity);

            return {
              kind: "UpsertEntry" as const,
              contentType: "article",
              fields: {},
            };
          }),
      });

      const summary = yield* runMigrations({
        definitions: [definition],
        mode: { kind: "item", sourceIdentity: "article-target-invalid" },
      });

      expect(summary.status).toBe("failed");
      expect(summary.definitions[0]?.counts).toEqual({
        migrated: 0,
        skipped: 0,
        failed: 1,
        unchanged: 0,
        needsUpdate: 0,
      });
      expect(pipelineCalls).toEqual([]);
      expect(destinationState.executions).toEqual([]);
      expect(
        storeState.itemStates.get(
          InMemoryMigrationStore.itemStateKey(
            "articles",
            "article-target-invalid"
          )
        )
      ).toEqual(
        expect.objectContaining({
          status: "failed",
          sourceVersion: "source-version-1",
          error: expect.objectContaining({
            kind: "source",
            errorTag: "SourcePayloadSchemaError",
          }),
        })
      );
    })
  );

  it.effect(
    "passes decoded source payloads to the transformation pipeline",
    () =>
      Effect.gen(function* () {
        const destinationState = makeTestDestinationState<UpsertEntryCommand>();
        const storeState = InMemoryMigrationStore.makeState();
        const decodedPayloads: ArticleStatsSource[] = [];

        const definition = defineMigration({
          id: "articles",
          source: InMemorySourcePlugin.make({
            sourceSchema: ArticleStatsSource,
            items: [
              {
                identity: "article-stats",
                version: "source-version-1",
                item: asArticleStatsSource({
                  title: "  Decoded article  ",
                  views: "42",
                }),
              },
            ],
          }),
          destination: makeTestUpsertEntryDestination({
            state: destinationState,
          }),
          store: InMemoryMigrationStore.layer(storeState),
          pipeline: (source) =>
            Effect.sync(() => {
              decodedPayloads.push(source.item);

              return {
                kind: "UpsertEntry" as const,
                contentType: "article",
                fields: {
                  title: source.item.title,
                  views: source.item.views,
                },
              };
            }),
        });

        const summary = yield* runMigration(definition);

        expect(summary.status).toBe("succeeded");
        expect(decodedPayloads).toEqual([
          { title: "Decoded article", views: 42 },
        ]);
        expect(destinationState.executions[0]?.command.fields).toEqual({
          title: "Decoded article",
          views: 42,
        });
      })
  );

  it.effect(
    "accepts decoded source values through in-memory entry command factories",
    () =>
      Effect.gen(function* () {
        const destinationState =
          makeTestDestinationState<ArticleStatsEntryCommand>();
        const storeState = InMemoryMigrationStore.makeState();
        const destinationFixture = InMemoryDestinationTesting.fixtureEntries({
          contentType: "article",
          commands: {
            publishEntry: true,
            upsertEntry: { fields: ArticleStatsEntryFields },
          },
        });
        destinationState.bind(destinationFixture);
        const destination = destinationFixture.destination;

        const definition = defineMigration({
          id: "articles",
          source: InMemorySourcePlugin.make({
            sourceSchema: ArticleStatsSource,
            items: [
              {
                identity: "article-stats",
                version: "source-version-1",
                item: asArticleStatsSource({
                  title: "  Decoded article  ",
                  views: "42",
                }),
              },
            ],
          }),
          destination,
          store: InMemoryMigrationStore.layer(storeState),
          pipeline: (source) =>
            Effect.succeed(
              destination.commands.upsertEntry({
                title: source.item.title,
                views: source.item.views,
              })
            ),
        });

        const summary = yield* runMigration(definition);
        const firstExecution = destinationState.executions[0];

        expect(summary.status).toBe("succeeded");
        expect(firstExecution?.command.kind).toBe("UpsertEntry");
        expect(
          firstExecution?.command.kind === "UpsertEntry"
            ? firstExecution.command.fields
            : undefined
        ).toEqual({
          title: "Decoded article",
          views: 42,
        });
        expect(destinationState.entries.get("article:article-stats")).toEqual(
          expect.objectContaining({
            fields: {
              title: "Decoded article",
              views: 42,
            },
          })
        );
      })
  );

  it.effect("rejects non-positive in-memory Source batch sizes", () =>
    Effect.gen(function* () {
      const definition = defineMigration({
        id: "articles",
        source: makeTestInMemorySource({
          batchSize: 0,
          items: [
            {
              identity: "article-1",
              version: "source-version-1",
              item: { title: "Article 1" },
            },
          ],
        }),
        destination: makeTestUpsertEntryDestination({}),
        store: InMemoryMigrationStore.layer(),
        pipeline: (source) =>
          Effect.succeed({
            kind: "UpsertEntry" as const,
            contentType: "article",
            fields: {
              title: source.item.title,
            },
          }),
      });

      const error = yield* Effect.flip(runMigration(definition));

      expect(error).toEqual(
        expect.objectContaining({
          _tag: "SourcePluginError",
          message: "In-memory source batchSize must be a positive integer",
        })
      );
    })
  );

  it.effect("processes all Source Cursor Windows in one run", () =>
    Effect.gen(function* () {
      const destinationState = makeTestDestinationState<UpsertEntryCommand>();
      const storeState = InMemoryMigrationStore.makeState();

      const definition = defineMigration({
        id: "articles",
        source: makeTestInMemorySource({
          batchSize: 2,
          items: [
            {
              identity: "article-1",
              version: "source-version-1",
              item: { title: "Article 1" },
            },
            {
              identity: "article-2",
              version: "source-version-1",
              item: { title: "Article 2" },
            },
            {
              identity: "article-3",
              version: "source-version-1",
              item: { title: "Article 3" },
            },
            {
              identity: "article-4",
              version: "source-version-1",
              item: { title: "Article 4" },
            },
            {
              identity: "article-5",
              version: "source-version-1",
              item: { title: "Article 5" },
            },
          ],
        }),
        destination: makeTestUpsertEntryDestination({
          state: destinationState,
        }),
        store: InMemoryMigrationStore.layer(storeState),
        pipeline: (source) =>
          Effect.succeed({
            kind: "UpsertEntry" as const,
            contentType: "article",
            fields: {
              title: source.item.title,
            },
          }),
      });

      const summary = yield* runMigration(definition);

      expect(summary.definitions[0]?.counts).toEqual({
        migrated: 5,
        skipped: 0,
        failed: 0,
        unchanged: 0,
        needsUpdate: 0,
      });
      expect(
        destinationState.executions.map(
          (execution) => execution.context.sourceIdentity
        )
      ).toEqual([
        "article-1",
        "article-2",
        "article-3",
        "article-4",
        "article-5",
      ]);
      expect(storeState.sourceCursors.get(definition.id)).toEqual(
        encodedInMemoryCursor(4)
      );
      expect(storeState.sourceCursorCommits).toEqual([
        {
          definitionId: definition.id,
          cursor: encodedInMemoryCursor(2),
        },
        {
          definitionId: definition.id,
          cursor: encodedInMemoryCursor(4),
        },
      ]);
    })
  );

  it.effect("advances Source Cursors after windows with item failures", () =>
    Effect.gen(function* () {
      const destinationState = makeTestDestinationState<UpsertEntryCommand>();
      const storeState = InMemoryMigrationStore.makeState();
      const pipelineError: PipelineFailureTestError = {
        _tag: "PipelineFailureTestError",
        message: "Article cannot be transformed",
        code: "missing-title",
      };

      const definition = defineMigration({
        id: "articles",
        source: makeTestInMemorySource({
          batchSize: 2,
          items: [
            {
              identity: "article-1",
              version: "source-version-1",
              item: { title: null },
            },
            {
              identity: "article-2",
              version: "source-version-1",
              item: { title: "Article 2" },
            },
            {
              identity: "article-3",
              version: "source-version-1",
              item: { title: "Article 3" },
            },
          ],
        }),
        destination: makeTestUpsertEntryDestination({
          state: destinationState,
        }),
        store: InMemoryMigrationStore.layer(storeState),
        pipeline: (source) =>
          source.identity === "article-1"
            ? Effect.fail(pipelineError)
            : Effect.succeed({
                kind: "UpsertEntry" as const,
                contentType: "article",
                fields: {
                  title: source.item.title,
                },
              }),
      });

      const summary = yield* runMigration(definition);

      expect(summary.status).toBe("failed");
      expect(summary.definitions[0]?.counts).toEqual({
        migrated: 2,
        skipped: 0,
        failed: 1,
        unchanged: 0,
        needsUpdate: 0,
      });
      expect(
        destinationState.executions.map(
          (execution) => execution.context.sourceIdentity
        )
      ).toEqual(["article-2", "article-3"]);
      expect(storeState.sourceCursors.get(definition.id)).toEqual(
        encodedInMemoryCursor(2)
      );
      expect(storeState.sourceCursorCommits).toEqual([
        {
          definitionId: definition.id,
          cursor: encodedInMemoryCursor(2),
        },
      ]);
    })
  );

  it.effect(
    "processes failed backlog before cursor discovery in normal mode",
    () =>
      Effect.gen(function* () {
        const destinationState = makeTestDestinationState<UpsertEntryCommand>();
        const storeState = InMemoryMigrationStore.makeState();

        const definition = defineMigration({
          id: "articles",
          source: makeTestInMemorySource({
            items: [
              {
                identity: "article-failed",
                version: "source-version-2",
                item: { title: "Recovered article" },
              },
              {
                identity: "article-new",
                version: "source-version-1",
                item: { title: "New article" },
              },
            ],
          }),
          destination: makeTestUpsertEntryDestination({
            state: destinationState,
          }),
          store: InMemoryMigrationStore.layer(storeState),
          pipeline: () =>
            Effect.succeed({
              kind: "UpsertEntry" as const,
              contentType: "article",
              fields: {},
            }),
        });

        storeState.sourceCursors.set(definition.id, encodedInMemoryCursor(1));
        storeState.itemStates.set(
          InMemoryMigrationStore.itemStateKey("articles", "article-failed"),
          {
            definitionId: toMigrationDefinitionId("articles"),
            sourceIdentity: toSourceIdentity("article-failed"),
            sourceVersion: toSourceVersion("source-version-1"),
            lastRunId: toMigrationRunId("run-previous"),
            updatedAt: new Date("2026-01-01T00:00:00.000Z"),
            status: "failed",
            error: {
              kind: "pipeline",
              errorTag: "PipelineFailureTestError",
              message: "Article could not be transformed",
            },
          }
        );

        const summary = yield* runMigration(definition);

        expect(summary.status).toBe("succeeded");
        expect(summary.definitions[0]?.counts).toEqual({
          migrated: 2,
          skipped: 0,
          failed: 0,
          unchanged: 0,
          needsUpdate: 0,
        });
        expect(
          destinationState.executions.map(
            (execution) => execution.context.sourceIdentity
          )
        ).toEqual(["article-failed", "article-new"]);
      })
  );

  it.effect(
    "processes needs-update backlog before cursor discovery in normal mode",
    () =>
      Effect.gen(function* () {
        const destinationState = makeTestDestinationState<UpsertEntryCommand>();
        const storeState = InMemoryMigrationStore.makeState();

        const definition = defineMigration({
          id: "articles",
          source: makeTestInMemorySource({
            items: [
              {
                identity: "article-needs-update",
                version: "source-version-1",
                item: { title: "Reserved article" },
              },
              {
                identity: "article-new",
                version: "source-version-1",
                item: { title: "New article" },
              },
            ],
          }),
          destination: makeTestUpsertEntryDestination({
            state: destinationState,
          }),
          store: InMemoryMigrationStore.layer(storeState),
          pipeline: () =>
            Effect.succeed({
              kind: "UpsertEntry" as const,
              contentType: "article",
              fields: {},
            }),
        });

        storeState.sourceCursors.set(definition.id, encodedInMemoryCursor(1));
        storeState.itemStates.set(
          InMemoryMigrationStore.itemStateKey(
            "articles",
            "article-needs-update"
          ),
          {
            definitionId: toMigrationDefinitionId("articles"),
            sourceIdentity: toSourceIdentity("article-needs-update"),
            sourceVersion: toSourceVersion("source-version-1"),
            lastRunId: toMigrationRunId("run-previous"),
            updatedAt: new Date("2026-01-01T00:00:00.000Z"),
            status: "needs-update",
            destinationIdentity: toDestinationIdentity(
              "entry-article-needs-update"
            ),
            reason: "Destination stub must be completed",
          }
        );

        const summary = yield* runMigration(definition);

        expect(summary.status).toBe("succeeded");
        expect(summary.definitions[0]?.counts).toEqual({
          migrated: 2,
          skipped: 0,
          failed: 0,
          unchanged: 0,
          needsUpdate: 0,
        });
        expect(
          destinationState.executions.map(
            (execution) => execution.context.sourceIdentity
          )
        ).toEqual(["article-needs-update", "article-new"]);
        expect(destinationState.executions[0]?.context.previousState).toEqual(
          expect.objectContaining({
            status: "needs-update",
            reason: "Destination stub must be completed",
          })
        );
      })
  );

  it.effect("processes only failed Migration Item States in failed mode", () =>
    Effect.gen(function* () {
      const destinationState = makeTestDestinationState<UpsertEntryCommand>();
      const storeState = InMemoryMigrationStore.makeState();

      const definition = defineMigration({
        id: "articles",
        source: makeTestInMemorySource({
          items: [
            {
              identity: "article-failed",
              version: "source-version-1",
              item: { title: "Recovered article" },
            },
            {
              identity: "article-needs-update",
              version: "source-version-1",
              item: { title: "Reserved article" },
            },
            {
              identity: "article-new",
              version: "source-version-1",
              item: { title: "New article" },
            },
          ],
        }),
        destination: makeTestUpsertEntryDestination({
          state: destinationState,
        }),
        store: InMemoryMigrationStore.layer(storeState),
        pipeline: (source) =>
          Effect.succeed({
            kind: "UpsertEntry" as const,
            contentType: "article",
            fields: {
              title: source.item.title,
            },
          }),
      });

      storeState.itemStates.set(
        InMemoryMigrationStore.itemStateKey("articles", "article-failed"),
        {
          definitionId: toMigrationDefinitionId("articles"),
          sourceIdentity: toSourceIdentity("article-failed"),
          sourceVersion: toSourceVersion("source-version-1"),
          lastRunId: toMigrationRunId("run-previous"),
          updatedAt: new Date("2026-01-01T00:00:00.000Z"),
          status: "failed",
          error: {
            kind: "destination",
            errorTag: "DestinationPluginError",
            message: "Destination command failed",
          },
        }
      );
      storeState.itemStates.set(
        InMemoryMigrationStore.itemStateKey("articles", "article-needs-update"),
        {
          definitionId: toMigrationDefinitionId("articles"),
          sourceIdentity: toSourceIdentity("article-needs-update"),
          sourceVersion: toSourceVersion("source-version-1"),
          lastRunId: toMigrationRunId("run-previous"),
          updatedAt: new Date("2026-01-01T00:00:00.000Z"),
          status: "needs-update",
          destinationIdentity: toDestinationIdentity(
            "entry-article-needs-update"
          ),
          reason: "Destination stub must be completed",
        }
      );

      const summary = yield* runMigrations({
        definitions: [definition],
        mode: { kind: "failed" },
      });

      expect(summary.status).toBe("succeeded");
      expect(summary.definitions[0]?.counts).toEqual({
        migrated: 1,
        skipped: 0,
        failed: 0,
        unchanged: 0,
        needsUpdate: 0,
      });
      expect(
        destinationState.executions.map(
          (execution) => execution.context.sourceIdentity
        )
      ).toEqual(["article-failed"]);
      expect(storeState.sourceCursorCommits).toEqual([]);
    })
  );

  it.effect("reprocesses skipped Migration Item States in skipped mode", () =>
    Effect.gen(function* () {
      const destinationState = makeTestDestinationState<UpsertEntryCommand>();
      const storeState = InMemoryMigrationStore.makeState();

      const definition = defineMigration({
        id: "articles",
        source: makeTestInMemorySource({
          items: [
            {
              identity: "article-skipped",
              version: "source-version-1",
              item: { title: "Previously skipped article" },
            },
            {
              identity: "article-new",
              version: "source-version-1",
              item: { title: "New article" },
            },
          ],
        }),
        destination: makeTestUpsertEntryDestination({
          state: destinationState,
        }),
        store: InMemoryMigrationStore.layer(storeState),
        pipeline: (source) =>
          Effect.succeed({
            kind: "UpsertEntry" as const,
            contentType: "article",
            fields: {
              title: source.item.title,
            },
          }),
      });

      storeState.itemStates.set(
        InMemoryMigrationStore.itemStateKey("articles", "article-skipped"),
        {
          definitionId: toMigrationDefinitionId("articles"),
          sourceIdentity: toSourceIdentity("article-skipped"),
          sourceVersion: toSourceVersion("source-version-1"),
          lastRunId: toMigrationRunId("run-previous"),
          updatedAt: new Date("2026-01-01T00:00:00.000Z"),
          status: "skipped",
          skipReason: "Draft article",
        }
      );

      const summary = yield* runMigrations({
        definitions: [definition],
        mode: { kind: "skipped" },
      });

      expect(summary.status).toBe("succeeded");
      expect(summary.definitions[0]?.counts).toEqual({
        migrated: 1,
        skipped: 0,
        failed: 0,
        unchanged: 0,
        needsUpdate: 0,
      });
      expect(
        destinationState.executions.map(
          (execution) => execution.context.sourceIdentity
        )
      ).toEqual(["article-skipped"]);
      expect(storeState.sourceCursorCommits).toEqual([]);
    })
  );

  it.effect("processes exactly one Source Identity in item mode", () =>
    Effect.gen(function* () {
      const destinationState = makeTestDestinationState<UpsertEntryCommand>();
      const storeState = InMemoryMigrationStore.makeState();

      const definition = defineMigration({
        id: "articles",
        source: makeTestInMemorySource({
          items: [
            {
              identity: "article-target",
              version: "source-version-1",
              item: { title: "Target article" },
            },
            {
              identity: "article-new",
              version: "source-version-1",
              item: { title: "New article" },
            },
          ],
        }),
        destination: makeTestUpsertEntryDestination({
          state: destinationState,
        }),
        store: InMemoryMigrationStore.layer(storeState),
        pipeline: (source) =>
          Effect.succeed({
            kind: "UpsertEntry" as const,
            contentType: "article",
            fields: {
              title: source.item.title,
            },
          }),
      });

      storeState.itemStates.set(
        InMemoryMigrationStore.itemStateKey("articles", "article-target"),
        {
          definitionId: toMigrationDefinitionId("articles"),
          sourceIdentity: toSourceIdentity("article-target"),
          sourceVersion: toSourceVersion("source-version-1"),
          lastRunId: toMigrationRunId("run-previous"),
          updatedAt: new Date("2026-01-01T00:00:00.000Z"),
          status: "migrated",
          destinationIdentity: toDestinationIdentity("entry-article-target"),
        }
      );

      const summary = yield* runMigrations({
        definitions: [definition],
        mode: { kind: "item", sourceIdentity: "article-target" },
      });

      expect(summary.status).toBe("succeeded");
      expect(summary.definitions[0]?.counts).toEqual({
        migrated: 1,
        skipped: 0,
        failed: 0,
        unchanged: 0,
        needsUpdate: 0,
      });
      expect(
        destinationState.executions.map(
          (execution) => execution.context.sourceIdentity
        )
      ).toEqual(["article-target"]);
      expect(storeState.sourceCursorCommits).toEqual([]);
    })
  );

  it.effect(
    "records Source identity lookup failures for known Migration Item States",
    () =>
      Effect.gen(function* () {
        const destinationState = makeTestDestinationState<UpsertEntryCommand>();
        const storeState = InMemoryMigrationStore.makeState();
        const sourceError = new SourcePluginError({
          message: "Source identity lookup failed",
          cause: new Error("Source system unavailable"),
        });

        const definition = defineMigration({
          id: "articles",
          source: defineSourcePlugin({
            cursorSchema: InMemorySourceCursor,
            sourceSchema: Schema.Unknown,
            lookupStrategy: "direct",
            read: () => Effect.succeed({ items: [] }),
            readByIdentity: () => Effect.fail(sourceError),
          }),
          destination: makeTestUpsertEntryDestination({
            state: destinationState,
          }),
          store: InMemoryMigrationStore.layer(storeState),
          pipeline: () =>
            Effect.succeed({
              kind: "UpsertEntry" as const,
              contentType: "article",
              fields: {},
            }),
        });

        storeState.itemStates.set(
          InMemoryMigrationStore.itemStateKey("articles", "article-failed"),
          {
            definitionId: toMigrationDefinitionId("articles"),
            sourceIdentity: toSourceIdentity("article-failed"),
            sourceVersion: toSourceVersion("source-version-1"),
            lastRunId: toMigrationRunId("run-previous"),
            updatedAt: new Date("2026-01-01T00:00:00.000Z"),
            status: "failed",
            error: {
              kind: "pipeline",
              errorTag: "PipelineFailureTestError",
              message: "Article could not be transformed",
            },
          }
        );

        const summary = yield* runMigrations({
          definitions: [definition],
          mode: { kind: "failed" },
        });

        expect(summary.status).toBe("failed");
        expect(summary.definitions[0]?.counts).toEqual({
          migrated: 0,
          skipped: 0,
          failed: 1,
          unchanged: 0,
          needsUpdate: 0,
        });
        expect(destinationState.executions).toEqual([]);
        expect(
          storeState.itemStates.get(
            InMemoryMigrationStore.itemStateKey("articles", "article-failed")
          )
        ).toEqual(
          expect.objectContaining({
            status: "failed",
            lastRunId: summary.runId,
            error: expect.objectContaining({
              kind: "source",
              errorTag: "SourcePluginError",
              message: "Source identity lookup failed",
            }),
          })
        );
      })
  );

  it.effect(
    "preserves Destination Identity when a migrated item lookup fails",
    () =>
      Effect.gen(function* () {
        const destinationState = makeTestDestinationState<UpsertEntryCommand>();
        const storeState = InMemoryMigrationStore.makeState();
        const sourceError = new SourcePluginError({
          message: "Source identity lookup failed",
          cause: new Error("Source system unavailable"),
        });

        const definition = defineMigration({
          id: "articles",
          source: defineSourcePlugin({
            cursorSchema: InMemorySourceCursor,
            sourceSchema: Schema.Unknown,
            lookupStrategy: "direct",
            read: () => Effect.succeed({ items: [] }),
            readByIdentity: () => Effect.fail(sourceError),
          }),
          destination: makeTestUpsertEntryDestination({
            state: destinationState,
          }),
          store: InMemoryMigrationStore.layer(storeState),
          pipeline: () =>
            Effect.succeed({
              kind: "UpsertEntry" as const,
              contentType: "article",
              fields: {},
            }),
        });

        storeState.itemStates.set(
          InMemoryMigrationStore.itemStateKey("articles", "article-migrated"),
          {
            definitionId: toMigrationDefinitionId("articles"),
            sourceIdentity: toSourceIdentity("article-migrated"),
            sourceVersion: toSourceVersion("source-version-1"),
            lastRunId: toMigrationRunId("run-previous"),
            updatedAt: new Date("2026-01-01T00:00:00.000Z"),
            status: "migrated",
            destinationIdentity: toDestinationIdentity(
              "entry-article-migrated"
            ),
            destinationVersion: toDestinationVersion("destination-version-1"),
          }
        );

        const summary = yield* runMigrations({
          definitions: [definition],
          mode: { kind: "item", sourceIdentity: "article-migrated" },
        });

        expect(summary.status).toBe("failed");
        expect(destinationState.executions).toEqual([]);
        expect(
          storeState.itemStates.get(
            InMemoryMigrationStore.itemStateKey("articles", "article-migrated")
          )
        ).toEqual(
          expect.objectContaining({
            status: "failed",
            destinationIdentity: "entry-article-migrated",
            destinationVersion: "destination-version-1",
            error: expect.objectContaining({
              kind: "source",
              errorTag: "SourcePluginError",
              message: "Source identity lookup failed",
            }),
          })
        );
      })
  );

  it.effect(
    "does not rediscover attempted backlog Source Identities in normal mode",
    () =>
      Effect.gen(function* () {
        const destinationState = makeTestDestinationState<UpsertEntryCommand>();
        const storeState = InMemoryMigrationStore.makeState();
        const sourceError = new SourcePluginError({
          message: "Source identity lookup failed",
          cause: new Error("Source system unavailable"),
        });

        const definition = defineMigration({
          id: "articles",
          source: defineSourcePlugin({
            cursorSchema: InMemorySourceCursor,
            sourceSchema: Schema.Unknown,
            lookupStrategy: "direct",
            read: () =>
              Effect.succeed({
                items: [
                  {
                    identity: toSourceIdentity("article-failed"),
                    version: toSourceVersion("source-version-2"),
                    item: { title: "Rediscovered article" },
                  },
                  {
                    identity: toSourceIdentity("article-new"),
                    version: toSourceVersion("source-version-1"),
                    item: { title: "New article" },
                  },
                ],
              }),
            readByIdentity: () => Effect.fail(sourceError),
          }),
          destination: makeTestUpsertEntryDestination({
            state: destinationState,
          }),
          store: InMemoryMigrationStore.layer(storeState),
          pipeline: () =>
            Effect.succeed({
              kind: "UpsertEntry" as const,
              contentType: "article",
              fields: {},
            }),
        });

        storeState.itemStates.set(
          InMemoryMigrationStore.itemStateKey("articles", "article-failed"),
          {
            definitionId: toMigrationDefinitionId("articles"),
            sourceIdentity: toSourceIdentity("article-failed"),
            sourceVersion: toSourceVersion("source-version-1"),
            lastRunId: toMigrationRunId("run-previous"),
            updatedAt: new Date("2026-01-01T00:00:00.000Z"),
            status: "failed",
            error: {
              kind: "pipeline",
              errorTag: "PipelineFailureTestError",
              message: "Article could not be transformed",
            },
          }
        );

        const summary = yield* runMigration(definition);

        expect(summary.status).toBe("failed");
        expect(summary.definitions[0]?.counts).toEqual({
          migrated: 1,
          skipped: 0,
          failed: 1,
          unchanged: 0,
          needsUpdate: 0,
        });
        expect(
          destinationState.executions.map(
            (execution) => execution.context.sourceIdentity
          )
        ).toEqual(["article-new"]);
        expect(
          storeState.itemStates.get(
            InMemoryMigrationStore.itemStateKey("articles", "article-failed")
          )
        ).toEqual(
          expect.objectContaining({
            status: "failed",
            sourceVersion: "source-version-1",
            error: expect.objectContaining({
              kind: "source",
              errorTag: "SourcePluginError",
              message: "Source identity lookup failed",
            }),
          })
        );
      })
  );

  it.effect("does not reprocess unchanged terminal Source Items", () =>
    Effect.gen(function* () {
      const destinationState = makeTestDestinationState<UpsertEntryCommand>();
      const storeState = InMemoryMigrationStore.makeState();
      const pipelineCalls: string[] = [];

      const definition = defineMigration({
        id: "articles",
        source: makeTestInMemorySource({
          items: [
            {
              identity: "article-1",
              version: "source-version-1",
              item: { title: "Already migrated" },
            },
            {
              identity: "article-2",
              version: "source-version-1",
              item: { title: "Already skipped" },
            },
            {
              identity: "article-3",
              version: "source-version-1",
              item: { title: "New article" },
            },
          ],
        }),
        destination: makeTestUpsertEntryDestination({
          state: destinationState,
        }),
        store: InMemoryMigrationStore.layer(storeState),
        pipeline: (source) =>
          Effect.sync(() => {
            pipelineCalls.push(source.identity);

            return {
              kind: "UpsertEntry" as const,
              contentType: "article",
              fields: {
                title: source.item.title,
              },
            };
          }),
      });

      const previousRunId = toMigrationRunId("run-previous");
      const previousUpdatedAt = new Date("2026-01-01T00:00:00.000Z");

      storeState.itemStates.set(
        InMemoryMigrationStore.itemStateKey("articles", "article-1"),
        {
          definitionId: toMigrationDefinitionId("articles"),
          sourceIdentity: toSourceIdentity("article-1"),
          sourceVersion: toSourceVersion("source-version-1"),
          lastRunId: previousRunId,
          updatedAt: previousUpdatedAt,
          status: "migrated",
          destinationIdentity: toDestinationIdentity("entry-article-1"),
        }
      );
      storeState.itemStates.set(
        InMemoryMigrationStore.itemStateKey("articles", "article-2"),
        {
          definitionId: toMigrationDefinitionId("articles"),
          sourceIdentity: toSourceIdentity("article-2"),
          sourceVersion: toSourceVersion("source-version-1"),
          lastRunId: previousRunId,
          updatedAt: previousUpdatedAt,
          status: "skipped",
          skipReason: "No destination needed",
        }
      );

      const summary = yield* runMigration(definition);

      expect(summary.definitions[0]?.counts).toEqual({
        migrated: 1,
        skipped: 0,
        failed: 0,
        unchanged: 2,
        needsUpdate: 0,
      });
      expect(pipelineCalls).toEqual(["article-3"]);
      expect(
        destinationState.executions.map(
          (execution) => execution.context.sourceIdentity
        )
      ).toEqual(["article-3"]);
      expect(
        storeState.itemStates.get(
          InMemoryMigrationStore.itemStateKey("articles", "article-1")
        )
      ).toEqual(
        expect.objectContaining({
          status: "migrated",
          lastRunId: previousRunId,
          updatedAt: previousUpdatedAt,
        })
      );
      expect(
        storeState.itemStates.get(
          InMemoryMigrationStore.itemStateKey("articles", "article-2")
        )
      ).toEqual(
        expect.objectContaining({
          status: "skipped",
          lastRunId: previousRunId,
          updatedAt: previousUpdatedAt,
        })
      );
    })
  );

  it.effect("reprocesses Source Items when Source Version changes", () =>
    Effect.gen(function* () {
      const destinationState = makeTestDestinationState<UpsertEntryCommand>();
      const storeState = InMemoryMigrationStore.makeState();
      const pipelineCalls: string[] = [];

      const definition = defineMigration({
        id: "articles",
        source: makeTestInMemorySource({
          items: [
            {
              identity: "article-1",
              version: "source-version-2",
              item: { title: "Updated article" },
            },
          ],
        }),
        destination: makeTestUpsertEntryDestination({
          state: destinationState,
          execute: (_command, context) => ({
            destinationIdentity: `entry-${context.sourceIdentity}`,
            destinationVersion: "destination-version-2",
          }),
        }),
        store: InMemoryMigrationStore.layer(storeState),
        pipeline: (source, context) =>
          Effect.sync(() => {
            pipelineCalls.push(
              `${source.identity}:${context.previousState?.sourceVersion}`
            );

            return {
              kind: "UpsertEntry" as const,
              contentType: "article",
              fields: {
                title: source.item.title,
              },
            };
          }),
      });

      storeState.itemStates.set(
        InMemoryMigrationStore.itemStateKey("articles", "article-1"),
        {
          definitionId: toMigrationDefinitionId("articles"),
          sourceIdentity: toSourceIdentity("article-1"),
          sourceVersion: toSourceVersion("source-version-1"),
          lastRunId: toMigrationRunId("run-previous"),
          updatedAt: new Date("2026-01-01T00:00:00.000Z"),
          status: "migrated",
          destinationIdentity: toDestinationIdentity("entry-article-1"),
          destinationVersion: toDestinationVersion("destination-version-1"),
        }
      );

      const summary = yield* runMigration(definition);

      expect(summary.definitions[0]?.counts).toEqual({
        migrated: 1,
        skipped: 0,
        failed: 0,
        unchanged: 0,
        needsUpdate: 0,
      });
      expect(pipelineCalls).toEqual(["article-1:source-version-1"]);
      expect(destinationState.executions).toHaveLength(1);
      expect(destinationState.executions[0]?.context.previousState).toEqual(
        expect.objectContaining({
          status: "migrated",
          sourceVersion: "source-version-1",
        })
      );
      expect(
        storeState.itemStates.get(
          InMemoryMigrationStore.itemStateKey("articles", "article-1")
        )
      ).toEqual(
        expect.objectContaining({
          status: "migrated",
          sourceVersion: "source-version-2",
          destinationVersion: "destination-version-2",
          lastRunId: summary.runId,
        })
      );
    })
  );

  it.effect(
    "expands selected Migration Definitions and executes dependencies first",
    () =>
      Effect.gen(function* () {
        const destinationState = makeTestDestinationState<UpsertEntryCommand>();
        const storeState = InMemoryMigrationStore.makeState();
        const store = InMemoryMigrationStore.layer(storeState);
        const executionOrder: string[] = [];

        const authors = defineMigration({
          id: "authors",
          source: makeTestInMemorySource({
            items: [
              {
                identity: "author-1",
                version: "source-version-1",
                item: { name: "Ada" },
              },
            ],
          }),
          destination: makeTestUpsertEntryDestination({
            state: destinationState,
          }),
          store,
          pipeline: (source) =>
            Effect.sync(() => {
              executionOrder.push(`authors:${source.identity}`);

              return {
                kind: "UpsertEntry" as const,
                contentType: "author",
                fields: {
                  name: source.item.name,
                },
              };
            }),
        });
        const articles = defineMigration({
          id: "articles",
          dependsOn: ["authors"],
          source: makeTestInMemorySource({
            items: [
              {
                identity: "article-1",
                version: "source-version-1",
                item: { title: "Dependent article" },
              },
            ],
          }),
          destination: makeTestUpsertEntryDestination({
            state: destinationState,
          }),
          store,
          pipeline: (source) =>
            Effect.sync(() => {
              executionOrder.push(`articles:${source.identity}`);

              return {
                kind: "UpsertEntry" as const,
                contentType: "article",
                fields: {
                  title: source.item.title,
                },
              };
            }),
        });

        const summary = yield* runMigrations({
          definitions: [articles, authors],
          definitionIds: ["articles"],
        });

        expect(summary.status).toBe("succeeded");
        expect(
          summary.definitions.map((definition) => definition.definitionId)
        ).toEqual(["authors", "articles"]);
        expect(executionOrder).toEqual([
          "authors:author-1",
          "articles:article-1",
        ]);
        expect(
          destinationState.executions.map(
            (execution) => execution.context.definitionId
          )
        ).toEqual(["authors", "articles"]);
      })
  );

  it.effect(
    "summarizes selected dependencies once when also explicitly selected",
    () =>
      Effect.gen(function* () {
        const destinationState = makeTestDestinationState<UpsertEntryCommand>();
        const storeState = InMemoryMigrationStore.makeState();
        const store = InMemoryMigrationStore.layer(storeState);

        const authors = defineMigration({
          id: "authors",
          source: makeTestInMemorySource({
            items: [
              {
                identity: "author-1",
                version: "source-version-1",
                item: { name: "Ada" },
              },
            ],
          }),
          destination: makeTestUpsertEntryDestination({
            state: destinationState,
          }),
          store,
          pipeline: (source) =>
            Effect.succeed({
              kind: "UpsertEntry" as const,
              contentType: "author",
              fields: {
                name: source.item.name,
              },
            }),
        });
        const articles = defineMigration({
          id: "articles",
          dependsOn: ["authors"],
          source: makeTestInMemorySource({
            items: [
              {
                identity: "article-1",
                version: "source-version-1",
                item: { title: "Dependent article" },
              },
            ],
          }),
          destination: makeTestUpsertEntryDestination({
            state: destinationState,
          }),
          store,
          pipeline: (source) =>
            Effect.succeed({
              kind: "UpsertEntry" as const,
              contentType: "article",
              fields: {
                title: source.item.title,
              },
            }),
        });

        const summary = yield* runMigrations({
          definitions: [articles, authors],
          definitionIds: ["articles", "authors"],
        });

        expect(
          summary.definitions.map((definition) => definition.definitionId)
        ).toEqual(["authors", "articles"]);
        expect(summary.definitions).toHaveLength(2);
        expect(
          destinationState.executions.map(
            (execution) => execution.context.definitionId
          )
        ).toEqual(["authors", "articles"]);
      })
  );

  it.effect(
    "fails the caller item when lookup stub creation partially succeeds then fails",
    () =>
      Effect.gen(function* () {
        const storeState = InMemoryMigrationStore.makeState();
        const store = InMemoryMigrationStore.layer(storeState);
        const destinationAttempts: EntryCommand[] = [];
        const destination = makePublishFailingDestination(destinationAttempts);

        const authors = defineMigration({
          id: "authors",
          source: makeTestInMemorySource({
            items: [],
          }),
          destination,
          store,
          stub: ({ sourceIdentity }) =>
            Effect.succeed([
              {
                kind: "UpsertEntry" as const,
                contentType: "author",
                fields: {
                  title: `Stub ${sourceIdentity}`,
                },
              },
              {
                kind: "PublishEntry" as const,
                contentType: "author",
              },
            ]),
          pipeline: (source) =>
            Effect.succeed({
              kind: "UpsertEntry" as const,
              contentType: "author",
              fields: source.item as Record<string, unknown>,
            }),
        });
        const articles = defineMigration({
          id: "articles",
          source: makeTestInMemorySource({
            items: [
              {
                identity: "article-1",
                version: "source-version-1",
                item: { title: "Article with missing author" },
              },
            ],
          }),
          destination,
          store,
          pipeline: (source) =>
            Effect.gen(function* () {
              const references = yield* MigrationReferenceLookup;
              const author = yield* references.lookup({
                definitionId: "authors",
                sourceIdentity: "author-1",
                stub: true,
              });

              return {
                kind: "UpsertEntry" as const,
                contentType: "article",
                fields: {
                  title: source.item.title,
                  author: author?.destinationIdentity,
                },
              };
            }),
        });

        const summary = yield* runMigrations({
          definitions: [articles, authors],
          definitionIds: ["articles"],
        });

        expect(summary.status).toBe("failed");
        expect(
          summary.definitions.map((definition) => definition.definitionId)
        ).toEqual(["articles"]);
        expect(summary.definitions[0]?.counts).toEqual({
          migrated: 0,
          skipped: 0,
          failed: 1,
          unchanged: 0,
          needsUpdate: 0,
        });
        expect(destinationAttempts).toEqual([
          expect.objectContaining({
            kind: "UpsertEntry",
            contentType: "author",
          }),
          expect.objectContaining({
            kind: "PublishEntry",
            contentType: "author",
          }),
        ]);
        expect(
          storeState.itemStates.get(
            InMemoryMigrationStore.itemStateKey("authors", "author-1")
          )
        ).toEqual(
          expect.objectContaining({
            status: "failed",
            destinationIdentity: "entry-author-1",
            destinationVersion: "version-1",
            error: expect.objectContaining({
              kind: "destination",
              message: "Publish failed",
            }),
          })
        );
        expect(
          storeState.itemStates.get(
            InMemoryMigrationStore.itemStateKey("articles", "article-1")
          )
        ).toEqual(
          expect.objectContaining({
            status: "failed",
            error: expect.objectContaining({
              kind: "pipeline",
            }),
          })
        );
      })
  );

  it.effect(
    "looks up migrated references without requiring declared dependencies",
    () =>
      Effect.gen(function* () {
        const storeState = InMemoryMigrationStore.makeState();
        const store = InMemoryMigrationStore.layer(storeState);
        const destinationState = makeTestDestinationState<UpsertEntryCommand>();

        storeState.itemStates.set(
          InMemoryMigrationStore.itemStateKey("authors", "author-1"),
          {
            definitionId: toMigrationDefinitionId("authors"),
            sourceIdentity: toSourceIdentity("author-1"),
            sourceVersion: toSourceVersion("author-version-1"),
            destinationIdentity: toDestinationIdentity("author-entry-1"),
            destinationVersion: toDestinationVersion("author-destination-1"),
            lastRunId: toMigrationRunId("run-authors"),
            updatedAt: new Date("2026-01-01T00:00:00.000Z"),
            status: "migrated",
          }
        );

        const authors = defineMigration({
          id: "authors",
          source: makeTestInMemorySource({
            items: [],
          }),
          destination: makeTestUpsertEntryDestination({
            state: destinationState,
          }),
          store,
          pipeline: (source) =>
            Effect.succeed({
              kind: "UpsertEntry" as const,
              contentType: "author",
              fields: source.item as Record<string, unknown>,
            }),
        });
        const articles = defineMigration({
          id: "articles",
          source: makeTestInMemorySource({
            items: [
              {
                identity: "article-1",
                version: "source-version-1",
                item: { title: "Article with migrated author" },
              },
            ],
          }),
          destination: makeTestUpsertEntryDestination({
            state: destinationState,
          }),
          store,
          pipeline: (source) =>
            Effect.gen(function* () {
              const references = yield* MigrationReferenceLookup;
              const author = yield* references.lookup({
                definitionId: "authors",
                sourceIdentity: "author-1",
              });

              return {
                kind: "UpsertEntry" as const,
                contentType: "article",
                fields: {
                  title: source.item.title,
                  author: author?.destinationIdentity,
                },
              };
            }),
        });

        const summary = yield* runMigrations({
          definitions: [articles, authors],
          definitionIds: ["articles"],
        });

        expect(summary.status).toBe("succeeded");
        expect(
          summary.definitions.map((definition) => definition.definitionId)
        ).toEqual(["articles"]);
        expect(destinationState.executions).toHaveLength(1);
        expect(destinationState.executions[0]?.command.fields).toEqual({
          title: "Article with migrated author",
          author: "author-entry-1",
        });
      })
  );

  it.effect(
    "looks up migrated references from the referenced Migration Definition Store",
    () =>
      Effect.gen(function* () {
        const authorsStoreState = InMemoryMigrationStore.makeState();
        const articlesStoreState = InMemoryMigrationStore.makeState();
        const destinationState = makeTestDestinationState<UpsertEntryCommand>();

        authorsStoreState.itemStates.set(
          InMemoryMigrationStore.itemStateKey("authors", "author-1"),
          {
            definitionId: toMigrationDefinitionId("authors"),
            sourceIdentity: toSourceIdentity("author-1"),
            sourceVersion: toSourceVersion("author-version-1"),
            destinationIdentity: toDestinationIdentity("author-entry-1"),
            destinationVersion: toDestinationVersion("author-destination-1"),
            lastRunId: toMigrationRunId("run-authors"),
            updatedAt: new Date("2026-01-01T00:00:00.000Z"),
            status: "migrated",
          }
        );

        const authors = defineMigration({
          id: "authors",
          source: makeTestInMemorySource({
            items: [],
          }),
          destination: makeTestUpsertEntryDestination({
            state: destinationState,
          }),
          store: InMemoryMigrationStore.layer(authorsStoreState),
          pipeline: (source) =>
            Effect.succeed({
              kind: "UpsertEntry" as const,
              contentType: "author",
              fields: source.item as Record<string, unknown>,
            }),
        });
        const articles = defineMigration({
          id: "articles",
          source: makeTestInMemorySource({
            items: [
              {
                identity: "article-1",
                version: "source-version-1",
                item: { title: "Article with target-store author" },
              },
            ],
          }),
          destination: makeTestUpsertEntryDestination({
            state: destinationState,
          }),
          store: InMemoryMigrationStore.layer(articlesStoreState),
          pipeline: (source) =>
            Effect.gen(function* () {
              const references = yield* MigrationReferenceLookup;
              const author = yield* references.lookup({
                definitionId: "authors",
                sourceIdentity: "author-1",
              });

              return {
                kind: "UpsertEntry" as const,
                contentType: "article",
                fields: {
                  title: source.item.title,
                  author: author?.destinationIdentity,
                  authorVersion: author?.destinationVersion,
                },
              };
            }),
        });

        const summary = yield* runMigrations({
          definitions: [articles, authors],
          definitionIds: ["articles"],
        });

        expect(summary.status).toBe("succeeded");
        expect(
          summary.definitions.map((definition) => definition.definitionId)
        ).toEqual(["articles"]);
        expect(destinationState.executions).toHaveLength(1);
        expect(destinationState.executions[0]?.command.fields).toEqual({
          title: "Article with target-store author",
          author: "author-entry-1",
          authorVersion: "author-destination-1",
        });
        expect(
          articlesStoreState.itemStates.get(
            InMemoryMigrationStore.itemStateKey("authors", "author-1")
          )
        ).toBeUndefined();
        expect(
          authorsStoreState.itemStates.get(
            InMemoryMigrationStore.itemStateKey("authors", "author-1")
          )
        ).toEqual(
          expect.objectContaining({
            status: "migrated",
            destinationIdentity: "author-entry-1",
          })
        );
      })
  );

  it.effect("creates lookup stubs as needs-update references", () =>
    Effect.gen(function* () {
      const storeState = InMemoryMigrationStore.makeState();
      const store = InMemoryMigrationStore.layer(storeState);
      const destinationState = makeTestDestinationState<EntryCommand>();
      const destination = makeTestEntryDestination({
        state: destinationState,
        execute: (command, context) =>
          command.kind === "UpsertEntry"
            ? {
                destinationIdentity: `entry-${context.sourceIdentity}`,
                destinationVersion: "stub-version-1",
              }
            : {},
      });

      const authors = defineMigration({
        id: "authors",
        source: makeTestInMemorySource({
          items: [],
        }),
        destination,
        store,
        stub: ({ sourceIdentity }) =>
          Effect.succeed([
            {
              kind: "UpsertEntry" as const,
              contentType: "author",
              fields: {
                title: `Stub ${sourceIdentity}`,
              },
            },
            {
              kind: "PublishEntry" as const,
              contentType: "author",
            },
          ]),
        pipeline: (source) =>
          Effect.succeed({
            kind: "UpsertEntry" as const,
            contentType: "author",
            fields: source.item as Record<string, unknown>,
          }),
      });
      const articles = defineMigration({
        id: "articles",
        source: makeTestInMemorySource({
          items: [
            {
              identity: "article-1",
              version: "source-version-1",
              item: { title: "Article with stub author" },
            },
          ],
        }),
        destination,
        store,
        pipeline: (source) =>
          Effect.gen(function* () {
            const references = yield* MigrationReferenceLookup;
            const author = yield* references.lookup({
              definitionId: "authors",
              sourceIdentity: "author-1",
              stub: true,
            });

            return {
              kind: "UpsertEntry" as const,
              contentType: "article",
              fields: {
                title: source.item.title,
                author: author?.destinationIdentity,
                authorStatus: author?.status,
              },
            };
          }),
      });

      const summary = yield* runMigrations({
        definitions: [articles, authors],
        definitionIds: ["articles"],
      });

      expect(summary.status).toBe("succeeded");
      expect(
        destinationState.executions.map((execution) => [
          execution.context.definitionId,
          execution.command.kind,
        ])
      ).toEqual([
        ["authors", "UpsertEntry"],
        ["authors", "PublishEntry"],
        ["articles", "UpsertEntry"],
      ]);
      expect(
        storeState.itemStates.get(
          InMemoryMigrationStore.itemStateKey("authors", "author-1")
        )
      ).toEqual(
        expect.objectContaining({
          status: "needs-update",
          destinationIdentity: "entry-author-1",
          destinationVersion: "stub-version-1",
        })
      );
      expect(
        destinationState.executions[2]?.command.kind === "UpsertEntry"
          ? destinationState.executions[2].command.fields
          : undefined
      ).toEqual({
        title: "Article with stub author",
        author: "entry-author-1",
        authorStatus: "needs-update",
      });
    })
  );

  it.effect(
    "creates lookup stubs in the referenced Migration Definition Store",
    () =>
      Effect.gen(function* () {
        const authorsStoreState = InMemoryMigrationStore.makeState();
        const articlesStoreState = InMemoryMigrationStore.makeState();
        authorsStoreState.nextRunNumber = 41;
        const stubLockObservations: string[] = [];
        const destinationState = makeTestDestinationState<EntryCommand>();
        const destination = makeTestEntryDestination({
          state: destinationState,
          execute: (command, context) => {
            if (context.definitionId === toMigrationDefinitionId("authors")) {
              const lock = authorsStoreState.definitionLocks.get(
                toMigrationDefinitionId("authors")
              );

              stubLockObservations.push(
                `${command.kind}:${lock?.ownerRunId ?? "none"}`
              );
            }

            return command.kind === "UpsertEntry"
              ? {
                  destinationIdentity: `entry-${context.sourceIdentity}`,
                  destinationVersion: "stub-version-1",
                }
              : {};
          },
        });

        const authors = defineMigration({
          id: "authors",
          source: makeTestInMemorySource({
            items: [],
          }),
          destination,
          store: InMemoryMigrationStore.layer(authorsStoreState),
          stub: ({ sourceIdentity }) =>
            Effect.succeed([
              {
                kind: "UpsertEntry" as const,
                contentType: "author",
                fields: {
                  title: `Stub ${sourceIdentity}`,
                },
              },
              {
                kind: "PublishEntry" as const,
                contentType: "author",
              },
            ]),
          pipeline: (source) =>
            Effect.succeed({
              kind: "UpsertEntry" as const,
              contentType: "author",
              fields: source.item as Record<string, unknown>,
            }),
        });
        const articles = defineMigration({
          id: "articles",
          source: makeTestInMemorySource({
            items: [
              {
                identity: "article-1",
                version: "source-version-1",
                item: { title: "Article with target-owned stub author" },
              },
            ],
          }),
          destination,
          store: InMemoryMigrationStore.layer(articlesStoreState),
          pipeline: (source) =>
            Effect.gen(function* () {
              const references = yield* MigrationReferenceLookup;
              const author = yield* references.lookup({
                definitionId: "authors",
                sourceIdentity: "author-1",
                stub: true,
              });

              return {
                kind: "UpsertEntry" as const,
                contentType: "article",
                fields: {
                  title: source.item.title,
                  author: author?.destinationIdentity,
                  authorStatus: author?.status,
                },
              };
            }),
        });

        const summary = yield* runMigrations({
          definitions: [articles, authors],
          definitionIds: ["articles"],
        });

        expect(summary.status).toBe("succeeded");
        expect(
          summary.definitions.map((definition) => definition.definitionId)
        ).toEqual(["articles"]);
        expect(
          destinationState.executions.map((execution) => [
            execution.context.definitionId,
            execution.context.runId,
            execution.command.kind,
          ])
        ).toEqual([
          ["authors", "run-41", "UpsertEntry"],
          ["authors", "run-41", "PublishEntry"],
          ["articles", "run-1", "UpsertEntry"],
        ]);
        expect(stubLockObservations).toEqual([
          "UpsertEntry:run-41",
          "PublishEntry:run-41",
        ]);
        expect(authorsStoreState.definitionLocks.size).toBe(0);
        expect(
          authorsStoreState.latestRunStates.get(
            toMigrationDefinitionId("authors")
          )
        ).toEqual(
          expect.objectContaining({
            runId: toMigrationRunId("run-41"),
            status: "succeeded",
          })
        );
        expect(
          authorsStoreState.itemStates.get(
            InMemoryMigrationStore.itemStateKey("authors", "author-1")
          )
        ).toEqual(
          expect.objectContaining({
            status: "needs-update",
            lastRunId: "run-41",
            destinationIdentity: "entry-author-1",
            destinationVersion: "stub-version-1",
          })
        );
        expect(
          articlesStoreState.itemStates.get(
            InMemoryMigrationStore.itemStateKey("authors", "author-1")
          )
        ).toBeUndefined();
        expect(
          articlesStoreState.itemStates.get(
            InMemoryMigrationStore.itemStateKey("articles", "article-1")
          )
        ).toEqual(
          expect.objectContaining({
            status: "migrated",
            destinationIdentity: "entry-article-1",
          })
        );
        expect(
          destinationState.executions[2]?.command.kind === "UpsertEntry"
            ? destinationState.executions[2].command.fields
            : undefined
        ).toEqual({
          title: "Article with target-owned stub author",
          author: "entry-author-1",
          authorStatus: "needs-update",
        });
      })
  );

  it.effect(
    "uses the active referenced Migration Definition run for lookup stubs",
    () =>
      Effect.gen(function* () {
        const storeState = InMemoryMigrationStore.makeState();
        const store = InMemoryMigrationStore.layer(storeState);
        const stubLockObservations: string[] = [];
        const destinationState = makeTestDestinationState<EntryCommand>();
        const destination = makeTestEntryDestination({
          state: destinationState,
          execute: (command, context) => {
            if (context.definitionId === toMigrationDefinitionId("authors")) {
              const lock = storeState.definitionLocks.get(
                toMigrationDefinitionId("authors")
              );

              stubLockObservations.push(
                `${command.kind}:${lock?.ownerRunId ?? "none"}`
              );
            }

            return command.kind === "UpsertEntry"
              ? {
                  destinationIdentity: `entry-${context.sourceIdentity}`,
                  destinationVersion: "stub-version-1",
                }
              : {};
          },
        });

        const authors = defineMigration({
          id: "authors",
          source: makeTestInMemorySource({
            items: [],
          }),
          destination,
          store,
          stub: ({ sourceIdentity }) =>
            Effect.succeed([
              {
                kind: "UpsertEntry" as const,
                contentType: "author",
                fields: {
                  title: `Stub ${sourceIdentity}`,
                },
              },
              {
                kind: "PublishEntry" as const,
                contentType: "author",
              },
            ]),
          pipeline: (source) =>
            Effect.succeed({
              kind: "UpsertEntry" as const,
              contentType: "author",
              fields: source.item as Record<string, unknown>,
            }),
        });
        const articles = defineMigration({
          id: "articles",
          dependsOn: ["authors"],
          source: makeTestInMemorySource({
            items: [
              {
                identity: "article-1",
                version: "source-version-1",
                item: { title: "Article with active author stub" },
              },
            ],
          }),
          destination,
          store,
          pipeline: (source) =>
            Effect.gen(function* () {
              const references = yield* MigrationReferenceLookup;
              const author = yield* references.lookup({
                definitionId: "authors",
                sourceIdentity: "author-1",
                stub: true,
              });

              return {
                kind: "UpsertEntry" as const,
                contentType: "article",
                fields: {
                  title: source.item.title,
                  author: author?.destinationIdentity,
                  authorStatus: author?.status,
                },
              };
            }),
        });

        const summary = yield* runMigrations({
          definitions: [articles, authors],
          definitionIds: ["articles"],
        });

        expect(summary.status).toBe("succeeded");
        expect(
          summary.definitions.map((definition) => definition.definitionId)
        ).toEqual(["authors", "articles"]);
        expect(summary.definitions[0]).toEqual(
          expect.objectContaining({
            definitionId: toMigrationDefinitionId("authors"),
            counts: {
              migrated: 0,
              skipped: 0,
              failed: 0,
              unchanged: 0,
              needsUpdate: 0,
            },
          })
        );
        expect(summary.definitions[1]).toEqual(
          expect.objectContaining({
            definitionId: toMigrationDefinitionId("articles"),
            counts: {
              migrated: 1,
              skipped: 0,
              failed: 0,
              unchanged: 0,
              needsUpdate: 0,
            },
          })
        );
        expect(
          destinationState.executions.map((execution) => [
            execution.context.definitionId,
            execution.context.runId,
            execution.command.kind,
          ])
        ).toEqual([
          ["authors", "run-1", "UpsertEntry"],
          ["authors", "run-1", "PublishEntry"],
          ["articles", "run-1", "UpsertEntry"],
        ]);
        expect(stubLockObservations).toEqual([
          "UpsertEntry:run-1",
          "PublishEntry:run-1",
        ]);
        expect(storeState.definitionLocks.size).toBe(0);
        expect(
          storeState.itemStates.get(
            InMemoryMigrationStore.itemStateKey("authors", "author-1")
          )
        ).toEqual(
          expect.objectContaining({
            status: "needs-update",
            lastRunId: "run-1",
            destinationIdentity: "entry-author-1",
          })
        );
        expect(
          storeState.latestRunStates.get(toMigrationDefinitionId("authors"))
        ).toEqual(
          expect.objectContaining({
            runId: toMigrationRunId("run-1"),
            status: "succeeded",
          })
        );
      })
  );

  it.effect(
    "reuses the referenced Migration Definition run for multiple lookup stubs",
    () =>
      Effect.gen(function* () {
        const authorsStoreState = InMemoryMigrationStore.makeState();
        const articlesStoreState = InMemoryMigrationStore.makeState();
        authorsStoreState.nextRunNumber = 41;
        const stubLockObservations: string[] = [];
        const destinationState = makeTestDestinationState<EntryCommand>();
        const destination = makeTestEntryDestination({
          state: destinationState,
          execute: (command, context) => {
            if (context.definitionId === toMigrationDefinitionId("authors")) {
              const lock = authorsStoreState.definitionLocks.get(
                toMigrationDefinitionId("authors")
              );

              stubLockObservations.push(
                `${context.sourceIdentity}:${command.kind}:${lock?.ownerRunId ?? "none"}`
              );
            }

            return command.kind === "UpsertEntry"
              ? {
                  destinationIdentity: `entry-${context.sourceIdentity}`,
                  destinationVersion: "stub-version-1",
                }
              : {};
          },
        });

        const authors = defineMigration({
          id: "authors",
          source: makeTestInMemorySource({
            items: [],
          }),
          destination,
          store: InMemoryMigrationStore.layer(authorsStoreState),
          stub: ({ sourceIdentity }) =>
            Effect.succeed([
              {
                kind: "UpsertEntry" as const,
                contentType: "author",
                fields: {
                  title: `Stub ${sourceIdentity}`,
                },
              },
              {
                kind: "PublishEntry" as const,
                contentType: "author",
              },
            ]),
          pipeline: (source) =>
            Effect.succeed({
              kind: "UpsertEntry" as const,
              contentType: "author",
              fields: source.item as Record<string, unknown>,
            }),
        });
        const articles = defineMigration({
          id: "articles",
          source: makeTestInMemorySource({
            items: [
              {
                identity: "article-1",
                version: "source-version-1",
                item: {
                  title: "First article",
                  authorIdentity: "author-1",
                },
              },
              {
                identity: "article-2",
                version: "source-version-1",
                item: {
                  title: "Second article",
                  authorIdentity: "author-2",
                },
              },
            ],
          }),
          destination,
          store: InMemoryMigrationStore.layer(articlesStoreState),
          pipeline: (source) =>
            Effect.gen(function* () {
              const references = yield* MigrationReferenceLookup;
              const item = source.item as {
                readonly authorIdentity: string;
                readonly title: string;
              };
              const author = yield* references.lookup({
                definitionId: "authors",
                sourceIdentity: item.authorIdentity,
                stub: true,
              });

              return {
                kind: "UpsertEntry" as const,
                contentType: "article",
                fields: {
                  title: item.title,
                  author: author?.destinationIdentity,
                  authorStatus: author?.status,
                },
              };
            }),
        });

        const summary = yield* runMigrations({
          definitions: [articles, authors],
          definitionIds: ["articles"],
        });

        expect(summary.status).toBe("succeeded");
        expect(
          destinationState.executions
            .filter(
              (execution) =>
                execution.context.definitionId ===
                toMigrationDefinitionId("authors")
            )
            .map((execution) => [
              execution.context.sourceIdentity,
              execution.context.runId,
              execution.command.kind,
            ])
        ).toEqual([
          ["author-1", "run-41", "UpsertEntry"],
          ["author-1", "run-41", "PublishEntry"],
          ["author-2", "run-41", "UpsertEntry"],
          ["author-2", "run-41", "PublishEntry"],
        ]);
        expect(stubLockObservations).toEqual([
          "author-1:UpsertEntry:run-41",
          "author-1:PublishEntry:run-41",
          "author-2:UpsertEntry:run-41",
          "author-2:PublishEntry:run-41",
        ]);
        expect(
          authorsStoreState.latestRunStates.get(
            toMigrationDefinitionId("authors")
          )
        ).toEqual(
          expect.objectContaining({
            runId: toMigrationRunId("run-41"),
            status: "succeeded",
          })
        );
        expect(authorsStoreState.definitionLocks.size).toBe(0);
        expect(
          authorsStoreState.itemStates.get(
            InMemoryMigrationStore.itemStateKey("authors", "author-1")
          )
        ).toEqual(
          expect.objectContaining({
            status: "needs-update",
            lastRunId: "run-41",
            destinationIdentity: "entry-author-1",
          })
        );
        expect(
          authorsStoreState.itemStates.get(
            InMemoryMigrationStore.itemStateKey("authors", "author-2")
          )
        ).toEqual(
          expect.objectContaining({
            status: "needs-update",
            lastRunId: "run-41",
            destinationIdentity: "entry-author-2",
          })
        );
      })
  );

  it.effect(
    "deduplicates concurrent lookup stubs for the same Source Identity",
    () =>
      Effect.gen(function* () {
        const authorsStoreState = InMemoryMigrationStore.makeState();
        const articlesStoreState = InMemoryMigrationStore.makeState();
        authorsStoreState.nextRunNumber = 41;
        let stubPlanCalls = 0;
        const destinationAttempts: Array<{
          readonly command: EntryCommand;
          readonly definitionId: string;
          readonly runId: string;
          readonly sourceIdentity: string;
        }> = [];
        const firstStubStarted = yield* Deferred.make<void>();
        const releaseStub = yield* Deferred.make<void>();
        const destination = makeEffectEntryDestination((command, context) =>
          Effect.gen(function* () {
            destinationAttempts.push({
              command,
              definitionId: context.definitionId,
              runId: context.runId,
              sourceIdentity: context.sourceIdentity,
            });

            if (
              context.definitionId === toMigrationDefinitionId("authors") &&
              command.kind === "UpsertEntry"
            ) {
              yield* Deferred.succeed(firstStubStarted, undefined);
              yield* Deferred.await(releaseStub);
            }

            return command.kind === "UpsertEntry"
              ? {
                  destinationIdentity: `entry-${context.sourceIdentity}`,
                  destinationVersion: "stub-version-1",
                }
              : {};
          })
        );

        const authors = defineMigration({
          id: "authors",
          source: makeTestInMemorySource({
            items: [],
          }),
          destination,
          store: InMemoryMigrationStore.layer(authorsStoreState),
          stub: ({ sourceIdentity }) =>
            Effect.sync(() => {
              stubPlanCalls += 1;

              return [
                {
                  kind: "UpsertEntry" as const,
                  contentType: "author",
                  fields: {
                    title: `Stub ${sourceIdentity}`,
                  },
                },
                {
                  kind: "PublishEntry" as const,
                  contentType: "author",
                },
              ];
            }),
          pipeline: (source) =>
            Effect.succeed({
              kind: "UpsertEntry" as const,
              contentType: "author",
              fields: source.item as Record<string, unknown>,
            }),
        });
        const articles = defineMigration({
          id: "articles",
          source: makeTestInMemorySource({
            items: [
              {
                identity: "article-1",
                version: "source-version-1",
                item: { title: "Article with duplicate author lookups" },
              },
            ],
          }),
          destination,
          store: InMemoryMigrationStore.layer(articlesStoreState),
          pipeline: (source) =>
            Effect.gen(function* () {
              const references = yield* MigrationReferenceLookup;
              yield* Effect.gen(function* () {
                yield* Deferred.await(firstStubStarted);
                yield* Effect.yieldNow;
                yield* Effect.yieldNow;
                yield* Deferred.succeed(releaseStub, undefined);
              }).pipe(Effect.forkChild);
              const [firstAuthor, secondAuthor] = yield* Effect.all(
                [
                  references.lookup({
                    definitionId: "authors",
                    sourceIdentity: "author-1",
                    stub: true,
                  }),
                  references.lookup({
                    definitionId: "authors",
                    sourceIdentity: "author-1",
                    stub: true,
                  }),
                ],
                { concurrency: "unbounded" }
              );

              return {
                kind: "UpsertEntry" as const,
                contentType: "article",
                fields: {
                  title: source.item.title,
                  firstAuthor: firstAuthor?.destinationIdentity,
                  secondAuthor: secondAuthor?.destinationIdentity,
                },
              };
            }),
        });

        const summary = yield* runMigrations({
          definitions: [articles, authors],
          definitionIds: ["articles"],
        });

        expect(summary.status).toBe("succeeded");
        expect(stubPlanCalls).toBe(1);
        expect(
          destinationAttempts
            .filter(
              (attempt) =>
                attempt.definitionId === toMigrationDefinitionId("authors")
            )
            .map((attempt) => [
              attempt.sourceIdentity,
              attempt.runId,
              attempt.command.kind,
            ])
        ).toEqual([
          ["author-1", "run-41", "UpsertEntry"],
          ["author-1", "run-41", "PublishEntry"],
        ]);
        expect(destinationAttempts.at(-1)).toEqual(
          expect.objectContaining({
            definitionId: "articles",
            sourceIdentity: "article-1",
          })
        );
        expect(
          authorsStoreState.itemStates.get(
            InMemoryMigrationStore.itemStateKey("authors", "author-1")
          )
        ).toEqual(
          expect.objectContaining({
            status: "needs-update",
            lastRunId: "run-41",
            destinationIdentity: "entry-author-1",
          })
        );
      })
  );

  it.effect(
    "releases a target stub lock when the parent run is interrupted",
    () =>
      Effect.gen(function* () {
        const authorsStoreState = InMemoryMigrationStore.makeState();
        const articlesStoreState = InMemoryMigrationStore.makeState();
        authorsStoreState.nextRunNumber = 41;
        const stubStarted = yield* Deferred.make<void>();
        const destination = makeEffectEntryDestination((command, context) =>
          Effect.gen(function* () {
            if (
              context.definitionId === toMigrationDefinitionId("authors") &&
              command.kind === "UpsertEntry"
            ) {
              yield* Deferred.succeed(stubStarted, undefined);
              return yield* Effect.never;
            }

            return command.kind === "UpsertEntry"
              ? {
                  destinationIdentity: `entry-${context.sourceIdentity}`,
                  destinationVersion: "stub-version-1",
                }
              : {};
          })
        );

        const authors = defineMigration({
          id: "authors",
          source: makeTestInMemorySource({
            items: [],
          }),
          destination,
          store: InMemoryMigrationStore.layer(authorsStoreState),
          stub: ({ sourceIdentity }) =>
            Effect.succeed([
              {
                kind: "UpsertEntry" as const,
                contentType: "author",
                fields: {
                  title: `Stub ${sourceIdentity}`,
                },
              },
            ]),
          pipeline: (source) =>
            Effect.succeed({
              kind: "UpsertEntry" as const,
              contentType: "author",
              fields: source.item as Record<string, unknown>,
            }),
        });
        const articles = defineMigration({
          id: "articles",
          source: makeTestInMemorySource({
            items: [
              {
                identity: "article-1",
                version: "source-version-1",
                item: { title: "Interrupted stub article" },
              },
            ],
          }),
          destination,
          store: InMemoryMigrationStore.layer(articlesStoreState),
          pipeline: (source) =>
            Effect.gen(function* () {
              const references = yield* MigrationReferenceLookup;
              const author = yield* references.lookup({
                definitionId: "authors",
                sourceIdentity: "author-1",
                stub: true,
              });

              return {
                kind: "UpsertEntry" as const,
                contentType: "article",
                fields: {
                  title: source.item.title,
                  author: author?.destinationIdentity,
                },
              };
            }),
        });

        const fiber = yield* runMigrations({
          definitions: [articles, authors],
          definitionIds: ["articles"],
        }).pipe(Effect.forkChild({ startImmediately: true }));

        yield* Deferred.await(stubStarted);
        expect(authorsStoreState.definitionLocks.size).toBe(1);

        yield* Fiber.interrupt(fiber);

        expect(authorsStoreState.definitionLocks.size).toBe(0);
        expect(articlesStoreState.definitionLocks.size).toBe(0);
        expect(
          authorsStoreState.latestRunStates.get(
            toMigrationDefinitionId("authors")
          )
        ).toEqual(
          expect.objectContaining({
            runId: toMigrationRunId("run-41"),
            status: "failed",
          })
        );
      })
  );

  it.effect(
    "uses the first migrated reference from ordered Migration Definition lookups",
    () =>
      Effect.gen(function* () {
        const storeState = InMemoryMigrationStore.makeState();
        const store = InMemoryMigrationStore.layer(storeState);
        const destinationState = makeTestDestinationState<UpsertEntryCommand>();

        for (const [definitionId, destinationIdentity] of [
          ["staff-authors", "staff-entry-1"],
          ["guest-authors", "guest-entry-1"],
        ] as const) {
          storeState.itemStates.set(
            InMemoryMigrationStore.itemStateKey(definitionId, "author-1"),
            {
              definitionId: toMigrationDefinitionId(definitionId),
              sourceIdentity: toSourceIdentity("author-1"),
              sourceVersion: toSourceVersion("author-version-1"),
              destinationIdentity: toDestinationIdentity(destinationIdentity),
              lastRunId: toMigrationRunId(`run-${definitionId}`),
              updatedAt: new Date("2026-01-01T00:00:00.000Z"),
              status: "migrated",
            }
          );
        }

        const staffAuthors = defineMigration({
          id: "staff-authors",
          source: makeTestInMemorySource({
            items: [],
          }),
          destination: makeTestUpsertEntryDestination({
            state: destinationState,
          }),
          store,
          pipeline: (source) =>
            Effect.succeed({
              kind: "UpsertEntry" as const,
              contentType: "author",
              fields: source.item as Record<string, unknown>,
            }),
        });
        const guestAuthors = defineMigration({
          id: "guest-authors",
          source: makeTestInMemorySource({
            items: [],
          }),
          destination: makeTestUpsertEntryDestination({
            state: destinationState,
          }),
          store,
          pipeline: (source) =>
            Effect.succeed({
              kind: "UpsertEntry" as const,
              contentType: "author",
              fields: source.item as Record<string, unknown>,
            }),
        });
        const articles = defineMigration({
          id: "articles",
          source: makeTestInMemorySource({
            items: [
              {
                identity: "article-1",
                version: "source-version-1",
                item: { title: "Article with polymorphic author" },
              },
            ],
          }),
          destination: makeTestUpsertEntryDestination({
            state: destinationState,
          }),
          store,
          pipeline: (source) =>
            Effect.gen(function* () {
              const references = yield* MigrationReferenceLookup;
              const author = yield* references.lookup({
                definitionIds: ["staff-authors", "guest-authors"],
                sourceIdentity: "author-1",
              });

              return {
                kind: "UpsertEntry" as const,
                contentType: "article",
                fields: {
                  title: source.item.title,
                  author: author?.destinationIdentity,
                },
              };
            }),
        });

        const summary = yield* runMigrations({
          definitions: [articles, guestAuthors, staffAuthors],
          definitionIds: ["articles"],
        });

        expect(summary.status).toBe("succeeded");
        expect(destinationState.executions[0]?.command.fields).toEqual({
          title: "Article with polymorphic author",
          author: "staff-entry-1",
        });
      })
  );

  it.effect(
    "persists the identity-bearing result from a Destination Command Plan",
    () =>
      Effect.gen(function* () {
        const storeState = InMemoryMigrationStore.makeState();
        const destinationState =
          makeTestDestinationState<ArticleEntryCommand>();
        const destinationFixture = InMemoryDestinationTesting.fixtureEntries({
          contentType: "article",
          commands: {
            publishEntry: true,
            upsertEntry: { fields: ArticleEntryFields },
          },
        });
        destinationState.bind(destinationFixture);
        const destination = destinationFixture.destination;
        const definition = defineMigration({
          id: "articles",
          source: makeTestInMemorySource({
            items: [
              {
                identity: "article-1",
                version: "source-version-1",
                item: { title: "Published article" },
              },
            ],
          }),
          destination,
          store: InMemoryMigrationStore.layer(storeState),
          pipeline: (source) =>
            Effect.succeed([
              destination.commands.upsertEntry({
                title: source.item.title,
              }),
              destination.commands.publishEntry(),
            ]),
        });

        const summary = yield* runMigration(definition);

        expect(summary.status).toBe("succeeded");
        expect(
          destinationState.executions.map((execution) => execution.command.kind)
        ).toEqual(["UpsertEntry", "PublishEntry"]);
        expect(
          storeState.itemStates.get(
            InMemoryMigrationStore.itemStateKey("articles", "article-1")
          )
        ).toEqual(
          expect.objectContaining({
            status: "migrated",
            destinationIdentity: "entry:article:article-1",
            destinationVersion: "version:1",
          })
        );
      })
  );

  it.effect(
    "publishes in-memory entries without returning another identity",
    () =>
      Effect.gen(function* () {
        const storeState = InMemoryMigrationStore.makeState();
        const destinationState =
          makeTestDestinationState<ArticleEntryCommand>();
        const destinationFixture = InMemoryDestinationTesting.fixtureEntries({
          contentType: "article",
          commands: {
            publishEntry: true,
            upsertEntry: { fields: ArticleEntryFields },
          },
        });
        destinationState.bind(destinationFixture);
        const destination = destinationFixture.destination;
        const definition = defineMigration({
          id: "articles",
          source: makeTestInMemorySource({
            items: [
              {
                identity: "article-1",
                version: "source-version-1",
                item: { title: "Published by default article" },
              },
            ],
          }),
          destination,
          store: InMemoryMigrationStore.layer(storeState),
          pipeline: (source) =>
            Effect.succeed([
              destination.commands.upsertEntry({
                title: source.item.title,
              }),
              destination.commands.publishEntry(),
            ]),
        });

        const summary = yield* runMigration(definition);

        expect(summary.status).toBe("succeeded");
        expect(
          destinationState.executions.map((execution) => ({
            kind: execution.command.kind,
            result: execution.result,
          }))
        ).toEqual([
          {
            kind: "UpsertEntry",
            result: {
              destinationIdentity: "entry:article:article-1",
              destinationVersion: "version:1",
            },
          },
          {
            kind: "PublishEntry",
            result: {},
          },
        ]);
        expect(
          storeState.itemStates.get(
            InMemoryMigrationStore.itemStateKey("articles", "article-1")
          )
        ).toEqual(
          expect.objectContaining({
            status: "migrated",
            destinationIdentity: "entry:article:article-1",
            destinationVersion: "version:1",
          })
        );
        expect(destinationState.entries.get("article:article-1")).toEqual(
          expect.objectContaining({
            contentType: "article",
            fields: {
              title: "Published by default article",
            },
            published: true,
          })
        );
      })
  );

  it.effect("fails publishing an in-memory entry before it is upserted", () =>
    Effect.gen(function* () {
      const storeState = InMemoryMigrationStore.makeState();
      const destinationState = makeTestDestinationState<ArticleEntryCommand>();
      const destinationFixture = InMemoryDestinationTesting.fixtureEntries({
        contentType: "article",
        commands: {
          publishEntry: true,
          upsertEntry: { fields: ArticleEntryFields },
        },
      });
      destinationState.bind(destinationFixture);
      const destination = destinationFixture.destination;
      const definition = defineMigration({
        id: "articles",
        source: makeTestInMemorySource({
          items: [
            {
              identity: "article-1",
              version: "source-version-1",
              item: { title: "Publish-only article" },
            },
          ],
        }),
        destination,
        store: InMemoryMigrationStore.layer(storeState),
        pipeline: () => Effect.succeed(destination.commands.publishEntry()),
      });

      const summary = yield* runMigration(definition);

      expect(summary.status).toBe("failed");
      expect(destinationState.executeAttempts).toBe(1);
      expect(destinationState.executions).toEqual([]);
      expect(destinationState.entries.size).toBe(0);
      expect(
        storeState.itemStates.get(
          InMemoryMigrationStore.itemStateKey("articles", "article-1")
        )
      ).toEqual(
        expect.objectContaining({
          status: "failed",
          error: expect.objectContaining({
            message: "Cannot publish an in-memory entry before it is upserted",
          }),
        })
      );
    })
  );

  it.effect(
    "fails an empty Destination Command Plan before preserving a previous identity",
    () =>
      Effect.gen(function* () {
        const storeState = InMemoryMigrationStore.makeState();
        const destinationState = makeTestDestinationState<UpsertEntryCommand>();
        storeState.itemStates.set(
          InMemoryMigrationStore.itemStateKey("articles", "article-1"),
          {
            definitionId: toMigrationDefinitionId("articles"),
            sourceIdentity: toSourceIdentity("article-1"),
            sourceVersion: toSourceVersion("source-version-1"),
            destinationIdentity: toDestinationIdentity(
              "entry-article-previous"
            ),
            destinationVersion: toDestinationVersion("previous-version-1"),
            lastRunId: toMigrationRunId("run-previous"),
            updatedAt: new Date("2026-01-01T00:00:00.000Z"),
            status: "migrated",
          }
        );
        const definition = defineMigration({
          id: "articles",
          source: makeTestInMemorySource({
            items: [
              {
                identity: "article-1",
                version: "source-version-1",
                item: { title: "Empty plan article" },
              },
            ],
          }),
          destination: makeTestUpsertEntryDestination({
            state: destinationState,
          }),
          store: InMemoryMigrationStore.layer(storeState),
          pipeline: () => Effect.succeed([]),
        });

        const summary = yield* runMigrations({
          definitions: [definition],
          mode: { kind: "item", sourceIdentity: "article-1" },
        });

        expect(summary.status).toBe("failed");
        expect(destinationState.executions).toEqual([]);
        expect(
          storeState.itemStates.get(
            InMemoryMigrationStore.itemStateKey("articles", "article-1")
          )
        ).toEqual(
          expect.objectContaining({
            status: "failed",
            destinationIdentity: "entry-article-previous",
            destinationVersion: "previous-version-1",
            error: expect.objectContaining({
              kind: "destination",
              message:
                "Destination Command Plan must contain at least one Destination Command",
            }),
          })
        );
      })
  );

  it.effect(
    "fails a Destination Command Plan that produces multiple destination identities",
    () =>
      Effect.gen(function* () {
        const storeState = InMemoryMigrationStore.makeState();
        const destinationState = makeTestDestinationState<EntryCommand>();
        const definition = defineMigration({
          id: "articles",
          source: makeTestInMemorySource({
            items: [
              {
                identity: "article-1",
                version: "source-version-1",
                item: { title: "Multi identity article" },
              },
            ],
          }),
          destination: makeTestEntryDestination({
            state: destinationState,
            execute: (command, context) =>
              command.kind === "UpsertEntry"
                ? {
                    destinationIdentity: `entry-${context.sourceIdentity}`,
                    destinationVersion: "entry-version-1",
                  }
                : {
                    destinationIdentity: `published-${context.sourceIdentity}`,
                    destinationVersion: "published-version-1",
                  },
          }),
          store: InMemoryMigrationStore.layer(storeState),
          pipeline: (source) =>
            Effect.succeed([
              {
                kind: "UpsertEntry" as const,
                contentType: "article",
                fields: {
                  title: source.item.title,
                },
              },
              {
                kind: "PublishEntry" as const,
                contentType: "article",
              },
            ]),
        });

        const summary = yield* runMigration(definition);

        expect(summary.status).toBe("failed");
        expect(
          destinationState.executions.map((execution) => execution.command.kind)
        ).toEqual(["UpsertEntry", "PublishEntry"]);
        expect(
          storeState.itemStates.get(
            InMemoryMigrationStore.itemStateKey("articles", "article-1")
          )
        ).toEqual(
          expect.objectContaining({
            status: "failed",
            destinationIdentity: "entry-article-1",
            destinationVersion: "entry-version-1",
            error: expect.objectContaining({
              kind: "destination",
              message:
                "Destination Command Plan produced more than one Destination Identity",
            }),
          })
        );
      })
  );

  it.effect(
    "rejects statically known multi-identity Destination Command Plans before execution",
    () =>
      Effect.gen(function* () {
        const storeState = InMemoryMigrationStore.makeState();
        const destinationState = makeTestDestinationState<EntryCommand>();
        const definition = defineMigration({
          id: "articles",
          source: makeTestInMemorySource({
            items: [
              {
                identity: "article-1",
                version: "source-version-1",
                item: { title: "Static multi identity article" },
              },
            ],
          }),
          destination: makeTestMultiIdentityEntryDestination({
            state: destinationState,
          }),
          store: InMemoryMigrationStore.layer(storeState),
          pipeline: (source) =>
            Effect.succeed([
              {
                kind: "UpsertEntry" as const,
                contentType: "article",
                fields: {
                  title: source.item.title,
                },
              },
              {
                kind: "PublishEntry" as const,
                contentType: "article",
              },
            ]),
        });

        const summary = yield* runMigration(definition);

        expect(summary.status).toBe("failed");
        expect(destinationState.executions).toEqual([]);
        expect(
          storeState.itemStates.get(
            InMemoryMigrationStore.itemStateKey("articles", "article-1")
          )
        ).toEqual(
          expect.objectContaining({
            status: "failed",
            error: expect.objectContaining({
              kind: "destination",
              message:
                "Destination Command Plan contains more than one identity-bearing Destination Command",
            }),
          })
        );
      })
  );

  it.effect(
    "applies Destination Retry to each Destination Command independently",
    () =>
      Effect.gen(function* () {
        const storeState = InMemoryMigrationStore.makeState();
        const attempts: EntryCommand["kind"][] = [];
        let publishFailures = 1;
        const destination = {
          commandDefinitions: EntryPlugin.commandDefinitions,
          layer: Layer.sync(DestinationPlugin, () => ({
            execute: (command, context) =>
              Effect.gen(function* () {
                const typedCommand = yield* Schema.decodeUnknownEffect(
                  EntryCommand
                )(command).pipe(
                  Effect.mapError(
                    (cause) =>
                      new DestinationPluginError({
                        message:
                          "Destination command did not match command schema",
                        cause,
                      })
                  )
                );

                attempts.push(typedCommand.kind);

                if (
                  typedCommand.kind === "PublishEntry" &&
                  publishFailures > 0
                ) {
                  publishFailures -= 1;

                  return yield* new DestinationPluginError({
                    message: "Publish failed transiently",
                  });
                }

                return typedCommand.kind === "UpsertEntry"
                  ? {
                      destinationIdentity: toDestinationIdentity(
                        `entry-${context.sourceIdentity}`
                      ),
                    }
                  : {};
              }),
          })),
        };
        const definition = defineMigration({
          id: "articles",
          source: makeTestInMemorySource({
            items: [
              {
                identity: "article-1",
                version: "source-version-1",
                item: { title: "Retry publish article" },
              },
            ],
          }),
          destination,
          destinationRetry: (effect) =>
            effect.pipe(Effect.retry(Schedule.recurs(1))),
          store: InMemoryMigrationStore.layer(storeState),
          pipeline: (source) =>
            Effect.succeed([
              {
                kind: "UpsertEntry" as const,
                contentType: "article",
                fields: {
                  title: source.item.title,
                },
              },
              {
                kind: "PublishEntry" as const,
                contentType: "article",
              },
            ]),
        });

        const summary = yield* runMigration(definition);

        expect(summary.status).toBe("succeeded");
        expect(attempts).toEqual([
          "UpsertEntry",
          "PublishEntry",
          "PublishEntry",
        ]);
        expect(
          storeState.itemStates.get(
            InMemoryMigrationStore.itemStateKey("articles", "article-1")
          )
        ).toEqual(
          expect.objectContaining({
            status: "migrated",
            destinationIdentity: "entry-article-1",
          })
        );
      })
  );

  it.effect("uses the selected Migration Definition Store for run state", () =>
    Effect.gen(function* () {
      const unselectedStoreState = InMemoryMigrationStore.makeState();
      const selectedStoreState = InMemoryMigrationStore.makeState();

      const unselected = defineMigration({
        id: "unselected",
        source: makeTestInMemorySource({
          items: [
            {
              identity: "unselected-1",
              version: "source-version-1",
              item: { title: "Unselected" },
            },
          ],
        }),
        destination: makeTestUpsertEntryDestination({}),
        store: InMemoryMigrationStore.layer(unselectedStoreState),
        pipeline: (source) =>
          Effect.succeed({
            kind: "UpsertEntry" as const,
            contentType: "unselected",
            fields: {
              title: source.item.title,
            },
          }),
      });
      const selected = defineMigration({
        id: "selected",
        source: makeTestInMemorySource({
          items: [
            {
              identity: "selected-1",
              version: "source-version-1",
              item: { title: "Selected" },
            },
          ],
        }),
        destination: makeTestUpsertEntryDestination({}),
        store: InMemoryMigrationStore.layer(selectedStoreState),
        pipeline: (source) =>
          Effect.succeed({
            kind: "UpsertEntry" as const,
            contentType: "selected",
            fields: {
              title: source.item.title,
            },
          }),
      });

      const summary = yield* runMigrations({
        definitions: [unselected, selected],
        definitionIds: ["selected"],
      });

      expect(
        summary.definitions.map((definition) => definition.definitionId)
      ).toEqual(["selected"]);
      expect(unselectedStoreState.latestRunStates.size).toBe(0);
      expect(
        selectedStoreState.latestRunStates.get(
          toMigrationDefinitionId("selected")
        )
      ).toEqual(
        expect.objectContaining({
          status: "succeeded",
        })
      );
    })
  );

  it.effect(
    "rejects selected Migration Definitions that do not share a Migration Store",
    () =>
      Effect.gen(function* () {
        const authorsStoreState = InMemoryMigrationStore.makeState();
        const articlesStoreState = InMemoryMigrationStore.makeState();
        const destinationState = makeTestDestinationState<UpsertEntryCommand>();
        const pipelineCalls: string[] = [];

        const authors = defineMigration({
          id: "authors",
          source: makeTestInMemorySource({
            items: [
              {
                identity: "author-1",
                version: "source-version-1",
                item: { name: "Ada" },
              },
            ],
          }),
          destination: makeTestUpsertEntryDestination({
            state: destinationState,
          }),
          store: InMemoryMigrationStore.layer(authorsStoreState),
          pipeline: (source) =>
            Effect.sync(() => {
              pipelineCalls.push(source.identity);

              return {
                kind: "UpsertEntry" as const,
                contentType: "author",
                fields: {
                  name: source.item.name,
                },
              };
            }),
        });
        const articles = defineMigration({
          id: "articles",
          dependsOn: ["authors"],
          source: makeTestInMemorySource({
            items: [
              {
                identity: "article-1",
                version: "source-version-1",
                item: { title: "Split store article" },
              },
            ],
          }),
          destination: makeTestUpsertEntryDestination({
            state: destinationState,
          }),
          store: InMemoryMigrationStore.layer(articlesStoreState),
          pipeline: (source) =>
            Effect.sync(() => {
              pipelineCalls.push(source.identity);

              return {
                kind: "UpsertEntry" as const,
                contentType: "article",
                fields: {
                  title: source.item.title,
                },
              };
            }),
        });

        const error = yield* Effect.flip(
          runMigrations({
            definitions: [articles, authors],
            definitionIds: ["articles"],
          })
        );

        expect(error).toEqual(
          expect.objectContaining({
            _tag: "MigrationRuntimeError",
            message:
              "Migration Definitions in the same run must use the same Migration Store",
          })
        );
        expect(destinationState.executions).toEqual([]);
        expect(pipelineCalls).toEqual([]);
        expect(authorsStoreState.latestRunStates.size).toBe(0);
        expect(articlesStoreState.latestRunStates.size).toBe(0);
      })
  );

  it.effect(
    "rejects missing Migration Definition dependencies before execution",
    () =>
      Effect.gen(function* () {
        const destinationState = makeTestDestinationState<UpsertEntryCommand>();
        const storeState = InMemoryMigrationStore.makeState();
        const store = InMemoryMigrationStore.layer(storeState);
        const pipelineCalls: string[] = [];

        const articles = defineMigration({
          id: "articles",
          dependsOn: ["authors"],
          source: makeTestInMemorySource({
            items: [
              {
                identity: "article-1",
                version: "source-version-1",
                item: { title: "Article with missing dependency" },
              },
            ],
          }),
          destination: makeTestUpsertEntryDestination({
            state: destinationState,
          }),
          store,
          pipeline: (source) =>
            Effect.sync(() => {
              pipelineCalls.push(source.identity);

              return {
                kind: "UpsertEntry" as const,
                contentType: "article",
                fields: {
                  title: source.item.title,
                },
              };
            }),
        });

        const error = yield* Effect.flip(
          runMigrations({ definitions: [articles] })
        );

        expect(error).toEqual(
          expect.objectContaining({
            _tag: "MigrationRuntimeError",
            message: "Migration Definition was not found",
          })
        );
        expect(destinationState.executions).toEqual([]);
        expect(pipelineCalls).toEqual([]);
        expect(storeState.latestRunStates.size).toBe(0);
      })
  );

  it.effect(
    "rejects Migration Definition dependency cycles before execution",
    () =>
      Effect.gen(function* () {
        const destinationState = makeTestDestinationState<UpsertEntryCommand>();
        const storeState = InMemoryMigrationStore.makeState();
        const store = InMemoryMigrationStore.layer(storeState);
        const pipelineCalls: string[] = [];

        const authors = defineMigration({
          id: "authors",
          dependsOn: ["articles"],
          source: makeTestInMemorySource({
            items: [
              {
                identity: "author-1",
                version: "source-version-1",
                item: { name: "Ada" },
              },
            ],
          }),
          destination: makeTestUpsertEntryDestination({
            state: destinationState,
          }),
          store,
          pipeline: (source) =>
            Effect.sync(() => {
              pipelineCalls.push(source.identity);

              return {
                kind: "UpsertEntry" as const,
                contentType: "author",
                fields: {
                  name: source.item.name,
                },
              };
            }),
        });
        const articles = defineMigration({
          id: "articles",
          dependsOn: ["authors"],
          source: makeTestInMemorySource({
            items: [
              {
                identity: "article-1",
                version: "source-version-1",
                item: { title: "Cyclic article" },
              },
            ],
          }),
          destination: makeTestUpsertEntryDestination({
            state: destinationState,
          }),
          store,
          pipeline: (source) =>
            Effect.sync(() => {
              pipelineCalls.push(source.identity);

              return {
                kind: "UpsertEntry" as const,
                contentType: "article",
                fields: {
                  title: source.item.title,
                },
              };
            }),
        });

        const error = yield* Effect.flip(
          runMigrations({ definitions: [articles, authors] })
        );

        expect(error).toEqual(
          expect.objectContaining({
            _tag: "MigrationRuntimeError",
            message: "Migration Definition dependency cycle detected",
          })
        );
        expect(destinationState.executions).toEqual([]);
        expect(pipelineCalls).toEqual([]);
        expect(storeState.latestRunStates.size).toBe(0);
      })
  );

  it.effect(
    "acquires and releases the full Migration Definition Lock set around the run",
    () =>
      Effect.gen(function* () {
        const destinationState = makeTestDestinationState<UpsertEntryCommand>();
        const storeState = InMemoryMigrationStore.makeState();
        const store = InMemoryMigrationStore.layer(storeState);
        const lockObservations: string[] = [];

        const observeLocks = (phase: "authors" | "articles") => {
          for (const definitionId of ["authors", "articles"] as const) {
            const lock = storeState.definitionLocks.get(
              toMigrationDefinitionId(definitionId)
            );

            lockObservations.push(
              `${phase}:${definitionId}:${lock?.ownerRunId ?? "none"}`
            );
          }
        };

        const authors = defineMigration({
          id: "authors",
          source: makeTestInMemorySource({
            items: [
              {
                identity: "author-1",
                version: "source-version-1",
                item: { name: "Ada" },
              },
            ],
          }),
          destination: makeTestUpsertEntryDestination({
            state: destinationState,
          }),
          store,
          pipeline: (source) =>
            Effect.sync(() => {
              observeLocks("authors");

              return {
                kind: "UpsertEntry" as const,
                contentType: "author",
                fields: {
                  name: source.item.name,
                },
              };
            }),
        });
        const articles = defineMigration({
          id: "articles",
          dependsOn: ["authors"],
          source: makeTestInMemorySource({
            items: [
              {
                identity: "article-1",
                version: "source-version-1",
                item: { title: "Locked article" },
              },
            ],
          }),
          destination: makeTestUpsertEntryDestination({
            state: destinationState,
          }),
          store,
          pipeline: (source) =>
            Effect.sync(() => {
              observeLocks("articles");

              return {
                kind: "UpsertEntry" as const,
                contentType: "article",
                fields: {
                  title: source.item.title,
                },
              };
            }),
        });

        const summary = yield* runMigrations({
          definitions: [articles, authors],
        });

        expect(summary.status).toBe("succeeded");
        expect(lockObservations).toEqual([
          "authors:authors:run-1",
          "authors:articles:run-1",
          "articles:authors:run-1",
          "articles:articles:run-1",
        ]);
        expect(storeState.definitionLocks.size).toBe(0);
      })
  );

  it.effect("preserves the primary error when failRun cleanup fails", () =>
    Effect.gen(function* () {
      const destinationState = makeTestDestinationState<UpsertEntryCommand>();
      const storeState = InMemoryMigrationStore.makeState();
      const sourceError = new SourcePluginError({
        message: "Source read failed",
      });
      const failRunError = new MigrationStoreError({
        message: "Unable to mark failed run",
      });

      const definition = defineMigration({
        id: "articles",
        source: defineSourcePlugin({
          cursorSchema: InMemorySourceCursor,
          sourceSchema: Schema.Unknown,
          lookupStrategy: "scan",
          read: () => Effect.fail(sourceError),
          readByIdentity: () => Effect.succeed(null),
        }),
        destination: makeTestUpsertEntryDestination({
          state: destinationState,
        }),
        store: failRunFailingStoreLayer(storeState, failRunError),
        pipeline: () =>
          Effect.succeed({
            kind: "UpsertEntry" as const,
            contentType: "article",
            fields: {},
          }),
      });

      const error = yield* Effect.flip(runMigration(definition));
      const cause = error.cause as
        | {
            readonly failRunError?: unknown;
            readonly primaryError?: unknown;
          }
        | undefined;

      expect(error).toEqual(
        expect.objectContaining({
          _tag: "MigrationStoreError",
          message: "Unable to mark Migration Run failed",
        })
      );
      expect(cause?.primaryError).toBe(sourceError);
      expect(cause?.failRunError).toBe(failRunError);
      expect(destinationState.executions).toEqual([]);
      expect(storeState.definitionLocks.size).toBe(0);
    })
  );

  it.effect("surfaces Migration Definition Lock release failures", () =>
    Effect.gen(function* () {
      const destinationState = makeTestDestinationState<UpsertEntryCommand>();
      const storeState = InMemoryMigrationStore.makeState();
      const releaseError = new MigrationStoreError({
        message: "Unable to release Migration Definition Lock",
        cause: { definitionId: "articles" },
      });

      const definition = defineMigration({
        id: "articles",
        source: makeTestInMemorySource({
          items: [
            {
              identity: "article-1",
              version: "source-version-1",
              item: { title: "Release failure article" },
            },
          ],
        }),
        destination: makeTestUpsertEntryDestination({
          state: destinationState,
        }),
        store: releaseFailingStoreLayer(storeState, releaseError),
        pipeline: (source) =>
          Effect.succeed({
            kind: "UpsertEntry" as const,
            contentType: "article",
            fields: {
              title: source.item.title,
            },
          }),
      });

      const error = yield* Effect.flip(runMigration(definition));
      const cause = error.cause as
        | {
            readonly releaseFailures?: readonly {
              readonly definitionId: string;
              readonly error: unknown;
              readonly token: string;
            }[];
          }
        | undefined;

      expect(error).toEqual(
        expect.objectContaining({
          _tag: "MigrationStoreError",
          message: "Unable to release Migration Definition Lock set",
        })
      );
      expect(cause?.releaseFailures).toEqual([
        expect.objectContaining({
          definitionId: toMigrationDefinitionId("articles"),
          error: releaseError,
          token: "lock-1",
        }),
      ]);
      expect(destinationState.executions).toHaveLength(1);
      expect(storeState.definitionLocks.size).toBe(1);
      expect(
        storeState.latestRunStates.get(toMigrationDefinitionId("articles"))
      ).toEqual(
        expect.objectContaining({
          status: "succeeded",
        })
      );
    })
  );

  it.effect(
    "attempts every Migration Definition Lock release when cleanup fails",
    () =>
      Effect.gen(function* () {
        const destinationState = makeTestDestinationState<UpsertEntryCommand>();
        const storeState = InMemoryMigrationStore.makeState();
        const releaseError = new MigrationStoreError({
          message: "Unable to release Migration Definition Lock",
        });
        const releasedDefinitionIds: string[] = [];
        const store = releaseFailingStoreLayer(
          storeState,
          releaseError,
          (lock) => {
            releasedDefinitionIds.push(lock.definitionId);
          }
        );

        const authors = defineMigration({
          id: "authors",
          source: makeTestInMemorySource({
            items: [
              {
                identity: "author-1",
                version: "source-version-1",
                item: { name: "Ada" },
              },
            ],
          }),
          destination: makeTestUpsertEntryDestination({
            state: destinationState,
          }),
          store,
          pipeline: (source) =>
            Effect.succeed({
              kind: "UpsertEntry" as const,
              contentType: "author",
              fields: {
                name: source.item.name,
              },
            }),
        });
        const articles = defineMigration({
          id: "articles",
          dependsOn: ["authors"],
          source: makeTestInMemorySource({
            items: [
              {
                identity: "article-1",
                version: "source-version-1",
                item: { title: "Cleanup article" },
              },
            ],
          }),
          destination: makeTestUpsertEntryDestination({
            state: destinationState,
          }),
          store,
          pipeline: (source) =>
            Effect.succeed({
              kind: "UpsertEntry" as const,
              contentType: "article",
              fields: {
                title: source.item.title,
              },
            }),
        });

        const error = yield* Effect.flip(
          runMigrations({ definitions: [articles, authors] })
        );
        const cause = error.cause as
          | {
              readonly releaseFailures?: readonly {
                readonly definitionId: string;
                readonly error: unknown;
              }[];
            }
          | undefined;

        expect(error).toEqual(
          expect.objectContaining({
            _tag: "MigrationStoreError",
            message: "Unable to release Migration Definition Lock set",
          })
        );
        expect(releasedDefinitionIds).toEqual([
          toMigrationDefinitionId("authors"),
          toMigrationDefinitionId("articles"),
        ]);
        expect(cause?.releaseFailures).toEqual([
          expect.objectContaining({
            definitionId: toMigrationDefinitionId("authors"),
            error: releaseError,
          }),
          expect.objectContaining({
            definitionId: toMigrationDefinitionId("articles"),
            error: releaseError,
          }),
        ]);
        expect(storeState.definitionLocks.size).toBe(2);
      })
  );

  it.effect(
    "rejects concurrent Migration Definition Lock ownership before execution",
    () =>
      Effect.gen(function* () {
        const destinationState = makeTestDestinationState<UpsertEntryCommand>();
        const storeState = InMemoryMigrationStore.makeState();
        const store = InMemoryMigrationStore.layer(storeState);
        const pipelineCalls: string[] = [];

        storeState.definitionLocks.set(toMigrationDefinitionId("articles"), {
          definitionId: toMigrationDefinitionId("articles"),
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
          ownerRunId: toMigrationRunId("run-other"),
          token: toMigrationDefinitionLockToken("lock-other"),
        });

        const definition = defineMigration({
          id: "articles",
          source: makeTestInMemorySource({
            items: [
              {
                identity: "article-1",
                version: "source-version-1",
                item: { title: "Locked article" },
              },
            ],
          }),
          destination: makeTestUpsertEntryDestination({
            state: destinationState,
          }),
          store,
          pipeline: (source) =>
            Effect.sync(() => {
              pipelineCalls.push(source.identity);

              return {
                kind: "UpsertEntry" as const,
                contentType: "article",
                fields: {
                  title: source.item.title,
                },
              };
            }),
        });

        const error = yield* Effect.flip(runMigration(definition));

        expect(error).toEqual(
          expect.objectContaining({
            _tag: "MigrationStoreError",
            message: "Migration definition is already locked",
          })
        );
        expect(destinationState.executions).toEqual([]);
        expect(pipelineCalls).toEqual([]);
        expect(
          storeState.definitionLocks.get(toMigrationDefinitionId("articles"))
        ).toEqual(
          expect.objectContaining({
            ownerRunId: "run-other",
            token: "lock-other",
          })
        );
        expect(storeState.latestRunStates.size).toBe(0);
      })
  );

  it.effect(
    "rejects overlapping lock sets before executing earlier definitions",
    () =>
      Effect.gen(function* () {
        const destinationState = makeTestDestinationState<UpsertEntryCommand>();
        const storeState = InMemoryMigrationStore.makeState();
        const store = InMemoryMigrationStore.layer(storeState);
        const pipelineCalls: string[] = [];

        storeState.definitionLocks.set(toMigrationDefinitionId("authors"), {
          definitionId: toMigrationDefinitionId("authors"),
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
          ownerRunId: toMigrationRunId("run-other"),
          token: toMigrationDefinitionLockToken("lock-other"),
        });

        const authors = defineMigration({
          id: "authors",
          source: makeTestInMemorySource({
            items: [
              {
                identity: "author-1",
                version: "source-version-1",
                item: { name: "Ada" },
              },
            ],
          }),
          destination: makeTestUpsertEntryDestination({
            state: destinationState,
          }),
          store,
          pipeline: (source) =>
            Effect.sync(() => {
              pipelineCalls.push(source.identity);

              return {
                kind: "UpsertEntry" as const,
                contentType: "author",
                fields: {
                  name: source.item.name,
                },
              };
            }),
        });
        const articles = defineMigration({
          id: "articles",
          dependsOn: ["authors"],
          source: makeTestInMemorySource({
            items: [
              {
                identity: "article-1",
                version: "source-version-1",
                item: { title: "Locked article" },
              },
            ],
          }),
          destination: makeTestUpsertEntryDestination({
            state: destinationState,
          }),
          store,
          pipeline: (source) =>
            Effect.sync(() => {
              pipelineCalls.push(source.identity);

              return {
                kind: "UpsertEntry" as const,
                contentType: "article",
                fields: {
                  title: source.item.title,
                },
              };
            }),
        });

        const error = yield* Effect.flip(
          runMigrations({ definitions: [articles, authors] })
        );

        expect(error).toEqual(
          expect.objectContaining({
            _tag: "MigrationStoreError",
            message: "Migration definition is already locked",
          })
        );
        expect(destinationState.executions).toEqual([]);
        expect(pipelineCalls).toEqual([]);
        expect(storeState.latestRunStates.size).toBe(0);
        expect(storeState.definitionLocks).toEqual(
          new Map([
            [
              toMigrationDefinitionId("authors"),
              expect.objectContaining({
                ownerRunId: toMigrationRunId("run-other"),
                token: "lock-other",
              }),
            ],
          ])
        );
      })
  );
});
