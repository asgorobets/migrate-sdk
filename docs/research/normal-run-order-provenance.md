# Normal-run ordering: decision provenance and Drupal comparison

Research date: 2026-09-11

## Finding

The SDK's normal-run policy of processing failed and needs-update backlog before
source cursor discovery was an explicit early design decision. Codex proposed
the ordering, and the user accepted that exact proposal. It was documented before
implementation, then reinforced by later update and batch work. The user's
current request to use source order revises that earlier policy.

This audit records the behavior before implementation of [ADR 0012](../adr/0012-source-order-and-limited-runs.md). That subsequent change removes normal-run backlog priority while preserving checkpoint resume and explicit retry modes.

## Original discussion

The original local conversation is preserved in
[the June 2 session](</Users/asgorobets/.codex/sessions/2026/06/02/rollout-2026-06-02T20-09-57-019e8ad0-bffe-7073-92f6-8e0ac1128296.jsonl:1338>).
The relevant exchange occurred after midnight on June 3 in America/New_York.

- At **2026-06-02 23:46 EDT**, the user said failed items must still be processed
  even when a saved cursor would otherwise exclude them. This established the
  recovery requirement, but did not itself require backlog-first ordering.
  Evidence: response item at JSONL line 1338, timestamp
  `2026-06-03T03:46:08.694Z`.
- At **2026-06-03 00:21 EDT**, Codex explicitly asked whether normal mode should
  process backlog or cursor discovery first. It recommended backlog first,
  identifying failed and needs-update items as known incomplete work and saying
  discovery could still proceed after unsuccessful retries. It asked:
  “Do you accept backlog first, then cursor discovery for normal mode?”
  Evidence: [assistant proposal](</Users/asgorobets/.codex/sessions/2026/06/02/rollout-2026-06-02T20-09-57-019e8ad0-bffe-7073-92f6-8e0ac1128296.jsonl:1618>),
  timestamp `2026-06-03T04:21:13.370Z`.
- At **00:22 EDT**, the user replied “yes.” Codex then stated that it would
  record the policy in the design docs.
  Evidence: [user response](</Users/asgorobets/.codex/sessions/2026/06/02/rollout-2026-06-02T20-09-57-019e8ad0-bffe-7073-92f6-8e0ac1128296.jsonl:1623>),
  timestamp `2026-06-03T04:22:04.524Z`; assistant acknowledgement at line 1626.
- The next exchange separately accepted committing the cursor after a processed
  window even when some items failed. Its rationale was that durable item state
  and identity lookup preserve a recovery path after the cursor advances.
  Evidence: assistant at line 1632 and user at line 1637.

Git attribution alone would not establish who proposed this policy. The
conversation identifies Codex as proposer and the user as accepting it; the
commits below are authored and committed under Alexei Gorobet's identity.

## Documentation and implementation chain

