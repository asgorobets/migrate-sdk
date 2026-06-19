# Migration Framework

A framework for moving data or content between systems while preserving typed transformation logic and durable migration progress.

## Language

**Source Item**:
One unit emitted by a source plugin for migration.

**Source Identity**:
The stable, possibly composite identity of a source item within a migration definition.

**Source Identity Key**:
The structured value of a source identity for one source item.

**Source Identity Part**:
A named element of a composite source identity key tuple.

**Encoded Source Identity**:
The durable string form of a source identity after schema encoding.

**Source Identity Contract**:
The static agreement that defines the id, schema, key derivation, and encoding of source identities for a migration definition.

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
A migration item state that records durable destination tracking evidence and can be passed to a rollback pipeline.

**Migration Item Outcome**:
The result of processing one source item during a migration run.

**Source Plugin**:
A plugin that emits source items from a source system.

**Document Source**:
A source plugin that emits source items selected from a parsed structured document.

**Document Fetcher**:
The document source component that retrieves a structured resource for a parser.

**Document Parser**:
The document source component that parses a fetched resource into a schema-backed document.

**Document Selector**:
The document source component that selects source item payloads, and optional parent context, from a parsed document.

**Destination Plugin**:
A legacy command-plan plugin that exposes destination-owned commands for a destination system.

**Destination Capability Module**:
An Effect helper module that exposes destination-owned helpers, typed destination change descriptors, dependency layers, and optional rollback helpers.

**Migration Store**:
The pluggable durable backend for a migration definition.

**Migration Definition**:
The configured workflow that connects a source plugin, scoped process pipeline, optional tracking record contract, and migration store.

**Migration Contract**:
The stored compatibility agreement for the identity, version, and optional tracking record contract of a migration definition.

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
A process capability for reading migrated tracking state or destination references from migration item states.

**Process Pipeline**:
The scoped Effect that processes one source item and performs destination-side work.

**Pipeline Execution Scope**:
The per-source-item runtime boundary shared by a process pipeline and framework-owned services.

**Rollback Pipeline**:
The scoped user-authored compensation Effect that receives durable migration item state and performs destination-side cleanup.

**Destination Command**:
A typed destination-owned operation in the legacy command-plan model.

**Destination Command Definition**:
A destination-owned definition that validates a destination command kind and describes its command shape. Normal migration pipelines should use destination-owned command factories rather than constructing command definition records directly.

**Destination Command Group**:
A destination-owned namespace of destination command definitions. Grouped command factories are exposed under `commands.<group>` unless the group is marked top-level, in which case its factories are exposed directly under `commands`.

**Destination Plugin Definition**:
A destination-owned set of uniquely named destination command groups and command definitions. Simple plugin definitions may add commands directly as root-level sugar, but plugin definitions must be non-empty before they compile to the runtime destination plugin service.

**Destination Command Schema**:
A no-service Effect schema for a destination command. It validates process-facing command values and must have the same encoded and decoded TypeScript shape.

**Destination Entry Field Schema**:
A destination-owned Effect schema for process-facing entry fields. It validates already-decoded values and must have the same encoded and decoded TypeScript shape.

**Destination Command Result**:
The result of executing a destination command.

**Destination Change**:
A typed, destination-native outcome recorded by a successful destination helper because it may be needed for tracking, rollback, or inspection. It is not necessarily a structural diff.

**Destination Change Descriptor**:
A destination-owned typed descriptor for one kind of destination change.

**Destination Journal**:
The per-source-item ordered collection of destination journal entries observed during process or rollback execution.

**Destination Journal Segment**:
The ordered journal entries captured from one process or rollback execution.

**Destination Journal Entry**:
A journal entry that records either a destination change or a destination journal diagnostic.

**Destination Journal Diagnostic**:
A generic serializable message entry with required severity, required message, and optional JSON-object details that records explicitly marked process or destination-helper context without claiming that a destination change happened.

**Tracking Record**:
The optional durable, schema-validated materialized state staged by a process pipeline and persisted for one migration item.

