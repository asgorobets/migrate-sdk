# Source Identity Contract Hardening

Status: ready-for-agent

## Parent

[Source Identity Contracts](../PRD.md)

## What to build

Harden the source identity contract after the end-to-end migration compiles.

This slice should add the validation, diagnostics, and edge-case behavior that
keeps the public source identity API difficult to misuse. It should focus on
unsupported schema shapes, invalid emitted identity values, malformed durable
records, duplicate source identities, and targeted id parsing behavior.

## Acceptance criteria

- [ ] Raw struct schemas are rejected as canonical source identity keys.
- [ ] Tuple source identity schemas with unnamed parts are rejected.
- [ ] Tuple source identity schemas with optional elements are rejected.
- [ ] Tuple source identity schemas with rest elements are rejected.
- [ ] Unsupported nested source identity key parts are rejected unless the
      current implementation explicitly supports their canonical encoding.
- [ ] Invalid source identity keys emitted by source plugins fail before item
      state lookup, duplicate detection, or pipeline execution.
- [ ] Invalid emitted identity failures preserve enough source boundary context
      for durable item errors when a record can safely be written.
- [ ] Malformed durable source identity records fail decoding instead of being
      silently accepted.
- [ ] Duplicate source identity detection uses encoded source identity for both
      scalar and tuple keys.
- [ ] Duplicate source identity diagnostics include human-readable source
      identity part information where available.
- [ ] Tuple part names appear in validation errors and operator-facing
      diagnostics where those surfaces already exist.
- [ ] Scalar targeted ids parse as one CLI value through the selected
      migration definition's source identity schema.
- [ ] Tuple targeted ids parse positionally through the selected migration
      definition's source identity schema.
- [ ] Malformed targeted ids fail before source lookup starts.
- [ ] Repeated targeted ids are deduplicated and surfaced as operator feedback.
- [ ] Comma-separated id lists are not introduced as a primary targeting API.
- [ ] Scan-based targeted lookup can find a tuple source identity by comparing
      encoded identities.
- [ ] Direct targeted lookup receives structured tuple key parts.
- [ ] Cursor positions, page numbers, and offsets are not required in source
      identity for scan lookup.
- [ ] Hardening tests cover behavior at runtime, store, source plugin, and CLI
      boundaries without asserting private helper internals.

## Blocked by

[End-To-End Source Identity Contract Migration](01-end-to-end-source-identity-contract-migration.md)
