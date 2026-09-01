# Next.js development HMR and Vercel Skew Protection

Research date: 2026-08-30

Source snapshot: [`vercel/next.js@2fe6f962`](https://github.com/vercel/next.js/tree/2fe6f962a1982594bdda96a7de16c594677266d2)

## Summary

Next.js development HMR and Vercel Skew Protection solve different problems:

- `next dev` keeps a development session alive while a compiler-owned module graph changes. It applies ordinary source changes to the running development server where possible and restarts a supervised child process for changes that require a clean process.
- Vercel Skew Protection routes framework-managed requests from an already-loaded client to the immutable deployment that originally served it. It does not hot-swap production code.

The useful model for Migrate SDK is therefore not “use a build ID for every source edit.” Packaged deployments need an immutable build identity. Local development needs a stable supervisor plus reloadable, immutable Local Source Generations. A run remains pinned to the generation that started it, while new plans and runs use the latest successfully loaded generation.

## How Next.js development mode works

### Ordinary source edits use a compiler-owned module graph

Next.js Fast Refresh is enabled by default and updates React code after a file is saved, preserving component state when the edited module is eligible. A file that only exports React components can be updated by itself; a module with non-component exports causes that module and its importers to be re-run. [Next.js Fast Refresh documentation](https://nextjs.org/docs/15/architecture/fast-refresh)

Current Turbopack development mode also has server-side HMR. The server subscribes to Turbopack's server HMR events, applies supported partial updates through the Turbopack runtime, and falls back to evicting and re-evaluating server chunks when an update cannot be applied incrementally. This is real in-process module replacement, backed by a compiler/runtime that owns the module graph. [Server HMR subscription and fallback](https://github.com/vercel/next.js/blob/2fe6f962a1982594bdda96a7de16c594677266d2/packages/next/src/server/dev/hot-reloader-turbopack.ts#L229-L325), [cache invalidation](https://github.com/vercel/next.js/blob/2fe6f962a1982594bdda96a7de16c594677266d2/packages/next/src/server/dev/hot-reloader-turbopack.ts#L666-L785)

For App Router route handlers, the generated development entry retrieves the current userland module on each request so server HMR changes are observed without re-executing the entry chunk. [App Route development entry](https://github.com/vercel/next.js/blob/2fe6f962a1982594bdda96a7de16c594677266d2/packages/next/src/build/templates/app-route.ts#L55-L83)

After a successful Server Component update, the server tells connected browsers to refresh their RSC data. The browser normally performs an App Router HMR refresh, but it falls back to a full page reload when recovering from a runtime or error-page state. [Server change notification](https://github.com/vercel/next.js/blob/2fe6f962a1982594bdda96a7de16c594677266d2/packages/next/src/server/dev/hot-reloader-turbopack.ts#L2140-L2208), [browser handling](https://github.com/vercel/next.js/blob/2fe6f962a1982594bdda96a7de16c594677266d2/packages/next/src/client/dev/hot-reloader/app/hot-reloader-app.tsx#L407-L438)

### Development revisions are not deployment IDs

The Next.js development server returns the constant build ID `development`; a separate HMR refresh hash represents Server Component source refreshes. [Next development server identity](https://github.com/vercel/next.js/blob/2fe6f962a1982594bdda96a7de16c594677266d2/packages/next/src/server/dev/next-dev-server.ts#L258-L268)

This is an important distinction: Next.js does not mint a production deployment ID for each local edit. Its compiler and HMR protocol track development revisions independently.

### Some changes restart a supervised child

`next dev` is a parent supervisor that forks the actual development server. The child watches `next.config.*`; a config change exits with a dedicated restart code. The parent responds by starting a replacement child and reusing its port. [Config watcher](https://github.com/vercel/next.js/blob/2fe6f962a1982594bdda96a7de16c594677266d2/packages/next/src/server/lib/start-server.ts#L557-L608), [supervised restart](https://github.com/vercel/next.js/blob/2fe6f962a1982594bdda96a7de16c594677266d2/packages/next/src/cli/next-dev.ts#L430-L478)

The browser's HMR connection has its own session identity. If it reconnects and sees a different Turbopack server session ID, or a changed Webpack compilation hash consistent with a restart, it reloads the page. [HMR restart detection](https://github.com/vercel/next.js/blob/2fe6f962a1982594bdda96a7de16c594677266d2/packages/next/src/client/dev/hot-reloader/app/web-socket.ts#L66-L105)

Inference for this comparison: Next.js's restart design treats active browser work as recoverable by retry or reload. The implementation does not provide a model for preserving an hours-long operation inside the child being replaced.

## How Vercel Skew Protection works

### Deployments are immutable and requests are version-pinned

Vercel describes Skew Protection as version locking. Framework-managed requests from an existing client carry the deployment ID as a `?dpl=` query parameter or an `x-deployment-id` header. Vercel uses that identity to route those requests to the deployment that served the client. Covered traffic includes static assets, client-side route data, prefetches, and Server Actions. Custom browser `fetch()` calls are not automatically pinned. [Vercel Skew Protection](https://vercel.com/docs/skew-protection)

Next.js reads the deployment ID embedded in the document, appends it to mutable asset URLs, and adds `x-deployment-id` to RSC navigation and Server Action requests. [Deployment ID client state](https://github.com/vercel/next.js/blob/2fe6f962a1982594bdda96a7de16c594677266d2/packages/next/src/shared/lib/deployment-id.ts#L1-L37), [RSC request header](https://github.com/vercel/next.js/blob/2fe6f962a1982594bdda96a7de16c594677266d2/packages/next/src/client/components/router-reducer/fetch-server-response.ts#L690-L702), [Server Action request header](https://github.com/vercel/next.js/blob/2fe6f962a1982594bdda96a7de16c594677266d2/packages/next/src/client/components/router-reducer/reducers/server-action-reducer.ts#L118-L130)

The server returns its deployment identity on navigation responses. If the client receives a different identity, it rejects the incompatible RSC response and performs a full document navigation instead. [Server response header](https://github.com/vercel/next.js/blob/2fe6f962a1982594bdda96a7de16c594677266d2/packages/next/src/build/templates/app-page-runtime.ts#L1663-L1674), [client mismatch handling](https://github.com/vercel/next.js/blob/2fe6f962a1982594bdda96a7de16c594677266d2/packages/next/src/client/components/router-reducer/fetch-server-response.ts#L252-L265)

### A document navigation normally moves to the latest deployment

Vercel does not pin top-level document navigation by default. A hard refresh, direct URL entry, or new tab receives the latest production deployment. The current page remains stable until that navigation; a version mismatch causes a full reload. Vercel offers an explicit `__vdpl` cookie for applications that must pin even document navigations during a long-lived session. [Document navigation and long-lived sessions](https://vercel.com/docs/skew-protection#document-navigations)

For self-hosting, Next.js documents the same mismatch-detection behavior but does not itself implement deployment-aware routing: the `?dpl=` asset suffix is cache busting, while the hosting provider or load balancer must implement version-aware routing. [Next.js `deploymentId`](https://nextjs.org/docs/app/api-reference/config/next-config-js/deploymentId), [self-hosting version skew](https://nextjs.org/docs/app/guides/self-hosting#version-skew)

### Production code is not hot-swapped

Skew Protection relies on multiple immutable deployments coexisting. Old clients continue using old code; new document loads use the newest deployment. No module cache is rewritten underneath a production request or Server Action.

## Comparison

| Concern | Next.js development HMR | Vercel Skew Protection |
| --- | --- | --- |
| Goal | Reflect local source edits quickly | Prevent old clients from mixing with new deployments |
| Identity | Constant development build ID plus HMR session/hash | Immutable deployment ID |
| Code update | Patch/re-evaluate a compiler-owned module graph; restart child when required | Deploy a separate immutable version |
| Client behavior | WebSocket update, soft RSC refresh, or full reload | Pin managed requests; hard navigate on mismatch |
| Routing | One development session | Hosting platform routes by deployment ID |
| Active work | Designed around short web requests and refreshable UI state | Existing requests/clients remain on their deployment |

## Implications for Migrate SDK

### Do not copy in-process server HMR

Migrate SDK loads customer TypeScript through Node and does not own a Turbopack-like module graph or module replacement runtime. More importantly, a migration run is durable work whose behavior must not change halfway through. Replacing a migration function, concurrency setting, dependency graph, or configuration inside the process that owns an active Effect risks giving one run mixed semantics.

The desired user experience can still be hot reload, but its execution model should be immutable generations rather than in-process HMR.

### Separate artifact identity from local source generation

- `MIGRATE_SERVER_BUILD_ID` should identify an immutable built or deployed artifact. It is analogous to a production `deploymentId`.
- Local development needs a separate source generation or server session identity. It should change after a source edit has been loaded and validated, without pretending that an artifact was built.
- The TUI is a stable client and should not need to restart when the local source generation changes.

Using one public “build ID” for both concepts would repeat the conflation that Next.js avoids by keeping its development build identity constant and tracking HMR revisions separately.

### Recommended local architecture

Use a stable local supervisor with immutable Node worker generations:

```text
TUI
 │
 ▼
local supervisor ── current generation ──► Node worker G2
       │                                      new plan/start
       │
       └── run owner: run-123 ────────────► Node worker G1
                                              observe/stop/drain
```

On a source change:

1. Detect and debounce the change.
2. Start a fresh Node child with a new local source-generation ID.
3. Import and validate the config and registry in that child.
4. If validation succeeds, atomically make it current for new `prepare` and `start` calls.
5. Keep existing runs pinned to the child generation that started them.
6. Route `observe` and `stop` by Run ID ownership, including from a reopened TUI.
7. Let the old child exit after its runs drain.
8. If loading fails, retain the last good generation and surface the reload error.

This combines the two useful Next.js ideas: a stable development supervisor and version-pinned work. It deliberately does not copy Next.js's in-process module replacement.

### The concurrency-edit scenario

If migration A is running and the customer changes migration B's concurrency:

- A continues in generation G1 with the concurrency and code it started with.
- The supervisor loads G2 from the edited source.
- The TUI remains connected and refreshes registry/plan data from G2.
- Starting B uses its new concurrency in G2.
- A remains observable and stoppable through its Run ID and G1 ownership.
- G1 drains after A finishes; it is not killed by the source edit.

No local artifact build is required. What changes is the loaded source generation.

### Source watching is a separate implementation concern

Next.js gets accurate invalidation because its bundler owns the import graph. Migrate SDK currently does not. The first reload slice should not claim equivalent graph-aware HMR unless the Node loader records the modules imported by the migration config. A safe staged approach is:

1. implement an explicit `Reload migration source` operation using immutable generations;
2. add automatic watching once the loader can report the config's imported module set, with a broader project-source watch only as a documented fallback;
3. keep build-artifact identity and Local Source Generation identity separate in local connection state and diagnostics.

## Primary sources

- [Vercel: Skew Protection](https://vercel.com/docs/skew-protection)
- [Vercel: system environment variables (`VERCEL_DEPLOYMENT_ID`)](https://vercel.com/docs/environment-variables/system-environment-variables#vercel_deployment_id)
- [Next.js: `deploymentId`](https://nextjs.org/docs/app/api-reference/config/next-config-js/deploymentId)
- [Next.js: self-hosting and version skew](https://nextjs.org/docs/app/guides/self-hosting#version-skew)
- [Next.js: Fast Refresh](https://nextjs.org/docs/15/architecture/fast-refresh)
- [`vercel/next.js` source snapshot](https://github.com/vercel/next.js/tree/2fe6f962a1982594bdda96a7de16c594677266d2)
