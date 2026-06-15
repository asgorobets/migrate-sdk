# End-To-End Source Identity Contract Migration

Status: ready-for-human

## Parent

[Source Identity Contracts](../PRD.md)

## What to build

Migrate the SDK from branded-string source identities to schema-backed Source
Identity Contracts in one coherent end-to-end slice.

This slice should introduce the public source identity contract authoring shape,
normalize emitted source items into structured and encoded source identity
values, update targeted source lookup to receive decoded source identity
targets, persist the new item-state identity shape, and refactor existing
source implementations and examples so the repository compiles against the new
contract.

This is intentionally a broad tracer bullet. The source identity type is a
cross-cutting public API, so splitting the first migration by layer would likely
leave intermediate states that cannot compile.

## Acceptance criteria

- [x] Migration authors can define a scalar source identity contract with a
      versioned id and schema-backed key.
- [x] Migration authors can define a fixed tuple source identity contract with
      named parts.
- [x] Reusable source identity contracts can provide id, schema, and fingerprint
      metadata to source plugin options.
- [x] Configured source plugins expose the source identity contract as part of
      their runtime contract.
- [x] Source plugin reads emit structured source identity key values rather than
      encoded identity strings.
- [x] The runtime validates emitted source identity key values against the
      configured source identity schema.
- [x] The runtime constructs pipeline-facing Source Items with source identity
      contract id, structured key, and encoded source identity.
- [x] Pipelines can read the structured source identity key without parsing an
      encoded string.
- [x] Targeted source lookup calls `readByIdentity` with decoded source identity
      target data, including contract id, structured key, and encoded key.
- [x] Existing item-state reads and writes use encoded source identity for
      durable lookup and duplicate detection.
- [x] Migration Item State persists enough source identity data to recover both
      structured and encoded source identity.
- [x] Existing in-memory source behavior compiles and runs against the new
      source identity contract.
- [x] Existing CSV source behavior compiles and runs against the new source
      identity contract.
- [x] Existing JSON file source behavior compiles and runs against the new
      source identity contract.
- [x] Existing document source behavior compiles and runs against the new
      source identity contract.
- [x] Existing SQL source behavior compiles and runs against the new source
      identity contract.
- [x] Existing source examples and fixtures are updated away from stale
      branded-string source identity authoring.
- [x] Existing runtime tests are updated to assert structured and encoded source
      identity behavior.
- [x] Existing source plugin tests are updated rather than bypassed.
- [x] Type checking passes for the package after the migration.
- [x] The relevant source identity design docs remain truthful after the code
      change.

## Blocked by

None - can start immediately
