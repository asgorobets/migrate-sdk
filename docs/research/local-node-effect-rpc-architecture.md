# Local Node Migrate Server over Effect RPC

Status: implemented for local socket and remote HTTP connections

## Recommendation

Keep OpenTUI in Bun, but move config loading and all Migrate SDK execution into a
Node child process. The Bun process uses Effect RPC over a reconnectable local
socket to call that process. This preserves the existing Node migration
authoring contract, lets inline work outlive one TUI connection, and uses the
same Migrate Protocol exposed remotely over HTTPS.

The implemented slices provide:

1. a runtime-neutral, schema-backed Migrate Protocol and server handler layer;
2. a Node server entry point that loads the existing CLI config;
3. a Bun-side adapter implementing the current `MigrationTuiRuntime` interface;
4. a reconnectable local socket plus bounded HTTP observation leases; and
5. an end-to-end fixture proving a Node-only config can be operated from the Bun
   TUI process.

This implements the accepted direction in
[ADR 0007](../adr/0007-server-boundary-for-local-and-remote-clients.md#decision):
the Migrate Server owns the registry and runtime capabilities, the TUI is a
client, and only serializable protocol data crosses the boundary. The ADR also
already identifies Node child-process IPC as the first local connection
([lines 68-73](../adr/0007-server-boundary-for-local-and-remote-clients.md#L68-L73)).

## Validated runtime shape

The implemented local process tree is:

```text
shell
└─ Node npm launcher
   └─ Bun OpenTUI renderer
      └─ Node Migrate Server (detached, socket-enabled child process)
```

The npm launcher already runs in Node and launches Bun
([`packages/tui/bin/launcher.js:157-166`](../../packages/tui/bin/launcher.js#L157-L166)).
It passes its exact `process.execPath` to the Bun process. Bun then uses that
path as the executable when it spawns the server entry. It must not use
Bun's own `process.execPath` for the Node server.

I validated this shape locally with Node 24.16.0, Bun 1.3.14, Effect
4.0.0-rc.111, and `@effect/platform-node` 4.0.0-rc.111:

- a Bun parent successfully forked an explicit Node child with IPC; and
- a complete Effect RPC spike successfully made a unary `Ping` call and consumed
  a three-item streaming `Observe` response across that Bun-to-Node channel.

The spike used the worker layers documented below. It was temporary and was not
added to the repository. The production implementation instead uses Effect's
NDJSON socket protocol so the Node server can accept a later client. The test
matrix includes Bun-parent/Node-child socket coverage plus packed migration
smoke on macOS, Linux, and Windows.

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

### Evaluated worker client

The initial spike used the following connection-scoped worker transport. It is
retained here as research evidence, not as the active implementation:

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

const client = yield* RpcClient.make(MigrateStreamingRpcs)
```

`NodeWorker.layer` accepts either a worker thread or a Node `ChildProcess` and
uses `child.send` / `message` for IPC. Its scope finalizer disconnects and then
kills an unresponsive child after five seconds
(`@effect/platform-node/src/NodeWorker.ts:31-65,67-121`).

The explicit `concurrency` is essential. `RpcClient.layerProtocolWorker` uses a
worker pool (`RpcClient.ts:1330-1344`), and Effect's pool defaults per-item
concurrency to **1** (`effect/src/Pool.ts:239-245,323-346`). With
`{ size: 1 }` alone, a long-running `ObserveRun` stream holds the only
lease and blocks refresh, cancel, and other command RPCs. `{ size: 1,
concurrency: 64 }` keeps one Node server process while allowing its IPC channel
to multiplex requests. This transport concurrency is unrelated to the
migration execution concurrency exposed to users.

### Evaluated worker server

The child process can be composed as:

```ts
import * as NodeWorkerRunner from "@effect/platform-node/NodeWorkerRunner"
import * as RpcServer from "effect/unstable/rpc/RpcServer"

const ServerLive = RpcServer.layer(MigrateStreamingRpcs, {
  disableFatalDefects: true
}).pipe(
  Layer.provide(MigrateStreamingServerHandlers),
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

- public protocol version negotiation and one complete operation contract;
- the schema-backed request, projection, event, and error types;
- discovery of the Node executable and packaged server entry;
- child startup timeout, logs, crash messages, and restart policy;
- config-path and working-directory bootstrap;
- config loading and construction of the authoritative server Layer;
- plan fingerprinting and plan-change rejection;
- the server-side map from Migration Run ids to server-owned live handles;
- server-owned versus provider-owned execution semantics;
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
| `GetServerInfo` | unary | Protocol version, SDK version, and registry/environment identity |
| `GetDashboard` | unary | Registry entries, groups, and durable definition status projection |
| `GetActiveRuns` | unary | Discover queued and running Migration Runs |
| `GetMessages` | unary | Durable messages for one migration or group |
| `GetSourceIdentityHistory` | unary | Durable source-identity history for selective runs |
| `NormalizeSourceIdentity` | unary | Validate and encode a source identity with the authoritative Source |
| `PrepareOperation` | unary | Serializable plan projection, dependency checks, and plan fingerprint |
| `StartOperation` | unary | Replan, verify fingerprint, start, and return the Migration Run id and start status |
| `ObserveRun` | stream | Coalesced progress checkpoints, durable status snapshots, warnings, and terminal event for a Migration Run id |
| `ObserveRunLease` | unary | Bounded, resume-token-based form of the same observation for HTTP and serverless connections |
| `StopRun` | unary | Explicitly request a safe stop for one Migration Run and report whether the current execution supports it |
| `ScanSource` | unary | Scan the selected migration or group with explicit concurrency |
| `BreakLock` | unary | Clear one selected stale Migration Definition Lock |

Every compatible server implements this complete surface. Rollback, retry, and
update are operation actions carried by `PrepareOperation` and `StartOperation`,
not separate RPC variants. The server handlers delegate to the existing SDK
services; they do not reimplement migration behavior.

### Never send executable plans

The registry-backed Migrate Server runtime keeps
`MigrationDefinitionExecutableRunPlan` or
`MigrationDefinitionExecutableRollbackPlan` inside its runtime-only
`ExecutableMigrationOperation`
([`packages/migrate-sdk/src/server/registry-runtime.ts`](../../packages/migrate-sdk/src/server/registry-runtime.ts)).
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

1. `StartOperation` returns a schema-backed
   `{ runId, status: "started" | "completed" }` result as soon as the SDK has a
   Migration Run id;
2. the Node server retains any host-local execution handle;
3. `ObserveRun({ runId })` streams progress independently; and
4. `StopRun({ runId })` is the only operation that requests execution
   cancellation from the server.

Closing an observation therefore stops only the observer, as required by the
domain model. Provider-owned executions can be observed again from their
durable state. A local inline run remains owned by the detached Node server,
which accepts a later client on the same socket and exits only after it has no
clients or active work.

The stream should publish checkpoints at natural cursor-window commits and may
coalesce status updates. Durable Migration Run and Item State remains the source
of truth. Reconnection begins with a dashboard/status read and then resumes live
observation where supported.

## Mapping onto the TUI

### SDK services, registry runtime, and local loader

The implementation separates the runtime into three roles:

- **`MigrateServer`**: an SDK Effect service that owns plan fingerprints,
  authoritative replanning, run starts, observation streams, and
  request routing;
- **registry migration server runtime**: accepts an existing registry and
  executable, then binds store, messages, scans, history, execution, and lock
  work to the server backend;
- **local migration server loader**: discovers `migrate.config.*`, resolves its
  executable Layer, and constructs the registry runtime;
- **protocol-backed `MigrationTuiRuntime` adapter**: implements the public
  `MigrationTuiRuntime` interface with RPC calls and maps protocol DTOs to UI
  models.

The public prepared-operation type is a serializable projection. Executable SDK
plans remain in the registry runtime and all values crossing the boundary are
schema-encoded protocol values. `MigrateClient.streamingLayer` /
`MigrateClient.httpLayer` expose one logical client observation interface, and
`MigrateServer.make` / `MigrateServer.layer` expose the reusable server service;
the connection transport supplies the remaining protocol Layer.

The registry runtime, local loader, and `MigrateServerBackend` adapter live
under `migrate-sdk/server`. The TUI package retains the local Node process
bootstrap and its protocol-backed UI adapter, but it no longer owns migration
planning, execution, or durable observation.

### Config loading

Only the local Node server loader calls the existing
`loadMigrationCliConfigWithPath({ cwd, configPath })` with Node services. That
loader already discovers the config and installs `tsx`'s Node registration for
TypeScript imports when the runtime is not Bun
([`config-loader.ts:200-235`](../../packages/migrate-sdk/src/cli/config-loader.ts#L200-L235),
[`282-311`](../../packages/migrate-sdk/src/cli/config-loader.ts#L282-L311)).
The Bun renderer does not import customer config. Remote hosts construct the
same registry runtime from an already-imported registry and executable, with no
config-file discovery.

Bootstrap travels through process arguments and the inherited environment. It
is limited to `cwd` and optional `configPath`; credentials are not copied into
the application protocol.

### Effect-native execution ownership

The registry migration server runtime exposes discovery, planning, status,
messages, source scans, execution, and observation as Effects. Config loading
is isolated in the local loader.
It retains real execution handles on the server without interpreting SDK work
through Promises. The client adapter uses `StartOperation`, `ObserveRun`, and
`StopRun` and owns only the observation stream and UI-facing state. Promise
interpretation is limited to that client and
process boundary; there is no shared UI execution controller between the
layers.

Closing the observation stream does not implicitly request cancellation. A
detached run continues in its execution provider and is reported as detached to
the client.

### TUI lifecycle

The TUI owns only its socket connection and observation scope. A newly launched
Node server is detached from the renderer process and owns its execution fibers;
disconnecting or aborting observation does not interrupt a run. The server
remains reachable at the deterministic local endpoint until its idle policy
finds no clients and no active executions.

Keep logs separate from the RPC socket. The socket carries NDJSON protocol
frames; server logging must use a separate deployment or process channel.

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
6. a concurrency regression where `ObserveRun` remains open while a dashboard
   or stop RPC completes, proving pool concurrency is greater than
   one;
7. child crash, startup timeout, schema mismatch, and protocol-version mismatch
   behavior; and
8. macOS, Linux, and Windows package smoke coverage.

`RpcTest` is an in-memory protocol implementation
(`effect/src/unstable/rpc/RpcTest.ts:34-63` in the local checkout). It does not
prove socket serialization, Bun compatibility, child lifecycle, or packaging,
so the cross-process fixture is mandatory.

## HTTP and later SSH connections

Keep the logical `RpcGroup`, schemas, handler Layer, and TUI runtime adapter
transport-independent. Later connections should replace only the protocol
Layer and connection bootstrap:

- The deployed HTTP connection uses Effect's HTTP client and server protocol
  layers. Remote observation is implemented as bounded `ObserveRunLease` calls
  with opaque resume tokens, so correctness does not depend on an HTTP response
  surviving for the duration of a Migration Run. Server hosts still own
  authentication, authorization, transport security, and the registry-bound
  backend.
- Effect currently provides a stdio server protocol
  (`RpcServer.ts:1275-1341`) but no symmetric built-in stdio client. SSH can
  later start the same Node server in stdio mode, but the project would own the
  client-side byte-stream adapter/framing, or tunnel HTTP/TCP instead.

SSH remains a later connection option. Child-process IPC continues to preserve
the local Node runtime contract, while HTTP proves the same Migrate Protocol can
cross a stateless remote boundary.

## Implemented module boundary

Avoid a new published package until there is an independently deployable remote
server. The client contract and server implementation remain separate SDK
subpaths so clients do not import server construction code. The first
implementation uses:

```text
packages/migrate-sdk/src/protocol/
  index.ts          # schemas, errors, RPC group, and protocol version

packages/migrate-sdk/src/client/
  index.ts          # runtime-neutral Effect RPC client service and Layer

packages/migrate-sdk/src/server/
  registry-runtime.ts # registry-backed planning, execution, and observation
  registry-backend.ts # adapter from registry runtime to MigrateServer
  local-runtime.ts    # local migrate.config discovery and composition
  durable-observation.ts # durable terminal-state observation
  service.ts        # plan validation, execution registry, and observation
  handlers.ts       # RPC handlers delegating to MigrateServer

packages/tui/src/server/
  node-entry.ts     # Node config bootstrap and server Layer
  local-client.ts   # reconnectable local socket client and server launcher
  tui-runtime.ts    # MigrationTuiRuntime RPC adapter
```

Export the contract from `migrate-sdk/protocol` and registry runtime, local
loader, backend, and handler construction from `migrate-sdk/server`. Keep the
local Node process launcher in the TUI package for this local-only slice. A
deployable Migrate Server or future CLI can consume the same server module
without importing TUI code or loading a config file.

The resulting boundary is narrow: the migration engine remains unchanged, the
CLI may continue invoking it directly until its incremental client refactor,
and the TUI changes from a direct runtime implementation to a protocol-backed
implementation. Migration-control behavior now has one server-owned
implementation independent of its clients and transports.