**Tracking Record Contract**:
The static agreement that declares a tracking record id and schema and requires one staged schema-valid tracking record before a successful item can be persisted.

**Destination Version**:
The observed destination-side version or revision returned by a destination plugin.

**Destination Stub**:
A placeholder destination item created to reserve a destination reference before the full destination item can be written.

**Needs Update**:
A migration item state status indicating that tracked destination state exists but the destination item is incomplete.

**Destination Retry Strategy**:
The Effect retry wrapper applied by a process pipeline at a destination helper or destination Effect call site.

**Source Cursor Retry Strategy**:
The Effect retry wrapper selected by a migration definition for source cursor reads.

**Source Lookup Retry Strategy**:
The Effect retry wrapper selected by a migration definition for source identity lookups.

**Source Payload Schema**:
The Effect schema used by a source plugin to validate, decode, and infer source item payloads from source-native values into process-facing values.

**Source Cursor Schema**:
The Effect codec used by a source plugin to validate, encode, and decode source cursors.

**Skip Item**:
A typed process error that records a source item as skipped without invoking destination-side work.

**Migration Item Error**:
A normalized error record stored for a failed migration item state.

**Migration Item Error Detail**:
Durable structured detail for inspecting a migration item error after the run has ended.

**Migration Diagnostic**:
A schema-backed warning or error record that explains migration status, item failure, run failure, or another operational condition.

## Relationships

