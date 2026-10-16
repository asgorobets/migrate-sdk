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
pnpm add migrate-sdk effect@4.0.4 @effect/platform-node@4.0.4
```

The SDK includes the `migrate` CLI. For the optional terminal UI:

```sh
pnpm add --save-dev @migrate-sdk/tui
```

Open a one-off session against a deployed Migrate Server with pnpm 10.2.0 or newer:

```sh
MIGRATE_SERVER_TOKEN="<your-token>" \
  pnpm --allow-build=bun --allow-build=esbuild dlx @migrate-sdk/tui@latest \
  --server https://migrate.example.com/api/migrate
```

pnpm caches the TUI automatically; no local project or lockfile setup is needed.
The flags approve the Bun and esbuild install scripts. Use the release with the
matching Effect 4.0.4 dependencies after it is published.

## Documentation

- [Getting started](https://migrate-sdk.dev/docs/getting-started) — assemble your first migration definition.
- [Learn the concepts](https://migrate-sdk.dev/docs/learn) — sources, schemas, tracking, and saved state.
- [CLI](https://migrate-sdk.dev/docs/operate/cli) and [TUI](https://migrate-sdk.dev/docs/operate/tui) — select work, run migrations, and check progress locally or remotely.
- [Cookbook](https://migrate-sdk.dev/docs/cookbook) — complete recipes for common migration tasks.
- [Workflow SDK](https://migrate-sdk.dev/docs/cookbook/workflow-sdk) — run migrations durably beyond a request's lifetime.
