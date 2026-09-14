# Drupal Migrate: state, dependencies, and rollback

Research date: 2026-09-11. This is source research, not a Drupal execution test. Core findings were checked against the official **Drupal 11.4.6 tag**, released September 3, 2026, and cross-checked against Drupal's moving `11.x` API documentation. Version 11.4.6 is the latest stable Drupal 11 release listed at research time. [Release](https://www.drupal.org/project/drupal/releases/11.4.6), [release list](https://www.drupal.org/project/drupal/releases?version=11).

## Core separates activity, row state, and execution results

Drupal's migration status describes activity. It has `IDLE`, `IMPORTING`, `ROLLING_BACK`, `STOPPING`, and `DISABLED`; it has no migration-level `SUCCEEDED` or `IMPORTED` status. Execution methods return separate results: `COMPLETED`, `INCOMPLETE`, `STOPPED`, `FAILED`, `SKIPPED`, or `DISABLED`. `COMPLETED` means processing completed; `FAILED` denotes a fatal execution error. Consequently, **Idle does not tell us whether data has been migrated**. [MigrationInterface](https://git.drupalcode.org/project/drupal/-/blob/11.4.6/core/modules/migrate/src/Plugin/MigrationInterface.php#L12-86).

The ID map records a source-to-destination relationship and a separate status per source row:

| Row status | Meaning |
| --- | --- |
| `IMPORTED` | Imported successfully. |
| `NEEDS_UPDATE` | Requires another import/update. |
| `IGNORED` | Import deliberately skipped this row. |
| `FAILED` | Import failed for this row. |