- A **Source Item** has exactly one **Migration Item State** for a given migration definition.
- A **Source Item** must have a **Source Identity**.
- A **Source Identity** may be singular or composite.
- A **Source Identity** conforms to a **Source Identity Contract**.
- A **Source Identity Key** is described by an Effect schema.
- A singular **Source Identity Key** is described by a scalar schema.
- A composite **Source Identity Key** is described by a fixed tuple schema with named **Source Identity Parts**.
- A **Source Identity Part** name is schema metadata for diagnostics, CLI targeting, status reports, reset/rekey tooling, and contract mismatch errors.
- A **Migration Item State** preserves the structured **Source Identity**, including composite identity fields.
- An **Encoded Source Identity** is the only source identity form used for durable lookup keys and operator targeting.
- A **Source Plugin** derives **Source Identity** before the **Process Pipeline** receives the **Source Item**.
- A **Source Item** must have a **Source Version** supplied by a source field, source metadata, or a hash of the item contents.
- A **Source Cursor** selects which source items to inspect during a migration run.
- A **Source Cursor** shape is owned by the **Source Plugin** and must be described by a **Source Cursor Schema**.
- An **Encoded Source Cursor** is the only cursor form persisted by a **Migration Store**.
- A **Source Cursor Window** may return a next **Source Cursor**.
- A **Source Cursor** is committed after a cursor window is processed, even when some source items in the window fail.
- A **Source Inventory Scan** starts from the beginning of the source and does not read or write the persisted **Source Cursor**.
- A **Source Inventory Scan** validates source item payloads with the **Source Payload Schema**.
- A **Source Inventory Scan** may return **Migration Diagnostics** for invalid source payloads or duplicate **Source Identities**.
- A **Migration Item State** records source identity, migration status, and may record observed source version, destination tracking changes, or failure metadata.
- A **Migration Item State** is modeled as discriminated variants by status.
- A **Migration Item State** does not store source item payloads by default.
- A failed **Migration Item State** may preserve **Destination Changes** recorded before the item failed.
- Public and persisted migration data uses domain-friendly discriminators such as `kind` and `status`; Effect `_tag` is reserved for Effect-native errors or internals and hidden from public authoring examples through helpers.
- A **Migration Item Error** normalizes source, process, destination, or store errors for durable storage.
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
- A **Source Payload Schema** may decode source-native raw values, such as CSV strings, into the process-facing TypeScript values the **Process Pipeline** receives.
- A **Source Payload Schema** may be supplied directly by a user or derived by a source plugin from a source-native schema.
- A **Migration Run** decodes each source item payload with the **Source Payload Schema** before unchanged-terminal checks, process pipeline execution, and destination-side work.
- A source item with a valid identity and version but invalid payload becomes a failed **Migration Item State** with durable **Migration Item Error Details**.
- A **Source Lookup Strategy** may be direct or scan-based.
- A **Migration Definition** may select separate **Source Cursor Retry Strategy** and **Source Lookup Retry Strategy** wrappers.
- A **Migration Store** records **Migration Item State**, the latest **Migration Run State**, the last successful **Source Cursor**, and the **Migration Contract** for each **Migration Definition**.
- A **Migration Store** may be backed by SQL, key/value storage, files, or another durable system.
- A **Migration Definition** uses one public **Migration Store** service.
- A **Migration Run** blocks before processing items when the current **Migration Contract** differs from the stored **Migration Contract** and any **Migration Item State** exists for the **Migration Definition**.
- In the legacy command-plan model, a **Destination Plugin** exposes **Destination Commands** to process and rollback pipelines.
- A **Destination Plugin** does not decide whether destination tracking is persisted.
- A **Destination Plugin** exposes or uses a **Destination Command Schema**.
- A **Migration Definition** declares the source, process, migration store, optional tracking record contract, and dependencies for a migration workflow.
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
- A **Migration Reference Lookup** reads migrated tracking state or destination references from **Migration Item State** in a **Migration Store**.
- A **Migration Reference Lookup** result is typed from the referenced **Migration Definition's Tracking Record Contract**.
- A **Migration Reference Lookup** returns the structured **Tracking Record** for a referenced **Migration Definition** with a **Tracking Record Contract**.
- A **Migration Definition** without a **Tracking Record Contract** is not reference-lookupable by default.
- A **Migration Definition** expected to serve downstream references should declare a **Tracking Record Contract**.
- A **Migration Reference Lookup** reads and writes referenced **Migration Item State** through the referenced **Migration Definition's Migration Store**.
- A **Migration Reference Lookup** may target a **Migration Definition** that is not a declared dependency.
- A **Migration Reference Lookup** may target one **Migration Definition** or an ordered list of **Migration Definitions**.
- A **Migration Reference Lookup** over multiple **Migration Definitions** returns the first migrated reference found in lookup order.
- A declared **Migration Definition Dependency** gives same-run ordering and locking guarantees for reference lookup, but is not required to perform a reference lookup.
- A missing migrated reference may be handled as no value or as an item-level process failure by the **Process Pipeline**.
- A missing migrated reference may create a **Destination Stub** when the **Migration Reference Lookup** is configured to allow stubs.
- A referenced **Migration Definition** owns how its **Destination Stubs** are created.
- A referenced **Migration Definition** creates **Destination Stubs** from a **Source Identity**, not from the full referenced **Source Item** payload.
- A referenced **Migration Definition** creates **Destination Stubs** by performing destination-side work.
- A **Migration Reference Lookup** over multiple **Migration Definitions** must select one referenced **Migration Definition** to create a **Destination Stub** when no migrated reference is found.
- A **Migration Reference Lookup** that creates a **Destination Stub** records **Needs Update** item state for the stubbed reference.
- A **Needs Update** item state created by **Migration Reference Lookup** may not have an observed source version yet.
- A **Migration Reference Lookup** may return a **Needs Update** item state as a usable reference because tracked destination state already exists.
- A **Process Pipeline** processes exactly one **Source Item** within one **Pipeline Execution Scope**.
- A **Process Pipeline** may invoke one or more destination helpers or other destination Effects.
- A **Rollback Pipeline** processes exactly one **Rollbackable Migration Item State** within one **Pipeline Execution Scope**.
- A **Rollback Pipeline** is explicit compensation, not an inferred inverse of a **Process Pipeline** or previous destination effects.
- A **Rollback Pipeline** uses durable **Migration Item State** and does not require reading the **Source Item**.
- A **Rollbackable Migration Item State** is any **Migration Item State** that records durable destination tracking evidence.
- A **Rollback Pipeline** decides how to interpret durable **Destination Changes** and optional **Tracking Records** when compensating destination-side work.
- A successful **Rollback Pipeline** removes the **Migration Item State** so the source identity can be migrated again.
- A failed **Rollback Pipeline** preserves the **Migration Item State** so rollback can be retried or manually corrected.
- A destination capability module exposes **Destination Change Descriptors** for destination change kinds it can record.
- A destination helper may record a **Destination Change** in the **Destination Journal** when it succeeds.
- A **Destination Change** conforms to a **Destination Change Descriptor**.
- A destination helper may record a **Destination Journal Diagnostic** when it fails.
- A **Destination Journal Diagnostic** is not a **Destination Change**.
- A **Process Pipeline** may record a **Destination Journal Diagnostic** when failure context would otherwise exist only in logs.
- Ordinary logs are not **Destination Journal Diagnostics**.
- A **Destination Journal Diagnostic** is created from explicitly marked diagnostic logging.
- A **Destination Journal Diagnostic** uses one generic message shape; migration authors and destination helpers map their own errors or domain context into that shape.
- A **Destination Journal Diagnostic** has severity `info`, `warning`, or `error`.
- A **Destination Journal Diagnostic** does not require a stable id or descriptor-backed detail type.
- A **Destination Journal Diagnostic** carries details as a JSON object, not as **Migration Item Error Details**.
- A **Destination Journal** is scoped to one **Source Item** or one **Rollbackable Migration Item State**.
- A **Destination Journal** preserves the order in which its **Destination Journal Entries** were observed.
- A **Destination Journal** separates the **Process Pipeline** segment from failed **Rollback Pipeline** attempt segments.
- A **Destination Journal Segment** belongs to either a **Process Pipeline** execution or one failed **Rollback Pipeline** attempt.
- A **Destination Journal** survives item-level process failure so partial destination effects and diagnostics can be recorded in **Migration Item State**.
- A failed **Rollback Pipeline** attempt may add a **Destination Journal Segment** to preserved **Migration Item State**.
- A successful **Rollback Pipeline** deletes the **Migration Item State**, including destination journal evidence.
- Repeated **Destination Changes** with the same **Destination Change Descriptor** are interpreted through typed payload data and **Destination Journal** order.
- Durable **Destination Journal Diagnostics** do not persist raw Effect causes or raw thrown objects.
- A successful **Migration Item State** may complete without a **Tracking Record** when the **Migration Definition** has no **Tracking Record Contract**.
- A successful **Migration Item State** with a **Tracking Record Contract** requires one staged schema-valid **Tracking Record**.
- A **Tracking Record** may include multiple named destination items affected by one **Source Item**.
- A **Tracking Record** is the stable item-level contract for successful items that declare a **Tracking Record Contract**.
- A **Migration Item State** may preserve a structured **Tracking Record**.
- A failed **Migration Item State** may preserve **Destination Journal** evidence without a **Tracking Record**.
- A **Destination Journal** is rollback and inspection evidence, not a replacement for a stable **Tracking Record** contract.
- A **Destination Plugin Definition** owns the **Destination Command Groups** for the command kinds it accepts.
- A **Destination Command Group** owns related **Destination Command Definitions**.
- A **Destination Command Definition** validates command shape and does not define migration tracking.
- A **Destination Plugin Definition** may expose grouped command factories under `destination.commands.<group>` or top-level command factories directly under `destination.commands`.
- A **Destination Plugin Definition** may be implemented with command handlers that compile to the runtime **Destination Plugin** service.
- A **Destination Plugin Definition** must contain at least one **Destination Command Definition** through its **Destination Command Groups** before it can compile to a runtime **Destination Plugin** service.
- A **Destination Command Schema** validates already-decoded command values and must not change value representation between its encoded and decoded sides.
- A **Destination Entry Field Schema** validates process-produced values; source plugins decode external raw data before the process, and destination plugins encode to destination-native payloads internally.
- A **Destination Entry Field Schema** must not change value representation between its encoded and decoded sides.
- A **Destination Plugin** may expose command factories such as `destination.commands.upsertEntry(...)` so pipelines do not construct raw command objects.
- Destination-specific schemas should be configured once when creating a destination capability or legacy **Destination Plugin**.
- A legacy **Destination Command** maps back to exactly one **Source Item** through its **Pipeline Execution Scope**.
- A **Destination Retry Strategy** is applied inline by the process pipeline around the destination helper or destination Effect being retried.
- A destination helper may record a **Destination Change** and a destination-native version in the **Destination Journal**.
- A side-effect-only destination helper may omit **Destination Changes**.
- If a **Process Pipeline** partially succeeds and then fails, the **Migration Item State** is failed and preserves recorded **Destination Changes**.
- A **Destination Stub** is incomplete and must be updated by a later migration run.
- A **Needs Update** item state is not terminal and must be reprocessed even when source version is unchanged.
- A destination capability or legacy **Destination Plugin** may classify retryable errors, but the **Process Pipeline** selects where to apply a **Destination Retry Strategy**.
- A **Process Pipeline** may fail with **Skip Item** to record a skipped **Migration Item State**.
- Destination helpers and destination Effects are not invoked when a **Process Pipeline** fails with **Skip Item** before destination-side work.

