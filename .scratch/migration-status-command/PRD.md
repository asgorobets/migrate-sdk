# Migration Status Command

Status: ready-for-human

## Problem Statement

Migration operators can list configured Migration Definitions, inspect dependency graphs, run migrations, and roll back selected definitions, but they cannot inspect current operational state from the CLI or SDK. The static list and graph commands intentionally avoid stores, sources, locks, and runtime status. Planning intentionally stays cheap and static. After running migrations, operators still need to answer practical questions: which Migration Definitions have durable progress, which item states are failed or needs-update, whether a definition has ever run, whether the current source has new work, and whether source data is currently invalid or duplicated.

The existing Migration Store already owns durable Migration Item State, latest Migration Run State, Source Cursor progress, and Migration Definition Locks, but the public store contract does not expose the right read primitives for efficient status. The existing source cursor read API can scan source data, but migration runs use that API while also advancing durable cursor progress. Status needs a read-only Source Inventory Scan that starts from the beginning and never changes migration progress.

Migration operators also need status diagnostics that are structured enough for CLI rendering, tests, future UI, and future run-log persistence conventions. Warnings such as duplicate Source Identities and invalid source payloads should be schema-backed and serializable without becoming Effect error-channel failures or durable records in this feature.

## Solution

Add a read-only Migration Status API and CLI command.

The SDK exposes a standalone status function for callers that already have Migration Definitions. The Migration Definition Registry exposes a registry-backed `status` helper that reuses registry selection and required dependency expansion. The CLI exposes `migrate status` with explicit definition selection, `--all`, `--with-dependencies`, optional `--scan-source`, and source scan `--concurrency`.

Durable-only status reads only Migration Store facts: latest Migration Run State lifecycle metadata and current Migration Item State aggregate counts. It does not initialize source or destination plugins. It does not acquire locks, create run state, write cursors, write item state, execute pipelines, or call destination plugins.

Source-scan status additionally performs a Source Inventory Scan. It starts with the beginning of the source, follows source cursor windows until the source is exhausted, validates source item payloads with the Source Payload Schema, counts total, unprocessed, invalid, duplicate, and orphaned source relationships, and returns schema-backed diagnostics for invalid payloads or duplicate Source Identities. It does not read or write the persisted Source Cursor and does not persist scan diagnostics.

The Migration Store adds aggregate/read primitives for cheap durable status. Existing detail primitives remain available for rollback and source-scan status paths that need durable source identities.

## User Stories

1. As a migration operator, I want to run `migrate status articles`, so that I can inspect the current durable progress for one Migration Definition.

2. As a migration operator, I want to run `migrate status --all`, so that I can inspect every registered Migration Definition explicitly.

3. As a migration operator, I want `migrate status` without `--all` or definition ids to fail, so that omitted scope does not silently inspect every migration.

4. As a migration operator, I want `migrate status articles --with-dependencies`, so that I can include required dependencies when inspecting a dependent Migration Definition.

5. As a migration operator, I want required dependencies not to expand silently for status, so that inspection scope is visible by default.

6. As a migration operator, I want status rows ordered by registry order, so that status aligns with list output rather than execution order.

7. As a migration operator, I want status not to expose execution order, so that inspection output does not imply runnable sequencing.

8. As a migration operator, I want durable-only status to avoid source plugin initialization, so that cheap status stays fast and safe.

9. As a migration operator, I want durable-only status to avoid destination plugin initialization, so that status cannot accidentally perform destination-side work.

10. As a migration operator, I want durable-only status to show latest run lifecycle status, so that I can tell whether the latest known run is running, succeeded, or failed.

11. As a migration operator, I want latest run lifecycle status separated from current item-state counts, so that I do not mistake current durable counts for latest-run statistics.

12. As a migration operator, I want status to show migrated item-state counts, so that I can see how much durable work has completed.

13. As a migration operator, I want status to show skipped item-state counts, so that skipped source items remain visible.

14. As a migration operator, I want status to show failed item-state counts, so that I know which Migration Definitions need attention.

