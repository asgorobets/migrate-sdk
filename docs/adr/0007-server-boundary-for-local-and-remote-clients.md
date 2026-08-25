# Server Boundary for Local and Remote Clients

Migrate Clients such as the TUI will communicate with a Migrate Server that
runs in the environment owning the migration registry and its credentials. The
Migrate Protocol is versioned and schema-backed, while Migrate Connections and
Execution Adapters remain separate choices. This supports a Node-hosted
local configuration now and remote SSH or HTTPS operation later without making
the TUI own remote database, source, destination, or workflow-provider access.

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
Stores, Sources, Destinations, and the configured Migration Executable. It
exposes discovery, status, messages, planning, starting, observation,
cancellation, rollback, source scanning, and lock recovery through one
**Migrate Protocol**.

The TUI is a **Migrate Client**. It does not load remote migration definitions,
choose a workflow provider, or require credentials for the resources behind a
server. A connection profile identifies the server target and access method.
The server describes its registry, deployment or environment identity, protocol
version, SDK version, and supported capabilities so that the client can detect
incompatibility before offering an action.

The first local connection uses a Node Migrate Server process started by
the TUI. The Bun renderer communicates with that process over IPC, while the
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
state with timely checkpoint updates. Observation is reconnectable where the
server supports it. Ending an observation stops only that observer; cancelling
a detached run requires an explicit cancellation operation.

The controlled local and remote implementations may use Effect RPC to derive
clients and handlers from the schema-backed contract, including streaming
observation. Effect RPC is currently unstable, so its wire representation is an
internal implementation detail rather than the public compatibility promise.
The application-level Migrate Protocol, version negotiation, and capability
semantics are owned by Migrate SDK and must remain independently versioned.

The SDK exposes `MigrateClient.make` / `MigrateClient.layer` and
`MigrateServer.make` / `MigrateServer.layer`. Transports provide the RPC
protocol required by the client Layer, while server hosts provide the
registry-bound backend required by the server Layer. Tests use those same
interfaces for Migrate Protocol, service, transport, and packaging behavior.
Renderer-only component tests may adapt the configured migration host in
process; the IPC and Pilotty suites remain responsible for verifying the
process and protocol boundary.

The CLI may continue loading configuration and invoking the SDK directly. It is
not required to route local one-shot commands through the Migrate Protocol.
Shared server handlers should still delegate to the same registry-bound SDK
services used by the CLI rather than reimplementing migration behavior.

## Consequences

- Existing Node migrations can be operated through the Bun-rendered TUI without
  changing the customer's migration runtime.
- Remote operation requires only credentials for the Migrate Server; resource
  and provider credentials remain in the target environment.
- Local IPC, SSH, and HTTPS clients can share one operation and event model.
- Execution providers remain replaceable behind Migration Executable instead of
  becoming TUI integrations.
- The TUI and server must negotiate protocol, SDK, registry, environment, and
  capability information before exposing unsupported actions.
- HTTPS Migrate Servers require authentication, authorization, transport
  security, and deployment-specific lifecycle handling.
- A connection-scoped SSH Migrate Server cannot guarantee survival of inline
  work after disconnect. Long-running remote work must use a durable Execution
  Adapter or a persistent Migrate Server.
- Streaming observation is an optimization over durable state, not a second
  source of truth, and reconnecting clients must be able to refresh from stored
  status.
- The boundary extracts serializable server requests and handlers from the
  in-process server runtime without rewriting the migration engine or changing
  the existing Execution Adapter interface.

## Related Research

- [Effect RPC for the local and remote Migrate Server](../research/effect-rpc-for-migrate-server.md)
