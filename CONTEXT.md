# Migration Framework

A framework for moving data or content between systems while preserving typed transformation logic and durable migration progress.

## Language

**Source Item**:
One unit emitted by a source plugin for migration.

**Source Identity**:
The stable identity of a source item within a migration definition.

**Source Version**:
The observed version or fingerprint of a source item at read time.

**Source Cursor**:
A source plugin position marker for selecting source items during incremental reads.

**Encoded Source Cursor**:
The durable string form of a source cursor after schema encoding.

**Source Cursor Window**:
One batch of source items read from a source cursor.

**Source Inventory Scan**:
A read-only traversal of a migration definition's current source items for inspection.

**Source Lookup Strategy**:
The source plugin's declared cost model for reading a source item by identity.

**Migration Item State**:
Durable state for one source item within a migration.

**Rollbackable Migration Item State**:
A migration item state that records a destination identity and can be passed to a rollback pipeline.

**Migration Item Outcome**:
The result of processing one source item during a migration run.

**Source Plugin**:
A plugin that emits source items from a source system.

**Destination Plugin**:
A plugin that executes destination commands against a destination system.

**Migration Store**:
The pluggable durable backend for a migration definition.

**Migration Definition**:
The configured workflow that connects a source plugin, transformation pipeline, destination plugin, and migration store.

**Migration Definition Dependency**:
An ordering relationship declared by a migration definition.

**Required Migration Definition Dependency**:
A migration definition dependency that must run before the dependent migration definition.

**Optional Migration Definition Dependency**:
A migration definition dependency that orders another migration definition first when both definitions participate in the same run.

**Migration Definition Registry**:
A catalog of executable migration definitions available to an SDK or CLI host.

**Migration Definition Lock**:
A durable ownership record that prevents multiple runners from executing the same migration definition concurrently.

**Migration Spec**:
A serializable description of a migration workflow that can be compiled into a migration definition.

**Plugin Registry**:
A future catalog of plugin factories for compiling migration specs into migration definitions.

**Migration Run**:
One execution attempt of one or more migration definitions.

**Migration Run State**:
The durable state for one migration run.

**Migration Run Summary**:
The structured result returned after a migration run completes or fails.

**Migration Status Report**:
The structured inspection result for one or more migration definitions.

**Rollback Run Summary**:
The structured result returned after a rollback run completes or fails.

**Execution Start Result**:
The result of starting execution, either a completed summary or a run id for later observation.

**Run Mode**:
The runtime mode that controls which migration item states are reprocessed.

**Run Request**:
The invocation object that starts a migration run from the SDK, CLI, or another host.

**Rollback Request**:
The invocation object that starts a rollback run from the SDK, CLI, or another host.

**Execution Adapter**:
The runtime strategy that executes migration definitions.

**Migration Reference Lookup**:
A pipeline capability for reading migrated destination identities from migration item states.

**Transformation Pipeline**:
The typed transformation from one source item into destination commands.

**Rollback Pipeline**:
The typed compensation from a durable migration item state into destination commands that undo destination-side effects.

**Destination Command**:
The typed command produced by a transformation pipeline and executed by a destination plugin.

**Destination Command Definition**:
A destination-owned definition that validates a destination command kind and classifies whether it is identity-bearing or side-effect-only. Normal migration pipelines should use destination-owned command factories rather than constructing command definition records directly.

**Destination Command Group**:
A destination-owned namespace of destination command definitions. Grouped command factories are exposed under `commands.<group>` unless the group is marked top-level, in which case its factories are exposed directly under `commands`.

**Destination Plugin Definition**:
A destination-owned set of uniquely named destination command groups and command definitions. Simple plugin definitions may add commands directly as root-level sugar, but plugin definitions must be non-empty before they compile to the runtime destination plugin service.

**Destination Command Schema**:
A no-service Effect schema for a destination command. It validates pipeline-facing command values and must have the same encoded and decoded TypeScript shape.

