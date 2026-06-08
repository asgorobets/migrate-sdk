# Migration Definition Registry and CLI

Status: ready-for-agent

## Problem Statement

The SDK can run and roll back supplied migration definitions, but users do not yet have a stable catalog for application migrations or a CLI that can discover that catalog and operate on named migration definitions. Today, callers must pass definition arrays directly to SDK operations, which makes repeated CLI usage awkward, makes monorepo config discovery undefined, and leaves dependency selection ergonomics to each caller.

Migration operators need a simple command surface for listing available migration definitions, inspecting dependency relationships, planning execution order, running migrations, and rolling back selected migrations. Migration authors need a static registry that keeps executable definitions available to the SDK and CLI without introducing global mutable registration or future low-code/plugin discovery prematurely.

## Solution

Add a static **Migration Definition Registry** as the executable catalog for SDK and CLI hosts. The registry owns pure catalog validation, metadata listing, lookup, run planning, rollback planning, and thin run/rollback helpers over the existing runtime operations. It remains static from the runner's point of view even when future workflows compile serializable migration specs into executable migration definitions before registry initialization.

Add a first CLI slice that discovers a CLI-only executable config file, loads one registry, and exposes `list`, `graph`, `run`, and `rollback` commands. The CLI requires explicit scope for execution and rollback, supports `--with-dependencies` for required dependency expansion, supports `--plan` for planning without runtime execution, and uses `--ids` as an operator shorthand for source identity targeting.

The first slice keeps static inspection separate from runtime status. `list` and `graph` use registry metadata only. `--plan` resolves selection and ordering only. Store reads, source scans, migrated counts, lock inspection, and status summaries are left to future operational commands.

## User Stories

1. As a migration author, I want to define a migration definition registry from executable migration definitions, so that my application has one catalog for SDK and CLI operations.

2. As a migration author, I want the registry to be static from the runner's point of view, so that execution scope is deterministic and not affected by import-time global mutation.

3. As a migration author, I want registry construction to reject duplicate migration definition ids, so that ambiguous command selection cannot reach runtime execution.

4. As a migration author, I want registry construction to reject missing required dependency definitions, so that hard ordering prerequisites are explicit in the catalog.

5. As a migration author, I want registry construction to reject required dependency cycles, so that required ordering remains executable.

6. As a migration author, I want migration definition dependencies to distinguish required and optional dependencies, so that ordering prerequisites are separate from best-effort ordering hints.

7. As a migration author, I want optional dependencies to be allowed when omitted from the registry, so that optional relationships do not become hard catalog requirements.

8. As a migration author, I want optional dependency cycles not to fail registry construction, so that reference lookup and stub workflows can remain cyclic when no hard ordering promise exists.

9. As a migration author, I want migration reference lookup relationships to stay separate from migration definition dependencies, so that runtime lookup relationships do not automatically become execution ordering constraints.

10. As an SDK user, I want to list registered migration definitions through a public registry method, so that tools and tests can inspect the catalog without running migrations.

11. As an SDK user, I want to get an optional migration definition by id, so that lookup can be composed in application code without throwing.

12. As an SDK user, I want to require a migration definition by id through an Effect error channel, so that command handlers can render unknown definition failures.

13. As an SDK user, I want structured run plans, so that I can inspect selected definitions, included definitions, execution order, optional edges, and notices before running.

14. As an SDK user, I want structured rollback plans, so that I can inspect selected definitions, rollback targets, included definitions, execution order, optional edges, and notices before rollback.

15. As an SDK user, I want raw `runMigrations` and `rollbackMigrations` requests to remain public, so that lower-level callers can bypass the registry while still getting request-boundary validation.

16. As an SDK user, I want registry-backed run and rollback helpers, so that common calls can start from the registry instead of rebuilding definition arrays.

17. As a CLI user, I want a `migrate.config.ts` file that exports my registry, so that repeated commands do not require passing long definition arrays or module paths.

