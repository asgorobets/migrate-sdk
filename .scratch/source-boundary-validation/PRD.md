# Source Boundary Validation and Durable Error Details

Status: ready-for-human

## Problem Statement

The migration runtime now has durable stores, locks, cursors, item state, and multi-definition execution, but the source boundary is still too loose for a schema-first migration SDK. Source payload schemas are exposed in the public API but are not yet enforced by the runner, source versions are optional in the data model, and persisted item errors can depend on raw causes that are not suitable for later inspection.

This creates three problems for migration authors and operators:

- A source plugin can emit payloads that do not match the declared source payload schema, and the pipeline can still receive them.
- A source item can be treated as unchanged without a meaningful source version.
- A future inspection API may not be able to explain a previous schema failure unless the migration is rerun and logs are captured.

## Solution

Tighten the source boundary and persisted item error model.

Every source plugin must expose a Source Payload Schema at runtime. Every Source Item must carry a non-empty Source Identity and a non-empty Source Version. The runner validates source payloads before unchanged detection, pipeline execution, and destination execution. Invalid source payloads become durable item failures with source error details, not run-level source read failures.

Persisted Migration Item Errors should store stable inspection data: kind, error tag, message, and optional structured details. Raw live causes remain useful for immediate runtime diagnostics, but they must not be persisted in Migration Item State.

## User Stories

1. As a migration definition author, I want every source plugin to expose a Source Payload Schema, so that source data is validated before it reaches my transformation pipeline.

2. As a migration definition author, I want the pipeline to receive schema-decoded source payloads, so that the runtime value matches the type I authored against.

3. As a source plugin author, I want the framework to validate payloads in the runner, so that item-level validation failures are recorded consistently across all source plugins.

4. As a source plugin author, I want source payload schema derivation to be a plugin adapter concern, so that Drizzle, OpenAPI, HTTP, CSV, and hand-written plugins can obtain schemas differently while producing the same configured source contract.

5. As a source plugin author, I want to provide or derive an Effect Schema before creating a configured source plugin, so that the core SDK does not need to understand every schema ecosystem.

6. As a migration operator, I want a source item with invalid payload to become a failed Migration Item State, so that unrelated source items can continue processing.

7. As a migration operator, I want invalid source payload failures to include durable schema details, so that I can inspect previous failures without rerunning the migration.

8. As a migration operator, I want run summaries to remain aggregate counts, so that summaries do not become large error dumps.

9. As a migration operator, I want failed schema validation items to count as failed items, so that the run status accurately reflects source data problems.

10. As a migration operator, I want failed source validation items to be retried under existing failed-item semantics, so that fixed source data can be processed on a later run.

11. As a migration operator, I want payload validation to happen before unchanged detection, so that invalid payloads are not hidden by matching source versions.

12. As a migration operator, I want validation to apply to cursor-discovered items and targeted source identity lookups, so that normal runs and targeted reruns follow the same source contract.

13. As a migration framework developer, I want Source Version to be required and non-empty, so that unchanged detection is always based on an explicit source revision.

14. As a migration framework developer, I want Migration Item State to require Source Version, so that durable state cannot represent invalid versionless progress.

15. As a migration framework developer, I want Destination Identity and Destination Version to be non-empty when present, so that destination progress records cannot contain meaningless identifiers.

16. As a migration framework developer, I want Migration Run Id and Migration Definition Lock Token to be non-empty domain primitives, so that durable run and lock records cannot contain invalid ownership data.

17. As a migration framework developer, I want lock tokens to be branded domain values, so that lock ownership cannot be confused with arbitrary strings.

18. As a migration framework developer, I want Migration Item Error Detail to be a generic field across source, pipeline, and destination item errors, so that future inspection APIs use one durable shape.

19. As a migration framework developer, I want generic pipeline and destination failures to store stable error summaries without raw causes, so that persisted item state remains durable and inspectable.

20. As a migration framework developer, I want schema validation failures to use a dedicated item error constructor, so that schema issues are normalized into stable details.

21. As a migration framework developer, I want schema error detail lists to be bounded, so that large payloads or union failures cannot produce massive persisted item state records.

22. As a migration framework developer, I want old file-store records without source versions to fail decoding, so that invalid pre-release durable state is not silently accepted.

23. As a migration framework developer, I want the design document to match the new source boundary contract, so that future reviews do not rediscover stale API sketches.

24. As a future adapter author, I want the core SDK to require Effect Schema but let adapters accept source-native schemas, so that adapters can support Drizzle, OpenAPI, or other schema systems without weakening the core runtime contract.

## Implementation Decisions

- Treat this as a source-boundary tightening slice, not only a payload validation slice.

- Require every configured source plugin to expose a Source Payload Schema.

- Place the Source Payload Schema on the runtime Source Plugin service, alongside the Source Cursor Schema, so the runner reads the schema from the same source service it executes.

- Keep the public authoring wrapper responsible for binding the source implementation, Source Payload Schema, and Source Cursor Schema together.