Map rows also carry rollback policy, last-imported time, and an optional source hash. Rollback policy distinguishes deleting destination data from preserving it, such as an existing entity updated by the migration. These are current row records, not an append-only execution log. [MigrateIdMapInterface](https://api.drupal.org/api/drupal/core!modules!migrate!src!Plugin!MigrateIdMapInterface.php/11.x).

## Dependency satisfaction is based on processed rows

`Migration::checkRequirements()` first checks source and destination requirements, then checks the required migrations with `allRowsProcessed()`. An empty `requirements` list skips the migration-dependency portion. Neither the dependency's activity status nor a last execution result decides this check. [Migration::checkRequirements](https://git.drupalcode.org/project/drupal/-/blob/11.4.6/core/modules/migrate/src/Plugin/Migration.php#L476-503).

The actual completion rule is:

```text
if source count is unknown: satisfied
otherwise: source count <= processed map-row count
```

The inequality explicitly accommodates extra map entries caused by unresolved stubs. It also means an empty countable source satisfies this check without an import. This is a coverage approximation, not proof of successful migration or source exhaustion. [Migration::allRowsProcessed](https://git.drupalcode.org/project/drupal/-/blob/11.4.6/core/modules/migrate/src/Plugin/Migration.php#L567-579).

For the standard SQL ID map, `processedCount()` counts **every map row**, without filtering status. Therefore failed, ignored, and needs-update rows all contribute. `importedCount()` includes both imported and needs-update rows; error and update counts are available separately. As a concrete inference: a ten-row source with nine imports and one recorded failure can satisfy the dependency check. There is no zero-errors condition in that predicate. [SQL ID-map counting](https://git.drupalcode.org/project/drupal/-/blob/11.4.6/core/modules/migrate/src/Plugin/migrate/id_map/Sql.php#L774-834).

Required and optional dependencies are both used for execution ordering. Only required paths become execution requirements; optional dependencies can be absent from an execution. The plugin manager builds and sorts the dependency graphs separately from checking their completion. [MigrationPluginManager::buildDependencyMigration](https://git.drupalcode.org/project/drupal/-/blob/11.4.6/core/modules/migrate/src/Plugin/MigrationPluginManager.php#L162-215).

## Import and rollback change different things

Core import requires Idle, checks requirements, sets Importing, processes rows, and normally returns to Idle. Row failures can be recorded while iteration continues, so an execution may return Completed with failed map rows. [MigrateExecutable::import](https://api.drupal.org/api/drupal/core!modules!migrate!src!MigrateExecutable.php/function/MigrateExecutable::import/11.x).

Core rollback also requires Idle, sets Rolling back, and walks the existing ID map. It invokes the destination rollback for deletable destinations and removes processed map entries. Preserved destination objects remain, but their map entries are removed too. Entries without destination IDs, such as failed imports, are removed without a destination rollback. The normal exit sets Idle. Core's method has no import-requirements check or dependent-migration expansion. [MigrateExecutable::rollback](https://git.drupalcode.org/project/drupal/-/blob/11.4.6/core/modules/migrate/src/MigrateExecutable.php#L285-354).

For an unchanged, nonempty countable source, removing all map entries therefore makes the ordinary completion check false. This is why Drupal does not mistake successful rollback for a successful import. Exceptions follow from its permissive counting rule: an uncountable source still passes, and surplus entries can conceal a smaller coverage gap. These are deductions from the predicate, not live-tested cases.

## Incremental processing and stubs expose the limits

`SourcePluginBase` can skip counting or cache counts. Its iteration selects unmapped rows, rows needing update, rows above a high-water mark, or rows with changed source hashes. High-water and hash tracking are mutually exclusive. The high-water value is saved while advancing the source, before destination import succeeds; it is progress information, not completion evidence. The source's pre-rollback handler resets it to null. [SourcePluginBase](https://git.drupalcode.org/project/drupal/-/blob/11.4.6/core/modules/migrate/src/Plugin/migrate/source/SourcePluginBase.php).

The SQL source counts its underlying prepared query; its execution iterator separately adds map/high-water conditions. When the map is joinable, unmapped rows and needs-update rows are eligible, with above-high-water rows added to that set. A failed map row is not an automatic retry condition. These details depend on source implementation and configuration; a count should not be interpreted as a universal count of unresolved work. [SqlBase::initializeIterator and doCount](https://git.drupalcode.org/project/drupal/-/blob/11.4.6/core/modules/migrate/src/Plugin/migrate/source/SqlBase.php#L250-402).

`migration_lookup` resolves references through another migration's ID map. If a match is absent, eligible lookups can create a stub; `no_stub` disables that, while `stub_id` chooses a stub migration. This is item-level reference resolution, separate from migration-wide dependency checking. [MigrationLookup](https://git.drupalcode.org/project/drupal/-/blob/11.4.6/core/modules/migrate/src/Plugin/migrate/process/MigrationLookup.php#L191-287).

Stub creation runs the destination import and records a successful stub as `NEEDS_UPDATE`. It does not establish that the complete source has been migrated. Combined with the unfiltered count, this explains why Drupal's dependency predicate can accept a migration that still contains placeholders. [MigrateStub::doCreateStub](https://git.drupalcode.org/project/drupal/-/blob/11.4.6/core/modules/migrate/src/MigrateStub.php#L106-128).

## Lessons from core

The useful design precedent is the separation of activity, item state, and execution outcome. Drupal does not provide a strict readiness model to copy unchanged. We should decide explicitly whether failed items, required updates, unresolved stubs, and unknown source coverage permit dependents to run. A source with changing identities also needs more than count equality: equal totals alone cannot prove that the mapped identities cover the current source. Those are design conclusions from the inspected implementation.

The inspected core paths expose import/rollback events and current activity, but do not create durable operation records with execution IDs. Retaining such records in this SDK can still be justified by its own observation, cancellation, and history requirements; they need not serve as migration-readiness evidence.

## Migrate Tools and Drush: commands, display, and history

This section inspects Migrate Tools **6.1.4**, a release supporting Drupal 9.1,
10, and 11, and the official Drush 13 command documentation. Migrate Tools and
Drush core provide overlapping commands; their implementations should not be
treated as interchangeable. [Release](https://www.drupal.org/project/migrate_tools/releases/6.1.4),
[project](https://www.drupal.org/project/migrate_tools)

Migrate Tools displays activity status, total source rows, imported rows,
unprocessed rows, messages, and last import time separately. Its unprocessed
count is source count minus map processed count, or unavailable for an
uncountable source. Its dependency tree command is a separate view of required
dependencies. [MigrateToolsCommands.php, status and dependencyTree](https://git.drupalcode.org/project/migrate_tools/-/blob/6.1.4/src/Drush/Commands/MigrateToolsCommands.php#L77)

For import, `--execute-dependencies` recursively executes requirements;
`--force` empties the requirements list for that execution. These controls
have distinct purposes. Core source and destination requirements are checked
before the empty migration-requirements shortcut. [Migrate Tools executeMigration](https://git.drupalcode.org/project/migrate_tools/-/blob/6.1.4/src/Drush/Commands/MigrateToolsCommands.php#L1116),
[core checkRequirements](https://github.com/drupal/drupal/blob/11.4.6/core/modules/migrate/src/Plugin/Migration.php#L476)

Migrate Tools rollback reverses the selected dependency-sorted migrations
within each group. Its rollback command has no import-style `--force` or
`--execute-dependencies` option and does not automatically expand an authors-only
selection to include books. This is not an equivalent to our omitted-dependent
tracked-state safety check. [Migrate Tools rollback and migrationsList](https://git.drupalcode.org/project/migrate_tools/-/blob/6.1.4/src/Drush/Commands/MigrateToolsCommands.php#L553)

Drush 13 likewise documents force and dependency execution on import, while
rollback exposes selection by migrations, tags, all, or source ID list.
Its status fields separately expose activity, counts, and last import time.
[Import](https://www.drush.org/13.x/commands/migrate_import/),
[rollback](https://www.drush.org/13.x/commands/migrate_rollback/),
[status](https://www.drush.org/13.x/commands/migrate_status/)

Migrate Tools writes a timestamp to `migrate_last_imported` on post-import and
sets it to false on post-rollback. The rollback listener does not distinguish
full from selected-item rollback. This is a mutable latest-import indicator,
not a durable ledger of execution IDs, outcomes, and scopes. It should not be
used as proof of data completeness. [MigrateExecutable.php, onPostImport and onPostRollback](https://git.drupalcode.org/project/migrate_tools/-/blob/6.1.4/src/MigrateExecutable.php#L314)

## Implications for Migrate SDK

These are recommendations based on the inspected source, not Drupal behavior
or changes implemented by this research. SDK comparison uses the working tree
based on `9cb4c14838769097b5873e53782a64f3a65c301f`, including the uncommitted
rollback fix.

Our current rule requires a latest successful forward operation with no failed
item state. It has no source-completion or operation-scope input. A successful
selected-item run can therefore establish readiness without processing the
whole source. [Current readiness predicate](../../packages/migrate-sdk/src/domain/status.ts),
[targeted and full execution paths](../../packages/migrate-sdk/src/services/migration-run-executor.ts)

Adopt Drupal's separation of activity, item outcomes, and completeness. Keep
our durable execution history: reconnecting to detached Workflow SDK executions
needs the execution identity and lifecycle that Drupal's activity flag and last
import timestamp do not provide. [SDK run state](../../packages/migrate-sdk/src/domain/run.ts),
[observation design](multi-run-dashboard-observation.md)

Do not copy the source-count comparison as our safety contract. Our sources
can be incremental, and inventory scans are optional. Equal counts do not prove
that the expected identities are present. Instead, persist minimal completion
evidence per definition: what source pass or checkpoint was completed and
whether subsequent rollback invalidated its coverage. Compute readiness from
that evidence plus unresolved item outcomes, using one shared implementation.
Keep active-operation exclusion as a separate admission check.

The proposed behavior is:

| Situation | Proposed SDK rule |
| --- | --- |
| Full forward pass finishes with no unresolved failures or required updates | Ready for that known source pass, even if the source was empty |
| Selected-item run succeeds with no earlier completion evidence | Does not establish whole-migration readiness |
| Retry resolves all failures from an already completed discovery pass | Can restore readiness |
| Rollback removes tracked records | Invalidate readiness; restore through a complete forward pass unless exact gap repair is tracked |
| Later operation fails before changing data | Preserve prior completion evidence; expose the failed operation separately |
| Source total is unknown | Require completion evidence; do not assume ready |

Before implementation, settle whether intentionally skipped items fulfill a
dependency, what an incremental completion checkpoint promises, and whether
exact repair of selectively rolled-back identities should restore readiness
without a full pass. A separate mutable green/red status would not answer
these questions. The useful durable addition is evidence, with status derived
from it.


## Adopted model after discussion

The implementation decision is recorded in [ADR 0011](../adr/0011-operation-history-and-migration-readiness.md). It adopts Drupal's permissive treatment of failed and needs-update items for dependencies, using persisted evidence that a forward source pass reached its end. It does not infer readiness from raw map counts or unknown source totals. This decision supersedes any stricter readiness recommendations above.