**Destination Entry Field Schema**:
A destination-owned Effect schema for pipeline-facing entry fields. It validates already-decoded values and must have the same encoded and decoded TypeScript shape.

**Destination Command Plan**:
An ordered set of destination commands produced for one source item.

**Rollback Command Plan**:
An ordered set of destination commands produced by a rollback pipeline for one migration item state.

**Destination Command Result**:
The result of executing a destination command.

**Destination Identity**:
The stable identity of a destination item created or updated by a destination plugin.

**Destination Version**:
The observed destination-side version or revision returned by a destination plugin.

**Destination Stub**:
A placeholder destination item created to reserve a destination identity before the full destination item can be written.

**Needs Update**:
A migration item state status indicating that destination identity exists but the destination item is incomplete.

**Destination Retry Strategy**:
The Effect retry wrapper selected by a migration definition for destination command execution.

**Source Cursor Retry Strategy**:
The Effect retry wrapper selected by a migration definition for source cursor reads.

**Source Lookup Retry Strategy**:
The Effect retry wrapper selected by a migration definition for source identity lookups.

**Source Payload Schema**:
The Effect schema used by a source plugin to validate, decode, and infer source item payloads from source-native values into pipeline-facing values.

**Source Cursor Schema**:
The Effect codec used by a source plugin to validate, encode, and decode source cursors.

**Skip Item**:
A typed pipeline error that records a source item as skipped without calling the destination plugin.

**Migration Item Error**:
A normalized error record stored for a failed migration item state.

**Migration Item Error Detail**:
Durable structured detail for inspecting a migration item error after the run has ended.

**Migration Diagnostic**:
A schema-backed warning or error record that explains migration status, item failure, run failure, or another operational condition.

## Relationships