18. As a CLI user, I want the CLI to discover the nearest config file upward from my current directory, so that package-level migration configs work naturally in monorepos.

19. As a CLI user, I want `--config` to override discovery, so that I can run commands against a specific package registry from anywhere.

20. As a CLI user in a monorepo, I want the nearest package config to win, so that commands from a package directory target that package's registry.

21. As a CLI user in a monorepo, I want the root config to be used from the root when present, so that repository-wide registries are supported.

22. As a CLI user in a monorepo, I want the CLI not to search downward into child packages, so that the root cannot accidentally choose among multiple nested migration configs.

23. As a CLI user, I want TypeScript config files to load directly, so that I do not need to precompile migration configs before running the CLI.

24. As a CLI user, I want the config shape to be synchronous and registry-only, so that configuration stays focused on which registry the CLI uses.

25. As a CLI user, I want config load failures from registry construction to render all catalog issues, so that I can fix duplicate ids, missing required dependencies, and required cycles in one pass.

26. As a CLI user, I want unknown config import failures to include the config path and cause, so that broken executable configs can be diagnosed.

27. As a CLI user, I want `migrate list` to show static registry discovery metadata, so that I can quickly see available migration definitions.

28. As a CLI user, I want `migrate list` to show rollback availability and declared dependencies, so that catalog shape is visible without planning or status reads.

29. As a CLI user, I want `migrate list` to mark unresolved optional dependencies without failing, so that optional catalog typos are visible while staying non-fatal.

30. As a CLI user, I want `migrate graph` to show the full dependency graph, so that I can inspect required, optional, and unresolved optional relationships.

31. As a CLI user, I want `migrate graph <definition>` to show direct incoming and outgoing edges, so that I can inspect a focused dependency neighborhood.

32. As a CLI user, I want graph output as a simple directional edge list, so that graph output is easy to read, test, and use even when cycles exist.

33. As a CLI user, I want `migrate run <definition>` to run one migration definition, so that common single-definition execution is concise.

34. As a CLI user, I want `migrate run <definition...>` to run multiple selected migration definitions, so that related migrations can be selected explicitly.

35. As a CLI user, I want `migrate run --all` to run every registered definition, so that full-registry execution is explicit.

36. As a CLI user, I want `migrate run` without `--all` or definition ids to fail, so that an omitted scope does not accidentally run every migration.

37. As a CLI user, I want `migrate rollback <definition>` to roll back one migration definition, so that destructive cleanup scope is explicit.

38. As a CLI user, I want `migrate rollback <definition...>` to roll back multiple selected migration definitions, so that related rollback scope can be selected explicitly.

39. As a CLI user, I want `migrate rollback --all` to roll back every registered rollbackable definition, so that full-registry rollback is explicit.

40. As a CLI user, I want `migrate rollback` without `--all` or definition ids to fail, so that an omitted destructive scope does not roll back everything.

41. As a CLI user, I want required dependencies not to expand silently, so that execution scope remains visible by default.

42. As a CLI user, I want `--with-dependencies` to expand required dependencies, so that I can opt into required dependency inclusion without spelling every dependency manually.

43. As a CLI user, I want `--with-dependencies` not to expand optional dependencies, so that optional ordering hints do not unexpectedly add work.

44. As a CLI user, I want `--with-dependencies` to have no short alias, so that scope expansion remains explicit.

45. As a CLI user, I want duplicate requested migration definition ids to be deduplicated with a notice, so that repeated arguments do not execute the same definition twice.

46. As a CLI user, I want requested definition order preserved in plan output, so that I can see what I typed.

47. As a CLI user, I want execution order normalized separately from requested order, so that dependency ordering is clear.

48. As a CLI user, I want `run --plan` to show what would run without executing, so that I can verify selection and dependency ordering.

49. As a CLI user, I want `rollback --plan` to show what would roll back without executing, so that I can verify destructive scope before running it.

