# Tighten Source Boundary Schemas and Durable Error Records

Status: ready-for-human

## Parent

[Source Boundary Validation and Durable Error Details](../PRD.md)

## What to build

Tighten the domain and runtime contracts that source payload validation will rely on. The SDK should require a Source Payload Schema on the runtime Source Plugin, require meaningful non-empty identifiers and versions at store boundaries, and persist durable Migration Item Error records that future inspection APIs can read without depending on raw live causes.

Update the design docs alongside the code so the documented public contract matches the implementation as it changes.

## Acceptance criteria

- [x] Every configured Source Plugin exposes a required Source Payload Schema at runtime.
- [x] The core SDK continues to require Effect Schema for configured source plugins, while leaving source-native schema derivation to future adapters.
- [x] Source Version is required on Source Items and is a non-empty domain primitive.
- [x] Migration Item State requires Source Version.
- [x] Destination Identity, Destination Version, and Migration Run Id are non-empty domain primitives.
- [x] Migration Definition Lock Token is a branded non-empty domain primitive used by lock records.
- [x] Encoded Source Cursor remains unchanged; non-empty cursor semantics are deferred.
- [x] Migration Item Error supports optional durable details for all item error kinds.
- [x] Migration Item Error Detail has optional string path and required message.
- [x] Persisted Migration Item Error records do not store raw live causes.
- [x] Generic source, pipeline, and destination item error normalization persists stable error kind, error tag, message, and optional details only.
- [x] File-store item-state decoding fails for records missing Source Version.
- [x] In-memory and file-store behavior stay aligned around persisted item error shape.
- [x] Existing tests that asserted persisted causes are updated to assert durable error records instead.
- [x] Relevant design documentation is updated in place as part of the code change.

## Blocked by

None - can start immediately
