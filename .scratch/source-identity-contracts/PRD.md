# Source Identity Contracts

Status: ready-for-agent

## Problem Statement

The SDK currently treats source identity too much like one branded string. That
is not enough for migrations where a source item is naturally identified by more
than one value, such as an address inside a business unit, a localized field
inside a document, or a row whose durable identity is a tuple of source columns.

Migration authors need source identities that are structured, schema-validated,
durably encoded, easy to target from the CLI, and safe to compare across runs.
Source plugin authors need a common runtime contract without losing the
source-specific ways their plugin derives identity from rows, documents, API
pages, nested selections, or SQL records.

The runtime also needs to detect unsafe mapping drift. If a migration definition
has already written item state using one source identity contract, running the
same migration with a changed identity schema or changed declarative mapping can
make retry, skip, lookup, rollback, and status output unsafe.

## Solution

Introduce schema-backed Source Identity Contracts as the public source identity
model.

A source identity contract has a versioned compatibility name, a supported
identity key schema, SDK-owned canonical encoding, and a contract fingerprint. Source
identity values can be scalar keys or fixed positional tuple keys. Tuple parts
must be named in schema metadata so diagnostics, CLI help, status output, reset
tooling, and contract mismatch errors remain human-readable without turning the
durable key into a struct.

Source plugins keep ownership of source-native identity derivation. Each plugin
exposes the same identity envelope, but the `key` authoring shape can be
plugin-specific: a CSV plugin can derive identity from columns, a document
plugin can derive identity from selected parent and item context, and a direct
API source can derive identity from a decoded response record.

The runtime normalizes every emitted source item into a Source Item that carries
the structured identity key, the source identity contract id, the encoded source
identity, the source payload, and the source version. The encoded source
identity remains the durable lookup key. The structured key remains available to
source lookup, pipeline code, status rendering, future reset or rekey tools, and
source-aware diagnostics.

The migration store records a Migration Contract for each migration definition.
The hard compatibility check is the source identity contract fingerprint: if it
differs from stored state and any migration item state exists, execution is
blocked until the user intentionally clears state, rolls back, or uses a future
explicit rekey or reset operation.

Source version contracts are tracked separately as comparability metadata. The
store may record the current source version contract metadata on the Migration
Contract for inspection, but each Migration Item State records the source
version contract fingerprint that produced its `sourceVersion`. A stored source
version is treated as unchanged only when both the version value and the
per-item source version contract fingerprint match the current source item and
definition.

## User Stories

1. As a migration author, I want to declare a scalar source identity key, so that
   simple sources still have the same ergonomic authoring path.

2. As a migration author, I want to declare a composite source identity key, so
   that nested or multi-column source items can be tracked safely.

3. As a migration author, I want a source identity contract id, so that I can
   make an explicit compatibility promise about how source keys are derived.

4. As a migration author, I want tuple identity parts to be named, so that CLI
   help, status output, and errors can explain which value failed.

5. As a migration author, I want tuple identity order to be durable, so that
   changing key part order is treated as changing identity semantics.

6. As a migration author, I want source identity keys validated by Effect Schema,
   so that invalid identity values fail before they become durable state.

7. As a migration author, I want source identity derivation to happen before my
   pipeline runs, so that failures inside my pipeline can still be recorded
   against the correct source item.

8. As a migration author, I want the pipeline to receive the structured source
   identity key, so that advanced transformations can inspect it without parsing
   an encoded string.

9. As a migration author, I want source version to remain separate from source
   identity, so that identity answers "which source item" and version answers
   "which observed revision".

10. As a migration author, I want the source version contract recorded with each
    observed item state, so that unchanged detection is invalidated when source
    version semantics change.

11. As a migration author, I want source identity contract mismatches to block
    execution, so that accidental identity changes cannot corrupt targeting,
    dedupe, retries, skips, rollbacks, or status.

12. As a migration author, I want function-based identity derivation to require
    an explicit contract version bump when semantics change, so that the SDK
    does not pretend JavaScript function bodies are reliable fingerprints.

13. As a migration author, I want declarative identity mappings to participate
    in contract fingerprints, so that column or path changes are detected
    mechanically where possible.

14. As a migration author, I want source identity structs rejected as canonical
    keys, so that lookup keys stay scalar or positional instead of becoming
    hierarchical objects with ordering ambiguity.

