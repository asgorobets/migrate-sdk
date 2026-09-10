import { afterEach, describe, expect, it, vi } from "vitest";
import { localMigrateServerEndpoint } from "./local-connection.ts";
import {
  localTelemetryEnvironment,
  localTelemetryMessage,
} from "./local-telemetry.ts";

afterEach(() => vi.unstubAllEnvs());

describe("local telemetry startup", () => {
  it.each([
    [{}, "30000"],
    [{ OTEL_BSP_EXPORT_TIMEOUT: "5000" }, "5000"],
    [
      { OTEL_BSP_EXPORT_TIMEOUT: "5000", OTEL_EXPORTER_OTLP_TIMEOUT: "6000" },
      "6000",
    ],
    [
      {
        OTEL_EXPORTER_OTLP_TIMEOUT: "6000",
        OTEL_EXPORTER_OTLP_TRACES_TIMEOUT: "7000",
      },
      "7000",
    ],
  ])("preserves timeout precedence for %j", (environment, expected) => {
    expect(
      localTelemetryEnvironment(environment).OTEL_EXPORTER_OTLP_TRACES_TIMEOUT
    ).toBe(expected);
  });

  it("preserves custom headers and does not mutate the client environment", () => {
    const environment = { OTEL_EXPORTER_OTLP_HEADERS: "Authorization=secret" };
    const result = localTelemetryEnvironment(environment);
    expect(result.OTEL_EXPORTER_OTLP_HEADERS).toBe("Authorization=secret");
    expect(environment).toEqual({
      OTEL_EXPORTER_OTLP_HEADERS: "Authorization=secret",
    });
    expect(localTelemetryMessage(result)).toBe(
      'OpenTelemetry traces: http://localhost:4318/v1/traces (service: "migrate-sdk").'
    );
  });

  it("uses the decoded service name from resource attributes", () => {
    const environment = localTelemetryEnvironment({
      OTEL_RESOURCE_ATTRIBUTES: "service.name=nightly%20catalog,env=local",
    });
    expect(environment.OTEL_SERVICE_NAME).toBe("nightly catalog");
    expect(localTelemetryMessage(environment)).toBe(
      'OpenTelemetry traces: http://localhost:4318/v1/traces (service: "nightly catalog").'
    );
  });

  it("prefers an explicit service name over resource attributes", () => {
    expect(
      localTelemetryEnvironment({
        OTEL_RESOURCE_ATTRIBUTES: "service.name=resource-name",
        OTEL_SERVICE_NAME: "explicit-name",
      }).OTEL_SERVICE_NAME
    ).toBe("explicit-name");
  });

  it("rejects malformed resource attributes through Effect configuration", () => {
    expect(() =>
      localTelemetryEnvironment({
        OTEL_RESOURCE_ATTRIBUTES: "service.name=%invalid",
      })
    ).toThrow();
  });

  it("reports a custom trace path without exposing endpoint credentials", () => {
    const environment = localTelemetryEnvironment({
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT:
        "https://user:secret@collector.test/traces?token=secret",
      OTEL_SERVICE_NAME: "catalog",
    });
    expect(localTelemetryMessage(environment)).toBe(
      'OpenTelemetry traces: https://collector.test/traces (service: "catalog").'
    );
  });

  it("reports explicit disabling instead of announcing trace export", () => {
    expect(
      localTelemetryMessage(
        localTelemetryEnvironment({ OTEL_SDK_DISABLED: "true" })
      )
    ).toBe("OpenTelemetry traces disabled by OTEL configuration.");
  });

  it.each([
    "true",
    "yes",
    "on",
    "1",
    "y",
  ])("uses Effect's disabled boolean: %s", (value) => {
    expect(
      localTelemetryMessage(
        localTelemetryEnvironment({ OTEL_SDK_DISABLED: value })
      )
    ).toBe("OpenTelemetry traces disabled by OTEL configuration.");
  });

  it("rejects an invalid boolean instead of announcing a different configuration", () => {
    expect(() =>
      localTelemetryMessage(
        localTelemetryEnvironment({ OTEL_SDK_DISABLED: "TRUE" })
      )
    ).toThrow();
  });

  it("uses the base URL when the signal-specific URL is invalid", () => {
    expect(
      localTelemetryMessage(
        localTelemetryEnvironment({
          OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector.test/base/",
          OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "not a URL",
        })
      )
    ).toBe(
      'OpenTelemetry traces: http://collector.test/base/v1/traces (service: "migrate-sdk").'
    );
  });

  it("rejects configuration when neither URL is valid", () => {
    expect(() =>
      localTelemetryMessage(
        localTelemetryEnvironment({
          OTEL_EXPORTER_OTLP_ENDPOINT: "not a URL",
          OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "also invalid",
        })
      )
    ).toThrow();
  });

  it("reports disabled when no endpoint is configured", () => {
    expect(localTelemetryMessage({ OTEL_TRACES_EXPORTER: "otlp" })).toBe(
      "OpenTelemetry traces disabled by OTEL configuration."
    );
  });

  it("selects a new server when tracing or its endpoint changes", () => {
    const input = { cwd: "/workspace", configPath: "migrate.config.ts" };
    const untraced = localMigrateServerEndpoint(input);
    const traced = localMigrateServerEndpoint({ ...input, otel: true });
    expect(traced).not.toBe(untraced);
    expect(localMigrateServerEndpoint({ ...input, otel: true })).toBe(traced);
    vi.stubEnv(
      "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
      "http://collector.test/custom"
    );
    expect(localMigrateServerEndpoint({ ...input, otel: true })).not.toBe(
      traced
    );
    expect(localMigrateServerEndpoint(input)).toBe(untraced);
  });
});