15. As a migration operator, I want status to show needs-update item-state counts, so that stubbed or incomplete destinations remain visible.

16. As a migration operator, I do not want status to show unchanged counts, so that the table only shows persisted item-state statuses.

17. As a migration operator, I do not want status to show rollbackable counts, so that rollback plugin/runtime capability does not clutter operator status.

18. As a migration operator, I want `migrate status articles --scan-source`, so that I can compare durable progress against the current source inventory.

19. As a migration operator, I want Source Inventory Scan to start from the beginning of the source, so that status can compute current total and unprocessed counts.

20. As a migration operator, I want Source Inventory Scan not to read the persisted Source Cursor, so that current inventory status is independent from migration progress.

21. As a migration operator, I want Source Inventory Scan not to write the persisted Source Cursor, so that checking status cannot change future migration runs.

22. As a migration operator, I want source-scan status to show total source item counts, so that I know the current source inventory size.

23. As a migration operator, I want source-scan status to show unprocessed source item counts, so that I can see current source items that have no durable item state.

24. As a migration operator, I want source-scan status to show invalid source item counts, so that source data problems are visible before a migration run.

25. As a migration operator, I want source-scan status to show duplicate Source Identity counts, so that unsafe source identity problems are visible.

26. As a migration operator, I want source-scan status to show orphaned item-state counts, so that durable mappings whose source identity is no longer present are visible.

27. As a migration operator, I want durable buckets to count all durable states, including orphaned states, so that durable progress is not hidden by source changes.

28. As a migration operator, I want source-scan status to validate source payloads with the Source Payload Schema, so that status reflects whether current source items are runnable.

29. As a migration operator, I want invalid source payloads to appear as warnings rather than command failures, so that I can see the rest of the status report.

30. As a migration operator, I want source read failures to fail source-scan status, so that incomplete inventory scans are not presented as complete.

31. As a migration operator, I want duplicate Source Identities to appear as warnings rather than command failures, so that I can see the rest of the status report while still seeing the problem.

32. As a migration operator, I want duplicate Source Identity warnings to include suggestions, so that I know to fix the source plugin or source data.

33. As a migration operator, I want invalid source item warnings to include suggestions, so that I know to fix the source data or Source Payload Schema.

34. As a migration operator, I want status warnings rendered below the status table, so that counts remain scan-friendly and diagnostics remain actionable.

35. As a migration operator, I want `--concurrency` for source scans, so that I can trade source pressure for faster status when I know it is safe.

36. As a migration operator, I want source scan concurrency to default to one, so that the default status command is conservative.

37. As a migration operator, I want source scan concurrency to preserve output order, so that faster scans do not reorder rows.

38. As a migration operator, I want `--concurrency` to be invalid without `--scan-source`, so that flags do not silently do nothing.

39. As a migration operator, I want `--concurrency` to require a positive integer, so that invalid concurrency cannot reach runtime.

40. As a migration operator, I want each definition's source cursor windows to remain sequential even when multiple definitions scan concurrently, so that source plugin cursor semantics stay stable.

41. As a migration operator, I want `migrate status` not to accept `--ids` in the first version, so that definition-level status is not confused with item-level inspection.

42. As an SDK user, I want a standalone status function that accepts Migration Definitions, so that I can inspect status without constructing a registry.

43. As an SDK user, I want the standalone status function to accept optional definition ids, so that I can filter supplied definitions.

44. As an SDK user, I want the standalone status function not to expand dependencies, so that dependency policy remains registry-owned.

45. As an SDK user, I want a registry-backed status method, so that CLI and application code can reuse registry selection and dependency expansion.

46. As an SDK user, I want registry-backed status to return requested and included definition ids, so that tools can explain selected scope.

47. As an SDK user, I want registry-backed status to return registry notices, so that duplicate requested definitions and optional dependency cycles remain visible.

48. As an SDK user, I want status request normalization to default `scanSource` and `concurrency`, so that downstream status code receives normalized input.

49. As an SDK user, I want status request validation to reject invalid concurrency, so that status behavior is deterministic.

50. As an SDK user, I want status request validation to reject concurrency without source scanning, so that unused status controls are not accepted.