15. As a migration author, I want reusable source identity contracts, so that
    multiple source plugins can share the same id, schema, and fingerprint while
    deriving keys from their own source-native context.

16. As a CSV source user, I want source identity key parts to map to CSV columns,
    so that tuple position follows a clear column order.

17. As a document source user, I want source identity key derivation to receive
    the selected document context, so that a nested item can be identified by
    parent and child values.

18. As a SQL source user, I want source identity key derivation to use selected
    fields, so that database primary keys and compound keys map naturally into
    source identity contracts.

19. As a source plugin author, I want a common source identity envelope, so that
    every plugin produces the same runtime source identity model.

20. As a source plugin author, I want the `key` authoring API to remain
    plugin-specific, so that my plugin can expose columns, paths, callbacks, or
    field projections without forcing every source into one generic selector
    DSL.

21. As a source plugin author, I want the runtime to attach the contract id and
    encoded identity, so that plugin reads only need to emit structured identity
    key values.

22. As a source plugin author, I want `readByIdentity` to receive a decoded
    source identity target, so that direct lookups can use structured key parts
    without parsing encoded strings.

23. As a source plugin author, I want scan-only sources to support targeted
    lookup by comparing encoded identities, so that every source can be targeted
    correctly even without a direct lookup primitive.

24. As a source plugin author, I want direct lookup sources to use structured
    keys, so that a composite key can fetch the smallest available source
    resource.

25. As a source plugin author, I want invalid emitted identity keys to become
    source boundary failures, so that bad plugin output is caught consistently.

26. As a runtime maintainer, I want one canonical source identity encoder, so
    that stores, CLI targeting, duplicate detection, and status output agree.

27. As a runtime maintainer, I want encoded source identity to remain the durable
    store key, so that migration item state lookup is stable and compact.

28. As a runtime maintainer, I want structured source identity persisted, so that
    status, inspection, rollback, and future reference lookup do not depend on
    reparsing display strings.

29. As a runtime maintainer, I want duplicate source identity detection to use
    the encoded identity, so that scalar and composite identities follow one
    comparison rule.

30. As a runtime maintainer, I want a source identity schema fingerprint, so that
    schema changes are captured even when the contract id is accidentally reused.

31. As a runtime maintainer, I want declarative source-to-key mappings included
    in the fingerprint, so that changing CSV columns or plugin-declared paths
    changes the Migration Contract.

32. As a runtime maintainer, I want function-based mappings marked as
    user-versioned, so that the runtime has honest guarantees about what it can
    and cannot fingerprint.

33. As a store implementer, I want item state to include source identity
    contract id, structured key, and encoded key, so that old and new state can
    be decoded and inspected deterministically.

34. As a store implementer, I want Migration Contract state stored separately
    from item state, so that execution can be blocked before reading or writing
    individual items.

35. As a CLI operator, I want repeatable `--id` flags for targeted runs, so that
    multiple source items can be selected without comma-splitting ambiguity.

36. As a CLI operator, I want scalar source identities to be passed as simple
    values, so that common one-key sources remain easy to rerun.

37. As a CLI operator, I want composite source identities to be parsed
    positionally, so that CLI targeting follows the same tuple contract as
    runtime identity encoding.

38. As a CLI operator, I want invalid targeted ids to fail before the run starts,
    so that malformed input does not create partial migration state.

39. As a CLI operator, I want duplicate targeted ids to be deduplicated and
    reported, so that accidental repeated flags do not cause duplicate work.

40. As a framework maintainer, I want this source identity slice to land before
    destination journal tracking, so that later tracking records and rollback
    APIs can rely on stable structured source identity.

41. As an SDK maintainer, I want existing in-repo source implementations and
    examples to compile against the new source identity contract, so that the
    public API is proven by real call sites instead of only new unit tests.

42. As an SDK maintainer, I want existing source plugin tests updated rather
    than bypassed, so that in-memory, CSV, JSON file, document, and SQL source
    behavior stays covered while the identity model changes.

## Implementation Decisions

- Treat Source Identity Contract as a public source-side primitive.

- Model the contract as a versioned compatibility id plus a supported Effect
  Schema identity key shape, SDK-owned canonical encoding, and an SDK-owned
  fingerprint.

- Keep the source identity contract id user-authored. It is the human-readable
  compatibility name and must change when function-based derivation semantics
  change.

- Support scalar identity keys for the common case.

