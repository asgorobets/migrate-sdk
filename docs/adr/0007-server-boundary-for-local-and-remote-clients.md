# Server Boundary for Local and Remote Clients

Migrate Clients such as the TUI will communicate with a Migrate Server that
runs in the environment owning the migration registry and its credentials. The
Migrate Protocol is versioned and schema-backed, while Migrate Connections and
Execution Adapters remain separate choices. This supports a Node-hosted
local configuration and remote HTTPS operation now, with SSH remaining a later
connection option, without making the TUI own remote database, source,
destination, or workflow-provider access.

## Status

Accepted

## Context

The CLI currently loads a customer configuration and invokes the SDK in the
same process. That is appropriate for a command-line host, but it does not give
the TUI a durable runtime boundary. The TUI renderer may run under Bun while a
customer's existing configuration and migration dependencies require Node.

The published TUI launches its renderer with a package-pinned Bun executable,
then starts a local Node Migrate Server over child-process IPC. The customer
config and its dependencies load only in that Node process. Customers do not
need to install Bun globally, and configs that already work through the
Node-based CLI retain the same runtime contract in the TUI.

The same problem becomes more important for remote execution. A remote
environment may own its Migration Store, Sources, Destinations, execution
provider, and credentials. Requiring a local TUI to reproduce those connections
would duplicate sensitive configuration, make the local machine responsible for
selecting the correct environment, and prevent operation when the remote
resources are intentionally inaccessible from the user's machine.

Execution transport and execution strategy are different concerns. SSH, local
process IPC, and HTTPS answer how a client reaches the environment that owns the
migrations. Inline execution, Workflow SDK, Effect Workflow, and future durable
providers answer how that environment executes them.

## Considered Options

- Keep invoking the SDK inside the TUI process and require Bun-compatible
  customer configurations.
- Let the TUI connect directly to each remote Migration Store, Source,
  Destination, and execution provider.
- Add provider-specific TUI clients, such as a Vercel client and an SSH client.
- Shell out to the CLI and parse command output as the TUI integration contract.
- Introduce one schema-backed Migrate Server contract with pluggable local and
  remote connections.

## Decision

A **Migrate Server** is the application boundary for interactive and remote
migration operations. It runs with the authoritative Migration Definition
Registry and the environment's required Effect layers, including Migration
Stores, Sources, Destinations, and the environment-selected Migration
Executable. It
exposes discovery, status, messages, planning, starting, observation,
cancellation, rollback, source scanning, and lock recovery through one
**Migrate Protocol**.

The TUI is a **Migrate Client**. It does not load remote migration definitions,
choose a workflow provider, or require credentials for the resources behind a
server. A connection profile identifies the server target and access method.
The server describes its registry, deployment or environment identity, protocol
version, and SDK version so that the client can detect incompatibility before
offering an action. Every compatible Migrate Server implements the complete
Migrate Protocol; customer-facing operations are not negotiated individually.

The first local connection uses a Node Migrate Server process started by
the TUI. The Bun renderer communicates with that process over a reconnectable
local Effect RPC socket, while the
Node process loads the same local configuration and SDK package that the CLI
would load. The npm launcher remains responsible for locating and passing the
user's Node executable. This preserves the existing Node authoring contract
without requiring customers to rewrite migrations for Bun.

Remote connections use the same logical Migrate Protocol:

- SSH may start a Migrate Server in stdio mode for a connection-scoped session.
- SSH may also tunnel to a persistent Migrate Server when the server must
  outlive the shell session.
- HTTPS may expose the Migrate Server from a deployed application, including an
  application that starts and observes a durable workflow provider.

These are **Migrate Connections**, not Execution Adapters. A TUI does not
select `vercel`, `workflow`, or another provider. The remote server's deployed
configuration selects its Migration Executable. Provider-specific dashboards
or execution references may be returned as metadata, but provider credentials
and control remain behind the server boundary.