51. As an SDK user, I want status reports to be structured data, so that tests and future UI do not parse CLI text.

52. As an SDK user, I want status warnings to be structured data, so that renderers can produce different messages without losing diagnostic facts.

53. As an SDK user, I want status warnings to be schema-backed, so that status reports can be encoded and decoded.

54. As an SDK user, I want status warnings not to use the Effect error channel, so that warnings do not interrupt report generation.

55. As an SDK user, I want status errors to remain typed Effect errors, so that request, store, source read, and registry planning failures can be rendered consistently.

56. As an SDK maintainer, I want a Migration Diagnostic convention, so that status warnings, item failures, and future run logs share serializable diagnostic expectations.

57. As an SDK maintainer, I want diagnostics to avoid raw Effect causes in durable records, so that persisted data remains stable and inspectable.

58. As an SDK maintainer, I want status warnings not to be persisted, so that current-source observations do not become stale durable records.

59. As an SDK maintainer, I want future run-error persistence to be designed separately, so that status does not smuggle in run-history requirements.

60. As a Migration Store implementer, I want a latest run state read primitive, so that status can inspect lifecycle metadata without writing run state.

61. As a Migration Store implementer, I want an item-state summary primitive, so that durable-only status can count statuses efficiently.

62. As a Migration Store implementer, I want file and in-memory stores to implement summaries by counting existing states, so that first implementations stay simple.

63. As a Migration Store implementer, I want future SQL or key/value stores to implement summaries natively, so that large stores do not materialize every item state for cheap status.

64. As a Migration Store implementer, I want status source scans to reuse the existing item-state listing primitive when exact orphan counts are needed, so that the public store API does not proliferate prematurely.

65. As a Migration Store implementer, I want no batch item-state lookup primitive in the first version, so that the store surface stays focused until a real large-store pressure point appears.

66. As a migration operator with split stores, I want status over multiple Migration Definitions to read each definition's own store, so that inspection works even when execution would require shared store locks.

67. As a migration operator, I want run and rollback to keep their current shared-store execution rule, so that lock and run lifecycle ownership remains safe.

68. As a migration operator, I want status to avoid Migration Definition Locks, so that inspection cannot block or be blocked like execution.

69. As a migration operator, I want status to avoid creating Migration Run State, so that status commands do not pollute run records.

70. As a migration operator, I want status to avoid writing Migration Item State, so that invalid source observations do not alter migration progress.

71. As a source plugin author, I want status scans to call the same source cursor read operation from the beginning, so that I do not need a separate status-specific source API.

72. As a source plugin author, I want each scan to follow normal cursor windows, so that existing cursor pagination behavior applies.

73. As a source plugin author, I want source read failures to remain Source Plugin Errors, so that status surfaces the same boundary errors as migration runs.

74. As a CLI user, I want known status errors to render concise messages, so that common failures are actionable.

75. As a CLI user, I want unknown CLI/config failures to keep stack traces where current CLI behavior already exposes them, so that unexpected implementation issues are diagnosable.

76. As a CLI implementer, I want the status command to use Effect CLI primitives, so that the command remains idiomatic with the existing CLI.

77. As a CLI implementer, I want status rendering to be a separate renderer, so that tests can assert structured status data separately from human output.

78. As an SDK maintainer, I want the public status names to be migration-specific, so that inputs and reports are not confused with registry-only or run-mode concepts.

79. As an SDK maintainer, I want status domain types separate from run summaries, so that execution summaries and read-only inspection reports do not blur together.

80. As an SDK maintainer, I want status implementation to be a deep module, so that durable-only status, source-scan status, diagnostics, and concurrency are testable without the CLI.

## Implementation Decisions

- Add a status domain module with normalized request types, report types, source status counts, item-state summary type, and schema-backed status warnings.

- Use `MigrationStatusRequestInput`, `MigrationStatusRequest`, and `makeMigrationStatusRequest` for standalone status request normalization.

- Use `MigrationStatusReport` for the standalone top-level status result.

