# Add CLI Graph Command

Status: ready-for-agent

## Parent

[Migration Definition Registry and CLI](../PRD.md)

## What to build

Add static dependency graph inspection to the CLI. `migrate graph` should render the full registry dependency graph, and `migrate graph <definition>` should render a focused one-hop neighborhood around the selected definition.

Graph inspection should stay static and should not run planning, expand dependencies, read stores, initialize plugin layers, or inspect runtime status.

## Acceptance criteria

- [ ] `migrate graph` renders all registered dependency edges.
- [ ] Full graph output includes required edges.
- [ ] Full graph output includes optional edges when the referenced definition is registered.
- [ ] Full graph output includes unresolved optional edges when the referenced definition is not registered.
- [ ] `migrate graph <definition>` renders direct outgoing edges from the selected definition to required and optional dependencies.
- [ ] `migrate graph <definition>` renders direct incoming edges from definitions that declare the selected definition as required or optional.
- [ ] Focused graph output is one-hop only and does not render transitive closure.
- [ ] Graph edges are rendered as directional edge-list lines.
- [ ] Edge labels use `required`, `optional`, and `optional unresolved` wording.
- [ ] Edge output uses directional arrows and does not use CLI-flag-looking notation.
- [ ] Graph output supports cycles without failing.
- [ ] Unknown focused graph definition ids fail with a clear lookup error.
- [ ] `migrate graph` does not use `--with-dependencies`.
- [ ] `migrate graph` does not run planning, read stores, initialize plugin layers, or inspect runtime status.
- [ ] Tests cover full graph, focused graph, incoming edges, outgoing edges, optional edges, unresolved optional edges, and cycles.

## Blocked by

- [Add CLI Config Discovery and List Command](./03-add-cli-config-discovery-and-list-command.md)
