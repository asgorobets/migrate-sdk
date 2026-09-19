# @migrate-sdk/workflow-sdk

Workflow SDK execution adapter for `migrate-sdk`.

The package is named for Workflow SDK rather than Vercel because Workflow SDK
runs on swappable worlds: Vercel, local, Postgres, Redis, and other providers.
Vercel is a deployment/world choice, not the migration adapter boundary.

```ts
import {
  WorkflowSdkClient,
  WorkflowSdkMigrationExecutable,
} from "@migrate-sdk/workflow-sdk";
import { Effect, Layer } from "effect";
import { MigrationExecutable } from "migrate-sdk";
import { migrationExecutionWorkflow } from "./workflows/migration-execution";

const executableLayer = WorkflowSdkMigrationExecutable.layer({
  workflow: migrationExecutionWorkflow,
  startOptions: {
    deploymentId: "latest",
  },
}).pipe(Layer.provide(WorkflowSdkClient.layer));

const result = await Effect.runPromise(
  MigrationExecutable.startRun(plan).pipe(Effect.provide(executableLayer))
);
```

Workflow files should import the workflow-safe driver subpath, not the package
root:

```ts
import { runMigrationExecutionWorkflow } from "@migrate-sdk/workflow-sdk/workflow";

export async function migrationExecutionWorkflow(envelope) {
  "use workflow";

  return await runMigrationExecutionWorkflow(envelope, steps);
}
```

This package currently implements the durable run boundary: allocate a migration
run id, acquire definition locks, queue migration run state, start the Workflow
SDK run, attach the Workflow SDK run id, then let the Workflow SDK workflow
consume the locked run envelope through cursor-window steps. The executable can
reattach to that Workflow SDK run id for native terminal observation.

Before item work, the locked run publishes a baseline of stored counts. Existing
steps accumulate committed before/after state changes and publish one compact
cumulative contribution every five seconds while changing, plus a final flush
at window completion or step exit. Unchanged periods write nothing. These are
stream writes inside existing steps, not extra Workflow steps or persisted
per-item events. Each step/attempt has its own contribution and revision;
replaying an update replaces that contribution rather than adding it again.
Future parallel windows can use independent contributions under the same run.

The Migrate Server relays this stream. Shared client code reconstructs display
counts and retains them with the last consumed chunk index across HTTP session
renewals. A new client replays the stream; a replacement server resumes after
the client's cursor. Neither needs a new persistence service. Routine progress
and reconnection do not rescan Migration Item State. Lifecycle changes refresh
small run/definition metadata separately.

Provider status is checked after thirty seconds without progress, on lifecycle
notifications, and when the stream closes. Dashboard discovery also checks
active run metadata every thirty seconds; neither check scans item states.
Failed dashboard and focused-run stream readers reconnect from their last
cursor with capped, jittered backoff.
Detaching closes the reader. Idle TUIs stop their observation session.

Streaming is a display optimization: Migration Item State remains authoritative.
Initial loading, explicit refresh, and terminal reconciliation read stored
summaries. A worker can commit a state and die before publishing; the display
may lag until final reconciliation. A missing baseline is reported to the
client instead of silently initiating expensive polling. Baseline writes have
bounded retries. No atomic outbox or per-item event history is introduced.

Workflow stream storage, retention, reader compute, and transfer still have a
cost. Five-second batching bounds routine write volume by active steps and time,
not item throughput; lifecycle and step-final writes add to that volume.
Serverless streaming requests also remain subject to host duration and billing.

Processing concurrency from the executable plan is applied to item
admission and per-item work inside every cursor-window step. A `processBatch`
callback may separately choose the concurrency of its own destination requests.

Run requests support source identity selection, failed-only and skipped-only
modes, update runs, rescans, and orphan rollback. Identity selections include
composite identities and use the same registry input as inline execution.
Included dependencies run with the same mode policy as inline execution.

Targeted runs look up the selected identities without scanning or changing the
source cursor. Update runs schedule migrated items as `needs-update`, preserve
their tracking evidence, reset discovery, and reprocess unchanged source items.
Preparation happens once per definition inside its first cursor-work step.
Subsequent steps carry an `initialized` marker alongside counts. After a failed
or cancelled run, a normal run processes the persisted retry/update backlog
before resuming discovery, including when a source cursor is already saved.

Run finalization does not re-plan the request. Provide the original
`MigrationStore` layer in the step runtime (as in the example) so cleanup can
still mark the run failed and release its locks after a definition or registry
is removed in a later deployment. The store verifies ownership of the original
lock lease before making changes.

For existing runtimes without a supplied store, finalization uses the store
shared by surviving scoped definitions, or the registry's sole store layer
when none survive. A mixed-store registry without surviving scoped definitions
must supply the original store to its finalization steps; cleanup fails rather
than guessing between stores. Store layers are compared by reference identity.

## Why cursor-work steps should not retry automatically

Workflow SDK normally retries a step when the worker fails or its result is
lost. That is useful for lifecycle work, but a cursor-window step has a special
boundary: it can save item outcomes and the next source cursor before Workflow
SDK stores the step's return value. Those two writes are not atomic. Repeating
the step at that point could consume the next source window while the workflow
still holds the previous window's counts.

Use `disableWorkflowStepRetries` on the two steps that consume cursor work:

```ts
import { disableWorkflowStepRetries } from "@migrate-sdk/workflow-sdk/steps";

disableWorkflowStepRetries(executeMigrationRunCursorWindowStep);
disableWorkflowStepRetries(executeMigrationRunRollbackOrphansPageStep);
```

Keep begin, complete, cancel, failure-finalization, and whole-run rollback steps
on Workflow SDK's normal retry policy. Finalization releases migration locks,
so it must remain retryable when its result is lost.

If an existing application defines its own Workflow SDK step functions, add
the two calls above. This is not a breaking API change, but it deliberately
changes retry behavior for those cursor-work steps: a failed step now fails the
run, and the next migration run resumes from the item states and source cursor
already saved in the Migration Store.

This reduces unsafe replay; it does not promise exactly-once delivery. A worker
can still stop after a destination accepts work but before the item's outcome
is saved. Migrations should use stable destination identities, tolerate replay,
and journal accepted operation ids when they can be used to resume unfinished
work.

`processBatch` follows the same cursor rule as `process`. One callback receives
either eligible items from one source cursor window or items from the retry
backlog, and it may divide them into any smaller requests it needs. The SDK
waits for every item settlement before it commits the source cursor, and no
unsettled item is carried into a later cursor window.

## Local World test

The package includes a Workflow SDK Local World integration test that can be run
from the CLI:

```sh
pnpm --filter @migrate-sdk/workflow-sdk test:workflow
```

The test starts a real adapter-backed Workflow SDK run in the in-process Local
World, scans 100 source entries, asserts that the scan is split into two
completed Workflow SDK steps of 50 entries each, and verifies planned Process
Pipeline concurrency inside those steps.
It also covers identity targeting, update runs, and recovery from an interrupted
update after a cursor window has committed.
