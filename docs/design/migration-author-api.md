# Migration Author API

Audience: SDK users writing migrations.

Status: current process authoring model.

Migration definitions describe source access, durable store access, optional
dependencies, optional tracking contracts, and a required `process` function.
Destination work happens inline through normal Effect code.

```ts
const ArticleTracking = Tracking.record({
  id: "article-entry@v1",
  schema: Schema.Struct({
    entryId: Schema.String,
  }),
})

const entries = InMemoryDestination.makeEntries({
  contentType: "article",
  fields: Schema.Struct({
    title: Schema.String,
  }),
})

const articles = defineMigration({
  id: "articles",
  source,
  store,
  tracking: ArticleTracking,
  process: Effect.fn("articles.process")(function* (source) {
    const entry = yield* entries.entries.upsert({
      title: source.item.title,
    })

    yield* Tracking.setRecord({
      entryId: entry.entryId,
    })
  }),
})
```

The runtime provides scoped tracking services around each source item. A
successful item persists source identity, source version, status, and any
journal segment or tracking record produced by the process. A failed item keeps
the available process journal and normalized failure metadata.

## Execution Concurrency

Process and rollback pipelines run serially by default. Authors can set
definition defaults, and operators can override them from the CLI:

```ts
const articles = defineMigration({
  id: "articles",
  source,
  store,
  execution: {
    process: { concurrency: 4 },
    rollback: { concurrency: 2 },
  },
  process: Effect.fn("articles.process")(function* (source) {
    // destination writes
  }),
  rollback: Effect.fn("articles.rollback")(function* (state) {
    // destination deletes
  }),
})
```

`concurrency` accepts a positive integer or `"unbounded"`. The CLI exposes the
same command-local override as `migrate run --concurrency 4 ...` /
`migrate run -c 4 ...` and `migrate rollback --concurrency unbounded ...`.
Status source scans use the same command-local flag name for their own
source-scan concurrency. Plan output includes the effective policy for each
selected Migration Definition.

Concurrency controls how many source items have active pipeline Effects at the
same time. It does not replace per-item retry policy. Each concurrent pipeline
run can still retry, back off, and jitter through ordinary `.pipe()` semantics:

```ts
import { Effect, Schedule } from "effect"

const RetryDestinationWrite = Schedule.exponential("250 millis").pipe(
  Schedule.both(Schedule.recurs(3)),
  Schedule.jittered
)

const articles = defineMigration({
  id: "articles",
  source,
  store,
  execution: {
    process: { concurrency: 4 },
  },
  process: (source) => {
    const process = Effect.gen(function* () {
      const entry = yield* entries.entries.upsert({
        title: source.item.title,
      })

      yield* Tracking.setRecord({
        entryId: entry.entryId,
      })
    })

    return process.pipe(
      Effect.retry(RetryDestinationWrite),
      Effect.timeout("30 seconds")
    )
  },
})
```

With `process.concurrency = 4`, up to four source items can be in flight. Each
item owns its own retry schedule, so jitter prevents their retries from lining
up against the same destination dependency.

## Swappable Execution

The registry owns selection and planning. A swappable `MigrationExecutable`
service executes the resolved run or rollback plan.

```ts
import { Effect } from "effect"
import {
  MigrationDefinitionRegistry,
  MigrationExecutable,
} from "migrate-sdk"

const registry = MigrationDefinitionRegistry.make({
  id: "catalog-migration",
  definitions: [authors, articles],
})

const executableRegistry = registry.executable()

const program = Effect.gen(function* () {
  const plan = yield* executableRegistry.planRun({
    definitionIds: ["articles"],
    withDependencies: true,
    execution: {
      process: { concurrency: 4 },
    },
  })

  const executable = yield* MigrationExecutable
  return yield* executable.startRun(plan)
}).pipe(Effect.provide(MigrationExecutable.inline))
```

Executable registries carry a stable `id` even when running inline. Durable
adapters use the same id later to serialize an execution envelope and rehydrate
the registry in the workflow execution context.

`MigrationExecutable` exposes static helpers that delegate to the currently
provided service, matching the SDK's scoped helper style:

```ts
const program = Effect.gen(function* () {
  const plan = yield* registry.executable().planRun({
    definitionIds: ["articles"],
  })

  return yield* MigrationExecutable.startRun(plan)
}).pipe(Effect.provide(MigrationExecutable.inline))
```

