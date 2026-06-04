# Validate Source Payloads End to End

Status: ready-for-human

## Parent

[Source Boundary Validation and Durable Error Details](../PRD.md)

## What to build

Validate source payloads in the migration runner before they reach unchanged detection, transformation pipelines, or destination plugins. Source payload validation failures should become durable item failures with source error details when the Source Item has valid identity and version. The same behavior should apply to cursor-discovered items and targeted source identity lookups.

Update the design docs alongside the code so the documented runtime sequence matches the implementation as it changes.

## Acceptance criteria

- [x] Cursor-discovered Source Items have their payload decoded with the runtime Source Payload Schema before unchanged-terminal checks.
- [x] Targeted Source Items returned by source identity lookup have their payload decoded with the runtime Source Payload Schema before processing.
- [x] Transformation Pipelines receive the decoded source payload while preserving the original Source Identity and Source Version.
- [x] A valid Source Item envelope with invalid source payload records a failed Migration Item State.
- [x] Source payload validation failures use source error kind and a stable source payload schema error tag.
- [x] Source payload validation failures persist durable schema error details.
- [x] Schema error detail output is bounded with internal limits and records when additional issues were omitted.
- [x] Source payload validation failure skips Transformation Pipeline execution.
- [x] Source payload validation failure skips Destination Plugin execution.
- [x] A run continues processing unrelated Source Items after a source payload validation failure.
- [x] Definition and run summaries remain aggregate-only and reflect failed item counts.
- [x] Existing failed item retry semantics apply to source payload validation failures.
- [x] Invalid payloads are not hidden by unchanged-terminal state when the Source Version matches a previous terminal state.
- [x] Source read failures before Source Items are emitted remain run-level source plugin failures.
- [x] Relevant design documentation is updated in place as part of the code change.

## Blocked by

- [01 - Tighten Source Boundary Schemas and Durable Error Records](01-tighten-source-boundary-schemas-and-durable-error-records.md)
