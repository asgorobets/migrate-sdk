# CLI Migration Run Observation and Control

Status: ready-for-agent

## Problem

The TUI can list, observe, and stop Migration Runs through a local or remote
Migrate Server, but the CLI still owns execution directly. Ctrl+C therefore
means local handle cancellation, and detached or remotely executed runs do not
have a first-class CLI discovery and observation workflow.

The CLI needs the same Migrate Client boundary as the TUI so a user can operate
a Workflow SDK migration running behind an HTTPS Migrate Server without loading
that environment's registry, resource credentials, or execution provider on
the local machine.

## Current Implementation

The first two slices are implemented:

- Migrate SDK owns `migrate-sdk/client/node`, including local socket startup,
  the reconnectable Node server host, remote HTTPS construction, authentication
  headers, compatibility validation, and connection disposal. The TUI consumes
  this module.
- The CLI exposes `migrate runs list`, `migrate runs observe <run-id>`, and
  `migrate runs stop <run-id>` for local or remote Migrate Servers.
- `runs observe` offers detach, safe stop, or continued observation in an
  interactive terminal. A non-interactive interrupt detaches without calling
  `StopRun` and prints the observe-again command.

Existing `migrate run` and `migrate rollback` still use direct
`MigrationExecution` and their legacy attached-handle interrupt behavior. The
next slice is the operation-selection protocol needed to preserve all current
CLI selection and execution modes before those commands move to the server.

## Vocabulary

- **Observe Run**: receive progress, lifecycle, warning, and terminal events
  for one Migration Run id.
- **Detach Migration Run Observation**: end only the current client's
  observation. Execution continues unchanged.
- **Stop Run**: explicitly request durable cooperative cancellation. The run
  enters `cancelling`, stops scheduling work, drains work already in flight,
  persists `cancelled`, and releases its locks.
- **Observe Again**: start a new observation using the same Migration Run id.

Do not describe detaching as pausing a run or observing again as resuming one.
The run never pauses. Avoid using attached or detached as protocol-level run
states because attachment also describes execution-host and provider handles.

## Command Surface

```console
migrate runs list
migrate runs observe <run-id>
migrate runs stop <run-id>
```

Existing commands keep their meaning:

```console
migrate list
migrate run ...
migrate rollback ...
```

`migrate list` lists registered Migration Definitions. It is not overloaded to
list Migration Runs.

Local lifecycle commands use `--config` discovery and the reconnectable local
Node Migrate Server. Remote lifecycle commands use:

```console
MIGRATE_SERVER_TOKEN=... migrate runs observe <run-id> \
  --server https://example.com/api/migrate
```

`--server` and `--config` are mutually exclusive. A bearer token is read from
`MIGRATE_SERVER_TOKEN`; there is no token flag because process arguments are an
inappropriate secret transport. Authentication policy remains application
owned, so a server may accept an unauthenticated connection when its host
deliberately does so.

## Observation Lifecycle

`runs observe` consumes the logical `MigrateClient.observeRun` stream. Local
socket streaming and bounded resumable HTTP leases remain hidden behind that
interface. The CLI renders absolute progress snapshots and terminal state; it
does not own transport resume tokens and does not poll the RPC endpoint itself.

For an interactive terminal, the first Ctrl+C offers:

1. **Detach** (default): abort this observation, print the Run ID and exact
   `migrate runs observe` command, then exit successfully.
2. **Stop safely**: call `StopRun`, render the `cancelling`/draining lifecycle,
   and keep observing until terminal state.
3. **Continue observing**: close the prompt and leave the observation active.

While safe stop is draining, another Ctrl+C may detach or continue observing.
It never maps to provider hard cancellation. For a non-interactive process,
Ctrl+C detaches, prints the Run ID and observe-again command, and never stops a
run implicitly.

Detachment is local state. The server does not remember which view the CLI had;
the Run ID and durable Migration Run State are sufficient for another client or
serverless invocation to reconstruct observation.

## Starting Operations

After the lifecycle commands are in place, `migrate run` and
`migrate rollback` move from direct `MigrationExecution` calls to:

1. Connect to the selected Migrate Server.
2. `PrepareOperation` and render its serializable plan.
3. Submit `StartOperation` with the accepted fingerprint.
4. Retain the returned Migration Run id.
5. Observe through `MigrateClient.observeRun` using the same interrupt lifecycle
   as `runs observe`.

An interrupt during `StartOperation` cannot safely discard the response once
dispatch may have happened. The CLI records the interrupt, waits for the start
result long enough to obtain the Run ID, and then detaches or stops according to
the user's choice. If the transport fails with an unknown dispatch outcome, the
CLI reports that uncertainty and directs the user to `migrate runs list`.

The server operation selection must represent existing CLI parity before this
cutover:

```ts
type MigrateSelection =
  | { readonly kind: "all" }
  | {
      readonly kind: "definitions"
      readonly definitionIds: readonly [MigrationDefinitionId, ...MigrationDefinitionId[]]
    }
  | { readonly kind: "group"; readonly groupId: MigrationDefinitionGroupId }
```

Operation selection is distinct from a dashboard view target. The TUI's focused
migration maps to a one-element definition selection. Existing run modes,
source identities, dependency expansion, concurrency, force, update, rescan,
retry, rollback, and rollback-orphans behavior must retain parity before direct
execution is removed.

## Module Boundary

Migrate SDK owns a Node Migrate Connection module that returns a connected
logical `MigrateClient`, server identity, a scoped Effect runner, and disposal.
It owns:

- local socket endpoint identity and reconnectable Node-server startup;
- remote HTTPS RPC construction and bearer-token request decoration;
- protocol and SDK compatibility validation;
- connection resource lifetime.

The TUI owns renderer state and adapts that connection into its runtime. The
CLI owns argument parsing, prompts, signal policy, and text rendering. Neither
client reimplements RPC transport or observation lease concatenation.

## Implementation Slices

1. Move the local/remote Node connection and local server host from the TUI
   package into `migrate-sdk/client/node`; update the TUI to consume it without
   behavior changes.
2. Add `migrate runs list`, `migrate runs observe`, and `migrate runs stop` on
   that shared connection, including non-interactive detachment.
3. Add and adopt the protocol-level operation selection needed for complete CLI
   selection parity.
4. Route `migrate run` and `migrate rollback` through prepare, start, and
   observation while preserving plan and progress rendering.
5. Replace the legacy direct-handle Ctrl+C flow with the interactive
   detach/stop/continue observation controller, then remove the bypassed path.

## Acceptance Criteria

- TUI and CLI use one Migrate SDK-owned local/remote connection
  implementation.
- A local CLI can list and observe a run after the initiating client exits.
- A remote CLI can list, observe, and safely stop a Workflow SDK run using only
  the Migrate Server URL and its server credential.
- Detaching never changes durable Migration Run State.
- Stopping always goes through `StopRun` and remains observable while draining.
- The Run ID and observe-again command are printed whenever observation ends
  before a terminal state.
- HTTP lease resume tokens remain private to `MigrateClient`.
- Existing definition listing, planning, selection, execution modes, and
  rollback behavior retain parity when operation commands move to the server.
- Store schema and other infrastructure-only commands may continue to load
  local configuration directly.

## Out of Scope

- Provider hard cancellation or kill commands.
- Pausing and resuming Migration Run execution.
- Persisting client navigation, focused tabs, or observer identity on the
  server.
- Passing server bearer tokens through CLI flags.
- Requiring infrastructure-only commands to cross the Migrate Protocol.
