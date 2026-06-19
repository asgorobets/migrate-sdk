# Source Identity Contract Hardening

Status: ready-for-human

## Parent

[Source Identity Contracts](../PRD.md)

## What to build

Harden the source identity contract after the end-to-end migration compiles.

This slice should add the validation, diagnostics, and edge-case behavior that
keeps the public source identity API difficult to misuse. It should focus on
unsupported schema shapes, invalid emitted identity values, malformed durable
records, duplicate source identities, and targeted id parsing behavior.

## Acceptance criteria

- [x] Raw struct schemas are rejected as canonical source identity keys.
- [x] Tuple source identity schemas with unnamed parts are rejected.
- [x] Tuple source identity schemas with optional elements are rejected.
- [x] Tuple source identity schemas with rest elements are rejected.
- [x] Unsupported nested source identity key parts are rejected unless the
      current implementation explicitly supports their canonical encoding.
- [x] Source identity codecs are supported when both decoded and encoded key
      parts remain scalar values.
- [x] Decoded source identity keys are canonicalized through the schema encoder
      before durable encoded identities are persisted or compared.
- [x] Invalid source identity keys emitted by source plugins fail before item
      state lookup, duplicate detection, or pipeline execution.
- [x] Invalid emitted identity failures preserve enough source boundary context
      for durable item errors when a record can safely be written.
- [x] Malformed durable source identity records fail decoding instead of being
      silently accepted.
- [x] Duplicate source identity detection uses encoded source identity for both
      scalar and tuple keys.
- [x] Duplicate source identity diagnostics include human-readable source
      identity part information where available.
- [x] Tuple part names appear in validation errors and operator-facing
      diagnostics where those surfaces already exist.
- [x] Scalar targeted ids parse as one CLI value through the selected
      migration definition's source identity schema.
- [x] Tuple targeted ids parse positionally through the selected migration
      definition's source identity schema.
- [x] Malformed targeted ids fail before source lookup starts.
- [x] Repeated targeted ids are deduplicated and surfaced as operator feedback.
- [x] Comma-separated id lists are not introduced as a primary targeting API.
- [x] Source plugins that implement scan-backed `readByIdentity` can find a
      tuple source identity by comparing encoded identities internally.
- [x] Direct targeted lookup receives structured tuple key parts.
- [x] Cursor positions, page numbers, and offsets are not required in source
      identity for scan lookup.
- [x] Hardening tests cover behavior at runtime, store, source plugin, and CLI
      boundaries without asserting private helper internals.

## Blocked by

[End-To-End Source Identity Contract Migration](01-end-to-end-source-identity-contract-migration.md)
