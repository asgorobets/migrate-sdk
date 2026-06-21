# @migrate-sdk/workflow-sdk

Workflow SDK execution adapter for `migrate-sdk`.

The package is named for Workflow SDK rather than Vercel because Workflow SDK
runs on swappable worlds: Vercel, local, Postgres, Redis, and other providers.
Vercel is a deployment/world choice, not the migration adapter boundary.

```ts
import { start } from "workflow/api";
import { WorkflowSdkMigrationExecutable } from "@migrate-sdk/workflow-sdk";
import { Effect } from "effect";
import { MigrationExecutable } from "migrate-sdk";
import { migrationExecutionWorkflow } from "./workflows/migration-execution";

const executableLayer = WorkflowSdkMigrationExecutable.layer({
  start,
  workflow: migrationExecutionWorkflow,
  startOptions: {
    deploymentId: "latest",
  },
});

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
consume the locked run envelope through cursor-window steps.

## Local World test

The package includes a Workflow SDK Local World integration test that can be run
from the CLI:

```sh
pnpm --filter @migrate-sdk/workflow-sdk test:workflow
```

The test starts a real adapter-backed Workflow SDK run in the in-process Local
World, scans 100 source entries, and asserts that the scan is split into two
completed Workflow SDK steps of 50 entries each.