The Migrate Protocol carries only schema-encoded requests, results, progress
events, and typed errors. Effects, Layers, Migration Definitions, and executable
plans never cross it. Planning results are serializable projections. When a
client accepts a plan, it sends the original operation request and the accepted
plan fingerprint. The server plans again against its current authoritative
registry and rejects the start if the plan has changed. This applies the same
principle as a Migration Execution Envelope: diagnostic order may cross an
execution boundary, but the receiving environment plans authoritatively.

Durable Migration Run State and Migration Item State remain authoritative for
status and item progress. Provider or attached-host events supplement that
state with timely checkpoint updates. Observation is reconnectable. Ending an
observation stops only that observer; stopping a run requires an explicit
`StopRun` operation.

HTTPS observation uses bounded, resumable leases rather than making one HTTP
response own the lifetime of a Migration Run. `ObserveRunLease` accepts an
opaque resume token and returns token-bearing observation events. A lease starts
with the current absolute durable progress snapshot, suppresses an already-seen
snapshot, and then waits for a later checkpoint or terminal state until its
configured duration ends. The client concatenates leases into one logical
observation stream. Replayed snapshots are safe because progress events carry
absolute counts rather than deltas. The opaque resume token retains the run's
durable observation definition so later leases can address its Migration Store
directly.
Transient lifecycle states and warnings are delivered with the next progress or
completion checkpoint and do not independently advance the resume position.

Whole-dashboard observation follows the same transport split. Connection-based
clients consume `ObserveDashboard` as a stream of complete
`MigrateDashboardSnapshot` envelopes containing both the dashboard and its
opaque content fingerprint. `GetDashboard` returns the same envelope. HTTPS
clients concatenate unary `ObserveDashboardLease` requests, passing the
fingerprint into the next lease. A lease returns the first changed complete
snapshot or a heartbeat when its bounded execution window expires. A fresh
serverless invocation reconstructs the dashboard from the registry and
Migration Stores before waiting, so neither client identity nor server process
memory is required for resumption.

Execution events are private invalidation signals, not competing dashboard
payloads. Inline item progress, lifecycle changes, provider checkpoints,
successful controls, and a subscriber-scoped fallback mark the server's
dashboard projection dirty. The server coalesces those signals, performs only
one durable projection read at a time, and multicasts the resulting absolute
snapshots. Each subscriber suppresses identical fingerprints after discarding
any shared projection that predates its subscription. The fallback remains
active while a dashboard subscriber exists even when the previous snapshot has
no active runs; otherwise a run started by cron or another host could not be
discovered without a process-local signal.

Focused `ObserveRun` remains separate. It supplies run-specific warnings,
messages, lifecycle, and terminal detail, but it does not update aggregate
dashboard rows. Client navigation and source-inventory results are also not
server observation state: the TUI retains selection locally and overlays
`ScanSource` results over subsequently streamed durable rows.

Attaching to provider events within a lease is an optional latency optimization.
A serverless function, deployment, or network connection may end between any
two leases; the next invocation reconstructs observation from the durable
Migration Store and the Execution Adapter identity stored on the Migration Run.
Process memory is never required for provider-owned run discovery or
observation.

The Migrate Protocol separates observation from control. Ending an observation
or closing a client never stops a Migration Run. `StopRun` addresses one
Migration Run id and reports requested, not-running, or unsupported. The local
server can stop inline work it owns; provider-owned work remains unsupported
until its Execution Adapter exposes provider-neutral cancellation. Breaking a
Migration Definition Lock is recovery metadata management and never claims to
cancel the provider execution.

The local Node server is connection-independent while it owns active work. It
accepts a later client on the same local socket and exits after all clients have
disconnected and no active Migration Run remains. It owns an independent
execution and cancellation handle for each started run. Non-overlapping plans
can therefore run concurrently; Migration Definition Locks remain the
authoritative conflict mechanism for plans whose definition sets overlap. This
gives inline local runs the same client-detachment semantics as remote
persistent servers without turning a renderer process into the execution
owner.

