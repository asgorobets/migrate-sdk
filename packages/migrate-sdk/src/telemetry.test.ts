import { Cause, ConfigProvider, Effect, Schema, Tracer } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { describe, expect, it } from "vitest";
import { completedInlineExecution } from "../examples/inline-execution.ts";
import { runTelemetryExample } from "../examples/telemetry.ts";
import { localTelemetryEnvironment } from "./client/node/local-telemetry.ts";
import { skipItem } from "./domain/process-result.ts";
import {
  DestinationError,
  MigrationDefinition,
  MigrationDefinitionRegistry,
  MigrationExecution,
  type ProcessBatchPipelineFor,
  SourceIdentity,
} from "./index.ts";
import { InMemorySource } from "./sources/in-memory/index.ts";
import { InMemoryMigrationStore } from "./stores/in-memory/index.ts";
import { migrationTelemetryLayer } from "./telemetry.ts";

const Span = Schema.Struct({
  attributes: Schema.Array(
    Schema.Struct({ key: Schema.String, value: Schema.Unknown })
  ),
  name: Schema.String,
  events: Schema.Array(Schema.Struct({ name: Schema.String })),
  status: Schema.Struct({ code: Schema.Number }),
  parentSpanId: Schema.optional(Schema.String),
  spanId: Schema.String,
  traceId: Schema.String,
});
const TraceData = Schema.Struct({
  resourceSpans: Schema.Array(
    Schema.Struct({
      resource: Schema.Struct({
        attributes: Schema.Array(
          Schema.Struct({ key: Schema.String, value: Schema.Unknown })
        ),
      }),
      scopeSpans: Schema.Array(Schema.Struct({ spans: Schema.Array(Span) })),
    })
  ),
});

const enabledConfig = {
  OTEL_EXPORTER_OTLP_ENDPOINT: "http://motel.test:27686",
  OTEL_SERVICE_NAME: "migration-test",
  OTEL_TRACES_EXPORTER: "otlp",
};

const capture = <A, E>(
  program: Effect.Effect<A, E>,
  config: Record<string, string | undefined> = enabledConfig
) =>
  Effect.gen(function* () {
    const requests: {
      readonly data: typeof TraceData.Type;
      readonly url: string;
    }[] = [];
    const fetch: typeof globalThis.fetch = (input, init) => {
      const request = new Request(input, init);
      return request.json().then((data: unknown) => {
        requests.push({
          data: Schema.decodeUnknownSync(TraceData)(data),
          url: request.url,
        });
        return new Response("{}", {
          headers: { "content-type": "application/json" },
        });
      });
    };
    const result = yield* program.pipe(
      Effect.provide(migrationTelemetryLayer),
      Effect.provideService(FetchHttpClient.Fetch, fetch),
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromUnknown(config)
      )
    );
    return {
      requests,
      result,
      spans: requests.flatMap((request) =>
        request.data.resourceSpans.flatMap((resource) =>
          resource.scopeSpans.flatMap((scope) => scope.spans)
        )
      ),
    };
  });

