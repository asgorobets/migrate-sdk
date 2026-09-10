# OpenTelemetry tracing

Migrate SDK exports migration traces using OpenTelemetry Protocol (OTLP). Configure
an endpoint for your observability service or an OpenTelemetry Collector, then
inspect the traces in your chosen viewer. The SDK has no dependency on a particular
collector or viewer.

The built-in exporter sends traces over OTLP/HTTP with JSON encoding. Configure
your observability service or Collector to receive this format. For other
protocols or formats, use an OpenTelemetry Collector configured with the
appropriate backend exporter, or use your application's existing Effect tracer.

## Quick local setup

Start a receiver that accepts OTLP/HTTP JSON, then add `--otel` when launching
the CLI or TUI:

```sh
migrate run articles --otel --config migrate.config.ts
migrate-tui --otel --config migrate.config.ts
```

The flag enables traces with service name `migrate-sdk` and sends them to
`http://localhost:4318/v1/traces`. No environment variables are required for a
receiver on the standard HTTP port. The receiver must already be running.
The startup message shows the configured service and endpoint. The local server
allows up to 30 seconds to flush pending spans on shutdown, giving a busy receiver
time to finish ingesting the run. Explicit exporter timeout settings override
this budget.

Existing `OTEL_*` values override these defaults, including
`OTEL_SDK_DISABLED=true` or `OTEL_TRACES_EXPORTER=none` to disable export.
For Motel's default port, only one override is needed:

```sh
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:27686 \
  migrate-tui --otel --config migrate.config.ts
```

The flag configures the local execution server. It cannot be combined with
`--server`; remote execution needs telemetry configured on the remote host.
When using `--otel`, changing telemetry settings selects a separate local server
so an existing server cannot silently retain different settings. Keep the same
flag and environment when reconnecting to observe an active run. Existing runs
continue on their original server.

## Configure the exporter with environment variables

Environment variables also work without the flag, including for applications
that provide `migrationTelemetryLayer` directly. Set these variables in the
process that executes migrations. For a Collector
listening locally on its OTLP/HTTP port:

```sh
export OTEL_TRACES_EXPORTER=otlp
export OTEL_SERVICE_NAME=my-migrations
export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318
```

The SDK sends traces to `http://127.0.0.1:4318/v1/traces`. Replace the base URL
with your service's OTLP/HTTP endpoint. This example assumes the receiver is
already running; the SDK does not start a collector.

For a hosted service that supplies a full trace URL and an authentication header:

```sh
export OTEL_TRACES_EXPORTER=otlp
export OTEL_SERVICE_NAME=my-migrations
export OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=https://ingest.example.com/v1/traces
export OTEL_EXPORTER_OTLP_TRACES_HEADERS='Authorization=Bearer%20YOUR_TOKEN'
```

Replace the example URL and header with the values from your provider. Headers
are comma-separated `name=value` pairs; percent-encode header values when needed,
for example `%20` for a space. API-key authentication can use
`'x-api-key=YOUR_API_KEY'` instead. Supply actual credentials through your
execution environment or secret manager.

