import { Layer } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { OtlpSerialization, OtlpTracer } from "effect/unstable/observability";

/**
 * Opt-in OTLP/HTTP JSON trace export using standard OTEL configuration.
 * Set OTEL_TRACES_EXPORTER=otlp, OTEL_SERVICE_NAME, and an OTLP endpoint.
 * Provide at the execution host's outer scope so completed spans flush on exit.
 * Does not install log or metric exporters.
 */
export const migrationTelemetryLayer = OtlpTracer.layerFromConfig().pipe(
  Layer.provide(OtlpSerialization.layerJson),
  Layer.provide(FetchHttpClient.layer)
);
