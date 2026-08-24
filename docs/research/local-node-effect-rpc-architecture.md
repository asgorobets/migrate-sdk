# Local Node Migrate Server over Effect RPC

Status: implemented for the first local client/server slice

## Recommendation

Keep OpenTUI in Bun, but move config loading and all Migrate SDK execution into a
Node child process. The Bun process should use Effect RPC over Node child-process
IPC to call that process. This is the smallest architecture that preserves the
existing Node migration authoring contract and creates the protocol seam needed
for later HTTPS and SSH connections.

Do not build the remote server yet. The first slice should introduce:

1. a runtime-neutral, schema-backed Migrate Protocol and server handler layer;
2. a Node server entry point that loads the existing CLI config;
3. a Bun-side adapter implementing the current `MigrationTuiRuntime` interface;
4. one local child-process IPC connection with explicit RPC multiplexing; and
5. an end-to-end fixture proving a Node-only config can be operated from the Bun
   TUI process.

This implements the accepted direction in
[ADR 0007](../adr/0007-server-boundary-for-local-and-remote-clients.md#decision):
the Migrate Server owns the registry and runtime capabilities, the TUI is a
client, and only serializable protocol data crosses the boundary. The ADR also
already identifies Node child-process IPC as the first local connection
([lines 68-73](../adr/0007-server-boundary-for-local-and-remote-clients.md#L68-L73)).

## Validated runtime shape

The proposed process tree is:

```text
shell
└─ Node npm launcher
   └─ Bun OpenTUI renderer
      └─ Node Migrate Server (IPC-enabled child process)
```

The npm launcher already runs in Node and launches Bun
([`packages/tui/bin/launcher.js:157-166`](../../packages/tui/bin/launcher.js#L157-L166)).
It should pass its exact `process.execPath` to the Bun process. Bun then uses
that path as the `execPath` when it forks the server entry. It must not use
Bun's own `process.execPath` for the Node server.

I validated this shape locally with Node 24.16.0, Bun 1.3.14, Effect
4.0.0-rc.111, and `@effect/platform-node` 4.0.0-rc.111:

- a Bun parent successfully forked an explicit Node child with IPC; and
- a complete Effect RPC spike successfully made a unary `Ping` call and consumed
  a three-item streaming `Observe` response across that Bun-to-Node channel.

The spike used the same layers recommended below. It was temporary and was not
added to the repository. The implementation now runs its own Bun-parent and
Node-child RPC regression plus packed migration smoke in the TUI package matrix
on macOS, Linux, and Windows; it does not depend on the inactive upstream test.

## Exact Effect RPC composition

The project pins Effect 4.0.0-rc.111. The exact API and behavior below were
cross-checked against the installed source under
`packages/migrate-sdk/node_modules`; the local upstream checkout is currently
older (`4.0.0-beta.67`).

### Shared contract

Define each operation with `Rpc.make` and collect operations with
`RpcGroup.make`. `Rpc.make` accepts payload, success, declared error, defect,
and streaming schemas (`effect/src/unstable/rpc/Rpc.ts:902-950`). A generated
client exposes unary RPCs as `Effect`s and streaming RPCs as `Stream`s
(`RpcClient.ts:70-136`). Handlers are collected with `RpcGroup.toLayer`
(`RpcGroup.ts:95-108`).

The contract module must be runtime-neutral: it can depend on Effect Schema and
serializable Migrate domain schemas, but not Node, Bun, OpenTUI, config modules,
Migration Definitions, Effect Layers, or executable plans.

### Bun client

The local connection can be composed as:

```ts
import { fork } from "node:child_process"
import * as NodeWorker from "@effect/platform-node/NodeWorker"
import * as RpcClient from "effect/unstable/rpc/RpcClient"

const WorkerLive = NodeWorker.layer(() =>
  fork(serverEntry, [], {
    cwd,
    env,
    execPath: nodeExecutable,
    silent: true
  })
)

const ProtocolLive = RpcClient.layerProtocolWorker({
  size: 1,
  concurrency: 64
}).pipe(Layer.provide(WorkerLive))

const client = yield* RpcClient.make(MigrateServerRpcs)
```

`NodeWorker.layer` accepts either a worker thread or a Node `ChildProcess` and
uses `child.send` / `message` for IPC. Its scope finalizer disconnects and then
kills an unresponsive child after five seconds
(`@effect/platform-node/src/NodeWorker.ts:31-65,67-121`).

The explicit `concurrency` is essential. `RpcClient.layerProtocolWorker` uses a
worker pool (`RpcClient.ts:1330-1344`), and Effect's pool defaults per-item
concurrency to **1** (`effect/src/Pool.ts:239-245,323-346`). With
`{ size: 1 }` alone, a long-running `ObserveExecution` stream holds the only
lease and blocks refresh, cancel, and other command RPCs. `{ size: 1,
concurrency: 64 }` keeps one Node server process while allowing its IPC channel
to multiplex requests. This transport concurrency is unrelated to the
migration execution concurrency exposed to users.

### Node server

The child process can be composed as:

```ts
import * as NodeWorkerRunner from "@effect/platform-node/NodeWorkerRunner"
import * as RpcServer from "effect/unstable/rpc/RpcServer"

const ServerLive = RpcServer.layer(MigrateServerRpcs, {
  disableFatalDefects: true
}).pipe(
  Layer.provide(MigrateServerHandlers),
  Layer.provide(RpcServer.layerProtocolWorkerRunner),
  Layer.provide(NodeWorkerRunner.layer)
)
```

`NodeWorkerRunner` receives parent IPC messages through `process.on("message")`
and replies through `process.send`; listener setup and cleanup are scoped
(`@effect/platform-node/src/NodeWorkerRunner.ts:32-78,107-125`).
`RpcServer.layerProtocolWorkerRunner` adapts that runner to the RPC protocol
(`RpcServer.ts:1350-1414`).

Use `disableFatalDefects: true` so one defective handler is represented as that
request's exit instead of terminating all outstanding client requests. Defects
still need server logging and should not be confused with declared domain
errors.

### What the worker protocol already supplies

Effect RPC already supplies:

- request identifiers and multiplexing;
- schema encoding and decoding through JSON codecs
  (`RpcClient.ts:664-799`, `RpcServer.ts:500-615`);
- typed success and declared error channels;
- streaming responses;
- stream acknowledgements and backpressure
  (`RpcServer.ts:400-443`);
- client interruption messages for unary requests and scoped streams
  (`RpcClient.ts:392-503`);
- request-fiber interruption on the server (`RpcServer.ts:188-207`);
- scoped connection shutdown and interruption of connection-owned fibers
  (`RpcServer.ts:138-168`); and
- typed transport/protocol failures through `RpcClientError`
  (`RpcClientError.ts:1-56`).

`RpcMessage` defines the request, acknowledgement, interruption, stream chunk,
and exit message vocabulary (`RpcMessage.ts:26-34,63-136,183-290`). The worker
adapter transports those structured messages directly over child IPC. We do
not need to invent JSON Lines framing for the local connection.

`RpcSerialization` provides JSON, newline-delimited JSON, and MessagePack
serializers (`RpcSerialization.ts:33-48,95-108,117-164,507-564`), but those are
for byte-stream transports such as HTTP, sockets, or stdio. They are not needed
for Node child IPC.

### What Migrate SDK still owns

Effect RPC does not supply the application protocol or process productization.
Migrate SDK still owns:

- public protocol versions and capability negotiation;
- the schema-backed request, projection, event, and error types;
- discovery of the Node executable and packaged server entry;
- child startup timeout, logs, crash messages, and restart policy;
- config-path and working-directory bootstrap;
- config loading and construction of the authoritative server Layer;
- plan fingerprinting and plan-change rejection;
- the server-side map from serializable execution references to live handles;
- attached versus detached execution semantics;
- explicit cancellation authorization and behavior; and
- durable state recovery after a stream reconnects.

Effect's `Rpc.fork` only changes whether a handler counts against the RPC
server's concurrency limit (`Rpc.ts:1241-1248`). It is not durable detachment.
Likewise, interrupting a client stream interrupts that observation request. It
must not implicitly cancel the migration run.

## First protocol surface

Start with a small vertical protocol rather than a generic
`execute(command: unknown)` endpoint:

| RPC | Shape | Purpose |
| --- | --- | --- |
| `GetServerInfo` | unary | Protocol version, SDK version, Node runtime, registry/environment identity, capabilities |
| `GetDashboard` | unary | Registry entries, groups, and durable definition status projection |
| `GetMessages` | unary | Durable messages for one migration or group |
| `PrepareOperation` | unary | Serializable plan projection, dependency checks, and plan fingerprint |
| `StartOperation` | unary | Replan, verify fingerprint, start, and promptly return an execution reference |
| `ObserveExecution` | stream | Coalesced progress checkpoints, durable status snapshots, warnings, and terminal event |
| `CancelExecution` | unary | Explicitly request cancellation where the execution capability supports it |

Additional operations such as source scan, source-identity history, lock
recovery, and rollback can be added as schema-backed RPCs while the TUI runtime
adapter is cut over. The server handlers should delegate to the existing SDK
services; they must not reimplement migration behavior.

### Never send executable plans

The current prepared TUI operation embeds
`MigrationDefinitionExecutableRunPlan` or
`MigrationDefinitionExecutableRollbackPlan`
([`packages/tui/src/runtime.ts:76-95`](../../packages/tui/src/runtime.ts#L76-L95)).
Those plans contain live definitions and executable capabilities, so they are
not protocol values. This follows the domain rule that Effects, Layers,
definitions, and executable plans never cross the Migrate Protocol
([`CONTEXT.md:383-386`](../../CONTEXT.md#L383-L386)).

`PrepareOperation` should return a display projection plus a fingerprint. On
confirmation, `StartOperation` sends the original request and accepted
fingerprint. The Node server plans again against its current registry and
rejects the start if the fingerprint changed. This avoids serializing authority
and prevents a stale confirmation from executing a different plan.

### Separate start from observation

Do not represent execution as one long streaming `Run` call. A client scope
finalizer sends an RPC interruption when a stream is closed
(`RpcClient.ts:428-503`), and the server maps it to interruption of that request
fiber (`RpcServer.ts:188-207`).

Instead:

1. `StartOperation` returns a schema-backed `{ runId, executionId, lifecycle }`
   reference as soon as the SDK starts the run;
2. the Node server retains any host-local execution handle;
3. `ObserveExecution(reference)` streams progress independently; and
4. `CancelExecution(reference)` is the only operation that requests execution
   cancellation.

Closing an observation therefore stops only the observer, as required by the
domain model. Detached provider executions can be observed again from their
durable state. A local inline run still depends on the connection-scoped Node
server process; surviving TUI/server shutdown requires a durable execution
adapter or a future daemon, not an RPC flag.

The stream should publish checkpoints at natural cursor-window commits and may
coalesce status updates. Durable Migration Run and Item State remains the source
of truth. Reconnection begins with a dashboard/status read and then resumes live
observation where supported.

## Mapping onto the current TUI

### `runtime.ts`

`runtime.ts` currently imports Node services, the CLI config loader, registry,
store, and executable services directly
([lines 1-36](../../packages/tui/src/runtime.ts#L1-L36)). It then loads config in
the Bun process ([lines 193-212](../../packages/tui/src/runtime.ts#L193-L212))
and constructs the executable runtime in-process
([lines 246-262](../../packages/tui/src/runtime.ts#L246-L262)).

Split this into two modules:

- **server application service**: owns current config/registry/store/executable,
  preparation, execution, observation, messages, scans, history, and lock work;
- **`RpcMigrationTuiRuntime` adapter**: implements the existing
  `MigrationTuiRuntime` interface with RPC calls and maps protocol DTOs to UI
  models.

Keeping the interface initially limits UI churn. Its prepared-operation type
must become a serializable projection rather than carrying an executable plan.
Schema-decode all values crossing the boundary instead of exporting new
anonymous interfaces.

### Config loading

The Node server should call the existing
`loadMigrationCliConfigWithPath({ cwd, configPath })` with Node services. That
loader already discovers the config and installs `tsx`'s Node registration for
TypeScript imports when the runtime is not Bun
([`config-loader.ts:200-235`](../../packages/migrate-sdk/src/cli/config-loader.ts#L200-L235),
[`282-311`](../../packages/migrate-sdk/src/cli/config-loader.ts#L282-L311)).
The Bun renderer must no longer import customer config.

Bootstrap may initially travel through process arguments/environment or an RPC
initial message. Effect exposes a schema-backed worker initial-message facility
(`RpcWorker.ts:67-118`), but choosing it is optional. Either way, limit bootstrap
to `cwd`, optional `configPath`, and protocol version; send no credentials over
the wire when the server can inherit its environment.

### `execution-controller.ts`

The controller's UI state and single-active-operation guard remain useful.
Replace its direct SDK `start`, live `handle.wait`, and `handle.cancel` branches
([`execution-controller.ts:134-252`](../../packages/tui/src/execution-controller.ts#L134-L252))
with `StartOperation`, `ObserveExecution`, and `CancelExecution` calls. The
client should own only an observation scope; the Node server owns real SDK
handles and provider/store observation.

The current abort behavior for detached observation
([lines 206-245](../../packages/tui/src/execution-controller.ts#L206-L245)) maps
naturally to closing the observation stream. It must continue to display that
the run is still active, not call `CancelExecution` implicitly.

### TUI lifecycle

Acquire the child process, worker protocol, and RPC client in one Effect scope
before creating the renderer. Release that scope only after the TUI lifecycle
supervisor has stopped rendering and performed any explicit attached-run exit
decision. Effect then cleans up IPC listeners and the child process even when
renderer setup or execution fails.

Keep stdout/stderr separate from the RPC channel. Child IPC carries protocol
messages; server logs can be captured through `silent: true` pipes and rendered
or written without corrupting the protocol.

## Testing the first slice

The merge bar for the local adapter should include:

1. schema round-trip tests for every request, response, event, and declared
   error, including rejection of excess properties where the public schema
   requires it;
2. in-memory `RpcTest` handler contract tests (useful, but not transport proof);
3. a real Bun-parent / Node-child test using the packaged server entry;
4. a Node-only config fixture that would fail if Bun tried to load it;
5. dashboard, prepare, start, progress stream, terminal state, and explicit
   cancel assertions;
6. a concurrency regression where `ObserveExecution` remains open while a
   dashboard or cancel RPC completes, proving pool concurrency is greater than
   one;
7. child crash, startup timeout, schema mismatch, and protocol-version mismatch
   behavior; and
8. macOS, Linux, and Windows package smoke coverage.

`RpcTest` is an in-memory protocol implementation
(`effect/src/unstable/rpc/RpcTest.ts:34-63` in the local checkout). It does not
prove worker serialization, Bun compatibility, child lifecycle, or packaging,
so the cross-process fixture is mandatory.

## Later HTTP and SSH connections

Keep the logical `RpcGroup`, schemas, handler Layer, and TUI runtime adapter
transport-independent. Later connections should replace only the protocol
Layer and connection bootstrap:

- Effect already provides HTTP client and server protocol layers
  (`RpcClient.ts` and `RpcServer.ts:800-825`), suitable for a deployed Migrate
  Server after authentication, authorization, transport security, and durable
  lifecycle are designed.
- Effect currently provides a stdio server protocol
  (`RpcServer.ts:1275-1341`) but no symmetric built-in stdio client. SSH can
  later start the same Node server in stdio mode, but the project would own the
  client-side byte-stream adapter/framing, or tunnel HTTP/TCP instead.

Do not implement either in the first slice. Child-process IPC proves the
contract and removes the immediate Bun runtime incompatibility without
prematurely choosing remote authentication, discovery, deployment, or daemon
semantics.

## Proposed module boundary

Avoid a new published package until there is an independently deployable remote
server. Keep the client contract and server implementation as separate SDK
subpaths so clients do not import server construction code. The first
implementation can use:

```text
packages/migrate-sdk/src/protocol/
  index.ts          # schemas, errors, RPC group, versions and capabilities

packages/migrate-sdk/src/server/
  handlers.ts       # runtime-neutral handlers delegating to SDK services

packages/tui/src/server/
  node-entry.ts     # Node config bootstrap and server Layer
  local-client.ts   # Bun child-process connection Layer
  tui-runtime.ts    # MigrationTuiRuntime RPC adapter
```

Export the contract from `migrate-sdk/protocol` and handler construction from
`migrate-sdk/server`. Keep Node process code in the TUI package for this
local-only slice. When a deployable Migrate Server is introduced, it can consume
the same protocol and server exports without moving execution logic out of the
SDK again.

The resulting boundary is narrow: the migration engine remains unchanged, the
CLI may continue invoking it directly, and the TUI changes only from a direct
runtime implementation to a protocol-backed implementation.
