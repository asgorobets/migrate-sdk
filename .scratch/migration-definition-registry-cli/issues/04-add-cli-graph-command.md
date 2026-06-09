# Add CLI Graph Command

Status: ready-for-agent

## Parent

[Migration Definition Registry and CLI](../PRD.md)

## What to build

Add static dependency graph inspection to the CLI. `migrate graph` should render the full registry dependency graph, and `migrate graph <definition>` should render a focused one-hop neighborhood around the selected definition.

Graph inspection should stay static and should not run planning, expand dependencies, read stores, initialize plugin layers, or inspect runtime status.

## Acceptance criteria

- [x] `migrate graph` renders all registered dependency edges.
- [x] Full graph output includes required edges.
- [x] Full graph output includes optional edges when the referenced definition is registered.
- [x] Full graph output includes unresolved optional edges when the referenced definition is not registered.
- [x] `migrate graph <definition>` renders direct outgoing edges from the selected definition to required and optional dependencies.
- [x] `migrate graph <definition>` renders direct incoming edges from definitions that declare the selected definition as required or optional.
- [x] Focused graph output is one-hop only and does not render transitive closure.
- [x] Graph edges are rendered as directional edge-list lines.
- [x] Edge labels use `required`, `optional`, and `optional unresolved` wording.
- [x] Edge output uses directional arrows and does not use CLI-flag-looking notation.
- [x] Graph output supports cycles without failing.
- [x] Unknown focused graph definition ids fail with a clear lookup error.
- [x] `migrate graph` does not use `--with-dependencies`.
- [x] `migrate graph` does not run planning, read stores, initialize plugin layers, or inspect runtime status.
- [x] Tests cover full graph, focused graph, incoming edges, outgoing edges, optional edges, unresolved optional edges, and cycles.

## Blocked by

- [Add CLI Config Discovery and List Command](./03-add-cli-config-discovery-and-list-command.md)
