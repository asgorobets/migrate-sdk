# Add Update Run Planning And Validation

Status: ready-for-agent

## Parent

[Run Update Rescan](../PRD.md)

## What to build

Add update intent to run planning and command validation without changing runtime execution behavior yet. Operators should be able to request an update run through the SDK, registry-backed planning, and CLI plan path, see that update intent in rendered plans, and get clear validation failures for combinations that are not part of the first update slice.

This slice should keep `--update` separate from Run Mode. Update is a run execution option, while Run Mode continues to describe normal, failed, skipped, or single-item source selection.

## Acceptance criteria

- [ ] Raw run request input accepts update intent.
- [ ] Registry-backed run input accepts update intent.
- [ ] Run planning preserves update intent in the structured plan.
- [ ] CLI `migrate run --update <definition>` parses successfully.
- [ ] CLI `migrate run --update --all` parses successfully.
- [ ] CLI `migrate run --update <definition> --with-dependencies` parses successfully.
- [ ] Plan output makes update intent visible to the operator.
- [ ] Plan mode remains static and does not acquire locks, read stores, mutate item state, clear Source Cursors, scan sources, or run process pipelines.
- [ ] `--update --failed` is rejected with a clear error.
- [ ] `--update --skipped` is rejected with a clear error.
- [ ] `--update` with source identity targeting is rejected with a clear error.
- [ ] Missing dependency suggestions preserve the update flag when suggesting corrected run commands.
- [ ] Existing run mode, source identity targeting, dependency expansion, and plan rendering tests remain green.

## Blocked by

None - can start immediately
