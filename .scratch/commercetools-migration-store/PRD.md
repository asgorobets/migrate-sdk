# Commercetools Custom Object Migration Store

Status: ready-for-agent

## Problem Statement

Commercetools migration authors can use the SDK's in-memory and file-backed
stores while developing, but teams running real Commercetools migrations may not
want to provision a separate database, Redis instance, or shared filesystem only
to persist migration progress. They need durable source cursors, migration item
state, latest run state, and definition locks in a place that already belongs to
their Commercetools operational boundary.

Commercetools Custom Objects are JSON documents with project-local storage,
direct lookup by `container` and `key`, query predicates over document values,
and optimistic concurrency through versions. That makes them a viable native
backend for `MigrationStore`, but the store must avoid a few sharp edges:
single-document state can grow too large, offset pagination is bounded, locks
must be acquired with true create-if-absent semantics, and state records must be
queryable without making every hot-path item lookup a predicate scan.

## Solution

Add a Commercetools-native `MigrationStore` implementation to the
`@migrate-sdk/commercetools` package. The store uses Custom Objects as durable
state records and is exposed through its own public migration-store package
slice, separate from source and destination plugins.

The default storage model is one Custom Object per logical migration store
record: source cursor, item state, latest run state, and definition lock.
Definition locks use Custom Object `version: 0` writes for create-if-absent
semantics. Direct item and cursor reads use deterministic generated keys.
List, maintenance, and inspection reads use query predicates over a
denormalized scalar index embedded in each record value. Unbounded scans use
keyset pagination sorted by Custom Object key, not offset pagination.

The implementation should depend on the existing Commercetools SDK service
layer so migration authors can choose whether state is stored in the same
Commercetools project as the destination or in a separate state project.

## User Stories

1. As a Commercetools migration author, I want to persist migration state in Commercetools Custom Objects, so that I do not need to provision a separate state database.

2. As a Commercetools migration author, I want the store to work with destination-only migrations, so that I can use it before any Commercetools source plugin exists.

3. As a Commercetools migration author, I want the store to be independent from the destination plugin, so that source, destination, and store concerns remain composable.

4. As a Commercetools migration author, I want to configure the store with a container and namespace, so that multiple migration projects can share one Commercetools project without key collisions.

5. As a Commercetools migration author, I want sensible default store options, so that the simplest setup requires minimal configuration.

6. As a Commercetools migration author, I want to provide a separate Commercetools SDK layer for state, so that I can store migration state outside the destination project when migrating between projects.

7. As a Commercetools migration author, I want a convenience constructor that builds the store from an API root and project key, so that simple projects do not need extra layer plumbing.

8. As a Commercetools migration author, I want source cursors to be persisted durably, so that interrupted runs can resume source discovery.

9. As a Commercetools migration author, I want migration item state to be persisted durably, so that migrated, skipped, failed, and needs-update items survive process restarts.

10. As a Commercetools migration author, I want latest run state to be persisted durably, so that operators can inspect whether a definition is running, succeeded, or failed.

11. As a Commercetools migration author, I want definition locks to be persisted durably, so that two runners cannot execute the same migration definition at the same time.

12. As a Commercetools migration author, I want abandoned locks not to expire automatically, so that a stalled runner and a new runner cannot both write state and destination side effects.

13. As a Commercetools migration operator, I want lock records to include owner run id, token, definition id, and acquisition time, so that I can diagnose lock ownership.

14. As a Commercetools migration operator, I want lock release to verify the ownership token, so that one runner cannot release another runner's lock accidentally.

15. As a Commercetools migration operator, I want a failed lock acquisition to be reported as a store-level failure, so that concurrent execution is visible and safe.

16. As a Commercetools migration operator, I want direct item lookups to use generated Custom Object keys, so that normal item processing does not depend on query predicate performance.

17. As a Commercetools migration operator, I want item-state listing to use query predicates, so that rollback, reference lookup, cleanup, and inspection can select records by definition.