The service object remains the adapter implementation contract:

```ts
export class MigrationExecutable extends Service<
  MigrationExecutable,
  {
    readonly startRun: (
      plan: MigrationDefinitionExecutableRunPlan
    ) => Effect.Effect<
      ExecutionStartResult<MigrationRunSummary>,
      MigrationExecutableRunError
    >

    readonly startRollback: (
      plan: MigrationDefinitionExecutableRollbackPlan
    ) => Effect.Effect<
      ExecutionStartResult<RollbackRunSummary>,
      MigrationExecutableRollbackError
    >
  }
>()("@migrate-sdk/MigrationExecutable") {
  static readonly startRun = (plan: MigrationDefinitionExecutableRunPlan) =>
    Effect.flatMap(MigrationExecutable, (executable) =>
      executable.startRun(plan)
    )

  static readonly startRollback = (
    plan: MigrationDefinitionExecutableRollbackPlan
  ) =>
    Effect.flatMap(MigrationExecutable, (executable) =>
      executable.startRollback(plan)
    )
}
```

`registry.executable()` narrows the registry to plans that can be executed. The
base registry can still be used for listing, diagnostics, and non-executing plan
rendering while migrations are being authored.

The narrowing is both a type-level and runtime boundary. Static registries should
surface missing `.provide(...)` calls through Effect requirements where
TypeScript can see them. Dynamic or generated registries should fail planning
with a typed runtime diagnostic:

```ts
import { Data } from "effect"

export interface MigrationRuntimeRequirement {
  readonly key: string
  readonly owner: "source" | "store" | "destination" | "process" | "definition"
  readonly label?: string
}

export class MigrationDefinitionRegistryExecutableError extends Data.TaggedError(
  "MigrationDefinitionRegistryExecutableError"
)<{
  readonly definitionId: MigrationDefinitionId
  readonly missingRequirements: ReadonlyArray<MigrationRuntimeRequirement>
}> {}

const plan = yield* registry.executable().planRun({
  definitionIds: ["articles"],
})
```

This keeps adapters simple: `MigrationExecutable` accepts only executable plans
and does not re-check whether a selected definition is fully wired.

Executable plans are distinct public types from ordinary registry plans. The
execution service should only accept plans produced by the executable registry
view:

```ts
declare const executablePlanTypeId: unique symbol

export type MigrationDefinitionExecutableRunPlan =
  MigrationDefinitionRunPlan & {
    readonly [executablePlanTypeId]: "run"
  }

export type MigrationDefinitionExecutableRollbackPlan =
  MigrationDefinitionRollbackPlan & {
    readonly [executablePlanTypeId]: "rollback"
  }
```

This is valid:

```ts
const plan = yield* registry.executable().planRun({
  definitionIds: ["articles"],
})

yield* MigrationExecutable.startRun(plan)
```

This should not type-check:

```ts
const plan = yield* registry.planRun({
  definitionIds: ["articles"],
})

yield* MigrationExecutable.startRun(plan)
```

Executable plans are in-process objects. They can contain resolved migration
definitions and Effect programs, so they should not be treated as durable
runtime payloads. Distributed adapters should derive a serializable execution
envelope from the plan:

```ts
export interface MigrationExecutionEnvelope {
  readonly runId: MigrationRunId
  readonly registryId: MigrationDefinitionRegistryId
  readonly kind: "run" | "rollback"
  readonly definitionIds: ReadonlyArray<MigrationDefinitionId>
  /** Diagnostic only; the workflow execution context re-plans before execution. */
  readonly plannedOrder: ReadonlyArray<MigrationDefinitionId>
  readonly request: RunRequest | RollbackRequest
}
```

Inline execution runs the executable plan directly. Durable workflow adapters
serialize the envelope, start a provider-owned workflow execution, and let that
workflow re-plan against the registry catalog in its own execution context.

The envelope is not a frozen executable plan. `registryId` and `request` are the
portable durable inputs. `plannedOrder` is diagnostic metadata for logs, status
views, and operator debugging; the workflow execution context still re-plans
before it does any work. Providers with immutable deployment boundaries should
let the provider keep already-started runs on their compatible code world.

The durable workflow handler must execute with `envelope.runId`; it must not
call the public `MigrationExecutable.startRun(plan)` or `startRollback(plan)`
after the durable adapter has already allocated a migration run id. Adapter
implementations can share an internal envelope executor with the inline
executable:

