# Migrate SDK

**Data migrations, defined and run in TypeScript.**

Move data between APIs, databases, and files using your own clients and mapping
code. Built with Effect, Migrate SDK saves progress for each item so you can
resume interrupted runs, skip unchanged data, retry failures, and roll back
using recorded results.

Run in your application or use the CLI and TUI, locally or remotely. Your code
and migration state stay in your infrastructure.

[Website](https://migrate-sdk.dev) · [Documentation](https://migrate-sdk.dev/docs) · [Live Workflow SDK demo](https://migrate-sdk-workflow.vercel.app)

Try the hosted demo to run PostgreSQL catalog migrations through Vercel Workflow
and follow their progress in the browser or connect your own TUI using the
command shown on the demo page. The [Workflow SDK cookbook](https://migrate-sdk.dev/docs/cookbook/workflow-sdk)
walks through the implementation and deployment.

## Install

For Node.js, use **22.19.0 or newer**.

```sh
pnpm add migrate-sdk@latest effect@4 @effect/platform-node@4
```

The SDK shares compatible Effect v4 and Node platform installations with your
application. These commands select the current compatible releases. Commit your
lockfile to keep subsequent installs repeatable. npm 7+ and pnpm with automatic
peer installation enabled also install compatible peers when you add the SDK alone.

The SDK includes the `migrate` CLI. Install the optional terminal UI at the same
version as your project's SDK:

```sh
TUI_VERSION="$(node -p "require('migrate-sdk/package.json').version")"
pnpm add --save-dev --save-exact "@migrate-sdk/tui@$TUI_VERSION"
pnpm exec migrate-tui
```

The compiled TUI needs no separate Bun installation or install-time build.
From 0.16.0, npm selects a compiled executable for macOS ARM64/x64, Linux glibc
ARM64/x64, or Windows x64. Keep optional dependencies enabled. See the
[binary installation guide](./docs/tui-binaries.md) for direct executables and
release details. Releases through 0.15.x use the supplied Bun runtime; with
strict pnpm build checks, run those versions using `pnpm --config.ignore-scripts=true dlx`.

Open a one-off session against a deployed Migrate Server:

```sh
MIGRATE_SERVER_TOKEN="<your-token>" \
  pnpm dlx @migrate-sdk/tui@latest \
  --server https://migrate.example.com/api/migrate
```

pnpm caches the TUI automatically; no local project, lockfile setup, or build
script approvals are needed. Use a TUI release compatible with your Migrate
Server; pin that version for repeatable sessions. Direct compiled executables
can connect remotely without Node or Bun. Local migrations require Node.

## Documentation

- [Getting started](https://migrate-sdk.dev/docs/getting-started) — assemble your first migration definition.
- [Learn the concepts](https://migrate-sdk.dev/docs/learn) — sources, schemas, tracking, and saved state.
- [CLI](https://migrate-sdk.dev/docs/operate/cli) and [TUI](https://migrate-sdk.dev/docs/operate/tui) — select work, run migrations, and check progress locally or remotely.
- [Cookbook](https://migrate-sdk.dev/docs/cookbook) — complete recipes for common migration tasks.
- [Workflow SDK](https://migrate-sdk.dev/docs/cookbook/workflow-sdk) — run migrations durably beyond a request's lifetime.