18. As a Commercetools migration operator, I want failed item states to be queryable by status, so that maintenance tooling can inspect only failed work.

19. As a Commercetools migration operator, I want item states touched by a run to be queryable by run id, so that I can inspect what a specific run changed.

20. As a Commercetools migration operator, I want lock records to be queryable, so that future state inspection and force-unlock tooling can list existing locks.

21. As a Commercetools migration operator, I want scans to use keyset pagination, so that large state sets are not capped by the platform's offset limit.

22. As a Commercetools migration operator, I want scan pages to use the maximum safe page size, so that large listings minimize API round trips.

23. As a Commercetools migration operator, I want scans to avoid total-count computation, so that large state listings do not pay unnecessary count cost.

24. As a Commercetools migration operator, I want state records to be small, so that migrations avoid large Custom Object document performance problems.

25. As a Commercetools migration operator, I want the store to avoid one giant state object by default, so that item writes do not rewrite the entire migration state.

26. As a Commercetools migration operator, I want a future single-object mode to remain possible for tiny projects, so that simple debugging workflows are not ruled out permanently.

27. As a Commercetools migration operator, I want state records to avoid storing source payload snapshots, so that Custom Objects do not become a sensitive data dump.

28. As a Commercetools migration operator, I want readable metadata inside record values, so that hashed keys can still be diagnosed through the stored JSON document.

29. As a Commercetools migration operator, I want generated keys to use a readable delimiter, so that Custom Objects are easier to inspect manually.

30. As a Commercetools migration operator, I want generated keys to tolerate namespaces containing dots or hyphens, so that project naming conventions do not break store layout.

31. As a Commercetools migration operator, I want long or unsafe definition ids and source identities to be hashed into bounded key segments, so that Custom Object key constraints are respected.

32. As a Commercetools migration operator, I want hash collisions to be detected by decoded record metadata, so that a rare key collision cannot silently return the wrong item state.

33. As a Commercetools migration operator, I want store records to include a format version, so that future record migrations can be handled deliberately.

34. As a Commercetools migration operator, I want unknown future record versions to fail clearly, so that old clients do not corrupt newer state.

35. As a Commercetools migration operator, I want state records to avoid relying on explicit nulls, so that Commercetools Custom Object value persistence does not change record semantics.

36. As a Commercetools migration operator, I want store errors to be normalized into migration store failures, so that the runner stops safely when durable progress cannot be written.

37. As a migration SDK maintainer, I want the store to implement the existing `MigrationStore` boundary, so that the runner does not need Commercetools-specific behavior.

38. As a migration SDK maintainer, I want Custom Object SDK calls hidden behind a small internal client, so that query, pagination, versioning, and error mapping are tested in one place.

39. As a migration SDK maintainer, I want key generation hidden behind a small internal module, so that key stability and hashing can be tested independently.

40. As a migration SDK maintainer, I want record schemas hidden behind a small internal module, so that persistence format changes are deliberate and testable.

41. As a migration SDK maintainer, I want predicate building centralized, so that user-provided values are escaped or bound safely in one place.

42. As a migration SDK maintainer, I want the internal scan helper to return a stream or callback-style sequence, so that public array-returning APIs can collect today and future maintenance APIs can stream later.

43. As a migration SDK maintainer, I want the store to reuse the existing Commercetools SDK service layer, so that source, destination, and store all share the same Effect service composition model.

44. As a migration SDK maintainer, I want tests to use a fake Commercetools SDK layer, so that concurrency and request-shape behavior can be specified without live credentials.

45. As a future CLI author, I want this store's record layout to support state inspection and force-unlock commands, so that operational tooling can be built without changing the persistence model.

46. As a future source plugin author, I want the store package slice not to assume destination-only workflows, so that Commercetools source-to-destination migrations can reuse it.

47. As a future execution adapter author, I want state records to be individually addressable, so that queued or partitioned runtimes can evolve without rewriting one shared state blob.

