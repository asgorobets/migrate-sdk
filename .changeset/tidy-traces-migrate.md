---
"migrate-sdk": minor
"@migrate-sdk/tui": minor
---

Add optional OpenTelemetry tracing to see where migrations spend time reading
sources, processing batches, waiting, and saving results. Use traces to find slow
steps and compare batch sizes or the number of items processed at once.

To try it locally, start a trace receiver, then add `--otel` to the CLI or TUI:

```sh
migrate run articles --otel --config migrate.config.ts
migrate-tui --otel --config migrate.config.ts
```

The default address is `http://localhost:4318/v1/traces`, with service name
`migrate-sdk`. Existing `OTEL_*` environment variables override these defaults.
Use any compatible service that accepts OTLP/HTTP JSON traces; no particular
viewer is required.

For scheduled scripts or applications using the SDK directly, provide
`migrationTelemetryLayer` from `migrate-sdk/telemetry` and configure it with
OpenTelemetry environment variables. Existing Effect tracing setups work too.
See the [tracing setup guide](https://github.com/asgorobets/migrate-sdk/blob/main/docs/telemetry.md)
for service configuration and examples.

Tracing is optional. No configuration changes are needed if you do not use it.