50. As a CLI user, I want `--plan` to use the same planning path as execution, so that invalid selections fail the same way they would during a real command.

51. As a CLI user, I want `--plan` not to acquire locks, read stores, initialize plugins, scan sources, inspect rollbackable state, or calculate counts, so that planning remains cheap and static.

52. As a CLI user, I want human plan output to show requested definitions, included definitions, execution order, target ids, and notices, so that plan output is concise.

53. As a CLI user, I want all-registry plans to show `Requested: all`, so that my original scope choice is preserved.

54. As a CLI user, I want missing explicit required dependency errors to suggest safe fixed commands, so that I know how to proceed.

55. As a CLI user, I want rollback missing-dependency suggestions to prefer `--with-dependencies`, so that required dependency scope is less likely to be omitted.

56. As a CLI user, I want `--failed` to select failed run mode, so that I can retry failed item states.

57. As a CLI user, I want `--skipped` to select skipped run mode, so that I can reprocess skipped item states when skip logic changes.

58. As a CLI user, I want `--ids` on run to trigger item mode, so that single-item reruns are concise.

59. As a CLI user, I want `--ids` to be the only CLI shorthand for source identities, so that the command surface stays compact.

60. As a CLI user, I want run item mode to accept exactly one source identity, so that item mode stays scoped to one source identity in one migration definition.

61. As a CLI user, I want run item mode to require exactly one explicit definition id, so that source identities remain scoped to a migration definition.

62. As a CLI user, I want run item mode not to combine with `--all`, multiple definitions, `--with-dependencies`, `--failed`, or `--skipped`, so that source identity targeting remains unambiguous.

63. As a CLI user, I want `--ids` on rollback to accept one or more source identities, so that targeted rollback can clean up specific items.

64. As a CLI user, I want rollback `--ids` to require exactly one explicit definition id, so that target ids are interpreted in one definition's source identity namespace.

65. As a CLI user, I want rollback `--ids` to combine with `--with-dependencies`, so that dependency-safe targeted rollback can be planned and executed.

66. As a CLI user, I want `--ids` to accept comma-separated source identities, so that targeted commands remain concise.

67. As a CLI user, I want commas inside source identities to be percent-encoded, so that uncommon comma-bearing identities remain representable.

68. As a CLI user, I want empty `--ids` segments and invalid percent encoding to fail during CLI parsing, so that bad CLI input does not reach registry planning.

69. As a CLI user, I want duplicate parsed `--ids` values deduplicated with a notice, so that generated input does not target the same source identity twice.

70. As a CLI user, I want optional dependency cycles to appear as notices rather than failures, so that non-hard ordering conflicts stay visible without blocking execution.

71. As a CLI user, I want unresolved optional dependency ids to appear in static inspection commands, so that optional catalog issues are visible.

72. As a CLI implementer, I want the CLI to use Effect CLI primitives for flags, arguments, subcommands, and service provisioning, so that command parsing stays typed and Effect-native.

73. As a CLI implementer, I want config discovery and module import owned by the migrate CLI, so that missing primitives in Effect CLI do not leak into public behavior.

74. As a CLI implementer, I want trailing command flags after definition ids to be supported when feasible, so that operator commands read naturally.

75. As an SDK maintainer, I want registry planning as a deep module with structured inputs and outputs, so that CLI and SDK behavior can be tested without snapshotting CLI text.

## Implementation Decisions

- Build a static **Migration Definition Registry** for executable **Migration Definitions**, distinct from the future **Plugin Registry** for compiling serializable **Migration Specs**.

- Do not use an ambient global mutable registry as the primary API.

- Keep raw run and rollback SDK operations public as lower-level primitives.

- Add required and optional migration definition dependency support. Existing required dependency shorthand may remain as a compatibility path during transition.

- Treat required dependencies as hard ordering prerequisites.

- Treat optional dependencies as ordering hints only when both definitions participate in the selected or all-registry run.

