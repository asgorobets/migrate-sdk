# Drupal limits across multiple migrations

Research date: 2026-09-14

## Conclusion

The standard Drupal CLI implementations support a separate limit for each
selected migration. `--all --limit=1`, an explicit list of migration IDs with
`--limit=1`, and Migrate Tools' `--group=example --limit=1` pass the same limit to
each migration's executable. They do not share one item budget across the whole
command. Required dependencies executed recursively also receive that limit in
the normal CLI path.

This validates the proposed SDK direction of per-definition limits for a
multi-definition plan. It does not imply that partially imported dependencies
automatically satisfy Drupal's dependency requirements. Current core checks
source count against the number of recorded ID-map rows before allowing a
dependent migration to import. Selection, per-migration budgets, and dependency
readiness are separate decisions, as detailed below.

## Sources inspected

Fresh official documentation and source were read on the research date:

- [Drush 13 command documentation](https://www.drush.org/13.x/commands/migrate_import/)
  and `13.x` commit `1d9e5f800ee982a231cc0b6cc823f8465c04737b`.
- [Drush 14 command documentation](https://www.drush.org/14.x/commands/migrate_import/)
  and `14.x` commit `d355656d8a876098fe1319a070bef48162076bbe`.
- [Migrate Tools project](https://www.drupal.org/project/migrate_tools) and
  `6.1.x` commit `bb2053b30060f4302736b1c59fa0c155324ac4aa`.
- Drupal core `11.x` commit `c647ff03d3a51379d2dcd22b20d5ddcf310f90e9`.

These are current development-branch snapshots, not a claim that every released
version has identical behavior. Drush's built-in commands and Migrate Tools are
alternative command implementations. This note supplements the
[earlier item-limit research](drupal-migrate-limit.md). No migration or upstream
test was executed; no implementation was changed.

## Where the budget belongs

| Selection | Built-in Drush 13/14 | Migrate Tools 6.1.x, normal CLI path |
| --- | --- | --- |
| One migration ID | One executable with the requested limit | Same |
| Comma-separated migration IDs | New executable for each selected migration; same limit | Same |
| `--all` | Same limit for each selected migration | Same |
| `--tag` | Same limit for each selected migration | Same |
| `--group` | Not an option of the inspected built-in command | Same limit for each migration in the selected group(s) |
| `--execute-dependencies` | Same options passed into required-dependency recursion | Same options passed into requirement recursion, plus `is_dependency` |

Drush 13 collects `limit` into `userData.options`, walks the selected migrations,
and constructs a new executable inside `executeMigration()`. Drush 14 moved the
command into a separate class but preserves that structure. Neither decrements
the limit in command-level shared state.
([Drush 13 import and recursion](https://github.com/drush-ops/drush/blob/1d9e5f800ee982a231cc0b6cc823f8465c04737b/src/Commands/core/MigrateRunnerCommands.php#L322),
[Drush 14 import and recursion](https://github.com/drush-ops/drush/blob/d355656d8a876098fe1319a070bef48162076bbe/src/Commands/migrate/MigrateImportCommand.php#L82))

Migrate Tools resolves group/tag/ID/all selection, then loops through the
resulting groups and migrations with the unchanged options. Its normal
executable construction and recursive requirement calls retain `limit`.
([Selection loop](https://git.drupalcode.org/project/migrate_tools/-/blob/bb2053b30060f4302736b1c59fa0c155324ac4aa/src/Drush/Commands/MigrateToolsCommands.php#L461),
[Recursion and executable construction](https://git.drupalcode.org/project/migrate_tools/-/blob/bb2053b30060f4302736b1c59fa0c155324ac4aa/src/Drush/Commands/MigrateToolsCommands.php#L1145))

Thus, for three independent migrations with eligible rows, `--all --limit=1`
requests up to one item from each migration, rather than stopping the command
after its first item. Actual counts remain subject to the callback caveats
below, and a migration failure can stop the command before later selections run.

**Separate batch-path exception:** Migrate Tools' `MigrateBatchExecutable`
explicitly gives generated required-dependency operations `limit => 0` so their
items can all be processed. The same class subtracts processed items from a
migration's remaining limit between batch iterations. Do not describe this
batch path as giving every generated dependency the CLI item limit.
([Batch operations and continuation](https://git.drupalcode.org/project/migrate_tools/-/blob/bb2053b30060f4302736b1c59fa0c155324ac4aa/src/MigrateBatchExecutable.php#L184))

## Required dependencies: exact core criterion

Core constructs an ordered dependency graph and records required dependency
paths as migration `requirements`; optional edges affect ordering without
becoming required paths. The core import executor calls `checkRequirements()`
before rewinding the source and returns `RESULT_FAILED` if that check raises a
requirements error.
([Graph construction](https://github.com/drupal/drupal/blob/c647ff03d3a51379d2dcd22b20d5ddcf310f90e9/core/modules/migrate/src/Plugin/MigrationPluginManager.php#L162),
[Import preflight](https://github.com/drupal/drupal/blob/c647ff03d3a51379d2dcd22b20d5ddcf310f90e9/core/modules/migrate/src/MigrateExecutable.php#L139))

`Migration::checkRequirements()` rejects missing required migration definitions
and required migrations whose `allRowsProcessed()` is false. That method returns
true exactly when the source reports an uncountable value below zero, or its
count is less than or equal to `getIdMap()->processedCount()`. It does not check
the previous run's completed result, whether the previous run hit a limit, or a
successful-import-only count.
([Requirement check](https://github.com/drupal/drupal/blob/c647ff03d3a51379d2dcd22b20d5ddcf310f90e9/core/modules/migrate/src/Plugin/Migration.php#L476),
[Completion predicate](https://github.com/drupal/drupal/blob/c647ff03d3a51379d2dcd22b20d5ddcf310f90e9/core/modules/migrate/src/Plugin/Migration.php#L567))

With the standard SQL ID map, `processedCount()` counts all map rows, with no
status filter. Missing map tables count as zero. These code-derived examples
illustrate the consequence; they assume the dependency definition exists and
source/destination plugin requirements pass:

| Required migration state | Core readiness result |
| --- | --- |
| Source count 100; one recorded row after a limited run | Fails |
| Source count 1; one recorded row | Passes |
| Source count 0; zero map rows, even without a prior import | Passes |
| Source count 100; 100 map rows including failed/ignored/needs-update statuses | Passes this count check |
| Uncountable source; zero map rows | Passes this count check |
| Map count exceeds source count, for example from stubs or historical rows | Passes this count check |

([SQL processed count and count helper](https://github.com/drupal/drupal/blob/c647ff03d3a51379d2dcd22b20d5ddcf310f90e9/core/modules/migrate/src/Plugin/migrate/id_map/Sql.php#L774))

Consequently, `products --execute-dependencies --limit=1` can run one row of a
required category migration and then fail the product migration's requirement
check when categories has more unrecorded rows. Passing the same limit to both
does not bypass preflight. `--force` clears migration requirements in both
wrappers; core still checks source/destination plugin requirements first.
([Drush force handling](https://github.com/drush-ops/drush/blob/d355656d8a876098fe1319a070bef48162076bbe/src/Commands/migrate/MigrateImportCommand.php#L146),
[Migrate Tools force handling](https://git.drupalcode.org/project/migrate_tools/-/blob/bb2053b30060f4302736b1c59fa0c155324ac4aa/src/Drush/Commands/MigrateToolsCommands.php#L1172))

Recorded failures and command failure are also different. The SQL count can
satisfy readiness despite failed rows from an earlier run, but a wrapper can
abort the current command immediately after a migration records failures.
Migrate Tools has `--continue-on-failure` handling; built-in Drush throws when its
current executable reports failures. This affects whether later selected
migrations are reached at all.
([Migrate Tools failure handling](https://git.drupalcode.org/project/migrate_tools/-/blob/bb2053b30060f4302736b1c59fa0c155324ac4aa/src/Drush/Commands/MigrateToolsCommands.php#L1229),
[Drush failure handling](https://github.com/drush-ops/drush/blob/d355656d8a876098fe1319a070bef48162076bbe/src/Commands/migrate/MigrateImportCommand.php#L175))

## Counting caveats and SDK interpretation

Each executable owns its own counter. Migrate Tools increments its limit counter
on matching ID-map saves, including failure/ignored outcomes, and requests
completion during row preparation. Built-in Drush increments its counter during
matching prepare-row callbacks, which can occur before final source eligibility.
The earlier note explains how source-stage skips and already-mapped rows prevent
these mechanisms from being a universal exact budget of eligible attempts.
([Migrate Tools counters](https://git.drupalcode.org/project/migrate_tools/-/blob/bb2053b30060f4302736b1c59fa0c155324ac4aa/src/MigrateExecutable.php#L203),
[Drush counter](https://github.com/drush-ops/drush/blob/d355656d8a876098fe1319a070bef48162076bbe/src/Drupal/Migrate/MigrateExecutable.php#L501))

For the SDK, a limit scoped to each definition is consistent with the normal
Drupal CLI model and does not inherently require a single-definition
restriction. An SDK implementation can preserve its stricter eligible-attempt
counting while making that budget independent per definition. Whether limited
upstream work is sufficient to run a dependent definition remains a separate
SDK policy: Drupal's count-based preflight is evidence of a distinct readiness
check, not a reason to call a partial source scan complete. These are design
inferences; this research did not audit or modify the SDK implementation.

The accompanying SDK audit found that included dependencies are ordered and run
without a completion recheck between definitions; durable dependency preflight
applies to dependencies omitted from the selected plan. Per-definition counters
already reset independently. On that evidence, permitting multi-definition
limited plans would allow one eligible attempt per included definition, while a
later standalone dependent can remain blocked when its omitted prerequisite has
no completed-run evidence. This differs from Drupal core's per-import readiness
check for an included but partially processed prerequisite. The distinction
should be documented explicitly if the SDK adopts that plan behavior.

## Proposed SDK scope and implementation gaps

Recommendation for discussion: apply `--limit N` independently to every
definition in a normal run's selected and dependency-expanded plan. Three
selected definitions may therefore attempt up to `3 * N` items. Source order,
eligibility, failure/skip counting, and partial-page continuation stay the same
inside each definition. These examples describe the proposed behavior:

| Command | Attempt budget |
| --- | --- |
| `migrate run books --limit 1` | One eligible book |
| `migrate run --group catalog --limit 1` | One eligible item in each selected catalog migration |
| `migrate run --all --limit 1` | One eligible item in each selected migration |
| `migrate run books --with-dependencies --limit 1` | One eligible item in each included prerequisite, then one eligible book |

The current implementation rejects these broader selections in
[`runLimitValidationMessage`](../../packages/migrate-sdk/src/domain/run-limit.ts).
Both registry planning and direct runtime execution use that helper. The
restriction is a deliberate initial scope rule in ADR 0012, rather than a
requirement of the budget implementation.

The inline runner already passes the same limit separately to each definition;
each definition initializes its own counts. The Workflow runner also initializes
fresh cursor-window state for each definition and passes the plan's limit into
each window. Thus, the implementation work centers on removing the selection
restriction and proving those existing boundaries across multiple definitions.
([Inline execution](../../packages/migrate-sdk/src/services/migration-run-executor.ts),
[Workflow orchestration](../../packages/workflow-sdk/src/migration-execution-workflow.ts),
[Workflow step input](../../packages/workflow-sdk/src/steps.ts))

The dependency policy needs an explicit amendment to ADR 0012 and clarification
alongside ADR 0011. A dependency included in the plan runs before its dependent,
even when its requested limited work stops short of source exhaustion. That
does not create durable completion. A required dependency omitted from the plan
must still have valid prior completion, unless the existing force option is
used. The SDK currently generates completion preflight edges only for omitted
dependencies; it does not recheck completion between definitions in the same
plan. Broad limited runs would make this distinction visible to users.
([Plan preflight edges](../../packages/migrate-sdk/src/domain/registry.ts),
[Completion contract](../adr/0011-operation-history-and-migration-readiness.md))

One item from each migration does not guarantee a related sample: the first
book can reference an author outside the limited author batch. Ordinary missing
reference behavior and retries still apply. A run-level item limit also does
not cap destination operations or reference-created stubs.

Required changes and coverage:

- Permit explicit multiple definitions, groups, all, and dependency expansion in
  the shared limit validator. Keep the restrictions on update, targeted retry,
  explicit identity, and orphan cleanup modes as a separate scope decision.
- Say "per migration" in CLI help, prepared-plan output, README, and release notes.
  Update ADR 0012 and the domain rule that currently require one definition.
- Cover independent budgets, different page sizes, unchanged prefixes,
  repeated limited runs, and no concurrency overshoot in both inline and
  Workflow execution.
- Cover included partial prerequisites, omitted incomplete prerequisites,
  existing completion, rollback invalidation, exact-end completion, and one
  definition failing while later definitions still receive their own budget.
- Preserve the CLI check that the server returns the requested limit. The
  request already carries selection and limit independently, so this proposal
  does not need another public status or stop-reason field.

This proposal has not changed the SDK's current limit-selection behavior.