- A **Source Item** has exactly one **Migration Item State** for a given migration definition.
- A **Source Item** must have a **Source Identity**.
- A **Source Item** must have a **Source Version** supplied by a source field, source metadata, or a hash of the item contents.
- A **Source Cursor** selects which source items to inspect during a migration run.
- A **Source Cursor** shape is owned by the **Source Plugin** and must be described by a **Source Cursor Schema**.
- An **Encoded Source Cursor** is the only cursor form persisted by a **Migration Store**.
- A **Source Cursor Window** may return a next **Source Cursor**.
- A **Source Cursor** is committed after a cursor window is processed, even when some source items in the window fail.
- A **Source Inventory Scan** starts from the beginning of the source and does not read or write the persisted **Source Cursor**.
- A **Source Inventory Scan** validates source item payloads with the **Source Payload Schema**.
- A **Source Inventory Scan** may return **Migration Diagnostics** for invalid source payloads or duplicate **Source Identities**.
- A **Migration Item State** records source identity, migration status, and may record observed source version, destination identity, or failure metadata.
- A **Migration Item State** is modeled as discriminated variants by status.
- A **Migration Item State** does not store source item payloads by default.
- Public and persisted migration data uses domain-friendly discriminators such as `kind` and `status`; Effect `_tag` is reserved for Effect-native errors or internals and hidden from public authoring examples through helpers.
- A **Migration Item Error** normalizes source, pipeline, destination, or store errors for durable storage.
- A **Migration Item Error** may include **Migration Item Error Details** so future inspection can explain failures without rerunning the migration.
- A **Migration Diagnostic** is serializable.
- A **Migration Diagnostic** may be returned in an inspection report or persisted by a context-specific durable record.
- Durable **Migration Diagnostics** do not persist raw Effect causes or raw thrown objects.
- Live error causes are useful for logging, but durable **Migration Item Error** records do not persist raw causes.
- A **Migration Store** error fails the migration run instead of becoming a migration item failure.
- A **Source Plugin** cursor read error fails the migration definition run.
- A **Source Plugin** identity lookup error can become a migration item failure when the source identity is already known.
- A **Migration Item Outcome** may be unchanged even though unchanged is not persisted as a **Migration Item State** status.
- A **Source Plugin** emits **Source Items**; it does not own **Migration Item State**.
- A **Source Plugin** reads source items by cursor and by source identity.
- A **Source Plugin** must expose a **Source Payload Schema**.
- A **Source Payload Schema** may decode source-native raw values, such as CSV strings, into the pipeline-facing TypeScript values the transformation pipeline receives.
- A **Source Payload Schema** may be supplied directly by a user or derived by a source plugin from a source-native schema.
- A **Migration Run** decodes each source item payload with the **Source Payload Schema** before unchanged-terminal checks, transformation pipeline execution, and destination command execution.
- A source item with a valid identity and version but invalid payload becomes a failed **Migration Item State** with durable **Migration Item Error Details**.
- A **Source Lookup Strategy** may be direct or scan-based.
- A **Migration Definition** may select separate **Source Cursor Retry Strategy** and **Source Lookup Retry Strategy** wrappers.
- A **Migration Store** records **Migration Item State**, the latest **Migration Run State**, and the last successful **Source Cursor** for each **Migration Definition**.
- A **Migration Store** may be backed by SQL, key/value storage, files, or another durable system.
- A **Migration Definition** uses one public **Migration Store** service.
- A **Destination Plugin** executes **Destination Commands** and returns **Destination Command Results**.
- A **Destination Plugin** exposes or uses a **Destination Command Schema**.
- A **Migration Definition** declares the source, pipeline, destination, migration store, and dependencies for a migration workflow.
- A **Migration Definition** is executable and may contain layers and effects.
- A **Required Migration Definition Dependency** is a hard ordering prerequisite.
- An **Optional Migration Definition Dependency** is an ordering preference when both **Migration Definitions** participate in a run.
- A **Migration Reference Lookup** relationship is not a **Migration Definition Dependency** unless the migration definition also declares it as one.
- A **Migration Definition Registry** catalogs executable **Migration Definitions**.
- A **Migration Definition Registry** is distinct from a **Plugin Registry** and does not compile **Migration Specs**.
- A **Migration Definition Registry** may be authored directly or initialized from previously compiled **Migration Definitions**.
- A **Migration Status Report** inspects selected **Migration Definitions** without acquiring **Migration Definition Locks** or creating **Migration Run State**.
- A **Migration Status Report** may include current durable item-state counts, latest **Migration Run State** lifecycle metadata, and **Source Inventory Scan** counts.
- A **Migration Status Report** over multiple **Migration Definitions** may read each definition's own **Migration Store** independently.
- A **Migration Definition Lock** is acquired through the **Migration Store** before a migration definition is executed.
- A **Migration Definition Lock** prevents concurrent runners from executing the same **Migration Definition** in the first version.
- A **Migration Definition Lock** does not expire automatically in durable stores; abandoned locks require an explicit force-unlock workflow.
- A **Migration Run** that includes multiple **Migration Definitions** acquires the full set of definition locks before executing any definition.
- A **Migration Run** that includes multiple **Migration Definitions** requires every selected or dependency-expanded definition to use the same **Migration Store** layer.
- Overlapping **Migration Runs** are rejected when any requested **Migration Definition** is already locked.
- A **Migration Spec** is serializable and cannot contain arbitrary effects directly.
- A **Migration Spec** can be compiled through a plugin registry into a **Migration Definition**.
- A **Plugin Registry** supports future DSL or low-code workflows and is not required for the first code path.
- A **Migration Run** executes one or more **Migration Definitions**.
- A **Migration Run** orders multiple **Migration Definitions** by their declared **Migration Definition Dependencies**.
- A **Migration Run** executes ordered **Migration Definitions** sequentially in the first version.
- A **Migration Run** continues processing source items after an item failure in the first version.
- A **Migration Run** is marked failed when one or more source items fail, even if other items complete.
- A completed **Migration Run** produces a **Migration Run Summary** for SDK callers and CLI rendering.
- A completed rollback run produces a **Rollback Run Summary** for SDK callers and CLI rendering.
- A **Rollback Run Summary** is distinct from a **Migration Run Summary**.
- An **Execution Adapter** may return an **Execution Start Result** before the migration run is complete.
- A **Migration Run** treats migrated and skipped item states as terminal for a given source version.
- A **Migration Run** retries failed item states on rerun.
- A **Migration Run** requires an explicit run mode to reprocess unchanged skipped items when skip logic changes.
- A **Run Mode** can select normal processing, failed items, skipped items, or one item by source identity.
- A normal **Run Mode** processes failed and needs-update backlog before source cursor discovery.
- A failed **Run Mode** reprocesses only failed item states.
- A skipped **Run Mode** reprocesses skipped item states regardless of source version.
- A **Run Request** supplies migration definitions, run mode, and optional migration definition selection.
- A **Rollback Request** supplies migration definitions, rollback selection, and optional source identity selection.
- A **Run Request** that selects migration definitions also includes their **Required Migration Definition Dependencies**.
- An **Execution Adapter** may execute migration definitions inline, inline with bounded parallelism, or through a durable queue.
- An **Execution Adapter** may be provided by users when they need custom scheduling or parallelization.
- A **Migration Reference Lookup** reads migrated destination identities from **Migration Item State** in a **Migration Store**.
- A **Migration Reference Lookup** reads and writes referenced **Migration Item State** through the referenced **Migration Definition's Migration Store**.
- A **Migration Reference Lookup** may target a **Migration Definition** that is not a declared dependency.
- A **Migration Reference Lookup** may target one **Migration Definition** or an ordered list of **Migration Definitions**.
- A **Migration Reference Lookup** over multiple **Migration Definitions** returns the first migrated reference found in lookup order.
- A declared **Migration Definition Dependency** gives same-run ordering and locking guarantees for reference lookup, but is not required to perform a reference lookup.
- A missing migrated reference may be handled as no value or as an item-level pipeline failure by the **Transformation Pipeline**.
- A missing migrated reference may create a **Destination Stub** when the **Migration Reference Lookup** is configured to allow stubs.
- A referenced **Migration Definition** owns how its **Destination Stubs** are created.
- A referenced **Migration Definition** creates **Destination Stubs** from a **Source Identity**, not from the full referenced **Source Item** payload.
- A referenced **Migration Definition** creates **Destination Stubs** by producing a **Destination Command Plan**.
- A **Migration Reference Lookup** over multiple **Migration Definitions** must select one referenced **Migration Definition** to create a **Destination Stub** when no migrated reference is found.
- A **Migration Reference Lookup** that creates a **Destination Stub** records **Needs Update** item state for the stubbed reference.
- A **Needs Update** item state created by **Migration Reference Lookup** may not have an observed source version yet.
- A **Migration Reference Lookup** may return a **Needs Update** item state as a usable reference because the **Destination Identity** already exists.
- A **Transformation Pipeline** transforms exactly one **Source Item** into one **Destination Command Plan**.
- A **Rollback Pipeline** transforms exactly one **Rollbackable Migration Item State** into one **Rollback Command Plan**.
- A **Rollback Pipeline** is explicit compensation, not an inferred inverse of a **Transformation Pipeline** or **Destination Command Plan**.
- A **Rollback Pipeline** uses durable **Migration Item State** and does not require reading the **Source Item**.
- A **Rollbackable Migration Item State** is any **Migration Item State** that records a **Destination Identity**.
- A **Rollback Command Plan** uses the same **Destination Commands**, **Destination Command Definitions**, and **Destination Plugin** as a **Destination Command Plan**.
- A **Destination Command Plan** may contain one or more ordered **Destination Commands**.
- A **Destination Plugin Definition** owns the **Destination Command Groups** for the command kinds it accepts.
- A **Destination Command Group** owns related **Destination Command Definitions**.
- A **Destination Command Definition** classifies its command kind as identity-bearing or side-effect-only.
- A **Destination Plugin Definition** may expose grouped command factories under `destination.commands.<group>` or top-level command factories directly under `destination.commands`.
- A **Destination Plugin Definition** may be implemented with command handlers that compile to the runtime **Destination Plugin** service.
- A **Destination Plugin Definition** must contain at least one **Destination Command Definition** through its **Destination Command Groups** before it can compile to a runtime **Destination Plugin** service.
- A **Destination Command Schema** validates already-decoded command values and must not change value representation between its encoded and decoded sides.
- A **Destination Entry Field Schema** validates pipeline-produced values; source plugins decode external raw data before the pipeline, and destination plugins encode to destination-native payloads internally.
- A **Destination Entry Field Schema** must not change value representation between its encoded and decoded sides.
- A **Destination Plugin** may expose command factories such as `destination.commands.upsertEntry(...)` so pipelines do not construct raw command objects.
- Destination-specific schemas should be configured once when creating a **Destination Plugin**; command factories enforce the relevant configured schema for the command being created.
- A **Destination Command** maps back to exactly one **Source Item** through its **Destination Command Plan**.
- A **Destination Retry Strategy** wraps each **Destination Command** execution in a **Destination Command Plan** independently.
- A **Destination Command Result** may include a non-empty **Destination Identity** and a non-empty **Destination Version**.
- A side-effect-only **Destination Command Result** may omit **Destination Identity**.
- A **Migration Item State** records one primary **Destination Identity** for a **Source Item**.
- A **Destination Command Plan** that records a migrated or needs-update **Migration Item State** must produce or preserve one primary **Destination Identity**.
- A **Destination Command Plan** must not produce more than one identity-bearing **Destination Command Result**.
- A **Destination Command Plan** with more than one identity-bearing command or result fails the **Source Item**.
- Side-effect-only **Destination Command Results** do not replace the primary **Destination Identity** recorded in **Migration Item State**.
- If a **Destination Command Plan** partially succeeds and then fails, the **Migration Item State** is failed and preserves the latest known primary **Destination Identity** and **Destination Version**.
- A workflow that creates multiple durable destination identities should use multiple **Migration Definitions** stitched through **Migration Reference Lookup**.
- A **Destination Stub** is incomplete and must be updated by a later migration run.
- A **Needs Update** item state is not terminal and must be reprocessed even when source version is unchanged.
- A **Destination Plugin** may classify retryable errors, but a **Migration Definition** selects the **Destination Retry Strategy**.
- A **Transformation Pipeline** may fail with **Skip Item** to record a skipped **Migration Item State**.
- A **Destination Plugin** is not called when a **Transformation Pipeline** fails with **Skip Item**.

