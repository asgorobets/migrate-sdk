import { createHash } from "node:crypto";
import { Config, ConfigProvider, Effect, Schema } from "effect";

const resourceAttributes = Config.Record(
  Schema.StringFromUriComponent,
  Schema.StringFromUriComponent,
  "OTEL_RESOURCE_ATTRIBUTES"
).pipe(Config.withDefault(undefined));

const resourceServiceName = (environment: NodeJS.ProcessEnv) =>
  Effect.runSync(
    resourceAttributes.parse(ConfigProvider.fromUnknown(environment))
  )?.["service.name"];

/** Apply local tracing defaults without mutating the client's environment. */
export const localTelemetryEnvironment = (
  environment: NodeJS.ProcessEnv
): NodeJS.ProcessEnv => ({
  ...environment,
  OTEL_EXPORTER_OTLP_ENDPOINT:
    environment.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://localhost:4318",
  // Allow a busy local receiver to drain pending batches after clients detach.
  OTEL_EXPORTER_OTLP_TRACES_TIMEOUT:
    environment.OTEL_EXPORTER_OTLP_TRACES_TIMEOUT ??
    environment.OTEL_EXPORTER_OTLP_TIMEOUT ??
    environment.OTEL_BSP_EXPORT_TIMEOUT ??
    "30000",
  OTEL_SERVICE_NAME:
    environment.OTEL_SERVICE_NAME ??
    resourceServiceName(environment) ??
    "migrate-sdk",
  OTEL_TRACES_EXPORTER: environment.OTEL_TRACES_EXPORTER ?? "otlp",
});

export const localTelemetryIdentity = (
  environment: NodeJS.ProcessEnv
): string =>
  createHash("sha256")
    .update(
      JSON.stringify(
        Object.entries(environment)
          .filter(([key]) => key.startsWith("OTEL_"))
          .sort(([first], [second]) => first.localeCompare(second))
      )
    )
    .digest("hex");

const traceEndpoint = Config.URL("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT").pipe(
  Config.orElse(() =>
    Config.URL("OTEL_EXPORTER_OTLP_ENDPOINT").pipe(
      Config.map((url) => {
        const separator = url.pathname.endsWith("/") ? "" : "/";
        url.pathname += `${separator}v1/traces`;
        return url;
      })
    )
  ),
  Config.withDefault(undefined)
);

// Match OtlpTracer.layerFromConfig using the same Effect configuration codecs.
const traceConfiguration = Config.all({
  disabled: Config.Boolean("OTEL_SDK_DISABLED").pipe(Config.withDefault(false)),
  endpoint: traceEndpoint,
  exporters: Config.Array(Schema.String, "OTEL_TRACES_EXPORTER").pipe(
    Config.map((values) => values.map((value) => value.toLowerCase().trim())),
    Config.withDefault<readonly string[]>([])
  ),
});

export const localTelemetryMessage = (
  environment: NodeJS.ProcessEnv
): string => {
  const { disabled, endpoint, exporters } = Effect.runSync(
    traceConfiguration.parse(ConfigProvider.fromUnknown(environment))
  );
  if (disabled || endpoint === undefined || !exporters.includes("otlp")) {
    return "OpenTelemetry traces disabled by OTEL configuration.";
  }

  // Endpoint credentials and query parameters may contain secrets.
  endpoint.username = "";
  endpoint.password = "";
  endpoint.search = "";
  endpoint.hash = "";
  return `OpenTelemetry traces: ${endpoint} (service: ${JSON.stringify(environment.OTEL_SERVICE_NAME)}).`;
};