The controlled local and remote implementations may use Effect RPC to derive
clients and handlers from the schema-backed contract, including streaming
observation. Effect RPC is currently unstable, so its wire representation is an
internal implementation detail rather than the public compatibility promise.
The application-level Migrate Protocol and version negotiation are owned by
Migrate SDK and must remain independently versioned. Connection implementations
hide their observation transport: local IPC uses an RPC stream, while HTTPS
concatenates bounded observation leases into the same client-facing stream.
Their internal Effect RPC groups expose only the observation operation valid for
that transport, so an HTTPS caller cannot open the local unbounded stream.

The server implementation derives its advertised Migrate Protocol and SDK
versions. Hosts provide deployment environment metadata, and low-level backend
adapters may provide a registry identity. The registry-backed server constructor
derives that identity from its registry, so host code cannot advertise a
registry or protocol that differs from the server it actually constructed.

The SDK exposes one logical `MigrateClient` service with streaming and HTTP
Layer constructors, plus `MigrateServer.make` / `MigrateServer.layer`. A remote
host provides its `MigrationExecutable` Layer to `RegistryMigrateServer.layer`,
then provides the resulting server to `MigrateServerHttp.layer`. The HTTP Layer
constructs the routerless RPC application; application-owned Effect HTTP
middleware supplies authentication and other transport policies in the same
request fiber. Only the framework route converts the fully composed application
with `MigrateServerHttp.toWebHandler`. Transports provide the RPC protocol
required by the appropriate client Layer, while server hosts provide the
registry-bound backend required by the server Layer. Tests use those same
interfaces for Migrate Protocol, service, transport, and packaging behavior.
Renderer-only component tests may adapt the registry-backed migration server
runtime in process; the IPC and Pilotty suites remain responsible for verifying
the process and protocol boundary.

The CLI may continue loading configuration and invoking the SDK directly during
an incremental refactor. The intended seam for migration-control commands is
the Migrate Server interface: local commands may call it in-process, while
remote commands use a Migrate Connection. Store schema and other
infrastructure-only commands may remain outside that interface.

## Consequences

- Existing Node migrations can be operated through the Bun-rendered TUI without
  changing the customer's migration runtime.
- Closing the TUI ends observation only; local inline work remains owned by the
  reconnectable Node Migrate Server until it reaches a terminal state or a
  client explicitly requests a stop.
- Remote operation requires only credentials for the Migrate Server; resource
  and provider credentials remain in the target environment.
- Local IPC, SSH, and HTTPS clients can share one operation and event model.
- Execution providers remain replaceable behind Migration Executable instead of
  becoming TUI integrations.
- The TUI and server negotiate protocol and SDK compatibility and exchange
  registry and environment identity before operations begin.
- Contextual availability, such as rollback support or whether a run can be
  stopped, is represented by migration and run data rather than server feature
  negotiation.
- HTTPS Migrate Servers require authentication, authorization, transport
  security, and deployment-specific lifecycle handling.
- A connection-scoped SSH Migrate Server cannot guarantee survival of inline
  work after disconnect. Long-running remote work must use a durable Execution
  Adapter or a persistent Migrate Server.
- Streaming observation is an optimization over durable state, not a second
  source of truth, and reconnecting clients must be able to refresh from stored
  status.
- Remote clients can compose bounded HTTP observation leases into a continuous
  interface without keeping a serverless invocation alive for the run duration.
- Dashboard clients receive complete durable snapshots for every migration;
  changing TUI selection affects only optional focused observation and never
  interrupts aggregate freshness.
- Inline and provider progress can wake one shared dashboard projection without
  exposing provider event formats or making clients poll every second.
- The boundary extracts serializable server requests and handlers from the
  in-process server runtime without rewriting the migration engine or changing
  the existing Execution Adapter interface.

## Related Research

- [Effect RPC for the local and remote Migrate Server](../research/effect-rpc-for-migrate-server.md)