## Example dialogue

> **Dev:** "Can the SQL plugin call this a row?"
> **Domain expert:** "Inside the SQL plugin, yes. In the framework glossary it is a **Source Item**, because non-SQL sources emit items too."

> **Dev:** "Does the product destination plugin decide whether product IDs are tracked?"
> **Domain expert:** "No — the plugin owns product commands and destination changes, but the **Migration Definition** owns the optional **Tracking Record Contract** that decides whether a successful item must persist a materialized record."

## Flagged ambiguities

- "source map" was used for durable source-to-destination progress tracking — resolved: use **Migration Item State** instead.
- "row state" was considered, but rejected because not all source items are SQL rows.
- "migration state store" was considered, but rejected because the store contains item state, run state, and cursors, not a single kind of migration state.
- "migration" was used for both configuration and execution — resolved: use **Migration Definition** for configuration and **Migration Run** for execution.
- Pipeline splitting was considered as possible item fan-out — resolved: first version keeps migration items one-to-one; splitting means reshaping fields, not producing multiple destination items.
- Separate item eligibility hooks were considered, but rejected for the first version; resolved: use **Skip Item** as a typed process error.
- "destination item" was used for pipeline output, but rejected because pipeline output may be an operation such as update, publish, or update-and-publish — resolved: use **Destination Command**.
- Hashing the entire source item was considered as an identity strategy — resolved: content hashes are usually **Source Version**, not **Source Identity**.
- "highwater mark" was used for incremental source selection — resolved: use **Source Cursor**.
- "source schema" and "source item schema" were used ambiguously — resolved: use **Source Payload Schema** for the schema that validates `SourceItem.item`, not source identity or source version.
- External lookup option names were considered — resolved: use framework terms such as **Migration Definition**, **Source Identity**, and **Destination Stub** consistently in the TypeScript API.
- "destination identity" was assumed to mean one primary destination record — resolved: durable destination tracking uses an optional **Tracking Record** that may be composite or bucketed.
- "transformation pipeline" under-described the work being done — resolved: use **Process Pipeline** for the scoped Effect that processes a source item and performs destination-side work.
- The current code/API may still use `pipeline`; new destination-tracking implementation work should rename that public authoring slot to `process`.
- "pipeline outcome" was used to mean durable item state — resolved: the **Process Pipeline** performs scoped effects, while the runtime records **Migration Item State** from process completion, journal evidence, and the optional **Tracking Record Contract**.
- "identity-bearing command" put migration tracking decisions in destination plugins — resolved: destination helpers may record **Destination Changes**, but the **Migration Definition** owns whether a **Tracking Record Contract** is required.
- "untracked" could mean no durable item state — resolved: there is no public untracked tracking mode; definitions without a **Tracking Record Contract** still record **Migration Item State**.
- Raw change kind strings were considered for journal reads and rollback helpers — resolved: migration authors reference typed **Destination Change Descriptors** exported by destination capability modules.
- `Schema.Struct` was considered for composite **Source Identity Keys** — resolved: use fixed tuple schemas with named **Source Identity Parts** because source identity is a positional lookup key.
