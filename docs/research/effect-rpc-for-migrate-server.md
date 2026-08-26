# Effect RPC for the local and remote Migrate Server

Research date: 2026-08-24

## Verdict

Effect already provides most of the protocol machinery needed here. The right
primitive is [`effect/unstable/rpc`](https://github.com/Effect-TS/effect-smol/tree/6f38f07d5941a211b251383aaab0f4f55e8a6557/packages/effect/src/unstable/rpc), not a hand-written request ID map, SSE implementation, or generic JSON-RPC wrapper.

Define the Migrate Server as schema-backed RPC groups that share one control
surface and select the observation operation appropriate to their transport.
Effect derives typed clients and typed server handlers from those groups. The
same logical protocol can run:

- locally over a reconnectable socket between the Bun renderer and a Node host;
- remotely over Effect RPC's HTTP transport;
- in tests through `RpcTest` without opening a transport.

This is legitimately “Effect over the wire” in the useful sense: callers invoke
methods that return `Effect` or `Stream`, handlers implement those methods with
`Effect` or `Stream`, schemas encode successes and typed failures, and Effect
RPC owns request correlation, stream chunks, interruption and backpressure. It
does **not** send live `Effect`, `Fiber`, `Layer`, migration definitions, or an
executable plan across the wire. Only schema-encoded data and RPC protocol
envelopes cross the boundary.

The implemented local transport uses Effect's socket protocol with NDJSON
serialization. The TUI can launch a detached Node server and reconnect to its
deterministic endpoint, while Effect still owns request correlation, streaming,
interruption, and backpressure.

## What Effect RPC provides

### One typed contract for effects and streams

`Rpc.make` defines a tagged operation with payload, success, error and defect
schemas. Setting `stream: true` changes the generated client method from an
`Effect` to a `Stream`; `RpcGroup.make` collects operations and derives the
handler surface. See `Rpc.make` and `RpcGroup.make` in
[`Rpc.ts`](https://github.com/Effect-TS/effect-smol/blob/6f38f07d5941a211b251383aaab0f4f55e8a6557/packages/effect/src/unstable/rpc/Rpc.ts#L893-L968)
and
[`RpcGroup.ts`](https://github.com/Effect-TS/effect-smol/blob/6f38f07d5941a211b251383aaab0f4f55e8a6557/packages/effect/src/unstable/rpc/RpcGroup.ts#L417-L428).

For the Migrate Server, this maps naturally to unary discovery and control
calls plus one streaming observation call. The early conceptual sketch below
predates the final operation names (`GetServerInfo`, `GetDashboard`,
`PrepareOperation`, `StartOperation`, `ObserveRun`, and `StopRun`):

```ts
const MigrateServerRpcs = RpcGroup.make(
  Rpc.make("migrate.v1.Describe", {
    success: MigrateServerDescriptor,
    error: MigrateServerDescribeError,
  }),
  Rpc.make("migrate.v1.Catalog", {
    payload: CatalogRequest,
    success: CatalogSnapshot,
    error: MigrateServerReadError,
  }),
  Rpc.make("migrate.v1.Prepare", {
    payload: PrepareRequest,
    success: PreparedOperation,
    error: MigrateServerPlanningError,
  }),
  Rpc.make("migrate.v1.Start", {
    payload: StartRequest,
    success: ExecutionReference,
    error: MigrateServerStartError,
  }),
  Rpc.make("migrate.v1.Observe", {
    payload: ObserveRequest,
    success: ExecutionEvent,
    error: MigrateServerObservationError,
    stream: true,
  }),
  Rpc.make("migrate.v1.Cancel", {
    payload: CancelRequest,
    success: CancellationResult,
    error: MigrateServerControlError,
  }),
)
```

The project-pinned `effect@4.0.0-rc.111` declarations confirm the same APIs in
`packages/tui/node_modules/effect/dist/unstable/rpc/Rpc.d.ts`,
`RpcGroup.d.ts`, `RpcClient.d.ts`, and `RpcServer.d.ts`.

### Schema encoding and typed remote errors

The schema-aware client encodes payloads with `Schema.toCodecJson`; the server
decodes them, runs the handler, and encodes the returned `Exit`, including typed
failures and defects. This is visible in `RpcClient.make` and `RpcServer.make`
in the project-pinned implementation:

- `packages/tui/node_modules/effect/dist/unstable/rpc/RpcClient.js`
- `packages/tui/node_modules/effect/dist/unstable/rpc/RpcServer.js`

The transport therefore receives plain encoded values rather than class
instances or executable SDK objects. `RpcSerialization` additionally provides
JSON, NDJSON, JSON-RPC 2.0 and MessagePack codecs for byte/string transports;
NDJSON and MessagePack maintain framing state for streams. See
[`RpcSerialization.ts`](https://github.com/Effect-TS/effect-smol/blob/6f38f07d5941a211b251383aaab0f4f55e8a6557/packages/effect/src/unstable/rpc/RpcSerialization.ts#L43-L168).

Worker transports move the already schema-encoded RPC envelopes as structured
values and do not require `RpcSerialization`. HTTP and socket transports do.

### Streaming, acknowledgement and backpressure

Streaming RPCs return a `Stream` by default or a scoped `Queue` when requested.
The client uses a bounded queue (`streamBufferSize`, default 16 in rc.111), and
live worker/socket protocols send `Ack` messages after consuming chunks. The
server waits for the acknowledgement before producing the next transmitted
chunk. The request, chunk, acknowledgement and terminal-exit vocabulary is
defined in
[`RpcMessage.ts`](https://github.com/Effect-TS/effect-smol/blob/6f38f07d5941a211b251383aaab0f4f55e8a6557/packages/effect/src/unstable/rpc/RpcMessage.ts#L34-L200),
while the acknowledgement loop is implemented by `RpcClient.makeNoSerialization`
and `RpcServer.makeNoSerialization`.

This is a good fit for cursor-commit progress. The server should emit one
coalesced `ExecutionEvent` after a durable checkpoint, not one event per source
item.

### Interruption and cancellation

Interrupting a generated client call sends an `Interrupt` message for its
request ID. The server tracks the handler fiber for that request and interrupts
it. Stream scope finalization does the same. See the client interruption path in
[`RpcClient.ts`](https://github.com/Effect-TS/effect-smol/blob/6f38f07d5941a211b251383aaab0f4f55e8a6557/packages/effect/src/unstable/rpc/RpcClient.ts#L360-L447)
and the server request-fiber handling in
[`RpcServer.ts`](https://github.com/Effect-TS/effect-smol/blob/6f38f07d5941a211b251383aaab0f4f55e8a6557/packages/effect/src/unstable/rpc/RpcServer.ts#L180-L228).

That solves transport-level cancellation, but it must not define migration
semantics. Closing the TUI's observation stream should stop only that observer;
it must not stop a provider-owned workflow. Keep `StartOperation` and
`ObserveRun` separate and make control an explicit `StopRun` RPC. The host
addresses live work by Migration Run id; the observation handler merely
attaches to durable/provider progress.

### Custom transports are first-class

`RpcClient.Protocol` and `RpcServer.Protocol` are Effect services. A custom
client protocol supplies a long-running receive loop plus `send`; a custom
server protocol supplies receive, send, disconnect and capability functions.
Built-in implementations use those same interfaces for HTTP, sockets,
WebSockets, stdio and workers. See
[`RpcClient.Protocol`](https://github.com/Effect-TS/effect-smol/blob/6f38f07d5941a211b251383aaab0f4f55e8a6557/packages/effect/src/unstable/rpc/RpcClient.ts#L852-L878)
and
[`RpcServer.Protocol`](https://github.com/Effect-TS/effect-smol/blob/6f38f07d5941a211b251383aaab0f4f55e8a6557/packages/effect/src/unstable/rpc/RpcServer.ts#L848-L879).

Lower-level `Socket`, `Channel`, `ChannelSchema`, `Queue` and `Stream` are
available if a new byte transport is required, but Effect RPC already composes
them into the required request lifecycle. `ChannelSchema.duplex` only gives
schema encoding/decoding; it does not add request IDs, typed remote exits,
interrupts or stream acknowledgements. It is therefore below the right
abstraction for this problem.

### Middleware and observability

RPC middleware can wrap server handlers, provide services, expose typed
middleware failures, and optionally add a client wrapper. Requests also carry
headers and trace context. This is enough to add authentication and deployment
identity later without changing every Migrate Protocol method. It does not
remove the need to define an authorization policy. See `RpcMiddleware.Service`
and `RpcClient.withHeaders` in the project-pinned rc.111 declarations.

## Local Node host: what is already solved

Effect's worker RPC transport was the closest match explored for
connection-scoped local process IPC:

- `RpcClient.layerProtocolWorker({ size: 1 })` provides the client protocol;
- `RpcServer.layerProtocolWorkerRunner` provides the server protocol;
- `NodeWorkerRunner.layer` runs inside either a Node worker thread **or an
  IPC-enabled child process** using `process.send`;
- `NodeWorker.layer` on a Node parent supports both worker threads and
  `ChildProcess` objects.

The child-process behavior is explicit in
[`NodeWorker.ts`](https://github.com/Effect-TS/effect-smol/blob/6f38f07d5941a211b251383aaab0f4f55e8a6557/packages/platform-node/src/NodeWorker.ts#L1-L81)
and
[`NodeWorkerRunner.ts`](https://github.com/Effect-TS/effect-smol/blob/6f38f07d5941a211b251383aaab0f4f55e8a6557/packages/platform-node/src/NodeWorkerRunner.ts#L1-L118).
The server/client bridge itself is implemented by
[`RpcClient.makeProtocolWorker`](https://github.com/Effect-TS/effect-smol/blob/6f38f07d5941a211b251383aaab0f4f55e8a6557/packages/effect/src/unstable/rpc/RpcClient.ts#L1175-L1341)
and
[`RpcServer.makeProtocolWorkerRunner`](https://github.com/Effect-TS/effect-smol/blob/6f38f07d5941a211b251383aaab0f4f55e8a6557/packages/effect/src/unstable/rpc/RpcServer.ts#L1339-L1397).

The cross-runtime caveat is on the Bun parent side. Effect's
[`BunWorker`](https://github.com/Effect-TS/effect-smol/blob/6f38f07d5941a211b251383aaab0f4f55e8a6557/packages/platform-bun/src/BunWorker.ts#L1-L100)
adapts `globalThis.Worker`; it does not adapt a Bun subprocess with an IPC
channel. `NodeWorker.layer` cannot be assumed to work under Bun because its
adapter expects Node `ChildProcess` event and send semantics.

The smallest production-safe addition is a TUI-owned
`BunSubprocessWorkerPlatform` built with Effect's public `Worker.makePlatform`:

```text
Bun renderer
  RpcClient.make(MigrateServerRpcs)
  RpcClient.layerProtocolWorker({ size: 1 })
  BunSubprocessWorkerPlatform
        │ Effect worker envelopes over Bun subprocess IPC
        ▼
Node Migrate Server
  NodeWorkerRunner.layer
  RpcServer.layerProtocolWorkerRunner
  MigrateServerRpcs handlers
  customer's config + local migrate-sdk + Node dependencies
```

The npm launcher should pass its exact `process.execPath` to the Bun renderer;
the renderer uses that path to spawn the host. The existing launcher can remain
the outer waiting process for the first version. A later cleanup can invert the
process tree if there is a compelling lifecycle reason.

One focused spike should first test whether Bun's `node:child_process.fork`
compatibility returns an object that satisfies `NodeWorker.layer`. If it does,
the custom Bun adapter may be unnecessary. Do not make that a production
assumption without the cross-platform test.

Avoid transferable payload schemas for the local child-process channel. The
worker RPC protocol advertises transferable support, while the Node
child-process branch necessarily ignores transfer lists when it calls
`ChildProcess.send`. Migrate Protocol DTOs do not need transferables, so this is
easy to enforce.

## Future HTTP and Cloudflare host

Effect RPC already has an additive remote transport:

- client: `RpcClient.layerProtocolHttp({ url })`;
- server: `RpcServer.layerHttp({ group, path, protocol: "http" })` or
  `RpcServer.toHttpEffect(group)`;
- serialization: `RpcSerialization.layerNdjson` for streamed observations;
- runtime boundary: `HttpRouter.toWebHandler` produces a Web
  `Request -> Promise<Response>` handler.

The HTTP and socket adapters are implemented alongside the worker adapters in
[`RpcClient.ts`](https://github.com/Effect-TS/effect-smol/blob/6f38f07d5941a211b251383aaab0f4f55e8a6557/packages/effect/src/unstable/rpc/RpcClient.ts#L880-L1170)
and
[`RpcServer.ts`](https://github.com/Effect-TS/effect-smol/blob/6f38f07d5941a211b251383aaab0f4f55e8a6557/packages/effect/src/unstable/rpc/RpcServer.ts#L911-L1265).
The current Effect HTTP router has a Web handler boundary suitable for a
fetch-style runtime; see
[`HttpRouter.toWebHandler`](https://github.com/Effect-TS/effect-smol/blob/6f38f07d5941a211b251383aaab0f4f55e8a6557/packages/effect/src/unstable/http/HttpRouter.ts#L1260-L1320).

That means the future Worker can provide its own registry, store and
`MigrationExecutable` layers, install the same server handlers, and expose
the same `RpcGroup` through HTTP. Scheduled handlers may invoke the underlying
SDK services directly; the TUI invokes the generated HTTP client.

This avoids designing SSE now. An `Observe` streaming RPC over framed NDJSON
already provides typed progress streaming. Polling durable status should remain
the fallback and source of truth. Cloudflare/workerd behavior, response
streaming and request-abort cleanup still require an end-to-end Worker test;
the existence of a Web `Request`/`Response` adapter is not by itself proof of a
production deployment.

## What Effect RPC does not solve

The application still owns:

- **Protocol compatibility.** There is no built-in Migrate Protocol version
  negotiation. Add a protocol namespace to tags and make `Describe` return
  `protocolVersion`, `sdkVersion`, `registryId`, and environment identity. A
  compatible server implements the complete Migrate Protocol rather than
  negotiating customer-facing operations individually.
- **Prepared-operation safety.** Never serialize
  `MigrationDefinitionExecutableRunPlan` or rollback plans; they contain
  executable definitions. Locally, retain the exact plan in the Node host and
  return an opaque receipt plus display projection. A stateless remote host may
  re-plan and compare a fingerprint before execution.
- **Durable execution semantics.** RPC request interruption is not the same as
  stopping a durable migration. Use `StartOperation`, `ObserveRun`, and explicit
  `StopRun` addressed by Migration Run id.
- **Authentication and authorization.** Middleware and headers are mechanisms,
  not policy.
- **Host lifecycle.** Spawn, signal forwarding, detach behavior, log routing and
  crash reporting stay in the launcher/host adapter.
- **Wire DTOs.** Existing TUI types are TypeScript interfaces, not all schemas.
  Add explicit customer-facing DTO schemas. Do not expose config objects,
  registry definitions, stores, causes or arbitrary `unknown` values.

## Do not use Effect Cluster for this seam

Effect Cluster builds sharded entities, mailboxes, runner discovery, persistent
message delivery and storage on top of RPC groups. `Entity` explicitly wraps an
`RpcGroup` with shard addressing and cluster errors. See
[`Entity.ts`](https://github.com/Effect-TS/effect-smol/blob/6f38f07d5941a211b251383aaab0f4f55e8a6557/packages/effect/src/unstable/cluster/Entity.ts#L1-L180).

Those facilities may be relevant inside a future distributed execution
provider, but they are not needed for one TUI client talking to one Migrate
Server. Adding Cluster now would introduce storage, runner and sharding concepts
that do not solve the runtime-compatibility problem.

## Implemented repository boundary

Put the contract in a runtime-independent SDK export, not in the OpenTUI
package:

```text
packages/migrate-sdk/src/protocol/index.ts
  schema-backed Migrate Protocol and transport-specific RPC groups

packages/migrate-sdk/src/client/index.ts
  one logical client with streaming-socket and bounded-HTTP Layers

packages/migrate-sdk/src/server/
  service.ts          plan validation, execution ownership, observation
  handlers.ts         streaming and HTTP handler Layers
  registry-runtime.ts registry and executable orchestration
  registry-backend.ts server backend adapter
  local-runtime.ts    local migrate.config discovery only

packages/tui/src/server/
  node-entry.ts       local Node socket host
  local-client.ts     socket connection and detached server launcher
  remote-client.ts    authenticated HTTP connection
  tui-runtime.ts      thin protocol-to-UI adapter
```

The `RpcGroup` is the protocol API; do not duplicate it with a hand-maintained
`MigrateClient` interface. `RpcClient.FromGroup` derives that
interface, `RpcGroup.toLayer` derives the handler requirements, and
`RpcTest.makeClient` provides an in-memory client for contract tests. The CLI
may continue calling the underlying services during the incremental refactor,
but the intended migration-control seam is the Migrate Server interface, used
in-process or remotely.

The registry runtime in
[`packages/migrate-sdk/src/server/registry-runtime.ts`](../../packages/migrate-sdk/src/server/registry-runtime.ts)
accepts an already-built registry and executable and owns the orchestration
behind the handlers. Its
`ExecutableMigrationOperation.plan` is deliberately runtime-only; the
registry backend projects it to the schema-backed, wire-safe
`MigratePreparedOperation`. Existing registry entries are already plain
DTO-shaped data, while executable plans contain `registryDefinitions` and
branded runtime-only markers; see
[`packages/migrate-sdk/src/domain/registry.ts`](../../packages/migrate-sdk/src/domain/registry.ts).

## Implemented slice

The SDK now owns the complete schema-backed operation contract, registry-backed
server construction, exact-request replanning, run-based observation, and
server-owned stop behavior. The TUI connects locally over a reconnectable
socket or remotely over authenticated HTTP. HTTP observation is composed from
bounded leases so no response or serverless invocation owns a run's lifetime.
The worker transport explored above is not part of the implementation.

## Risk assessment

The API lives under `effect/unstable/rpc`, and this repository is pinned to an
Effect 4 release candidate. Treat the Effect wire protocol as an internal
implementation detail, pin the same Effect version on both ends of the local
channel, and add encoded-message/compatibility tests before permitting an
independently upgraded remote TUI and host. The application-level
`migrate.v1` contract must remain stable even if its Effect transport adapter
changes.

For the immediate local use case, this risk is bounded because the TUI and SDK
are versioned together and the Node host ships with the TUI. For the remote
endgame, `GetServerInfo` must reject incompatible protocol ranges before the TUI
performs planning or control actions. If independent client/server evolution
becomes a public compatibility promise, freeze the external HTTP contract and
keep Effect RPC behind an adapter rather than exposing Effect's unstable wire
format as the permanent public protocol.