- Support fixed positional tuple identity keys for composite identities.

- Require every tuple part to carry a part name in schema metadata.

- Reject raw structs as canonical source identity keys.

- Reject tuple rest elements, optional tuple elements, unnamed tuple parts, and
  unsupported nested key parts at configuration time.

- Keep source payload schemas separate from source identity key schemas.

- Keep Source Version separate from Source Identity. Source Identity identifies
  the source item. Source Version identifies the observed source revision used
  by unchanged detection.

- Add a Source Version Contract fingerprint to Migration Item State, even
  though source version is not part of source identity.

- Treat Source Version Contract fingerprints as comparability metadata for
  unchanged detection, not as a hard definition-level execution blocker.

- Keep the common source plugin identity envelope as id, schema, and key
  derivation.

- Let each source plugin choose the authoring shape of key derivation.

- Refactor existing in-repo source implementations onto the new source identity
  contract where they already exist: in-memory source, CSV source, JSON file
  source, document source, SQL source, and their public examples or fixtures.

- Treat those refactors as compatibility proof for the public API. They should
  update existing source identity authoring and lookup behavior without
  expanding each source plugin's product scope.

- For declarative source plugins, include source-to-key mapping metadata in the
  source identity contract fingerprint.

- For function-based derivation, fingerprint the schema and explicit contract id
  but not the function body.

- Do not use first-row or sampled-source scans as the primary drift detector.
  Sampling may be a diagnostic later, but stored contract fingerprints are the
  enforcement mechanism.

- Normalize source plugin output into Source Items that carry contract id,
  structured key, encoded key, source payload, and source version.

- Let source plugin reads emit structured identity key values instead of encoded
  identity strings.

- Validate emitted source identity keys against the configured identity schema
  before item state lookup, duplicate detection, or pipeline execution.

- Use one canonical encoder for durable source identity keys across runtime,
  store, CLI, status, and lookup.

- Persist both structured source identity key and encoded source identity in
  Migration Item State.

- Use encoded source identity for durable lookup keys and duplicate detection.

- Pass the structured key through the pipeline-facing Source Item.

- Change targeted source lookup to use a decoded Source Identity Target that
  includes contract id, structured key, and encoded key.

- Implement scan lookup by deriving identities during scan and comparing encoded
  identities.

- Implement direct lookup by giving source plugins the structured identity key.

- Keep page numbers, cursors, and offsets out of source identity unless the
  source system itself treats them as durable identity.

- Parse CLI `--id` values through the selected migration definition's source
  identity schema.

- Keep `--id` repeatable. Do not introduce comma-separated identity lists as the
  primary API.

- Parse scalar identity keys from one CLI value.

- Parse tuple identity keys positionally from one CLI value according to the
  tuple schema.

- Validate CLI-targeted identities before source lookup starts.

- Add Migration Contract persistence for the source identity contract
  fingerprint and current source version contract metadata.

- Persist the source version contract fingerprint with each observed Migration
  Item State that stores a `sourceVersion`.

- Block execution when the stored Migration Contract source identity fingerprint
  differs from the current definition and any Migration Item State exists for
  the migration definition.

- Do not block execution when only source version contract semantics change.
  Instead, treat previously stored source versions as non-comparable when their
  source items are read, and rewrite item state with the current source version
  contract fingerprint.

- Treat all item states as relevant for contract blocking, including failed,
  skipped, migrated, and in-progress records.

- Keep reset, rekey, and state-clearing operations explicit future work for
  source identity contract changes. Source version contract changes rekey
  item-by-item as subsequent runs process source items. A future cursor reset or
  full rescan mode can force every stored item through this path.

- Preserve current source boundary behavior from the existing source validation
  work: identity and version are required before an item can be recorded as an
  item-level failure.

- Keep this source PRD independent from destination journal tracking. Destination
  tracking can depend on the new source identity model, but it should be
  specified and implemented separately.

## Testing Decisions

- Favor tests against public behavior and durable records rather than private
  helper implementation details.

- Test scalar source identity encoding, decoding, validation, and round-trip
  persistence.

- Test tuple source identity encoding, decoding, validation, and round-trip
  persistence.

- Test that tuple part names appear in validation errors, CLI errors, and status
  or diagnostic rendering where those surfaces exist.

- Test that unsupported identity schema shapes fail at source configuration
  time.