## Example dialogue

> **Dev:** "Can the SQL plugin call this a row?"
> **Domain expert:** "Inside the SQL plugin, yes. In the framework glossary it is a **Source Item**, because non-SQL sources emit items too."

## Flagged ambiguities

- "source map" was used for durable source-to-destination progress tracking — resolved: use **Migration Item State** instead.
- "row state" was considered, but rejected because not all source items are SQL rows.
- "migration state store" was considered, but rejected because the store contains item state, run state, and cursors, not a single kind of migration state.
- "migration" was used for both configuration and execution — resolved: use **Migration Definition** for configuration and **Migration Run** for execution.
- Pipeline splitting was considered as possible item fan-out — resolved: first version keeps migration items one-to-one; splitting means reshaping fields, not producing multiple destination items.
- Separate item eligibility hooks were considered, but rejected for the first version; resolved: use **Skip Item** as a typed pipeline error.
- "destination item" was used for pipeline output, but rejected because pipeline output may be an operation such as update, publish, or update-and-publish — resolved: use **Destination Command**.
- Hashing the entire source item was considered as an identity strategy — resolved: content hashes are usually **Source Version**, not **Source Identity**.
- "highwater mark" was used for incremental source selection — resolved: use **Source Cursor**.
- "source schema" and "source item schema" were used ambiguously — resolved: use **Source Payload Schema** for the schema that validates `SourceItem.item`, not source identity or source version.
- External lookup option names were considered — resolved: use framework terms such as **Migration Definition**, **Source Identity**, and **Destination Stub** consistently in the TypeScript API.
