# Drupal migration item limits

SDK implementation follow-up: [ADR 0012](../adr/0012-source-order-and-limited-runs.md) adopts source-order normal runs and bounded eligible attempts. SDK gap statements in this research describe the pre-change implementation.

Research date: 2026-09-11

## Conclusion

Drupal's normal migration model supports the desired repeated small-run workflow:
`drush migrate:import products --limit=1` can import the next eligible source row,
then stop. Running it again does not inherently select the already imported first
row. The source iterator consults the migration ID map and continues to eligible
rows. This is the useful precedent for Migrate SDK. However, the CLI wrappers do
not implement a universal strict budget of eligible processing attempts: their
counters and stop signals run through source preparation events, and behavior
depends on the wrapper, source plugin, and skip hooks. See the core eligibility
and wrapper sections below for the source evidence.

This was source and documentation research. No Drupal migration was executed, no
live destination was modified, and no Migrate SDK runtime change was made.

## Scope and source versions

- Drupal core `11.x`, inspected at commit
  `6379cc8e3bac8f363e6d96c3e4657bce293c381a`.
- Migrate Tools release `6.1.4`, which the [official project
  page](https://www.drupal.org/project/migrate_tools) lists as released on
  2026-05-13. Tagged source and the official release archive were inspected.
- Drush's built-in migration commands on `13.x`, inspected at commit
  `4ed1df714daa6ab5181e437c946a764aac4bc3b6`, with matching
  [Drush 13 command documentation](https://www.drush.org/13.x/commands/migrate_import/).
  This is a branch snapshot, not a claim about every Drush 13 release.

Drush's built-in commands and the contributed Migrate Tools commands are
alternative implementations. Drush documents that distinction explicitly; do
not assume their shared command names imply identical internals.
([Drush migration guide](https://www.drush.org/13.x/migrate/))

## The documented interface

The modern command accepts a numeric item limit such as:

```sh
drush migrate:import products --limit=1
```

The documented limit is per migration. A list of migration IDs, `--all`, or
dependency execution can therefore process more than one source row overall.
The docs distinguish `--idlist` selection, `--update`, and
`--execute-dependencies` from the limit itself.
([Drush 13 command](https://www.drush.org/13.x/commands/migrate_import/))

Neither inspected modern wrapper parses time units for this option; each stores
the supplied limit and compares a counter with it. Omitted/false/zero values do
not activate the limit check. Use a positive integer; do not treat permissive
PHP comparisons as an intentional input-validation contract.
([Migrate Tools constructor and limit check](https://git.drupalcode.org/project/migrate_tools/-/blob/6.1.4/src/MigrateExecutable.php#L152),
[Drush constructor and limit check](https://github.com/drush-ops/drush/blob/4ed1df714daa6ab5181e437c946a764aac4bc3b6/src/Drupal/Migrate/MigrateExecutable.php#L512))

Examples such as `--limit="60 seconds"` and `--limit="100 items"` belong to the
older Drupal 7 Migrate command documentation. They should not be copied into a
modern Drupal 10/11 contract.
([Drupal 7 command guide](https://www.drupal.org/docs/extending-drupal/contributed-modules/contributed-modules/contributed-modules-for-migration-deployment-backup-and-import/migrate/drush-commands-for-drupal-7s-migrate-module))

## Why repeated runs can advance

Core `SourcePluginBase::rewind()` rewinds the underlying iterator and seeks the
next row. `next()` obtains existing ID-map state, prepares the row, and yields it
only when it has no map row, needs an update, exceeds the original high-water
mark, or has changed under change tracking. Thus unchanged imported rows can be
read and examined without reaching the process/destination pipeline.
([Core source iterator](https://github.com/drupal/drupal/blob/6379cc8e3bac8f363e6d96c3e4657bce293c381a/core/modules/migrate/src/Plugin/migrate/source/SourcePluginBase.php#L384))

The resulting normal case is:

| Source state before invocation | `--limit=1` expected next work |
| --- | --- |
| A, B, C have no map rows | A |
| A imported unchanged; B and C pending | B |
| A and B imported unchanged; C pending | C |
| All imported unchanged | No new processing |

These examples assume ordinary successful rows and functioning wrapper event
delivery. They are source-derived behavior, not a new integration test result.

Eligibility is broader than “never migrated” but is not “retry every failure.”
`Row::needsUpdate()` specifically tests `STATUS_NEEDS_UPDATE`; an unchanged
`FAILED` or `IGNORED` map row does not automatically qualify just because of that
status. Update markers, high-water selection, or configured change tracking can
make existing rows eligible. A skip that deliberately saves no map row can recur.
([Row status test](https://github.com/drupal/drupal/blob/6379cc8e3bac8f363e6d96c3e4657bce293c381a/core/modules/migrate/src/Row.php#L437),
[Source preparation and eligibility](https://github.com/drupal/drupal/blob/6379cc8e3bac8f363e6d96c3e4657bce293c381a/core/modules/migrate/src/Plugin/migrate/source/SourcePluginBase.php#L292))

Continuation is principally an identity-map decision, not a generic committed
page cursor. Core SQL sources have separate batching logic: map joins are
disabled when batching would make the population change beneath offset-based
pages. A source page size and an overall migration limit are different controls.
([Core SQL source](https://github.com/drupal/drupal/blob/6379cc8e3bac8f363e6d96c3e4657bce293c381a/core/modules/migrate/src/Plugin/migrate/source/SqlBase.php))

## What the wrappers actually count

### Migrate Tools 6.1.4

`onMapSave()` increments `itemLimitCounter` for saves to this migration's map.
It is not a success-only counter: imported, updated, ignored, and failed map
outcomes contribute. `onPrepareRow()` requests `RESULT_COMPLETED` when
`itemLimitCounter + 1 >= itemLimit`, anticipating the current row. Feedback resets
the reporting counters, but does not reset the item-limit counter.
([Migrate Tools executable](https://git.drupalcode.org/project/migrate_tools/-/blob/6.1.4/src/MigrateExecutable.php#L203))

That stop request is not an immediate source-iterator break. Core checks
interruption after processing a yielded row. Preparation can skip rows and save
ignored map entries while searching for a yielded row, so source-stage skips can
make recorded outcomes exceed the nominal limit before core observes the stop.
Process-stage failures/skips happen within the yielded-row loop. Do not equate
the map-save counter with an exact destination-call or source-read budget.
([Core import loop](https://github.com/drupal/drupal/blob/6379cc8e3bac8f363e6d96c3e4657bce293c381a/core/modules/migrate/src/MigrateExecutable.php),
[Core preparation](https://github.com/drupal/drupal/blob/6379cc8e3bac8f363e6d96c3e4657bce293c381a/core/modules/migrate/src/Plugin/migrate/source/SourcePluginBase.php#L292))

There is also an integration caveat: this release registers the limit's
prepare-row listener only when the Migrate Plus event class exists, while
Migrate Plus is optional in the package manifest. The non-batched executable's
limit therefore depends on that event being delivered. This is a code-level
dependency observation; absence-of-Migrate-Plus behavior was not run locally.
([Listener registration](https://git.drupalcode.org/project/migrate_tools/-/blob/6.1.4/src/MigrateExecutable.php#L187),
[Package manifest](https://git.drupalcode.org/project/migrate_tools/-/blob/6.1.4/composer.json))

### Drush built-in commands

The inspected Drush implementation instead increments a counter on each matching
prepare-row callback and requests completion when that counter reaches the
limit. Nonmatching `--idlist` rows are excluded before that increment. The
prepare-row event occurs before core's final unchanged/high-water eligibility
decision and before delegated module hooks. Consequently, larger limits can
stop after fewer eligible rows when already-mapped rows are scanned. SQL source
filtering can avoid some callbacks, so this is source-dependent.
([Drush limit callback](https://github.com/drush-ops/drush/blob/4ed1df714daa6ab5181e437c946a764aac4bc3b6/src/Drupal/Migrate/MigrateExecutable.php#L512),
[Prepare-row decorator](https://github.com/drush-ops/drush/blob/4ed1df714daa6ab5181e437c946a764aac4bc3b6/src/Drupal/Migrate/MigratePrepareRowModuleHandler.php#L32))

For `--limit=1`, the early stop signal still permits the next eligible row to be
processed before core checks interruption. That explains why the useful
one-at-a-time behavior can work despite this counter placement. It does not
justify describing every `--limit=N` invocation as an exact eligible-attempt
budget. This conclusion is an inference from the callback and core loop order.

## Option interactions and completion

- **Update:** both standard CLI implementations call `prepareUpdate()` for the
  entire migration map before importing when `--update` is supplied without
  `--idlist`. With an ID list, they mark only those identities for update. A
  one-item update run can therefore leave other rows marked for update;
  repeatedly supplying `--update --limit=1` can reselect the first row.
  ([Migrate Tools command](https://git.drupalcode.org/project/migrate_tools/-/blob/6.1.4/src/Drush/Commands/MigrateToolsCommands.php#L1145),
  [Drush command](https://github.com/drush-ops/drush/blob/4ed1df714daa6ab5181e437c946a764aac4bc3b6/src/Commands/core/MigrateRunnerCommands.php#L391))
- **ID list:** selection is separate from update eligibility. Migrate Tools
  wraps the already-eligible source iterator in `SourceFilter`; built-in Drush
  excludes nonmatching IDs during preparation. Selecting an already imported
  unchanged ID does not itself promise reimport.
  ([Migrate Tools source filter](https://git.drupalcode.org/project/migrate_tools/-/blob/6.1.4/src/SourceFilter.php#L38),
  [Drush callback](https://github.com/drush-ops/drush/blob/4ed1df714daa6ab5181e437c946a764aac4bc3b6/src/Drupal/Migrate/MigrateExecutable.php#L517))
- **Multiple migrations/dependencies:** normal CLI execution creates an
  executable per migration and passes the same limit to recursively executed
  requirements. The budget is not shared. Migrate Tools' separate batch path is
  a further exception: its generated dependency operations explicitly use
  `limit => 0`.
  ([Migrate Tools command](https://git.drupalcode.org/project/migrate_tools/-/blob/6.1.4/src/Drush/Commands/MigrateToolsCommands.php#L1116),
  [Drush command](https://github.com/drush-ops/drush/blob/4ed1df714daa6ab5181e437c946a764aac4bc3b6/src/Commands/core/MigrateRunnerCommands.php#L373),
  [Migrate Tools batch operations](https://git.drupalcode.org/project/migrate_tools/-/blob/6.1.4/src/MigrateBatchExecutable.php#L184))
- **Deletion:** built-in Drush documents `--delete` as incompatible with limits,
  ID lists, and high-water sources. Its constructor disables missing-source
  deletion in those cases. This specific safeguard should not be generalized
  to every contrib module's synchronization mode.
  ([Drush deletion guard](https://github.com/drush-ops/drush/blob/4ed1df714daa6ab5181e437c946a764aac4bc3b6/src/Drupal/Migrate/MigrateExecutable.php#L143))
- **Completion:** both wrappers signal `RESULT_COMPLETED` on the limit and emit
  the ordinary final progress summary, including separate created, updated,
  failed, and ignored counts. The final wording does not establish source
  exhaustion. Core returns migration status to idle after import.
  ([Migrate Tools completion](https://git.drupalcode.org/project/migrate_tools/-/blob/6.1.4/src/MigrateExecutable.php#L315),
  [Drush completion](https://github.com/drush-ops/drush/blob/4ed1df714daa6ab5181e437c946a764aac4bc3b6/src/Drupal/Migrate/MigrateExecutable.php#L348),
  [Core executor](https://github.com/drupal/drupal/blob/6379cc8e3bac8f363e6d96c3e4657bce293c381a/core/modules/migrate/src/MigrateExecutable.php))

Upstream tests establish ordinary limited imports and limit/feedback coexistence:
Migrate Tools asserts two created rows for limit two, while Drush asserts 199
imports from 300 with feedback every 20 and 101 rows still unprocessed. Those
tests were inspected, not executed here; they do not establish the edge cases
above.
([Migrate Tools test](https://git.drupalcode.org/project/migrate_tools/-/blob/6.1.4/tests/src/Functional/DrushCommandsTest.php#L49),
[Drush regression test](https://github.com/drush-ops/drush/blob/4ed1df714daa6ab5181e437c946a764aac4bc3b6/tests/integration/MigrateRunnerTest.php#L329))

## Normal runs: source order versus backlog priority

Drupal core's normal import starts by rewinding the source, then processes its
current row and advances the source iterator. It does not first enumerate failed
or needs-update ID-map rows as a separate work queue. Although the SQL ID-map API
provides `getRowsNeedingUpdate()`, the normal import loop does not call it.
([Core import loop](https://github.com/drupal/drupal/blob/6379cc8e3bac8f363e6d96c3e4657bce293c381a/core/modules/migrate/src/MigrateExecutable.php#L157),
[ID-map query API](https://github.com/drupal/drupal/blob/6379cc8e3bac8f363e6d96c3e4657bce293c381a/core/modules/migrate/src/Plugin/migrate/id_map/Sql.php#L570))

`NEEDS_UPDATE` makes a row eligible when encountered in the source. `FAILED`
alone does not; neither does `IGNORED`. A failed row can become eligible through
an update marker, configured change tracking, or a qualifying high-water value.
SQL `prepareUpdate()` changes every existing map row to `NEEDS_UPDATE`, including
failed and ignored rows; `setUpdate()` applies that change to one source identity.
Neither operation schedules a separate retry phase.
([Source eligibility](https://github.com/drupal/drupal/blob/6379cc8e3bac8f363e6d96c3e4657bce293c381a/core/modules/migrate/src/Plugin/migrate/source/SourcePluginBase.php#L392),
[Update preparation](https://github.com/drupal/drupal/blob/6379cc8e3bac8f363e6d96c3e4657bce293c381a/core/modules/migrate/src/Plugin/migrate/id_map/Sql.php#L765),
[Individual update marker](https://github.com/drupal/drupal/blob/6379cc8e3bac8f363e6d96c3e4657bce293c381a/core/modules/migrate/src/Plugin/migrate/id_map/Sql.php#L879))

When a SQL source can join its map, its query includes source rows with no map,
rows marked `NEEDS_UPDATE`, and rows above a configured high-water mark using an
OR condition. This selects a combined source stream; it does not sort update
rows ahead of new rows. Ordering comes from the source query, with an additional
high-water-field order when configured. If the map cannot be joined, core checks
map state as source rows arrive. With an existing SQL high-water mark in that
case, the query can exclude older rows even if their map status needs update;
there is no separate map-driven recovery pass to fetch them by identity.
([SQL iterator conditions and ordering](https://github.com/drupal/drupal/blob/6379cc8e3bac8f363e6d96c3e4657bce293c381a/core/modules/migrate/src/Plugin/migrate/source/SqlBase.php#L249),
[Map join restrictions](https://github.com/drupal/drupal/blob/6379cc8e3bac8f363e6d96c3e4657bce293c381a/core/modules/migrate/src/Plugin/migrate/source/SqlBase.php#L413))

**SDK comparison, based on the accompanying repository audit:** Migrate SDK's
previously verified normal-run behavior processes a failed/needs-update backlog
before source discovery. That is an additional SDK scheduling policy, not a
direct copy of Drupal core's normal source-driven import. The two independent
choices are whether an existing state qualifies for processing and whether it
gets priority over new source items. Drupal's normal core loop establishes the
former without a universal backlog-first phase. Custom Drupal source plugins or
contributed runners can define additional behavior; none was assumed here.

## Implication for Migrate SDK

The useful model to adopt is durable per-identity eligibility plus a bounded run,
so repeated invocations advance past unchanged migrated source items. The exact
SDK contract should be clearer than these callback-based implementations:

1. Define the limit as eligible source-item attempts, including explicit failure
   and pipeline-skip outcomes, rather than successful destination writes.
2. Reserve budget after eligibility and before scheduling work, so concurrency
   cannot exceed it.
3. Preserve unprocessed items when stopping within a Source Cursor Window.
4. Record limit reached separately from completed authoritative source discovery.
5. Specify whether dependencies share a budget and whether update marking is
   broader than the selected items.

These are design recommendations derived from the Drupal comparison, not a
fresh audit of the SDK's current implementation gaps.
