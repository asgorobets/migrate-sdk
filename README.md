# Migrate SDK

**Data migrations, defined and run in TypeScript.**

Move data between APIs, databases, and files using your own clients and mapping
code. Built with Effect, Migrate SDK saves progress for each item so you can
resume interrupted runs, skip unchanged data, retry failures, and roll back
using recorded results.

Run in your application or use the CLI and TUI, locally or remotely. Your code
and migration state stay in your infrastructure.

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

- [Getting started](./apps/docs/content/docs/getting-started.mdx) — assemble your first migration definition.
- [Learn the concepts](./apps/docs/content/docs/learn/index.mdx) — sources, schemas, tracking, and saved state.
- [CLI](./apps/docs/content/docs/operate/cli.mdx) and [TUI](./apps/docs/content/docs/operate/tui.mdx) — select work, run migrations, and check progress locally or remotely.
- [Cookbook](./apps/docs/content/docs/cookbook/index.mdx) — complete recipes for common migration tasks.
- [Workflow SDK](./apps/docs/content/docs/cookbook/workflow-sdk.mdx) — run migrations durably beyond a request's lifetime.