```ts
const executeMigrationEnvelope = Effect.fn("MigrationExecutionEnvelope.execute")(
  function* (envelope: MigrationExecutionEnvelope) {
    const registry = yield* MigrationDefinitionRegistryCatalog.get(
      envelope.registryId
    )

    if (envelope.kind === "run") {
      const plan = yield* registry.executable().planRun(envelope.request)

      yield* Effect.logDebug("migration envelope planned order", {
        runId: envelope.runId,
        scheduled: envelope.plannedOrder,
        execution: plan.plannedOrder,
      })

      return yield* MigrationInlineRuntime.executeRun(plan, {
        runId: envelope.runId,
      })
    }

    const plan = yield* registry.executable().planRollback(envelope.request)

    yield* Effect.logDebug("migration envelope planned order", {
      runId: envelope.runId,
      scheduled: envelope.plannedOrder,
      execution: plan.plannedOrder,
    })

    return yield* MigrationInlineRuntime.executeRollback(plan, {
      runId: envelope.runId,
    })
  }
)
```

The envelope executor is an adapter implementation helper, not a second public
start API. Public callers still start execution through `MigrationExecutable`;
workflow handlers use the helper only after a run id already exists.

The workflow execution should acquire the selected migration definition locks
before it starts processing and hold them for the duration of the provider-owned
workflow run. The workflow owns the locks; individual steps may run in parallel
inside that workflow, but another migration workflow cannot start an overlapping
run while those locks are held.

The workflow execution context resolves registries through a catalog service
instead of importing one concrete registry. A simple app can provide a one-entry
catalog:

```ts
const ApplicationMigrationLayers = Layer.mergeAll(
  MigrationDefinitionRegistryCatalog.layer({
    registries: [migrations],
  }),
  MigrationExecutable.inline
)
```

That keeps provider workflow entrypoints reusable while the host decides which
code-defined registries are available in the execution context.

`MigrationDefinitionRegistryCatalog.layer(...)` should reject duplicate registry
ids during layer construction. A lookup should fail only when the requested
registry id is missing from the catalog:

```ts
MigrationDefinitionRegistryCatalog.layer({
  registries: [catalogMigrations, backfillMigrations],
})
```

Each call to `MigrationExecutable.startRun(plan)` or `startRollback(plan)`
creates a new `MigrationRunId`. The SDK should not implicitly deduplicate
repeated calls by plan shape. Overlapping execution is rejected by migration
definition locks, not hidden start idempotency.

The executable allocates `MigrationRunId` when `startRun` or `startRollback` is
called. Registry planning remains pure and does not create a run id. Durable
workflow handlers must execute using `envelope.runId`; they must not allocate a
second migration run id after the provider workflow starts.

Durable adapters should create the initial migration run state before returning
`started`, so `MigrationExecution.waitForRun(envelope.runId)` can find the run
immediately after the caller receives the start result. The provider workflow
transitions that existing state from queued to running and then to a terminal
state; it is not the first writer for the migration run id.

If a provider rejects the start request after the queued state has been created,
`startRun` or `startRollback` should fail and mark the migration run state as
`start-failed`. That keeps the run visible for operator diagnosis without
leaving an unaccepted run permanently queued.

If a provider accepts the run but `attachExecution` fails, `startRun` or
`startRollback` should fail with `MigrationExecutionAttachError` and include the
adapter execution identity. It should not return `started`, because observing by
`MigrationRunId` would not reliably find the adapter execution handle.

### Workflow SDK Adapter