- Use `MigrationDefinitionStatus` for one Migration Definition status row.

- Use `MigrationDefinitionSourceStatus` for source inventory counts.

- Use `MigrationItemStateSummary` for aggregate durable Migration Item State counts.

- Model duplicate Source Identity and invalid source item diagnostics as schema-backed tagged classes, not Effect tagged errors.

- Keep status warning suggestions in CLI rendering, not inside warning payloads.

- Add a standalone `getMigrationStatuses` API for SDK callers who already have Migration Definitions.

- Add `GetMigrationStatusesError` for standalone status failures.

- Add a registry-backed status input and report that reuse registry selection and include requested and included definition ids.

- Add a registry `status` method that uses registry selection, required dependency expansion, and registry-order output.

- Do not add status planning or execution order fields. Status is inspection, not execution.

- Do not add `withDependencies` to the standalone status request. Dependency expansion is registry policy.

- Add `getLatestRunState` to the Migration Store service.

- Add `getItemStateSummary` to the Migration Store service.

- Implement store summary reads for in-memory and file stores using existing state structures first.

- Leave `listItemStates` as the detailed item-state API for rollback and scan status.

- Do not add a batch item-state lookup primitive in this version.

- Durable-only status uses only latest run state and item-state summary reads.

- Source-scan status may materialize detailed item states to compute orphaned durable source identities exactly.

- Source-scan status starts from the beginning of the source by reading with no cursor.

- Source-scan status never reads the persisted Source Cursor.

- Source-scan status never writes the persisted Source Cursor.

- Source-scan status validates each source item payload with the Source Payload Schema.

- Invalid source payloads are returned as status warnings and counted as invalid.

- Duplicate Source Identities are returned as status warnings and counted as duplicates after the first occurrence.

- Valid, non-duplicate current source identities with no durable item state count as unprocessed.

- Durable item states whose source identity is absent from the scan count as orphaned.

- Durable buckets count all durable item state, including orphaned states.

- `unchanged` is excluded because it is a run outcome, not a persisted item-state status.

- `rollbackable` is excluded because rollbackability is plugin/runtime concern, not status table information.

- Source cursor read failures fail the status request because the source inventory is incomplete.

- Source scan concurrency applies across Migration Definitions, not within one definition's cursor windows.

- Source scan concurrency defaults to one.

- Source scan concurrency must be a positive integer.

- Source scan concurrency is invalid when source scanning is disabled.

- Preserve status report row order in registry/list order even when scans complete concurrently.

- Allow status over selected Migration Definitions with different store layers.

- Keep run and rollback shared-store execution rules unchanged.

- Add CLI `migrate status` with explicit definition ids or `--all`.

- Add CLI `--scan-source` for source inventory scanning.

- Add CLI `--concurrency` for scan concurrency.

- Add CLI `--with-dependencies` for required dependency expansion.

- Do not add CLI `--ids` to status in the first version.

- Render durable-only status without source columns.

- Render source-scan status with total, unprocessed, invalid, duplicate, and orphaned columns.

- Render status warnings below the table with actionable suggestions.

- Add a Migration Diagnostic glossary convention to the domain context.

- Document status API, CLI behavior, source scan semantics, store primitives, and diagnostic conventions in design docs.

## Testing Decisions

- Use TDD for implementation issues that come from this PRD.

- Prefer testing status behavior through public SDK functions, registry methods, store services, and CLI commands rather than private helpers.

- Test request normalization for default `scanSource`, default concurrency, valid concurrency, invalid non-positive concurrency, non-integer concurrency, and concurrency without source scanning.

- Test status warning schemas round-trip through Effect Schema encode/decode.

- Test durable-only status reads latest run state and item-state summary without initializing source or destination plugins.

- Test durable-only status does not acquire locks, create run state, write cursors, write item states, execute pipelines, or call destinations.

- Test in-memory store latest-run reads and item-state summaries.

- Test file store latest-run reads and item-state summaries.

- Test item-state summary counts migrated, skipped, failed, and needs-update states.

- Test missing latest run state returns null rather than failing.

- Test standalone status filters supplied definitions by explicit definition ids.

