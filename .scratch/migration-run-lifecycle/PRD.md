# Safe Inline Migration Cancellation

Status: ready-for-human

## Problem

Ctrl+C can interrupt inline execution after a Process Pipeline changes the
destination but before tracking, Migration Item State, and Source Cursor state
are persisted. A later run may then retry partially applied destination work.

The inline executor already knows its current state. Observing or cancelling it
must not reread Migration Store state, which may be a remote API call.

## Execution Contract

`MigrationExecutable` remains a start-and-dispatch adapter and returns an
`ExecutionStartResult`.

- A completed inline execution may still return its summary directly.
- An attached executor may return a `MigrationRunHandle` on a started result.
- A detached executor returns its migration and provider execution identities
  without being forced to implement SDK-level inspection or cancellation.

An attached `MigrationRunHandle` exposes:

- `runId`: stable correlation identity.
- `get`: read state already known by the current executor.
- `wait`: await the executor's terminal signal.
- `cancel`: idempotently request cooperative cancellation from that executor.

`wait` distinguishes a stored terminal result (`finished`, whose state is
`succeeded` or `failed`) from an execution effect failure
(`execution-failed`, whose state is `failed` and whose cause is returned to the
attached caller).

There is no `getRun`, run listing, or Migration Store polling API in this
change.

## Inline Cancellation

The first Ctrl+C requests cooperative cancellation and keeps the CLI attached:

1. Flip the inline executor's local scheduling gate.
2. Stop admitting new Source Items, Source Cursor Windows, definitions, or
   rollback items at the next scheduling boundary.
3. Allow already-started Process Pipelines to finish destination work, snapshot
   tracking, and persist Migration Item State.
4. Commit a Source Cursor only when its whole current window persisted.
5. Keep Migration Definition Locks while active work drains.
6. Persist terminal `cancelled` state, release locks, and then complete the
   local terminal signal.

Cancellation intent is local because another process cannot take over an
inline run. Migration Store is written at real lifecycle and recovery
boundaries; it is not queried as a live coordination channel.

Repeated cancellation returns the currently known state. A request after a
terminal result does not change the result.

The second Ctrl+C opens a default-no y/n confirmation. Only an explicit yes
forces process exit. The prompt explains that forced exit may leave destination
changes without matching migration state, so a later run may retry partial
work.

Hard kills, OOM, machine loss, and unavailable dependencies remain outside the
cooperative guarantee. Destination effects and Migration Store writes do not
share one transaction.

## Observation

Inline observation is direct and event-driven:

- `get` reads the supervisor's in-memory state.
- `wait` awaits a terminal signal; it does not sleep, poll, or reread state.
- Migration Progress events continue to flow directly from the local executor
  to the attached CLI.
- Progress is non-durable and is never used for recovery.
- The inline supervisor owns Definition-provided Layer scopes through terminal
  completion. This includes Source requirements bound with
  `source.provide(layer)`. Services supplied by the execution host remain
  host-owned and must live through `handle.wait`; an attached handle cannot
  prolong a parent scope that its caller closes.

Workflow execution is detached and provider-owned:

- The SDK returns the migration run id and provider execution id after dispatch.
- The CLI prints those identities and exits instead of waiting or cancelling the
  remote workflow.
- Provider-native workflow status, steps, retries, events, and logs are the
  operational observability surface.
- The SDK does not poll Migration Store or wrap provider observation commands.

## Internal Responsibilities

- **Migration Execution** plans through the registry and delegates start.
- **Migration Executable** starts work and may attach a run-scoped handle when
  the current process owns execution.
- **Inline supervisor** owns local state, the cancellation gate, and terminal
  notification.
- **Runner** checks the local gate at scheduling boundaries, drains active work,
  protects cursor commits, releases locks, and persists terminal state.
- **Migration Store** owns recovery records written at lifecycle boundaries;
  it is not the inline observation bus.
- **CLI** waits only on attached work and owns signal handling, confirmation,
  and rendering.

## Acceptance Criteria

- Inline `get`, `wait`, and scheduling checks make no Migration Store reads.
- Interrupting or abandoning `wait` does not interrupt the supervised run while
  its execution host remains active.
- Active destination work and its Migration Item State persist before
  cancellation becomes terminal.
- A partially processed Source Cursor Window does not advance its cursor.
- Later queued work does not start after cancellation is observed.
- Locks remain held until active work drains and are released before terminal
  cancellation is reported.
- Terminal cancellation or failure is persisted before Definition Locks are
  released.
- First Ctrl+C drains; second Ctrl+C cannot force exit without explicit yes.
- Ctrl+C during inline startup interrupts startup and runs Effect finalizers;
  cooperative signal ownership begins only after an attached handle exists.
- A cooperatively cancelled CLI command exits with code 130 after the run has
  safely drained.
- Detached workflow execution returns promptly with provider identity and is
  not observed through Migration Store polling.
- Run and rollback use the same cooperative lifecycle.

## Required Tests

- Cancel while a Process Pipeline is blocked after a destination effect; verify
  state persists before terminal cancellation and the cursor does not advance.
- Verify attached `wait` completes from a terminal signal without clock
  advancement or state reads.
- Verify repeated cancellation is idempotent.
- Verify detached executors return without CLI waiting.
- Verify first and second Ctrl+C, declined confirmation, and explicit unsafe
  exit.
- Interrupt startup while a Definition Lock is blocked; verify startup stops
  and already-acquired locks are released on interruption or defect.
- Defect while changing a queued run to running; verify failure is persisted
  before locks are released.

## Out of Scope

- Parallel Source Cursor Windows or cursor coverage maps.
- Exactly-once destination effects across hard termination.
- Taking over or resuming an inline run from another process.
- SDK-level workflow inspection, waiting, cancellation, or CLI wrappers.
- Durable progress snapshots, replay, or a general monitoring UI.
