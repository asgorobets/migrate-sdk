---
"migrate-sdk": patch
"@migrate-sdk/tui": patch
"@migrate-sdk/workflow-sdk": patch
"@migrate-sdk/commercetools": patch
---

Update the Effect packages together to 4.0.0-rc.113. This fixes fresh SDK and TUI
installations failing at startup with a missing `effect/ByteSize` module.

If your project installs `effect` or `@effect/*` runtime packages directly, update
them to 4.0.0-rc.113 alongside this release. Effect renamed some helpers in this
release; for example, use `Config.String` instead of `Config.string` and
`Flag.Boolean` instead of `Flag.boolean` in code that calls Effect directly.

Migration CLI flags and OpenTelemetry environment variables stay the same. No
global Effect or Bun installation is required.
