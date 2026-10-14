# Migrate SDK website

The existing pnpm/Turborepo `docs` workspace contains the custom marketing homepage at `/` and Fumadocs documentation at `/docs`.

The setup follows the official [Next.js installation guide](https://www.fumadocs.dev/docs/manual-installation/next), [MDX collections](https://www.fumadocs.dev/docs/mdx/collections), and [workspace guidance](https://www.fumadocs.dev/docs/mdx/workspace). One docs app needs one collection config; Fumadocs' multi-workspace feature is available when content gets its own independent configs.

## Develop

From the monorepo root:

```sh
pnpm install
pnpm --filter docs dev
```

Open `http://localhost:3001` for the homepage or `http://localhost:3001/docs` for documentation.

The development command uses Turbopack with Node source-map caching disabled. Rendering the generated MDX otherwise exhausts the Node heap while caching repeated debug-frame maps. Server stack traces in development use generated code locations; browser source maps and production builds keep their normal settings.

## Content and routing

- `content/docs/**/*.mdx`: documentation pages and frontmatter.
- `content/docs/**/meta.json`: sidebar order and section labels.
- `source.config.ts`: Fumadocs MDX collection and Shiki/Twoslash settings.
- `lib/source.ts`: collection loader, page tree, and `/docs` base URL.
- `mdx-components.tsx`: Fumadocs MDX components and interactive type popovers.
- `app/(docs)/docs`: Fumadocs layout and generated page routes.
- `app/(docs)/api/search`: search across the documentation collection.
- `app/page.tsx`: custom marketing homepage.
- `app/globals.css`: Tailwind/Fumadocs styles and shared theme colors.

Add an MDX page with `title` and `description` frontmatter, then add its name to `meta.json`. It automatically receives navigation, a table of contents, syntax highlighting, search indexing, and metadata. Keep headings plain; put links in body text.

`content/authors.ts` is the shared, type-checked migration example. The homepage generates Shiki/Twoslash data from it; the CSV-to-JSON cookbook includes the same file using Fumadocs' `<include>` support. Update the file rather than copying its code into MDX.

## Check and build

```sh
pnpm --filter docs check-types
pnpm --filter docs test
pnpm --filter docs build
# Includes dependency builds through the monorepo task graph:
pnpm exec turbo run build --filter=docs
```

`postinstall`, development, and production builds generate Fumadocs collections under `.source`. Generated collections and highlighted example data are ignored by Git and included in the app's Turbo build outputs.

The docs have one coordinated progression:

- **Learn:** Migration Definitions, schema contracts, Sources, Source Items, Destinations, state/completion, Migration Stores, Tracking, registries/dependencies, execution/observation, errors, retries, and rollback.
- **Cookbook:** CSV to JSON, API to API, joining two source APIs, writing to two destination APIs, and durable Workflow SDK execution.
- **Operate:** CLI arguments, TUI workflows, collaboration, cancellation, and lock recovery.

`content/examples/*.ts` contains independently type-checked example modules. Reuse those files with `<include>` rather than copying large examples into MDX. API recipes show adjacent files in tabs so imports are available without linking readers to raw source pages. Workflow pages include the real integration files from `examples/workflow-sdk`; their application check runs in that workspace.

Enable type hovers on complete TypeScript examples with `twoslash`. For included files, also set `source` to the same path as the include, relative to the MDX page:

```mdx
<include lang="ts" meta='title="source.ts" twoslash source="../examples/getting-started/source.ts"'>../examples/getting-started/source.ts</include>
```

`lib/remark-twoslash.ts` supplies each example's real local imports as hidden virtual files and registers them as compiler dependencies so helper edits invalidate the page. Twoslash checks the resulting code with strict null checking and derives the displayed types from it. Unmarked compiler errors fail the docs build. Use `// ^?` queries selectively to keep a key inferred type visible, and keep incomplete snippets unmarked unless you supply their context. Popovers support pointer hover and button activation; copying an example excludes hidden imports and type annotations. Popup signatures render as plain text through `lib/compact-type-hovers.ts` to keep generated MDX small; visible examples retain syntax highlighting. The docs tests check generated markup size, inferred signatures, and hidden-import dependencies.

Getting started walks through a complete local migration using the SDK directly, including schemas, processing, saved progress, and rollback. Its examples should show how schema decoding produces concrete TypeScript types. The Learn pages explain the primitives and relationships in `CONTEXT.md`, accepted ADRs, and current design documents; the cookbook applies them to other systems. Distinguish item state from run state and completion; distinguish request retries from persisted failed-item reruns. Check design status and current source before presenting legacy or proposed APIs as current. Public pages teach users; research evidence and the content plan live under `.scratch/docs-content/`.

Legacy `/docs/concepts`, `/docs/sources-and-stores`, and `/docs/cli` routes redirect to the expanded sections. Add future adapter or generated API reference pages only when their content is ready.