- Do not treat migration reference lookup relationships as dependencies unless the migration definition explicitly declares them as dependencies.

- Make registry construction lazy and synchronous.

- Make registry construction perform only pure catalog validation.

- Aggregate hard registry construction failures into one schema-backed construction error with issue variants for duplicate ids, missing required dependencies, and required dependency cycles.

- Do not acquire locks, read stores, initialize plugin layers, inspect rollbackable state, scan sources, or run runtime preflight during registry construction.

- Allow missing optional dependency ids and retain them for inspection.

- Allow optional dependency cycles and surface them as notices when they affect planning.

- Expose registry catalog helpers for listing entries, returning definitions, optional lookup, and required lookup.

- Expose registry planning helpers for run and rollback. Planning returns structured data rather than CLI-formatted text.

- Expose thin registry run and rollback helpers that delegate to existing runtime operations after planning.

- Require registry-backed execution selection to be either `all: true` or at least one definition id.

- Keep `withDependencies` defaulted to false.

- Make `withDependencies` expand required dependencies only.

- Accept `withDependencies` with all-registry selection as redundant.

- Preserve requested definition ids in plan output while deduplicating inclusion and execution.

- Record duplicate requested definition ids as plan notices.

- For run plans, order execution in forward dependency order.

- For rollback plans, order execution in reverse dependency order.

- Record optional dependency edges that participated in ordering because both sides were included.

- Preserve deterministic registry order when optional dependency edges cycle.

- Add plan notices for ignored optional dependency cycles, duplicate requested definitions, and duplicate target ids.

- Keep missing optional dependency ids as inspection concerns, not run or rollback plan notices.

- Keep lookup and planning failures in Effect error channels.

- Use structured planning errors for unknown definitions, missing explicit required dependencies, and invalid selections.

- Make CLI config CLI-only and executable.

- Expose a `defineMigrationCliConfig` helper that accepts a synchronous object with one registry.

- Accept only the default export from the config module in the first slice.

- Do not accept async config factories in the first slice.

- Keep CLI config registry-only. Do not add rendering options, default flags, command aliases, or output customization.

- Support direct loading for TypeScript and JavaScript config files in the first slice, including `.ts`, `.mts`, `.js`, and `.mjs` discovery names.

- Keep CommonJS config discovery out of scope for the first slice.

- Keep JSON, YAML, TOML, and INI config formats out of scope because they cannot hold executable definitions, functions, or Effect layers.

- Catch config import errors at the CLI command boundary.

- Render known registry construction errors with all catalog issues.

- Wrap unknown config import failures with config path and underlying cause.

- Discover config by using `--config` exactly when supplied; otherwise search upward from the process current working directory.

- Let the nearest config win.

- Stop after checking a detectable workspace root, otherwise stop at the filesystem root.

- Never search downward into child packages.

- Resolve `--config` paths relative to the process current working directory.

- Let relative imports inside config files resolve from the config file location.

- Implement `migrate list` as static registry discovery only.

- Make `list` render definition id, rollback availability, required dependencies, and optional dependencies.

- Mark unresolved optional dependencies in `list` without failing the command.

- Do not include source or destination plugin columns in `list` in the first slice.

- Implement `migrate graph` as read-only static dependency inspection.

- Make full graph render all dependency edges.

- Make focused graph render only one-hop direct incoming and outgoing edges for the selected definition.

- Render graph edges as directional edge-list lines using labels such as required, optional, and optional unresolved.

- Implement `migrate run` and `migrate rollback` with explicit scope. Omitted scope is invalid.

- Implement `--all` as the explicit full-registry scope for run and rollback.

- Implement `--with-dependencies` with no short alias.

- Implement `--plan` as a CLI-only mode on run and rollback.

- Keep `--plan` on the same planning path as execution and skip runtime execution only after a valid plan is produced.

- Do not expose a top-level plan command in the first slice.