describe("migration telemetry", () => {
  it.each([
    "single",
    "batch",
  ])("exports successful skip results from %s pipelines", (mode) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const writes: string[] = [];
        const process = Effect.fn("test.process")(function* (
          disposition: string
        ) {
          const decision = yield* Effect.succeed(
            disposition === "skip"
              ? skipItem("Outside publishing scope")
              : undefined
          ).pipe(Effect.withSpan("test.eligibility"));
          if (decision) {
            return decision;
          }
          if (disposition === "fail") {
            return yield* new DestinationError({ message: "Invalid book" });
          }
          writes.push(disposition);
        });
        const state = InMemoryMigrationStore.makeState();
        const common = {
          id: "books",
          source: InMemorySource.make({
            identity: SourceIdentity.make({
              id: "book@v1",
              schema: SourceIdentity.key("id", Schema.String),
            }),
            sourceSchema: Schema.String,
            items: ["skip", "fail", "migrate"].map((item) => ({
              identityKey: item,
              item,
              version: "v1",
            })),
          }),
          store: InMemoryMigrationStore.layer(state),
        };
        const processBatch: ProcessBatchPipelineFor<
          typeof common.source,
          DestinationError
        > = (items) =>
          items.map((item) => item.settle(process(item.source.item)));
        const definition =
          mode === "single"
            ? MigrationDefinition.make({
                ...common,
                process: (source) => process(source.item),
              })
            : MigrationDefinition.make({
                ...common,
                processBatch,
              });
        const registry = MigrationDefinitionRegistry.make({
          definitions: [definition],
        });
        const { result, spans } = yield* capture(
          completedInlineExecution(
            MigrationExecution.make({ registry }).run({ all: true })
          )
        );
        expect(result.definitions[0]?.counts).toMatchObject({
          skipped: 1,
          failed: 1,
          migrated: 1,
        });
        expect(writes).toEqual(["migrate"]);
        expect(
          [...state.itemStates.values()].find(
            (item) => item.status === "skipped"
          )
        ).toMatchObject({ skipReason: "Outside publishing scope" });
        const settlement = spans.find((span) =>
          span.attributes.some(
            (attribute) => attribute.key === "migration.item.skip.reason"
          )
        );
        expect(settlement?.name).toBe("migration.item.settle");
        expect(settlement?.status.code).toBe(1);
        expect(settlement?.attributes).toContainEqual({
          key: "migration.item.outcome",
          value: { stringValue: "skipped" },
        });
        expect(settlement?.attributes).toContainEqual({
          key: "migration.item.skip.reason",
          value: { stringValue: "Outside publishing scope" },
        });
        const skippedProcess = spans.find(
          (span) =>
            span.name === "test.process" &&
            span.parentSpanId === settlement?.spanId
        );
        expect(skippedProcess?.status.code).toBe(1);
        expect(skippedProcess?.events).toEqual([]);
        expect(
          spans
            .filter((span) => span.status.code === 2)
            .map((span) => span.name)
        ).toEqual(["test.process"]);
      })
    ));

  it.each([
    {
      name: "processing failure",
      cause: Cause.fail(new Error("Invalid book")),
    },
    { name: "defect", cause: Cause.die(skipItem("Unexpected defect")) },
    {
      name: "skip with finalizer failure",
      cause: Cause.combine(
        Cause.fail(skipItem("Skip")),
        Cause.die(new Error("Cleanup failed"))
      ),
    },
  ])("retains error status for $name", ({ cause }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { spans } = yield* capture(
          Effect.failCause<unknown>(cause).pipe(
            Effect.withSpan("process"),
            Effect.exit
          )
        );
        expect(spans[0]?.status.code).toBe(2);
        expect(spans[0]?.events).toContainEqual({ name: "exception" });
        expect(
          spans[0]?.attributes.some(
            (attribute) => attribute.key === "migration.item.outcome"
          )
        ).toBe(false);
      })
    ));

  it("preserves an application's tracer when export is disabled", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const tracer = Tracer.make({
          span: (options) => new Tracer.NativeSpan(options),
        });
        const { result, requests } = yield* capture(
          Effect.service(Tracer.Tracer),
          { ...enabledConfig, OTEL_SDK_DISABLED: "true" }
        ).pipe(Effect.provideService(Tracer.Tracer, tracer));
        expect(result).toBe(tracer);
        expect(requests).toEqual([]);
      })
    ));

  it.each([
    {
      environment: {},
      service: "migrate-sdk",
      url: "http://localhost:4318/v1/traces",
    },
    {
      environment: {
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "invalid signal endpoint",
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector.test:4318/base",
        OTEL_RESOURCE_ATTRIBUTES: "service.name=catalog%20migration",
      },
      service: "catalog migration",
      url: "http://collector.test:4318/base/v1/traces",
    },
    {
      environment: {
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://collector.test/custom",
        OTEL_RESOURCE_ATTRIBUTES: "service.name=ignored",
        OTEL_SERVICE_NAME: "custom-service",
      },
      service: "custom-service",
      url: "http://collector.test/custom",
    },
  ])("exports with local defaults and overrides: $service", ({
    environment,
    service,
    url,
  }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { requests } = yield* capture(
          Effect.void.pipe(Effect.withSpan("local-test")),
          localTelemetryEnvironment(environment)
        );
        expect(requests[0]?.url).toBe(url);
        expect(
          requests[0]?.data.resourceSpans[0]?.resource.attributes
        ).toContainEqual({
          key: "service.name",
          value: { stringValue: service },
        });
      })
    ));

  it.each([
    { OTEL_SDK_DISABLED: "true" },
    { OTEL_SDK_DISABLED: "y" },
    { OTEL_TRACES_EXPORTER: "none" },
  ])("honors explicit disabling with local defaults: %j", (environment) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { requests } = yield* capture(
          Effect.void.pipe(Effect.withSpan("local-test")),
          localTelemetryEnvironment(environment)
        );
        expect(requests).toEqual([]);
      })
    ));

  it("flushes a completed run with related window, batch, and wait spans", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { result, requests, spans } = yield* capture(runTelemetryExample);
        expect(result.status).toBe("succeeded");
        expect(result.definitions[0]?.counts.migrated).toBe(48);
        expect(requests.length).toBeGreaterThan(0);
        expect(
          requests.every(
            (request) => request.url === "http://motel.test:27686/v1/traces"
          )
        ).toBe(true);

        const run = spans.find((span) => span.name === "migration.run");
        expect(run).toBeDefined();
        expect(run?.attributes).toContainEqual({
          key: "migration.run.id",
          value: { stringValue: result.runId },
        });
        const definition = spans.find(
          (span) => span.name === "migration.definition"
        );
        expect(definition?.parentSpanId).toBe(run?.spanId);
        const windows = spans.filter(
          (span) => span.name === "migration.source.window"
        );
        expect(windows).toHaveLength(6);
        expect(
          windows.every((span) => span.parentSpanId === definition?.spanId)
        ).toBe(true);
        const batches = spans.filter((span) => span.name === "migration.batch");
        expect(batches).toHaveLength(6);
        expect(
          batches.every((batch) =>
            windows.some((window) => window.spanId === batch.parentSpanId)
          )
        ).toBe(true);
        for (const name of [
          "migration.source.read",
          "migration.batch.process",
          "demo.destination.wait",
        ]) {
          const phases = spans.filter((span) => span.name === name);
          expect(phases).toHaveLength(6);
          expect(phases.every((span) => span.traceId === run?.traceId)).toBe(
            true
          );
        }
        expect(
          spans.filter((span) => span.name === "migration.item.settle")
        ).toHaveLength(48);
        expect(
          spans.filter((span) => span.name === "migration.source.cursor.commit")
        ).toHaveLength(5);
      })
    ));

  it.each([
    {},
    { ...enabledConfig, OTEL_SDK_DISABLED: "true" },
    { ...enabledConfig, OTEL_TRACES_EXPORTER: "none" },
  ])("does not export when tracing is not enabled: %j", (config) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { requests, result } = yield* capture(
          Effect.succeed("completed").pipe(Effect.withSpan("test")),
          config
        );
        expect(result).toBe("completed");
        expect(requests).toEqual([]);
      })
    ));

  it("uses a signal-specific endpoint without appending a path", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { requests } = yield* capture(
          Effect.void.pipe(Effect.withSpan("test")),
          {
            ...enabledConfig,
            OTEL_EXPORTER_OTLP_TRACES_ENDPOINT:
              "http://motel.test/custom-traces",
          }
        );
        expect(requests[0]?.url).toBe("http://motel.test/custom-traces");
      })
    ));
});