## Implementation Decisions

- Add a dedicated migration-store public package slice to the Commercetools package.

- Keep the migration-store package slice separate from source and destination plugin exports.

- Expose a `CommercetoolsMigrationStore` public API with a layer constructor that depends on the Commercetools SDK service.

- Expose an optional convenience constructor that creates the required SDK layer from an API root and project key.

- Keep the first public options shape limited to container, namespace, and page size.

- Default the container to a migration-sdk-specific value.

- Default the namespace to a stable default value when the user does not provide one.

- Default page size to the Commercetools maximum for Custom Object query pages.

- Validate container and namespace before constructing the store layer.

- Use one Custom Object per logical migration store record by default.

- Do not use a single whole-state Custom Object as the default storage model.

- Use generated Custom Object keys with the `__` delimiter.

- Keep generated keys opaque. Do not parse generated keys as the source of truth.

- Put canonical readable metadata inside the Custom Object value.

- Hash or encode dynamic key parts into safe bounded key segments.

- Prefix hashed key segments by role, such as definition hash and source identity hash.

- Verify decoded record metadata after direct key lookup to guard against accidental hash collision or corrupt records.

- Store records as schema-backed envelopes with format version, namespace, record kind, optional scalar index, and state.

- Include record kinds for manifest, source cursor, latest run state, migration item state, and definition lock.

- Duplicate queryable fields into a denormalized scalar index object.

- Keep index values scalar and stable: strings, numbers, booleans, and date strings.

- Treat the state object as canonical and the index object as query support.

- Avoid persisted record semantics that depend on explicit null values.

- Implement definition locks as one Custom Object per locked definition.

- Acquire definition locks with a Custom Object create-if-absent write using version zero.

- Map concurrent modification during lock creation to an already-locked store failure.

- Release definition locks by reading the current lock, verifying owner run id and token, and deleting by current version.

- Keep durable locks without automatic expiration in the first implementation.

- Do not introduce force-unlock as part of the first implementation, but preserve enough record metadata to support it later.

- Use deterministic generated keys for direct source cursor lookup.

- Use deterministic generated keys for direct item-state lookup.

- Use deterministic generated keys for direct definition lock acquisition.

- Use query predicates for set-oriented reads such as item-state listing, failed-state inspection, run inspection, and lock listing.

- Use keyset pagination for unbounded Custom Object scans.

- Sort scans by Custom Object key.

- Use the last key from a page as the next page cursor.

- Avoid offset pagination for unbounded scans.

- Disable total counts for internal scans unless a future user-facing API specifically needs totals.

- Collect internal scans into arrays only where the current core `MigrationStore` API requires arrays.

- Keep the internal scan implementation stream-oriented or callback-oriented so future APIs can expose streaming without rewriting pagination.

- Implement source cursor, item state, run state, and lock records using the existing core domain schemas where possible.

- Normalize SDK failures into `MigrationStoreError`.

- Treat missing Custom Objects as null for read operations where the core store contract expects null.

- Treat missing records as successful no-ops only where the current core store behavior already allows that.

- Keep ordinary cursor, item, and run-state writes as upserts because the runner owns definition locks before writing destination-side progress.

- Hide Custom Object request construction behind an internal client module.

- Hide predicate escaping or variable binding behind an internal query builder module.

- Hide key generation and hashing behind an internal key module.

- Hide persisted record codecs behind an internal record module.

- Keep only the migration store public API and option types exportable.

- Keep internal Custom Object client, key, query, error, and record helpers unexported from the public package surface.

- Defer any change to the core `MigrationStore` API shape until large-state evidence requires paged item-state listing.

- Record the design in package-local docs before implementation.

## Testing Decisions

- Use TDD for the first implementation slice.

- Favor tests against externally visible store behavior: returned values, persisted record envelopes, SDK request shapes, lock behavior, pagination behavior, and error mapping.