- Do not expose validate commands in the first slice.

- Do not expose `--json` or another machine-readable plan output flag in the first slice.

- Render human plan output with requested definitions, target ids when present, included definitions, execution order, and notices.

- Render `Requested: all` for all-registry plans and expand concrete included definitions separately.

- Render safe fixed-command suggestions for missing explicit required dependency planning errors.

- Prefer `--with-dependencies` first in rollback missing-dependency suggestions because required dependency scope is easier to omit manually.

- Map CLI run-mode flags to SDK run modes instead of exposing a generic `--mode` flag.

- Use no run-mode flag for normal mode.

- Use `--failed` for failed mode.

- Use `--skipped` for skipped mode.

- Use `--ids` to trigger item mode for forward run.

- Reserve future run-mode flags such as `--needs-update` for later.

- Use `--ids` as the only CLI shorthand for source identities in the first slice.

- Parse `--ids` as a comma-separated argument.

- Reject empty `--ids` segments and invalid percent encoding during CLI parsing.

- Percent-decode parsed source identities after splitting on literal commas.

- Require source identities containing commas to encode the comma.

- Deduplicate parsed `--ids` values while preserving first occurrence order and surfacing notices.

- For forward run item mode, accept exactly one unique parsed source identity and exactly one explicit definition id.

- For forward run item mode, reject combinations with all-registry scope, multiple explicit definitions, required dependency expansion, failed mode, or skipped mode.

- For rollback targeting, accept one or more unique parsed source identities with exactly one explicit definition id.

- For rollback targeting, allow combination with required dependency expansion.

- Use Effect CLI primitives for flags, variadic definition id arguments, subcommands, and command-scoped service provisioning.

- Keep config discovery, executable config import, config default export validation, registry construction error rendering, and command output rendering owned by the migrate CLI.

- Validate whether trailing flags after definition ids require a small argv normalization step before invoking the Effect command parser.

## Testing Decisions

- Use TDD for the registry and CLI implementation slices.

- Treat registry construction and registry planning as deep modules. Test their structured behavior directly rather than snapshotting CLI output.

- Test registry construction rejects duplicate definition ids.

- Test registry construction rejects missing required dependency ids.

- Test registry construction rejects required dependency cycles.

- Test registry construction aggregates multiple hard issues into one construction error.

- Test registry construction allows missing optional dependency ids.

- Test registry construction allows optional dependency cycles.

- Test registry `list` returns static metadata including required, optional, unresolved optional, and rollback availability.

- Test registry `get` returns an optional definition for known and unknown ids.

- Test registry `require` fails with a typed lookup error for unknown ids.

- Test run planning requires explicit scope.

- Test rollback planning requires explicit scope.

- Test planning rejects unknown definition ids.

- Test planning rejects missing explicit required dependencies when `withDependencies` is false.

- Test planning expands required dependencies when `withDependencies` is true.

- Test planning does not expand optional dependencies.

- Test planning includes optional dependency edges only when both sides are included.

- Test planning preserves requested order separately from execution order.

- Test run planning normalizes execution order in forward dependency order.

- Test rollback planning normalizes execution order in reverse dependency order.

- Test duplicate requested definition ids are deduplicated and surfaced as notices.

- Test optional dependency cycles preserve deterministic registry order and surface notices.

- Test missing optional dependency ids remain inspection concerns and do not produce run or rollback plan notices.

- Test rollback target planning accepts one or more source identities for exactly one definition.

- Test rollback target planning rejects target ids with all-registry selection or multiple explicit definitions.

- Test forward item-mode planning accepts exactly one source identity for exactly one definition.

- Test forward item-mode planning rejects more than one unique source identity.

- Test forward item-mode planning rejects combinations with all-registry selection, multiple definitions, required dependency expansion, failed mode, and skipped mode.

- Test duplicate source identities are deduplicated and surfaced as notices.