- Keep the core SDK contract Effect Schema based. Do not accept arbitrary Standard Schema inputs in core.

- Allow adapter packages to accept source-native or portable schema inputs, but require them to normalize to Effect Schema before producing a configured source plugin.

- Do not provide a core helper for deriving source versions from schema-encoded payloads in this slice. Source version derivation remains source-plugin owned.

- Require Source Version on every Source Item.

- Make Source Version a non-empty domain primitive.

- Make Migration Item State require Source Version.

- Make Destination Identity, Destination Version, and Migration Run Id non-empty domain primitives.

- Introduce a branded non-empty Migration Definition Lock Token and use it in lock records.

- Defer any decision about whether Encoded Source Cursor must be non-empty until real plugins exist.

- Validate source payloads inside the runner after Source Plugin reads return Source Items.

- Validate source payloads before unchanged-terminal short-circuiting.

- Validate source payloads for both cursor-discovered items and targeted source identity lookup items.

- Pass schema-decoded source payloads into the Transformation Pipeline.

- Preserve the original Source Identity and Source Version when rebuilding a Source Item with decoded payload.

- Treat a source read failure before items are emitted as a run-level source plugin failure.

- Treat an invalid source item envelope that lacks valid identity or version as a source boundary failure that cannot safely be recorded as item state.

- Treat an invalid source payload with valid identity and version as an item failure.

- Record source payload validation failures with `kind` equal to source and a stable source payload schema error tag.

- Store Source Version on failed item state for source payload validation failures.

- Keep existing failed item retry semantics for source payload validation failures.

- Keep Migration Run Summary aggregate-only. Do not add error detail lists to run summaries in this slice.

- Add a generic durable Migration Item Error Detail model with optional string path and required message.

- Add optional error details to the generic Migration Item Error model for all item error kinds.

- Use string paths for error details because the field is intended for human and agent inspection, not machine patching.

- Keep detail path optional because some failures do not honestly map to a field path.

- Bound persisted validation details with internal constants. Include a durable truncation detail when issues are omitted.

- Do not persist raw live causes in Migration Item Error records.

- Keep live causes available only in the original caught error path. Do not add logging in this slice.

- Update generic item error normalization so pipeline, source lookup, and destination item failures no longer persist raw causes.

- Add a dedicated constructor for source payload schema validation failures that maps schema issues into durable details.

- Fail decoding old durable file-store item state records that are missing Source Version. No migration path is required because the library is not used yet.

- Update the design document in place to match the new contracts for source schemas, source versions, item errors, domain primitives, and lock tokens.

## Testing Decisions

- Favor tests against externally visible runtime behavior: run summaries, item states, destination calls, cursor advancement, targeted reruns, and file-store decode behavior.

- Add source payload validation tests through the main migration runner rather than testing runner internals.

- Test that a cursor-discovered source item with invalid payload records failed item state, increments failed counts, skips pipeline execution, skips destination execution, and continues processing other items.

- Test that a targeted source identity lookup item with invalid payload follows the same item failure behavior.

- Test that payload validation happens before unchanged detection by using an item with previously terminal state, same source version, and now-invalid payload.

- Test that the pipeline receives the decoded payload, not the raw emitted payload.

- Test that schema validation failure details are persisted in item state with stable message, stable error tag, optional string paths, and bounded detail output.

- Test that generic pipeline and destination item errors persist without raw cause.

- Test that Source Version is required on Source Items and Migration Item State.

- Test that empty Source Version, Destination Identity, Destination Version, Migration Run Id, and lock token are rejected by their domain schemas or constructors.

- Test that file-store decoding fails for old item state records missing Source Version.

- Reuse existing in-memory runtime tests as the primary integration surface.

- Reuse file-store tests for persisted record compatibility and durable item-state encoding.

- Keep tests focused on behavior and durable record shape. Do not assert private helper implementation details.

## Out of Scope

- Building the future inspection API.

- Adding CLI rendering for item error details.

- Adding runtime logging or observability behavior.

- Supporting generic Standard Schema as a core SDK input.

- Implementing Drizzle, OpenAPI, HTTP, CSV, SQL, or other real source adapters.

- Providing a core helper for hashing or deriving Source Version.

- Deciding whether Encoded Source Cursor must be non-empty.

- Migrating old file-store records.

- Adding public configuration for validation detail size limits.

- Changing run summary shape beyond existing aggregate counts.

## Further Notes

- This PRD depends on the current glossary decisions in `CONTEXT.md`, especially Source Payload Schema, Source Version, Migration Item Error Detail, and durable item error records not persisting raw causes.

- This slice intentionally keeps the core SDK opinionated around Effect Schema while leaving room for future adapter packages to accept and normalize other schema ecosystems.

- The main deep module opportunity is schema validation error normalization: converting Effect schema failures into bounded durable Migration Item Error Details should be isolated and tested independently enough that the runner can stay readable.

- The second deep module opportunity is source item validation at the runner boundary: the public behavior should stay simple even though it applies across cursor discovery, targeted lookup, unchanged detection, pipeline execution, and item-state persistence.