`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` takes precedence over the base endpoint and
is used as-is. Use it when your provider supplies a full ingestion path; using
that full path as the base endpoint would append another `/v1/traces`. These URL
and header conventions follow the [OTLP exporter configuration specification](https://opentelemetry.io/docs/specs/otel/protocol/exporter/).

Optional resource metadata identifies the deployment in your viewer:

```sh
export OTEL_RESOURCE_ATTRIBUTES='deployment.environment.name=development,service.version=1.0.0'
```

| Setting | Purpose |
| --- | --- |
| `OTEL_TRACES_EXPORTER=otlp` | Enable export; unset or `none` leaves it off |
| `OTEL_SERVICE_NAME` | Service name when enabled; alternatively set `service.name` in resource attributes |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Base URL; `/v1/traces` is appended |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | Full trace URL; overrides the base endpoint |
| `OTEL_EXPORTER_OTLP_TRACES_HEADERS` | Trace request headers; falls back to `OTEL_EXPORTER_OTLP_HEADERS` |
| `OTEL_RESOURCE_ATTRIBUTES` | Comma-separated resource metadata shared by exported spans |
| `OTEL_BSP_SCHEDULE_DELAY` | Export interval in milliseconds; default 5000 |
| `OTEL_BSP_MAX_EXPORT_BATCH_SIZE` | Maximum spans per export batch; default 1000 |
| `OTEL_EXPORTER_OTLP_TRACES_TIMEOUT` | Bounds the shutdown flush in milliseconds; default 30000 with `--otel`, otherwise 3000 |
| `OTEL_SDK_DISABLED=true` | Disable export |

The timeout falls back to `OTEL_EXPORTER_OTLP_TIMEOUT`, then
`OTEL_BSP_EXPORT_TIMEOUT`. The table describes the settings supported by this
layer; other OpenTelemetry SDK settings, such as protocol switching or certificate
file variables, are not automatically supported.

## Trace your own migrations

The CLI and the local Node Migrate Server used by CLI/TUI clients install the
exporter automatically when trace export, a service name, and an endpoint are
configured. For example, after building the package:
```sh
migrate run articles \
  --config migrate.config.ts
```

Set the variables before starting the CLI or TUI. Without `--otel`, an already-running local
server retains its startup environment; close its clients and let active work
finish before reconnecting with changed telemetry settings. Remote executions
need the exporter configured on their execution host.

For an application that runs the SDK directly, use the same environment variables
and provide the layer around the whole execution lifetime, including waiting for
any started run to finish:

```ts
import { Effect } from "effect";
import { migrationTelemetryLayer } from "migrate-sdk/telemetry";

const program = Effect.gen(function* () {
  const start = yield* execution.run({ all: true });
  if (start.kind === "started" && start.handle !== undefined) {
    return yield* start.handle.wait;
  }
  return start;
});

await Effect.runPromise(program.pipe(Effect.provide(migrationTelemetryLayer)));
```

The scope batches ended spans and flushes on shutdown. Long-lived hosts export
periodically (five seconds by default). Applications already using an Effect
tracer can keep their existing exporter; the new SDK spans use that tracer too.

Intentional skips are successful pipeline results. Return `skipItem(reason)` from
an ordinary pipeline, or `Effect.succeed(skipItem(reason))` from a deferred batch
settlement. Their spans complete successfully with any Effect tracer; no exporter
remapping is needed. The enclosing `migration.item.settle` span records
`migration.item.outcome=skipped` and `migration.item.skip.reason`. Actual failures
remain errors.

`skipItem` no longer uses the error channel. Replace `return yield* skipItem(...)`
with `return skipItem(...)`, and `Effect.fail(skipItem(...))` with
`Effect.succeed(skipItem(...))`. A nested helper's returned skip must be explicitly
returned by its caller. Throwing or failing with a skip value is a failure, not a
request to skip.

## Forward through an OpenTelemetry Collector

A Collector lets the migration process use one stable endpoint while you configure
backend credentials and outgoing transport separately. For example, this Collector
configuration receives local HTTP traces and forwards them to a hosted HTTP
backend:

```yaml
receivers:
  otlp:
    protocols:
      http:
        endpoint: 127.0.0.1:4318

processors:
  batch: {}

exporters:
  otlp_http/backend:
    endpoint: ${env:BACKEND_OTLP_ENDPOINT}
    headers:
      Authorization: ${env:BACKEND_AUTHORIZATION}

service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [batch]
      exporters: [otlp_http/backend]
```

Save this as `otel-collector.yaml`. In the Collector's environment, set
`BACKEND_OTLP_ENDPOINT` to the backend's OTLP/HTTP base URL and
`BACKEND_AUTHORIZATION` to its full authorization value, such as `Bearer TOKEN`
(with a literal space here). Adjust or omit the header to match the backend.
Start your installed Collector with `otelcol --config=otel-collector.yaml`, and
point the SDK at `http://127.0.0.1:4318` using the first configuration example.

This example assumes the Collector and SDK run on the same host. For containers
or separate hosts, configure the receiver's listen address and the SDK's endpoint
for that network. Select a gRPC or provider-specific exporter when required by the
backend. Component names depend on the installed Collector distribution; the
example uses the current `otlp_http` name. See the official
[Collector configuration guide](https://opentelemetry.io/docs/collector/configuration/)
for available exporters and deployment configuration.

## Run the local performance demo

With your exporter environment configured and its receiver running, run from
this repository:

```sh
pnpm --filter migrate-sdk demo:telemetry
MIGRATE_DEMO_BATCH_SIZE=16 MIGRATE_DEMO_CONCURRENCY=2 \
  pnpm --filter migrate-sdk demo:telemetry
MIGRATE_DEMO_BATCH_SIZE=16 MIGRATE_DEMO_CONCURRENCY=4 \
  pnpm --filter migrate-sdk demo:telemetry
```

The demo uses 48 synthetic items and an in-memory store. Each source window
simulates a 25 ms destination submission, a 50 ms polling wait, and 10 ms of
settlement work per item. Defaults are eight items per window and concurrency
two. Each invocation starts fresh; use the trace ID to distinguish runs because
the in-memory store reuses `run-1`.

Find the configured service name in your viewer. Compare `migration.run`
duration, number of windows, time in `demo.destination.wait`, and overlap between
`migration.item.settle` spans. Change one setting at a time. The artificial
delays demonstrate how to read traces; they are not a provider benchmark.

The demo also works through `pnpm exec turbo run demo:telemetry --filter=migrate-sdk`.
Its task is uncached and passes through the OTEL and demo environment variables.

### Recommended local viewer: Motel

[Motel](https://github.com/kitlangton/motel) is a convenient option for local
inspection: it receives OTLP traces and provides a trace waterfall and query API.
With Bun installed, start it in another terminal:

```sh
bunx @kitlangton/motel
```

Point the same exporter at its local receiver, then run the demo or your migration:

```sh
export OTEL_TRACES_EXPORTER=otlp
export OTEL_SERVICE_NAME=my-migrations
export OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://127.0.0.1:27686/v1/traces
```

When switching from a hosted service, also clear or replace its exporter headers.
Select `my-migrations` in Motel to view the traces. Any other receiver that
accepts OTLP/HTTP JSON can be used by changing the endpoint.

## What the spans measure

| Span | What to inspect |
| --- | --- |
| `migration.run` | Execution through finalization and lock release; run ID and final status |
| `migration.definition` | One inline definition's execution and status |
| `migration.source.targeted` | Backlog or explicitly targeted work before cursor discovery |
| `migration.source.lookup` / `.attempt` | Identity lookup including retries / one attempt |
| `migration.source.window` | Read, process, settle, and commit one cursor window; item count and concurrency |
| `migration.source.read` / `.attempt` | Source read including retry delays / one attempt |
| `migration.source.cursor.commit` | Persist the next cursor after outcomes are durable |
| `migration.item` | An ordinary item's admission and processing |
| `migration.item.admit` | Read prior state, decode, and decide whether work is needed |
| `migration.batch` | Admission, batch callback, and all settlements; source/admitted counts |
| `migration.batch.process` | The migration author's batch callback |
| `migration.item.settle` | Execute deferred work and persist one item's outcome |

Existing named `Effect.fn` calls from sources, stores, destinations, and user
pipelines appear underneath these phases. Cursor-window spans also apply when
an adapter calls the window executor separately. Durable workflow steps may
have separate trace IDs: this change does not propagate context through the
workflow provider or measure time suspended between steps. Run ID and
definition ID attributes allow those windows to be correlated if their host
installs an exporter.

The [Workflow SDK example](../examples/workflow-sdk/README.md#inspect-local-workflow-steps-with-opentelemetry)
installs the exporter in each step and adds `workflow.step.*` spans with Workflow
run, step, and attempt attributes. Follow its local setup to inspect the migration
and SQL work inside each step.

For waits inside your own pipeline, give the actual wait an explicit span:

```ts
yield* Effect.sleep(pollInterval).pipe(
  Effect.withSpan("destination.poll.wait", {
    attributes: { "migration.wait.reason": "poll-interval" },
  })
);
```

Use the same pattern around a bulk submission or polling request. A long batch
callback alone cannot distinguish network time from intentional waiting.
For source retries, compare `migration.source.read` with its attempt spans;
the gaps include retry scheduling and backoff.

Compare one setting at a time on the same input and saved-state conditions.
Increasing process concurrency affects ordinary item pipelines and batch
settlements; concurrency inside `processBatch` belongs to the callback itself.
Larger windows can reduce repeated submission and polling overhead, but must
respect provider limits. Overlapping spans and parent/child spans must not be
summed as elapsed run time. Trace collection itself also adds overhead.

The added attributes contain IDs, counts, modes, and outcomes rather than source
payloads or cursors. Existing spans and exception details may still include
application data. Per-item spans can be numerous on large scans; use bounded
local runs while investigating.