1. **`550bcd44190f9f6c54411b749ced78fa91551962`**, June 3, 07:12 EDT,
   `docs(architecture): document migration framework design`.
   The original `CONTEXT.md` line 149 and original
   `docs/design/initial-api-design.md` line 763 explicitly specify backlog-first
   normal runs. The initial design at line 721 explains why cursor advancement
   and retry lookup are separate. The policy remains in
   [current CONTEXT.md](../../CONTEXT.md#relationships).
   Reproduce with `git show 550bcd4:docs/design/initial-api-design.md`.
2. **`dece17cd8b8476817d37f58ee0a772dcb1cb72fb`**, June 3, 13:54 EDT,
   `feat(migrate-sdk): add initial in-memory API path`.
   [POC PRD](../../.scratch/first-poc-inmemory-layers/PRD.md) explicitly requires
   backlog first under Implementation Decisions, line 65.
   [Issue 04](../../.scratch/first-poc-inmemory-layers/issues/04-implement-run-modes-over-migration-item-state.md)
   repeats it in its description and acceptance criteria.
3. **`fcff35262df0c5ee4cc6658f3de4fea91cf34543`**, June 3, 18:47 EDT,
   `feat(migrate-sdk): implement item-state run modes`.
   Added `selectBacklogStates`, identity lookup before discovery, and normal-mode
   backlog tests. The commit body explicitly states the ordering. Runtime code
   subsequently moved behind executor services in `920e7d6`.
4. The [update/rescan PRD](../../.scratch/run-update-rescan/PRD.md), introduced
   in `d35c476`, retains backlog-first normal runs at line 93 and requires later
   normal runs to recover unfinished update work through identity lookup.
5. [ADR 0009](../adr/0009-process-batch-pipelines-with-per-item-settlements.md),
   added in `612c3b2`, describes a later normal run retrying failed batch items
   from backlog after their source window cursor has advanced (lines 82–89).

There is **no dedicated ADR comparing backlog-first and source-first ordering**
in the current ADR directory. ADR 0001 assigns progress ownership to the store;
it does not choose this ordering. ADR 0009 relies on automatic backlog recovery,
but is about per-item batch settlement rather than selecting ordering policy.

## Drupal comparison

For Drupal core 11.x, normal import begins by rewinding the source and obtains
work from its iterator. It does not first enumerate saved failed/needs-update
identities. Source eligibility admits needs-update rows when encountered, while
a failed map status alone does not trigger retry. SQL sources can combine map
and source conditions in one query; this is not a separate priority queue.
([Core import loop](https://api.drupal.org/api/drupal/core%21modules%21migrate%21src%21MigrateExecutable.php/function/MigrateExecutable%3A%3Aimport/11.x),
[source eligibility](https://api.drupal.org/api/drupal/core%21modules%21migrate%21src%21Plugin%21migrate%21source%21SourcePluginBase.php/class/SourcePluginBase/11.x))

| Question | SDK's current normal run | Drupal core normal import |
| --- | --- | --- |
| Where does execution select its first work? | Saved failed/needs-update identities, then source discovery | Source iterator |
| Does needs-update have priority over new source items? | Yes: backlog phase runs first | No separate priority; follows source query/iterator order |
| Is failed status alone enough for automatic retry? | Yes | No; another eligibility condition must apply |
| Can work outside the current source stream be recovered? | Backlog identity lookup can retrieve it | Only if source selection exposes it; no independent backlog recovery phase |

Drupal's `prepareUpdate()` changes all map rows to needs-update, including failed
and ignored rows. Execution still runs through source selection. The behavior
of high-water filters and non-joinable maps matters: not every historical
needs-update row is guaranteed to be exposed by every source configuration.
See [the detailed Drupal research](drupal-migrate-limit.md#normal-runs-source-order-versus-backlog-priority).

## Design implication

The later source-discovery change matters to this comparison. Commit `9213153`
(2026-08-21, `feat(migrate-sdk): add explicit source discovery modes`) made
`discovery: "full"` the default. Full traversal keeps checkpoints while in
progress and deletes the cursor when discovery finishes, including when some
items have durable failed outcomes. A subsequent run then discovers from the
beginning. Incremental discovery is opt-in and retains its completed cursor.
Interrupted full traversals also retain their checkpoint. See
[source discovery documentation](../design/source-authoring-api.md#cursor-reads).
The August change retained the older normal-run backlog phase, so the current
default combines backlog-first processing with a later full source traversal.

Recovery, eligibility, and ordering are separate decisions. Retrying failures
does not inherently require doing so before new source work. However, dropping
the backlog phase while resuming an interrupted or incremental traversal's saved
cursor removes the current
automatic recovery path for failures behind that cursor. A source-order design
must state whether those items wait for a full rescan or explicit retry, or are
included by a different source-selection policy.

Changing the normal-run policy would revise CONTEXT.md, the POC requirements,
the update recovery requirements, relevant ADR 0009 assumptions, and tests.
This note records the current user preference without silently changing those
contracts.