- Do not write tests that assert private helper call order unless that order is part of the observable SDK request sequence.

- Test the store through the public `MigrationStore` service boundary wherever practical.

- Test the internal Custom Object client as a deep module for SDK request construction, pagination, missing-object handling, and error mapping.

- Test the key-generation module as a deep module for delimiter choice, stable output, bounded unsafe input handling, namespace handling, and collision metadata checks.

- Test the record schema module as a deep module for all persisted record variants.

- Test the query builder module as a deep module for predicate construction and user-provided value escaping or binding.

- Use a fake Commercetools SDK service layer for unit tests.

- Add a lock acquisition test proving the store posts a definition-lock Custom Object with version zero.

- Add a concurrent lock acquisition test proving concurrent modification maps to an already-locked store failure.

- Add a lock release test proving the store verifies owner run id and token before deleting.

- Add a wrong-token release test proving the store refuses to delete another runner's lock.

- Add a source cursor round-trip test.

- Add migration item state round-trip tests for migrated, skipped, failed, and needs-update states.

- Add latest run-state round-trip tests for running, succeeded, and failed run states.

- Add a direct item lookup test proving the store uses deterministic key lookup rather than a predicate query.

- Add a delete item-state test proving the store deletes by current Custom Object version.

- Add an item-state listing test proving the store filters by namespace and definition id.

- Add failed item-state listing coverage if the first public API exposes it; otherwise cover the internal scan query shape.

- Add keyset pagination tests proving the next page uses the last key from the previous page.

- Add pagination tests proving scans continue beyond one page without using offset.

- Add a test proving `withTotal` is disabled for scans.

- Add a test proving unknown future record versions fail decoding clearly.

- Add a test proving records do not rely on explicit null values for required semantics.

- Add a test proving long and unsafe definition ids and source identities produce valid bounded keys.

- Add a test proving decoded metadata is checked after hashed direct lookup.

- Reuse existing file-store tests as prior art for durable record round trips and lock ownership behavior.

- Reuse existing in-memory store tests as prior art for the `MigrationStore` service contract.

- Do not require live Commercetools credentials for the default test suite.

- Keep live Commercetools integration tests out of the first required test run unless the repo later adds an explicit credentials-gated integration test convention.

## Out of Scope

- Building a Commercetools source plugin.

- Changing destination command behavior.

- Adding a CLI command for state inspection.

- Adding a CLI command for force-unlock.

- Adding a CLI command for state export or cleanup.

- Adding a public streaming maintenance API.

- Changing the core `MigrationStore` API to support paged item-state listing.

- Implementing item-level claims or partitioned execution.

- Implementing a single-object state mode.

- Migrating records between store format versions.

- Encrypting Custom Object state.

- Persisting source payload snapshots.

- Guaranteeing a transaction across multiple Custom Object writes.

- Supporting non-Commercetools state backends in this package slice.

- Replacing the existing file or in-memory stores.

- Running live Commercetools integration tests by default.

## Further Notes

- Custom Objects are a good fit for Commercetools-first migration teams because the state lives in the same platform boundary as the migrated data.

- Direct lookups and predicate scans should not be treated as interchangeable. Hot item processing should use direct key lookup. Predicate scans should support listing, inspection, rollback, cleanup, and future maintenance workflows.

- Keyset pagination is central to the design. Offset pagination has a platform ceiling and should not be used for unbounded state traversal.

- The denormalized index object is intentionally a store concern. It exists to make Custom Object predicates stable and simple without making every query depend on nested durable state details.

- The current core runtime expects selected and dependency-expanded migration definitions in a run to use the same store layer instance. The Commercetools store should preserve that assumption.

- The first implementation should be small but real: public package slice, store layer, record schemas, key generation, Custom Object client, lock behavior, cursor state, item state, run state, and keyset listing.

- Future maintenance tooling should build on the same record layout rather than introducing a separate state representation.
