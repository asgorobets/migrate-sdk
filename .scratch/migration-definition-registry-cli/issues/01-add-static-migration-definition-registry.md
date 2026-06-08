# Add Static Migration Definition Registry

Status: ready-for-agent

## Parent

[Migration Definition Registry and CLI](../PRD.md)

## What to build

Add the SDK foundation for a static **Migration Definition Registry** that catalogs executable migration definitions. The registry should validate hard catalog issues at construction, expose static metadata for inspection, support lookup by definition id, and introduce the required/optional dependency model without changing runtime execution behavior yet.

This slice should make the registry usable directly from SDK code and tests before any CLI command exists.

## Acceptance criteria

- [ ] `MigrationDefinitionRegistry.make` accepts a non-empty or empty array of executable migration definitions and returns an immutable registry value.
- [ ] Registry construction rejects duplicate migration definition ids.
- [ ] Registry construction rejects missing required dependency ids in the full registry graph.
- [ ] Registry construction rejects required dependency cycles.
- [ ] Registry construction aggregates all hard catalog issues into one schema-backed construction error.
- [ ] Migration definitions can express required and optional dependencies.
- [ ] Existing required dependency shorthand remains supported as a compatibility path to required dependencies.
- [ ] Missing optional dependency ids do not fail registry construction.
- [ ] Optional dependency cycles do not fail registry construction.
- [ ] `list()` returns static metadata for definition id, rollback availability, required dependencies, and optional dependencies.
- [ ] `list()` preserves declared optional dependency ids even when the referenced definition is not registered.
- [ ] `definitions()` returns the executable definitions in registry order for SDK integrations and tests.
- [ ] `get(id)` returns an optional definition for known and unknown ids.
- [ ] `require(id)` returns the definition or fails through a typed Effect lookup error.
- [ ] Migration reference lookup relationships remain separate from migration definition dependencies.
- [ ] Relevant design docs and public exports are updated to reflect the registry catalog API.

## Blocked by

None - can start immediately
