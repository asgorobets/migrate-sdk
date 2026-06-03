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

**Source Cursor Window**:
One batch of source items read from a source cursor.

**Source Lookup Strategy**:
The source plugin's declared cost model for reading a source item by identity.

**Migration Item State**:
Durable state for one source item within a migration.

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

**Migration Definition Lock**:
A lease that prevents multiple runners from executing the same migration definition concurrently.

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

**Run Mode**:
The runtime mode that controls which migration item states are reprocessed.

**Run Request**:
The invocation object that starts a migration run from the SDK, CLI, or another host.

**Transformation Pipeline**:
The typed transformation from one source item into one destination command.

**Destination Command**:
The typed command produced by a transformation pipeline and executed by a destination plugin.

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

**Source Item Schema**:
The Effect schema used by a source plugin to validate and infer source items.

**Destination Command Schema**:
The Effect schema used by a destination plugin to validate and infer destination commands.

**Skip Item**:
A typed pipeline error that records a source item as skipped without calling the destination plugin.

**Migration Item Error**:
A normalized error record stored for a failed migration item state.

## Relationships

- A **Source Item** has exactly one **Migration Item State** for a given migration definition.
- A **Source Item** must have a **Source Identity**.
- A **Source Item** may have a **Source Version** supplied by a source field, source metadata, or a hash of the item contents.
- A **Source Cursor** selects which source items to inspect during a migration run.
- A **Source Cursor Window** may return a next **Source Cursor**.
- A **Source Cursor** is committed after a cursor window is processed, even when some source items in the window fail.
- A **Migration Item State** can record a source identity, destination identity, migration status, observed source version, and failure metadata.
- A **Migration Item State** is modeled as tagged variants by status.
- A **Migration Item State** does not store source item payloads by default.
- A **Migration Item Error** normalizes source, pipeline, destination, or store errors for durable storage.
- A **Migration Store** error fails the migration run instead of becoming a migration item failure.
- A **Source Plugin** cursor read error fails the migration definition run.
- A **Source Plugin** identity lookup error can become a migration item failure when the source identity is already known.
- A **Migration Item Outcome** may be unchanged even though unchanged is not persisted as a **Migration Item State** status.
- A **Source Plugin** emits **Source Items**; it does not own **Migration Item State**.
- A **Source Plugin** reads source items by cursor and by source identity.
- A **Source Plugin** exposes or uses a **Source Item Schema**.
- A **Source Lookup Strategy** may be direct or scan-based.
- A **Migration Definition** may select separate **Source Cursor Retry Strategy** and **Source Lookup Retry Strategy** wrappers.
- A **Migration Store** records **Migration Item State**, **Migration Run State**, and the last successful **Source Cursor** for a **Migration Definition**.
- A **Migration Store** may be backed by SQL, key/value storage, files, or another durable system.
- A **Migration Definition** uses one public **Migration Store** service.
- A **Destination Plugin** executes **Destination Commands** and returns destination identity metadata that can be recorded in **Migration Item State**.
- A **Destination Plugin** exposes or uses a **Destination Command Schema**.
- A **Migration Definition** declares the source, pipeline, destination, migration store, and dependencies for a migration workflow.
- A **Migration Definition** is executable and may contain layers and effects.
- A **Migration Definition Lock** is acquired through the **Migration Store** before a migration definition is executed.
- A **Migration Definition Lock** prevents concurrent runners from executing the same **Migration Definition** in the first version.
- A **Migration Spec** is serializable and cannot contain arbitrary effects directly.
- A **Migration Spec** can be compiled through a plugin registry into a **Migration Definition**.
- A **Plugin Registry** supports future DSL or low-code workflows and is not required for the first code path.
- A **Migration Run** executes one or more **Migration Definitions**.
- A **Migration Run** orders multiple **Migration Definitions** by their declared dependencies.
- A **Migration Run** executes ordered **Migration Definitions** sequentially in the first version.
- A **Migration Run** continues processing source items after an item failure in the first version.
- A **Migration Run** is marked failed when one or more source items fail, even if other items complete.
- A **Migration Run** returns a **Migration Run Summary** for SDK callers and CLI rendering.
- A **Migration Run** treats migrated and skipped item states as terminal for a given source version.
- A **Migration Run** retries failed item states on rerun.
- A **Migration Run** requires an explicit run mode to reprocess unchanged skipped items when skip logic changes.
- A **Run Mode** can select normal processing, failed items, skipped items, or one item by source identity.
- A normal **Run Mode** processes failed and needs-update backlog before source cursor discovery.
- A failed **Run Mode** reprocesses only failed item states.
- A skipped **Run Mode** reprocesses skipped item states regardless of source version.
- A **Run Request** supplies migration definitions, run mode, optional source cursor override, and optional migration definition selection.
- A **Run Request** that selects migration definitions also includes their required dependencies.
- A **Transformation Pipeline** transforms exactly one **Source Item** into at most one **Destination Command** in the first version.
- A **Destination Command** maps back to exactly one **Source Item** in the first version.
- A **Destination Plugin** returns a **Destination Identity** and may return a **Destination Version**.
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