- Test registry run and rollback helpers delegate to existing runtime operations after planning.

- Test CLI config discovery with `--config`.

- Test CLI config discovery from package directories, repository root, and missing-root-config monorepo cases.

- Test CLI config discovery does not search downward into child packages.

- Test TypeScript config loading for `migrate.config.ts` and `migrate.config.mts`.

- Test JavaScript config loading for `migrate.config.js` and `migrate.config.mjs`.

- Test config loading rejects missing default export.

- Test config loading rejects invalid default export.

- Test config loading catches registry construction errors thrown during module import and renders all issues.

- Test config loading wraps unknown import failures with config path and underlying cause.

- Test CLI `list` renders static registry metadata without invoking planning, stores, plugin layers, or runtime execution.

- Test CLI `graph` renders full graph edge lists.

- Test CLI `graph <definition>` renders one-hop incoming and outgoing edges only.

- Test CLI graph output labels required, optional, and optional unresolved edges.

- Test CLI `run --plan` renders requested definitions, included definitions, normalized execution order, and notices.

- Test CLI `rollback --plan` renders requested definitions, target ids when present, included definitions, normalized execution order, and notices.

- Test CLI `--plan` exits before execution.

- Test CLI `--plan` fails with the same planning errors as execution for invalid selection.

- Test CLI missing required dependency errors render safe fixed-command suggestions.

- Test rollback missing required dependency suggestions list `--with-dependencies` first.

- Test CLI `--ids` parsing splits on commas, rejects empty parts, percent-decodes values, and fails on invalid percent encoding before planning.

- Test CLI run-mode flags map to SDK run modes and reject incompatible combinations.

- Keep CLI tests focused on exit codes, key rendered text, and command-to-planning behavior instead of whole-output snapshots.

- Reuse existing package-scoped verification: package tests, package typecheck, focused formatter/linter checks for touched files, and `git diff --check`.

## Out of Scope

- Implementing a global mutable registry.

- Implementing the future plugin registry for compiling serializable migration specs.

- Implementing low-code, runtime-storage, or plugin-discovered migration definitions.

- Implementing source or destination plugin metadata columns in `migrate list`.

- Implementing a `status` command or any durable status table.

- Reading migration stores in `list`, `graph`, or `--plan`.

- Inspecting migration definition locks in this slice.

- Reading latest run state in this slice.

- Calculating migrated, failed, skipped, needs-update, total, imported, unprocessed, or rollbackable counts for CLI inspection.

- Scanning source systems for totals or unprocessed source items.

- Adding `status --scan-source`, preview, or source scan commands.

- Adding top-level `plan` commands.

- Adding validate commands.

- Adding `--json` or machine-readable output flags.

- Adding output formatting customization.

- Adding CLI config rendering options, default command flags, or command aliases.

- Adding async config factories.

- Adding named config exports.

- Adding CommonJS config discovery.

- Adding JSON, YAML, TOML, or INI config formats.

- Adding short aliases for `--with-dependencies`.

- Adding long aliases for `--ids`.

- Adding a generic `--mode` CLI flag.

- Adding future run-mode flags such as `--needs-update`.

- Changing rollback item execution semantics.

- Changing migration store pagination or status query APIs.

- Changing source or destination plugin runtime service contracts except where registry metadata becomes necessary for the first slice.

## Further Notes

- The current ADR accepts the static **Migration Definition Registry** as the first executable catalog and keeps Drupal references confined to ADR-level inspiration.

- The first implementation should favor small, deep modules: registry construction, dependency graph normalization, run/rollback planning, config discovery/loading, `--ids` parsing, and CLI renderers.

- The CLI command surface should stay intentionally small: `list`, `graph`, `run`, and `rollback`.

- `list` is discovery, not status. Runtime operational state should be designed separately once store query APIs and status columns are clear.

- `--plan` is a planning view, not a dry run. It should not imply source scanning, store reads, destination no-op execution, or count calculation.
