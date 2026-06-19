# Execute Update Rescan For Migrated Items

Status: ready-for-agent

## Parent

[Run Update Rescan](../PRD.md)

## What to build

Implement the first executable update run path. When update intent reaches runtime execution, the selected Migration Definition should schedule existing migrated Migration Item States for reprocessing, clear the Source Cursor, scan from the beginning, and run the Process Pipeline for matching Source Items even when their Source Version is unchanged.

The completed slice should be verifiable with a migrated item that a normal run would count as unchanged, while an update run processes it again and persists a fresh migrated state.

## Acceptance criteria

- [ ] Update execution acquires normal Migration Definition locks before mutating update state.
- [ ] Update execution runs normal run preflight before mutating update state.
- [ ] Existing migrated Migration Item States are converted to Needs Update state before source discovery.
- [ ] Update scheduling preserves Source Identity, Source Version, source version contract metadata, Tracking Record, and Destination Journal evidence.
- [ ] Update scheduling records a reason indicating the item was scheduled by an update run.
- [ ] Update scheduling is idempotent for already scheduled Needs Update states.
- [ ] Failed and skipped item states are not converted to Needs Update by this slice.
- [ ] Update execution clears the Source Cursor for each selected Migration Definition.
- [ ] Update execution starts cursor discovery from the beginning.
- [ ] A previously migrated Source Item with matching Source Version runs the Process Pipeline during update.
- [ ] A normal run still counts the same matching-version migrated Source Item as unchanged.
- [ ] Newly discovered Source Items are processed as normal migrated items during update.
- [ ] Successful update processing replaces scheduled state with fresh migrated state.
- [ ] Process context includes previous Migration Item State when an updated item is processed.
- [ ] Update execution works through raw SDK run, registry run, and CLI run paths.

## Blocked by

- [Add Update Run Planning And Validation](./01-add-update-run-planning-and-validation.md)