- Test standalone status rejects unknown selected definition ids.

- Test standalone status does not expand dependencies.

- Test registry status expands required dependencies only when `withDependencies` is requested.

- Test registry status rejects missing explicit required dependencies when `withDependencies` is not requested.

- Test registry status preserves registry order rather than execution order.

- Test registry status includes duplicate requested definition notices.

- Test registry status includes optional dependency cycle notices while preserving deterministic order.

- Test registry status supports selected definitions with different store layers.

- Test source-scan status starts from the beginning of the source and ignores persisted cursor progress.

- Test source-scan status does not commit source cursors.

- Test source-scan status follows multiple source cursor windows.

- Test source-scan status validates source payloads and reports invalid warnings without persisting failed item states.

- Test source-scan status reports duplicate Source Identity warnings and duplicate counts.

- Test source-scan status counts unprocessed valid source identities with no durable state.

- Test source-scan status counts orphaned durable states absent from the current source scan.

- Test source-scan status leaves durable buckets inclusive of orphaned states.

- Test source read failures fail the status effect.

- Test source scan concurrency runs selected definitions with bounded concurrency and preserves report order.

- Test CLI `migrate status` requires explicit scope.

- Test CLI `migrate status <definition>` renders durable-only status columns.

- Test CLI `migrate status --all` renders all registry definitions in registry order.

- Test CLI `migrate status --scan-source` renders source inventory columns.

- Test CLI `migrate status --scan-source --concurrency <n>` passes normalized concurrency to status execution.

- Test CLI `--concurrency` without `--scan-source` fails with a clear message.

- Test CLI status missing dependency errors reuse existing planning error rendering patterns where appropriate.

- Test CLI status warnings render suggested fixes without requiring exact full-output snapshots.

- Reuse the existing Effect Vitest style for SDK/runtime tests.

- Reuse existing store test patterns for file and in-memory store behavior.

- Reuse existing CLI test helpers for config loading, command execution, exit codes, stderr, stdout, and key rendered text.

- Keep CLI tests focused on exit codes and key output fragments rather than brittle full table snapshots.

## Out of Scope

- Persisting per-run statistics.

- Persisting run history.

- Persisting run logs or run diagnostics.

- Designing a run-log storage layer.

- Designing item-level status inspection.

- Adding `--ids` to status.

- Adding a `status --json` machine-readable output flag.

- Adding output formatting customization.

- Adding status table sorting controls.

- Adding source scan progress streaming.

- Adding pagination or streaming for store item-state scans.

- Adding a batch item-state lookup primitive.

- Adding a source-plugin-specific status API.

- Reading or displaying Migration Definition Locks in status.

- Force-unlock workflows.

- Orphan cleanup commands.

- Rollbackability counts.

- Destination plugin metadata columns.

- Source plugin metadata columns.

- Changing run or rollback shared-store execution rules.

- Changing migration run cursor advancement behavior.

- Changing migration execution summaries.

- Changing rollback execution summaries.

- Adding a top-level run history or audit command.

- Adding an ADR for run diagnostics persistence.

## Further Notes

- The status command is intentionally separate from `list`, `graph`, and `--plan`. `list` and `graph` remain static registry inspection. `--plan` remains selection and ordering inspection. `status` is operational state inspection.

- The first status implementation should favor deep modules: request normalization and schemas, store summary reads, source inventory scanning, status report construction, registry selection integration, and CLI rendering.

- The source inventory scanner should be reusable outside the CLI because future UI or SDK callers need structured status reports.

- The diagnostic convention is intentionally broader than status, but persistence is context-specific. Status warnings are returned data only. Durable item failures already use durable Migration Item Error records. Future run-log persistence should design its own durable diagnostic records when needed.

- The status source scan path is explicitly allowed to be expensive. Operators opt into it with `--scan-source`; concurrency defaults to one but can be raised when the operator accepts source-system pressure.

- Store aggregation should support simple current stores and efficient future stores. File and in-memory stores can count by listing state internally. SQL and key/value stores can implement grouped counts without materializing all item states.