Workflow SDK execution serializes the envelope and starts a code-defined
workflow function with `start(workflow, [envelope], startOptions)`. Per the
Workflow SDK [starting workflows](https://workflow-sdk.dev/docs/foundations/starting-workflows)
and [serialization](https://workflow-sdk.dev/docs/foundations/serialization)
docs, `start()` returns immediately after enqueuing a run, every argument must
be serializable, and `run.returnValue` is an observation boundary that waits for
completion.

Workflow SDK [`"use workflow"` functions](https://workflow-sdk.dev/docs/foundations/workflows-and-steps)
orchestrate durable work without full Node.js runtime access. The Effect
migration runtime should therefore execute inside a `"use step"` function called
by the workflow:

```ts
import { start } from "workflow/api"

export async function runMigrationExecutionWorkflow(
  envelope: MigrationExecutionEnvelope
) {
  "use workflow"

  return await executeMigrationEnvelopeStep(envelope)
}

async function executeMigrationEnvelopeStep(
  envelope: MigrationExecutionEnvelope
) {
  "use step"

  return await Effect.runPromise(
    executeMigrationEnvelope(envelope).pipe(
      Effect.provide(ApplicationMigrationLayers)
    )
  )
}
```

The Workflow SDK adapter starts that workflow with the envelope:

```ts
const envelope: MigrationExecutionEnvelope = {
  runId: MigrationRunId.make(),
  registryId: plan.registryId,
  kind: "run",
  definitionIds: plan.definitionIds,
  plannedOrder: plan.plannedOrder,
  request: plan.request,
}

yield* MigrationRunStateStore.createQueued({
  runId: envelope.runId,
  registryId: envelope.registryId,
  kind: envelope.kind,
  definitionIds: envelope.definitionIds,
})

const run = yield* Effect.tryPromise({
  try: () => start(runMigrationExecutionWorkflow, [envelope], startOptions),
  catch: (cause) =>
    new MigrationExecutionStartError({
      runId: envelope.runId,
      adapter: "workflow-sdk",
      cause,
    }),
}).pipe(
  Effect.tapError((error) =>
    MigrationRunStateStore.markStartFailed({
      runId: envelope.runId,
      error,
    })
  )
)

const execution = {
  adapter: "workflow-sdk",
  workflowRunId: run.runId,
} as const

yield* MigrationRunStateStore.attachExecution({
  runId: envelope.runId,
  execution,
}).pipe(
  Effect.mapError(
    (cause) =>
      new MigrationExecutionAttachError({
        runId: envelope.runId,
        execution,
        cause,
      })
  )
)

return {
  kind: "started",
  runId: envelope.runId,
  execution,
} satisfies ExecutionStartResult<MigrationRunSummary>
```

The Workflow SDK adapter should always return `started` after `start()` returns.
It should not await `run.returnValue` inside `startRun` or `startRollback`; that
would turn the scheduling boundary into an observation boundary. Workflow SDK
pins runs to the deployment that starts them by default according to its
[versioning](https://workflow-sdk.dev/docs/foundations/versioning) model. Runs
explicitly started with `deploymentId: "latest"` cross a version boundary and
should rely on backward-compatible envelope schemas.

Callers can provide the Workflow SDK adapter as the `MigrationExecutable` layer:

```ts
const program = registry
  .executable()
  .planRun({ all: true })
  .pipe(
    Effect.flatMap((plan) => MigrationExecutable.startRun(plan)),
    Effect.provide(
      WorkflowSdkMigrationExecutable.layer({
        workflow: runMigrationExecutionWorkflow,
        startOptions,
      })
    )
  )
```

### Effect Workflow Adapter

Effect workflows can use the same envelope, but the provider boundary is an
Effect `Workflow` value and a `WorkflowEngine` layer. The API currently lives
under `effect/unstable/workflow`, so this adapter should be treated as
experimental until that Effect API stabilizes.

```ts
import { Schema } from "effect"
import { Workflow } from "effect/unstable/workflow"

export const MigrationExecutionEnvelopeSchema = Schema.Struct({
  runId: MigrationRunId,
  registryId: MigrationDefinitionRegistryId,
  kind: Schema.Literals(["run", "rollback"]),
  definitionIds: Schema.Array(MigrationDefinitionId),
  plannedOrder: Schema.Array(MigrationDefinitionId),
  request: Schema.Union(RunRequest, RollbackRequest),
})

export const MigrationRunWorkflow = Workflow.make({
  name: "MigrationRunWorkflow",
  payload: MigrationExecutionEnvelopeSchema,
  success: Schema.Union(MigrationRunSummary, RollbackRunSummary),
  error: MigrationExecutionEnvelopeError,
  idempotencyKey: (envelope) => envelope.runId,
})

export const MigrationRunWorkflowLayer = MigrationRunWorkflow.toLayer(
  Effect.fn("MigrationRunWorkflow")(function* (envelope) {
    return yield* executeMigrationEnvelope(envelope)
  })
)
```

Use `envelope.runId` as the workflow `idempotencyKey`. Effect derives a stable
workflow execution id from the workflow name and idempotency key; using the
migration run id preserves the SDK rule that every public start call creates a
new migration run. If caller-supplied idempotency is added later, it should be a
separate explicit request field rather than a hidden plan-shape hash.

The Effect workflow adapter starts the workflow with `discard: true`, receives
the provider execution id immediately, and returns `started`:

```ts
const envelope = MigrationExecutionEnvelope.fromPlan({
  runId: MigrationRunId.make(),
  plan,
})

yield* MigrationRunStateStore.createQueued({
  runId: envelope.runId,
  registryId: envelope.registryId,
  kind: envelope.kind,
  definitionIds: envelope.definitionIds,
})

const executionId = yield* MigrationRunWorkflow.execute(envelope, {
  discard: true,
}).pipe(
  Effect.mapError(
    (cause) =>
      new MigrationExecutionStartError({
        runId: envelope.runId,
        adapter: "effect-workflow",
        cause,
      })
  ),
  Effect.tapError((error) =>
    MigrationRunStateStore.markStartFailed({
      runId: envelope.runId,
      error,
    })
  )
)

const execution = {
  adapter: "effect-workflow",
  executionId,
} as const

yield* MigrationRunStateStore.attachExecution({
  runId: envelope.runId,
  execution,
})

return {
  kind: "started",
  runId: envelope.runId,
  execution,
} satisfies ExecutionStartResult<MigrationRunSummary>
```

The application layer must provide both the workflow handler and a workflow
engine. `WorkflowEngine.layerMemory` is suitable for tests and local
development only; production durability requires a durable engine such as the
cluster workflow engine with sharding and message storage.

```ts
import { WorkflowEngine } from "effect/unstable/workflow"

const EffectWorkflowMigrationLayer = Layer.mergeAll(
  MigrationRunWorkflowLayer,
  EffectWorkflowMigrationExecutable.layer({
    workflow: MigrationRunWorkflow,
  }),
  WorkflowEngine.layerMemory
).pipe(Layer.provide(ApplicationMigrationLayers))
```

Observation and control can also use the Effect workflow operations when the
stored execution handle is an Effect workflow handle:

```ts
const start = yield* MigrationExecutable.startRun(plan)

if (start.kind === "started" && start.execution.adapter === "effect-workflow") {
  const result = yield* MigrationRunWorkflow.poll(start.execution.executionId)
  yield* MigrationRunWorkflow.interrupt(start.execution.executionId)
  yield* MigrationRunWorkflow.resume(start.execution.executionId)
}
```

`MigrationExecutable.inline` uses the built-in runtime and returns a completed
summary:

```ts
const result = yield* executable.startRun(plan)

if (result.kind === "completed") {
  console.log(result.runId, result.summary.status)
}
```

A durable workflow adapter returns after accepting or scheduling the run:

```ts
const result = yield* executable.startRun(plan)

if (result.kind === "started") {
  console.log(result.runId, result.execution)
}
```

Both result variants expose the migration run id at the top level. Started
results may also expose adapter execution metadata, such as a Workflow SDK run id
or an Effect workflow execution id used for provider-native observability:

```ts
export type MigrationExecutionHandle =
  | {
      readonly adapter: "workflow-sdk"
      readonly workflowRunId: string
    }
  | {
      readonly adapter: "effect-workflow"
      readonly executionId: string
    }

export type ExecutionStartResult<Summary> =
  | {
      readonly kind: "completed"
      readonly runId: MigrationRunId
      readonly summary: Summary
    }
  | {
      readonly kind: "started"
      readonly runId: MigrationRunId
      readonly execution: MigrationExecutionHandle
    }
```

For inline execution, `runId` duplicates `summary.runId` so callers can log,
render, or correlate a run before branching on completion state.

The default layer is named `MigrationExecutable.inline`, not `live` or
`layerInline`, because inline is the execution strategy being selected:

```ts
const result = yield* MigrationExecutable.startRun(plan).pipe(
  Effect.provide(MigrationExecutable.inline)
)
```

`startRun` and `startRollback` only start execution. Inline execution returns
`completed` because the built-in runtime has already finished in the current
process. Durable workflow adapters return `started`; waiting for completion,
reading provider return values, streaming progress, or cancelling a run should be
modeled as a separate execution-management capability.

Execution management is intentionally not part of `MigrationExecutable`. A
future `MigrationExecution` service can wait for a run, read run state, stream
progress, cancel a run, or bridge to an adapter-specific workflow backend without
changing the execution start contract. Its stable public key should be the
migration run id:

```ts
const start = yield* MigrationExecutable.startRun(plan)

const summary = yield* MigrationExecution.waitForRun(start.runId)
```

The execution-management service can resolve adapter execution metadata from
the migration run state when a durable adapter has stored it. Callers that
intentionally want native Workflow SDK observability can still use the adapter
handle from the start result:

```ts
if (start.kind === "started" && start.execution.adapter === "workflow-sdk") {
  const run = getRun(start.execution.workflowRunId)
  const status = await run.status
}
```

The executable receives a plan, not raw registry selection input. This keeps
dependency expansion, rollback order, target normalization, and effective
execution policy in one registry planning path while allowing the execution
strategy to be replaced.

Definitions inside executable plans should be fully provided. Runtime service
requirements are erased while configuring sources, stores, and destination
capability modules, not at the `startRun` or `startRollback` call site:

```ts
const source = SqlSource.make({
  // source options
}).provide(sourceSql.layer)

const destination = CommercetoolsDestination.make().provide(commercetools.layer)

const articles = defineMigration({
  id: "articles",
  source,
  store,
  tracking: ArticleTracking,
  process: Effect.fn("articles.process")(function* (source) {
    const entry = yield* destination.entries.upsert({
      title: source.item.title,
    })

    yield* Tracking.setRecord({
      entryId: entry.entryId,
    })
  }),
})
```

The execution boundary then has no caller-provided migration service
requirements:

```ts
const result = yield* registry
  .executable()
  .planRun({ definitionIds: ["articles"] })
  .pipe(
    Effect.flatMap((plan) => MigrationExecutable.startRun(plan)),
    Effect.provide(MigrationExecutable.inline)
  )
```

This should be treated as unfinished authoring for executable plans because the
source still requires its SQL service:

```ts
const source = SqlSource.make({
  // source options
})
```

Generated or dynamic registries can report runtime authoring gaps explicitly
when static Effect requirements are not enough:

```ts
const registry = MigrationDefinitionRegistry.make({
  definitions,
  missingRequirements: (definition) =>
    definition.id === "articles"
      ? [{ key: "SqlClient", label: "SQL client layer", owner: "source" }]
      : [],
})

const plan = yield* registry.executable().planRun({ definitionIds: ["articles"] })
// fails with MigrationDefinitionRegistryExecutableError { missingRequirements }
```

Execution adapters may still have their own requirements. For Workflow SDK, the
adapter should configure the workflow function and optional `start()` options,
not queues, workers, or registry identity:

```ts
const result = yield* registry
  .executable()
  .planRun({ all: true })
  .pipe(
    Effect.flatMap((plan) => MigrationExecutable.startRun(plan)),
    Effect.provide(
      WorkflowSdkMigrationExecutable.layer({
        workflow: runMigrationExecutionWorkflow,
        startOptions,
      })
    )
  )
```

Execution adapters are selected with layers. The caller provides the adapter
layer once at the program boundary, and the execution call stays the same:

```ts
const executableLayer =
  process.env.MIGRATE_EXECUTOR === "workflow-sdk"
    ? WorkflowSdkMigrationExecutable.layer({
        workflow: runMigrationExecutionWorkflow,
        startOptions,
      })
    : MigrationExecutable.inline

const program = Effect.gen(function* () {
  const plan = yield* registry.executable().planRun({
    definitionIds: ["articles"],
    withDependencies: true,
  })

  return yield* MigrationExecutable.startRun(plan)
}).pipe(Effect.provide(executableLayer))
```

Existing function-style entrypoints should remain as compatibility wrappers
while the service API settles:

```ts
runMigration(definition, options)
runMigrations(input)
rollbackMigration(definition, options)
rollbackMigrations(input)
```

Those wrappers should use the executable registry and inline executable
internally, so existing SDK users keep the simple completed-summary path:

```ts
export const runMigrations = (input: RunRequestInput) =>
  Effect.gen(function* () {
    const registry = MigrationDefinitionRegistry.make({
      id: input.registryId,
      definitions: input.definitions,
    })

    const plan = yield* registry.executable().planRun(input)
    const result = yield* MigrationExecutable.startRun(plan)

    if (result.kind === "completed") {
      return result.summary
    }

    return yield* Effect.dieMessage(
      "inline MigrationExecutable returned a started result"
    )
  }).pipe(Effect.provide(MigrationExecutable.inline))
```

The wrapper receives `completed` because it provides the inline executable.