- Test that source plugins can emit structured identity key values and the
  runtime attaches contract id and encoded identity.

- Update existing in-memory, CSV, JSON file, document, and SQL source tests to
  exercise the new identity contract at their current public boundaries.

- Keep existing source examples and fixtures compiling against the new
  authoring shape instead of leaving stale branded-string identity examples.

- Test that invalid emitted source identity keys fail before pipeline execution.

- Test that duplicate source items are detected by encoded identity.

- Test that the pipeline receives a structured source identity key.

- Test that Migration Item State persists the structured key and encoded key.

- Test that file-store or durable-store decoding rejects malformed persisted
  source identity records.

- Test that CLI scalar `--id` targeting decodes through the selected migration
  definition's source identity schema.

- Test that CLI tuple `--id` targeting decodes positionally through the selected
  migration definition's source identity schema.

- Test that repeated `--id` flags are accepted and comma-separated lists are not
  treated as the primary identity API.

- Test that malformed CLI ids fail before source lookup and before item state is
  written.

- Test that duplicate targeted ids are deduplicated and surfaced as operator
  feedback.

- Test scan lookup by targeting a composite source identity and verifying that
  the source scans until the encoded identity matches.

- Test direct lookup by passing a decoded composite Source Identity Target to a
  source plugin and verifying that the plugin receives structured key parts.

- Test that cursor positions and page numbers are not required in source
  identity for scan lookup.

- Test that declarative key mapping changes produce a different migration
  contract fingerprint.

- Test that identity schema changes produce a different migration contract
  fingerprint.

- Test that tuple part order changes produce a different migration contract
  fingerprint.

- Test that changing only display labels or diagnostics metadata that is not part
  of the contract does not accidentally block execution, if such metadata exists.

- Test that function-based key derivation requires the user-authored contract id
  to carry semantic versioning, and document that function source is not hashed
  as an enforcement mechanism.

- Test that a stored Migration Contract mismatch blocks execution before source
  reads begin when any item state exists.

- Test that a stored Migration Contract mismatch does not block a brand-new
  migration definition with no item state.

- Reuse the existing in-memory runtime tests as the primary integration surface
  for source item normalization, duplicate detection, and contract blocking.

- Reuse file-store tests for durable encoding, decoding, and persisted record
  compatibility.

- Add focused unit tests around Source Identity schema construction and
  canonical encoding because that module should be a deep, stable module.

## Out of Scope

- Destination journal tracking.

- Destination tracking records.

- Destination rollback execution.

- Migration reference lookup based on destination tracking records.

- Opaque encoded-id CLI copy and paste support.

- Comma-separated `--id` lists.

- A public reset command.

- A public rekey command.

- Automatic migration of old pre-production item state.

- Arbitrary hierarchical source identity keys.

- Struct-shaped canonical source identity keys.

- Hashing JavaScript function bodies for source identity drift detection.

- A custom source identity selector DSL shared by all source plugins.

- Source payload schema redesign.

- Source cursor schema redesign.

- Streaming source reads.

- Adding new production capabilities to CSV, document, SQL, JSON file, or API
  source adapters beyond the compatibility refactor needed to prove the core
  contracts.

## Further Notes

- This PRD implements the source-side foundation from the accepted scoped
  pipeline tracking decision.

- This PRD should be implemented before the destination-side PRD because
  destination tracking records, rollback, lookup, and status output all benefit
  from stable structured source identity.

- The strongest deep module opportunity is Source Identity itself: supported
  schema construction, tuple part metadata extraction, canonical encoding,
  decoding, display formatting, CLI parsing support, and fingerprinting should
  sit behind a small public interface.

- The second deep module opportunity is Migration Contract comparison. It should
  turn current definition metadata and stored contract metadata into a clear
  allow or block decision with inspectable mismatch details.

- The third deep module opportunity is Source Identity Target parsing for CLI
  and runtime item selection. The CLI should delegate parsing and validation to
  the same source identity contract machinery used by the runtime.

- This PRD intentionally keeps plugin-specific derivation APIs open. The shared
  contract is the produced source identity key and its schema, not one universal
  way to select values from every possible source system.

- Existing source implementations are part of the acceptance bar because they
  are the best guardrail against designing a source identity API that only works
  in a synthetic test. The PRD should not, however, absorb the separate document
  source, SQL source, or future adapter roadmaps.
